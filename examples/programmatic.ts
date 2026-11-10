/**
 * Example: Using scraper programmatically
 */

import { AvitoScraper } from '../src/core/scraper.js';

async function main() {
  const scraper = new AvitoScraper({
    headless: true,
    delayMs: [2000, 4000], // 2-4 seconds delay
  });

  try {
    console.log('Searching for Samsung SSD...');

    const results = await scraper.search({
      query: 'Samsung SSD 2TB M.2',
      priceMax: 15000,
      sort: 'price_asc',
    });

    console.log(`Found ${results.length} results:\n`);

    results.forEach((item, index) => {
      console.log(`${index + 1}. ${item.title}`);
      console.log(`   Price: ${item.price} ₽`);
      console.log(`   Location: ${item.location}`);
      console.log(`   Seller reviews: ${item.seller.reviewsCountApproximate ? '≈' : ''}${item.seller.reviewsCount ?? 'unknown'}`);
      console.log(`   URL: ${item.url}\n`);
    });

    // Example user criterion: at least 100 seller reviews. Filter AFTER search
    // and BEFORE details (avito_get_details for MCP clients). Unknown/rounded
    // counts need verification; search itself must keep all cards for pagination.
    const minReviews = 100;
    const candidates = results.filter(({ seller }) =>
      seller.reviewsCount === null || seller.reviewsCountApproximate ||
      seller.reviewsCount >= minReviews,
    );
    if (candidates.length > 0) {
      console.log('Fetching details of first candidate...');
      const details = await scraper.getItemDetails(candidates[0].url);
      console.log(`\nDetails:`);
      console.log(`Seller: ${details.seller.name}`);
      const reviews = details.seller;
      console.log(`Review criterion: ${reviews.reviewsCount === null || reviews.reviewsCountApproximate
        ? 'unconfirmed' : reviews.reviewsCount >= minReviews ? 'matched' : 'not matched'}`);
      console.log(`Views: ${details.viewsCount}`);
      console.log(`Images: ${details.images.length}`);
    }
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await scraper.close();
  }
}

main();
