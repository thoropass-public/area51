// `./a51 black-holes` manages black holes.
//
// A black hole is up to three things at once: a hostname bound to the Black Holes
// worker (for HTTP), Email Routing enabled for that name with the zone catch-all
// pointed at the worker (for mail), and a row in the D1 `domains` table (so the
// dashboard and Autopilot know it exists). This command keeps them in step.
//
// The D1 table is still called `domains`; only the command was renamed. Renaming
// the table would mean a migration plus edits in all four workers and the
// dashboard frontend, for nothing an operator can see.

import { loadContext, parseRoles, zoneForHostname } from '../lib/context.mjs';
import { step, ok, warn, skip, plain, heading, color, resetSteps, die, info, table, sym, hint } from '../lib/log.mjs';
import { confirm, select, typeToConfirm, closePrompts } from '../lib/prompt.mjs';
import { ensureBlackHole, inspectZoneTakeover, describeTakeover } from '../lib/provision.mjs';

const USAGE = './a51 black-holes [list | add <host> [http,mail] | remove <host>]';

export async function run(args) {
  const positional = args.filter((a) => !a.startsWith('--'));
  const action = positional[0] || 'list';

  const { env, cf, accountId } = await loadContext({ needDatabase: true });
  resetSteps();

  if (action === 'list') return list(cf, accountId, env);
  if (action === 'add') return add(cf, accountId, env, positional[1], positional[2]);
  if (action === 'remove') return remove(cf, accountId, env, positional[1]);

  die(`unknown action "${action}".\n  Usage: ${USAGE}`);
  return 1;
}

/**
 * The roles for one `domains` row. The column holds a JSON array. A value that
 * will not parse counts as no roles, rather than throwing.
 */
function rolesOf(row) {
  try {
    const parsed = JSON.parse(row && row.roles);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function list(cf, accountId, env) {
  heading(`Black holes ${color.dim(`— worker ${env.WORKER_NAME}`)}`);
  const rows = await cf.d1Rows(accountId, env.D1_DATABASE_ID, 'SELECT domain, roles FROM domains ORDER BY domain');
  if (!rows.length) {
    plain('');
    warn('none configured');
    hint('Add one with `./a51 black-holes add <host>`');
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

  const out = [[color.dim('HOST'), color.dim('ROLES'), color.dim('CAPTURES'), color.dim('BOUND')]];
  let unbound = 0;
  for (const row of rows) {
    const roles = rolesOf(row);
    const wantsHttp = roles.includes('http');
    const attached = boundHosts.has(row.domain);

    const surfaces = [];
    if (wantsHttp) surfaces.push(`https://${row.domain}/*`);
    if (roles.includes('mail')) surfaces.push(`*@${row.domain}`);

    let state;
    if (!wantsHttp) state = color.dim('n/a');
    else if (!boundKnown) state = color.dim('?');
    else if (attached) state = sym.ok;
    else { state = sym.fail; unbound += 1; }

    out.push([
      color.cyan(row.domain),
      roles.length ? roles.join(', ') : color.yellow('none'),
      color.dim(surfaces.join('  ') || '—'),
      state,
    ]);
  }

  plain('');
  table(out);
  plain('');

  if (unbound) {
    warn(`${unbound} host${unbound === 1 ? '' : 's'} with the http role ${unbound === 1 ? 'is' : 'are'} not bound to ${env.WORKER_NAME}`);
    hint('Fix with `./a51 doctor --fix`, or re-add the host.');
  } else if (!boundKnown) {
    skip('could not read the worker\'s Custom Domains — BOUND is unknown (needs Zone · Workers Routes:Edit)');
  }
  info(color.dim(`${rows.length} black hole${rows.length === 1 ? '' : 's'} · database ${env.D1_DATABASE_NAME}`));
  plain('');
  return 0;
}

/**
 * What should this host capture? Asked only when the roles argument is omitted,
 * so `add <host> http,mail` still works without a prompt for anyone who already
 * knows what they want. Both roles is listed first, since it is the usual answer.
 */
async function askRoles(hostname) {
  const choice = await select(`What should ${hostname} capture?`, [
    { value: 'http,mail', label: 'HTTP and email', hint: `https://${hostname}/… and <anything>@${hostname}` },
    { value: 'http', label: 'HTTP only', hint: 'no mail records are touched' },
    { value: 'mail', label: 'Email only', hint: `<anything>@${hostname}; nothing is served over HTTP` },
  ], { auto: false });
  return parseRoles(choice);
}

/**
 * A subdomain can only capture mail if its own zone apex is already a mail black
 * hole. That is mechanics, not policy: Email Routing is enabled per name, but the
 * catch-all that actually delivers to the worker is zone-scoped (its API takes no
 * subdomain). The catch-all covers the apex and every enabled subdomain, but it
 * only exists once the apex is a mail black hole.
 *
 * Enabling the subdomain first would add and lock MX records whose mail has
 * nowhere to go: a black hole that accepts every message and drops it, which is
 * worse than refusing here.
 */
async function assertApexCapturesMail(cf, accountId, env, zone, hostname, roles) {
  let rows = [];
  try {
    rows = await cf.d1Rows(accountId, env.D1_DATABASE_ID, 'SELECT roles FROM domains WHERE domain = ?', [zone.name]);
  } catch (err) {
    die(`could not read the domains table to check ${zone.name}: ${err.message}`);
  }

  if (rolesOf(rows[0]).includes('mail')) return;

  die([
    `${hostname} cannot capture mail until ${zone.name} does.`,
    '',
    `  Email Routing is enabled per name, but the catch-all that delivers mail to`,
    `  ${env.WORKER_NAME} is zone-wide. It covers ${zone.name} and every enabled`,
    `  subdomain of it — and it only exists once ${zone.name} itself is a mail`,
    `  black hole. Enabling ${hostname} first would lock MX records whose mail`,
    `  has nowhere to go.`,
    '',
    '  Add the apex first, then this host:',
    `    ./a51 black-holes add ${zone.name} http,mail`,
    `    ./a51 black-holes add ${hostname} ${roles.join(',')}`,
  ].join('\n'));
}

/**
 * Show what this add changes, and take consent for the destructive part.
 *
 * An apex mail add hands the zone's inbound mail to the catcher, and Email
 * Routing writes and LOCKS its MX to do it. That is not something to discover
 * afterwards, so it always asks. A subdomain add only touches records at that one
 * name, so it asks only when something is actually in the way.
 *
 * Either way, when records will really be lost they are named and the gate
 * becomes a typed confirmation rather than a y/N, so it cannot be cleared by a
 * reflexive Enter.
 */
async function confirmAdd(cf, zone, hostname, roles, isApex) {
  const doomed = describeTakeover(await inspectZoneTakeover(cf, zone, hostname));
  const wantsMail = roles.includes('mail');

  plain('');
  plain(`  ${color.bold(hostname)} ${color.dim(`— ${roles.join(', ')}`)}`);
  plain('');
  if (roles.includes('http')) plain(`    ${color.dim('HTTP callbacks ')}  https://${hostname}/<anything>`);
  if (wantsMail) plain(`    ${color.dim('Email callbacks')}  <anything>@${hostname}`);
  plain('');

  if (wantsMail) {
    if (isApex) {
      plain(`  Email Routing will add and ${color.bold('LOCK')} MX + SPF records for ${zone.name},`);
      plain('  taking over inbound mail for the whole zone.');
    } else {
      plain(`  Email Routing will add and ${color.bold('LOCK')} MX + SPF records for ${hostname}.`);
      plain(`  Mail for the rest of ${zone.name} is unaffected.`);
    }
    plain('');
  }

  if (doomed.length) {
    warn('these records will be replaced or overridden:');
    plain('');
    for (const line of doomed) plain(`      ${color.red(line)}`);
    plain('');
    return typeToConfirm('TAKEOVER', `${hostname} already has records that this replaces.`);
  }

  // Nothing to lose. The zone-wide MX lock still deserves a beat; a clean
  // subdomain does not, so it proceeds without a prompt.
  if (isApex && wantsMail) return confirm(`  Add ${color.bold(hostname)} as a black hole?`, true);
  return true;
}

async function add(cf, accountId, env, hostname, rolesArg) {
  if (!hostname) die(`usage: ./a51 black-holes add <hostname> [http,mail]`);

  // The zone is resolved up front rather than inside ensureBlackHole, because
  // every check below needs to know whether this hostname is the apex.
  const zone = await zoneForHostname(cf, accountId, hostname);
  if (!zone) {
    die(
      `no Cloudflare zone found for ${hostname}.\n` +
      '  Add the domain to this Cloudflare account (dashboard → Add a site), then re-run.\n' +
      '  If the zone does exist, the API token is missing Zone:Read for it.',
    );
  }
  const isApex = hostname === zone.name;

  const roles = rolesArg ? parseRoles(rolesArg) : await askRoles(hostname);

  if (roles.includes('mail') && !isApex) {
    await assertApexCapturesMail(cf, accountId, env, zone, hostname, roles);
  }

  if (!(await confirmAdd(cf, zone, hostname, roles, isApex))) {
    plain('\n  Canceled. Nothing was changed.');
    closePrompts();
    return 1;
  }

  step(`Add black hole ${hostname} [${roles.join(', ')}]`);
  const followUps = [];
  await ensureBlackHole(cf, accountId, {
    hostname,
    roles,
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
  if (roles.includes('http')) ok(`https://${hostname}/<anything> is captured`);
  if (roles.includes('mail')) {
    ok(`${color.bold(`<anything>@${hostname}`)} is captured`);
    if (!isApex) {
      plain(color.dim(`      Delivered by the zone-wide ${zone.name} catch-all, which covers the apex`));
      plain(color.dim('      and every subdomain enabled for Email Routing.'));
    }
  }
  plain(color.dim('  DNS and the certificate can take a minute. No redeploy is needed.'));
  closePrompts();
  return 0;
}

async function remove(cf, accountId, env, hostname) {
  if (!hostname) die('usage: ./a51 black-holes remove <hostname>');

  step(`Remove black hole ${hostname}`);

  // Read the row before deleting it. What a removal leaves behind depends on
  // which roles the host had. An http-only host leaves no mail behind, and
  // warning about MX records that were never there only sends the operator
  // looking for something to undo.
  let rows = [];
  try {
    rows = await cf.d1Rows(accountId, env.D1_DATABASE_ID, 'SELECT roles FROM domains WHERE domain = ?', [hostname]);
  } catch (err) {
    die(`could not read the domains table: ${err.message}`);
  }
  const roles = rolesOf(rows[0]);

  if (!(await confirm(`  Detach ${hostname} from ${env.WORKER_NAME} and drop its row?`, false))) {
    plain('  Canceled.');
    closePrompts();
    return 1;
  }

  await cf.d1Query(accountId, env.D1_DATABASE_ID, 'DELETE FROM domains WHERE domain = ?', [hostname]);
  if (rows.length) ok('removed from the domains table');
  else skip('no row in the domains table');

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

  // Mail is deliberately left alone, but WHAT is left behind differs, and the
  // subdomain case has no API to undo it: `DELETE .../email/routing/dns` disables
  // routing for the whole zone, so there is no way to retract one name's MX
  // records without taking every other black hole on that zone down with it.
  //
  // A host that never captured mail has none of this to undo, so the notice only
  // prints for the mail role. Roles come from the `domains` table, which is
  // where the rest of the tool looks to decide what a black hole is. If there is
  // no row, nothing on record says the host ever captured mail, so nothing is
  // printed.
  const zone = roles.includes('mail') ? await zoneForHostname(cf, accountId, hostname) : null;
  if (zone && zone.name !== hostname) {
    warn(`${hostname} keeps its own MX records, still locked by Email Routing.`);
    plain(color.dim('    Mail sent to it is still accepted and still captured, because the zone'));
    plain(color.dim(`    catch-all covers it. There is no per-name disable in the API — remove it`));
    plain(color.dim(`    at: dashboard → ${zone.name} → Email → Email Routing → Settings → Subdomains.`));
  } else if (zone) {
    warn(`Email Routing on ${zone.name} was left untouched — it is a zone-wide setting.`);
    plain(color.dim(`    Disable it at: dashboard → ${zone.name} → Email → Email Routing, if no other`));
    plain(color.dim('    black hole on that zone still needs mail capture.'));
    plain(color.dim('    `./a51 destroy` offers to do it as part of a full teardown.'));
  }

  plain('');
  plain(color.dim('  Captured requests and emails from this host are kept. Purge them with `./a51 purge`.'));
  closePrompts();
  return 0;
}
