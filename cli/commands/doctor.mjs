// `./a51 doctor` — check every moving part of a deployment and say exactly what
// is wrong and how to fix it. `--fix` re-applies the things that are safe to
// re-apply (schema, Pages bindings, domain bindings, Access policy).
//
// Read-only by default. The live probes at the end hit the deployed hostnames
// from this machine, so they also catch DNS and certificate problems that the
// API cannot see.

import { loadContext, parseRoles, zoneForHostname } from '../lib/context.mjs';
import { heading, plain, color, info } from '../lib/log.mjs';
import { applySchema, ensurePagesProject, ensurePagesDomain, ensureBlackHole, ensureAccess, pagesBindings } from '../lib/provision.mjs';
import { parseList } from '../lib/env.mjs';

const REQUIRED_TABLES = ['domains', 'email_blacklist', 'emails', 'endpoints', 'ip_blacklist', 'requests'];

class Report {
  constructor() {
    this.pass = 0;
    this.warns = [];
    this.fails = [];
  }

  ok(msg) {
    this.pass += 1;
    plain(`  ${color.green('✓')} ${msg}`);
  }

  warn(msg, fix) {
    this.warns.push(msg);
    plain(`  ${color.yellow('!')} ${msg}`);
    if (fix) plain(`      ${color.dim(fix)}`);
  }

  fail(msg, fix) {
    this.fails.push(msg);
    plain(`  ${color.red('✗')} ${msg}`);
    if (fix) plain(`      ${color.dim(fix)}`);
  }
}

async function probe(url, { headers = {}, redirect = 'manual' } = {}) {
  try {
    const res = await fetch(url, { headers, redirect, signal: AbortSignal.timeout(10000) });
    return { ok: true, status: res.status, location: res.headers.get('location') || '', body: (await res.text()).slice(0, 200) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export async function run(args) {
  const fix = args.includes('--fix');
  const skipProbes = args.includes('--no-probes');
  const { env, cf, accountId } = await loadContext();
  const r = new Report();
  const followUps = [];

  heading(`AREA 51 doctor${fix ? color.yellow('  (--fix: will repair what it can)') : ''}`);

  // ── configuration ─────────────────────────────────────────────────────────
  plain(`\n${color.bold('Configuration')}`);
  const required = ['CLOUDFLARE_ACCOUNT_ID', 'D1_DATABASE_ID', 'D1_DATABASE_NAME', 'R2_BUCKET_NAME', 'R2_FILES_BUCKET_NAME', 'WORKER_NAME', 'AGENT_WORKER_NAME', 'CLEANUP_WORKER_NAME', 'PAGES_PROJECT_NAME', 'DASHBOARD_HOSTNAME', 'AUTOPILOT_HOSTNAME'];
  const missing = required.filter((k) => !env[k]);
  if (missing.length) r.fail(`.env is missing ${missing.join(', ')}`, 'Run `./a51 setup` — it fills these in as it provisions.');
  else r.ok('.env has every value the deploy needs');
  if (!env.AGENT_SECRET) r.warn('AGENT_SECRET is empty — Autopilot cannot authenticate any agent', 'Run `./a51 rotate-secret`.');

  try {
    const token = await cf.verifyToken();
    if (token && token.status === 'active') r.ok('API token is active');
    else r.fail(`API token status is "${token && token.status}"`, 'Create a new token and update CLOUDFLARE_API_TOKEN in .env.');
  } catch (err) {
    r.fail(`API token rejected: ${err.message}`, 'See docs/setup.md#api-token for the exact permission list.');
    summarise(r);
    return r.fails.length ? 1 : 0;
  }

  // ── storage ───────────────────────────────────────────────────────────────
  plain(`\n${color.bold('Storage')}`);
  let tables = [];
  if (env.D1_DATABASE_ID) {
    try {
      const db = await cf.get(`/accounts/${accountId}/d1/database/${env.D1_DATABASE_ID}`);
      r.ok(`D1 database ${db.name} (${env.D1_DATABASE_ID})`);
      tables = (await cf.d1Rows(accountId, env.D1_DATABASE_ID, "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")).map((t) => t.name);
      const missingTables = REQUIRED_TABLES.filter((t) => !tables.includes(t));
      if (missingTables.length) {
        if (fix) {
          await applySchema(cf, accountId, env.D1_DATABASE_ID);
          r.ok(`re-applied db/schema.sql (was missing: ${missingTables.join(', ')})`);
        } else {
          r.fail(`missing tables: ${missingTables.join(', ')}`, 'Run `./a51 doctor --fix` (or `./a51 deploy schema`) to apply db/schema.sql.');
        }
      } else {
        r.ok(`all six tables present`);
      }

      // Column-level drift: these were added after the first release.
      const emailCols = (await cf.d1Rows(accountId, env.D1_DATABASE_ID, 'PRAGMA table_info(emails)')).map((c) => c.name);
      for (const col of ['read', 'starred', 'attachment_count']) {
        if (!emailCols.includes(col)) {
          r.fail(`emails.${col} is missing`, `Add it: ALTER TABLE emails ADD COLUMN ${col} INTEGER NOT NULL DEFAULT 0;`);
        }
      }
      const endpointCols = (await cf.d1Rows(accountId, env.D1_DATABASE_ID, 'PRAGMA table_info(endpoints)')).map((c) => c.name);
      for (const col of ['r2_key', 'filename']) {
        if (!endpointCols.includes(col)) {
          r.fail(`endpoints.${col} is missing — file-backed endpoints will fail`, `Add it: ALTER TABLE endpoints ADD COLUMN ${col} TEXT;`);
        }
      }
      if (emailCols.length && endpointCols.length) r.ok('emails / endpoints columns match the current schema');
    } catch (err) {
      r.fail(`D1 database unreachable: ${err.message}`, 'Check D1_DATABASE_ID in .env, or run `./a51 setup`.');
    }
  }

  for (const [label, bucket] of [['captured email', env.R2_BUCKET_NAME], ['endpoint files', env.R2_FILES_BUCKET_NAME]]) {
    if (!bucket) continue;
    try {
      await cf.get(`/accounts/${accountId}/r2/buckets/${encodeURIComponent(bucket)}`);
      r.ok(`R2 bucket ${bucket} (${label})`);
    } catch (err) {
      r.fail(`R2 bucket ${bucket} missing: ${err.message}`, 'Run `./a51 setup`, or create it at dashboard → R2 → Create bucket.');
    }
  }

  // ── workers ───────────────────────────────────────────────────────────────
  plain(`\n${color.bold('Workers')}`);
  const WORKER_CHECKS = [
    { target: 'black-holes', label: 'Black Holes', name: env.WORKER_NAME, bindings: ['DB', 'EML', 'FILES'] },
    { target: 'autopilot', label: 'Autopilot', name: env.AGENT_WORKER_NAME, bindings: ['DB', 'EML', 'AGENT_SECRET'] },
    { target: 'cleanup', label: 'Cleanup', name: env.CLEANUP_WORKER_NAME, bindings: ['DB', 'EML'] },
  ];
  for (const check of WORKER_CHECKS) {
    if (!check.name) continue;
    const settings = await cf.getWorkerSettings(accountId, check.name);
    if (!settings) {
      r.fail(`${check.label} worker "${check.name}" is not deployed`, `Run \`./a51 deploy ${check.target}\`.`);
      continue;
    }
    r.ok(`${check.label}: ${check.name} deployed`);
    const present = new Set(((settings.bindings || [])).map((b) => b.name));
    const missing = check.bindings.filter((b) => !present.has(b));
    if (missing.length) {
      const secret = missing.includes('AGENT_SECRET');
      r.fail(
        `${check.name} is missing binding(s): ${missing.join(', ')}`,
        secret
          ? 'AGENT_SECRET is not installed — every agent call returns 401. Run `./a51 deploy autopilot`.'
          : `Run \`./a51 deploy ${check.target}\` after confirming the matching names in .env.`,
      );
    }
  }

  // ── black holes ───────────────────────────────────────────────────────────
  plain(`\n${color.bold('Black holes')}`);
  let blackHoles = [];
  if (env.D1_DATABASE_ID && tables.includes('domains')) {
    blackHoles = await cf.d1Rows(accountId, env.D1_DATABASE_ID, 'SELECT domain, roles FROM domains ORDER BY domain');
    if (!blackHoles.length) r.warn('the domains table is empty — the dashboard shows no hosts and agents cannot build callback URLs', 'Run `./a51 domains add <host> http,mail`.');
  }

  let workerDomains = [];
  try {
    workerDomains = (await cf.listWorkerDomains(accountId, env.WORKER_NAME)) || [];
  } catch (err) {
    r.warn(`could not list the worker's Custom Domains: ${err.message}`, 'The token needs Zone · Workers Routes:Edit to read or change these.');
  }
  const boundHosts = new Set(workerDomains.map((d) => d.hostname));

  for (const row of blackHoles) {
    const roles = parseRoles(safeRoles(row.roles), { fallback: [] });
    if (roles.includes('http')) {
      if (boundHosts.has(row.domain)) r.ok(`${row.domain}: bound to ${env.WORKER_NAME}`);
      else if (fix) {
        await ensureBlackHole(cf, accountId, { hostname: row.domain, roles, workerName: env.WORKER_NAME, databaseId: env.D1_DATABASE_ID, followUps });
        r.ok(`${row.domain}: re-bound to ${env.WORKER_NAME}`);
      } else {
        r.fail(`${row.domain} is in the domains table but not bound to ${env.WORKER_NAME}`, 'Run `./a51 doctor --fix`, or `./a51 domains add ' + row.domain + ' ' + roles.join(',') + '`.');
      }
    }
    if (roles.includes('mail')) {
      const zone = await zoneForHostname(cf, accountId, row.domain);
      if (!zone) {
        r.warn(`${row.domain}: no zone visible, cannot check Email Routing`);
        continue;
      }
      try {
        const settings = await cf.getEmailRouting(zone.id);
        if (!settings || !settings.enabled) {
          r.fail(`Email Routing is disabled on ${zone.name}`, `Enable it: \`./a51 domains add ${row.domain} ${roles.join(',')}\`.`);
        } else {
          const catchAll = await cf.getCatchAll(zone.id);
          const action = ((catchAll && catchAll.actions) || [])[0] || {};
          const target = (action.value || [])[0];
          if (action.type === 'worker' && target === env.WORKER_NAME) r.ok(`*@${zone.name} → ${env.WORKER_NAME}`);
          else r.fail(`the ${zone.name} catch-all points at ${action.type || 'nothing'}${target ? ` (${target})` : ''}, not ${env.WORKER_NAME}`, `Fix it: \`./a51 domains add ${row.domain} ${roles.join(',')}\`.`);
        }
      } catch (err) {
        r.fail(`could not read Email Routing on ${zone.name}: ${err.message}`, 'Reading Email Routing state needs Zone · Zone Settings:Read (NOT Email Routing Rules, which only covers the catch-all rule). Enabling it needs Zone Settings:Edit.');
      }
    }
  }

  if (env.FALLBACK_ADDRESS) {
    try {
      const list = (await cf.listDestinationAddresses(accountId)) || [];
      const dest = list.find((d) => (d.email || '').toLowerCase() === env.FALLBACK_ADDRESS.toLowerCase());
      if (dest && dest.verified) r.ok(`fallback inbox ${env.FALLBACK_ADDRESS} is verified`);
      else if (dest) r.warn(`fallback inbox ${env.FALLBACK_ADDRESS} is not verified — forwarding on a failed capture will fail`, 'Click the verification link Cloudflare emailed to that address.');
      else r.warn(`${env.FALLBACK_ADDRESS} is not an Email Routing destination on this account`, 'Run `./a51 setup` to register it, then verify from that inbox.');
    } catch (err) {
      r.warn(`could not check destination addresses: ${err.message}`);
    }
  }

  // ── dashboard ─────────────────────────────────────────────────────────────
  plain(`\n${color.bold('Dashboard')}`);
  const project = await cf.getPagesProject(accountId, env.PAGES_PROJECT_NAME);
  if (!project) {
    r.fail(`Pages project "${env.PAGES_PROJECT_NAME}" does not exist`, 'Run `./a51 setup`.');
  } else {
    r.ok(`Pages project ${project.name} (${project.subdomain})`);
    const want = pagesBindings(env);
    for (const target of ['production', 'preview']) {
      const cfg = (project.deployment_configs && project.deployment_configs[target]) || {};
      const problems = [];
      if (!cfg.d1_databases || !cfg.d1_databases.DB || cfg.d1_databases.DB.id !== want.d1_databases.DB.id) problems.push('DB (D1)');
      for (const binding of ['EML', 'FILES']) {
        const got = cfg.r2_buckets && cfg.r2_buckets[binding];
        if (!got || got.name !== want.r2_buckets[binding].name) problems.push(`${binding} (R2)`);
      }
      if (problems.length) {
        if (fix) {
          await ensurePagesProject(cf, accountId, env, followUps);
          r.ok(`${target} bindings repaired — redeploy with \`./a51 deploy dashboard\``);
        } else {
          r.fail(`${target} bindings missing or wrong: ${problems.join(', ')}`, 'Run `./a51 doctor --fix` then `./a51 deploy dashboard`. Without these, /api/* returns 500.');
        }
      } else {
        r.ok(`${target} bindings: DB, EML, FILES`);
      }
    }
    try {
      const domains = (await cf.listPagesDomains(accountId, env.PAGES_PROJECT_NAME)) || [];
      const match = domains.find((d) => d.name === env.DASHBOARD_HOSTNAME);
      if (match) r.ok(`custom domain ${match.name} (${match.status || 'active'})`);
      else r.fail(`${env.DASHBOARD_HOSTNAME} is not attached to the Pages project`, 'Run `./a51 setup`.');
    } catch (err) {
      r.warn(`could not list Pages custom domains: ${err.message}`);
    }

    // Production branch — a mismatch means the branch `deploy` uploads to (main)
    // is NOT the one the custom domain serves, so the dashboard renders empty.
    if (project.production_branch && project.production_branch !== 'main') {
      if (fix) {
        await ensurePagesProject(cf, accountId, env, followUps);
        r.ok(`production branch was "${project.production_branch}" — reset to main; redeploy with \`./a51 deploy dashboard\``);
      } else {
        r.fail(`Pages production branch is "${project.production_branch}", not main — the custom domain serves an empty production`, 'Run `./a51 doctor --fix`, then `./a51 deploy dashboard`.');
      }
    }

    // DNS target — the dashboard CNAME must point at the project's REAL subdomain
    // (Cloudflare suffixes it on a global name collision, e.g. area51-xxxx.pages.dev),
    // not a guessed `<name>.pages.dev`.
    try {
      const zone = await zoneForHostname(cf, accountId, env.DASHBOARD_HOSTNAME);
      const record = zone && (await cf.findDnsRecord(zone.id, env.DASHBOARD_HOSTNAME));
      if (record && record.type === 'CNAME' && project.subdomain && record.content !== project.subdomain) {
        if (fix) {
          await ensurePagesDomain(cf, accountId, env, env.DASHBOARD_HOSTNAME, project, followUps);
          r.ok(`DNS repointed to ${project.subdomain} (was ${record.content})`);
        } else {
          r.fail(`dashboard DNS points at ${record.content}, but the Pages subdomain is ${project.subdomain}`, 'Run `./a51 doctor --fix` — it repoints the CNAME.');
        }
      } else if (record && record.type === 'CNAME' && record.content === project.subdomain) {
        r.ok(`DNS → ${project.subdomain}`);
      }
    } catch (err) {
      r.warn(`could not check the dashboard DNS record: ${err.message}`);
    }
  }

  // ── access ────────────────────────────────────────────────────────────────
  plain(`\n${color.bold('Access control')}`);
  const allowed = parseList(env.ALLOWED_EMAILS);
  try {
    const apps = (await cf.listAccessApps(accountId)) || [];
    const app = apps.find((a) => (a.domain || '').replace(/\/$/, '') === env.DASHBOARD_HOSTNAME);
    if (!app) {
      if (fix && allowed.length) {
        await ensureAccess(cf, accountId, { hostname: env.DASHBOARD_HOSTNAME, allowed, sessionDuration: env.ACCESS_SESSION_DURATION || '24h', teamName: env.ACCESS_TEAM_NAME, pagesProjectName: env.PAGES_PROJECT_NAME, followUps });
      } else {
        r.fail(`no Cloudflare Access application protects ${env.DASHBOARD_HOSTNAME} — the dashboard is open to anyone`, allowed.length ? 'Run `./a51 access` (or `./a51 doctor --fix`).' : 'Set ALLOWED_EMAILS in .env, then run `./a51 access`.');
      }
    } else {
      const policies = (await cf.get(`/accounts/${accountId}/access/apps/${app.id}/policies`)) || [];
      const allows = policies.filter((p) => p.decision === 'allow');
      if (!allows.length) r.fail(`the Access app on ${env.DASHBOARD_HOSTNAME} has no allow policy — nobody can get in`, 'Run `./a51 access`.');
      else r.ok(`Access protects ${env.DASHBOARD_HOSTNAME} (${allows.length} allow policy, session ${app.session_duration || 'default'})`);

      // The dashboard is also reachable at the project's *.pages.dev URL. If the
      // Access app's destinations don't cover it, that URL is an unauthenticated
      // bypass — one of the most important things to catch here.
      if (project && project.subdomain) {
        const uris = (app.destinations || []).map((d) => d.uri || '');
        const guarded = uris.some((u) => u === project.subdomain || u === `*.${project.subdomain}`);
        if (guarded) {
          r.ok(`Access also guards the pages.dev URL (${project.subdomain}) — no bypass`);
        } else if (fix && allowed.length) {
          await ensureAccess(cf, accountId, { hostname: env.DASHBOARD_HOSTNAME, allowed, sessionDuration: env.ACCESS_SESSION_DURATION || '24h', teamName: env.ACCESS_TEAM_NAME, pagesProjectName: env.PAGES_PROJECT_NAME, followUps });
          r.ok(`added the pages.dev URL (${project.subdomain}) to the Access app`);
        } else {
          r.fail(`the Access app does not cover ${project.subdomain} — the dashboard is reachable UNAUTHENTICATED at its *.pages.dev URL`, 'Run `./a51 doctor --fix` (or `./a51 access`) to add it.');
        }
      }
    }
  } catch (err) {
    r.warn(`could not check Cloudflare Access: ${err.message}`, 'The token needs Account · Access: Apps and Policies:Edit to read this.');
  }

  // ── live probes ───────────────────────────────────────────────────────────
  if (!skipProbes) {
    plain(`\n${color.bold('Live probes')}`);
    for (const row of blackHoles) {
      const roles = parseRoles(safeRoles(row.roles), { fallback: [] });
      if (!roles.includes('http')) continue;
      const res = await probe(`https://${row.domain}/__a51_doctor_probe`);
      if (!res.ok) r.fail(`https://${row.domain} did not respond: ${res.error}`, 'DNS or the certificate may still be provisioning. Retry in a minute.');
      else if (res.status === 404) r.ok(`https://${row.domain} answers 404 on an unknown path (correct — and the hit is now in Requests)`);
      else if (res.status === 403) r.warn(`https://${row.domain} answered 403 — this machine's IP may be on the ip_blacklist`);
      else r.warn(`https://${row.domain} answered ${res.status} on an unknown path — expected 404`);
    }

    if (env.AUTOPILOT_HOSTNAME) {
      const unauth = await probe(`https://${env.AUTOPILOT_HOSTNAME}/requests`);
      if (!unauth.ok) r.fail(`https://${env.AUTOPILOT_HOSTNAME} did not respond: ${unauth.error}`, 'Check the Custom Domain binding on the Autopilot worker.');
      else if (unauth.status === 401) {
        r.ok(`Autopilot rejects unauthenticated requests (401)`);
        if (env.AGENT_SECRET) {
          const auth = await probe(`https://${env.AUTOPILOT_HOSTNAME}/requests`, { headers: { 'X-A51-Secret': env.AGENT_SECRET } });
          if (auth.ok && auth.status === 200) r.ok('Autopilot accepts the AGENT_SECRET in .env');
          else r.fail(`Autopilot rejected the AGENT_SECRET in .env (HTTP ${auth.status || auth.error})`, 'The deployed secret differs from .env. Run `./a51 deploy autopilot`.');
        }
      } else if (unauth.status === 530) {
        r.fail(`https://${env.AUTOPILOT_HOSTNAME} answered 530 — the hostname isn't routed to a worker (worker not deployed, or its Custom Domain is missing)`, 'Run `./a51 deploy autopilot`, then `./a51 setup` to (re)bind the hostname.');
      } else {
        r.fail(`Autopilot answered ${unauth.status} without a secret — expected 401`, 'If the worker is deployed, confirm AGENT_SECRET is installed: `./a51 deploy autopilot`.');
      }
    }

    if (env.DASHBOARD_HOSTNAME) {
      const res = await probe(`https://${env.DASHBOARD_HOSTNAME}/`);
      if (!res.ok) r.fail(`https://${env.DASHBOARD_HOSTNAME} did not respond: ${res.error}`, 'DNS or the Pages custom domain may still be provisioning.');
      else if ([301, 302, 303, 307, 308].includes(res.status) && /cloudflareaccess\.com/.test(res.location)) r.ok('the dashboard redirects to the Cloudflare Access login (protected)');
      else if (res.status === 200 && /cloudflareaccess/.test(res.body)) r.ok('the dashboard is behind Cloudflare Access');
      else if (res.status === 200) r.fail('the dashboard served content with no Access challenge — it is publicly readable', 'Set ALLOWED_EMAILS in .env and run `./a51 access`.');
      else if (res.status === 530) r.fail(`https://${env.DASHBOARD_HOSTNAME} answered 530 — the hostname isn't routed (Pages project or its custom domain is missing)`, 'Run `./a51 setup` to (re)create the project and attach the custom domain.');
      else r.warn(`the dashboard answered ${res.status}`);
    }
  }

  summarise(r);
  return r.fails.length ? 1 : 0;
}

function safeRoles(raw) {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.join(',') : '';
  } catch {
    return '';
  }
}

function summarise(r) {
  plain('');
  const parts = [
    color.green(`${r.pass} ok`),
    r.warns.length ? color.yellow(`${r.warns.length} warning${r.warns.length === 1 ? '' : 's'}`) : null,
    r.fails.length ? color.red(`${r.fails.length} problem${r.fails.length === 1 ? '' : 's'}`) : null,
  ].filter(Boolean);
  heading(parts.join(' · '));
  if (!r.fails.length && !r.warns.length) info(color.dim('Everything checks out.'));
  plain('');
}
