/**
 * Parser tests: run the real AvitoParser against local fixture pages
 * (file:// URLs, no network / no captcha involved).
 *
 * Fixtures:
 *   item-page-new.html    — 2024+ markup: JSON-LD + data-marker, no itemprop price/description
 *   item-page-legacy.html — old microdata markup, no JSON-LD
 *   search-page.html      — search cards, geo-text classes instead of data-geo-name
 *
 * Run: npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { AvitoParser } from '../dist/core/parser.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => pathToFileURL(join(here, 'fixtures', name)).href;

async function withPage(fixtureName, fn) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route(/^https?:/, (route) => route.abort());
    await page.goto(fixture(fixtureName), { waitUntil: 'load' });
    return await fn(new AvitoParser(), page);
  } finally {
    await browser.close();
  }
}

test('details: new markup — JSON-LD wins, DOM fills gaps', async () => {
  await withPage('item-page-new.html', async (parser, page) => {
    const d = await parser.parseItemDetails(page);

    assert.equal(d.title, 'iPhone 13, 128 ГБ, SIM + eSIM');
    assert.equal(d.price, 19990);
    assert.equal(d.currency, 'RUB');
    assert.ok(d.fullDescription.includes('состояние отличное'), 'description from JSON-LD');
    assert.equal(d.id, '4718346312');
    assert.equal(d.seller.name, 'K-Mobile');
    assert.equal(d.viewsCount, 7574);
    // location comes from DOM marker (not in JSON-LD)
    assert.ok(d.location.includes('Калининград'), `location, got: ${d.location}`);
    // images: JSON-LD array
    assert.deepEqual(d.images, [
      'https://cdn.avito.ru/images/1.jpg',
      'https://cdn.avito.ru/images/2.jpg',
    ]);
    assert.equal(d.imageUrl, 'https://cdn.avito.ru/images/1.jpg');
    // specifications parsed from item-params list
    assert.deepEqual(d.specifications, {
      'Состояние': 'Б/у',
      'Память': '128 ГБ',
      'Цвет': 'черный',
    });
    // canonical URL without tracking junk
    assert.ok(d.url.startsWith('https://www.avito.ru/kaliningrad/telefony/iphone_13'));
  });
});

test('details: legacy microdata markup — fallback path works', async () => {
  await withPage('item-page-legacy.html', async (parser, page) => {
    const d = await parser.parseItemDetails(page);

    assert.equal(d.title, 'iPhone 12, 64 ГБ');
    assert.equal(d.price, 23990);
    assert.ok(d.fullDescription.includes('без комплектации'));
    assert.equal(d.location, 'Москва, Тверской район');
    assert.equal(d.seller.name, 'Иван');
    assert.equal(d.seller.reviewsCount, null);
    assert.equal(d.availableQuantity, null);
    assert.equal(d.availabilityNote, 'уточнить у продавца');
    assert.equal(d.viewsCount, 120);
    assert.equal(d.id, '3648418641');
    assert.deepEqual(d.images, ['https://cdn.avito.ru/images/legacy1.jpg']);
  });
});

test('details: count seller reviews separately from model reviews and read advertised stock', async () => {
  await withPage('item-page-new.html', async (parser, page) => {
    await page.setContent(`
      <h1>Intel Core i5-12400F</h1>
      <div data-marker="rating-caption/rating">57 отзывов</div>
      <div data-marker="item-view/seller-info">
        <div data-marker="seller-info/name">Продавец</div>
        <span>4,9</span>
        <a data-marker="rating-caption/rating" href="#open-reviews-list">1&nbsp;234 отзыва</a>
      </div>
      <div data-marker="item-view/item-description">Цена за штуку.<br>В наличии 6 шт.</div>
    `);
    const d = await parser.parseItemDetails(page);
    assert.equal(d.seller.reviewsCount, 1234);
    assert.equal(d.availableQuantity, 6);
    assert.equal(d.availabilityNote, null);
  });
});

test('details: explicit zero counts are distinguishable from missing data', async () => {
  await withPage('item-page-new.html', async (parser, page) => {
    await page.setContent(`
      <h1>Intel Core i5-12400F</h1>
      <div data-marker="item-view/seller-info">
        <a data-marker="rating-caption/rating">Нет отзывов</a>
      </div>
      <div data-marker="item-view/item-params"><ul><li>Количество в наличии: 0 шт.</li></ul></div>
    `);
    const d = await parser.parseItemDetails(page);
    assert.equal(d.seller.reviewsCount, 0);
    assert.equal(d.availableQuantity, 0);
    assert.equal(d.availabilityNote, null);
  });
});

test('details: ambiguous stock and model-only reviews stay unknown', async () => {
  await withPage('item-page-new.html', async (parser, page) => {
    for (const description of [
      'В наличии несколько штук',
      'В наличии от 5 шт.',
      'В наличии 5–7 штук',
      'В наличии -5 шт.',
      'В наличии 6 шт.<br>В наличии 8 шт.',
      'В наличии 5 шт. кулеров',
      'В наличии 5 шт. Кулеров для этой серии.',
      'i5-12400F, цена 5 000 ₽',
    ]) {
      await page.setContent(`
        <h1>Intel Core i5-12400F</h1>
        <div data-marker="rating-caption/rating">57 отзывов</div>
        <div data-marker="item-view/item-description">${description}</div>
      `);
      const d = await parser.parseItemDetails(page);
      assert.equal(d.seller.reviewsCount, null, description);
      assert.equal(d.availableQuantity, null, description);
      assert.equal(d.availabilityNote, 'уточнить у продавца', description);
    }
  });
});

test('details: conflicting numbers in the stock field and description require clarification', async () => {
  await withPage('item-page-new.html', async (parser, page) => {
    await page.setContent(`
      <h1>Intel Core i5-12400F</h1>
      <div data-marker="item-view/item-params"><ul><li>Количество в наличии: 7 шт.</li></ul></div>
      <div data-marker="item-view/item-description">6 шт. в наличии.</div>
    `);
    const d = await parser.parseItemDetails(page);
    assert.equal(d.availableQuantity, null);
    assert.equal(d.availabilityNote, 'уточнить у продавца');
  });
});

test('firewall stub ("Доступ ограничен") is detected by title even when body is in an iframe', async () => {
  await withPage('blocked-page.html', async (parser, page) => {
    assert.equal(await parser.isBlocked(page), true, 'isBlocked');
    assert.equal(await parser.detectCaptcha(page), true, 'detectCaptcha');
  });
});

test('search: cards without data-geo-name still yield location; price falls back to text', async () => {
  await withPage('search-page.html', async (parser, page) => {
    const items = await parser.parseSearchResults(page);

    assert.equal(items.length, 2);

    assert.equal(items[0].id, '4718346312');
    assert.equal(items[0].title, 'iPhone 13, 128 ГБ, SIM + eSIM');
    assert.equal(items[0].price, 19990);
    assert.ok(items[0].location.includes('Калининград'), `location, got: ${items[0].location}`);
    assert.ok(items[0].url.includes('4718346312'));

    // second card has no meta price — parsed from "22 990 ₽" text
    assert.equal(items[1].price, 22990);
    assert.ok(items[1].location.includes('Казань'), `location, got: ${items[1].location}`);
  });
});
