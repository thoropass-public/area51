// `./a51 users` manages the operators of this deployment.
//
// Shapes:
//   ./a51 users [list]                  who has access, and their key ids
//   ./a51 users add [email]             add an operator, mint their key
//   ./a51 users remove <email>          revoke both ways in
//   ./a51 users rotate-key <email>      issue a new key, invalidate the old one
//   ./a51 users sync                    reconcile Cloudflare with D1
//
// One command because a person is one thing, even though there are two doors:
//
//   · The dashboard is guarded by Cloudflare Access. There is no key: Access
//     emails a one-time PIN to the address, and Cloudflare owns that exchange.
//   · Autopilot is guarded by a per-operator API key, sent as
//     `Authorization: Bearer <key>` and checked against the `users` table.
//
// The two authenticators are independent and neither knows the other exists.
// The D1 `users` table is the source of truth for both, and it is the ONLY
// thing these commands write directly. Cloudflare's copy, a Zero Trust email
// list the Access policy points at, is a projection: every mutation writes D1,
// re-reads D1, and pushes what it read. There is deliberately no command that
// writes the list on its own, because that would create a second way for the
// two to disagree.
//
// Keys are shown exactly once, when they are minted. Only a sha256 of each key
// is stored, so there is nothing to reveal later: a lost key is replaced with
// `rotate-key`, never recovered.

import { loadContext } from '../lib/context.mjs';
import { heading, step, plain, ok, warn, info, hint, color, table, resetSteps, die } from '../lib/log.mjs';
import { ask, confirm, closePrompts } from '../lib/prompt.mjs';
import { listUsers, upsertUser, normalizeEmail, mcpRegisterLines, syncOperators } from '../lib/users.mjs';

const USAGE = [
  './a51 users [list]                  who has access, and their key ids',
  '  ./a51 users add [email]             add an operator and mint their key',
  '  ./a51 users remove <email>          revoke the dashboard and Autopilot',
  '  ./a51 users rotate-key <email>      issue a new key for one operator',
  '  ./a51 users sync                    reconcile Cloudflare with D1',
].join('\n');

export async function run(args) {
  const positional = args.filter((a) => !a.startsWith('-'));
  const action = positional[0] || 'list';
  const arg = positional[1];

  const ctx = await loadContext({ needDatabase: true });
  resetSteps();

  if (action === 'list') return list(ctx);
  if (action === 'add') return add(ctx, arg);
  if (action === 'remove') return remove(ctx, arg);
  if (action === 'rotate-key') return rotate(ctx, arg);
  if (action === 'sync') return sync(ctx);

  die(`unknown action "${action}".\n  Usage: ${USAGE}`);
  return 1;
}

/** Read-only. No key material exists to print, so this is safe to run anywhere. */
async function list({ env, cf, accountId }) {
  heading(`Operators ${color.dim(`— database ${env.D1_DATABASE_NAME}`)}`);
  const users = await listUsers(cf, accountId, env.D1_DATABASE_ID);

  if (!users.length) {
    plain('');
    warn('no operators — the dashboard is closed to everyone and Autopilot rejects every key');
    hint('Add one with `./a51 users add`');
    plain('');
    return 0;
  }

  // The Cloudflare-side copy, read only to report drift. D1 is the truth, so a
  // failure here costs the ACCESS column and nothing else.
  const onList = await readAccessList(cf, accountId, env);

  const out = [[color.dim('EMAIL'), color.dim('KEY ID'), color.dim('ADDED'), color.dim('ACCESS')]];
  for (const u of users) {
    out.push([
      color.cyan(u.email),
      u.key_id,
      color.dim((u.created_at || '').slice(0, 10)),
      onList === null ? color.dim('?') : onList.has(u.email) ? color.green('yes') : color.red('MISSING'),
    ]);
  }
  plain('');
  table(out);
  plain('');

  reportDrift(users.map((u) => u.email), onList);
  info(color.dim(`${users.length} operator${users.length === 1 ? '' : 's'} · key ids are public; the keys themselves are stored only as hashes`));
  plain('');
  return 0;
}

async function add({ env, cf, accountId }, emailArg) {
  const email = await resolveEmail(emailArg, '  Email address of the new operator');

  const before = await listUsers(cf, accountId, env.D1_DATABASE_ID);
  if (before.some((u) => u.email === email)) {
    die([
      `${email} is already an operator.`,
      '',
      '  Their key cannot be shown again — only its hash is stored. To give them a',
      '  working key, issue a new one:',
      `    ./a51 users rotate-key ${email}`,
    ].join('\n'));
  }

  step(`Add operator ${email}`);
  const minted = await upsertUser(cf, accountId, env.D1_DATABASE_ID, email);
  ok(`added to the users table ${color.dim(`(key id ${minted.keyId})`)}`);

  const pushed = await pushFromD1({ env, cf, accountId }, { previousCount: before.length });
  printKey(env, email, minted.key, 'Their key');
  closePrompts();
  return pushed ? 0 : 2;
}

async function remove({ env, cf, accountId }, emailArg) {
  if (!emailArg) die('usage: ./a51 users remove <email>');
  const { ok: valid, email, reason } = normalizeEmail(emailArg);
  if (!valid) die(reason);

  const before = await listUsers(cf, accountId, env.D1_DATABASE_ID);
  if (!before.some((u) => u.email === email)) {
    die(`${email} is not an operator. Run \`./a51 users list\` to see who is.`);
  }
  const last = before.length === 1;

  step(`Remove operator ${email}`);
  plain('');
  plain('  Their Autopilot key stops working immediately. They lose the dashboard as');
  plain('  soon as their current Access session expires — revoke it in Zero Trust to');
  plain('  cut it short.');
  if (last) {
    plain('');
    warn(`${email} is the last operator — the dashboard will be closed to everyone.`);
  }
  plain('');
  if (!(await confirm(`  Remove ${color.bold(email)}?`, false))) {
    plain('  Canceled. Nothing was changed.');
    closePrompts();
    return 1;
  }

  await cf.d1Query(accountId, env.D1_DATABASE_ID, 'DELETE FROM users WHERE email = ?', [email]);
  ok('removed from the users table — their Autopilot key is now dead');

  const pushed = await pushFromD1({ env, cf, accountId }, { previousCount: before.length });
  plain('');
  info(color.dim('Anything they captured is kept. Purge it with `./a51 purge`.'));
  plain('');
  closePrompts();
  return pushed ? 0 : 2;
}

/**
 * Replace one operator's key. Both halves change: upsertUser mints a fresh
 * key_id AND a fresh secret, and the ON CONFLICT clause overwrites both columns
 * in one write. The command is `rotate-key` rather than `rotate-secret` for
 * exactly that reason: the public id does not survive a rotation either, so an
 * operator correlating worker logs by key_id across one will not find a match.
 */
async function rotate({ env, cf, accountId }, emailArg) {
  if (!emailArg) die('usage: ./a51 users rotate-key <email>');
  const { ok: valid, email, reason } = normalizeEmail(emailArg);
  if (!valid) die(reason);

  const users = await listUsers(cf, accountId, env.D1_DATABASE_ID);
  const existing = users.find((u) => u.email === email);
  if (!existing) {
    die(`${email} is not an operator. Add them with \`./a51 users add ${email}\`.`);
  }

  step(`Rotate the key for ${email}`);
  plain('');
  plain(`  Key ${color.bold(existing.key_id)} stops working the moment this is written.`);
  plain('  Every agent registered with it must be re-registered with the new key.');
  plain('');
  if (!(await confirm('  Continue?', true))) {
    plain('  Canceled. The old key is still in effect.');
    closePrompts();
    return 1;
  }

  const minted = await upsertUser(cf, accountId, env.D1_DATABASE_ID, email);
  ok(`issued key ${color.dim(minted.keyId)} — ${color.dim(existing.key_id)} is revoked`);

  // No push. Rotation changes key_id and key_hash; the email set is untouched,
  // and the Access list mirrors the email column only. Cloudflare has nothing to
  // learn from this operation.
  info(color.dim('dashboard access is unchanged — Access authenticates the address, not the key'));

  printKey(env, email, minted.key, 'Their new key');
  closePrompts();
  return 0;
}

/**
 * Reconcile Cloudflare with D1, changing nothing in D1.
 *
 * This is the repair path for a push that failed half-way, whether from a
 * missing permission, an inactive Zero Trust org or a network error. It is also
 * the only command that touches the Access application without a user having
 * changed. It cannot do anything
 * except make Cloudflare agree with D1, which is why it is safe to run at any
 * time and why `doctor --fix` calls the same code.
 */
async function sync({ env, cf, accountId }) {
  step('Reconcile Cloudflare with D1');
  const pushed = await pushFromD1({ env, cf, accountId }, { force: true });
  closePrompts();
  return pushed ? 0 : 2;
}

// ── helpers ─────────────────────────────────────────────────────────────────

/** Take the address from argv or ask for it, and normalize either way. */
async function resolveEmail(emailArg, question) {
  const raw = emailArg || (await ask(question, '', { required: true }));
  const { ok: valid, email, reason } = normalizeEmail(raw);
  if (!valid) die(reason);
  return email;
}

/**
 * Push D1's state to Cloudflare, reporting rather than throwing.
 *
 * The D1 row is already written by the time this runs, and D1 is the source of
 * truth, so a failure here is a sync problem to be repaired, not a reason to
 * unwind the change. Returns false when the operator needs to do something.
 */
async function pushFromD1({ env, cf, accountId }, opts = {}) {
  if (!env.DASHBOARD_HOSTNAME) {
    warn('DASHBOARD_HOSTNAME is not set — skipping the Cloudflare side');
    hint('Run `./a51 setup` first, then `./a51 users sync`.');
    return false;
  }

  const followUps = [];
  try {
    await syncOperators(cf, accountId, env, { ...opts, followUps });
  } catch (err) {
    followUps.push({
      label: `could not update Cloudflare: ${err && err.message ? err.message : err}`,
      detail: 'The users table is already correct. Fix the cause, then run `./a51 users sync`.',
    });
  }

  if (!followUps.length) return true;

  plain('');
  warn('the users table is updated, but Cloudflare is not in step:');
  plain('');
  followUps.forEach((f) => {
    plain(`  · ${f.label}`);
    for (const line of String(f.detail).split('\n')) plain(`    ${color.dim(line)}`);
  });
  plain('');
  return false;
}

/** The emails currently on the Cloudflare list, or null if it can't be read. */
async function readAccessList(cf, accountId, env) {
  if (!env.ACCESS_LIST_ID) return null;
  try {
    const items = (await cf.getZeroTrustListItems(accountId, env.ACCESS_LIST_ID)) || [];
    return new Set(items.map((i) => String(i.value || '').toLowerCase()));
  } catch {
    return null;
  }
}

/** Name any difference between D1 and the list, in both directions. */
function reportDrift(emails, onList) {
  if (onList === null) return;
  const inD1 = new Set(emails);
  const missing = emails.filter((e) => !onList.has(e));
  const stale = [...onList].filter((e) => !inD1.has(e));

  if (stale.length) {
    // The dangerous direction: Cloudflare still admits somebody D1 does not
    // list, so a revocation did not fully land.
    warn(`${stale.length} address${stale.length === 1 ? '' : 'es'} on the Access list ${stale.length === 1 ? 'is' : 'are'} NOT an operator: ${stale.join(', ')}`);
    hint('They can still open the dashboard. Run `./a51 users sync` to remove them.');
  }
  if (missing.length) {
    warn(`${missing.length} operator${missing.length === 1 ? '' : 's'} missing from the Access list: ${missing.join(', ')}`);
    hint('They cannot log in until this is pushed. Run `./a51 users sync`.');
  }
}

/**
 * The one and only time a key is visible. Printed last, after every other line,
 * so it is still on screen when the command ends.
 */
function printKey(env, email, key, label) {
  plain('');
  heading(`${label} ${color.dim(`— shown once, ${color.bold('now')}`)}`);
  plain('');
  plain(`    ${color.bold(color.green(key))}`);
  plain('');
  plain(`  ${color.yellow('Copy it before this scrolls away.')} Only a hash is stored, so it cannot be`);
  plain(`  shown again — a lost key is replaced with \`./a51 users rotate-key ${email}\`.`);
  plain('');
  if (env.AUTOPILOT_HOSTNAME) {
    plain(`  ${color.bold('They register Autopilot with:')}`);
    plain('');
    for (const line of mcpRegisterLines(env.AUTOPILOT_HOSTNAME, key)) plain(`    ${line}`);
    plain('');
  }
  if (env.DASHBOARD_HOSTNAME) {
    plain(`  The dashboard needs no key — Cloudflare Access emails ${color.cyan(email)} a`);
    plain(`  one-time PIN at ${color.cyan(`https://${env.DASHBOARD_HOSTNAME}`)}.`);
    plain('');
  }
}
