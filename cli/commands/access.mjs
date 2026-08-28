// `./a51 access` — edit who may open the dashboard (Cloudflare Access).
//
// Shapes:
//   ./a51 access --list                        print the current allow-list (read-only)
//   ./a51 access --add <email|domain>[,...]    add entries, keep the existing ones
//   ./a51 access --remove <email|domain>[,...] drop entries, keep the rest
//   ./a51 access                               re-apply ALLOWED_EMAILS from .env
//
// There is deliberately NO positional "replace the whole list" form: --add /
// --remove express every change without the footgun of silently wiping entries
// you forgot to re-type. To set the list wholesale, edit ALLOWED_EMAILS in .env
// and run `./a51 access` (the bare re-apply).
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

// Pull --add / --remove (each takes a value: `--add x,y` or `--add=x,y`) out of
// the args; whatever is left and isn't a flag is a positional (replace) list.
function parseArgs(args) {
  const add = [];
  const remove = [];
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--add' || a === '--remove') {
      const val = args[i + 1];
      if (val === undefined || val.startsWith('-')) {
        die(`${a} needs a value, e.g. ${a} new@gmail.com,example.com`);
      }
      (a === '--add' ? add : remove).push(val);
      i += 1; // consume the value
    } else if (a.startsWith('--add=')) {
      add.push(a.slice('--add='.length));
    } else if (a.startsWith('--remove=')) {
      remove.push(a.slice('--remove='.length));
    } else if (!a.startsWith('-')) {
      positional.push(a);
    }
    // any other --flag (e.g. --yes) is ignored here
  }
  return { add: normList(add.join(',')), remove: normList(remove.join(',')), positional };
}

export async function run(args) {
  // --list is a pure read of .env — no token, no network, no changes.
  if (args.includes('--list') || args.includes('-l')) {
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
    plain(color.dim(`  ${list.length} ${list.length === 1 ? 'entry' : 'entries'} · edit with --add / --remove · guards ${env.DASHBOARD_HOSTNAME || '(DASHBOARD_HOSTNAME unset)'}`));
    plain('');
    return 0;
  }

  const { add, remove, positional } = parseArgs(args);

  // No positional "replace" form — steer a stray argument to --add / --remove,
  // and to the .env escape hatch for setting the whole list at once.
  if (positional.length) {
    die([
      `unexpected argument "${positional[0]}".`,
      'Edit the allow-list with --add / --remove:',
      '  ./a51 access --add new@gmail.com,example.com',
      '  ./a51 access --remove new@gmail.com',
      'To set the whole list at once, edit ALLOWED_EMAILS in .env, then run `./a51 access`.',
    ].join('\n'));
  }
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

  // Persist only when --add/--remove changed the list. A bare re-apply doesn't
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
