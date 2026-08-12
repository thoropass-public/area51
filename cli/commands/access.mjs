// `./a51 access [email|domain ...]` — (re)configure Cloudflare Access in front
// of the dashboard. Run it after changing who should have access; it replaces
// the application's allow policy with exactly the identities given.

import { loadContext } from '../lib/context.mjs';
import { parseList, saveEnv } from '../lib/env.mjs';
import { heading, plain, ok, warn, color, die } from '../lib/log.mjs';
import { ensureAccess } from '../lib/provision.mjs';
import { closePrompts } from '../lib/prompt.mjs';

export async function run(args) {
  const positional = args.filter((a) => !a.startsWith('--'));
  const { env, cf, accountId } = await loadContext();

  const allowed = positional.length ? parseList(positional.join(',')) : parseList(env.ALLOWED_EMAILS);
  if (!allowed.length) {
    die('no identities given and ALLOWED_EMAILS is empty.\n  Usage: ./a51 access you@example.com,example.com');
  }
  if (!env.DASHBOARD_HOSTNAME) die('DASHBOARD_HOSTNAME is not set in .env. Run `./a51 setup` first.');

  heading(`Cloudflare Access → https://${env.DASHBOARD_HOSTNAME}`);
  plain('');

  const followUps = [];
  await ensureAccess(cf, accountId, {
    hostname: env.DASHBOARD_HOSTNAME,
    allowed,
    sessionDuration: env.ACCESS_SESSION_DURATION || '24h',
    teamName: env.ACCESS_TEAM_NAME || env.CLOUDFLARE_ZONE?.replace(/\./g, '-') || 'area51',
    followUps,
  });

  if (positional.length) {
    saveEnv({ ALLOWED_EMAILS: allowed.join(',') });
    ok('updated ALLOWED_EMAILS in .env');
  }

  if (followUps.length) {
    plain('');
    warn('some steps need a hand:');
    followUps.forEach((f) => {
      plain(`  · ${f.label}`);
      for (const line of String(f.detail).split('\n')) plain(`    ${color.dim(line)}`);
    });
    closePrompts();
    return 2;
  }

  plain('');
  plain(color.dim('  Everyone on the list gets a one-time PIN by email when they open the dashboard.'));
  plain(color.dim('  Existing sessions keep working until they expire — revoke them in Zero Trust if needed.'));
  plain('');
  closePrompts();
  return 0;
}
