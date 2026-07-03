import { PAGE_SIZE, json, withErrorHandler } from '../_shared.js';

async function listEmails({ request, env }) {
  const url = new URL(request.url);
  const cursor = url.searchParams.get('cursor');

  const conditions = [];
  const params = [];
  if (cursor) {
    conditions.push('ts < ?');
    params.push(cursor);
  }

  // Drill-in mode: the exact (from, to, subject) triple. Active iff all three
  // eq params are present (the group drill-in always sends all three; subject
  // may legitimately be ''). In this mode we return ONLY that exact group,
  // paginated by ts — search and starred are ignored. COALESCE handles the
  // NULL-vs-'' subject case so blank-subject groups page correctly.
  const fromEq = url.searchParams.get('from_eq');
  const toEq = url.searchParams.get('to_eq');
  const subjectEq = url.searchParams.get('subject_eq');
  const exactMode = fromEq !== null && toEq !== null && subjectEq !== null;

  if (exactMode) {
    conditions.push('from_addr = ?'); params.push(fromEq);
    conditions.push('to_addr = ?'); params.push(toEq);
    conditions.push("COALESCE(subject, '') = ?"); params.push(subjectEq);
  } else {
    // Fuzzy search: each term ORs across from_addr / to_addr / subject; the
    // dashboard's ":star:" pin maps to ?starred=1 and OR-combines with the
    // terms. The whole OR group is ANDed with the cursor.
    const searchTerms = url.searchParams.getAll('search').filter(Boolean);
    const starredOnly = url.searchParams.get('starred') === '1';
    const orClauses = [];
    for (const term of searchTerms) {
      orClauses.push('(from_addr LIKE ? OR to_addr LIKE ? OR subject LIKE ?)');
      params.push(`%${term}%`, `%${term}%`, `%${term}%`);
    }
    if (starredOnly) orClauses.push('starred = 1');
    if (orClauses.length) conditions.push('(' + orClauses.join(' OR ') + ')');
  }

  let query = 'SELECT id, ts, from_addr, to_addr, subject, read, starred FROM emails';
  if (conditions.length) query += ' WHERE ' + conditions.join(' AND ');
  query += ` ORDER BY ts DESC LIMIT ${PAGE_SIZE}`;

  const { results } = await env.DB.prepare(query).bind(...params).all();
  return json(results || []);
}

export const onRequestGet = withErrorHandler(listEmails);
