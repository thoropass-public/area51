import { PAGE_SIZE, json, errResp, parseHeaderLines, deleteEndpointFile } from '../shared.js';

export async function listEndpoints({ request, env }) {
  const url = new URL(request.url);
  const cursor = url.searchParams.get('cursor');
  const searchTerms = url.searchParams.getAll('search').filter(Boolean);

  // filename rides along so the list can mark file-backed rows without a second
  // query. Same row read, two more columns.
  let query = 'SELECT uri, status, r2_key, filename FROM endpoints';
  const conditions = [];
  const params = [];

  if (cursor) {
    conditions.push('uri > ?');
    params.push(cursor);
  }
  if (searchTerms.length) {
    const orClauses = searchTerms.map(() => 'uri LIKE ?');
    conditions.push('(' + orClauses.join(' OR ') + ')');
    for (const term of searchTerms) params.push(`%${term}%`);
  }
  if (conditions.length) query += ' WHERE ' + conditions.join(' AND ');
  query += ` ORDER BY uri ASC LIMIT ${PAGE_SIZE}`;

  const { results } = await env.DB.prepare(query).bind(...params).all();
  // A non-null `filename` in the response means "file-backed"; r2_key itself is
  // an internal handle and never leaves the server.
  const rows = (results || []).map((r) => ({
    uri: r.uri,
    status: r.status,
    filename: r.r2_key ? (r.filename || '') : null,
  }));
  return json(rows);
}

// Text upsert. If the URI is currently file-backed, saving a text response
// CONVERTS it back: r2_key/filename are cleared and the uploaded object is
// deleted. Silent rather than a 400, because the dashboard only reaches this
// path from an explicit "remove file" or text edit, so refusing would just mean
// a delete followed by a re-create.
export async function upsertEndpoint({ request, env }) {
  let payload;
  try { payload = await request.json(); } catch { return errResp('Invalid JSON', 400); }

  const { uri, status, headers, body } = payload || {};

  if (!uri || typeof uri !== 'string') return errResp('Invalid uri', 400);
  if (!uri.startsWith('/')) return errResp('uri must start with /', 400);
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 100 || status > 599) {
    return errResp('Invalid status', 400);
  }

  const headersObj = parseHeaderLines(headers);
  const headersJson = JSON.stringify(headersObj);
  const bodyText = typeof body === 'string' ? body : '';

  const existing = await env.DB.prepare('SELECT r2_key FROM endpoints WHERE uri = ?').bind(uri).first();
  const previousKey = existing && existing.r2_key;

  await env.DB.prepare(
    `INSERT INTO endpoints (uri, status, headers, body, r2_key, filename)
     VALUES (?, ?, ?, ?, NULL, NULL)
     ON CONFLICT(uri) DO UPDATE SET
       status = excluded.status,
       headers = excluded.headers,
       body = excluded.body,
       r2_key = NULL,
       filename = NULL`
  ).bind(uri, status, headersJson, bodyText).run();

  // Row no longer references the object, so drop it. Order matters: the D1 write
  // lands first, so a failed delete leaves a logged orphan rather than an
  // endpoint pointing at a key that's already gone.
  if (previousKey) await deleteEndpointFile(env, previousKey);

  return json({ ok: true, replaced_file: !!previousKey });
}
