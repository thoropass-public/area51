import { PAGE_SIZE, json, withErrorHandler } from '../_shared.js';

async function listEmails({ request, env }) {
  const url = new URL(request.url);
  const cursor = url.searchParams.get('cursor');
  const searchTerms = url.searchParams.getAll('search').filter(Boolean);

  let query = 'SELECT id, ts, from_addr, to_addr, subject FROM emails';
  const conditions = [];
  const params = [];

  if (cursor) {
    conditions.push('ts < ?');
    params.push(cursor);
  }
  if (searchTerms.length) {
    const orClauses = searchTerms.map(() => 'to_addr LIKE ?');
    conditions.push('(' + orClauses.join(' OR ') + ')');
    for (const term of searchTerms) params.push(`%${term}%`);
  }
  if (conditions.length) query += ' WHERE ' + conditions.join(' AND ');
  query += ` ORDER BY ts DESC LIMIT ${PAGE_SIZE}`;

  const { results } = await env.DB.prepare(query).bind(...params).all();
  return json(results || []);
}

export const onRequestGet = withErrorHandler(listEmails);
