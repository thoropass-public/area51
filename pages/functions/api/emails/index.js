import { PAGE_SIZE, json, withErrorHandler } from '../_shared.js';

async function listEmails({ request, env }) {
  const url = new URL(request.url);
  const cursor = url.searchParams.get('cursor');
  const searchTerms = url.searchParams.getAll('search').filter(Boolean);
  // The dashboard's ":star:" pin maps to ?starred=1. Starred membership
  // OR-combines with the recipient search terms, mirroring how all pins OR.
  const starredOnly = url.searchParams.get('starred') === '1';

  let query = 'SELECT id, ts, from_addr, to_addr, subject, read, starred FROM emails';
  const conditions = [];
  const params = [];

  if (cursor) {
    conditions.push('ts < ?');
    params.push(cursor);
  }
  // One OR group: a to_addr LIKE per search term plus an optional starred=1
  // disjunct. The whole group is ANDed with the cursor condition.
  const orClauses = searchTerms.map(() => 'to_addr LIKE ?');
  for (const term of searchTerms) params.push(`%${term}%`);
  if (starredOnly) orClauses.push('starred = 1');
  if (orClauses.length) conditions.push('(' + orClauses.join(' OR ') + ')');
  if (conditions.length) query += ' WHERE ' + conditions.join(' AND ');
  query += ` ORDER BY ts DESC LIMIT ${PAGE_SIZE}`;

  const { results } = await env.DB.prepare(query).bind(...params).all();
  return json(results || []);
}

export const onRequestGet = withErrorHandler(listEmails);
