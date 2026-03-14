import type { WatchlistAlert, WatchedPerson } from '../config/competitors.js';
import {
  getWatchedPeople, updateWatchedPerson,
  getWatchlistAlerts, addWatchlistAlerts, markWatchlistAlertEmailed,
  getPersonnelChanges, logCrawl,
} from '../services/blobStore.js';
import RssParser from 'rss-parser';

const parser = new RssParser();

const JOB_CHANGE_KEYWORDS = [
  'appoint', 'hire', 'resign', 'depart', 'retire', 'promote', 'succeed',
  'named', 'joins', 'joined', 'leaves', 'leaving', 'stepping down',
  'new role', 'transition', 'linkedin',
];

const DEPARTURE_RE = /resign|depart|leav|stepping\s*down|retire|exit/i;
const NEW_ROLE_RE = /appoint|hire|join|named|promot|succeeds?|takes over/i;

function makeId(): string {
  return `wa-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
}

function detectAlertType(text: string, currentCompany: string): WatchlistAlert['alert_type'] {
  const lower = text.toLowerCase();
  const mentionsCurrentCo = currentCompany && lower.includes(currentCompany.toLowerCase());
  if (DEPARTURE_RE.test(lower) && mentionsCurrentCo) return 'departure';
  if (NEW_ROLE_RE.test(lower) && !mentionsCurrentCo) return 'new_role';
  if (DEPARTURE_RE.test(lower)) return 'departure';
  if (NEW_ROLE_RE.test(lower)) return 'new_role';
  return 'mention';
}

function extractCompany(text: string, knownCompany: string): string {
  // Try to find company names near "joins", "at", "to" keywords
  const patterns = [
    /(?:joins?|at|to|with)\s+([A-Z][A-Za-z&\s]{2,30}(?:Inc|Corp|LLC|LP|Group|Partners|Capital|Associates|Advisors)?)/,
    /([A-Z][A-Za-z&\s]{2,30}(?:Inc|Corp|LLC|LP|Group|Partners|Capital|Associates|Advisors)?)\s+(?:appoints?|hires?|names?)/,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) {
      const found = m[1].trim();
      if (found.toLowerCase() !== knownCompany.toLowerCase()) return found;
    }
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

function nameMatchScore(watchedName: string, candidateName: string): boolean {
  const wTokens = watchedName.toLowerCase().split(/\s+/).filter(t => t.length > 1);
  const cTokens = candidateName.toLowerCase().split(/\s+/).filter(t => t.length > 1);
  if (wTokens.length < 2 || cTokens.length < 2) return false;
  // Match if first and last name tokens match
  return wTokens[0] === cTokens[0] && wTokens[wTokens.length - 1] === cTokens[cTokens.length - 1];
}

export async function crawlWatchlist(): Promise<{ found: number; alerts_sent: number }> {
  const people = await getWatchedPeople({ status: 'watching' });
  if (people.length === 0) return { found: 0, alerts_sent: 0 };

  const existingAlerts = await getWatchlistAlerts({});
  const existingUrls = new Set(existingAlerts.map(a => a.source_url));
  const newAlerts: WatchlistAlert[] = [];

  // 1. Scan Google News RSS for each watched person
  for (const person of people.slice(0, 50)) {
    for (const query of person.search_queries.slice(0, 2)) {
      const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
      try {
        const feed = await parser.parseURL(rssUrl);
        for (const item of (feed.items || []).slice(0, 5)) {
          const title = item.title || '';
          const link = item.link || '';
          if (!link || existingUrls.has(link)) continue;

          const lower = title.toLowerCase();
          // Must contain person's name (at least last name)
          const nameTokens = person.name.toLowerCase().split(/\s+/);
          const lastName = nameTokens[nameTokens.length - 1];
          if (!lower.includes(lastName)) continue;

          // Must contain a job-change keyword
          const hasKeyword = JOB_CHANGE_KEYWORDS.some(kw => lower.includes(kw));
          if (!hasKeyword) continue;

          let dateStr: string;
          try {
            const parsed = item.pubDate ? new Date(item.pubDate) : null;
            dateStr = (parsed && !isNaN(parsed.getTime()))
              ? parsed.toISOString().split('T')[0]
              : new Date().toISOString().split('T')[0];
          } catch {
            dateStr = new Date().toISOString().split('T')[0];
          }

          const snippet = (item.contentSnippet || item.content || title).substring(0, 200);
          const alertType = detectAlertType(title + ' ' + snippet, person.current_company);
          const detectedCompany = extractCompany(title + ' ' + snippet, person.current_company);
          const detectedRole = extractRole(title + ' ' + snippet);

          const alert: WatchlistAlert = {
            id: makeId(),
            watched_person_id: person.id,
            person_name: person.name,
            category: person.category,
            alert_type: alertType,
            headline: title,
            source_url: link,
            snippet,
            detected_company: detectedCompany,
            detected_role: detectedRole,
            date: dateStr,
            created_at: new Date().toISOString(),
            email_sent: false,
            acknowledged: false,
          };

          newAlerts.push(alert);
          existingUrls.add(link); // prevent dups within this run
        }
      } catch (err) {
        console.warn(`[Watchlist] RSS error for ${person.name}:`, err);
      }
      await new Promise(r => setTimeout(r, 200));
    }

    // 2. Cross-reference with existing personnel changes
    const personnelChanges = await getPersonnelChanges({});
    for (const change of personnelChanges.slice(0, 100)) {
      if (!change.person_name) continue;
      if (!nameMatchScore(person.name, change.person_name)) continue;
      // Check if we already have an alert for this source
      if (change.source_url && existingUrls.has(change.source_url)) continue;
      const sourceUrl = change.source_url || `personnel-${change.id}`;

      newAlerts.push({
        id: makeId(),
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

    // Update last_checked_at
    await updateWatchedPerson(person.id, { last_checked_at: new Date().toISOString() });

    // Auto-update status if departure confirmed from current company
    const departures = newAlerts.filter(a =>
      a.watched_person_id === person.id && a.alert_type === 'departure'
    );
    if (departures.length > 0) {
      await updateWatchedPerson(person.id, { status: 'moved' });
    }

    await new Promise(r => setTimeout(r, 300));
  }

  // 3. Save alerts
  const added = await addWatchlistAlerts(newAlerts);

  // 4. Send email alerts (try Resend)
  let alertsSent = 0;
  if (newAlerts.length > 0) {
    try {
      const { sendWatchlistAlert } = await import('../services/resendEmail.js');
      const result = await sendWatchlistAlert(newAlerts, people);
      if (result.sent) {
        alertsSent = newAlerts.length;
        for (const a of newAlerts) {
          await markWatchlistAlertEmailed(a.id);
        }
      }
    } catch (err) {
      console.warn('[Watchlist] Email send failed:', err);
    }
  }

  await logCrawl({
    crawl_type: 'watchlist',
    entity_id: null,
    articles_found: added,
    status: 'success',
    error_message: null,
    finished_at: new Date().toISOString(),
  });

  return { found: added, alerts_sent: alertsSent };
}
