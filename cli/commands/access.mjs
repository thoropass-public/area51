// `./a51 access` — edit who may open the dashboard (Cloudflare Access).
//
// Shapes:
//   ./a51 access [list]                        print the current allow-list (read-only)
//   ./a51 access add <email|domain>[,...]      add entries, keep the existing ones
//   ./a51 access remove <email|domain>[,...]   drop entries, keep the rest
//   ./a51 access apply                         re-apply ALLOWED_EMAILS from .env
//
// Subcommands, not flags, so this reads the same way as `./a51 black-holes`:
// both manage a list of things, and a reader who learns one should not be
// surprised by the other.
//
// There is deliberately NO "replace the whole list" form: add / remove express
// every change without the footgun of silently wiping entries you forgot to
// re-type. To set the list wholesale, edit ALLOWED_EMAILS in .env and run
// `./a51 access apply`.
//
// Entries are full addresses (you@example.com) or bare domains (example.com =
// anyone with that email domain). Everything is normalized to lowercase, since
// email addresses and domains are case-insensitive. The resulting list is pushed
// to the Access application AND written back to ALLOWED_EMAILS in .env.

import { loadContext } from '../lib/context.mjs';
import { loadEnv, parseList, saveEnv } from '../lib/env.mjs';
import { heading, plain, ok, warn, color, die } from '../lib/log.mjs';
import { ensureAccess } from '../lib/provision.mjs';
import { closePrompts } from '../lib/prompt.mjs';

/** Split a raw value into trimmed, de-duplicated, lowercased entries. */
function normList(raw) {
  return [...new Set(parseList(raw).map((s) => s.toLowerCase()))];
}

const USAGE = [
  './a51 access [list]                        show the allow-list (read-only)',
  '  ./a51 access add <email|domain>[,...]      add entries, keep the rest',
  '  ./a51 access remove <email|domain>[,...]   drop entries, keep the rest',
  '  ./a51 access apply                         re-apply ALLOWED_EMAILS from .env',
].join('\n');

export async function run(args) {
  // Flags (--yes and friends) are handled globally; everything else positional.
  const positional = args.filter((a) => !a.startsWith('-'));
  const action = positional[0] || 'list';
  const values = normList(positional.slice(1).join(','));

  if (action === 'list') return showList();
  if (action === 'add' || action === 'remove') {
    if (!values.length) {
      die(`\`access ${action}\` needs at least one entry.\n  e.g. ./a51 access ${action} new@gmail.com,example.com`);
    }
    return applyList({
      add: action === 'add' ? values : [],
      remove: action === 'remove' ? values : [],
    });
  }
  if (action === 'apply') {
    if (values.length) {
      die([
        `\`access apply\` takes no arguments (got "${values[0]}").`,
        'It re-applies ALLOWED_EMAILS from .env as-is. To change the list:',
        '  ./a51 access add new@gmail.com',
        '  ./a51 access remove old@gmail.com',
      ].join('\n'));
    }
    return applyList({ add: [], remove: [] });
  }

  die(`unknown action "${action}".\n  Usage: ${USAGE}`);
  return 1;
}

/** `list` is a pure read of .env — no token, no network, no changes. */
function showList() {
  const env = loadEnv();
  const list = normList(env.ALLOWED_EMAILS);
  heading('Cloudflare Access — allow-list');
  plain('');
  if (!list.length) {
    warn('ALLOWED_EMAILS is empty — no allow-list is configured (the dashboard would be public).');
  } else {
    for (const e of list) plain(`  • ${e}`);
  }
  plain('');
  plain(color.dim(`  ${list.length} ${list.length === 1 ? 'entry' : 'entries'} · edit with \`access add\` / \`access remove\` · guards ${env.DASHBOARD_HOSTNAME || '(DASHBOARD_HOSTNAME unset)'}`));
  plain('');
  return 0;
}

async function applyList({ add, remove }) {
  const incremental = add.length > 0 || remove.length > 0;

  const { env, cf, accountId } = await loadContext();
  if (!env.DASHBOARD_HOSTNAME) die('DASHBOARD_HOSTNAME is not set in .env. Run `./a51 setup` first.');

  const current = normList(env.ALLOWED_EMAILS);
  let allowed;
  const report = [];

  if (incremental) {
    const set = new Set(current);
    // Remove first, then add, so an entry named in both ends up present.
    const removed = remove.filter((e) => set.has(e));
    const missing = remove.filter((e) => !set.has(e));
    for (const e of remove) set.delete(e);
    const added = add.filter((e) => !set.has(e));
    const already = add.filter((e) => set.has(e));
    for (const e of add) set.add(e);
    allowed = [...set];

    if (added.length) report.push(['ok', `added: ${added.join(', ')}`]);
    if (already.length) report.push(['dim', `already on the list: ${already.join(', ')}`]);
    if (removed.length) report.push(['ok', `removed: ${removed.join(', ')}`]);
    if (missing.length) report.push(['warn', `not on the list (nothing to remove): ${missing.join(', ')}`]);
  } else {
    allowed = current;                          // bare re-apply (reads .env)
  }

  if (!allowed.length) {
    die('that would leave the allow-list empty — anyone who finds the dashboard could read it.\n  Refusing. To intentionally make it public, run `./a51 setup --no-access`.');
  }

  heading(`Cloudflare Access → https://${env.DASHBOARD_HOSTNAME}`);
  plain('');
  for (const [kind, msg] of report) {
    if (kind === 'ok') ok(msg);
    else if (kind === 'warn') warn(msg);
    else plain(`  ${color.dim(msg)}`);
  }
  if (report.length) plain('');
  plain(`  Allow-list is now: ${color.bold(allowed.join(', '))}`);
  plain('');

  const followUps = [];
  await ensureAccess(cf, accountId, {
    hostname: env.DASHBOARD_HOSTNAME,
    allowed,
    sessionDuration: env.ACCESS_SESSION_DURATION || '24h',
    teamName: env.ACCESS_TEAM_NAME || env.CLOUDFLARE_ZONE?.replace(/\./g, '-') || 'area51',
    pagesProjectName: env.PAGES_PROJECT_NAME,
    followUps,
  });

  // Persist only when add/remove changed the list. A bare `apply` doesn't
  // rewrite .env (and saveEnv skips identical values anyway).
  if (incremental) {
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
