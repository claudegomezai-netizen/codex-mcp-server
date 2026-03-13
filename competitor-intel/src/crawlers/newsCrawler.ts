import RSSParser from 'rss-parser';
import { ALL_ENTITIES, PRIORITY_KEYWORDS, type Entity, type Article } from '../config/competitors.js';
import { addArticles, logCrawl, getAllEntitiesWithCustom } from '../services/blobStore.js';
import { analyzeSentiment } from '../services/sentiment.js';

const parser = new RSSParser({
  timeout: 10000,
  headers: { 'User-Agent': 'Mozilla/5.0 (compatible; IntelBot/1.0)' },
});

function buildGoogleNewsUrl(query: string): string {
  return `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
}

function extractSource(item: any): string {
  if (item.source) return item.source;
  const parts = (item.title || '').split(' - ');
  return parts.length > 1 ? parts[parts.length - 1].trim() : item.creator || 'Unknown';
}

function stripHtml(text: string): string {
  return (text || '').replace(/<[^>]*>/g, '').replace(/&[^;]+;/g, ' ').trim();
}

function cleanTitle(title: string): string {
  const stripped = stripHtml(title);
  const parts = stripped.split(' - ');
  return parts.length > 1 ? parts.slice(0, -1).join(' - ').trim() : stripped;
}

function makeId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
}

function isPriorityArticle(title: string, snippet: string): boolean {
  const text = `${title} ${snippet}`.toLowerCase();
  return PRIORITY_KEYWORDS.some(kw => text.includes(kw));
}

async function crawlEntityQueries(entity: Entity): Promise<Article[]> {
  // Fetch all queries for this entity in parallel
  const queryResults = await Promise.allSettled(
    entity.searchQueries.map(async (query) => {
      const url = buildGoogleNewsUrl(query);
      const feed = await parser.parseURL(url);
      return (feed.items || []).map(item => {
        const title = cleanTitle(item.title || '');
        const snippet = (item.contentSnippet || item.content || '')
          .replace(/<[^>]*>/g, '').substring(0, 500).trim();
        const { score, label } = analyzeSentiment(`${title} ${snippet}`);

        return {
          id: makeId(),
          entity_id: entity.id,
          entity_name: entity.name,
          title,
          link: item.link || '',
          source: extractSource(item),
          pub_date: item.isoDate || item.pubDate || new Date().toISOString(),
          snippet,
          sentiment_score: score,
          sentiment_label: label,
          alerted: false,
          priority: isPriorityArticle(title, snippet),
          created_at: new Date().toISOString(),
          search_query: query,
        } as Article;
      });
    })
  );

  // Dedup within same entity — multiple queries can return the same article
  const allArticles = queryResults
    .filter((r): r is PromiseFulfilledResult<Article[]> => r.status === 'fulfilled')
    .flatMap(r => r.value);
  const seenLinks = new Set<string>();
  return allArticles.filter(a => {
    if (seenLinks.has(a.link)) return false;
    seenLinks.add(a.link);
    return true;
  });
}

// Process entities in batches to limit concurrency
async function crawlInBatches(allEntities: Entity[], batchSize = 5): Promise<number> {
  let totalNew = 0;
  for (let i = 0; i < allEntities.length; i += batchSize) {
    const batch = allEntities.slice(i, i + batchSize);
    const results = await Promise.allSettled(
      batch.map(async (entity) => {
        try {
          const articles = await crawlEntityQueries(entity);
          const newCount = await addArticles(entity.id, articles);
          console.log(`  ${entity.name}: ${newCount} new articles`);
          await logCrawl({
            crawl_type: 'news',
            entity_id: entity.id,
            articles_found: newCount,
            status: 'success',
            error_message: null,
            finished_at: new Date().toISOString(),
          });
          return newCount;
        } catch (err: any) {
          console.error(`  ${entity.name}: ERROR - ${err.message}`);
          await logCrawl({
            crawl_type: 'news',
            entity_id: entity.id,
            articles_found: 0,
            status: 'error',
            error_message: err.message,
            finished_at: new Date().toISOString(),
          });
          return 0;
        }
      })
    );
    totalNew += results
      .filter((r): r is PromiseFulfilledResult<number> => r.status === 'fulfilled')
      .reduce((sum, r) => sum + r.value, 0);
  }
  return totalNew;
}

export async function crawlAll(): Promise<number> {
  const allEntities = await getAllEntitiesWithCustom();
  console.log(`[${new Date().toISOString()}] Starting batched news crawl for ${allEntities.length} entities...`);

  const totalNew = await crawlInBatches(allEntities, 5);

  console.log(`[${new Date().toISOString()}] News crawl complete. ${totalNew} new articles.`);
  return totalNew;
}

export async function crawlSingle(entityId: string): Promise<number> {
  const allEntities = await getAllEntitiesWithCustom();
  const entity = allEntities.find(e => e.id === entityId);
  if (!entity) throw new Error(`Entity not found: ${entityId}`);

  const articles = await crawlEntityQueries(entity);
  const newCount = await addArticles(entity.id, articles);
  await logCrawl({
    crawl_type: 'news',
    entity_id: entity.id,
    articles_found: newCount,
    status: 'success',
    error_message: null,
    finished_at: new Date().toISOString(),
  });
  return newCount;
}
