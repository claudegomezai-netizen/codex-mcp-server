import type { Config } from '@netlify/functions';
import { get13FHoldings, getAll13FPeriods } from '../../src/services/blobStore.js';
import { verifyAuth, unauthorizedResponse } from '../../src/services/auth.js';
import { ENTITIES_WITH_CIK } from '../../src/crawlers/holdings13fCrawler.js';

export default async (req: Request) => {
  if (!(await verifyAuth(req))) return unauthorizedResponse();
  const url = new URL(req.url);
  const cik = url.searchParams.get('cik') || '';
  const period = url.searchParams.get('period') || undefined;

  if (!cik) {
    // Return all entities with summary data for card display
    const entitySummaries: Array<{
      name: string; cik: string; periods: string[];
      total_value_thousands: number; holdings_count: number;
      top_holdings: Array<{ issuer: string; value_thousands: number; pct: number }>;
      latest_period: string;
    }> = [];

    for (const entity of ENTITIES_WITH_CIK) {
      const p = await getAll13FPeriods(entity.cik);
      if (p.length > 0) {
        const filing = await get13FHoldings(entity.cik);
        const totalVal = filing?.total_value_thousands || 0;
        const holdings = filing?.holdings || [];
        const top3 = holdings.slice(0, 3).map(h => ({
          issuer: h.issuer,
          value_thousands: h.value_thousands,
          pct: totalVal > 0 ? Math.round((h.value_thousands / totalVal) * 10000) / 100 : 0,
        }));
        entitySummaries.push({
          name: entity.name,
          cik: entity.cik,
          periods: p,
          total_value_thousands: totalVal,
          holdings_count: holdings.length,
          top_holdings: top3,
          latest_period: p[0],
        });
      }
    }

    // Sort by total value descending
    entitySummaries.sort((a, b) => b.total_value_thousands - a.total_value_thousands);

    return new Response(JSON.stringify({ entities: entitySummaries }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const filing = await get13FHoldings(cik, period);
  const allPeriods = await getAll13FPeriods(cik);

  return new Response(JSON.stringify({ filing, periods: allPeriods }), {
    headers: { 'Content-Type': 'application/json' },
  });
};

export const config: Config = { path: '/api/13f' };
