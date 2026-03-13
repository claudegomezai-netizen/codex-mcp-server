import type { Context } from '@netlify/functions';
import { verifyAuth, unauthorizedResponse } from '../../src/services/auth.js';
import { crawlPersonnel } from '../../src/crawlers/personnelCrawler.js';

export default async (req: Request, context: Context) => {
  // Auth check
  if (!(await verifyAuth(req))) return unauthorizedResponse();

  const found = await crawlPersonnel();
  return Response.json({ found });
};

export const config = { path: '/api/personnel/crawl' };
