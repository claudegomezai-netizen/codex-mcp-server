import type { Config } from '@netlify/functions';
import type { WatchedPerson } from '../../src/config/competitors.js';
import { getWatchedPeople, addWatchedPerson, updateWatchedPerson, removeWatchedPerson } from '../../src/services/blobStore.js';
import { verifyAuth, unauthorizedResponse } from '../../src/services/auth.js';

export default async (req: Request) => {
  if (!(await verifyAuth(req))) return unauthorizedResponse();
  const headers = { 'Content-Type': 'application/json' };

  if (req.method === 'GET') {
    const url = new URL(req.url);
    const category = url.searchParams.get('category') || undefined;
    const status = url.searchParams.get('status') || undefined;
    const people = await getWatchedPeople({ category, status });
    return new Response(JSON.stringify(people), { headers });
  }

  if (req.method === 'POST') {
    const body = await req.json();
    const { name, current_company, current_role, category, notes } = body as {
      name?: string; current_company?: string; current_role?: string;
      category?: string; notes?: string;
    };
    if (!name || !current_company) {
      return new Response(JSON.stringify({ error: 'name and current_company are required' }), { status: 400, headers });
    }

    const id = `wp-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
    const quotedName = `"${name}"`;
    const person: WatchedPerson = {
      id,
      name,
      current_company,
      current_role: current_role || '',
      category: (category === 'competitive_intel' ? 'competitive_intel' : 'recruitment'),
      notes: notes || '',
      search_queries: [
        quotedName,
        `${quotedName} (leaves OR joins OR appointed OR hired OR resigned OR "new role" OR LinkedIn)`,
        `${quotedName} "${current_company}"`,
      ],
      added_at: new Date().toISOString(),
      last_checked_at: '',
      status: 'watching',
    };

    await addWatchedPerson(person);
    return new Response(JSON.stringify(person), { status: 201, headers });
  }

  if (req.method === 'PUT') {
    const body = await req.json();
    const { id, ...updates } = body as { id: string } & Partial<WatchedPerson>;
    if (!id) {
      return new Response(JSON.stringify({ error: 'id is required' }), { status: 400, headers });
    }
    // Rebuild search queries if name or company changed
    if (updates.name || updates.current_company) {
      const people = await getWatchedPeople({});
      const existing = people.find(p => p.id === id);
      if (existing) {
        const pName = updates.name || existing.name;
        const pCompany = updates.current_company || existing.current_company;
        const quotedName = `"${pName}"`;
        updates.search_queries = [
          quotedName,
          `${quotedName} (leaves OR joins OR appointed OR hired OR resigned OR "new role" OR LinkedIn)`,
          `${quotedName} "${pCompany}"`,
        ];
      }
    }
    const updated = await updateWatchedPerson(id, updates);
    if (!updated) {
      return new Response(JSON.stringify({ error: 'Person not found' }), { status: 404, headers });
    }
    return new Response(JSON.stringify({ updated: id }), { headers });
  }

  if (req.method === 'DELETE') {
    const url = new URL(req.url);
    const id = url.searchParams.get('id');
    if (!id) {
      return new Response(JSON.stringify({ error: 'id query param is required' }), { status: 400, headers });
    }
    const removed = await removeWatchedPerson(id);
    if (!removed) {
      return new Response(JSON.stringify({ error: 'Person not found' }), { status: 404, headers });
    }
    return new Response(JSON.stringify({ removed: id }), { headers });
  }

  return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers });
};

export const config: Config = { path: '/api/watchlist' };
