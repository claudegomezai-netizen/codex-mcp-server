/**
 * Social Media Crawler — Reddit (public JSON) + StockTwits
 * Monitors competitor mentions across social platforms
 * Reddit: uses public .json endpoints (no OAuth / API key needed)
 * StockTwits: uses public API (no key needed)
 */

import type { SocialPost, SocialBuzz, SocialFeedData } from '../config/competitors.js';
import { ALL_ENTITIES } from '../config/competitors.js';
import { saveSocialFeed } from '../services/blobStore.js';

// ── Reddit (Public JSON) ───────────────────────────────

const REDDIT_BASE = 'https://www.reddit.com';
const USER_AGENT = 'CompetitorIntelDashboard/1.0 (The Dobbs Group alerts@dobbsgroup.com)';

const SUBREDDITS = [
  'investing', 'finance', 'wallstreetbets', 'financialplanning',
  'stocks', 'personalfinance', 'wealthmanagement', 'CFP',
  'FinancialAdvisors', 'institutionalinvestors',
];

interface RedditChild {
  data: {
    id: string;
    title: string;
    selftext: string;
    author: string;
    subreddit: string;
    permalink: string;
    score: number;
    num_comments: number;
    created_utc: number;
    url: string;
  };
}

async function searchRedditPublic(query: string): Promise<RedditChild[]> {
  try {
    // Search across all of Reddit via public JSON endpoint
    const params = new URLSearchParams({
      q: query,
      sort: 'new',
      t: 'week',
      limit: '15',
      type: 'link',
    });
    const url = `${REDDIT_BASE}/search.json?${params}`;

    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
    });

    if (res.status === 429) {
      console.warn(`[Reddit] Rate limited, backing off...`);
      await new Promise(r => setTimeout(r, 5000));
      return [];
    }

    if (!res.ok) {
      console.warn(`[Reddit] Search failed for "${query}": ${res.status}`);
      return [];
    }

    const data = await res.json();
    return data?.data?.children || [];
  } catch (err) {
    console.warn(`[Reddit] Search error for "${query}":`, err);
    return [];
  }
}

async function searchSubreddit(subreddit: string, query: string): Promise<RedditChild[]> {
  try {
    const params = new URLSearchParams({
      q: query,
      sort: 'new',
      t: 'week',
      limit: '10',
      restrict_sr: 'true',
      type: 'link',
    });
    const url = `${REDDIT_BASE}/r/${subreddit}/search.json?${params}`;

    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
    });

    if (res.status === 429) {
      await new Promise(r => setTimeout(r, 5000));
      return [];
    }
    if (!res.ok) return [];

    const data = await res.json();
    return data?.data?.children || [];
  } catch {
    return [];
  }
}

// ── StockTwits ──────────────────────────────────────────

const STOCKTWITS_API = 'https://api.stocktwits.com/api/2';

interface StockTwitsMessage {
  id: number;
  body: string;
  created_at: string;
  user: { username: string };
  entities?: { sentiment?: { basic: string } };
  likes?: { total: number };
  conversation?: { replies: number };
}

async function searchStockTwitsGeneral(query: string): Promise<StockTwitsMessage[]> {
  try {
    const url = `${STOCKTWITS_API}/search.json?q=${encodeURIComponent(query)}&type=messages&limit=10`;
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
    });

    if (!res.ok) {
      console.warn(`[StockTwits] Search failed for "${query}": ${res.status}`);
      return [];
    }

    const data = await res.json();
    return data?.messages || [];
  } catch {
    return [];
  }
}

// ── Sentiment Analysis ──────────────────────────────────

const POSITIVE_WORDS = new Set([
  'great', 'excellent', 'bullish', 'growth', 'profit', 'gain', 'outperform',
  'upgrade', 'strong', 'impressive', 'beat', 'innovative', 'opportunity',
  'upside', 'positive', 'expand', 'success', 'winner', 'momentum', 'surge',
  'breakthrough', 'confident', 'optimistic', 'record', 'thriving',
]);

const NEGATIVE_WORDS = new Set([
  'bad', 'bearish', 'loss', 'decline', 'risk', 'fraud', 'scandal',
  'downgrade', 'weak', 'miss', 'concern', 'warning', 'penalty', 'layoff',
  'failure', 'crash', 'plunge', 'dump', 'terrible', 'violation', 'lawsuit',
  'investigation', 'bankrupt', 'default', 'underperform', 'cut',
]);

function analyzeSentiment(text: string): { score: number; label: 'positive' | 'neutral' | 'negative' } {
  const words = text.toLowerCase().split(/\W+/);
  let pos = 0;
  let neg = 0;

  for (const w of words) {
    if (POSITIVE_WORDS.has(w)) pos++;
    if (NEGATIVE_WORDS.has(w)) neg++;
  }

  const total = pos + neg;
  if (total === 0) return { score: 0, label: 'neutral' };

  const score = parseFloat(((pos - neg) / total).toFixed(2));
  const label = score > 0.2 ? 'positive' : score < -0.2 ? 'negative' : 'neutral';
  return { score, label };
}

// ── Main Crawler ────────────────────────────────────────

// Build search terms for each entity — use short distinctive names
function getSearchTerms(entityName: string): string[] {
  const shortNames: Record<string, string[]> = {
    'The Dobbs Group': ['"Dobbs Group"', '"Graystone Consulting"'],
    'NEPC': ['NEPC investing'],
    'Mercer Investment Consulting': ['Mercer investment consulting'],
    'Callan Associates': ['"Callan Associates"'],
    'Cambridge Associates': ['"Cambridge Associates"'],
    'Meketa Investment Group': ['Meketa investment'],
    'Wilshire Associates': ['"Wilshire Associates"'],
    'Marquette Associates': ['"Marquette Associates"'],
    'CAPTRUST': ['CAPTRUST financial'],
    'J.P. Morgan Asset Management': ['JP Morgan asset management'],
    'UBS Institutional Consulting': ['UBS institutional consulting'],
    'William Blair': ['"William Blair"'],
    'SageView Advisory Group': ['SageView advisory'],
  };

  return shortNames[entityName] || [`"${entityName}"`];
}

// Dedup posts by ID
function dedup(posts: SocialPost[]): SocialPost[] {
  const seen = new Set<string>();
  return posts.filter(p => {
    if (seen.has(p.id)) return false;
    seen.add(p.id);
    return true;
  });
}

export async function crawlSocialMedia(): Promise<number> {
  const now = new Date().toISOString();
  const allPosts: SocialPost[] = [];
  const entities = ALL_ENTITIES.slice(0, 13); // Main competitors only

  // ── Reddit Crawl (public JSON, no auth needed) ──
  let redditCount = 0;
  console.log('[Social] Searching Reddit (public JSON)...');

  for (const entity of entities) {
    const terms = getSearchTerms(entity.name);

    for (const term of terms) {
      // Global search first
      const posts = await searchRedditPublic(term);

      for (const post of posts) {
        const d = post.data;
        const text = `${d.title} ${d.selftext || ''}`;
        const sentiment = analyzeSentiment(text);

        allPosts.push({
          id: `reddit-${d.id}`,
          platform: 'reddit',
          entity_id: entity.id,
          entity_name: entity.name,
          author: d.author,
          content: (d.selftext || '').slice(0, 500),
          title: d.title,
          subreddit: d.subreddit,
          url: `https://reddit.com${d.permalink}`,
          score: d.score,
          comments: d.num_comments,
          sentiment_score: sentiment.score,
          sentiment_label: sentiment.label,
          posted_at: new Date(d.created_utc * 1000).toISOString(),
          fetched_at: now,
        });
        redditCount++;
      }

      // Respect Reddit rate limits — ~1 req/sec for unauthenticated
      await new Promise(r => setTimeout(r, 1100));
    }
  }

  console.log(`[Social] Reddit: ${redditCount} posts found`);

  // ── StockTwits Crawl ──
  let stwCount = 0;
  console.log('[Social] Searching StockTwits...');

  for (const entity of entities) {
    const terms = getSearchTerms(entity.name);

    for (const term of terms) {
      const messages = await searchStockTwitsGeneral(term.replace(/"/g, ''));

      for (const msg of messages) {
        const sentiment = analyzeSentiment(msg.body);

        allPosts.push({
          id: `stw-${msg.id}`,
          platform: 'stocktwits',
          entity_id: entity.id,
          entity_name: entity.name,
          author: msg.user?.username || 'unknown',
          content: msg.body.slice(0, 500),
          url: `https://stocktwits.com/message/${msg.id}`,
          score: msg.likes?.total || 0,
          comments: msg.conversation?.replies || 0,
          sentiment_score: sentiment.score,
          sentiment_label: sentiment.label,
          posted_at: msg.created_at || now,
          fetched_at: now,
        });
        stwCount++;
      }

      // Rate limit for StockTwits (200/hr)
      await new Promise(r => setTimeout(r, 500));
    }
  }
  console.log(`[Social] StockTwits: ${stwCount} posts found`);

  // ── Dedup ──
  const uniquePosts = dedup(allPosts);
  console.log(`[Social] ${allPosts.length} total → ${uniquePosts.length} unique posts`);

  // ── Build buzz summary ──
  const buzzMap = new Map<string, SocialBuzz>();

  for (const post of uniquePosts) {
    let buzz = buzzMap.get(post.entity_id);
    if (!buzz) {
      buzz = {
        entity_id: post.entity_id,
        entity_name: post.entity_name,
        mention_count: 0,
        avg_sentiment: 0,
        sentiment_label: 'neutral',
        top_post: null,
        platforms: { reddit: 0, stocktwits: 0 },
      };
      buzzMap.set(post.entity_id, buzz);
    }

    buzz.mention_count++;
    buzz.platforms[post.platform]++;

    // Track top scoring post
    if (!buzz.top_post || post.score > buzz.top_post.score) {
      buzz.top_post = {
        title: post.title || post.content.slice(0, 80),
        url: post.url,
        score: post.score,
      };
    }
  }

  // Compute average sentiment per entity
  for (const [entityId, buzz] of buzzMap) {
    const entityPosts = uniquePosts.filter(p => p.entity_id === entityId);
    if (entityPosts.length > 0) {
      const total = entityPosts.reduce((sum, p) => sum + p.sentiment_score, 0);
      buzz.avg_sentiment = parseFloat((total / entityPosts.length).toFixed(2));
      buzz.sentiment_label = buzz.avg_sentiment > 0.1 ? 'positive' : buzz.avg_sentiment < -0.1 ? 'negative' : 'neutral';
    }
  }

  const buzzSummary = Array.from(buzzMap.values())
    .sort((a, b) => b.mention_count - a.mention_count);

  // ── Save ──
  const feedData: SocialFeedData = {
    posts: uniquePosts
      .sort((a, b) => new Date(b.posted_at).getTime() - new Date(a.posted_at).getTime())
      .slice(0, 1000),
    buzz_summary: buzzSummary,
    updated_at: now,
  };

  await saveSocialFeed(feedData);
  return uniquePosts.length;
}
