// The provisioning primitives, shared by `setup`, `deploy`, `black-holes` and
// `users`. Every function here is idempotent: it inspects the current state
// first and reports `created: false` when there is nothing to do, so running
// setup twice is boring rather than destructive.
//
// Functions take an explicit `followUps` array. When a step fails in a way a
// human can finish in the Cloudflare dashboard, it pushes an entry there and
// returns instead of throwing — the run continues, and setup prints the list
// of manual follow-ups at the end (and exits non-zero).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from './env.mjs';
import { ok, skip, warn, info, color } from './log.mjs';
import { isAlreadyExists, isAuthError } from './cloudflare.mjs';
import { splitSqlStatements, describeStatement } from './sql.mjs';
import { degraded, zoneForHostname } from './context.mjs';

/**
 * Pages Functions run on this compatibility date, and `ensurePagesProject` PATCHes
 * it onto the project's production AND preview configs on every
 * `./a51 deploy dashboard`. So this constant does not merely seed a new project —
 * it OVERWRITES whatever the live one is set to. Changing it is a runtime change
 * to every deployment that redeploys.
 *
 * It matches the three `wrangler.toml.template` files, and it must stay that way:
 * one date for the whole project, raised deliberately. Cloudflare's guidance is to
 * keep it current, and some runtime features are gated behind a recent date. A
 * compatibility date does NOT gate security patches — those ship regardless — but
 * it does gate behavioural fixes, which is the real cost of letting it rot.
 *
 * When you raise it, raise all four together, and re-verify the email path
 * afterwards: `nodejs_compat` + postal-mime is where the risk concentrates.
 */
export const PAGES_COMPATIBILITY_DATE = '2026-05-20';

export const SCHEMA_PATH = join(repoRoot, 'db', 'schema.sql');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Compose the fix hint for an auth-shaped failure. Cloudflare returns the same
 * 403 / [10000] / [9109] shape for several distinct causes, and naming only one
 * of them (as this code used to) sends operators to re-check a permission that
 * was already correct. So every auth failure lists the real candidates, most
 * likely first:
 *
 *   1. token propagation — a token created/edited seconds ago (setup retries a
 *      few times, but a long propagation still needs a re-run),
 *   2. the specific permission this step needs — which is often NOT the
 *      obvious one (enabling Email Routing needs Zone Settings, not Email
 *      Routing Rules),
 *   3. Zone Resources scope — a zone permission that doesn't *include* this
 *      zone throws the same error even when the checkbox is ticked,
 *   4. an extra manual step below, when there is one (e.g. Zero Trust).
 *
 * `permission` is the precise permission for this step. `zone` scopes the
 * Zone-Resources note; pass null for account-level steps. `extra` is an
 * optional trailing line (a manual click-path).
 */
export function authFixHint(permission, { zone = null, extra = null } = {}) {
  const lines = [
    `This is an auth-shaped error, which has more than one possible cause:`,
    `  • A just-created/edited token can take up to a minute to propagate — wait and re-run \`./a51 setup\`.`,
    `  • The token needs ${permission}.`,
  ];
  if (zone) {
    lines.push(`  • The token's Zone Resources must INCLUDE ${zone} (or "All zones") — a zone permission scoped elsewhere fails the same way.`);
  }
  if (extra) lines.push(`  • ${extra}`);
  return lines.join('\n');
}

/**
 * Run one provisioning step and never let it abort the command.
 *
 * Every `ensure*` helper below already converts the failures it *expects* into
 * `followUps`. This wraps the ones it does not: a Cloudflare error on a call with
 * no specific handler, a network blip, a bug. Without it a single unexpected
 * throw unwinds to the top-level catch and abandons a half-provisioned
 * deployment — which is the opposite of what an idempotent, re-runnable setup is
 * for. The remaining steps are usually independent and worth doing.
 *
 * Returns `{ ok, value }` so a caller can skip the steps that genuinely depend on
 * this one (a worker cannot deploy without a database id) while still running the
 * ones that do not.
 */
export async function attempt(followUps, label, fn, fixHint) {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    const hint = fixHint || 'Fix the cause above, then re-run — completed steps report "already correct".';
    degraded(
      followUps,
      `${label}: ${message}`,
      isAuthError(err) ? `${hint}\n${authFixHint('the permission this step needs')}` : hint,
    );
    return { ok: false, value: undefined };
  }
}

// ─── zone takeover preflight ────────────────────────────────────────────────

// DNS record types that occupy a hostname. A CNAME cannot coexist with any
// other record at the same name, so anything in this set is a genuine clash;
// TXT/CAA and friends are left alone because they never conflict with what we
// create.
const ADDRESS_RECORD_TYPES = ['A', 'AAAA', 'CNAME'];

/**
 * Read what making `hostname` a black hole would destroy, so the confirmation can
 * name real records instead of warning in the abstract. Returns three lists:
 *
 *   mx       — MX records AT `hostname`. Enabling Email Routing for that name
 *              adds and LOCKS its own, replacing whatever is there.
 *   address  — A / AAAA / CNAME at `hostname`. Binding the catcher as a Custom
 *              Domain replaces the address record already there.
 *   zoneMx   — MX anywhere on the zone, populated ONLY when `hostname` is the
 *              apex. An apex takeover makes Email Routing the mail authority for
 *              the whole zone, so the broader list is the honest thing to show;
 *              a subdomain takeover only touches its own name.
 *
 * `hostname` defaults to the apex. Read-only and best effort: a failed lookup
 * reports nothing rather than blocking on a flaky call, and the provisioning
 * steps still surface their own errors later.
 */
export async function inspectZoneTakeover(cf, zone, hostname = zone.name) {
  const takeover = { mx: [], address: [], zoneMx: [] };
  try {
    const atName = await cf.listDnsRecordsByName(zone.id, hostname);
    takeover.mx = atName.filter((r) => r.type === 'MX');
    takeover.address = atName.filter((r) => ADDRESS_RECORD_TYPES.includes(r.type));
  } catch { /* best effort */ }

  // An apex takeover puts the ZONE's mail at stake, not just the apex records:
  // Email Routing becomes the mail authority for the whole zone. So the apex
  // case also reports MX anywhere on the zone, which is the broader signal an
  // operator needs before handing the domain over. A subdomain takeover only
  // touches records at its own name, so it reports only those.
  if (hostname === zone.name) {
    try {
      takeover.zoneMx = await cf.listDnsRecordsByType(zone.id, 'MX');
    } catch { /* best effort */ }
  }
  return takeover;
}

/** The records a takeover would replace, formatted one per line for display. */
export function describeTakeover(takeover) {
  const mx = takeover.zoneMx.length ? takeover.zoneMx : takeover.mx;
  return [
    ...mx.map((r) => `MX      ${r.name} → ${r.content}`),
    ...takeover.address.map((r) => `${r.type.padEnd(7)} ${r.name} → ${r.content}`),
  ];
}

/**
 * Report a hostname that is already occupied by something that is NOT this
 * deployment. Returns null when the name is free (or already ours), otherwise
 * `{ hostname, records }` for the caller to refuse on.
 *
 * `isOurs` is what makes this safe to run on an existing deployment. Setup
 * derives both hostnames from the zone and never prompts, so without an
 * ownership test the check would refuse every re-run: the second run always
 * finds the record the first one created. Ownership is asked of the Workers /
 * Pages APIs rather than inferred from DNS, because those are authoritative
 * about what this deployment owns.
 */
export async function findHostnameConflict(cf, zone, hostname, isOurs) {
  try {
    if (await isOurs()) return null;
  } catch {
    // Can't establish ownership (a permission gap, a transient error). Fall
    // through to the DNS check rather than claiming the name is free.
  }

  let records = [];
  try {
    records = await cf.listDnsRecordsByName(zone.id, hostname);
  } catch {
    return null;   // can't read DNS: let the provisioning step surface it
  }

  const clash = records.filter((r) => ADDRESS_RECORD_TYPES.includes(r.type));
  return clash.length ? { hostname, records: clash } : null;
}

// ─── storage ────────────────────────────────────────────────────────────────

/** Create the D1 database if absent. Returns { id, created }. */
export async function ensureDatabase(cf, accountId, name, knownId) {
  if (knownId) {
    try {
      const db = await cf.get(`/accounts/${accountId}/d1/database/${knownId}`);
      skip(`D1 database ${color.bold(db.name)} already exists (${knownId})`);
      return { id: knownId, created: false, name: db.name };
    } catch {
      warn(`D1_DATABASE_ID in .env (${knownId}) no longer resolves — looking the database up by name`);
    }
  }
  const { created, database } = await cf.ensureD1Database(accountId, name);
  if (created) ok(`created D1 database ${color.bold(name)} (${database.uuid || database.id})`);
  else skip(`D1 database ${color.bold(name)} already exists`);
  return { id: database.uuid || database.id, created, name };
}

/**
 * Apply db/schema.sql statement by statement over the D1 HTTP API. The schema
 * is written with `CREATE TABLE IF NOT EXISTS`, so this is safe to re-run and
 * never drops data.
 */
export async function applySchema(cf, accountId, databaseId) {
  const statements = splitSqlStatements(readFileSync(SCHEMA_PATH, 'utf8'));
  let applied = 0;
  for (const statement of statements) {
    try {
      await cf.d1Query(accountId, databaseId, statement);
      applied += 1;
    } catch (err) {
      throw new Error(`failed applying schema statement "${describeStatement(statement)}": ${err.message}`);
    }
  }
  ok(`applied ${applied} schema statement${applied === 1 ? '' : 's'} from db/schema.sql`);
  const tables = await cf.d1Rows(
    accountId,
    databaseId,
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_cf%' ESCAPE '\\' ORDER BY name",
  );
  info(color.dim(`tables: ${tables.map((t) => t.name).join(', ')}`));
  return tables.map((t) => t.name);
}

/** Create both R2 buckets if absent. */
export async function ensureBuckets(cf, accountId, { emails, files }, followUps) {
  for (const name of [emails, files]) {
    try {
      const { created } = await cf.ensureR2Bucket(accountId, name);
      if (created) ok(`created R2 bucket ${color.bold(name)}`);
      else skip(`R2 bucket ${color.bold(name)} already exists`);
    } catch (err) {
      degraded(
        followUps,
        `could not create R2 bucket ${name}: ${err.message}`,
        isAuthError(err)
          ? authFixHint('Account · Workers R2 Storage:Edit', { extra: 'R2 must also be ENABLED on the account first (dashboard → R2 → Get started) — the API cannot enable it for you.' })
          : `Create it by hand: dashboard → R2 → Create bucket → name it "${name}".`,
      );
    }
  }
}

// ─── black holes ────────────────────────────────────────────────────────────

/**
 * Make `hostname` a working black hole: bound to the Black Holes worker for
 * HTTP, catch-all Email Routing for mail, and a row in the `domains` table so
 * the dashboard and Autopilot both know about it.
 */
export async function ensureBlackHole(cf, accountId, opts) {
  const { hostname, roles, workerName, databaseId, followUps } = opts;

  const zone = await zoneForHostname(cf, accountId, hostname);
  if (!zone) {
    degraded(
      followUps,
      `no Cloudflare zone found for ${hostname}`,
      'Add the domain to this Cloudflare account first (dashboard → Add a site), then re-run.\nIf the zone exists, the API token is missing Zone:Read for it.',
    );
    return false;
  }

  if (roles.includes('http')) {
    try {
      await cf.attachWorkerDomain(accountId, { hostname, service: workerName, zoneId: zone.id });
      ok(`${color.bold(hostname)} → Custom Domain on ${workerName}`);
    } catch (err) {
      const manual = `Bind it by hand: dashboard → Workers & Pages → ${workerName} → Settings → Domains & Routes\n→ Add → Custom Domain → ${hostname}.`;
      degraded(
        followUps,
        `could not bind ${hostname} to ${workerName}: ${err.message}`,
        isAuthError(err)
          ? authFixHint(`Zone · Workers Routes:Edit on ${zone.name}`, { zone: zone.name, extra: manual })
          : `${manual}\nThe token needs Zone · Workers Routes:Edit on ${zone.name}.`,
      );
    }
  }

  if (roles.includes('mail')) {
    await ensureEmailRouting(cf, zone, workerName, followUps, hostname);
  }

  if (databaseId) {
    await upsertDomainRow(cf, accountId, databaseId, hostname, roles, followUps);
  }
  return true;
}

/**
 * Enable Email Routing for a black hole that is a SUBDOMAIN of its zone.
 *
 * Two facts make this work, and both are load-bearing:
 *   * Email Routing is enabled per NAME — `POST .../email/routing/dns` with the
 *     subdomain adds and locks MX + SPF for that name specifically.
 *   * The zone's catch-all matches the apex AND every subdomain, so once the
 *     name has MX behind it, `<anything>@<subdomain>` lands in the same worker
 *     with no per-subdomain rule to create.
 *
 * The caller must already have established that the zone apex is a mail black
 * hole. Without its catch-all pointing at the worker there is nothing for this
 * subdomain's mail to be delivered to, and `./a51 black-holes add` refuses before
 * it reaches here rather than enabling a name whose mail goes nowhere.
 */
async function ensureSubdomainEmailRouting(cf, zone, workerName, followUps, hostname) {
  const manual = `Add it by hand: dashboard → ${zone.name} → Email → Email Routing → Settings\n→ Subdomains → enter ${hostname}.`;
  try {
    await cf.enableEmailRoutingForName(zone.id, hostname);
    ok(`Email Routing enabled for ${color.bold(hostname)} (MX + SPF added and locked)`);
  } catch (err) {
    if (isAlreadyExists(err)) {
      skip(`Email Routing already enabled for ${hostname}`);
    } else {
      degraded(
        followUps,
        `could not enable Email Routing for ${hostname}: ${err.message}`,
        isAuthError(err)
          ? authFixHint(`Zone · Zone Settings:Edit on ${zone.name}`, { zone: zone.name, extra: manual })
          : manual,
      );
      return;
    }
  }

  // Re-assert the zone catch-all. It should already point at the worker, since
  // the apex is a mail black hole — but the PUT is idempotent, and doing it here
  // means a catch-all somebody repointed by hand gets repaired instead of
  // silently swallowing this subdomain's mail as well.
  try {
    await cf.setCatchAllToWorker(zone.id, workerName);
    skip(`catch-all for *@${zone.name} confirmed → ${workerName} (covers ${hostname})`);
  } catch (err) {
    degraded(
      followUps,
      `could not confirm the ${zone.name} catch-all: ${err.message}`,
      isAuthError(err)
        ? authFixHint(`Zone · Email Routing Rules:Edit on ${zone.name}`, { zone: zone.name })
        : `Set it by hand: dashboard → ${zone.name} → Email → Email Routing → Routing rules\n→ Catch-all address → Edit → Action "Send to a Worker" → ${workerName} → Save.`,
    );
  }
}

/**
 * Enable Email Routing for `hostname` and make sure the zone's catch-all points
 * at the worker. `hostname` defaults to the apex; a subdomain takes the
 * per-name path above.
 */
export async function ensureEmailRouting(cf, zone, workerName, followUps, hostname = zone.name) {
  if (hostname !== zone.name) {
    return ensureSubdomainEmailRouting(cf, zone, workerName, followUps, hostname);
  }
  // NOTE ON PERMISSIONS: the /email/routing settings + enable endpoints are
  // governed by Zone · Zone Settings — NOT by Email Routing Rules (which only
  // covers the catch-all rule set below). A token with Email Routing Rules but
  // no Zone Settings gets a bare [10000] "Authentication error" on enable, which
  // is exactly the trap this messaging is written to defuse. See docs/guides/getting-started.md.

  // Read current state. A zone that never touched Email Routing can 404 here —
  // that legitimately means "disabled". An AUTH error, though, is the real
  // problem (missing Zone Settings, or a zone-scope miss) and must NOT be
  // swallowed as "disabled" — doing so sent us straight into an enable() that
  // failed again with a misleading message.
  let enabled = false;
  try {
    const settings = await cf.getEmailRouting(zone.id);
    enabled = Boolean(settings && settings.enabled);
  } catch (err) {
    if (isAuthError(err)) {
      degraded(
        followUps,
        `could not read Email Routing state on ${zone.name}: ${err.message}`,
        authFixHint(`Zone · Zone Settings:Read on ${zone.name} (Email Routing settings live under Zone Settings, not Email Routing Rules)`, { zone: zone.name }),
      );
      return;
    }
    // Non-auth (e.g. 404): treat as not-yet-enabled and continue to enable.
  }

  if (!enabled) {
    // Pre-existing MX means the zone already receives mail somewhere. Enabling
    // Email Routing adds and LOCKS its own MX for the whole zone, taking over
    // inbound mail — so warn loudly rather than silently break real delivery.
    try {
      const mx = await cf.listDnsRecordsByType(zone.id, 'MX');
      if (mx.length) {
        const shown = mx.slice(0, 3).map((r) => r.content).join(', ');
        warn(`${zone.name} already has ${mx.length} MX record${mx.length === 1 ? '' : 's'} (${shown}${mx.length > 3 ? ', …' : ''}).`);
        warn('  Enabling Email Routing adds and LOCKS its own MX for the whole zone — this takes over inbound mail and breaks existing delivery. Use a domain with no prior mail (see docs/guides/getting-started.md).');
      }
    } catch { /* preflight only — never block the enable on a failed lookup */ }

    try {
      await cf.enableEmailRouting(zone.id);
      ok(`enabled Email Routing on ${color.bold(zone.name)} (MX + SPF records added)`);
    } catch (err) {
      if (isAlreadyExists(err)) {
        skip(`Email Routing already enabled on ${zone.name}`);
      } else if (isAuthError(err)) {
        degraded(
          followUps,
          `could not enable Email Routing on ${zone.name}: ${err.message}`,
          authFixHint(
            `Zone · Zone Settings:Edit on ${zone.name} — enabling Email Routing writes and locks MX/SPF DNS records, which is a Zone Settings write, NOT "Email Routing Rules". This is the usual cause of a [10000] error here.`,
            { zone: zone.name, extra: `Or enable it by hand: dashboard → ${zone.name} → Email → Email Routing → Get started.` },
          ),
        );
        return;
      } else {
        degraded(
          followUps,
          `could not enable Email Routing on ${zone.name}: ${err.message}`,
          `Enable it by hand: dashboard → ${zone.name} → Email → Email Routing → Get started.`,
        );
        return;
      }
    }
  } else {
    skip(`Email Routing already enabled on ${zone.name}`);
  }

  try {
    await cf.setCatchAllToWorker(zone.id, workerName);
    ok(`catch-all for *@${color.bold(zone.name)} → ${workerName}`);
  } catch (err) {
    degraded(
      followUps,
      `could not point the ${zone.name} catch-all at ${workerName}: ${err.message}`,
      isAuthError(err)
        ? authFixHint(`Zone · Email Routing Rules:Edit on ${zone.name} (the catch-all RULE is Email Routing Rules; enabling routing above is Zone Settings)`, { zone: zone.name })
        : `Set it by hand: dashboard → ${zone.name} → Email → Email Routing → Routing rules\n→ Catch-all address → Edit → Action "Send to a Worker" → ${workerName} → Save.`,
    );
  }
}

/** Register the fallback inbox as an Email Routing destination address. */
export async function ensureDestinationAddress(cf, accountId, address, followUps) {
  if (!address) {
    warn('FALLBACK_ADDRESS is empty — a failed email capture will have nowhere to forward to');
    return;
  }
  try {
    const list = (await cf.listDestinationAddresses(accountId)) || [];
    const existing = list.find((d) => (d.email || '').toLowerCase() === address.toLowerCase());
    if (existing && existing.verified) {
      skip(`fallback inbox ${color.bold(address)} is already a verified destination`);
      return;
    }
    if (existing) {
      warn(`fallback inbox ${color.bold(address)} is registered but NOT verified — click the link Cloudflare emailed you`);
      return;
    }
    await cf.createDestinationAddress(accountId, address);
    warn(`registered ${color.bold(address)} as a destination — check that inbox and click Cloudflare's verification link`);
  } catch (err) {
    degraded(
      followUps,
      `could not register the fallback inbox ${address}: ${err.message}`,
      'Add it by hand: dashboard → Email → Email Routing → Destination addresses → Add.\nUntil it is verified, forwarding on a failed capture will silently fail.',
    );
  }
}

/** Insert or update one row in the `domains` table. */
export async function upsertDomainRow(cf, accountId, databaseId, hostname, roles, followUps = []) {
  try {
    await cf.d1Query(
      accountId,
      databaseId,
      'INSERT INTO domains (domain, roles) VALUES (?, ?) ON CONFLICT(domain) DO UPDATE SET roles = excluded.roles',
      [hostname, JSON.stringify(roles)],
    );
    ok(`domains table: ${color.bold(hostname)} = ${JSON.stringify(roles)}`);
  } catch (err) {
    degraded(
      followUps,
      `could not write ${hostname} to the domains table: ${err.message}`,
      `Run it by hand:\n  ./a51 black-holes add ${hostname} ${roles.join(',')}`,
    );
  }
}

// ─── Pages (the dashboard) ──────────────────────────────────────────────────

/** The binding set the dashboard's Pages Functions need. */
export function pagesBindings(env) {
  return {
    compatibility_date: PAGES_COMPATIBILITY_DATE,
    d1_databases: { DB: { id: env.D1_DATABASE_ID } },
    r2_buckets: {
      EML: { name: env.R2_BUCKET_NAME },
      FILES: { name: env.R2_FILES_BUCKET_NAME },
    },
  };
}

/**
 * Create the Pages project with its D1 + R2 bindings already in place, or patch
 * the bindings of an existing project. Doing this before the first upload is
 * what removes the classic "every /api/* call 500s until you add the binding in
 * the dashboard and redeploy" step.
 */
export async function ensurePagesProject(cf, accountId, env, followUps) {
  const name = env.PAGES_PROJECT_NAME;
  const bindings = pagesBindings(env);
  const existing = await cf.getPagesProject(accountId, name);

  // Applied to production AND preview, and re-applied on every run so a project
  // someone edited by hand repairs itself. `production_branch` is pinned so the
  // branch `./a51 deploy` uploads to (main) is the one the custom domain serves.
  const patch = {
    production_branch: 'main',
    deployment_configs: { production: bindings, preview: bindings },
  };

  if (!existing) {
    // Create MINIMALLY, then attach bindings with a PATCH. Creating with
    // `deployment_configs` in the same call is rejected on some accounts with a
    // generic [8000000] "unknown error" — while a bare create (name +
    // production_branch) succeeds. Create-then-patch is the reliable order and
    // still lands the bindings before the first upload (the whole point of doing
    // this over the API), so the dashboard's /api/* never 500s for a missing DB.
    let project;
    try {
      project = await cf.createPagesProject(accountId, { name, production_branch: 'main' });
      ok(`created Pages project ${color.bold(name)}`);
    } catch (err) {
      degraded(
        followUps,
        `could not create the Pages project ${name}: ${err.message}`,
        'Create it by hand (dashboard → Workers & Pages → Create → Pages → Direct upload),\nthen add the D1 binding DB and the R2 bindings EML + FILES for Production AND Preview.',
      );
      return null;
    }
    try {
      await cf.patchPagesProject(accountId, name, patch);
      ok(`Pages project ${color.bold(name)}: DB / EML / FILES bindings attached`);
    } catch (err) {
      degraded(
        followUps,
        `created ${name} but could not attach its bindings: ${err.message}`,
        `Set them by hand: dashboard → Pages → ${name} → Settings → Bindings.\nD1: DB → ${env.D1_DATABASE_NAME}. R2: EML → ${env.R2_BUCKET_NAME}, FILES → ${env.R2_FILES_BUCKET_NAME}.\nAdd them to BOTH Production and Preview, then redeploy.`,
      );
    }
    // Re-read so the caller gets the real (possibly globally-suffixed) subdomain.
    try { return (await cf.getPagesProject(accountId, name)) || project; } catch { return project; }
  }

  try {
    await cf.patchPagesProject(accountId, name, patch);
    ok(`Pages project ${color.bold(name)}: bindings confirmed (DB, EML, FILES)`);
  } catch (err) {
    degraded(
      followUps,
      `could not update bindings on the Pages project ${name}: ${err.message}`,
      `Set them by hand: dashboard → Pages → ${name} → Settings → Bindings.\nD1: DB → ${env.D1_DATABASE_NAME}. R2: EML → ${env.R2_BUCKET_NAME}, FILES → ${env.R2_FILES_BUCKET_NAME}.\nAdd them to BOTH Production and Preview, then redeploy.`,
    );
  }
  return existing;
}

/** Attach the dashboard hostname to the Pages project, DNS record included. */
export async function ensurePagesDomain(cf, accountId, env, hostname, project, followUps) {
  const name = env.PAGES_PROJECT_NAME;
  // Always resolve the project's REAL subdomain. Pages appends a suffix (e.g.
  // area51-xxxx.pages.dev) when the base name is taken globally, so a guessed
  // `${name}.pages.dev` would point the custom domain at a host that isn't ours.
  let live = project;
  if (!live || !live.subdomain) {
    try { live = await cf.getPagesProject(accountId, name); } catch { /* fall back below */ }
  }
  const target = (live && live.subdomain) || `${name}.pages.dev`;

  const zone = await zoneForHostname(cf, accountId, hostname);
  if (!zone) {
    degraded(followUps, `no Cloudflare zone found for the dashboard host ${hostname}`, 'Add the domain to this account, then re-run `./a51 setup`.');
    return;
  }

  try {
    const domains = (await cf.listPagesDomains(accountId, name)) || [];
    if (domains.some((d) => d.name === hostname)) {
      skip(`${color.bold(hostname)} is already a custom domain on ${name}`);
    } else {
      await cf.addPagesDomain(accountId, name, hostname);
      ok(`${color.bold(hostname)} → Pages project ${name}`);
    }
  } catch (err) {
    if (isAlreadyExists(err)) skip(`${hostname} is already a custom domain on ${name}`);
    else {
      degraded(
        followUps,
        `could not attach ${hostname} to the Pages project: ${err.message}`,
        `Attach it by hand: dashboard → Pages → ${name} → Custom domains → Set up a custom domain.`,
      );
    }
  }

  // Pages custom domains resolve through a proxied CNAME to <project>.pages.dev.
  try {
    const record = await cf.findDnsRecord(zone.id, hostname);
    if (!record) {
      await cf.createDnsRecord(zone.id, {
        type: 'CNAME',
        name: hostname,
        content: target,
        proxied: true,
        comment: 'AREA 51 dashboard (Cloudflare Pages)',
      });
      ok(`DNS: ${color.bold(hostname)} CNAME → ${target} (proxied)`);
    } else if (record.type === 'CNAME' && record.content === target) {
      skip(`DNS record for ${hostname} already points at ${target}`);
    } else if (record.type === 'CNAME' && /(^|\.)pages\.dev$/i.test(record.content)) {
      // A Pages-managed CNAME pointing at the WRONG subdomain — e.g. a stale
      // `${name}.pages.dev` guess written before the real suffixed subdomain was
      // known. It is clearly ours to repoint, so fix it rather than warn.
      await cf.updateDnsRecord(zone.id, record.id, {
        type: 'CNAME',
        name: hostname,
        content: target,
        proxied: true,
        comment: 'AREA 51 dashboard (Cloudflare Pages)',
      });
      ok(`DNS: repointed ${color.bold(hostname)} CNAME → ${target} ${color.dim(`(was ${record.content})`)}`);
    } else {
      warn(`DNS record for ${hostname} is a ${record.type} → ${record.content}; leaving it alone. Point it at ${target} if the dashboard doesn't resolve.`);
    }
  } catch (err) {
    degraded(
      followUps,
      `could not create the DNS record for ${hostname}: ${err.message}`,
      `Create it by hand: dashboard → ${zone.name} → DNS → Add record →\nCNAME  ${hostname}  →  ${target}  (Proxied).`,
    );
  }
}

// ─── Cloudflare Access ──────────────────────────────────────────────────────

/**
 * Poll until a just-created Zero-Trust org reads back, so the identity-provider
 * and application calls that follow don't race a not-yet-propagated org. Best
 * effort: returns after the org appears or the attempts run out (the caller's
 * own error handling covers a genuinely broken org).
 */
async function waitForAccessOrg(cf, accountId, { attempts = 4, delayMs = 1500 } = {}) {
  for (let i = 0; i < attempts; i++) {
    await sleep(delayMs);
    try {
      const org = await cf.getAccessOrganization(accountId);
      if (org) return org;
    } catch { /* keep polling — transient during propagation */ }
  }
  return null;
}

/** The name setup gives the operator list, and how it finds one it did not create. */
export const ACCESS_LIST_NAME = 'AREA 51 operators';

/**
 * Find or create the Zero Trust list the Access policy points at, and return
 * its id.
 *
 * Resolution order matters. An id in .env wins, because that is the list this
 * deployment has already adopted; a rename in the Cloudflare dashboard must not
 * silently strand it and start a second list. Only when there is no id does it
 * fall back to matching on name, and only then does it create one.
 *
 * `adopt` is the id of a list that already exists and should be taken over
 * rather than replaced — the migration path for a deployment whose Access
 * policy was pointed at a hand-made list before `./a51 users` existed.
 */
export async function ensureAccessList(cf, accountId, { listId = '', adopt = '' } = {}) {
  const wanted = adopt || listId;
  if (wanted) {
    try {
      const list = await cf.getZeroTrustList(accountId, wanted);
      if (list && list.id) {
        skip(`operator list ${color.bold(list.name || ACCESS_LIST_NAME)} already exists`);
        return { id: list.id, name: list.name || ACCESS_LIST_NAME, created: false };
      }
    } catch {
      // A stale id in .env is not fatal: fall through to name lookup, then to
      // creating a fresh list. Saying so matters, because the old list is left
      // behind on the account rather than cleaned up.
      warn(`ACCESS_LIST_ID ${wanted} no longer resolves — looking for "${ACCESS_LIST_NAME}" instead`);
    }
  }

  const lists = (await cf.listZeroTrustLists(accountId)) || [];
  const byName = lists.find((l) => l.name === ACCESS_LIST_NAME && (l.type || '').toUpperCase() === 'EMAIL');
  if (byName) {
    skip(`operator list ${color.bold(ACCESS_LIST_NAME)} already exists`);
    return { id: byName.id, name: byName.name, created: false };
  }

  const created = await cf.createZeroTrustList(accountId, {
    name: ACCESS_LIST_NAME,
    description: 'Operators who may open the AREA 51 dashboard. Managed by `./a51 users` — edits here are overwritten.',
    items: [],
  });
  ok(`created the operator list ${color.bold(ACCESS_LIST_NAME)}`);
  return { id: created.id, name: created.name || ACCESS_LIST_NAME, created: true };
}

/**
 * Put an Access application in front of the dashboard hostname, gated on the
 * operator list, authenticating with One-time PIN (an emailed code — no
 * identity provider to configure).
 *
 * The policy holds ONE include rule pointing at the list by id, so adding or
 * removing an operator never touches this application — `./a51 users` rewrites
 * the list instead. The single exception is the empty case, below.
 */
export async function ensureAccess(cf, accountId, opts) {
  const { hostname, listId, operatorCount = 0, sessionDuration, teamName, followUps, pagesProjectName } = opts;

  // Manual click-path for turning Zero Trust on. Cloudflare Access requires the
  // account to have Zero Trust activated once (pick a team name / subscribe to
  // the free plan) before the org API works — the API cannot do that first
  // activation for you. Referenced from several branches below.
  const ZT_ACTIVATE = 'If this is a brand-new account, Zero Trust may not be activated yet: open dashboard → Zero Trust once, choose a team name and the Free plan, then re-run `./a51 users sync`.';

  // 1. Zero Trust organization. One per account; it owns the login subdomain.
  let org = null;
  try {
    org = await cf.getAccessOrganization(accountId);
  } catch (err) {
    degraded(
      followUps,
      `could not read the Zero Trust organization: ${err.message}`,
      isAuthError(err)
        ? authFixHint('Account · Access: Organizations, Identity Providers, and Groups:Edit', { extra: ZT_ACTIVATE })
        : `The token needs Account · Access: Organizations, Identity Providers, and Groups:Edit.\n${ZT_ACTIVATE}`,
    );
    return;
  }

  if (!org) {
    const authDomain = `${teamName}.cloudflareaccess.com`;
    try {
      org = await cf.createAccessOrganization(accountId, { name: teamName, authDomain });
      ok(`created Zero Trust organization ${color.bold(authDomain)}`);
      // A just-created org isn't instantly usable by the IdP / app endpoints —
      // that first-run race is what made the app creation below fail until a
      // second run. Poll until the org reads back before proceeding.
      await waitForAccessOrg(cf, accountId);
    } catch (err) {
      degraded(
        followUps,
        `could not create a Zero Trust organization (${authDomain}): ${err.message}`,
        [
          'This can fail for a few reasons:',
          '  • Team names are globally unique — if taken, set ACCESS_TEAM_NAME in .env to something else and re-run `./a51 users sync`.',
          `  • ${ZT_ACTIVATE}`,
          '  • The token needs Account · Access: Organizations, Identity Providers, and Groups:Edit (and a just-edited token may need a minute to propagate).',
        ].join('\n'),
      );
      return;
    }
  } else {
    skip(`Zero Trust organization ${color.bold(org.auth_domain)} already exists`);
  }

  // 2. One-time PIN login method.
  let otpId = null;
  try {
    const idps = (await cf.listAccessIdentityProviders(accountId)) || [];
    const otp = idps.find((i) => i.type === 'onetimepin');
    if (otp) {
      otpId = otp.id;
      skip('One-time PIN login is already enabled');
    } else {
      const created = await cf.createOneTimePinProvider(accountId);
      otpId = created && created.id;
      ok('enabled One-time PIN login (Access emails a code — no IdP to configure)');
    }
  } catch (err) {
    warn(`could not confirm the One-time PIN login method: ${err.message}`);
  }

  // 3. The destinations to guard. A Cloudflare Pages dashboard is reachable at
  // BOTH its custom domain AND the project's *.pages.dev URL — the apex plus
  // every preview deployment (main.<sub>.pages.dev, <hash>.<sub>.pages.dev). If
  // Access only guards the custom domain, the pages.dev URL is an
  // UNAUTHENTICATED BYPASS, so the app must cover all of them. The custom host is
  // listed first so the app's `domain` (and our lookup on it) stays stable.
  const destinations = [{ type: 'public', uri: hostname }];
  if (pagesProjectName) {
    try {
      const proj = await cf.getPagesProject(accountId, pagesProjectName);
      const sub = proj && proj.subdomain;   // e.g. area51-xxxx.pages.dev
      if (sub && !destinations.some((d) => d.uri === sub)) {
        destinations.push({ type: 'public', uri: sub });          // the apex
        destinations.push({ type: 'public', uri: `*.${sub}` });   // preview + branch URLs
      }
    } catch { /* if the project can't be read, guard the custom host only */ }
  }

  // 4. The policy.
  //
  // Normally there is exactly ONE include rule, pointing at the operator list by
  // id. Adding or removing an operator rewrites the LIST, never this
  // application — which is what keeps `./a51 users` cheap and keeps the blast
  // radius of a routine change off the thing that actually guards the dashboard.
  //
  // The empty case is the exception, and it is deliberate. Cloudflare does not
  // document how an include rule behaves when the list it names has no entries,
  // and "probably nobody matches" is not a safe thing to infer for the only
  // control protecting every captured request and email. So when there are no
  // operators, the policy becomes an explicit deny-everyone: no inference, no
  // reliance on emergent behaviour, and the dashboard is shut whatever Cloudflare
  // would have done with an empty list. Adding an operator restores the allow.
  const policies = operatorCount > 0
    ? [{
        name: 'AREA 51 operators',
        decision: 'allow',
        include: [{ email_list: { id: listId } }],
      }]
    : [{
        name: 'AREA 51 — no operators',
        decision: 'deny',
        include: [{ everyone: {} }],
      }];

  // `app_launcher_visible` is a presentation preference, not a control: it only
  // decides whether the dashboard appears as a tile in the Zero Trust App
  // Launcher. New apps are created hidden, because a pentest console does not
  // belong in a directory everyone browses — but an existing app whose owner
  // turned it ON keeps that choice. Updating an Access app is a full PUT, so
  // anything not carried across here is silently reset; that is worth being
  // careful about on the one object standing between the internet and every
  // captured request.
  const body = {
    name: 'AREA 51 dashboard',
    type: 'self_hosted',
    domain: hostname,
    destinations,
    session_duration: sessionDuration,
    app_launcher_visible: false,
    ...(otpId ? { allowed_idps: [otpId], auto_redirect_to_identity: true } : {}),
    policies,
  };

  const gate = operatorCount > 0
    ? `${operatorCount} operator${operatorCount === 1 ? '' : 's'} via the list`
    : color.yellow('DENY ALL — no operators');

  try {
    const apps = (await cf.listAccessApps(accountId)) || [];
    const existing = apps.find((a) => (a.domain || '').replace(/\/$/, '') === hostname);
    if (existing) {
      if (existing.app_launcher_visible) body.app_launcher_visible = true;
      await cf.updateAccessApp(accountId, existing.id, body);
      ok(`updated the Access application on ${color.bold(hostname)} (${gate})`);
    } else {
      await cf.createAccessApp(accountId, body);
      ok(`Access application protects ${color.bold(hostname)} (${gate})`);
    }
    info(color.dim(operatorCount > 0
      ? `allow-list: the "${ACCESS_LIST_NAME}" list (${listId})`
      : 'no operators — the dashboard is closed to everyone until one is added'));
    if (destinations.length > 1) {
      info(color.dim(`also guards the pages.dev URL (no Access bypass): ${destinations.slice(1).map((d) => d.uri).join(', ')}`));
    } else if (pagesProjectName) {
      warn('could not read the Pages subdomain — the app guards only the custom domain. Re-run once the Pages project exists so the *.pages.dev URL is covered too.');
    }
  } catch (err) {
    const manual = `Configure it by hand: dashboard → Zero Trust → Access → Applications → Add an application\n→ Self-hosted → domain ${hostname} → policy Allow / Emails in list "${ACCESS_LIST_NAME}".`;
    degraded(
      followUps,
      `could not configure Cloudflare Access on ${hostname}: ${err.message}`,
      isAuthError(err)
        ? authFixHint('Account · Access: Apps and Policies:Edit', { extra: manual })
        : `${manual}\nThe token needs Account · Access: Apps and Policies:Edit.`,
    );
  }
}
