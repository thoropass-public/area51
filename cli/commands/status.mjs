// `./a51 status` — a one-screen answer to "what is deployed, and where".
//
// Read-only, and deliberately shallow: it reports what `.env` says plus whether
// each Worker exists. It does not verify bindings, DNS, routing or policies —
// that is `./a51 doctor`, which costs a dozen API calls and probes the live
// hosts. Keeping the two apart means `status` is the cheap glance and `doctor`
// is the real check, and the closing line says so rather than leaving a reader
// to guess which one they wanted.
//
// Deliberately no row counts. D1 bills per row read, so `SELECT COUNT(*)` over
// the capture tables costs real reads for a number nobody acts on. The dashboard
// makes the same trade (docs/decisions.md).

import { loadContext, parseRoles } from '../lib/context.mjs';
import { heading, section, plain, color, kv, table, info, sym } from '../lib/log.mjs';
import { parseList } from '../lib/env.mjs';

const unset = color.dim('(not set)');

export async function run() {
  const { env, cf, accountId } = await loadContext();

  heading(`AREA 51 ${color.dim('— deployment status')}`);

  section('Account');
  kv('account', accountId);
  kv('zone', env.CLOUDFLARE_ZONE || unset);

  section('Endpoints');
  kv('AREA 51', env.DASHBOARD_HOSTNAME ? color.cyan(`https://${env.DASHBOARD_HOSTNAME}`) : unset);
  kv('Autopilot', env.AUTOPILOT_HOSTNAME ? color.cyan(`https://${env.AUTOPILOT_HOSTNAME}/mcp`) : unset);

  section('Black holes');
  await printBlackHoles(cf, accountId, env);

  section('Workers');
  await printWorkers(cf, accountId, env);

  section('Storage');
  kv('database', `${env.D1_DATABASE_NAME || unset} ${color.dim(env.D1_DATABASE_ID || '(no id)')}`);
  kv('email', env.R2_BUCKET_NAME || unset);
  kv('uploads', env.R2_FILES_BUCKET_NAME || unset);

  section('Retention');
  kv('schedule', `${env.CLEANUP_CRON || unset} ${color.dim('UTC')}`);
  kv('requests', `keep newest ${env.CLEANUP_REQUESTS_KEEP || '?'} rows`);
  kv('emails', `delete after ${env.CLEANUP_EMAIL_MAX_AGE_DAYS || '?'} days ${color.dim('(starred kept forever)')}`);

  section('Dashboard access');
  const allowed = parseList(env.ALLOWED_EMAILS);
  kv('allow-list', allowed.length ? allowed.join(', ') : color.yellow('empty — the dashboard may be public'));
  kv('session', env.ACCESS_SESSION_DURATION || color.dim('(default)'));

  plain('');
  info(color.dim('This reads .env and checks which Workers exist. To verify bindings, DNS,'));
  info(color.dim('routing and policies against Cloudflare — and probe the live hosts — run'));
  info(color.dim('`./a51 doctor`.'));
  plain('');
  return 0;
}

/**
 * The `domains` table, as a table. Each row shows the host, its roles, and the
 * two callback surfaces it actually offers — so the difference between an
 * http-only catcher and one that also takes mail is visible without decoding
 * the roles column.
 */
async function printBlackHoles(cf, accountId, env) {
  if (!env.D1_DATABASE_ID) {
    plain(`  ${sym.warn} ${color.yellow('no database yet — run ./a51 setup')}`);
    return;
  }

  let rows = [];
  try {
    rows = await cf.d1Rows(accountId, env.D1_DATABASE_ID, 'SELECT domain, roles FROM domains ORDER BY domain');
  } catch (err) {
    plain(`  ${sym.fail} ${color.red(`could not read the domains table: ${err.message}`)}`);
    return;
  }
  if (!rows.length) {
    plain(`  ${sym.warn} ${color.yellow('none configured')} ${color.dim('— ./a51 black-holes add <host>')}`);
    return;
  }

  const out = [[color.dim('HOST'), color.dim('ROLES'), color.dim('CAPTURES')]];
  for (const row of rows) {
    let roles = [];
    try {
      roles = parseRoles(JSON.parse(row.roles).join(','), { fallback: [] });
    } catch {
      roles = [];
    }
    const surfaces = [];
    if (roles.includes('http')) surfaces.push(`https://${row.domain}/*`);
    if (roles.includes('mail')) surfaces.push(`*@${row.domain}`);
    out.push([
      color.cyan(row.domain),
      roles.length ? roles.join(', ') : color.yellow('none'),
      color.dim(surfaces.join('  ') || '—'),
    ]);
  }
  table(out);
}

/** Which Workers exist. Existence only — `doctor` checks their bindings. */
async function printWorkers(cf, accountId, env) {
  const targets = [
    ['black holes', env.WORKER_NAME],
    ['autopilot', env.AGENT_WORKER_NAME],
    ['cleanup', env.CLEANUP_WORKER_NAME],
  ];
  for (const [label, name] of targets) {
    if (!name) {
      kv(label, unset);
      continue;
    }
    let script = null;
    try {
      script = await cf.getWorkerSettings(accountId, name);
    } catch (err) {
      kv(label, `${name} ${color.yellow(`unreadable (${err.message})`)}`);
      continue;
    }
    kv(label, `${name} ${script ? color.green('deployed') : color.red('not deployed')}`);
  }
}
