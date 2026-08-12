// `./a51 domains` — manage black holes.
//
// A black hole is three things at once: a hostname bound to the Black Holes
// worker (for HTTP), a zone catch-all pointed at that worker (for mail), and a
// row in the D1 `domains` table (so the dashboard and Autopilot know it exists).
// This command keeps all three in step.

import { loadContext, parseRoles, zoneForHostname } from '../lib/context.mjs';
import { step, ok, warn, skip, plain, heading, color, resetSteps, die, info } from '../lib/log.mjs';
import { confirm, closePrompts } from '../lib/prompt.mjs';
import { ensureBlackHole } from '../lib/provision.mjs';

export async function run(args) {
  const positional = args.filter((a) => !a.startsWith('--'));
  const action = positional[0] || 'list';

  const { env, cf, accountId } = await loadContext({ needDatabase: true });
  resetSteps();

  if (action === 'list') return list(cf, accountId, env);
  if (action === 'add') return add(cf, accountId, env, positional[1], positional[2]);
  if (action === 'remove') return remove(cf, accountId, env, positional[1]);

  die(`unknown action "${action}".\n  Usage: ./a51 domains [list | add <host> [http,mail] | remove <host>]`);
  return 1;
}

async function list(cf, accountId, env) {
  heading('Black holes');
  const rows = await cf.d1Rows(accountId, env.D1_DATABASE_ID, 'SELECT domain, roles FROM domains ORDER BY domain');
  if (!rows.length) {
    plain('');
    warn('none configured. Add one with `./a51 domains add <host> http,mail`');
    return 0;
  }

  let bound = [];
  try {
    bound = (await cf.listWorkerDomains(accountId, env.WORKER_NAME)) || [];
  } catch {
    // Listing custom domains is a nice-to-have here; the table is the source of truth.
  }
  const boundHosts = new Set(bound.map((d) => d.hostname));

  plain('');
  for (const row of rows) {
    let roles = [];
    try {
      roles = JSON.parse(row.roles);
    } catch {
      roles = [];
    }
    const http = roles.includes('http');
    const attached = boundHosts.has(row.domain);
    const flag = http && !attached ? color.yellow('  ← not bound to the worker') : '';
    plain(`  ${color.bold(row.domain.padEnd(34))} ${roles.join(', ').padEnd(12)}${flag}`);
  }
  plain('');
  info(color.dim(`worker: ${env.WORKER_NAME} · database: ${env.D1_DATABASE_NAME}`));
  return 0;
}

async function add(cf, accountId, env, hostname, rolesArg) {
  if (!hostname) die('usage: ./a51 domains add <hostname> [http,mail]');
  const roles = parseRoles(rolesArg || 'http,mail');

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
    heading(color.yellow('Manual follow-ups'));
    followUps.forEach((f) => {
      plain(`  · ${f.label}`);
      for (const line of String(f.detail).split('\n')) plain(`    ${color.dim(line)}`);
    });
    return 2;
  }

  plain('');
  ok(`https://${hostname} is live${roles.includes('mail') ? `, and any address @${hostname} is a catch-all inbox` : ''}`);
  plain(color.dim('  DNS and the certificate can take a minute. No redeploy is needed.'));
  return 0;
}

async function remove(cf, accountId, env, hostname) {
  if (!hostname) die('usage: ./a51 domains remove <hostname>');

  step(`Remove black hole ${hostname}`);
  if (!(await confirm(`  Detach ${hostname} from ${env.WORKER_NAME} and drop its row?`, false))) {
    plain('  Cancelled.');
    closePrompts();
    return 1;
  }

  await cf.d1Query(accountId, env.D1_DATABASE_ID, 'DELETE FROM domains WHERE domain = ?', [hostname]);
  ok('removed from the domains table');

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

  const zone = await zoneForHostname(cf, accountId, hostname);
  if (zone) {
    warn(`Email Routing on ${zone.name} was left untouched — it is a zone-wide setting.`);
    plain(color.dim(`    Disable it at: dashboard → ${zone.name} → Email → Email Routing, if no other`));
    plain(color.dim('    black hole on that zone still needs mail capture.'));
  }

  plain('');
  plain(color.dim('  Captured requests and emails from this host are kept. Purge them with `./a51 purge`.'));
  closePrompts();
  return 0;
}
