import RSSParser from 'rss-parser';
import type { GovEvent } from '../config/competitors.js';
import { addGovEvents, logCrawl } from '../services/blobStore.js';

const parser = new RSSParser({
  timeout: 10000,
  headers: { 'User-Agent': 'Mozilla/5.0 (compatible; IntelBot/1.0)' },
  customFields: { item: [['dc:date', 'dcDate'], ['dc:subject', 'dcSubject']] },
});

interface GovFeed {
  name: string;
  url: string;
  category: string;
}

const GOV_FEEDS: GovFeed[] = [
  { name: 'Federal Reserve Press Releases', url: 'https://www.federalreserve.gov/feeds/press_all.xml', category: 'Federal Reserve' },
  { name: 'Federal Reserve Board Meetings', url: 'https://www.federalreserve.gov/feeds/press_monetary.xml', category: 'FOMC / Monetary Policy' },
  { name: 'SEC Press Releases', url: 'https://www.sec.gov/news/pressreleases.rss', category: 'SEC' },
  { name: 'SEC Enforcement', url: 'https://www.sec.gov/rss/litigation/litreleases.xml', category: 'SEC Enforcement' },
  { name: 'Treasury Press Releases', url: 'https://home.treasury.gov/system/files/136/treasury-press-releases.xml', category: 'Treasury' },
  { name: 'DOL News Releases', url: 'https://www.dol.gov/rss/releases.xml', category: 'Dept of Labor' },
  { name: 'BLS Economic Releases', url: 'https://www.bls.gov/feed/bls_latest.rss', category: 'Economic Data (BLS)' },
];

const FOMC_DATES = [
  { date: '2025-01-28', end: '2025-01-29' }, { date: '2025-03-18', end: '2025-03-19' },
  { date: '2025-05-06', end: '2025-05-07' }, { date: '2025-06-17', end: '2025-06-18' },
  { date: '2025-07-29', end: '2025-07-30' }, { date: '2025-09-16', end: '2025-09-17' },
  { date: '2025-10-28', end: '2025-10-29' }, { date: '2025-12-16', end: '2025-12-17' },
  { date: '2026-01-27', end: '2026-01-28' }, { date: '2026-03-17', end: '2026-03-18' },
  { date: '2026-04-28', end: '2026-04-29' }, { date: '2026-06-16', end: '2026-06-17' },
  { date: '2026-07-28', end: '2026-07-29' }, { date: '2026-09-15', end: '2026-09-16' },
  { date: '2026-11-03', end: '2026-11-04' }, { date: '2026-12-15', end: '2026-12-16' },
  // 2027 (tentative — update when Fed publishes official schedule)
  { date: '2027-01-26', end: '2027-01-27' }, { date: '2027-03-16', end: '2027-03-17' },
  { date: '2027-04-27', end: '2027-04-28' }, { date: '2027-06-15', end: '2027-06-16' },
  { date: '2027-07-27', end: '2027-07-28' }, { date: '2027-09-21', end: '2027-09-22' },
  { date: '2027-11-02', end: '2027-11-03' }, { date: '2027-12-14', end: '2027-12-15' },
];

function makeId(): string {
  return `gov-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
}

function parseEventDate(item: any): string | null {
  const raw = item.isoDate || item.dcDate || item.pubDate;
  if (!raw) return null;
  try {
    const d = new Date(raw);
    if (isNaN(d.getTime())) return null;
    return d.toISOString().split('T')[0];
  } catch {
    return null;
  }
}

function buildFomcEvents(): GovEvent[] {
  const events: GovEvent[] = [];
  for (const f of FOMC_DATES) {
    events.push({
      id: makeId(), title: 'FOMC Meeting (Day 1)',
      description: 'Federal Open Market Committee scheduled meeting. Interest rate decisions and monetary policy updates expected.',
      event_date: f.date, event_time: null, source: 'FOMC Schedule',
      category: 'FOMC / Monetary Policy',
      link: 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm',
      created_at: new Date().toISOString(),
    });
    events.push({
      id: makeId(), title: 'FOMC Meeting (Day 2 - Decision)',
      description: 'FOMC concludes. Rate decision and statement released at 2:00 PM ET. Press conference may follow.',
      event_date: f.end, event_time: '14:00 ET', source: 'FOMC Schedule',
      category: 'FOMC / Monetary Policy',
      link: 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm',
      created_at: new Date().toISOString(),
    });
  }
  return events;
}

async function crawlFeed(feed: GovFeed): Promise<GovEvent[]> {
  try {
    const parsed = await parser.parseURL(feed.url);
    return (parsed.items || []).slice(0, 30)
      .map(item => {
        const eventDate = parseEventDate(item);
        if (!eventDate) return null; // Skip items with unparseable dates
        return {
          id: makeId(),
          title: (item.title || 'Untitled').replace(/<[^>]*>/g, '').trim(),
          description: (item.contentSnippet || item.content || '').replace(/<[^>]*>/g, '').substring(0, 500).trim(),
          event_date: eventDate,
          event_time: null,
          source: feed.name,
          category: feed.category,
          link: item.link || '',
          created_at: new Date().toISOString(),
        };
      })
      .filter((e): e is GovEvent => e !== null);
  } catch (err: any) {
    console.error(`  Error crawling ${feed.name}: ${err.message}`);
    return [];
  }
}

export async function crawlGovEvents(): Promise<number> {
  console.log(`[${new Date().toISOString()}] Starting government calendar crawl...`);

  // Seed FOMC dates
  const fomcEvents = buildFomcEvents();
  const fomcNew = await addGovEvents(fomcEvents);
  if (fomcNew > 0) console.log(`  Seeded ${fomcNew} FOMC meeting dates`);

  // Crawl all feeds in parallel
  const feedResults = await Promise.allSettled(
    GOV_FEEDS.map(feed => crawlFeed(feed))
  );

  const failedFeeds = feedResults.filter(r => r.status === 'rejected').length;
  const allFeedEvents = feedResults
    .filter((r): r is PromiseFulfilledResult<GovEvent[]> => r.status === 'fulfilled')
    .flatMap(r => r.value);

  const feedNew = await addGovEvents(allFeedEvents);
  const totalNew = fomcNew + feedNew;

  const hasErrors = failedFeeds > 0;
  try {
    await logCrawl({
      crawl_type: 'gov_calendar',
      entity_id: null,
      articles_found: totalNew,
      status: hasErrors ? 'completed' : 'success',
      error_message: hasErrors ? `${failedFeeds}/${GOV_FEEDS.length} feeds failed` : null,
      finished_at: new Date().toISOString(),
    });
  } catch (logErr) {
    console.warn('[GovCal] logCrawl failed:', logErr);
  }

  console.log(`[${new Date().toISOString()}] Gov calendar crawl complete. ${totalNew} new events.${hasErrors ? ` (${failedFeeds} feeds failed)` : ''}`);
  return totalNew;
}
