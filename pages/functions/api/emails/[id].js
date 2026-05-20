import { json, errResp, withErrorHandler } from '../_shared.js';

async function getEmail({ params, env }) {
  const row = await env.DB.prepare(
    'SELECT id, ts, from_addr, to_addr, subject, raw_eml FROM emails WHERE id = ?'
  ).bind(params.id).first();
  if (!row) return errResp('Not found', 404);
  return json(row);
}

export const onRequestGet = withErrorHandler(getEmail);
