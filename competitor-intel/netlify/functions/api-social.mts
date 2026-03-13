import type { Config } from '@netlify/functions';
import { getSocialFeed } from '../../src/services/blobStore.js';
import { verifyAuth, unauthorizedResponse } from '../../src/services/auth.js';

export default async (req: Request) => {
  if (!(await verifyAuth(req))) return unauthorizedResponse();

  const url = new URL(req.url);
  const entityId = url.searchParams.get('entity') || '';
  const platform = url.searchParams.get('platform') || '';
  const sentiment = url.searchParams.get('sentiment') || '';
  const search = url.searchParams.get('search') || '';
  const limit = parseInt(url.searchParams.get('limit') || '100');
  const offset = parseInt(url.searchParams.get('offset') || '0');

  const feed = await getSocialFeed();
  if (!feed) {
    return new Response(JSON.stringify({ posts: [], buzz_summary: [], updated_at: null }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let posts = feed.posts;

  if (entityId && entityId !== 'all') {
    posts = posts.filter(p => p.entity_id === entityId);
  }
  if (platform && platform !== 'all') {
    posts = posts.filter(p => p.platform === platform);
  }
  if (sentiment && sentiment !== 'all') {
    posts = posts.filter(p => p.sentiment_label === sentiment);
  }
  if (search) {
    const q = search.toLowerCase();
    posts = posts.filter(p =>
      (p.title || '').toLowerCase().includes(q) ||
      p.content.toLowerCase().includes(q) ||
      p.entity_name.toLowerCase().includes(q)
    );
  }

  return new Response(JSON.stringify({
    posts: posts.slice(offset, offset + limit),
    total: posts.length,
    buzz_summary: feed.buzz_summary,
    updated_at: feed.updated_at,
  }), {
    headers: { 'Content-Type': 'application/json' },
  });
};

export const config: Config = { path: '/api/social' };
