/**
 * Browser manager with Playwright
 */

import { chromium, type Browser, type BrowserContext, type LaunchOptions, type Page } from 'playwright';
import ProxyChain from 'proxy-chain';
import { getRandomUserAgent } from '../utils/user-agents.js';
import type { ProxyConfig, ScraperOptions } from './types.js';

export class BrowserManager {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private options: ScraperOptions;
  private proxyServer: any = null;
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
    const opening = this.opening ??= this.open(proxy);
    try {
      await opening;
    } finally {
      if (this.opening === opening) this.opening = null;
    }
  }

  private async open(proxy?: ProxyConfig): Promise<void> {
    const launchOptions: LaunchOptions = { headless: this.options.headless };

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
        proxy.username &&
        proxy.password;

      if (isSocksWithAuth) {
        console.error(`Настраиваем локальный прокси-туннель для ${proxy.type} с авторизацией...`);
        console.error(`Верхний прокси: ${proxy.type}://${proxy.host}:${proxy.port} (пользователь: ${proxy.username})`);

        const upstreamUrl = `${proxy.type}://${proxy.username}:${proxy.password}@${proxy.host}:${proxy.port}`;

        // Create local HTTP proxy server with error handling
        this.proxyServer = new ProxyChain.Server({
          port: 0,
          verbose: false, // Disable verbose to reduce noise
          prepareRequestFunction: ({ request, username, password, hostname, port, isHttp }) => {
            console.error(`\n[PROXY] Запрос: ${request.method} ${request.url}`);
            console.error(`[PROXY] Цель: ${hostname}:${port} (isHttp: ${isHttp})`);
            return {
              upstreamProxyUrl: upstreamUrl,
              // Try forcing connection timeout
              requestAuthentication: false,
              // Don't require auth on local proxy
              failMsg: 'Proxy connection failed',
            };
          },
        });

        // Add error handler
        this.proxyServer.on('connectionClosed', ({ connectionId, stats }: any) => {
          console.error(`[PROXY] Соединение ${connectionId} закрыто — отправлено ${stats.srcTxBytes} байт, получено ${stats.srcRxBytes} байт`);
        });

        this.proxyServer.on('requestFailed', ({ request, error }: any) => {
          console.error(`[PROXY] Запрос не удался: ${request?.url}`);
          console.error(`[PROXY] Ошибка: ${error?.message}`);
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
        if (proxy.username && proxy.password) {
          launchOptions.proxy.username = proxy.username;
          launchOptions.proxy.password = proxy.password;
        }
      }
    }

    if (this.options.userDataDir) {
      const context = await chromium.launchPersistentContext(this.options.userDataDir, {
        ...launchOptions,
        chromiumSandbox: true,
        locale: 'ru-RU',
        viewport: null,
      });
      this.context = context;
      this.page = context.pages()[0] ?? null;
      this.page?.setDefaultTimeout(this.options.timeout ?? 30000);
      context.once('close', () => {
        if (this.context === context) {
          this.context = null;
          this.page = null;
        }
      });
      return;
    }

    this.browser = await chromium.launch({
      ...launchOptions,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
        '--no-sandbox',
      ],
    });

    // Create context with stealth settings
    this.context = await this.browser.newContext({
      userAgent: this.options.userAgent || getRandomUserAgent(),
      viewport: {
        width: 1920,
        height: 1080,
      },
      locale: 'ru-RU',
      timezoneId: 'Europe/Moscow',
    });

    // Add stealth scripts
    await this.context.addInitScript(() => {
      // @ts-ignore - runs in browser context
      // Hide webdriver property
      Object.defineProperty(navigator, 'webdriver', {
        get: () => false,
      });

      // @ts-ignore - runs in browser context
      // Mock plugins
      Object.defineProperty(navigator, 'plugins', {
        get: () => [1, 2, 3, 4, 5],
      });

      // @ts-ignore - runs in browser context
      // Mock languages
      Object.defineProperty(navigator, 'languages', {
        get: () => ['ru-RU', 'ru', 'en-US', 'en'],
      });
    });
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
