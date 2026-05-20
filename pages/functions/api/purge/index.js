import { json, errResp, withErrorHandler } from '../_shared.js';

const ALLOWED_TABLES = ['requests', 'emails'];

async function purge({ request, env }) {
  let payload;
  try { payload = await request.json(); } catch { return errResp('Invalid JSON', 400); }

  const { table, keep } = payload || {};

  if (!ALLOWED_TABLES.includes(table)) {
    return errResp('Invalid table', 400);
  }
  if (typeof keep !== 'number' || !Number.isInteger(keep) || keep < 0) {
    return errResp('Invalid keep value', 400);
  }

  // table is validated against an allowlist above; safe to interpolate.
  const result = await env.DB.prepare(
    `DELETE FROM ${table}
     WHERE id NOT IN (SELECT id FROM ${table} ORDER BY ts DESC LIMIT ?)`
  ).bind(keep).run();

  return json({ ok: true, deleted: (result.meta && result.meta.changes) || 0 });
}

export const onRequestPost = withErrorHandler(purge);
