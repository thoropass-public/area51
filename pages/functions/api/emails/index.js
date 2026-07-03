import { PAGE_SIZE, json, errResp, withErrorHandler } from '../_shared.js';

async function listEmails({ request, env }) {
  const url = new URL(request.url);
  const cursor = url.searchParams.get('cursor');

  const conditions = [];
  const params = [];
  if (cursor) {
    conditions.push('ts < ?');
    params.push(cursor);
  }

  // Drill-in mode: the exact (from, subject) pair. Active iff both eq params are
  // present (the group drill-in always sends both; subject may legitimately be
  // ''). In this mode we return ONLY that exact group across all recipients,
  // paginated by ts — search and starred are ignored. COALESCE handles the
  // NULL-vs-'' subject case so blank-subject groups page correctly.
  const fromEq = url.searchParams.get('from_eq');
  const subjectEq = url.searchParams.get('subject_eq');
  const exactMode = fromEq !== null && subjectEq !== null;

  if (exactMode) {
    conditions.push('from_addr = ?'); params.push(fromEq);
    conditions.push("COALESCE(subject, '') = ?"); params.push(subjectEq);
  } else {
    // Fuzzy search: each term ORs across from_addr / to_addr / subject; multiple
    // terms OR together. The optional `starred=1` filter (dedicated star button)
    // is a separate AND constraint — starred AND matching the search — not an OR
    // disjunct, so it narrows results rather than widening them.
    const searchTerms = url.searchParams.getAll('search').filter(Boolean);
    const starredOnly = url.searchParams.get('starred') === '1';
    const orClauses = [];
    for (const term of searchTerms) {
      orClauses.push('(from_addr LIKE ? OR to_addr LIKE ? OR subject LIKE ?)');
      params.push(`%${term}%`, `%${term}%`, `%${term}%`);
    }
    if (orClauses.length) conditions.push('(' + orClauses.join(' OR ') + ')');
    if (starredOnly) conditions.push('starred = 1');
  }

  let query = 'SELECT id, ts, from_addr, to_addr, subject, read, starred FROM emails';
  if (conditions.length) query += ' WHERE ' + conditions.join(' AND ');
  query += ` ORDER BY ts DESC LIMIT ${PAGE_SIZE}`;

  const { results } = await env.DB.prepare(query).bind(...params).all();
  return json(results || []);
}

// Bulk mark-as-read for a whole conversation group — every row sharing the
// exact (from_addr, subject) pair, across ALL recipients and including rows not
// currently loaded in the dashboard. Powers the group row's "mark group read"
// action. COALESCE matches NULL and '' subjects alike. Dashboard-only writer,
// same as the per-email PATCH.
async function markGroup({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return errResp('Invalid JSON', 400); }
  if (!body || typeof body !== 'object') return errResp('Invalid body', 400);
  const fromAddr = body.from_addr;
  const subject = body.subject;
  if (typeof fromAddr !== 'string' || typeof subject !== 'string') {
    return errResp('from_addr and subject are required', 400);
  }
  const read = body.read ? 1 : 0;
  const res = await env.DB.prepare(
    "UPDATE emails SET read = ? WHERE from_addr = ? AND COALESCE(subject, '') = ?"
  ).bind(read, fromAddr, subject).run();
  return json({ ok: true, updated: res.meta?.changes ?? 0 });
}

export const onRequestGet = withErrorHandler(listEmails);
export const onRequestPatch = withErrorHandler(markGroup);
