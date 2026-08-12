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
    plain('  Cancelled. Nothing was changed.');
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
    if (project) {
      await cf.deletePagesProject(accountId, env.PAGES_PROJECT_NAME);
      ok(`deleted Pages project ${env.PAGES_PROJECT_NAME}`);
    } else {
      skip(`Pages project ${env.PAGES_PROJECT_NAME} does not exist`);
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
    plain('  Cancelled. Data kept.');
    closePrompts();
    return 1;
  }

  plain('');
  if (env.D1_DATABASE_ID) {
    try {
      await cf.delete(`/accounts/${accountId}/d1/database/${env.D1_DATABASE_ID}`);
      ok(`deleted D1 database ${env.D1_DATABASE_NAME}`);
    } catch (err) {
      warn(`could not delete the database: ${err.message}`);
    }
  }

  for (const bucket of [env.R2_BUCKET_NAME, env.R2_FILES_BUCKET_NAME].filter(Boolean)) {
    try {
      await cf.delete(`/accounts/${accountId}/r2/buckets/${encodeURIComponent(bucket)}`);
      ok(`deleted R2 bucket ${bucket}`);
    } catch (err) {
      warn(`could not delete bucket ${bucket}: ${err.message}`);
      info(color.dim('  R2 refuses to delete a bucket that still has objects. Empty it first:'));
      info(color.dim(`  dashboard → R2 → ${bucket} → select all → Delete, then re-run.`));
    }
  }

  plain('');
  plain('  Gone. `.env` still holds your token and settings — delete it too if you are done.');
  closePrompts();
  return 0;
}
