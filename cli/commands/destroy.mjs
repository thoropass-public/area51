// `./a51 destroy` — tear the deployment down again.
//
// Split into two gates on purpose. The first removes compute (workers, the Pages
// project, the Access application, and Email Routing) which is fully rebuildable
// from this repo. The second removes storage (the D1 database and both R2
// buckets) which destroys every captured request, email and staged endpoint,
// permanently.
//
// Both gates require typing a word rather than a y/N: a yes/no can be cleared by
// a reflexive Enter, and neither of these should be. Email Routing is asked about
// separately inside the first gate, since it is the one step that changes the zone
// rather than just removing AREA 51.

import { loadContext, zoneForHostname } from '../lib/context.mjs';
import { heading, plain, ok, warn, skip, color, info } from '../lib/log.mjs';
import { typeToConfirm, confirm, closePrompts } from '../lib/prompt.mjs';
import { deriveR2Credentials, listR2ObjectKeys } from '../lib/r2s3.mjs';
import { ACCESS_LIST_NAME } from '../lib/provision.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Disable Email Routing on every zone this deployment enabled it for, which also
 * deletes the MX, SPF and DKIM records Cloudflare added and LOCKED.
 *
 * This used to be skipped with a note, on the grounds that Email Routing is a
 * zone-wide setting. That left the worst possible end state: every other piece
 * torn down, and the domain still advertising mail service that nothing answers,
 * with records that cannot be edited while they stay locked. So it is offered
 * here instead.
 *
 * Asked rather than assumed, because it is the one teardown step that changes how
 * the whole zone behaves rather than just removing AREA 51 from it. It sits in
 * the first (compute) gate: `./a51 setup` puts all of it back.
 */
async function teardownEmailRouting(cf, accountId, env) {
  const zones = new Map();
  const consider = async (hostname) => {
    if (!hostname) return;
    try {
      const zone = await zoneForHostname(cf, accountId, hostname);
      if (zone) zones.set(zone.id, zone);
    } catch { /* best effort — a zone we cannot resolve is one we cannot disable */ }
  };

  // Every mail black hole in the table. The table is still intact here: this runs
  // in the compute gate, before the database can be deleted.
  try {
    if (env.D1_DATABASE_ID) {
      const rows = await cf.d1Rows(accountId, env.D1_DATABASE_ID, 'SELECT domain, roles FROM domains');
      for (const row of rows) {
        let roles = [];
        try {
          const parsed = JSON.parse(row.roles);
          if (Array.isArray(parsed)) roles = parsed;
        } catch { /* malformed row: treat as no roles */ }
        if (roles.includes('mail')) await consider(row.domain);
      }
    }
  } catch { /* table gone or unreadable — the .env fallback below covers it */ }
  if (!zones.size) await consider(env.CLOUDFLARE_ZONE || env.BLACK_HOLE_HOSTNAME);

  // Only offer zones where it is actually on, so a re-run after a partial
  // destroy is quiet rather than asking about nothing.
  const enabled = [];
  for (const zone of zones.values()) {
    try {
      const settings = await cf.getEmailRouting(zone.id);
      if (settings && settings.enabled) enabled.push(zone);
    } catch { /* unreadable: skip rather than guess */ }
  }

  if (!enabled.length) {
    skip('Email Routing is not enabled on any zone this deployment used');
    return;
  }

  plain('');
  plain(`  Email Routing is still enabled on ${color.bold(enabled.map((z) => z.name).join(', '))}.`);
  plain(color.dim('    Disabling it deletes the MX, SPF and DKIM records Cloudflare added and'));
  plain(color.dim('    locked, and the zone stops receiving mail entirely. Any subdomain enabled'));
  plain(color.dim('    for Email Routing under it goes at the same time.'));
  if (!(await confirm('  Disable Email Routing and delete those records?', true))) {
    info(color.dim('Email Routing left enabled. Its MX records stay locked until it is disabled.'));
    return;
  }

  for (const zone of enabled) {
    try {
      await cf.disableEmailRouting(zone.id);
      ok(`disabled Email Routing on ${zone.name} ${color.dim('(MX / SPF / DKIM removed)')}`);
    } catch (err) {
      warn(`could not disable Email Routing on ${zone.name}: ${err.message}`);
      info(color.dim(`  Do it by hand: dashboard → ${zone.name} → Email → Email Routing → Settings → Disable.`));
    }
  }
}

export async function run() {
  const { env, cf, accountId } = await loadContext();

  heading(color.red('Destroy this AREA 51 deployment'));
  plain('');
  plain(`  account    ${accountId}`);
  plain(`  workers    ${[env.WORKER_NAME, env.AGENT_WORKER_NAME, env.CLEANUP_WORKER_NAME].filter(Boolean).join(', ')}`);
  plain(`  pages      ${env.PAGES_PROJECT_NAME} (${env.DASHBOARD_HOSTNAME})`);
  plain(`  database   ${env.D1_DATABASE_NAME} ${color.dim(env.D1_DATABASE_ID || '')}`);
  plain(`  buckets    ${env.R2_BUCKET_NAME}, ${env.R2_FILES_BUCKET_NAME}`);
  plain('');

  if (!(await typeToConfirm('REMOVE', 'Step 1 of 2 — this deletes the three Workers, the Pages project and the Access application.\nCaptured data is NOT touched by this step.'))) {
    plain('  Canceled. Nothing was changed.');
    closePrompts();
    return 1;
  }

  // ── compute ───────────────────────────────────────────────────────────────
  plain('');
  for (const name of [env.WORKER_NAME, env.AGENT_WORKER_NAME, env.CLEANUP_WORKER_NAME].filter(Boolean)) {
    try {
      const script = await cf.getWorkerSettings(accountId, name);
      if (!script) {
        skip(`worker ${name} does not exist`);
        continue;
      }
      await cf.deleteWorkerScript(accountId, name);
      ok(`deleted worker ${name} (its Custom Domains go with it)`);
    } catch (err) {
      warn(`could not delete worker ${name}: ${err.message}`);
    }
  }

  try {
    const project = await cf.getPagesProject(accountId, env.PAGES_PROJECT_NAME);
    if (!project) {
      skip(`Pages project ${env.PAGES_PROJECT_NAME} does not exist`);
    } else {
      // Cloudflare refuses to delete a project while any custom domain is still
      // attached ([8000028]). Detach every one first — no manual dashboard step.
      let domains = [];
      try { domains = (await cf.listPagesDomains(accountId, env.PAGES_PROJECT_NAME)) || []; }
      catch (err) { warn(`could not list the Pages custom domains: ${err.message}`); }
      for (const d of domains) {
        try {
          await cf.deletePagesDomain(accountId, env.PAGES_PROJECT_NAME, d.name);
          ok(`removed custom domain ${d.name} from ${env.PAGES_PROJECT_NAME}`);
        } catch (err) {
          warn(`could not remove custom domain ${d.name}: ${err.message}`);
        }
      }
      // The detach can take a moment to register; retry the project delete a few
      // times before giving up so the whole thing stays one command.
      let lastErr = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await cf.deletePagesProject(accountId, env.PAGES_PROJECT_NAME);
          ok(`deleted Pages project ${env.PAGES_PROJECT_NAME}`);
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err;
          if (attempt < 2) await sleep(2000);
        }
      }
      if (lastErr) throw lastErr;
    }
  } catch (err) {
    warn(`could not delete the Pages project: ${err.message}`);
  }

  if (env.DASHBOARD_HOSTNAME) {
    try {
      const zone = await zoneForHostname(cf, accountId, env.DASHBOARD_HOSTNAME);
      const record = zone && (await cf.findDnsRecord(zone.id, env.DASHBOARD_HOSTNAME));
      if (record && record.type === 'CNAME') {
        await cf.delete(`/zones/${zone.id}/dns_records/${record.id}`);
        ok(`deleted the DNS record for ${env.DASHBOARD_HOSTNAME}`);
      }
    } catch (err) {
      warn(`could not delete the dashboard DNS record: ${err.message}`);
    }
  }

  try {
    const apps = (await cf.listAccessApps(accountId)) || [];
    const app = apps.find((a) => (a.domain || '').replace(/\/$/, '') === env.DASHBOARD_HOSTNAME);
    if (app) {
      await cf.deleteAccessApp(accountId, app.id);
      ok('deleted the Cloudflare Access application');
    } else {
      skip('no Access application to delete');
    }
  } catch (err) {
    warn(`could not delete the Access application: ${err.message}`);
  }

  // The operator list, after the application that referenced it. Order matters:
  // a list still in use by a policy cannot be deleted, and leaving it behind
  // would strand a named list on the account that nothing points at.
  if (env.ACCESS_LIST_ID) {
    try {
      await cf.deleteZeroTrustList(accountId, env.ACCESS_LIST_ID);
      ok('deleted the operator email list');
    } catch (err) {
      warn(`could not delete the operator email list: ${err.message}`);
      plain(color.dim(`    Remove it by hand: dashboard → Zero Trust → My Team → Lists → ${ACCESS_LIST_NAME}.`));
    }
  } else {
    skip('no operator email list recorded in .env');
  }

  await teardownEmailRouting(cf, accountId, env);

  // ── data ──────────────────────────────────────────────────────────────────
  plain('');
  if (!(await confirm('  Also delete the database and both R2 buckets (every captured request and email)?', false))) {
    plain('');
    plain('  Compute removed. Data kept — re-run `./a51 setup` to rebuild on top of it.');
    closePrompts();
    return 0;
  }

  if (!(await typeToConfirm('DELETE-DATA', 'Step 2 of 2 — this permanently deletes every captured request, every captured\nemail (rows AND raw .eml objects), every endpoint and every uploaded payload.'))) {
    plain('  Canceled. Data kept.');
    closePrompts();
    return 1;
  }

  plain('');
  if (env.D1_DATABASE_ID) {
    try {
      let exists = true;
      try {
        await cf.get(`/accounts/${accountId}/d1/database/${env.D1_DATABASE_ID}`);
      } catch (e) {
        if (e.status === 404) exists = false; else throw e;
      }
      if (!exists) {
        skip(`D1 database ${env.D1_DATABASE_NAME} does not exist`);
      } else {
        await cf.delete(`/accounts/${accountId}/d1/database/${env.D1_DATABASE_ID}`);
        ok(`deleted D1 database ${env.D1_DATABASE_NAME}`);
      }
    } catch (err) {
      warn(`could not delete the database: ${err.message}`);
    }
  }

  // R2 refuses to delete a non-empty bucket ([10008]), so each bucket is emptied
  // first. Objects are ENUMERATED via R2's S3 API (the v4 REST API has no
  // reliable object list) using credentials derived from this same token, then
  // DELETED via the v4 object API. This runs only inside the DELETE-DATA gate
  // above, so emptying is always an explicit, confirmed choice. R2 creds are
  // derived once and reused across both buckets.
  let r2creds = null;
  for (const bucket of [env.R2_BUCKET_NAME, env.R2_FILES_BUCKET_NAME].filter(Boolean)) {
    try {
      // Skip a bucket that is already gone, so re-running after a partial destroy
      // is boring rather than noisy.
      let exists = true;
      try {
        await cf.get(`/accounts/${accountId}/r2/buckets/${encodeURIComponent(bucket)}`);
      } catch (e) {
        if (e.status === 404) exists = false; else throw e;
      }
      if (!exists) { skip(`R2 bucket ${bucket} does not exist`); continue; }

      // Empty it. Listing is S3; deletion is the v4 object API.
      if (!r2creds) r2creds = await deriveR2Credentials(cf);
      const keys = await listR2ObjectKeys(accountId, bucket, r2creds);
      if (keys.length) {
        info(color.dim(`  emptying ${bucket}: ${keys.length} object${keys.length === 1 ? '' : 's'}`));
        let deleted = 0;
        let failed = 0;
        const CONCURRENCY = 16;
        for (let i = 0; i < keys.length; i += CONCURRENCY) {
          const batch = keys.slice(i, i + CONCURRENCY);
          const results = await Promise.allSettled(batch.map((k) => cf.deleteR2Object(accountId, bucket, k)));
          for (const r of results) { if (r.status === 'fulfilled') deleted += 1; else failed += 1; }
        }
        if (failed) warn(`  ${failed} object${failed === 1 ? '' : 's'} in ${bucket} could not be deleted — the bucket delete below may fail`);
        ok(`emptied ${bucket} (${deleted} object${deleted === 1 ? '' : 's'} deleted)`);
      }

      await cf.delete(`/accounts/${accountId}/r2/buckets/${encodeURIComponent(bucket)}`);
      ok(`deleted R2 bucket ${bucket}`);
    } catch (err) {
      warn(`could not delete bucket ${bucket}: ${err.message}`);
      info(color.dim('  If this persists, empty it in the dashboard (R2 → bucket → select all → Delete) and re-run.'));
    }
  }

  plain('');
  plain('  Gone. `.env` still holds your token and settings — delete it too if you are done.');
  closePrompts();
  return 0;
}
