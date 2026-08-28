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
import { step, ok, skip, warn, info, plain, heading, color, resetSteps, die, setStepTotal, section, hint, detail, summary } from '../lib/log.mjs';
import { ask, confirm, select, typeToConfirm, closePrompts } from '../lib/prompt.mjs';
import { resolveAccount, verifyToken, parseRoles, zoneForHostname } from '../lib/context.mjs';
import {
  ensureDatabase, applySchema, ensureBuckets, ensureBlackHole, ensureDestinationAddress,
  ensurePagesProject, ensurePagesDomain, ensureAccess, authFixHint,
  inspectZoneTakeover, describeTakeover, findHostnameConflict, attempt,
} from '../lib/provision.mjs';
import { isAuthError } from '../lib/cloudflare.mjs';
import { printTokenPermissions } from '../lib/permissions.mjs';
import { deployWorker, deployPages, putWorkerSecret, wranglerBin, WORKER_TARGETS } from '../lib/wrangler.mjs';

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
  // Twelve numbered steps, so each header can say [3/12] and a reader can tell
  // how much is left. Keep this in step with the step() calls below.
  setStepTotal(12);
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

  // The layout is fixed, and none of it is asked. The black hole is the zone
  // apex with both roles; AREA 51 and Autopilot are fixed subdomains of it.
  //
  // Why the apex, specifically: the catch-all rule that delivers mail to the
  // catcher is zone-scoped, and it covers the apex plus every subdomain enabled
  // for Email Routing. Nothing at all can capture mail on the zone until the
  // apex is a mail black hole, because that is what puts the catch-all there.
  // Making it the primary black hole establishes that foundation once, and makes
  // the HTTP host and the mail domain the same string.
  //
  // Subdomains CAN capture mail — `./a51 black-holes add sub.example.com mail`
  // enables Email Routing for that name and the zone catch-all picks it up. That
  // is an additive layer on top of the apex, not an alternative to it.
  //
  // .env still wins for the other two hostnames. One already set there is used
  // as-is, so an operator who needs a different layout writes it by hand and
  // re-runs — no prompt, and no way to get there by accident.
  env.BLACK_HOLE_HOSTNAME = zoneName;
  env.BLACK_HOLE_ROLES = 'http,mail';
  const roles = parseRoles(env.BLACK_HOLE_ROLES);
  env.DASHBOARD_HOSTNAME = env.DASHBOARD_HOSTNAME || `area51.${zoneName}`;
  env.AUTOPILOT_HOSTNAME = env.AUTOPILOT_HOSTNAME || `autopilot.${zoneName}`;

  // A deployment created before the layout was fixed may carry a subdomain black
  // hole in .env. Moving it to the apex is the right migration, but doing it
  // silently would leave the old hostname still bound to the worker and still
  // listed in the `domains` table — a black hole nobody chose. Say so, and name
  // the command that clears it.
  const previousBlackHole = fromFile.BLACK_HOLE_HOSTNAME;
  if (previousBlackHole && previousBlackHole !== zoneName) {
    warn(`the black hole moves from ${previousBlackHole} to the apex ${color.bold(zoneName)}`);
    plain(color.dim(`      ${previousBlackHole} stays bound to ${env.WORKER_NAME} and stays in the domains table.`));
    plain(color.dim(`      Drop it with \`./a51 black-holes remove ${previousBlackHole}\` if you no longer want it.`));
  }

  plain('');
  plain(`  ${color.bold(zoneName)} becomes the black hole:`);
  plain('');
  plain(`    ${color.dim('HTTP callbacks ')}  https://${color.bold(zoneName)}/<anything>`);
  plain(`    ${color.dim('Email callbacks')}  <anything>@${color.bold(zoneName)}`);
  plain(`    ${color.dim('AREA 51        ')}  https://${env.DASHBOARD_HOSTNAME} ${color.dim('— the console, behind Cloudflare Access')}`);
  plain(`    ${color.dim('Autopilot      ')}  https://${env.AUTOPILOT_HOSTNAME} ${color.dim('— MCP / REST for agents, shared secret')}`);
  plain('');

  if (!(await confirmZoneTakeover(cf, zone, env, { dryRun }))) {
    plain('\n  Nothing was changed. Re-run `./a51 setup` and pick another zone.');
    closePrompts();
    return 1;
  }

  // Preflight, before the plan, so a name that is already taken is visible early.
  // It reports rather than exits: the rest of the deployment is still worth
  // provisioning, and the conflicting hostname's own steps are skipped below.
  const hostConflicts = await findDerivedHostnameConflicts(cf, accountId, zone, env);

  env.FALLBACK_ADDRESS = await ask(
    '  Fallback inbox (only used if an email capture fails; blank to skip)',
    env.FALLBACK_ADDRESS || '',
  );

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
    // Required, with no escape. This prompt is the dashboard's only protection,
    // and it is exactly where the old --yes flag did its damage: it made this
    // optional, so an unattended install shipped a world-readable console. If you
    // genuinely want that, `--no-access` says so out loud.
    const answer = await ask('  Who may open the dashboard?', '', { required: true });
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
    `Email Routing      *@${zoneName} → ${env.WORKER_NAME}`,
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

  const followUps = [...hostConflicts.map((c) => ({ label: c.label, detail: c.detail }))];
  const taken = new Set(hostConflicts.map((c) => c.key));
  const dashboardHostFree = !taken.has('DASHBOARD_HOSTNAME');
  const autopilotHostFree = !taken.has('AUTOPILOT_HOSTNAME');

  // Wrangler only uploads code. If it is missing, everything provisioned over the
  // REST API (storage, DNS, Email Routing, Access) is still worth doing, so this
  // records a follow-up and skips the four upload steps instead of aborting.
  let canUpload = true;
  if (!wranglerBin()) {
    canUpload = false;
    warn('wrangler is not installed — provisioning will continue, but no code can be uploaded');
    followUps.push({
      label: 'no code was uploaded (wrangler is not installed)',
      detail: 'Run `npm install` in the repository root, then `./a51 deploy all`.',
    });
  }

  // ── 6. storage ────────────────────────────────────────────────────────────
  step('Storage (D1 + R2)');
  const dbStep = await attempt(
    followUps,
    `could not create or read the D1 database ${env.D1_DATABASE_NAME}`,
    () => ensureDatabase(cf, accountId, env.D1_DATABASE_NAME, env.D1_DATABASE_ID),
    'Create it by hand: `npx wrangler d1 create ' + env.D1_DATABASE_NAME + '`, put the id in D1_DATABASE_ID in .env, then re-run `./a51 setup`.',
  );
  const db = dbStep.value || { id: env.D1_DATABASE_ID || '' };
  if (db.id) {
    env.D1_DATABASE_ID = db.id;
    saveEnv({ D1_DATABASE_ID: db.id });
    await attempt(
      followUps,
      'could not apply db/schema.sql',
      () => applySchema(cf, accountId, db.id),
      'Apply it by hand: `npx wrangler d1 execute ' + env.D1_DATABASE_NAME + ' --remote --file=db/schema.sql`, or re-run `./a51 doctor --fix`.',
    );
  } else {
    // Everything downstream binds to this id. Say so once, here, rather than
    // letting four later steps fail for the same reason.
    warn('no database id — the workers and the dashboard cannot be bound to storage');
  }
  await attempt(
    followUps,
    'could not create the R2 buckets',
    () => ensureBuckets(cf, accountId, { emails: env.R2_BUCKET_NAME, files: env.R2_FILES_BUCKET_NAME }, followUps),
  );

  // ── 7. workers ────────────────────────────────────────────────────────────
  const skipUploads = !canUpload || !db.id;

  step(`Deploy ${WORKER_TARGETS['black-holes'].label}`);
  if (skipUploads) {
    skip(canUpload ? 'skipped — no database id to bind' : 'skipped — wrangler is not installed');
  } else if (!deployWorker('black-holes', env).ok) {
    followUps.push({ label: `${env.WORKER_NAME} failed to deploy`, detail: 'Fix the error above, then run `./a51 deploy black-holes`.' });
  }

  step(`Deploy ${WORKER_TARGETS.autopilot.label}`);
  if (skipUploads) {
    skip(canUpload ? 'skipped — no database id to bind' : 'skipped — wrangler is not installed');
  } else if (putWorkerSecret('autopilot', env, 'AGENT_SECRET', env.AGENT_SECRET).ok) {
    ok('installed AGENT_SECRET as an encrypted Worker Secret');
  } else {
    followUps.push({ label: 'AGENT_SECRET was not installed on the Autopilot worker', detail: 'Run `./a51 deploy autopilot` again — without the secret every agent call returns 401.' });
  }
  if (!skipUploads && !deployWorker('autopilot', env).ok) {
    followUps.push({ label: `${env.AGENT_WORKER_NAME} failed to deploy`, detail: 'Fix the error above, then run `./a51 deploy autopilot`.' });
  }

  step(`Deploy ${WORKER_TARGETS.cleanup.label}`);
  if (skipUploads) {
    skip(canUpload ? 'skipped — no database id to bind' : 'skipped — wrangler is not installed');
  } else if (deployWorker('cleanup', env).ok) {
    ok(`retention cron registered: ${env.CLEANUP_CRON} (UTC)`);
  } else {
    followUps.push({ label: `${env.CLEANUP_WORKER_NAME} failed to deploy`, detail: 'Fix the error above, then run `./a51 deploy cleanup`. Without it, nothing trims old data.' });
  }

  // ── 8. hostnames ──────────────────────────────────────────────────────────
  step('Black hole hostname');
  await attempt(
    followUps,
    `could not finish setting up the black hole ${env.BLACK_HOLE_HOSTNAME}`,
    () => ensureBlackHole(cf, accountId, {
      hostname: env.BLACK_HOLE_HOSTNAME,
      roles,
      workerName: env.WORKER_NAME,
      databaseId: db.id,
      followUps,
    }),
    `Re-run \`./a51 black-holes add ${env.BLACK_HOLE_HOSTNAME} ${roles.join(',')}\` once the cause is fixed.`,
  );
  if (roles.includes('mail')) {
    await attempt(
      followUps,
      `could not register the fallback inbox ${env.FALLBACK_ADDRESS || '(unset)'}`,
      () => ensureDestinationAddress(cf, accountId, env.FALLBACK_ADDRESS, followUps),
    );
  }

  step('Autopilot hostname');
  const autopilotZone = autopilotHostFree ? await zoneForHostname(cf, accountId, env.AUTOPILOT_HOSTNAME) : null;
  if (!autopilotHostFree) {
    skip(`${env.AUTOPILOT_HOSTNAME} skipped — a foreign DNS record is in the way (see follow-ups)`);
  } else if (!autopilotZone) {
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
  let project = (await attempt(
    followUps,
    `could not create or configure the Pages project ${env.PAGES_PROJECT_NAME}`,
    () => ensurePagesProject(cf, accountId, env, followUps),
  )).value || null;
  const bindingsReady = !!project;   // API create + bindings PATCH succeeded
  if (skipUploads) {
    skip(canUpload ? 'upload skipped — no database id to bind' : 'upload skipped — wrangler is not installed');
  } else if (!deployPages(env).ok) {
    followUps.push({ label: 'the dashboard failed to upload', detail: 'Fix the error above, then run `./a51 deploy dashboard`.' });
  }
  if (!bindingsReady) {
    // The API create failed entirely, so `wrangler pages deploy` created a bare
    // project — no D1/R2 bindings, and its production branch defaulted to the
    // local git branch. Attach the bindings + pin the branch now that the project
    // exists, then redeploy so THIS deployment actually carries them; otherwise
    // every /api/* call 500s for a missing DB binding.
    const repaired = (await attempt(
      followUps,
      `could not attach bindings to ${env.PAGES_PROJECT_NAME} on the second attempt`,
      () => ensurePagesProject(cf, accountId, env, followUps),
    )).value || null;
    if (repaired) {
      project = repaired;
      if (!skipUploads) {
        info('re-deploying the dashboard now that its D1/R2 bindings are attached…');
        deployPages(env);
      }
    }
  }
  if (dashboardHostFree) {
    await attempt(
      followUps,
      `could not attach ${env.DASHBOARD_HOSTNAME} to the Pages project`,
      () => ensurePagesDomain(cf, accountId, env, env.DASHBOARD_HOSTNAME, project, followUps),
    );
  } else {
    skip(`${env.DASHBOARD_HOSTNAME} skipped — a foreign DNS record is in the way (see follow-ups)`);
  }

  // ── 10. access ────────────────────────────────────────────────────────────
  step('Cloudflare Access');
  if (skipAccess) {
    warn('skipped (--no-access). Add protection later with `./a51 access apply`.');
  } else {
    await attempt(
      followUps,
      `could not configure Cloudflare Access on ${env.DASHBOARD_HOSTNAME}`,
      () => ensureAccess(cf, accountId, {
        hostname: env.DASHBOARD_HOSTNAME,
        allowed,
        sessionDuration: env.ACCESS_SESSION_DURATION,
        teamName: env.ACCESS_TEAM_NAME,
        pagesProjectName: env.PAGES_PROJECT_NAME,
        followUps,
      }),
      'Re-run `./a51 access apply` once the cause is fixed. Until it succeeds the dashboard is UNPROTECTED.',
    );
  }

  // ── done ──────────────────────────────────────────────────────────────────
  printSummary(env, roles, allowed, skipAccess);

  if (followUps.length) {
    heading(`${color.yellow(`Needs a human (${followUps.length})`)}`);
    plain('');
    followUps.forEach((f, i) => {
      plain(`  ${color.yellow(String(i + 1) + '.')} ${f.label}`);
      hint(f.detail);
      plain('');
    });
    plain(`  Everything else is provisioned. Re-run ${color.bold('./a51 setup')} after fixing these —`);
    plain('  it only changes what is still wrong.');
    closePrompts();
    return 2;
  }

  closePrompts();
  return 0;
}

/**
 * The one genuinely destructive thing setup does: it takes a whole zone over.
 * Email Routing locks its own MX across the zone, and the apex address record
 * is replaced by the catcher's Custom Domain — so any site or mailbox on that
 * domain stops working, and neither change is undone by walking away.
 *
 * The disclaimer always prints. When the zone actually has something to lose it
 * names the exact records and escalates to a typed confirmation, so hijacking a
 * domain somebody is using cannot happen on a reflexive Enter. A clean burner
 * zone gets a plain y/N, which keeps the loud path rare enough to still mean
 * something when it fires.
 *
 * Returns false if the operator backs out.
 */
async function confirmZoneTakeover(cf, zone, env, { dryRun = false } = {}) {
  plain(`  ${color.yellow('Use a domain you do not use for anything else.')}`);
  plain('');
  plain('  Setup takes over the entire zone:');
  plain(`    · Email Routing is enabled and ${color.bold('LOCKS')} its own MX records, redirecting`);
  plain(`      all mail for *@${zone.name} to ${env.WORKER_NAME}.`);
  plain(`    · The apex (@) address record is replaced by a Custom Domain on that`);
  plain(`      same worker, so ${zone.name} stops serving whatever it serves today.`);
  plain('    · Every path and every address on the domain becomes a public trap.');
  plain('');

  const doomed = describeTakeover(await inspectZoneTakeover(cf, zone));

  if (doomed.length) {
    warn(`${color.bold(zone.name)} is already in use. These records will be replaced or overridden:`);
    plain('');
    for (const line of doomed) plain(`      ${color.red(line)}`);
    plain('');
  }

  // --dry-run changes nothing, so there is nothing to consent to. It still
  // prints everything above, which makes it the safe way to find out what a
  // zone would lose before committing to it.
  if (dryRun) {
    skip('--dry-run: no confirmation needed, nothing will be taken over');
    return true;
  }

  if (!doomed.length) {
    return confirm(`  Make ${color.bold(zone.name)} a black hole?`, true);
  }

  return typeToConfirm(
    'TAKEOVER',
    `${zone.name} already serves traffic or mail. Continuing breaks it, and the\nMX records Email Routing writes are locked afterwards.`,
  );
}

/**
 * Both private hostnames are derived rather than asked, so a name that is
 * already taken has to be caught here — otherwise it surfaces much later as an
 * opaque Cloudflare error part-way through provisioning, with half a deployment
 * already built.
 *
 * Ownership is tested FIRST, and against the Workers / Pages APIs rather than
 * DNS, so re-running against a live deployment stays a no-op: the record found
 * at area51.<zone> on the second run is the one the first run created. Without
 * that test this check would refuse every deployment it had ever built.
 *
 * The apex is deliberately not checked. Replacing the record there is the
 * documented intent of the takeover confirmed above, not a collision.
 */
async function findDerivedHostnameConflicts(cf, accountId, zone, env) {
  const checks = [
    {
      key: 'DASHBOARD_HOSTNAME',
      hostname: env.DASHBOARD_HOSTNAME,
      isOurs: async () => {
        const domains = (await cf.listPagesDomains(accountId, env.PAGES_PROJECT_NAME)) || [];
        return domains.some((d) => d.name === env.DASHBOARD_HOSTNAME);
      },
    },
    {
      key: 'AUTOPILOT_HOSTNAME',
      hostname: env.AUTOPILOT_HOSTNAME,
      isOurs: async () => {
        const bound = (await cf.listWorkerDomains(accountId, env.AGENT_WORKER_NAME)) || [];
        return bound.some((d) => d.hostname === env.AUTOPILOT_HOSTNAME);
      },
    },
  ];

  const conflicts = [];
  for (const check of checks) {
    // Only names inside the selected zone are checked here. A hostname an
    // operator deliberately pointed at another zone in .env is theirs to own,
    // and its provisioning step resolves its own zone anyway.
    if (check.hostname !== zone.name && !check.hostname.endsWith(`.${zone.name}`)) {
      skip(`${check.hostname} is outside ${zone.name} — left to its provisioning step`);
      continue;
    }
    let conflict = null;
    try {
      conflict = await findHostnameConflict(cf, zone, check.hostname, check.isOurs);
    } catch {
      // The check itself failing is not a reason to stop; the provisioning step
      // will surface a real problem with its own message.
      continue;
    }
    if (!conflict) continue;
    const shown = conflict.records.map((r) => `${r.type} ${r.name} → ${r.content}`).join('\n      ');
    warn(`${check.hostname} already has a DNS record that is not part of this deployment:`);
    plain(`      ${color.red(shown)}`);
    conflicts.push({
      key: check.key,
      hostname: check.hostname,
      label: `${check.hostname} is taken by a DNS record that is not this deployment's`,
      detail:
        `      ${shown}\n` +
        `Delete it (dashboard → ${zone.name} → DNS), or set ${check.key} in .env to a\n` +
        `hostname that is free, then re-run \`./a51 setup\`.`,
    });
  }
  return conflicts;
}

function printSummary(env, roles, allowed, skipAccess) {
  heading('Deployed');
  plain('');
  plain(`  AREA 51      ${color.cyan(`https://${env.DASHBOARD_HOSTNAME}`)}`);
  plain(`  Autopilot    ${color.cyan(`https://${env.AUTOPILOT_HOSTNAME}/mcp`)}`);
  plain('');
  // The two callback surfaces are listed separately and spelled out in full.
  // Merging them into one "any address @<host>" line is what used to hand out
  // a mail domain that did not exist whenever the black hole was a subdomain.
  plain(`  ${color.bold('Black hole')} ${color.dim('— point targets at these:')}`);
  plain('');
  plain(`    HTTP callbacks   ${color.cyan(`https://${env.BLACK_HOLE_HOSTNAME}/<anything>`)}`);
  if (roles.includes('mail')) {
    plain(`    Email callbacks  ${color.cyan(`<anything>@${env.BLACK_HOLE_HOSTNAME}`)}`);
  }
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
