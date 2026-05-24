import { json, withErrorHandler } from '../../_shared.js';

// Deletes endpoints whose URI starts with /autopilot/. Behaves like
// /api/purge for the requests / emails tables: a `keep` value preserves
// the N most recent rows and deletes the rest. Without a positive `keep`
// (or with keep=0), every /autopilot/* endpoint is wiped.
//
// "Most recent" is ordered by SQLite's implicit ROWID (monotonically
// increasing on each successful INSERT). For autopilot endpoints — which
// agents typically create as new URIs rather than re-upserting existing
// ones — this is a faithful proxy for "newest first." UPSERTs on an
// existing autopilot URI keep the same ROWID, so they don't artificially
// promote a row to "newest" on an update.

async function purgeAutopilot({ request, env }) {
  let keep = 0;
  try {
    const payload = await request.json();
    if (payload && typeof payload.keep === 'number' && Number.isInteger(payload.keep) && payload.keep >= 0) {
      keep = payload.keep;
    }
  } catch { /* body optional — empty body = delete all */ }

  let result;
  if (keep > 0) {
    result = await env.DB.prepare(
      `DELETE FROM endpoints
       WHERE uri LIKE '/autopilot/%'
         AND uri NOT IN (
           SELECT uri FROM endpoints
           WHERE uri LIKE '/autopilot/%'
           ORDER BY rowid DESC LIMIT ?
         )`
    ).bind(keep).run();
  } else {
    result = await env.DB.prepare(
      "DELETE FROM endpoints WHERE uri LIKE '/autopilot/%'"
    ).run();
  }
  return json({ ok: true, deleted: (result.meta && result.meta.changes) || 0 });
}

export const onRequestPost = withErrorHandler(purgeAutopilot);
