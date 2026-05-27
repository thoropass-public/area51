import { json, errResp, withErrorHandler } from '../_shared.js';

// Lean detail row. Headers, HTML body, and attachment contents live only in
// the raw .eml in R2 — fetched on demand via /api/emails/<id>/raw.
async function getEmail({ params, env }) {
  const row = await env.DB.prepare(
    'SELECT id, ts, from_addr, to_addr, subject, text, attachment_count FROM emails WHERE id = ?'
  ).bind(params.id).first();
  if (!row) return errResp('Not found', 404);
  return json(row);
}

export const onRequestGet = withErrorHandler(getEmail);
