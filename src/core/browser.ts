/**
 * Browser manager with Playwright
 */

import { chromium, type Browser, type BrowserContext, type BrowserContextOptions, type LaunchOptions, type Page } from 'playwright';
import ProxyChain from 'proxy-chain';
import type { ProxyConfig, ScraperOptions } from './types.js';

export class BrowserManager {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private options: ScraperOptions;
  private proxyServer: ProxyChain.Server | null = null;
  private currentProxy: ProxyConfig | undefined;
  private opening: Promise<void> | null = null;

  constructor(options: ScraperOptions = {}) {
    this.options = {
      headless: true,
      timeout: 30000,
      ...options,
    };
  }

  async initialize(proxy?: ProxyConfig): Promise<void> {
    if (this.isInitialized()) return;
    if (!this.opening && proxy) this.currentProxy = proxy;
    const opening = this.opening ??= this.open(this.currentProxy);
    try {
      await opening;
    } catch (error) {
      // Clear opening before close(), which otherwise waits for this same promise.
      if (this.opening === opening) this.opening = null;
      await this.close();
      throw error;
    } finally {
      if (this.opening === opening) this.opening = null;
    }
  }

  private async open(proxy?: ProxyConfig): Promise<void> {
    // A manually closed Chromium window can leave the SOCKS bridge running.
    await this.proxyServer?.close(true);
    this.proxyServer = null;
    const launchOptions: LaunchOptions = {
      headless: this.options.headless,
      handleSIGINT: this.options.handleBrowserSignals ?? true,
      handleSIGTERM: this.options.handleBrowserSignals ?? true,
      handleSIGHUP: this.options.handleBrowserSignals ?? true,
      args: ['--disable-blink-features=AutomationControlled', '--disable-dev-shm-usage'],
    };
    // Keep the native UA, platform, Client Hints and PluginArray consistent by default.
    // An explicit userAgent is a caller-controlled override, in either mode.
    const contextOptions: BrowserContextOptions = {
      userAgent: this.options.userAgent,
      viewport: { width: 1920, height: 1080 },
      locale: 'ru-RU',
      timezoneId: 'Europe/Moscow',
    };

    // Use local Chrome if available
    const localChromePath = process.env.CHROME_EXECUTABLE_PATH || './chrome-win64/chrome.exe';
    try {
      const fs = await import('fs');
      if (fs.existsSync(localChromePath)) {
        launchOptions.executablePath = localChromePath;
        console.error(`Используем локальный Chrome: ${localChromePath}`);
      }
    } catch {
      // If local Chrome not found, use Playwright's default
    }

    // Add proxy if provided
    if (proxy) {
      // Check if SOCKS proxy with authentication
      const isSocksWithAuth =
        (proxy.type === 'socks4' || proxy.type === 'socks5') &&
        proxy.username !== undefined;

      if (isSocksWithAuth) {
        console.error(`Настраиваем локальный прокси-туннель для ${proxy.type} с авторизацией...`);
        const upstreamUrl = `${proxy.type}://${encodeURIComponent(proxy.username!)}:${encodeURIComponent(proxy.password ?? '')}@${proxy.host}:${proxy.port}`;

        // Create local HTTP proxy server with error handling
        this.proxyServer = new ProxyChain.Server({
          host: '127.0.0.1',
          port: 0,
          verbose: false, // Disable verbose to reduce noise
          prepareRequestFunction: () => ({
            upstreamProxyUrl: upstreamUrl,
            requestAuthentication: false,
            failMsg: 'Proxy connection failed',
          }),
        });

        // Upstream library errors can contain the full URL, including credentials.
        this.proxyServer.on('requestFailed', () => {
          console.error('[PROXY] Не удалось выполнить запрос через прокси.');
        });

        await this.proxyServer.listen();
        const localPort = this.proxyServer.port;
        const localProxyUrl = `http://127.0.0.1:${localPort}`;

        console.error(`[PROXY] Локальный сервер запущен на порту ${localPort}`);
        console.error(`[PROXY] Браузер подключится к ${localProxyUrl}\n`);

        launchOptions.proxy = {
          server: localProxyUrl,
        };
      } else {
        // HTTP/HTTPS proxy or SOCKS without auth - use directly
        launchOptions.proxy = {
          server: `${proxy.type}://${proxy.host}:${proxy.port}`,
        };
        if (proxy.username !== undefined) {
          launchOptions.proxy.username = proxy.username;
          launchOptions.proxy.password = proxy.password ?? '';
        }
      }
    }

    if (this.options.userDataDir) {
      const context = await chromium.launchPersistentContext(this.options.userDataDir, {
        ...launchOptions,
        ...contextOptions,
        chromiumSandbox: true,
      });
      this.context = context;
      this.page = context.pages()[0] ?? null;
      context.once('close', () => {
        if (this.context === context) {
          this.context = null;
          this.page = null;
        }
      });
    } else {
      this.browser = await chromium.launch(launchOptions);
      this.context = await this.browser.newContext(contextOptions);
    }
    this.context.setDefaultTimeout(this.options.timeout ?? 30000);
  }

  /**
   * Reuse the same page across requests so the user can see the current task.
   */
  async getPage(): Promise<Page> {
    // If the browser process died or context was closed, re-initialize.
    if (!this.isInitialized()) {
      await this.restartBrowser();
    }

    if (!this.page || this.page.isClosed()) {
      try {
        this.page = await this.context!.newPage();
        this.page.setDefaultTimeout(this.options.timeout || 30000);
      } catch (error: any) {
        // Context was closed even though the browser looked alive.
        console.error('Предупреждение: пересоздаём браузер после закрытия контекста:', error.message);
        await this.restartBrowser();
        this.page = await this.context!.newPage();
        this.page.setDefaultTimeout(this.options.timeout || 30000);
      }
    }

    return this.page;
  }

  /**
   * Fully shut down the current browser (if any) and start a fresh one.
   */
  private async restartBrowser(): Promise<void> {
    await this.close();
    await this.initialize();
  }

  async close(): Promise<void> {
    // The MCP client may disconnect while Chromium is still starting.
    await this.opening?.catch(() => {});
    const { context, browser, proxyServer } = this;
    this.page = null;
    this.context = null;
    this.browser = null;
    this.proxyServer = null;
    await context?.close().catch((error) => console.error('Ошибка при закрытии контекста:', error.message));
    await browser?.close().catch((error) => console.error('Ошибка при закрытии браузера:', error.message));
    await proxyServer?.close(true).catch((error: Error) =>
      console.error('Ошибка при закрытии прокси-сервера:', error.message),
    );
  }

  setHeadless(headless: boolean): void {
    this.options.headless = headless;
  }

  isInitialized(): boolean {
    return this.context !== null && (Boolean(this.options.userDataDir) || this.browser?.isConnected() === true);
  }
}
