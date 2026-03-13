import type { Context } from '@netlify/functions';
import { verifyAuth, unauthorizedResponse } from '../../src/services/auth.js';
import { getPersonnelChanges } from '../../src/services/blobStore.js';

export default async (req: Request, context: Context) => {
  // Auth check
  if (!(await verifyAuth(req))) return unauthorizedResponse();

  const url = new URL(req.url);
  const changes = await getPersonnelChanges({
    entityId: url.searchParams.get('entity') || undefined,
    changeType: url.searchParams.get('type') || undefined,
  });

  return Response.json(changes);
};

export const config = { path: '/api/personnel' };
