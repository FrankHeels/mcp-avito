import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSellerReviewCount, parseSellerReviews } from '../dist/core/item-counts.js';

test('seller reviews: exact counts, grammatical forms, separators and explicit zero', () => {
  for (const [caption, count] of [
    ['1 отзыв', 1], ['2 отзыва', 2], ['15 отзывов', 15],
    ['1 234 отзыва', 1234], ['1\u00a0234 отзыва', 1234], ['1\u202f234 отзыва', 1234],
    ['Нет отзывов', 0], ['Пока нет отзывов', 0], ['Отзывов нет', 0], ['0 отзывов', 0],
  ]) {
    assert.deepEqual(parseSellerReviews([caption]), {
      reviewsCount: count, reviewsCountApproximate: false,
    }, caption);
  }
});

test('seller reviews: abbreviated thousands are numeric and explicitly approximate', () => {
  for (const [caption, count] of [
    ['1,2 тыс. отзывов', 1200], ['1.2 тыс. отзывов', 1200],
    ['2 тыс отзывов', 2000], ['1,2\u00a0тыс. отзывов', 1200],
    ['12,5\u202fтыс. отзывов', 12500], ['1,005 тыс. отзывов', 1005],
    ['  1,2 тыс. отзывов  ', 1200],
  ]) {
    assert.deepEqual(parseSellerReviews([caption]), {
      reviewsCount: count, reviewsCountApproximate: true,
    }, caption);
    assert.equal(parseSellerReviewCount([caption]), count);
  }
});

test('seller reviews: unsupported, conflicting or unsafe counts stay unknown', () => {
  for (const captions of [
    [], [''], ['4,9'], ['Проверенный продавец'], ['15 продаж'],
    ['Более 15 отзывов'], ['1,2 отзывов'], ['-1,2 тыс. отзывов'],
    ['1,2345 тыс. отзывов'], ['9007199254740992 отзывов'],
    ['9007199254741 тыс. отзывов'], ['15 отзывов', '16 отзывов'],
    ['1,2 тыс. отзывов', '1,3 тыс. отзывов'],
  ]) {
    assert.deepEqual(parseSellerReviews(captions), {
      reviewsCount: null, reviewsCountApproximate: false,
    }, captions.join(' / '));
  }
});

test('seller reviews: exact accessible count wins over abbreviated caption', () => {
  assert.deepEqual(parseSellerReviews(['1,2 тыс. отзывов', '1 234 отзыва']), {
    reviewsCount: 1234, reviewsCountApproximate: false,
  });
  assert.deepEqual(parseSellerReviews(['15 отзывов', '15 отзывов']), {
    reviewsCount: 15, reviewsCountApproximate: false,
  });
});
