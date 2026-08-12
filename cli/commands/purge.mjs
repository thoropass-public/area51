// `./a51 purge` — interactive, admin-only data deletion.
//
// This exists because emails are stored in two places at once: a lean row in D1
// and the verbatim .eml in R2. A bare `DELETE FROM emails` in the D1 console
// leaves the blobs behind as an invisible storage leak, so purging is done here
// where both halves can be deleted in lockstep (R2 first, then D1 — a failure
// leaves a visible row to retry rather than an unreachable object).
//
// Unattended retention is the cleanup worker's job (docs/cleanup.md). This is
// for one-off, ad-hoc purges and for the things the worker never touches.

import { loadContext } from '../lib/context.mjs';
import { ok, warn, plain, heading, color, die, info } from '../lib/log.mjs';
import { ask, select, typeToConfirm, closePrompts } from '../lib/prompt.mjs';

/** ISO 8601 UTC cutoff `now - days`, matching the format stored in `ts`. */
function isoCutoff(days) {
  return new Date(Date.now() - days * 86400000).toISOString();
}

async function askDays(what) {
  for (;;) {
    const answer = await ask(`  Delete ${what} older than how many days?`, '30');
    const days = Number(answer);
    if (Number.isInteger(days) && days >= 0) return days;
    warn('enter a whole number of days (0 = everything)');
  }
}

export async function run() {
  const { env, cf, accountId } = await loadContext({ needDatabase: true });
  const dbId = env.D1_DATABASE_ID;

  heading('AREA 51 — purge');
  const choice = await select('What should be purged?', [
    { value: 'requests', label: 'Requests', hint: 'older than N days (D1 only)' },
    { value: 'emails', label: 'Emails', hint: 'older than N days (D1 rows + their .eml in R2)' },
    { value: 'autopilot', label: 'Autopilot endpoints', hint: 'every /-/* row, plus any uploaded files they serve' },
    { value: 'quit', label: 'Quit', hint: 'change nothing' },
  ], { auto: false });

  let code = 0;
  if (choice === 'requests') code = await purgeRequests(cf, accountId, dbId);
  else if (choice === 'emails') code = await purgeEmails(cf, accountId, dbId, env.R2_BUCKET_NAME);
  else if (choice === 'autopilot') code = await purgeAutopilot(cf, accountId, dbId, env.R2_FILES_BUCKET_NAME);
  else plain('  Nothing was changed.');

  closePrompts();
  return code;
}

async function purgeRequests(cf, accountId, dbId) {
  const days = await askDays('captured requests');
  const cutoff = isoCutoff(days);
  if (!(await typeToConfirm('PURGE', `This deletes every row in "requests" with ts < ${cutoff}.`))) {
    plain('  Cancelled.');
    return 1;
  }
  const [result] = await cf.d1Query(accountId, dbId, 'DELETE FROM requests WHERE ts < ?', [cutoff]);
  const changes = (result && result.meta && result.meta.changes) ?? 0;
  ok(`deleted ${changes} request row${changes === 1 ? '' : 's'}`);
  return 0;
}

async function purgeEmails(cf, accountId, dbId, bucket) {
  const days = await askDays('captured emails');
  const cutoff = isoCutoff(days);

  const rows = await cf.d1Rows(accountId, dbId, 'SELECT id FROM emails WHERE ts < ? AND starred = 0', [cutoff]);
  if (!rows.length) {
    plain(`  Nothing older than ${cutoff} (starred email is never purged).`);
    return 0;
  }

  plain('');
  plain(`  ${rows.length} email${rows.length === 1 ? '' : 's'} older than ${cutoff}:`);
  plain(`    · ${rows.length} object${rows.length === 1 ? '' : 's'} deleted from R2 bucket ${bucket}`);
  plain(`    · ${rows.length} row${rows.length === 1 ? '' : 's'} deleted from D1 "emails"`);
  plain(`    · starred email is excluded and kept`);
  if (!(await typeToConfirm('PURGE', 'This cannot be undone — the raw messages are gone.'))) {
    plain('  Cancelled.');
    return 1;
  }

  const deleted = [];
  let failures = 0;
  for (const row of rows) {
    try {
      await cf.deleteR2Object(accountId, bucket, `emails/${row.id}.eml`);
      deleted.push(row.id);
    } catch (err) {
      failures += 1;
      warn(`R2 delete failed for emails/${row.id}.eml (${err.message}) — its row is kept so it can be retried`);
    }
  }
  ok(`deleted ${deleted.length} .eml object${deleted.length === 1 ? '' : 's'} from R2${failures ? `, ${failures} failed` : ''}`);

  // Only drop rows whose object is confirmed gone: a kept row is retryable,
  // an orphaned object is invisible.
  let removed = 0;
  for (let i = 0; i < deleted.length; i += 50) {
    const batch = deleted.slice(i, i + 50);
    const placeholders = batch.map(() => '?').join(',');
    const [result] = await cf.d1Query(accountId, dbId, `DELETE FROM emails WHERE id IN (${placeholders})`, batch);
    removed += (result && result.meta && result.meta.changes) || 0;
  }
  ok(`deleted ${removed} row${removed === 1 ? '' : 's'} from D1`);
  return failures ? 2 : 0;
}

async function purgeAutopilot(cf, accountId, dbId, filesBucket) {
  const rows = await cf.d1Rows(accountId, dbId, "SELECT uri, r2_key FROM endpoints WHERE uri LIKE '/-/%'");
  if (!rows.length) {
    plain('  No /-/* endpoints exist.');
    return 0;
  }
  const withFiles = rows.filter((r) => r.r2_key);

  plain('');
  plain(`  ${rows.length} endpoint${rows.length === 1 ? '' : 's'} under /-/* will be deleted.`);
  if (withFiles.length) plain(`  ${withFiles.length} of them serve an uploaded file; those objects go too (bucket ${filesBucket}).`);
  plain(color.dim('  Endpoints you created by hand (anything not starting with /-/) are untouched.'));
  if (!(await typeToConfirm('PURGE', 'Agents will lose every stub they staged.'))) {
    plain('  Cancelled.');
    return 1;
  }

  for (const row of withFiles) {
    try {
      await cf.deleteR2Object(accountId, filesBucket, row.r2_key);
    } catch (err) {
      warn(`R2 delete failed for ${row.uri} (${row.r2_key}): ${err.message}`);
    }
  }
  if (withFiles.length) ok(`deleted ${withFiles.length} uploaded file${withFiles.length === 1 ? '' : 's'}`);

  const [result] = await cf.d1Query(accountId, dbId, "DELETE FROM endpoints WHERE uri LIKE '/-/%'");
  const changes = (result && result.meta && result.meta.changes) ?? 0;
  ok(`deleted ${changes} endpoint row${changes === 1 ? '' : 's'}`);
  info(color.dim('Note: the black holes now answer 404 on those paths.'));
  return 0;
}
