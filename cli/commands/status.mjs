// `./a51 status` — a one-screen summary of what is deployed and where.
//
// Deliberately no row counts. D1 bills per row read, so `SELECT COUNT(*)` over
// the capture tables costs real reads for a number nobody acts on. The
// dashboard makes the same trade (docs/decisions.md).

import { loadContext, parseRoles } from '../lib/context.mjs';
import { heading, plain, color, info } from '../lib/log.mjs';
import { parseList } from '../lib/env.mjs';

const row = (label, value) => plain(`  ${color.dim(label.padEnd(16))} ${value}`);

export async function run() {
  const { env, cf, accountId } = await loadContext();

  heading('AREA 51');
  plain('');
  row('account', accountId);
  row('zone', env.CLOUDFLARE_ZONE || color.dim('(not set)'));
  row('database', `${env.D1_DATABASE_NAME} ${color.dim(env.D1_DATABASE_ID || '(no id)')}`);
  row('buckets', `${env.R2_BUCKET_NAME}, ${env.R2_FILES_BUCKET_NAME}`);

  plain(`\n${color.bold('  Endpoints')}`);
  row('dashboard', color.cyan(`https://${env.DASHBOARD_HOSTNAME || '(unset)'}`));
  row('autopilot', color.cyan(`https://${env.AUTOPILOT_HOSTNAME || '(unset)'}/mcp`));

  plain(`\n${color.bold('  Black holes')}`);
  if (env.D1_DATABASE_ID) {
    try {
      const rows = await cf.d1Rows(accountId, env.D1_DATABASE_ID, 'SELECT domain, roles FROM domains ORDER BY domain');
      if (!rows.length) row('', color.yellow('none configured — ./a51 black-hole add <host> http,mail'));
      for (const r of rows) {
        let roles = [];
        try {
          roles = parseRoles(JSON.parse(r.roles).join(','), { fallback: [] });
        } catch {
          roles = [];
        }
        row('', `${color.cyan(`https://${r.domain}`)} ${color.dim(`[${roles.join(', ')}]`)}`);
      }
    } catch (err) {
      row('', color.red(`could not read the domains table: ${err.message}`));
    }
  } else {
    row('', color.yellow('no database yet — run ./a51 setup'));
  }

  plain(`\n${color.bold('  Workers')}`);
  for (const [label, name] of [['black holes', env.WORKER_NAME], ['autopilot', env.AGENT_WORKER_NAME], ['cleanup', env.CLEANUP_WORKER_NAME]]) {
    if (!name) continue;
    const script = await cf.getWorkerSettings(accountId, name);
    row(label, script ? `${name} ${color.green('deployed')}` : `${name} ${color.red('not deployed')}`);
  }

  plain(`\n${color.bold('  Retention')}`);
  row('cron', `${env.CLEANUP_CRON || '(unset)'} UTC`);
  row('requests', `keep newest ${env.CLEANUP_REQUESTS_KEEP || '?'} rows`);
  row('emails', `delete after ${env.CLEANUP_EMAIL_MAX_AGE_DAYS || '?'} days (starred kept forever)`);

  plain(`\n${color.bold('  Access')}`);
  const allowed = parseList(env.ALLOWED_EMAILS);
  row('allow-list', allowed.length ? allowed.join(', ') : color.yellow('empty — the dashboard may be public'));
  row('session', env.ACCESS_SESSION_DURATION || '(default)');

  plain('');
  info(color.dim('`./a51 doctor` verifies all of the above against Cloudflare and probes the live hosts.'));
  plain('');
  return 0;
}
