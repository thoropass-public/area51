// `./a51 destroy` — tear the deployment down again.
//
// Split into two gates on purpose. The first removes compute (workers, the Pages
// project, the Access application) which is fully rebuildable from this repo.
// The second removes storage (the D1 database and both R2 buckets) which
// destroys every captured request, email and staged endpoint, permanently.
//
// Neither gate is satisfiable by --yes: destroying data always requires typing
// the word.

import { loadContext, zoneForHostname } from '../lib/context.mjs';
import { heading, plain, ok, warn, skip, color, info } from '../lib/log.mjs';
import { typeToConfirm, confirm, closePrompts } from '../lib/prompt.mjs';
import { deriveR2Credentials, listR2ObjectKeys } from '../lib/r2s3.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

  info(color.dim('Email Routing was left enabled — it is a zone-wide setting with its own DNS records.'));

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
