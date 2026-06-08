import { json, errResp, withErrorHandler } from '../_shared.js';

// Lean detail row. Headers, HTML body, and attachment contents live only in
// the raw .eml in R2 — fetched on demand via /api/emails/<id>/raw.
async function getEmail({ params, env }) {
  const row = await env.DB.prepare(
    'SELECT id, ts, from_addr, to_addr, subject, text, attachment_count, read, starred FROM emails WHERE id = ?'
  ).bind(params.id).first();
  if (!row) return errResp('Not found', 404);
  return json(row);
}

// Toggle per-email UI state (read / starred). Dashboard-only: the capture worker
// never writes these and Autopilot/MCP is read-only, so this PATCH is the sole
// writer. Body may carry `read` and/or `starred` (booleans); only the keys
// present are updated. Returns the updated {read, starred}.
async function patchEmail({ params, request, env }) {
  let body;
  try { body = await request.json(); } catch { return errResp('Invalid JSON body', 400); }
  if (!body || typeof body !== 'object') return errResp('Invalid body', 400);

  const sets = [];
  const values = [];
  if ('read' in body) { sets.push('read = ?'); values.push(body.read ? 1 : 0); }
  if ('starred' in body) { sets.push('starred = ?'); values.push(body.starred ? 1 : 0); }
  if (!sets.length) return errResp('Nothing to update — provide read and/or starred', 400);

  values.push(params.id);
  const res = await env.DB.prepare(
    `UPDATE emails SET ${sets.join(', ')} WHERE id = ? RETURNING read, starred`
  ).bind(...values).first();
  if (!res) return errResp('Not found', 404);
  return json(res);
}

export const onRequestGet = withErrorHandler(getEmail);
export const onRequestPatch = withErrorHandler(patchEmail);
