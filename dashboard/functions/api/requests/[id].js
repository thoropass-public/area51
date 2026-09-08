import { json, errResp, withErrorHandler } from '../_shared.js';

async function getRequest({ params, env }) {
  const row = await env.DB.prepare(
    'SELECT id, ts, method, url, ip, ua, headers, body FROM requests WHERE id = ?'
  ).bind(params.id).first();
  if (!row) return errResp('Not found', 404);

  let headers = {};
  try { headers = JSON.parse(row.headers || '{}'); } catch { headers = {}; }
  return json({ ...row, headers });
}

export const onRequestGet = withErrorHandler(getRequest);
