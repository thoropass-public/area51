import { json, errResp, withErrorHandler } from '../_shared.js';

// Purge:
//   requests  → DELETE FROM requests WHERE ts < cutoff        (by age)
//   emails    → DELETE FROM emails   WHERE ts < cutoff        (by age, + delete R2)
//   endpoints → DELETE every /autopilot/* endpoint, REGARDLESS of days.
//               The endpoints table has no timestamp, so age-based purge
//               doesn't apply; selecting it wipes the whole autopilot
//               namespace. Manually-defined endpoints are never touched.
const ALLOWED_TABLES = ['requests', 'emails', 'endpoints'];

async function purge({ request, env }) {
  let payload;
  try { payload = await request.json(); } catch { return errResp('Invalid JSON', 400); }

  const { table, days } = payload || {};

  if (!ALLOWED_TABLES.includes(table)) {
    return errResp('Invalid table', 400);
  }

  // Autopilot endpoints: delete all, ignore days (no ts on the table).
  if (table === 'endpoints') {
    const result = await env.DB.prepare(
      "DELETE FROM endpoints WHERE uri LIKE '/autopilot/%'"
    ).run();
    return json({ ok: true, deleted: (result.meta && result.meta.changes) || 0 });
  }

  // requests / emails are age-based.
  if (typeof days !== 'number' || !Number.isInteger(days) || days < 0) {
    return errResp('Invalid days value', 400);
  }

  const cutoff = new Date(Date.now() - days * 86400000).toISOString();

  if (table === 'emails') {
    // Collect the doomed ids first so we can drop their R2 objects too.
    const { results } = await env.DB.prepare(
      'SELECT id FROM emails WHERE ts < ?'
    ).bind(cutoff).all();
    const ids = (results || []).map((r) => r.id);

    const result = await env.DB.prepare(
      'DELETE FROM emails WHERE ts < ?'
    ).bind(cutoff).run();

    // Best-effort R2 cleanup. Rows are already gone; a failure here only
    // leaves an invisible orphaned object, never a row pointing at nothing.
    if (ids.length && env.EML) {
      const keys = ids.map((id) => `emails/${id}.eml`);
      for (let i = 0; i < keys.length; i += 1000) {
        try {
          await env.EML.delete(keys.slice(i, i + 1000));
        } catch (err) {
          console.error('purge_r2_delete_failed', err && err.message);
        }
      }
    }

    return json({ ok: true, deleted: (result.meta && result.meta.changes) || 0 });
  }

  // requests
  const result = await env.DB.prepare(
    'DELETE FROM requests WHERE ts < ?'
  ).bind(cutoff).run();
  return json({ ok: true, deleted: (result.meta && result.meta.changes) || 0 });
}

export const onRequestPost = withErrorHandler(purge);
