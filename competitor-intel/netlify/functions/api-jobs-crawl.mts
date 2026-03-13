import type { Context } from '@netlify/functions';
import { verifyAuth, unauthorizedResponse } from '../../src/services/auth.js';
import { crawlJobs } from '../../src/crawlers/jobCrawler.js';

export default async (req: Request, context: Context) => {
  // Auth check
  if (!(await verifyAuth(req))) return unauthorizedResponse();

  const found = await crawlJobs();
  return Response.json({ found });
};

export const config = { path: '/api/jobs/crawl' };
