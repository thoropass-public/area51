// area51-cleanup worker.
//
// A scheduled-only Cloudflare Worker (service name from CLEANUP_WORKER_NAME).
// It has NO fetch handler and NO Custom Domain — its only entry point is the
// `scheduled` handler, invoked by the cron trigger declared in wrangler.toml.
//
// Once a day it trims the shared `area51` D1 database (and the coupled R2
// bucket) so the stores don't grow unbounded:
//
//   requests — keep only the newest CLEANUP_REQUESTS_KEEP rows (by ts); delete
//              the rest. Requests have no R2 objects, so this is D1-only.
//   emails   — delete rows older than CLEANUP_EMAIL_MAX_AGE_DAYS days AND the
//              matching emails/<id>.eml objects in R2, in lockstep. R2 is
//              deleted first; only the ids whose blob delete succeeded get
//              their D1 row removed, so a transient R2 error leaves the row in
//              place to retry next run instead of silently orphaning the blob.
//              Starred emails (starred = 1) are exempt and kept indefinitely,
//              no matter how old.
//
// Bindings (shared with the Black Holes + Autopilot workers):
//   DB  — D1 `area51` database
//   EML — R2 `area51-emails` bucket (raw .eml at key emails/<id>.eml)
//
// Vars (from .env via the rendered wrangler.toml [vars]):
//   CLEANUP_REQUESTS_KEEP       — how many newest request rows to retain
//   CLEANUP_EMAIL_MAX_AGE_DAYS  — max age (days) before an email is purged
//
// Structured JSON logging, same convention as the other two workers; tail with
// `wrangler tail area51-cleanup`.

const log = (event, fields = {}) => {
  try { console.log(JSON.stringify({ event, ...fields })); } catch { /* never crash on logging */ }
};
const logErr = (event, fields = {}) => {
  try { console.error(JSON.stringify({ event, ...fields })); } catch { /* never crash on logging */ }
};

// Cloudflare's R2 binding accepts up to 1000 keys per delete() call.
const R2_DELETE_BATCH = 1000;
// D1 bind-parameter ceiling is generous, but keep the IN(...) DELETE bounded.
const D1_DELETE_BATCH = 100;

// Parse a [vars] string into a non-negative integer, falling back if missing
// or malformed (so a bad .env value degrades to a safe default rather than
// purging nothing or throwing).
function intFromEnv(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

// `now - days` as ISO 8601 UTC. Matches the worker's `new Date().toISOString()`
// (and purge.sh's cutoff format), so a plain string compare against the stored
// `ts` column is correct.
function isoCutoff(days) {
  return new Date(Date.now() - days * 86400000).toISOString();
}

// requests: keep only the newest `keep` rows by ts; delete everything else.
// The subquery picks the `keep` newest ids and the outer DELETE removes any row
// not in that set — exact "keep the most recent N", with no boundary/tie
// ambiguity. Once-a-day cost is a single full scan of `requests` (D1 bills per
// row read), which is trivial against the free-tier budget at our volume.
async function purgeRequests(env, keep) {
  const res = await env.DB
    .prepare(
      'DELETE FROM requests WHERE id NOT IN ' +
      '(SELECT id FROM requests ORDER BY ts DESC LIMIT ?)'
    )
    .bind(keep)
    .run();
  const deleted = res.meta?.changes ?? 0;
  log('cleanup_requests_done', { keep, deleted });
  return { deleted };
}

// emails: delete rows older than `maxAgeDays` and their R2 blobs in lockstep.
// Order is R2-first, then D1, keyed by the SAME id set — never a blind
// `DELETE ... WHERE ts < cutoff`, which would orphan the .eml objects.
//
// Starred emails are EXEMPT: a starred row (and its .eml) is retained
// indefinitely regardless of age, so the `starred = 0` predicate is applied at
// selection time — those ids never enter the delete set in the first place.
async function purgeEmails(env, maxAgeDays) {
  const cutoff = isoCutoff(maxAgeDays);

  const sel = await env.DB
    .prepare('SELECT id FROM emails WHERE ts < ? AND starred = 0 ORDER BY ts ASC')
    .bind(cutoff)
    .all();
  const ids = (sel.results || []).map((r) => r.id);
  if (ids.length === 0) {
    log('cleanup_emails_done', { cutoff, matched: 0, r2_deleted: 0, d1_deleted: 0, r2_failed: 0 });
    return { deleted: 0, r2_failed: 0 };
  }

  // Delete R2 objects in batches. Only ids whose batch delete resolved get
  // their D1 row removed below; a failed batch is logged and its rows are left
  // for the next run (no orphan, no lost row).
  const deletedIds = [];
  let r2Failed = 0;
  for (let i = 0; i < ids.length; i += R2_DELETE_BATCH) {
    const batch = ids.slice(i, i + R2_DELETE_BATCH);
    const keys = batch.map((id) => `emails/${id}.eml`);
    try {
      await env.EML.delete(keys);
      deletedIds.push(...batch);
    } catch (e) {
      r2Failed += batch.length;
      logErr('cleanup_emails_r2_failed', { count: batch.length, error: String(e) });
    }
  }

  // Delete the D1 rows for the confirmed-deleted blobs, in bounded IN(...) batches.
  let d1Deleted = 0;
  for (let i = 0; i < deletedIds.length; i += D1_DELETE_BATCH) {
    const batch = deletedIds.slice(i, i + D1_DELETE_BATCH);
    const placeholders = batch.map(() => '?').join(',');
    const res = await env.DB
      .prepare(`DELETE FROM emails WHERE id IN (${placeholders})`)
      .bind(...batch)
      .run();
    d1Deleted += res.meta?.changes ?? 0;
  }

  log('cleanup_emails_done', {
    cutoff,
    matched: ids.length,
    r2_deleted: deletedIds.length,
    d1_deleted: d1Deleted,
    r2_failed: r2Failed,
  });
  return { deleted: d1Deleted, r2_failed: r2Failed };
}

export default {
  async scheduled(event, env, ctx) {
    const keep = intFromEnv(env.CLEANUP_REQUESTS_KEEP, 1000);
    const maxAgeDays = intFromEnv(env.CLEANUP_EMAIL_MAX_AGE_DAYS, 90);
    log('cleanup_started', {
      cron: event.cron,
      scheduledTime: event.scheduledTime,
      keep,
      maxAgeDays,
    });

    // Each table is purged independently so a failure in one doesn't block the
    // other. The handler never throws — failures are logged and the next daily
    // run retries from a clean slate.
    const summary = { requests: null, emails: null };
    try {
      summary.requests = await purgeRequests(env, keep);
    } catch (e) {
      logErr('cleanup_requests_failed', { error: String(e) });
    }
    try {
      summary.emails = await purgeEmails(env, maxAgeDays);
    } catch (e) {
      logErr('cleanup_emails_failed', { error: String(e) });
    }

    log('cleanup_finished', { keep, maxAgeDays, summary });
  },
};
