# MCP Server Setup - Claude Desktop / opencode Integration

## Обзор

MCP (Model Context Protocol) сервер позволяет Claude Desktop и opencode использовать Avito Scraper напрямую через встроенные инструменты.

Первый поисковый запрос или запрос карточки открывает видимое окно Chromium. MCP переиспользует вкладку, а профиль хранится на диске в `~/.avito-scraper/mcp-profile`. При необходимости задайте отдельный абсолютный путь через `AVITO_PROFILE_DIR`. Для одновременной работы нескольких MCP-клиентов укажите отдельный каталог каждому клиенту.

## Установка

### 1. Собрать проект

```bash
cd C:\Temp\mcp-avito
pnpm install
pnpm exec playwright install chromium
pnpm build
```

### 2. Найти конфигурационный файл Claude Desktop

**Windows:**
```
%APPDATA%\Claude\claude_desktop_config.json
```

Полный путь обычно:
```
C:\Users\<USERNAME>\AppData\Roaming\Claude\claude_desktop_config.json
```

**macOS:**
```
~/Library/Application Support/Claude/claude_desktop_config.json
```

**Linux:**
```
~/.config/Claude/claude_desktop_config.json
```

### 3. Добавить конфигурацию MCP сервера

Откройте файл `claude_desktop_config.json` и добавьте:

```json
{
  "mcpServers": {
    "avito-scraper": {
      "command": "node",
      "args": [
        "C:\\Temp\\mcp-avito\\dist\\mcp\\server.js"
      ]
    }
  }
}
```

**Важно:** Замените пути на абсолютные пути к вашим файлам!

**macOS/Linux:**
```json
{
  "mcpServers": {
    "avito-scraper": {
      "command": "node",
      "args": [
        "/absolute/path/to/mcp-avito/dist/mcp/server.js"
      ]
    }
  }
}
```

### 4. Перезапустить Claude Desktop

Полностью закройте и откройте Claude Desktop заново.

---

## Настройка для opencode

opencode подключает MCP-сервер через проектный конфиг `opencode.json` (в корне проекта). Файл уже добавлен в репозиторий:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "avito": {
      "type": "local",
      "command": ["node", "dist/mcp/server.js"],
      "enabled": true
    }
  }
}
```

**Шаги:**

1. Убедитесь, что проект собран (нужен `dist/mcp/server.js`):
   ```bash
   pnpm install && pnpm build
   ```
2. Проверьте, что пути в `opencode.json` указывают на ваш проект (пути абсолютные).
3. Перезапустите opencode — конфиг читается только при старте, хот-релоада нет.

**Проверка:** после запуска в opencode появятся инструменты с префиксом `avito_` (`avito_search`, `avito_get_details`, `avito_search_all`).

---

## Доступные инструменты

После настройки в Claude Desktop появятся 3 новых инструмента:

### 1. `avito_search`

Поиск товаров на Avito.ru

**Параметры:**
- `query` (обязательно) - Поисковый запрос
- `price_min` (опционально) - Минимальная цена в рублях
- `price_max` (опционально) - Максимальная цена в рублях
- `location_id` (опционально) - ID региона
- `page` (опционально) - Номер страницы (по умолчанию: 1)
- `sort` (опционально) - Сортировка: default, date, price_asc, price_desc

**Пример использования в Claude Desktop:**

```
Найди Samsung SSD до 15000 рублей на Avito
```

Claude автоматически вызовет:
```json
{
  "query": "Samsung SSD",
  "price_max": 15000
}
```

### 2. `avito_get_details`

Получить детальную информацию о товаре

**Параметры:**
- `url` (обязательно) - URL товара на Avito

**Пример:**

```
Покажи детали этого объявления: https://www.avito.ru/moskva/tovary_dlya_kompyutera/...
```

### 3. `avito_search_all`

Поиск по всем страницам (множество результатов)

**Параметры:**
- `query` (обязательно) - Поисковый запрос
- `price_min`, `price_max`, `location_id`, `sort` - Фильтры
- `limit` (опционально) - Максимальное количество результатов

**Пример:**

```
Найди все MacBook Pro до 100000 рублей на Avito (макс 50 штук)
```

---

## Примеры диалогов с Claude Desktop

### Пример 1: Простой поиск

**Вы:**
```
Найди iPhone 13 на Avito до 50000 рублей
```

**Claude:**
Использует `avito_search`:
```json
{
  "query": "iPhone 13",
  "price_max": 50000
}
```

Выведет:
```
Найдено 50 объявлений:

1. iPhone 13 128GB - 45000₽
   Москва
   https://www.avito.ru/...

2. iPhone 13 Pro 256GB - 48000₽
   Санкт-Петербург
   https://www.avito.ru/...

...
```

### Пример 2: С детальной информацией

**Вы:**
```
Найди самый дешевый Samsung SSD на Avito и покажи его детали
```

**Claude:**
1. Вызывает `avito_search` с `sort: "price_asc"`
2. Берет первый результат
3. Вызывает `avito_get_details` с URL товара
4. Показывает полную информацию

### Пример 3: Сравнение цен

**Вы:**
```
Сравни цены на MacBook Pro M3 на Avito
```

**Claude:**
1. Вызывает `avito_search` с запросом "MacBook Pro M3"
2. Анализирует результаты
3. Выводит статистику: минимальная, максимальная, средняя цена
4. Показывает лучшие предложения

---

## Отладка

### Проверить, что MCP сервер работает

```bash
cd C:\Temp\mcp-avito
pnpm mcp:dev
```

Сервер должен вывести:
```
Avito MCP server running on stdio
```

### Проверить логи Claude Desktop

**Windows:**
```
%APPDATA%\Claude\logs\
```

**macOS:**
```
~/Library/Logs/Claude/
```

### Типичные проблемы

#### 1. "MCP server not found"

**Проблема:** Неверные пути в конфигурации

**Решение:**
- Убедитесь что пути абсолютные (не относительные)
- Проверьте что файл `dist/mcp/server.js` существует
- На Windows используйте двойные обратные слеши: `C:\\Temp\\...`

#### 2. "Browser not found"

**Проблема:** Chrome не найден

**Решение:**
- Добавьте переменную окружения `CHROME_EXECUTABLE_PATH` в конфиг
- Или установите Chromium: `npx playwright install chromium`

#### 3. Капча и ограничения доступа

- `CAPTCHA_DETECTED` — пройдите проверку вручную в открытом окне Chromium и повторите запрос.
- `AVITO_ACCESS_RESTRICTED` — Авито ограничил доступ. В открытом окне можно увидеть сообщение площадки.
- `AVITO_RATE_LIMITED` — Авито вернул HTTP 429. Повторите запрос позже.

---

## Прокси поддержка (опционально)

Для использования прокси с MCP сервером, создайте файл `.env`:

```env
# Proxy configuration
PROXY_LIST_FILE=C:\Temp\mcp-avito\config\proxies-local.txt
PROXY_ROTATION=round-robin
```

Затем обновите MCP сервер, чтобы читать настройки из `.env`.

---

## Расширенная конфигурация

### С прокси

```json
{
  "mcpServers": {
    "avito-scraper": {
      "command": "node",
      "args": [
        "C:\\Temp\\mcp-avito\\dist\\mcp\\server.js"
      ],
      "env": {
        "CHROME_EXECUTABLE_PATH": "C:\\Temp\\mcp-avito\\chrome-win64\\chrome.exe",
        "PROXY_LIST_FILE": "C:\\Temp\\mcp-avito\\config\\proxies-local.txt",
        "PROXY_ROTATION": "round-robin"
      }
    }
  }
}
```

### С таймаутом

```json
{
  "mcpServers": {
    "avito-scraper": {
      "command": "node",
      "args": [
        "C:\\Temp\\mcp-avito\\dist\\mcp\\server.js"
      ],
      "env": {
        "CHROME_EXECUTABLE_PATH": "C:\\Temp\\mcp-avito\\chrome-win64\\chrome.exe",
        "SCRAPER_TIMEOUT": "60000",
        "SCRAPER_DELAY_MIN": "2000",
        "SCRAPER_DELAY_MAX": "5000"
      }
    }
  }
}
```

---

## Безопасность

⚠️ **Важно:**

- MCP открывает Chromium с выделенным профилем. Используйте для `AVITO_PROFILE_DIR` отдельный каталог.
- Профиль может содержать cookies и данные сессии. Храните его вне репозитория.

---

## Производительность

### Оптимизация

MCP сервер переиспользует один экземпляр браузера между запросами для ускорения:

- Первый запрос: ~3-5 секунд (запуск браузера)
- Последующие запросы: ~2-3 секунды (только навигация)

### Лимиты

- `avito_search` - возвращает до 50 результатов (ограничение Avito)
- `avito_search_all` - может вернуть сотни результатов, используйте `limit`

---

## Следующие шаги

После настройки MCP сервера:

1. Протестируйте базовый поиск в Claude Desktop
2. Попробуйте комплексные запросы
3. Настройте прокси если нужно
4. См. [USAGE.md](./USAGE.md) для примеров использования CLI

---

_Обновлено: 2026-02-04_
