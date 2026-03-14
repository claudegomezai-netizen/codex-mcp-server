import type { Config } from '@netlify/functions';
import { crawlWatchlist } from '../../src/crawlers/watchlistCrawler.js';
import { verifyAuth, unauthorizedResponse } from '../../src/services/auth.js';

export default async (req: Request) => {
  if (!(await verifyAuth(req))) return unauthorizedResponse();
  const headers = { 'Content-Type': 'application/json' };

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers });
  }

  try {
    const result = await crawlWatchlist();
    return new Response(JSON.stringify(result), { headers });
  } catch (err) {
    console.error('[Watchlist Crawl] Error:', err);
    return new Response(JSON.stringify({ error: 'Crawl failed' }), { status: 500, headers });
  }
};

export const config: Config = { path: '/api/watchlist/crawl' };
