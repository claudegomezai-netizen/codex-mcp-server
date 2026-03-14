import type { PersonnelChange } from '../config/competitors.js';
import { getAllEntitiesWithCustom, addPersonnelChanges, getSecFilings, logCrawl } from '../services/blobStore.js';
import RssParser from 'rss-parser';

const parser = new RssParser();
const USER_AGENT = 'The Dobbs Group Competitor Intel alerts@dobbsgroup.com';

function makeId(): string {
  return `per-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
}

const PERSONNEL_KEYWORDS = [
  'ceo', 'cfo', 'cio', 'coo', 'cto', 'president', 'chairman', 'director',
  'appoint', 'hire', 'resign', 'depart', 'retire', 'promote', 'succeed',
  'named', 'joins', 'joined', 'leaves', 'leaving', 'stepping down',
  'new role', 'transition', 'chief', 'head of', 'managing director',
  'partner', 'executive vice president', 'senior vice president',
];

function detectChangeType(text: string): PersonnelChange['change_type'] {
  const lower = text.toLowerCase();
  if (/resign|depart|leav|stepping\s*down|retire/i.test(lower)) return 'departure';
  if (/promot|elevated|new\s*role|transition/i.test(lower)) return 'promotion';
  if (/board|director.*appoint|elected.*board/i.test(lower)) return 'board_change';
  return 'hire';
}

function extractPersonName(text: string): string {
  // Try common patterns: "John Smith appointed as..." or "... appoints John Smith"
  // Support names with hyphens, apostrophes, and prefixes (O'Brien, McDowell, etc.)
  const namePattern = `([A-Z][a-zA-Z'\\-]+(?:\\s(?:[A-Z][a-zA-Z'\\-]+|[A-Z]\\.)){1,3})`;
  const patterns = [
    new RegExp(namePattern + `\\s*(?:has been|was|is)\\s*(?:appointed|named|hired|promoted)`),
    new RegExp(`(?:appoints?|names?|hires?|promotes?)\\s*` + namePattern),
    new RegExp(namePattern + `\\s*(?:joins?|leaves?|resigns?|retires?|departs?)`),
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return m[1].trim();
  }
  return '';
}

function extractRole(text: string): string {
  const patterns = [
    /(?:as|to)\s+((?:Chief|President|Chairman|Director|Head|Managing|Senior|Executive|Partner|Vice)[^,.;]+)/i,
    /((?:CEO|CFO|CIO|COO|CTO|CMO|CLO|CRO)\b)/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return m[1].trim();
  }
  return '';
}

export async function crawlPersonnel(): Promise<number> {
  const allEntities = await getAllEntitiesWithCustom();
  const changes: PersonnelChange[] = [];

  // 1. Scan news RSS for personnel changes
  for (const entity of allEntities.slice(0, 15)) { // Limit to avoid timeout
    for (const query of entity.searchQueries.slice(0, 1)) {
      const personnelQuery = `${query} (CEO OR hire OR appoint OR resign OR depart OR promote)`;
      const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(personnelQuery)}&hl=en-US&gl=US&ceid=US:en`;

      try {
        const feed = await parser.parseURL(rssUrl);
        for (const item of (feed.items || []).slice(0, 5)) {
          const title = item.title || '';
          const lower = title.toLowerCase();

          // Check if this is a personnel-related article
          const isPersonnel = PERSONNEL_KEYWORDS.some(kw => lower.includes(kw));
          if (!isPersonnel) continue;

          const personName = extractPersonName(title);
          if (!personName) continue;

          // Safely parse date — avoid Invalid Date crash
          let dateStr: string;
          try {
            const parsed = item.pubDate ? new Date(item.pubDate) : null;
            dateStr = (parsed && !isNaN(parsed.getTime()))
              ? parsed.toISOString().split('T')[0]
              : new Date().toISOString().split('T')[0];
          } catch {
            dateStr = new Date().toISOString().split('T')[0];
          }

          changes.push({
            id: makeId(),
            entity_id: entity.id,
            entity_name: entity.name,
            person_name: personName,
            old_role: '',
            new_role: extractRole(title),
            change_type: detectChangeType(title),
            source: 'Google News',
            source_url: item.link || '',
            date: dateStr,
            details: title,
            created_at: new Date().toISOString(),
          });
        }
      } catch (err) {
        console.warn(`[Personnel] RSS error for ${entity.name}:`, err);
      }
    }
    await new Promise(r => setTimeout(r, 200));
  }

  // 2. Scan 8-K filings for leadership changes
  const recentFilings = await getSecFilings({ filingType: '8-K', limit: 50 });
  const last30Days = Date.now() - 30 * 86400000;
  for (const filing of recentFilings) {
    const filedTime = new Date(filing.filed_date).getTime();
    if (isNaN(filedTime) || filedTime < last30Days) continue;
    const desc = (filing.description || '').toLowerCase();
    const isPersonnel = PERSONNEL_KEYWORDS.some(kw => desc.includes(kw));
    if (!isPersonnel) continue;

    const personName = extractPersonName(filing.description);
    if (!personName) continue;

    const entityMatch = allEntities.find(e =>
      filing.entity_names.some(n => n.toLowerCase().includes(e.name.toLowerCase()))
    );

    changes.push({
      id: makeId(),
      entity_id: entityMatch?.id || 'unknown',
      entity_name: entityMatch?.name || filing.company_name,
      person_name: personName,
      old_role: '',
      new_role: extractRole(filing.description),
      change_type: detectChangeType(filing.description),
      source: 'SEC 8-K',
      source_url: filing.document_url,
      date: filing.filed_date,
      details: filing.description.substring(0, 300),
      created_at: new Date().toISOString(),
    });
  }

  const added = await addPersonnelChanges(changes);

  // Cross-reference new changes against People Watchlist
  try {
    const { getWatchedPeople, addWatchlistAlerts, markWatchlistAlertEmailed, getWatchlistAlerts } = await import('../services/blobStore.js');
    const { sendWatchlistAlert } = await import('../services/resendEmail.js');
    const watchedPeople = await getWatchedPeople({ status: 'watching' });
    if (watchedPeople.length > 0 && changes.length > 0) {
      const existingAlerts = await getWatchlistAlerts({});
      const existingUrls = new Set(existingAlerts.map(a => a.source_url));
      const watchAlerts: import('../config/competitors.js').WatchlistAlert[] = [];

      for (const change of changes) {
        if (!change.person_name) continue;
        const cTokens = change.person_name.toLowerCase().split(/\s+/).filter(t => t.length > 1);
        if (cTokens.length < 2) continue;

        for (const person of watchedPeople) {
          const wTokens = person.name.toLowerCase().split(/\s+/).filter(t => t.length > 1);
          if (wTokens.length < 2) continue;
          if (wTokens[0] === cTokens[0] && wTokens[wTokens.length - 1] === cTokens[cTokens.length - 1]) {
            const sourceUrl = change.source_url || `personnel-${change.id}`;
            if (existingUrls.has(sourceUrl)) continue;
            watchAlerts.push({
              id: `wa-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`,
              watched_person_id: person.id,
              person_name: person.name,
              category: person.category,
              alert_type: change.change_type === 'departure' ? 'departure' : change.change_type === 'hire' ? 'new_role' : 'mention',
              headline: change.details || `${change.person_name} — ${change.change_type} at ${change.entity_name}`,
              source_url: sourceUrl,
              snippet: change.details || '',
              detected_company: change.entity_name,
              detected_role: change.new_role || '',
              date: change.date,
              created_at: new Date().toISOString(),
              email_sent: false,
              acknowledged: false,
            });
            existingUrls.add(sourceUrl);
          }
        }
      }

      if (watchAlerts.length > 0) {
        await addWatchlistAlerts(watchAlerts);
        try {
          const result = await sendWatchlistAlert(watchAlerts, watchedPeople);
          if (result.sent) {
            for (const a of watchAlerts) await markWatchlistAlertEmailed(a.id);
          }
        } catch (emailErr) {
          console.warn('[Personnel→Watchlist] Email failed:', emailErr);
        }
      }
    }
  } catch (e) { console.warn('[Personnel] Watchlist cross-ref failed:', e); }

  await logCrawl({
    crawl_type: 'personnel',
    entity_id: null,
    articles_found: added,
    status: 'success',
    error_message: null,
    finished_at: new Date().toISOString(),
  });

  return added;
}
