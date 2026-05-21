import { PAGE_SIZE, json, errResp, withErrorHandler, parseHeaderLines } from '../_shared.js';

async function listEndpoints({ request, env }) {
  const url = new URL(request.url);
  const cursor = url.searchParams.get('cursor');
  const searchTerms = url.searchParams.getAll('search').filter(Boolean);

  let query = 'SELECT uri, status FROM endpoints';
  const conditions = [];
  const params = [];

  if (cursor) {
    conditions.push('uri > ?');
    params.push(cursor);
  }
  for (const term of searchTerms) {
    conditions.push('uri LIKE ?');
    params.push(`%${term}%`);
  }
  if (conditions.length) query += ' WHERE ' + conditions.join(' AND ');
  query += ` ORDER BY uri ASC LIMIT ${PAGE_SIZE}`;

  const { results } = await env.DB.prepare(query).bind(...params).all();
  return json(results || []);
}

async function upsertEndpoint({ request, env }) {
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

  await env.DB.prepare(
    `INSERT INTO endpoints (uri, status, headers, body)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(uri) DO UPDATE SET
       status = excluded.status,
       headers = excluded.headers,
       body = excluded.body`
  ).bind(uri, status, headersJson, bodyText).run();

  return json({ ok: true });
}

export const onRequestGet = withErrorHandler(listEndpoints);
export const onRequestPost = withErrorHandler(upsertEndpoint);
