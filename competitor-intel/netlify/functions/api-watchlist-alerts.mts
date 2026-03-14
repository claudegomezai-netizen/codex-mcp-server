import type { Config } from '@netlify/functions';
import { getWatchlistAlerts, acknowledgeWatchlistAlert } from '../../src/services/blobStore.js';
import { verifyAuth, unauthorizedResponse } from '../../src/services/auth.js';

export default async (req: Request) => {
  if (!(await verifyAuth(req))) return unauthorizedResponse();
  const headers = { 'Content-Type': 'application/json' };

  if (req.method === 'GET') {
    const url = new URL(req.url);
    const personId = url.searchParams.get('person_id') || undefined;
    const unack = url.searchParams.get('unacknowledged') === 'true' ? true : undefined;
    const alerts = await getWatchlistAlerts({ personId, unacknowledged: unack });
    return new Response(JSON.stringify(alerts), { headers });
  }

  if (req.method === 'POST') {
    const body = await req.json();
    const { alert_id } = body as { alert_id?: string };
    if (!alert_id) {
      return new Response(JSON.stringify({ error: 'alert_id is required' }), { status: 400, headers });
    }
    const acked = await acknowledgeWatchlistAlert(alert_id);
    if (!acked) {
      return new Response(JSON.stringify({ error: 'Alert not found' }), { status: 404, headers });
    }
    return new Response(JSON.stringify({ acknowledged: alert_id }), { headers });
  }

  return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers });
};

export const config: Config = { path: '/api/watchlist/alerts' };
