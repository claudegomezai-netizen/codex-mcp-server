import type { Context } from '@netlify/functions';
import { verifyAuth, unauthorizedResponse } from '../../src/services/auth.js';
import { sendDailyDigest } from '../../src/services/resendEmail.js';
import { getLatestBrief } from '../../src/services/blobStore.js';

export default async (req: Request, context: Context) => {
  // Auth check
  if (!(await verifyAuth(req))) return unauthorizedResponse();

  if (req.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }

  const brief = await getLatestBrief();
  if (!brief) {
    return Response.json({ error: 'No brief available. Generate a brief first.' }, { status: 404 });
  }

  const result = await sendDailyDigest(brief);
  return Response.json(result);
};

export const config = { path: '/api/email/digest' };
