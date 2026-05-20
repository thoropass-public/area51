import { json, errResp, withErrorHandler } from '../_shared.js';

async function getEndpoint({ params, env }) {
  const uri = decodeURIComponent(params.uri);
  const row = await env.DB.prepare(
    'SELECT uri, status, headers, body FROM endpoints WHERE uri = ?'
  ).bind(uri).first();
  if (!row) return errResp('Not found', 404);
  return json(row);
}

async function deleteEndpoint({ params, env }) {
  const uri = decodeURIComponent(params.uri);
  const result = await env.DB.prepare('DELETE FROM endpoints WHERE uri = ?').bind(uri).run();
  if (!result.meta || result.meta.changes === 0) return errResp('Not found', 404);
  return json({ ok: true });
}

export const onRequestGet = withErrorHandler(getEndpoint);
export const onRequestDelete = withErrorHandler(deleteEndpoint);
