/**
 * Social Media Crawler — Reddit (public JSON) + StockTwits
 * Reddit: public .json endpoints (no OAuth needed)
 * StockTwits: ticker symbol streams (no key needed)
 */

import type { SocialPost, SocialBuzz, SocialFeedData } from '../config/competitors.js';
import { ALL_ENTITIES } from '../config/competitors.js';
import { saveSocialFeed } from '../services/blobStore.js';

const USER_AGENT = 'CompetitorIntelDashboard/1.0 (The Dobbs Group alerts@dobbsgroup.com)';

// ── Reddit (Public JSON) ───────────────────────────────

interface RedditChild {
  data: {
    id: string; title: string; selftext: string; author: string;
    subreddit: string; permalink: string; score: number;
    num_comments: number; created_utc: number; url: string;
  };
}

async function searchReddit(query: string): Promise<RedditChild[]> {
  try {
    const params = new URLSearchParams({
      q: query, sort: 'new', t: 'month', limit: '15', type: 'link',
    });
    const res = await fetch(`https://www.reddit.com/search.json?${params}`, {
      headers: { 'User-Agent': USER_AGENT },
    });
    if (res.status === 429) {
      console.warn('[Reddit] Rate limited');
      return [];
    }
    if (!res.ok) return [];
    const data = await res.json();
    return data?.data?.children || [];
  } catch (err) {
    console.warn(`[Reddit] Error for "${query}":`, err);
    return [];
  }
}

// ── StockTwits (Symbol Streams) ─────────────────────────

interface STMessage {
  id: number; body: string; created_at: string;
  user: { username: string };
  likes?: { total: number };
  conversation?: { replies: number };
}

async function getStockTwitsStream(symbol: string): Promise<STMessage[]> {
  try {
    const res = await fetch(
      `https://api.stocktwits.com/api/2/streams/symbol/${symbol}.json?limit=15`,
      { headers: { 'User-Agent': USER_AGENT } },
    );
    if (!res.ok) return [];
    const data = await res.json();
    return data?.messages || [];
  } catch {
    return [];
  }
}

// ── Sentiment ──────────────────────────────────────────

const POS = new Set([
  'great','excellent','bullish','growth','profit','gain','outperform',
  'upgrade','strong','impressive','beat','innovative','opportunity',
  'upside','positive','expand','success','winner','momentum','surge',
  'breakthrough','confident','optimistic','record','thriving',
]);
const NEG = new Set([
  'bad','bearish','loss','decline','risk','fraud','scandal',
  'downgrade','weak','miss','concern','warning','penalty','layoff',
  'failure','crash','plunge','dump','terrible','violation','lawsuit',
  'investigation','bankrupt','default','underperform','cut',
]);

function sentiment(text: string): { score: number; label: 'positive' | 'neutral' | 'negative' } {
  const words = text.toLowerCase().split(/\W+/);
  let p = 0, n = 0;
  for (const w of words) { if (POS.has(w)) p++; if (NEG.has(w)) n++; }
  const t = p + n;
  if (t === 0) return { score: 0, label: 'neutral' };
  const score = parseFloat(((p - n) / t).toFixed(2));
  return { score, label: score > 0.2 ? 'positive' : score < -0.2 ? 'negative' : 'neutral' };
}

// ── Entity Config ──────────────────────────────────────

interface EntitySearch {
  id: string;
  name: string;
  redditTerms: string[];
  stwSymbols: string[];  // StockTwits ticker symbols
}

// Map entities to search terms + StockTwits symbols
function getEntitySearches(): EntitySearch[] {
  const map: Record<string, { reddit: string[]; stw: string[] }> = {
    'The Dobbs Group':              { reddit: ['"Dobbs Group"', '"Graystone Consulting"'],   stw: [] },  // MS is Morgan Stanley, not Dobbs Group
    'NEPC':                         { reddit: ['NEPC investment consulting'],                 stw: [] },
    'Mercer Investment Consulting': { reddit: ['Mercer investment consulting'],               stw: [] },
    'Callan Associates':            { reddit: ['"Callan Associates"'],                        stw: [] },
    'Cambridge Associates':         { reddit: ['"Cambridge Associates"'],                     stw: [] },
    'Meketa Investment Group':      { reddit: ['Meketa investment'],                          stw: [] },
    'Wilshire Associates':          { reddit: ['"Wilshire Associates"'],                      stw: [] },
    'Marquette Associates':         { reddit: ['"Marquette Associates"'],                     stw: [] },
    'CAPTRUST':                     { reddit: ['CAPTRUST financial advisor'],                 stw: [] },
    'J.P. Morgan Asset Management': { reddit: ['"JP Morgan" asset management'],               stw: ['JPM'] },
    'UBS Institutional Consulting': { reddit: ['UBS institutional consulting'],               stw: ['UBS'] },
    'William Blair':                { reddit: ['"William Blair"'],                            stw: [] },
    'SageView Advisory Group':      { reddit: ['SageView advisory'],                          stw: [] },
  };

  return ALL_ENTITIES.slice(0, 13).map(e => ({
    id: e.id,
    name: e.name,
    redditTerms: map[e.name]?.reddit || [`"${e.name}"`],
    stwSymbols: map[e.name]?.stw || [],
  }));
}

// ── Helpers ─────────────────────────────────────────────

function dedup(posts: SocialPost[]): SocialPost[] {
  const seen = new Set<string>();
  return posts.filter(p => { if (seen.has(p.id)) return false; seen.add(p.id); return true; });
}

// Serial with delay
async function serialWithDelay<T>(items: T[], delayMs: number, fn: (item: T) => Promise<void>): Promise<void> {
  for (const item of items) {
    await fn(item);
    await new Promise(r => setTimeout(r, delayMs));
  }
}

// ── Main Crawler ────────────────────────────────────────

export async function crawlSocialMedia(): Promise<number> {
  const now = new Date().toISOString();
  const redditPosts: SocialPost[] = [];
  const stwPosts: SocialPost[] = [];
  const entities = getEntitySearches();

  // Also add broad industry terms for Reddit
  const industryTerms = [
    'investment consultant pension',
    'OCIO outsourced CIO',
    'institutional investment advisor',
  ];

  // ── Run Reddit + StockTwits in PARALLEL ──
  const redditPromise = (async () => {
    console.log('[Social] Reddit: searching...');

    // Entity-specific searches
    for (const entity of entities) {
      for (const term of entity.redditTerms) {
        const posts = await searchReddit(term);
        for (const p of posts) {
          const d = p.data;
          if (!d || !d.id || !d.title) continue;  // skip malformed entries
          const s = sentiment(`${d.title} ${d.selftext || ''}`);
          redditPosts.push({
            id: `reddit-${d.id}`, platform: 'reddit',
            entity_id: entity.id, entity_name: entity.name,
            author: d.author || 'unknown', content: (d.selftext || '').slice(0, 500),
            title: d.title, subreddit: d.subreddit || '',
            url: d.permalink ? `https://reddit.com${d.permalink}` : '',
            score: Number(d.score) || 0, comments: Number(d.num_comments) || 0,
            sentiment_score: s.score, sentiment_label: s.label,
            posted_at: d.created_utc ? new Date(d.created_utc * 1000).toISOString() : now,
            fetched_at: now,
          });
        }
        await new Promise(r => setTimeout(r, 1100));
      }
    }

    // Broad industry searches
    for (const term of industryTerms) {
      const posts = await searchReddit(term);
      for (const p of posts) {
        const d = p.data;
        if (!d || !d.id || !d.title) continue;  // skip malformed entries
        const text = `${d.title} ${d.selftext || ''}`.toLowerCase();
        const s = sentiment(`${d.title} ${d.selftext || ''}`);
        // Try to match to a known entity
        const match = entities.find(e =>
          e.redditTerms.some(t => text.includes(t.replace(/"/g, '').toLowerCase()))
        );
        redditPosts.push({
          id: `reddit-${d.id}`, platform: 'reddit',
          entity_id: match?.id || 'industry',
          entity_name: match?.name || 'Industry Discussion',
          author: d.author || 'unknown', content: (d.selftext || '').slice(0, 500),
          title: d.title, subreddit: d.subreddit || '',
          url: d.permalink ? `https://reddit.com${d.permalink}` : '',
          score: Number(d.score) || 0, comments: Number(d.num_comments) || 0,
          sentiment_score: s.score, sentiment_label: s.label,
          posted_at: d.created_utc ? new Date(d.created_utc * 1000).toISOString() : now,
          fetched_at: now,
        });
      }
      await new Promise(r => setTimeout(r, 1100));
    }

    console.log(`[Social] Reddit: ${redditPosts.length} posts`);
  })();

  const stwPromise = (async () => {
    console.log('[Social] StockTwits: fetching symbol streams...');

    // Collect all unique symbols
    const allSymbols = new Map<string, EntitySearch>();
    for (const e of entities) {
      for (const sym of e.stwSymbols) {
        allSymbols.set(sym, e);
      }
    }
    // Also add some general finance tickers for broader coverage
    const extraSymbols: [string, string, string][] = [
      ['BLK', 'blackrock', 'BlackRock'],
      ['BEN', 'franklin-templeton', 'Franklin Templeton'],
      ['TROW', 'troweprice', 'T. Rowe Price'],
      ['IVZ', 'invesco', 'Invesco'],
      ['AMG', 'affiliated-managers', 'Affiliated Managers'],
    ];

    for (const [sym, id, name] of extraSymbols) {
      if (!allSymbols.has(sym)) {
        allSymbols.set(sym, { id, name, redditTerms: [], stwSymbols: [sym] });
      }
    }

    for (const [symbol, entity] of allSymbols) {
      const messages = await getStockTwitsStream(symbol);
      for (const msg of messages) {
        if (!msg || !msg.id || !msg.body) continue;  // skip malformed
        const s = sentiment(msg.body);
        stwPosts.push({
          id: `stw-${msg.id}`, platform: 'stocktwits',
          entity_id: entity.id, entity_name: entity.name,
          author: msg.user?.username || 'unknown',
          content: (msg.body || '').slice(0, 500),
          url: `https://stocktwits.com/message/${msg.id}`,
          score: Number(msg.likes?.total) || 0,
          comments: Number(msg.conversation?.replies) || 0,
          sentiment_score: s.score, sentiment_label: s.label,
          posted_at: msg.created_at || now,
          fetched_at: now,
        });
      }
      await new Promise(r => setTimeout(r, 400));
    }

    console.log(`[Social] StockTwits: ${stwPosts.length} posts`);
  })();

  // Wait for both to finish
  await Promise.all([redditPromise, stwPromise]);

  // ── Combine + dedup ──
  const allPosts = dedup([...redditPosts, ...stwPosts]);
  console.log(`[Social] Total: ${allPosts.length} unique posts`);

  // ── Build buzz summary ──
  const buzzMap = new Map<string, SocialBuzz>();

  for (const post of allPosts) {
    let buzz = buzzMap.get(post.entity_id);
    if (!buzz) {
      buzz = {
        entity_id: post.entity_id, entity_name: post.entity_name,
        mention_count: 0, avg_sentiment: 0, sentiment_label: 'neutral',
        top_post: null, platforms: { reddit: 0, stocktwits: 0 },
      };
      buzzMap.set(post.entity_id, buzz);
    }
    buzz.mention_count++;
    buzz.platforms[post.platform]++;
    if (!buzz.top_post || post.score > buzz.top_post.score) {
      buzz.top_post = { title: post.title || post.content.slice(0, 80), url: post.url, score: post.score };
    }
  }

  for (const [id, buzz] of buzzMap) {
    const ep = allPosts.filter(p => p.entity_id === id);
    if (ep.length > 0) {
      const avg = ep.reduce((s, p) => s + p.sentiment_score, 0) / ep.length;
      buzz.avg_sentiment = parseFloat(avg.toFixed(2));
      buzz.sentiment_label = avg > 0.1 ? 'positive' : avg < -0.1 ? 'negative' : 'neutral';
    }
  }

  const buzzSummary = Array.from(buzzMap.values()).sort((a, b) => b.mention_count - a.mention_count);

  // ── Save ──
  await saveSocialFeed({
    posts: allPosts.sort((a, b) => new Date(b.posted_at).getTime() - new Date(a.posted_at).getTime()).slice(0, 1000),
    buzz_summary: buzzSummary,
    updated_at: now,
  });

  return allPosts.length;
}
