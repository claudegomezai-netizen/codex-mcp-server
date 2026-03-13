import type { Context } from '@netlify/functions';
import { verifyAuth, unauthorizedResponse } from '../../src/services/auth.js';
import { getAdvAnalyses } from '../../src/services/blobStore.js';

export default async (req: Request, context: Context) => {
  // Auth check
  if (!(await verifyAuth(req))) return unauthorizedResponse();

  const analyses = await getAdvAnalyses();
  return Response.json(analyses);
};

export const config = { path: '/api/adv' };
