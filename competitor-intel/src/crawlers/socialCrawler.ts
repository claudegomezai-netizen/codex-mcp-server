/**
 * Social Media Crawler — Reddit + StockTwits
 * Monitors competitor mentions across social platforms
 */

import type { SocialPost, SocialBuzz, SocialFeedData } from '../config/competitors.js';
import { ALL_ENTITIES } from '../config/competitors.js';
import { saveSocialFeed } from '../services/blobStore.js';

// ── Reddit OAuth ────────────────────────────────────────

const REDDIT_TOKEN_URL = 'https://www.reddit.com/api/v1/access_token';
const REDDIT_API = 'https://oauth.reddit.com';

const SUBREDDITS = [
  'investing', 'finance', 'wallstreetbets', 'financialplanning',
  'stocks', 'personalfinance', 'wealthmanagement', 'CFP',
  'FinancialAdvisors', 'institutionalinvestors',
];

async function getRedditToken(): Promise<string | null> {
  const clientId = process.env.REDDIT_CLIENT_ID;
  const clientSecret = process.env.REDDIT_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  try {
    const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const res = await fetch(REDDIT_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'CompetitorIntelDashboard/1.0',
      },
      body: 'grant_type=client_credentials',
    });

    if (!res.ok) {
      console.warn(`[Reddit] Token request failed: ${res.status}`);
      return null;
    }

    const data = await res.json();
    return data.access_token || null;
  } catch (err) {
    console.warn('[Reddit] Token error:', err);
    return null;
  }
}

interface RedditPost {
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

async function searchReddit(
  token: string,
  query: string,
  subreddit?: string
): Promise<RedditPost[]> {
  try {
    const sub = subreddit ? `/r/${subreddit}` : '';
    const url = `${REDDIT_API}${sub}/search?q=${encodeURIComponent(query)}&sort=new&t=week&limit=10&type=link`;

    const res = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'CompetitorIntelDashboard/1.0',
      },
    });

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

async function searchStockTwits(query: string): Promise<StockTwitsMessage[]> {
  try {
    const url = `${STOCKTWITS_API}/search/symbols.json?q=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'CompetitorIntelDashboard/1.0' },
    });

    if (!res.ok) {
      // StockTwits also has a search endpoint for messages
      // Fall back to searching trending if symbol search fails
      console.warn(`[StockTwits] Symbol search failed for "${query}": ${res.status}`);
      return [];
    }

    const data = await res.json();
    // If we found a symbol, get its stream
    if (data?.results?.length > 0) {
      const symbol = data.results[0].symbol;
      return await getStockTwitsStream(symbol);
    }

    return [];
  } catch (err) {
    console.warn(`[StockTwits] Error for "${query}":`, err);
    return [];
  }
}

async function getStockTwitsStream(symbol: string): Promise<StockTwitsMessage[]> {
  try {
    const url = `${STOCKTWITS_API}/streams/symbol/${symbol}.json?limit=15`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'CompetitorIntelDashboard/1.0' },
    });

    if (!res.ok) return [];
    const data = await res.json();
    return data?.messages || [];
  } catch {
    return [];
  }
}

async function searchStockTwitsGeneral(query: string): Promise<StockTwitsMessage[]> {
  try {
    // Use the general search endpoint
    const url = `${STOCKTWITS_API}/search.json?q=${encodeURIComponent(query)}&type=messages&limit=10`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'CompetitorIntelDashboard/1.0' },
    });

    if (!res.ok) {
      console.warn(`[StockTwits] General search failed: ${res.status}`);
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
  // For the key competitors, use concise search-friendly terms
  const shortNames: Record<string, string[]> = {
    'The Dobbs Group': ['"Dobbs Group"', '"Graystone Consulting"'],
    'NEPC': ['"NEPC" investing'],
    'Mercer Investment Consulting': ['"Mercer" investment consulting'],
    'Callan Associates': ['"Callan Associates"'],
    'Cambridge Associates': ['"Cambridge Associates"'],
    'Meketa Investment Group': ['"Meketa"'],
    'Wilshire Associates': ['"Wilshire Associates"'],
    'Marquette Associates': ['"Marquette Associates"'],
    'CAPTRUST': ['"CAPTRUST"'],
    'J.P. Morgan Asset Management': ['"JP Morgan" asset management'],
    'UBS Institutional Consulting': ['"UBS" institutional'],
    'William Blair': ['"William Blair"'],
    'SageView Advisory Group': ['"SageView"'],
  };

  return shortNames[entityName] || [`"${entityName}"`];
}

export async function crawlSocialMedia(): Promise<number> {
  const now = new Date().toISOString();
  const allPosts: SocialPost[] = [];

  // ── Reddit Crawl ──
  const redditToken = await getRedditToken();
  let redditCount = 0;

  if (redditToken) {
    console.log('[Social] Reddit authenticated, searching subreddits...');

    // Search for each entity in key subreddits
    for (const entity of ALL_ENTITIES.slice(0, 13)) { // Main competitors only
      const terms = getSearchTerms(entity.name);

      for (const term of terms) {
        // Search across all subreddits at once (faster than per-subreddit)
        const posts = await searchReddit(redditToken, term);

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

        // Rate limit: 60 req/min for OAuth
        await new Promise(r => setTimeout(r, 300));
      }
    }
    console.log(`[Social] Reddit: ${redditCount} posts found`);
  } else {
    console.warn('[Social] Reddit credentials not set (REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET), skipping Reddit');
  }

  // ── StockTwits Crawl ──
  let stwCount = 0;
  console.log('[Social] Searching StockTwits...');

  // StockTwits works better with ticker-like searches or company names
  // Search for key entity names using general search
  for (const entity of ALL_ENTITIES.slice(0, 13)) {
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

  // ── Build buzz summary ──
  const buzzMap = new Map<string, SocialBuzz>();

  for (const post of allPosts) {
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
    const entityPosts = allPosts.filter(p => p.entity_id === entityId);
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
    posts: allPosts
      .sort((a, b) => new Date(b.posted_at).getTime() - new Date(a.posted_at).getTime())
      .slice(0, 1000),
    buzz_summary: buzzSummary,
    updated_at: now,
  };

  await saveSocialFeed(feedData);
  return allPosts.length;
}
