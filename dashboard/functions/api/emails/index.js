import { PAGE_SIZE, json, errResp, withErrorHandler } from '../_shared.js';

// Append the substring search + starred filter to a WHERE builder. Each search term
// ORs across from_addr / to_addr / subject; multiple terms OR together. The
// optional starred filter is a separate AND constraint (starred AND matching
// the search), narrowing rather than widening.
function appendFilter(searchTerms, starredOnly, conditions, params) {
  const orClauses = [];
  for (const term of (searchTerms || [])) {
    if (!term) continue;
    orClauses.push('(from_addr LIKE ? OR to_addr LIKE ? OR subject LIKE ?)');
    params.push(`%${term}%`, `%${term}%`, `%${term}%`);
  }
  if (orClauses.length) conditions.push('(' + orClauses.join(' OR ') + ')');
  if (starredOnly) conditions.push('starred = 1');
}

async function listEmails({ request, env }) {
  const url = new URL(request.url);
  const cursor = url.searchParams.get('cursor');

  const conditions = [];
  const params = [];
  if (cursor) {
    conditions.push('ts < ?');
    params.push(cursor);
  }

  // Drill-in mode: the exact (from, subject) pair, ADDITIVE with the search /
  // starred filter below. Active iff both eq params are present (subject may
  // legitimately be ''). COALESCE handles the NULL-vs-'' subject case so
  // blank-subject groups page correctly. Because it's additive, a drill-in
  // under an active filter shows only the group members that also match the
  // filter (e.g. the recipients caught by a pinned search term).
  const fromEq = url.searchParams.get('from_eq');
  const subjectEq = url.searchParams.get('subject_eq');
  if (fromEq !== null && subjectEq !== null) {
    conditions.push('from_addr = ?'); params.push(fromEq);
    conditions.push("COALESCE(subject, '') = ?"); params.push(subjectEq);
  }

  // Substring search + starred filter, applied in both the normal list and the
  // drill-in. In the normal list, fromEq/subjectEq are absent so it's the only
  // filter; in the drill-in it narrows the exact group.
  const searchTerms = url.searchParams.getAll('search').filter(Boolean);
  const starredOnly = url.searchParams.get('starred') === '1';
  appendFilter(searchTerms, starredOnly, conditions, params);

  let query = 'SELECT id, ts, from_addr, to_addr, subject, read, starred FROM emails';
  if (conditions.length) query += ' WHERE ' + conditions.join(' AND ');
  query += ` ORDER BY ts DESC LIMIT ${PAGE_SIZE}`;

  const { results } = await env.DB.prepare(query).bind(...params).all();
  return json(results || []);
}

// Bulk set read state for a conversation group, meaning every row sharing the
// exact (from_addr, subject) pair. When the caller passes the active search/starred
// filter (search[] / starred), the update is SCOPED to that filter, matching
// exactly what the (filtered) drill-in shows; with no filter it covers the
// whole group across all recipients (including rows not currently loaded).
// COALESCE matches NULL and '' subjects alike. Dashboard-only writer.
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

  const conditions = ['from_addr = ?', "COALESCE(subject, '') = ?"];
  const whereParams = [fromAddr, subject];
  const searchTerms = Array.isArray(body.search) ? body.search.filter((t) => typeof t === 'string' && t) : [];
  appendFilter(searchTerms, !!body.starred, conditions, whereParams);

  const res = await env.DB.prepare(
    `UPDATE emails SET read = ? WHERE ${conditions.join(' AND ')}`
  ).bind(read, ...whereParams).run();
  return json({ ok: true, updated: res.meta?.changes ?? 0 });
}

export const onRequestGet = withErrorHandler(listEmails);
export const onRequestPatch = withErrorHandler(markGroup);
