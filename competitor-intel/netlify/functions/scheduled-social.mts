import type { Config } from '@netlify/functions';
import { crawlSocialMedia } from '../../src/crawlers/socialCrawler.js';

export default async () => {
  console.log('[SCHEDULED] Running social media crawl...');
  const count = await crawlSocialMedia();
  console.log(`[SCHEDULED] Social media crawl complete. ${count} posts found.`);
};

export const config: Config = {
  schedule: '0 */6 * * *', // Every 6 hours
};
