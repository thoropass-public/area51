// `./a51 black-holes` manages black holes.
//
// A black hole is a Cloudflare zone handed over to the catcher. Concretely it is
// three things kept in step by this command: the zone apex bound to the Black
// Holes worker as a Custom Domain (HTTP), Email Routing enabled on the zone with
// its catch-all pointed at the same worker (mail), and a row in the D1 `domains`
// table (so the dashboard and Autopilot know it exists).
//
// There are no roles and no subdomains here, and both absences are deliberate.
//
//   Roles. A black hole used to be able to carry http, mail, or both, which put
//   a two-valued flag in the table and a branch on it in every reader: the CLI,
//   doctor, the dashboard API, the Home orbit chips, Autopilot's tool
//   descriptions. Every black hole now does both, so the flag is gone with them.
//
//   Subdomains. `add` takes the zone apex only. The apex is what makes the zone
//   capture mail at all (the catch-all that delivers to the worker is
//   zone-scoped), so a subdomain was never an alternative to it, only an extra
//   layer on top. That layer is now the operator's to add by hand in the
//   Cloudflare dashboard, where it is two clicks and needs nothing from this
//   tool; docs/guides/operations.md has both recipes. `remove` still accepts a
//   subdomain, because a deployment made before this change may have one in the
//   table and it has to be possible to take it back out.
//
// See docs/decisions.md#a-black-hole-is-a-whole-zone-and-has-no-roles.
//
// One black hole is not like the others: the zone `./a51 setup` deployed onto.
// The dashboard and Autopilot answer on subdomains of it, and its zone-wide
// catch-all is what makes this deployment capture mail at all, so `remove`
// refuses it outright. Which one that is comes from .env, not from the table;
// see `primaryHost` below.
//
// The D1 table is still called `domains`; only the command was renamed. Renaming
// the table would mean a migration plus edits in all four workers and the
// dashboard frontend, for nothing an operator can see.

import { loadContext, zoneForHostname } from '../lib/context.mjs';
import { step, ok, warn, skip, plain, heading, color, resetSteps, die, info, table, sym, hint } from '../lib/log.mjs';
import { confirm, typeToConfirm, closePrompts } from '../lib/prompt.mjs';
import { ensureBlackHole, inspectZoneTakeover, describeTakeover } from '../lib/provision.mjs';

const USAGE = './a51 black-holes [list | add <zone> | remove <host>]';

export async function run(args) {
  const positional = args.filter((a) => !a.startsWith('--'));
  const action = positional[0] || 'list';

  const { env, cf, accountId } = await loadContext({ needDatabase: true });
  resetSteps();

  if (action === 'list') return list(cf, accountId, env);
  if (action === 'add') return add(cf, accountId, env, positional[1]);
  if (action === 'remove') return remove(cf, accountId, env, positional[1]);

  die(`unknown action "${action}".\n  Usage: ${USAGE}`);
  return 1;
}

/**
 * The primary black hole: the zone this deployment was set up on.
 *
 * Read from .env rather than recorded per host, and deliberately so. The
 * `domains` table is one column (CLAUDE.md invariant 10) and the last thing it
 * needs is a second per-host flag a month after `roles` was removed from it.
 * .env already names this one. `setup` writes BLACK_HOLE_HOSTNAME there and
 * derives DASHBOARD_HOSTNAME and AUTOPILOT_HOSTNAME from the same answer, so
 * the fact is already stored, once, in the place CLAUDE.md invariant 9 keeps
 * deployment state.
 *
 * It is also the honest shape. Primary is a property of THIS deployment, not of
 * the zone: the same apex would be an ordinary black hole in somebody else's.
 * A column would claim otherwise, and would have to be kept in step with .env
 * by hand.
 *
 * Lowercased because hostnames are case-insensitive and this is compared
 * against whatever an operator typed on the command line. Empty when .env has
 * no BLACK_HOLE_HOSTNAME, which means there is nothing to protect yet.
 */
function primaryHost(env) {
  return String(env.BLACK_HOLE_HOSTNAME || '').trim().toLowerCase();
}

/** Whether `hostname` as typed is that primary. */
function isPrimary(hostname, env) {
  const primary = primaryHost(env);
  return Boolean(primary) && String(hostname).trim().toLowerCase() === primary;
}

async function list(cf, accountId, env) {
  heading(`Black holes ${color.dim(`worker ${env.WORKER_NAME}`)}`);
  const rows = await cf.d1Rows(accountId, env.D1_DATABASE_ID, 'SELECT domain FROM domains ORDER BY domain');
  if (!rows.length) {
    plain('');
    warn('none configured');
    hint('Add one with `./a51 black-holes add <zone>`');
    plain('');
    return 0;
  }

  // The Custom Domain list is a nice-to-have: the table is the source of truth,
  // so a failure here costs the BOUND column, not the listing.
  let bound = [];
  let boundKnown = true;
  try {
    bound = (await cf.listWorkerDomains(accountId, env.WORKER_NAME)) || [];
  } catch {
    boundKnown = false;
  }
  const boundHosts = new Set(bound.map((d) => d.hostname));

  // Two columns, because there is no longer a third worth printing. This table
  // used to carry a CAPTURES column spelling out the two surfaces each host
  // offered, which was worth the width only while hosts differed. Every row now
  // captures the same two things, so it is said once, below the table, instead
  // of once per row.
  //
  // The primary is marked rather than sorted to the top. The ordering is the
  // table's, which is alphabetical and stable; a row that jumped the queue would
  // make the list harder to scan to say something the mark already says.
  const out = [[color.dim('HOST'), color.dim(''), color.dim('BOUND')]];
  let unbound = 0;
  let primarySeen = false;
  for (const row of rows) {
    let state;
    if (!boundKnown) state = color.dim('?');
    else if (boundHosts.has(row.domain)) state = sym.ok;
    else { state = sym.fail; unbound += 1; }
    const primary = isPrimary(row.domain, env);
    if (primary) primarySeen = true;
    out.push([color.cyan(row.domain), primary ? color.dim('primary') : '', state]);
  }

  plain('');
  table(out);
  plain('');
  plain(color.dim('  Each one serves https://<host>/<any path> and captures <anything>@<host>.'));
  if (primarySeen) {
    plain(color.dim('  The primary is the zone AREA 51 is deployed on, and cannot be removed.'));
  }
  plain('');

  if (unbound) {
    warn(`${unbound} host${unbound === 1 ? '' : 's'} ${unbound === 1 ? 'is' : 'are'} not bound to ${env.WORKER_NAME}`);
    hint('Fix with `./a51 doctor --fix`, or re-add the host.');
  } else if (!boundKnown) {
    skip('could not read the worker\'s Custom Domains, so BOUND is unknown (needs Zone · Workers Routes:Edit)');
  }
  info(color.dim(`${rows.length} black hole${rows.length === 1 ? '' : 's'} · database ${env.D1_DATABASE_NAME}`));
  plain('');
  return 0;
}

/**
 * A black hole is the whole zone, so `add` takes the apex and nothing else.
 *
 * This is mechanics before it is policy. The catch-all rule that delivers mail
 * to the worker is zone-scoped: it exists once the apex is a black hole, and it
 * then covers the apex and every subdomain enabled for Email Routing. A
 * subdomain could therefore never be a black hole on its own, only an addition
 * to one. That is why the old command had an elaborate "is the apex already a
 * mail black hole?" gate in front of it. Taking the apex as given removes the
 * gate and the ordering problem it policed.
 *
 * It costs the one thing it used to allow: an http-only catcher on a subdomain,
 * with the zone's mail untouched. That is now a Cloudflare dashboard step the
 * operator takes themselves, so this says where to read about it rather than
 * only refusing.
 */
function assertApex(hostname, zone) {
  if (hostname === zone.name) return;
  die([
    `${hostname} is not a zone apex, and a black hole is a whole zone.`,
    '',
    `  Making ${zone.name} a black hole points every path on it at the catcher and`,
    '  hands it every address on the zone. There is no per-subdomain version of',
    '  that: the catch-all rule that delivers mail is zone-scoped, so the apex is',
    '  what makes the zone capture anything at all.',
    '',
    '  Add the zone:',
    `    ./a51 black-holes add ${zone.name}`,
    '',
    `  To put ${hostname} alone on the catcher, or to capture mail at it, do it in`,
    '  the Cloudflare dashboard. Both are a couple of clicks and AREA 51 needs no',
    '  part in either; the recipes are in docs/guides/operations.md.',
  ].join('\n'));
}

/**
 * Show what this add changes, and take consent for the destructive part.
 *
 * It always asks. Adding a black hole hands the zone's inbound mail to the
 * catcher, and Email Routing writes and LOCKS its MX to do it; that is not
 * something to discover afterward. When records will really be lost they are
 * named first and the gate becomes a typed confirmation rather than a y/N, so it
 * cannot be cleared by a reflexive Enter.
 */
async function confirmAdd(cf, zone, hostname) {
  const doomed = describeTakeover(await inspectZoneTakeover(cf, zone, hostname));

  plain('');
  plain(`  ${color.bold(hostname)}`);
  plain('');
  plain(`    ${color.dim('HTTP callbacks ')}  https://${hostname}/<anything>`);
  plain(`    ${color.dim('Email callbacks')}  <anything>@${hostname}`);
  plain('');
  plain(`  Email Routing will add and ${color.bold('LOCK')} MX + SPF records for ${zone.name},`);
  plain('  taking over inbound mail for the whole zone.');
  plain('');

  if (doomed.length) {
    warn('these records will be replaced or overridden:');
    plain('');
    for (const line of doomed) plain(`      ${color.red(line)}`);
    plain('');
    return typeToConfirm('TAKEOVER', `${hostname} already has records that this replaces.`);
  }

  return confirm(`  Add ${color.bold(hostname)} as a black hole?`, true);
}

async function add(cf, accountId, env, hostname) {
  if (!hostname) die('usage: ./a51 black-holes add <zone>');

  const zone = await zoneForHostname(cf, accountId, hostname);
  if (!zone) {
    die(
      `no Cloudflare zone found for ${hostname}.\n` +
      '  Add the domain to this Cloudflare account (dashboard → Add a site), then re-run.\n' +
      '  If the zone does exist, the API token is missing Zone:Read for it.',
    );
  }
  assertApex(hostname, zone);

  if (!(await confirmAdd(cf, zone, hostname))) {
    plain('\n  Canceled. Nothing was changed.');
    closePrompts();
    return 1;
  }

  step(`Add black hole ${hostname}`);
  const followUps = [];
  await ensureBlackHole(cf, accountId, {
    hostname,
    workerName: env.WORKER_NAME,
    databaseId: env.D1_DATABASE_ID,
    followUps,
  });

  if (followUps.length) {
    heading(color.yellow(`Needs a human (${followUps.length})`));
    followUps.forEach((f) => {
      plain(`  · ${f.label}`);
      for (const line of String(f.detail).split('\n')) plain(`    ${color.dim(line)}`);
    });
    closePrompts();
    return 2;
  }

  plain('');
  ok(`https://${hostname}/<anything> is captured`);
  ok(`${color.bold(`<anything>@${hostname}`)} is captured`);
  plain(color.dim('  DNS and the certificate can take a minute. No redeploy is needed.'));
  closePrompts();
  return 0;
}

/**
 * Every subdomain of `zone` with Email Routing enabled on it.
 *
 * There is no endpoint that lists them, so they are read off the records Email
 * Routing manages: enabling a name is exactly what puts an MX set there, so a
 * non-apex name carrying one is a subdomain somebody enabled. Nobody here
 * creates them any more, since they are added in the Cloudflare dashboard, and
 * that is why removal has to go looking rather than consult the table.
 */
async function enabledMailSubdomains(cf, zone) {
  const records = (await cf.listEmailRoutingRecords(zone.id)) || [];
  return [...new Set(
    records
      .filter((r) => r.type === 'MX' && r.name && r.name !== zone.name)
      .map((r) => r.name),
  )].sort();
}

/**
 * Removing a black hole takes the zone's mail subdomains with it, if the
 * operator agrees.
 *
 * They are not collateral: a subdomain enabled for Email Routing has MX records
 * of its own, and the only reason mail to it reaches the catcher is the zone
 * catch-all that this black hole put there. Leave them and every one of them
 * keeps accepting mail into a catch-all that no longer delivers anywhere. The
 * host swallows messages silently, which is the worst of the three possible
 * states (capturing, bouncing, swallowing).
 *
 * Asked rather than assumed. Each is a name someone added by hand, outside this
 * tool, and listing them before touching them is also the only time an operator
 * is shown what a zone actually accumulated.
 */
async function stripMailSubdomains(cf, zone) {
  let names = [];
  try {
    names = await enabledMailSubdomains(cf, zone);
  } catch (err) {
    warn(`could not list the mail subdomains on ${zone.name}: ${err.message}`);
    plain(color.dim(`    Check them by hand at: dashboard → ${zone.name} → Email → Email Routing`));
    plain(color.dim('    → Settings → Subdomains.'));
    return;
  }

  if (!names.length) {
    skip(`no mail subdomains are enabled on ${zone.name}`);
    return;
  }

  plain('');
  plain(`  ${names.length} subdomain${names.length === 1 ? '' : 's'} of ${color.bold(zone.name)} still capture${names.length === 1 ? 's' : ''} mail:`);
  plain('');
  for (const name of names) plain(`      ${color.cyan(`*@${name}`)}`);
  plain('');
  plain(color.dim('  Each has its own locked MX records. Once this black hole is gone they'));
  plain(color.dim('  accept mail that is delivered nowhere.'));
  plain('');

  if (!(await confirm('  Remove their Email Routing entries and MX records too?', true))) {
    skip('left the mail subdomains alone');
    return;
  }

  for (const name of names) {
    try {
      await cf.disableEmailRoutingForName(zone.id, name);
      ok(`removed Email Routing for ${color.bold(name)}, with its MX + SPF records`);
    } catch (err) {
      warn(`could not remove Email Routing for ${name}: ${err.message}`);
      plain(color.dim(`    Remove it by hand at: dashboard → ${zone.name} → Email → Email Routing`));
      plain(color.dim('    → Settings → Subdomains.'));
    }
  }
}

/**
 * A row left over from when a subdomain could be a black hole of its own.
 *
 * `add` refuses these now, so nothing creates one, but a deployment made before
 * that still has them and they have to come back out. The zone-wide teardown
 * above would be wrong here, because it would strip sibling black holes on the
 * same zone, so this touches exactly the one name.
 */
async function removeLegacySubdomain(cf, zone, hostname) {
  let names = [];
  try {
    names = await enabledMailSubdomains(cf, zone);
  } catch {
    names = [];
  }
  if (!names.includes(hostname)) {
    skip(`${hostname} has no Email Routing entry of its own`);
    return;
  }

  plain('');
  warn(`${hostname} still has its own MX records, locked by Email Routing.`);
  plain(color.dim(`    Mail to it is still captured, because the ${zone.name} catch-all covers it.`));
  plain('');
  if (!(await confirm(`  Remove Email Routing for ${color.bold(hostname)} as well?`, true))) {
    skip('left the MX records in place');
    plain(color.dim(`    Remove them later at: dashboard → ${zone.name} → Email → Email Routing`));
    plain(color.dim('    → Settings → Subdomains.'));
    return;
  }
  try {
    await cf.disableEmailRoutingForName(zone.id, hostname);
    ok(`removed Email Routing for ${color.bold(hostname)}, with its MX + SPF records`);
  } catch (err) {
    warn(`could not remove Email Routing for ${hostname}: ${err.message}`);
    plain(color.dim(`    Remove it by hand at: dashboard → ${zone.name} → Email → Email Routing`));
    plain(color.dim('    → Settings → Subdomains.'));
  }
}

/**
 * The primary black hole cannot be removed, and the reason is not only that it
 * would be unwise.
 *
 * It would not stick. BLACK_HOLE_HOSTNAME still names it afterwards, so the next
 * `./a51 setup`, the documented way to converge a deployment and the thing you
 * run after almost any change, binds it and re-inserts the row.
 * `./a51 doctor --fix` does the
 * same. A command whose effect the next routine command silently undoes is worse
 * than one that refuses: the operator believes something happened.
 *
 * And the zone stays load-bearing regardless. The dashboard and Autopilot answer
 * on subdomains of it, and the zone-scoped catch-all that makes mail capture work
 * anywhere in this deployment is attached to it. Dropping the apex row and its
 * Custom Domain would stop HTTP capture on one hostname while leaving every one
 * of those in place: not a teardown, just an inconsistency.
 *
 * So the two things an operator might actually mean are named instead, because
 * both are supported and neither is this command. Moving the deployment is a
 * .env edit plus a converge, after which this host is an ordinary black hole and
 * `remove` takes it. Tearing it down is `./a51 destroy`, which asks about Email
 * Routing, the workers and the data properly.
 */
function assertNotPrimary(hostname, env) {
  if (!isPrimary(hostname, env)) return;
  die([
    `${hostname} is the primary black hole and cannot be removed.`,
    '',
    '  It is the zone AREA 51 itself runs on:',
    '',
    `      ${env.DASHBOARD_HOSTNAME || `area51.${hostname}`} is the dashboard`,
    `      ${env.AUTOPILOT_HOSTNAME || `autopilot.${hostname}`} is Autopilot`,
    '',
    '  Both are subdomains of it, and the zone-wide catch-all attached to it is',
    '  what makes mail capture work here at all.',
    '',
    '  Removing it would also not stick: BLACK_HOLE_HOSTNAME in .env still names',
    '  it, so the next `./a51 setup` or `./a51 doctor --fix` puts it straight back.',
    '',
    '  To move AREA 51 onto a different zone, point .env at it and converge:',
    '    CLOUDFLARE_ZONE, BLACK_HOLE_HOSTNAME, DASHBOARD_HOSTNAME, AUTOPILOT_HOSTNAME',
    '    ./a51 setup',
    `  ${hostname} becomes an ordinary black hole then, and this command will take it.`,
    '',
    '  To tear the whole deployment down instead:',
    '    ./a51 destroy',
  ].join('\n'));
}

async function remove(cf, accountId, env, hostname) {
  if (!hostname) die('usage: ./a51 black-holes remove <host>');
  assertNotPrimary(hostname, env);

  step(`Remove black hole ${hostname}`);

  let rows = [];
  try {
    rows = await cf.d1Rows(accountId, env.D1_DATABASE_ID, 'SELECT domain FROM domains WHERE domain = ?', [hostname]);
  } catch (err) {
    die(`could not read the domains table: ${err.message}`);
  }

  const zone = await zoneForHostname(cf, accountId, hostname);

  if (!(await confirm(`  Detach ${hostname} from ${env.WORKER_NAME} and drop its row?`, false))) {
    plain('  Canceled.');
    closePrompts();
    return 1;
  }

  // Order: Cloudflare state first, the D1 row last.
  //
  // Same reasoning as the R2-before-D1 rule in CLAUDE.md. The row is what the
  // dashboard, Autopilot and `doctor` can all see; the Custom Domain and the
  // mail entries are not. If this run dies halfway, a host that still has
  // Cloudflare state and still has a row is a black hole that reports itself and
  // can simply be removed again. A host whose row went first would have left
  // bindings behind with nothing naming them.
  if (zone) {
    if (zone.name === hostname) await stripMailSubdomains(cf, zone);
    else await removeLegacySubdomain(cf, zone, hostname);
  } else {
    warn(`no zone visible for ${hostname}, so its mail records were not checked`);
  }

  try {
    const bound = (await cf.listWorkerDomains(accountId, env.WORKER_NAME)) || [];
    const match = bound.find((d) => d.hostname === hostname);
    if (match) {
      await cf.detachWorkerDomain(accountId, match.id);
      ok('detached the Custom Domain from the worker');
    } else {
      skip('no Custom Domain binding to detach');
    }
  } catch (err) {
    warn(`could not detach the Custom Domain: ${err.message}`);
  }

  await cf.d1Query(accountId, env.D1_DATABASE_ID, 'DELETE FROM domains WHERE domain = ?', [hostname]);
  if (rows.length) ok('removed from the domains table');
  else skip('no row in the domains table');

  // Email Routing on the ZONE is deliberately left on, and this is the one piece
  // of the teardown that is not offered here. Disabling it is a decision about
  // the whole zone rather than about this black hole, it unlocks and deletes the
  // apex MX, and `./a51 destroy` already asks the question properly as part of a
  // full teardown.
  if (zone && zone.name === hostname) {
    plain('');
    warn(`Email Routing on ${zone.name} was left enabled. It is a zone-wide setting.`);
    plain(color.dim(`    Disable it at: dashboard → ${zone.name} → Email → Email Routing, if nothing`));
    plain(color.dim('    on that zone still needs mail capture.'));
    plain(color.dim('    `./a51 destroy` offers to do it as part of a full teardown.'));
  }

  plain('');
  plain(color.dim('  Captured requests and emails from this host are kept. Purge them with `./a51 purge`.'));
  closePrompts();
  return 0;
}
