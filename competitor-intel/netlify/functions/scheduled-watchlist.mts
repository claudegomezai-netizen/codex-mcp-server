import type { Config } from '@netlify/functions';
import { crawlWatchlist } from '../../src/crawlers/watchlistCrawler.js';

export default async () => {
  console.log('[SCHEDULED] Scanning watched people...');
  const result = await crawlWatchlist();
  console.log(`[SCHEDULED] Watchlist scan complete. ${result.found} alerts, ${result.alerts_sent} emails sent.`);
};

export const config: Config = {
  schedule: '0 */4 * * *', // Every 4 hours
};
