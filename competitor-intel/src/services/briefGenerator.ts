import type { DailyBrief, Article } from '../config/competitors.js';
import { PRIORITY_KEYWORDS } from '../config/competitors.js';
import {
  getAllEntitiesWithCustom,
  getArticlesForEntity,
  getSecFilings,
  getPredictionMarkets,
  getGovEvents,
  getPersonnelChanges,
  getFinraAlerts,

  getJobTrends,
  getMarketIndicators,
  getAumData,
} from './blobStore.js';

const STOP_WORDS = new Set([
  'the','a','an','and','or','but','in','on','at','to','for','of','with','by',
  'from','as','is','was','are','were','be','been','being','have','has','had',
  'do','does','did','will','would','shall','should','may','might','can','could',
  'not','no','nor','so','if','then','than','that','this','these','those','it',
  'its','he','she','they','we','you','i','me','my','our','your','his','her',
  'their','which','who','whom','what','where','when','how','all','each','every',
  'both','few','more','most','other','some','such','any','only','own','same',
  'also','very','just','about','new','says','said','year','years','one','two',
]);

function extractThemes(articles: Article[]): Array<{ theme: string; count: number }> {
  const freq: Record<string, number> = {};

  for (const a of articles) {
    const text = `${a.title} ${a.snippet || ''}`.toLowerCase().replace(/[^a-z\s]/g, '');
    const words = text.split(/\s+/);
    const seen = new Set<string>();
    for (const w of words) {
      if (w.length < 4 || STOP_WORDS.has(w) || seen.has(w)) continue;
      seen.add(w);
      freq[w] = (freq[w] || 0) + 1;
    }
  }

  return Object.entries(freq)
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([theme, count]) => ({ theme, count }));
}

function getArticleReason(a: Article): string {
  if (a.priority) return 'Rate Alert';
  if (a.entity_id === 'dobbs-group' && a.sentiment_label === 'negative') return 'Self Negative';
  if (a.sentiment_label === 'negative') return 'Competitor Risk';
  return 'Notable';
}

export async function generateBrief(): Promise<DailyBrief> {
  const now = new Date();
  const oneDayAgo = new Date(now.getTime() - 24 * 3600000);
  const twoDaysAgo = new Date(now.getTime() - 48 * 3600000);
  const sevenDaysAgo = new Date(now.getTime() - 7 * 86400000);
  const sevenDaysFromNow = new Date(now.getTime() + 7 * 86400000);

  const allEntities = await getAllEntitiesWithCustom();

  // ── Gather all recent articles ──
  const allArticles: Article[] = [];
  for (const entity of allEntities) {
    const articles = await getArticlesForEntity(entity.id);
    allArticles.push(...articles);
  }

  // Last 24h articles
  const last24h = allArticles.filter(
    a => new Date(a.pub_date) >= oneDayAgo
  );

  // Fall back to all articles if none in last 24h
  const recentArticles = last24h.length > 0 ? last24h : allArticles;

  // Previous 24h articles (for trend comparison)
  const prevArticles = allArticles.filter(
    a => new Date(a.pub_date) >= twoDaysAgo && new Date(a.pub_date) < oneDayAgo
  );

  // ── 1. Market Sentiment ──
  const total = recentArticles.length || 1;
  const posCount = recentArticles.filter(a => a.sentiment_label === 'positive').length;
  const neuCount = recentArticles.filter(a => a.sentiment_label === 'neutral').length;
  const negCount = recentArticles.filter(a => a.sentiment_label === 'negative').length;

  const avgScore = recentArticles.length > 0
    ? recentArticles.reduce((sum, a) => sum + a.sentiment_score, 0) / recentArticles.length
    : 0;

  const prevAvg = prevArticles.length > 0
    ? prevArticles.reduce((sum, a) => sum + a.sentiment_score, 0) / prevArticles.length
    : 0;

  const diff = avgScore - prevAvg;
  const trend: DailyBrief['market_sentiment']['trend'] =
    diff > 0.05 ? 'improving' : diff < -0.05 ? 'declining' : 'stable';

  const market_sentiment: DailyBrief['market_sentiment'] = {
    avg_score: Math.round(avgScore * 100) / 100,
    trend,
    positive_pct: Math.round((posCount / total) * 100),
    neutral_pct: Math.round((neuCount / total) * 100),
    negative_pct: Math.round((negCount / total) * 100),
    total_articles: recentArticles.length,
    prev_avg_score: Math.round(prevAvg * 100) / 100,
  };

  // ── 2. Top Stories ──
  let topCandidates = recentArticles.filter(
    a => a.priority || a.sentiment_label === 'negative'
  );
  // Fall back to all recent articles if no priority/negative ones
  if (topCandidates.length === 0) {
    topCandidates = [...recentArticles];
  }
  topCandidates.sort((a, b) => new Date(b.pub_date).getTime() - new Date(a.pub_date).getTime());

  const top_stories = topCandidates.slice(0, 10).map(a => ({
    title: a.title,
    link: a.link,
    entity_name: a.entity_name,
    sentiment_label: a.sentiment_label,
    pub_date: a.pub_date,
    reason: getArticleReason(a),
    snippet: a.snippet || '',
  }));

  // ── 3. Risk Alerts ──
  const allFilings = await getSecFilings({ limit: 200 });
  // Priority: critical/warning in 7d → all critical/warning → most recent filings of any level
  let recentFilings = allFilings.filter(
    f => new Date(f.filed_date) >= sevenDaysAgo &&
      (f.risk_level === 'critical' || f.risk_level === 'warning')
  );
  if (recentFilings.length === 0) {
    recentFilings = allFilings.filter(f => f.risk_level === 'critical' || f.risk_level === 'warning');
  }
  if (recentFilings.length === 0) {
    // Fall back to most recent filings regardless of risk level
    recentFilings = allFilings.slice(0, 10);
  }

  const risk_alerts = recentFilings.slice(0, 10).map(f => ({
    company_name: f.company_name,
    filing_type: f.filing_type,
    risk_level: f.risk_level || 'info',
    risk_score: f.risk_score || 0,
    filed_date: f.filed_date,
    document_url: f.document_url,
    description: (f.description || '').substring(0, 200),
  }));

  // ── 4. Prediction Movers ──
  const allPredictions = await getPredictionMarkets();
  const prediction_movers = allPredictions.slice(0, 8).map(m => ({
    question: m.question,
    probability: m.probability,
    volume: m.volume,
    category: m.category,
    url: m.url,
  }));

  // ── 5. Upcoming Events ──
  const todayStr = now.toISOString().split('T')[0];
  const futureStr = sevenDaysFromNow.toISOString().split('T')[0];
  const events = await getGovEvents({ startDate: todayStr, endDate: futureStr });

  const upcoming_events = events.slice(0, 10).map(e => ({
    title: e.title,
    event_date: e.event_date,
    category: e.category,
    link: e.link,
  }));

  // ── 6. Competitor Activity ──
  const competitor_activity: DailyBrief['competitor_activity'] = [];
  for (const entity of allEntities) {
    const entityArticles = allArticles.filter(
      a => a.entity_id === entity.id && new Date(a.pub_date) >= oneDayAgo
    );
    if (entityArticles.length === 0) continue;

    entityArticles.sort((a, b) => new Date(b.pub_date).getTime() - new Date(a.pub_date).getTime());
    competitor_activity.push({
      entity_id: entity.id,
      entity_name: entity.name,
      article_count: entityArticles.length,
      top_headline: entityArticles[0].title,
      top_link: entityArticles[0].link,
    });
  }
  competitor_activity.sort((a, b) => b.article_count - a.article_count);

  // ── 7. Key Themes ──
  const key_themes = extractThemes(recentArticles);

  // ── 8. Personnel Moves (last 30 days, fallback to latest) ──
  let personnel_moves: DailyBrief['personnel_moves'] = [];
  try {
    const allPersonnel = await getPersonnelChanges({});
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400000);
    let filteredPersonnel = allPersonnel
      .filter(p => new Date(p.date) >= thirtyDaysAgo);
    // Fall back to most recent if none in 30d
    if (filteredPersonnel.length === 0) {
      filteredPersonnel = allPersonnel;
    }
    // Dedup by person name (same person can appear from multiple crawl hits)
    // Skip dedup for empty names — treat them as unique entries
    const seenNames = new Set<string>();
    const dedupedPersonnel = filteredPersonnel
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
      .filter(p => {
        const key = p.person_name.toLowerCase().trim();
        if (!key) return true; // empty name = always include
        if (seenNames.has(key)) return false;
        seenNames.add(key);
        return true;
      });
    personnel_moves = dedupedPersonnel
      .slice(0, 12)
      .map(p => ({
        person_name: p.person_name,
        entity_name: p.entity_name,
        change_type: p.change_type,
        old_role: p.old_role,
        new_role: p.new_role,
        date: p.date,
      }));
  } catch (e) { console.error('[Brief] Personnel fetch failed:', e); }

  // ── 9. FINRA Alerts ──
  let finra_alerts: DailyBrief['finra_alerts'] = [];
  try {
    const allFinra = await getFinraAlerts();
    finra_alerts = allFinra.slice(0, 5).map(f => ({
      firm_name: f.firm_name,
      action_type: f.action_type,
      severity: f.severity,
      summary: f.summary,
      date: f.date,
    }));
  } catch (e) { console.error('[Brief] FINRA fetch failed:', e); }


  // ── 11. Hiring Signals ──
  let hiring_signals: DailyBrief['hiring_signals'] = [];
  try {
    const trends = await getJobTrends();
    hiring_signals = trends
      .sort((a, b) => b.total_postings - a.total_postings)
      .slice(0, 5)
      .map(t => ({
        entity_name: t.entity_name,
        total_postings: t.total_postings,
        top_departments: Object.entries(t.by_department || {})
          .sort((a, b) => b[1] - a[1])
          .slice(0, 2)
          .map(([dept]) => dept),
      }));
  } catch (e) { console.error('[Brief] Jobs fetch failed:', e); }

  // ── 12. Market Indicators ──
  let market_indicators: DailyBrief['market_indicators'] = undefined;
  try {
    const mkt = await getMarketIndicators();
    if (mkt) {
      const fg = mkt.fear_greed;
      const fredSeries = mkt.fred_series || [];
      const vixSeries = fredSeries.find(s => s.series_id === 'VIXCLS');
      const ffSeries = fredSeries.find(s => s.series_id === 'FEDFUNDS');
      market_indicators = {
        fear_greed_score: fg?.score ?? null,
        fear_greed_rating: fg?.rating ?? null,
        yield_spread: mkt.yield_spread ?? null,
        vix: vixSeries?.latest_value ?? null,
        fed_funds: ffSeries?.latest_value ?? null,
        sparklines: fredSeries.slice(0, 4).map(s => ({
          label: s.label,
          values: (s.data_points || []).slice(-20).map(dp => dp.value),
        })),
      };
    }
  } catch (e) { console.error('[Brief] Market indicators fetch failed:', e); }

  // ── 13. AUM Leaderboard ──
  let total_aum_billions: number | undefined;
  let aum_leaderboard: Array<{ entity_name: string; aum_billions: number }> = [];
  try {
    const aumData = await getAumData();
    if (aumData.length > 0) {
      aum_leaderboard = aumData
        .sort((a, b) => b.aum_billions - a.aum_billions)
        .slice(0, 8)
        .map(a => ({ entity_name: a.entity_name, aum_billions: a.aum_billions }));
      total_aum_billions = aumData.reduce((s, a) => s + a.aum_billions, 0);
    }
  } catch (e) { console.error('[Brief] AUM fetch failed:', e); }

  return {
    generated_at: now.toISOString(),
    market_sentiment,
    top_stories,
    risk_alerts,
    prediction_movers,
    upcoming_events,
    competitor_activity,
    key_themes,
    personnel_moves,
    finra_alerts,

    hiring_signals,
    market_indicators,
    total_aum_billions,
    aum_leaderboard,
  };
}
