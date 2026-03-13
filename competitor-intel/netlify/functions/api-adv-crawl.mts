import type { Context } from '@netlify/functions';
import { verifyAuth, unauthorizedResponse } from '../../src/services/auth.js';
import { analyzeAdv } from '../../src/crawlers/advAnalyzer.js';

export default async (req: Request, context: Context) => {
  // Auth check
  if (!(await verifyAuth(req))) return unauthorizedResponse();

  const url = new URL(req.url);
  const entityId = url.searchParams.get('entity') || undefined;
  const analyzed = await analyzeAdv(entityId);
  return Response.json({ analyzed });
};

export const config = { path: '/api/adv/crawl' };
