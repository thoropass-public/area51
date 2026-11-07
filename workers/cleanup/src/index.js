// area51-cleanup worker.
//
// A scheduled-only Cloudflare Worker (service name from CLEANUP_WORKER_NAME).
// It has NO fetch handler and NO Custom Domain. Its only entry point is the
// `scheduled` handler, invoked by the cron trigger declared in wrangler.toml.
//
// Once a day it trims the shared `area51` D1 database (and the coupled R2
// bucket) so the stores don't grow unbounded:
//
//   requests  keep only the newest CLEANUP_REQUESTS_KEEP rows (by ts); delete
//              the rest. Requests have no R2 objects, so this is D1-only.
//   emails    delete rows older than CLEANUP_EMAIL_MAX_AGE_DAYS days AND the
//              matching emails/<id>.eml objects in R2, in lockstep. R2 is
//              deleted first; only the ids whose blob delete succeeded get
//              their D1 row removed, so a transient R2 error leaves the row in
//              place to retry next run instead of silently orphaning the blob.
//              Starred emails (starred = 1) are exempt and kept indefinitely,
//              no matter how old.
//
// And once a month, on the first Sunday:
//
//   endpoints  delete EVERY row under Autopilot's /-/ prefix, with the FILES
//              object first for any that serves a file. Agent-staged stubs are
//              engagement scratch, and nothing expires them otherwise.
//
// Bindings (shared with the Black Holes + Autopilot workers):
//   DB     the D1 `area51` database
//   EML    the captured-email R2 bucket (raw .eml at key emails/<id>.eml)
//   FILES  the endpoint-file bucket. Held ONLY so the monthly /-/ purge can
//          delete an object before the row that points at it. Autopilot itself
//          has no FILES binding and that has not changed. It is what stops an
//          agent reading or replacing a payload a human uploaded. This worker
//          never reads the bucket and never writes to it; it deletes, on a
//          schedule, keys it read out of D1.
//
// Vars (from .env via the rendered wrangler.toml [vars]):
//   CLEANUP_REQUESTS_KEEP       how many newest request rows to retain
//   CLEANUP_EMAIL_MAX_AGE_DAYS  max age (days) before an email is purged
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
// (and `./a51 purge`'s cutoff format), so a plain string compare against the stored
// `ts` column is correct.
function isoCutoff(days) {
  return new Date(Date.now() - days * 86400000).toISOString();
}

// requests: keep only the newest `keep` rows by ts; delete everything else.
// The subquery picks the `keep` newest ids and the outer DELETE removes any row
// not in that set. That is an exact "keep the most recent N", with no
// boundary or tie ambiguity. Once-a-day cost is a single full scan of `requests` (D1 bills per
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
// Order is R2-first, then D1, keyed by the SAME id set, and never a blind
// `DELETE ... WHERE ts < cutoff`, which would orphan the .eml objects.
//
// Starred emails are EXEMPT: a starred row (and its .eml) is retained
// indefinitely regardless of age, so the `starred = 0` predicate is applied at
// selection time, so those ids never enter the delete set in the first place.
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

// endpoints: delete every row under Autopilot's /-/ prefix.
//
// WHY ALL OF THEM, with no age test: the `endpoints` table has no timestamp
// column. There is nothing to compare an age against, and adding one to carry a
// monthly sweep would be a schema migration for a table whose whole contract is
// "exact-match lookup by uri". So the rule is the blunt one, and it is the rule
// the operator asked for: on the first Sunday of the month, agent-staged
// endpoints go. They are engagement scratch: an agent can stage another in one
// call, and nothing else expires them.
//
// HAND-WRITTEN ENDPOINTS ARE NEVER TOUCHED. The prefix is the whole of the
// test, matched with LIKE against a literal '/-/%'. Autopilot cannot create a
// row outside it (the worker enforces that server-side), so "under /-/" and
// "staged by an agent" are the same set, with one exception worth knowing: a
// file a human uploaded to a /-/ path from the dashboard also lives here, and
// this deletes it too. That is deliberate and documented. A payload meant to
// outlive the month belongs at a path of its own.
//
// ORDER: R2 object first, then the D1 row, exactly as the email purge and
// `./a51 purge` do it. A failure between the two leaves a VISIBLE broken row
// rather than an invisible orphaned object, which is the trade this codebase
// makes everywhere the two stores are written together.
async function purgeAutopilotEndpoints(env) {
  const sel = await env.DB
    .prepare("SELECT uri, r2_key FROM endpoints WHERE uri LIKE '/-/%'")
    .all();
  const rows = sel.results || [];
  if (rows.length === 0) {
    log('cleanup_autopilot_done', { matched: 0, r2_deleted: 0, d1_deleted: 0, r2_failed: 0 });
    return { deleted: 0, r2_failed: 0 };
  }

  // File-backed rows first. A row whose object could not be deleted is held
  // back from the D1 delete below, so the next run retries it instead of
  // stranding the object.
  const fileRows = rows.filter((r) => r.r2_key);
  const deletable = rows.filter((r) => !r.r2_key).map((r) => r.uri);
  let r2Failed = 0;
  for (let i = 0; i < fileRows.length; i += R2_DELETE_BATCH) {
    const batch = fileRows.slice(i, i + R2_DELETE_BATCH);
    try {
      await env.FILES.delete(batch.map((r) => r.r2_key));
      deletable.push(...batch.map((r) => r.uri));
    } catch (e) {
      r2Failed += batch.length;
      logErr('cleanup_autopilot_r2_failed', { count: batch.length, error: String(e) });
    }
  }

  let d1Deleted = 0;
  for (let i = 0; i < deletable.length; i += D1_DELETE_BATCH) {
    const batch = deletable.slice(i, i + D1_DELETE_BATCH);
    const placeholders = batch.map(() => '?').join(',');
    const res = await env.DB
      .prepare(`DELETE FROM endpoints WHERE uri IN (${placeholders})`)
      .bind(...batch)
      .run();
    d1Deleted += res.meta?.changes ?? 0;
  }

  log('cleanup_autopilot_done', {
    matched: rows.length,
    files: fileRows.length,
    r2_deleted: fileRows.length - r2Failed,
    d1_deleted: d1Deleted,
    r2_failed: r2Failed,
  });
  return { deleted: d1Deleted, r2_failed: r2Failed };
}

// First Sunday of the month, in UTC, which is the clock the cron trigger runs on.
//
// This is a date test in code rather than a cron expression because cron cannot
// say it. In a `D M DOW` field set, restricting BOTH day-of-month and day-of-week
// makes them an OR, not an AND: `0 7 1-7 * SUN` fires on the 1st through 7th
// *and* on every Sunday, which is most of the month. So the trigger stays the
// ordinary daily one and the handler decides.
//
// That means the monthly purge rides on the daily run: CLEANUP_CRON has to fire
// at least once every day for it to happen at all. The default (`0 6 * * *`)
// does. A cron edited down to, say, Mondays only would silently never purge.
function isFirstSundayUtc(date) {
  return date.getUTCDay() === 0 && date.getUTCDate() <= 7;
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
    // other. The handler never throws: failures are logged and the next daily
    // run retries from a clean slate.
    const summary = { requests: null, emails: null, autopilot: null };
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

    // `scheduledTime` rather than Date.now(): it is the instant the trigger was
    // scheduled for, so a run that starts late, or is retried, still decides
    // against the day it was meant to run on.
    const firstSunday = isFirstSundayUtc(new Date(event.scheduledTime || Date.now()));
    if (firstSunday) {
      try {
        summary.autopilot = await purgeAutopilotEndpoints(env);
      } catch (e) {
        logErr('cleanup_autopilot_failed', { error: String(e) });
      }
    }

    log('cleanup_finished', { keep, maxAgeDays, firstSunday, summary });
  },
};
