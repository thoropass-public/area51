// `./a51 setup` — provision an entire AREA 51 deployment from a Cloudflare API
// token and a domain that is already on the account.
//
// The whole command is idempotent. Re-running it after a failure, after editing
// .env, or after a code change is the normal way to converge the deployment on
// what .env says it should be. Nothing here deletes data.
//
// Order matters in three places:
//   * storage before workers   — a worker whose D1 id is empty won't deploy
//   * worker before catch-all  — Email Routing refuses to target a worker that
//                                does not exist yet
//   * bindings before upload   — the Pages project is created WITH its D1/R2
//                                bindings, so the first deployment already works

import { randomBytes } from 'node:crypto';
import { loadEnv, saveEnv, ensureEnvFile, parseList, envPath } from '../lib/env.mjs';
import { Cloudflare } from '../lib/cloudflare.mjs';
import { step, ok, skip, warn, info, plain, heading, color, resetSteps, die } from '../lib/log.mjs';
import { ask, confirm, select, closePrompts, isAssumeYes } from '../lib/prompt.mjs';
import { resolveAccount, verifyToken, parseRoles, zoneForHostname } from '../lib/context.mjs';
import {
  ensureDatabase, applySchema, ensureBuckets, ensureBlackHole, ensureDestinationAddress,
  ensurePagesProject, ensurePagesDomain, ensureAccess, authFixHint,
} from '../lib/provision.mjs';
import { isAuthError } from '../lib/cloudflare.mjs';
import { printTokenPermissions } from '../lib/permissions.mjs';
import { deployWorker, deployPages, putWorkerSecret, requireWrangler, WORKER_TARGETS } from '../lib/wrangler.mjs';

const DEFAULTS = {
  D1_DATABASE_NAME: 'area51',
  R2_BUCKET_NAME: 'area51-emails',
  R2_FILES_BUCKET_NAME: 'area51-files',
  WORKER_NAME: 'area51-black-holes',
  AGENT_WORKER_NAME: 'area51-autopilot',
  CLEANUP_WORKER_NAME: 'area51-cleanup',
  PAGES_PROJECT_NAME: 'area51',
  BLACK_HOLE_ROLES: 'http,mail',
  ACCESS_SESSION_DURATION: '24h',
  CLEANUP_REQUESTS_KEEP: '1000',
  CLEANUP_EMAIL_MAX_AGE_DAYS: '90',
  CLEANUP_CRON: '0 6 * * *',
};

/** Zero Trust team names allow lowercase letters, digits and dashes. */
function teamNameFrom(zoneName) {
  return zoneName.replace(/\./g, '-').replace(/[^a-z0-9-]/gi, '').toLowerCase().slice(0, 60);
}

export async function run(args) {
  const flags = new Set(args.filter((a) => a.startsWith('--')));
  const skipAccess = flags.has('--no-access');
  const dryRun = flags.has('--dry-run');

  heading('AREA 51 setup');
  plain(color.dim('Provisions D1, R2, three Workers, the Pages dashboard, DNS, Email Routing'));
  plain(color.dim('and Cloudflare Access on your own Cloudflare account. Safe to re-run.'));

  if (ensureEnvFile()) {
    plain('');
    ok(`created .env from .env.example`);
  }
  // A key that exists in .env but is empty falls back to the default, so
  // blanking a line in .env is a way to reset it rather than to break a deploy.
  const fromFile = Object.fromEntries(Object.entries(loadEnv()).filter(([, v]) => v !== ''));
  const env = { ...DEFAULTS, ...fromFile };

  // ── 1. credentials ────────────────────────────────────────────────────────
  resetSteps();
  step('Cloudflare credentials');

  if (!env.CLOUDFLARE_API_TOKEN) {
    plain('');
    printTokenPermissions();
    const token = await ask('  Cloudflare API token', '', { required: true });
    env.CLOUDFLARE_API_TOKEN = token.trim();
    saveEnv({ CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN });
    ok(`stored the token in ${envPath} (gitignored, mode 600)`);
  } else {
    skip('using CLOUDFLARE_API_TOKEN from .env');
  }

  const cf = new Cloudflare(env.CLOUDFLARE_API_TOKEN);
  await verifyToken(cf);

  if (!env.CLOUDFLARE_ACCOUNT_ID) {
    env.CLOUDFLARE_ACCOUNT_ID = await resolveAccount(cf, env);
  } else {
    skip(`account ${color.bold(env.CLOUDFLARE_ACCOUNT_ID)} (from .env)`);
  }
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;

  // ── 2. zone + hostnames ───────────────────────────────────────────────────
  step('Domain and hostnames');

  if (!env.CLOUDFLARE_ZONE) {
    const zones = (await cf.listZones(accountId)) || [];
    if (!zones.length) {
      die('this account has no active zones.\n  Add a domain to Cloudflare first (dashboard → Add a site), then re-run `./a51 setup`.');
    }
    env.CLOUDFLARE_ZONE = await select(
      'Which domain should AREA 51 be deployed on?',
      zones.map((z) => ({ value: z.name, label: z.name, hint: z.status })),
    );
  } else {
    skip(`zone ${color.bold(env.CLOUDFLARE_ZONE)} (from .env)`);
  }

  const zone = await zoneForHostname(cf, accountId, env.CLOUDFLARE_ZONE);
  if (!zone) {
    die(`no active Cloudflare zone named "${env.CLOUDFLARE_ZONE}" is visible to this token.\n  Check the spelling, that the domain is on account ${accountId}, and that the token has Zone:Read.`);
  }
  const zoneName = zone.name;

  plain('');
  plain(`  Three hostnames are provisioned on ${color.bold(zoneName)}:`);
  plain(`    ${color.dim('black hole')}  where targets send traffic and mail (public by design)`);
  plain(`    ${color.dim('dashboard')}   the console you use (locked behind Cloudflare Access)`);
  plain(`    ${color.dim('autopilot')}   the MCP / REST server for AI agents (shared-secret auth)`);
  plain('');

  env.BLACK_HOLE_HOSTNAME = await ask('  Black hole hostname', env.BLACK_HOLE_HOSTNAME || zoneName, { required: true });
  env.DASHBOARD_HOSTNAME = await ask('  Dashboard hostname', env.DASHBOARD_HOSTNAME || `area51.${zoneName}`, { required: true });
  env.AUTOPILOT_HOSTNAME = await ask('  Autopilot hostname', env.AUTOPILOT_HOSTNAME || `autopilot.${zoneName}`, { required: true });
  env.BLACK_HOLE_ROLES = await ask('  Black hole roles (http,mail)', env.BLACK_HOLE_ROLES || 'http,mail', { required: true });
  const roles = parseRoles(env.BLACK_HOLE_ROLES);

  if (roles.includes('mail')) {
    env.FALLBACK_ADDRESS = await ask(
      '  Fallback inbox (only used if an email capture fails; blank to skip)',
      env.FALLBACK_ADDRESS || '',
    );
  }

  // ── 3. access allow-list ──────────────────────────────────────────────────
  step('Dashboard access');
  let allowed = parseList(env.ALLOWED_EMAILS);
  if (skipAccess) {
    warn('--no-access: skipping Cloudflare Access. Anyone who finds the dashboard hostname can read it.');
  } else if (!allowed.length) {
    plain('');
    plain('  The dashboard has no login of its own — Cloudflare Access is the only thing');
    plain('  keeping it private. Entries can be full addresses (you@example.com) or bare');
    plain('  domains (example.com = anyone with that email domain). Comma-separated.');
    plain('');
    const answer = await ask('  Who may open the dashboard?', '', { required: !isAssumeYes() });
    allowed = parseList(answer);
    env.ALLOWED_EMAILS = allowed.join(',');
  } else {
    skip(`allow-list: ${allowed.join(', ')}`);
  }
  if (!env.ACCESS_TEAM_NAME) env.ACCESS_TEAM_NAME = teamNameFrom(zoneName);

  // ── 4. autopilot secret ───────────────────────────────────────────────────
  if (!env.AGENT_SECRET) {
    env.AGENT_SECRET = randomBytes(32).toString('hex');
    ok('generated a 32-byte AGENT_SECRET for Autopilot');
  }

  saveEnv({
    CLOUDFLARE_ZONE: zoneName,
    BLACK_HOLE_HOSTNAME: env.BLACK_HOLE_HOSTNAME,
    DASHBOARD_HOSTNAME: env.DASHBOARD_HOSTNAME,
    AUTOPILOT_HOSTNAME: env.AUTOPILOT_HOSTNAME,
    BLACK_HOLE_ROLES: roles.join(','),
    FALLBACK_ADDRESS: env.FALLBACK_ADDRESS || '',
    ALLOWED_EMAILS: env.ALLOWED_EMAILS || '',
    ACCESS_TEAM_NAME: env.ACCESS_TEAM_NAME,
    ACCESS_SESSION_DURATION: env.ACCESS_SESSION_DURATION,
    AGENT_SECRET: env.AGENT_SECRET,
    D1_DATABASE_NAME: env.D1_DATABASE_NAME,
    R2_BUCKET_NAME: env.R2_BUCKET_NAME,
    R2_FILES_BUCKET_NAME: env.R2_FILES_BUCKET_NAME,
    WORKER_NAME: env.WORKER_NAME,
    AGENT_WORKER_NAME: env.AGENT_WORKER_NAME,
    CLEANUP_WORKER_NAME: env.CLEANUP_WORKER_NAME,
    PAGES_PROJECT_NAME: env.PAGES_PROJECT_NAME,
    CLEANUP_REQUESTS_KEEP: env.CLEANUP_REQUESTS_KEEP,
    CLEANUP_EMAIL_MAX_AGE_DAYS: env.CLEANUP_EMAIL_MAX_AGE_DAYS,
    CLEANUP_CRON: env.CLEANUP_CRON,
  });

  // ── 5. plan + confirmation ────────────────────────────────────────────────
  step('Plan');
  const plan = [
    `D1 database        ${env.D1_DATABASE_NAME}${env.D1_DATABASE_ID ? color.dim(` (existing ${env.D1_DATABASE_ID})`) : ''}`,
    `R2 buckets         ${env.R2_BUCKET_NAME}, ${env.R2_FILES_BUCKET_NAME}`,
    `Worker             ${env.WORKER_NAME} → https://${env.BLACK_HOLE_HOSTNAME}  [${roles.join(', ')}]`,
    `Worker             ${env.AGENT_WORKER_NAME} → https://${env.AUTOPILOT_HOSTNAME}`,
    `Worker             ${env.CLEANUP_WORKER_NAME} (cron ${env.CLEANUP_CRON}, no domain)`,
    `Pages project      ${env.PAGES_PROJECT_NAME} → https://${env.DASHBOARD_HOSTNAME}`,
    roles.includes('mail') ? `Email Routing      *@${zoneName} → ${env.WORKER_NAME}` : `Email Routing      ${color.dim('skipped (no mail role)')}`,
    allowed.length && !skipAccess ? `Cloudflare Access  ${env.DASHBOARD_HOSTNAME} for ${allowed.join(', ')}` : `Cloudflare Access  ${color.yellow('SKIPPED — dashboard will be public')}`,
  ];
  plain('');
  for (const line of plan) plain(`    ${line}`);
  plain('');

  if (dryRun) {
    warn('--dry-run: stopping before any change is made. .env has been updated with the values above.');
    closePrompts();
    return 0;
  }

  if (!(await confirm('  Provision this on Cloudflare now?', true))) {
    plain('\n  Nothing was changed. Re-run `./a51 setup` when ready.');
    closePrompts();
    return 1;
  }

  requireWrangler();
  const followUps = [];

  // ── 6. storage ────────────────────────────────────────────────────────────
  step('Storage (D1 + R2)');
  const db = await ensureDatabase(cf, accountId, env.D1_DATABASE_NAME, env.D1_DATABASE_ID);
  env.D1_DATABASE_ID = db.id;
  saveEnv({ D1_DATABASE_ID: db.id });
  await applySchema(cf, accountId, db.id);
  await ensureBuckets(cf, accountId, { emails: env.R2_BUCKET_NAME, files: env.R2_FILES_BUCKET_NAME }, followUps);

  // ── 7. workers ────────────────────────────────────────────────────────────
  step(`Deploy ${WORKER_TARGETS['black-holes'].label}`);
  if (!deployWorker('black-holes', env).ok) {
    followUps.push({ label: `${env.WORKER_NAME} failed to deploy`, detail: 'Fix the error above, then run `./a51 deploy black-holes`.' });
  }

  step(`Deploy ${WORKER_TARGETS.autopilot.label}`);
  if (putWorkerSecret('autopilot', env, 'AGENT_SECRET', env.AGENT_SECRET).ok) {
    ok('installed AGENT_SECRET as an encrypted Worker Secret');
  } else {
    followUps.push({ label: 'AGENT_SECRET was not installed on the Autopilot worker', detail: 'Run `./a51 deploy autopilot` again — without the secret every agent call returns 401.' });
  }
  if (!deployWorker('autopilot', env).ok) {
    followUps.push({ label: `${env.AGENT_WORKER_NAME} failed to deploy`, detail: 'Fix the error above, then run `./a51 deploy autopilot`.' });
  }

  step(`Deploy ${WORKER_TARGETS.cleanup.label}`);
  if (deployWorker('cleanup', env).ok) {
    ok(`retention cron registered: ${env.CLEANUP_CRON} (UTC)`);
  } else {
    followUps.push({ label: `${env.CLEANUP_WORKER_NAME} failed to deploy`, detail: 'Fix the error above, then run `./a51 deploy cleanup`. Without it, nothing trims old data.' });
  }

  // ── 8. hostnames ──────────────────────────────────────────────────────────
  step('Black hole hostname');
  await ensureBlackHole(cf, accountId, {
    hostname: env.BLACK_HOLE_HOSTNAME,
    roles,
    workerName: env.WORKER_NAME,
    databaseId: db.id,
    followUps,
  });
  if (roles.includes('mail')) {
    await ensureDestinationAddress(cf, accountId, env.FALLBACK_ADDRESS, followUps);
  }

  step('Autopilot hostname');
  const autopilotZone = await zoneForHostname(cf, accountId, env.AUTOPILOT_HOSTNAME);
  if (!autopilotZone) {
    followUps.push({ label: `no zone found for ${env.AUTOPILOT_HOSTNAME}`, detail: 'Add the domain to this Cloudflare account, then re-run `./a51 setup`.' });
  } else {
    try {
      await cf.attachWorkerDomain(accountId, {
        hostname: env.AUTOPILOT_HOSTNAME,
        service: env.AGENT_WORKER_NAME,
        zoneId: autopilotZone.id,
      });
      ok(`${color.bold(env.AUTOPILOT_HOSTNAME)} → Custom Domain on ${env.AGENT_WORKER_NAME}`);
    } catch (err) {
      const manual = `Bind it by hand: dashboard → Workers & Pages → ${env.AGENT_WORKER_NAME} → Settings → Domains & Routes → Add → Custom Domain.`;
      followUps.push({
        label: `could not bind ${env.AUTOPILOT_HOSTNAME} to ${env.AGENT_WORKER_NAME}: ${err.message}`,
        detail: isAuthError(err)
          ? authFixHint(`Zone · Workers Routes:Edit on ${autopilotZone.name}`, { zone: autopilotZone.name, extra: manual })
          : manual,
      });
    }
  }

  // ── 9. dashboard ──────────────────────────────────────────────────────────
  step('Dashboard (Cloudflare Pages)');
  let project = await ensurePagesProject(cf, accountId, env, followUps);
  const bindingsReady = !!project;   // API create + bindings PATCH succeeded
  if (!deployPages(env).ok) {
    followUps.push({ label: 'the dashboard failed to upload', detail: 'Fix the error above, then run `./a51 deploy dashboard`.' });
  }
  if (!bindingsReady) {
    // The API create failed entirely, so `wrangler pages deploy` created a bare
    // project — no D1/R2 bindings, and its production branch defaulted to the
    // local git branch. Attach the bindings + pin the branch now that the project
    // exists, then redeploy so THIS deployment actually carries them; otherwise
    // every /api/* call 500s for a missing DB binding.
    const repaired = await ensurePagesProject(cf, accountId, env, followUps);
    if (repaired) {
      project = repaired;
      info('re-deploying the dashboard now that its D1/R2 bindings are attached…');
      deployPages(env);
    }
  }
  await ensurePagesDomain(cf, accountId, env, env.DASHBOARD_HOSTNAME, project, followUps);

  // ── 10. access ────────────────────────────────────────────────────────────
  step('Cloudflare Access');
  if (skipAccess) {
    warn('skipped (--no-access). Add protection later with `./a51 access`.');
  } else {
    await ensureAccess(cf, accountId, {
      hostname: env.DASHBOARD_HOSTNAME,
      allowed,
      sessionDuration: env.ACCESS_SESSION_DURATION,
      teamName: env.ACCESS_TEAM_NAME,
      pagesProjectName: env.PAGES_PROJECT_NAME,
      followUps,
    });
  }

  // ── done ──────────────────────────────────────────────────────────────────
  printSummary(env, roles, allowed, skipAccess);

  if (followUps.length) {
    heading(`${color.yellow('Manual follow-ups')} (${followUps.length})`);
    followUps.forEach((f, i) => {
      plain(`  ${i + 1}. ${f.label}`);
      for (const line of String(f.detail).split('\n')) plain(`     ${color.dim(line)}`);
    });
    plain('');
    plain(`  Re-run ${color.bold('./a51 setup')} after fixing these — it only changes what is still wrong.`);
    closePrompts();
    return 2;
  }

  closePrompts();
  return 0;
}

function printSummary(env, roles, allowed, skipAccess) {
  heading('Deployed');
  plain('');
  plain(`  Dashboard    ${color.cyan(`https://${env.DASHBOARD_HOSTNAME}`)}`);
  plain(`  Black hole   ${color.cyan(`https://${env.BLACK_HOLE_HOSTNAME}`)}   ${color.dim(`roles: ${roles.join(', ')}`)}`);
  if (roles.includes('mail')) plain(`               ${color.dim(`any address @${env.BLACK_HOLE_HOSTNAME} is a catch-all inbox`)}`);
  plain(`  Autopilot    ${color.cyan(`https://${env.AUTOPILOT_HOSTNAME}/mcp`)}`);
  plain('');
  plain(`  ${color.bold('Register Autopilot with Claude Code:')}`);
  plain('');
  plain(`    claude mcp add autopilot https://${env.AUTOPILOT_HOSTNAME}/mcp \\`);
  plain(`      --transport http --header "X-A51-Secret: ${env.AGENT_SECRET}"`);
  plain('');
  plain(`  ${color.bold('Verify:')}`);
  plain('');
  plain(`    curl -i https://${env.BLACK_HOLE_HOSTNAME}/hello        ${color.dim('# 404! Not Found, and a row in Requests')}`);
  plain(`    ./a51 status                                            ${color.dim('# what is deployed, and what is missing')}`);
  plain(`    ./a51 doctor                                            ${color.dim('# check every binding end to end')}`);
  plain('');
  if (!allowed.length || skipAccess) {
    plain(`  ${color.yellow('!')} The dashboard is NOT protected. Set ALLOWED_EMAILS in .env and run ${color.bold('./a51 access')}.`);
    plain('');
  }
  plain(`  DNS and certificates can take a minute or two to go live. Docs: ${color.dim('docs/README.md')}`);
}
