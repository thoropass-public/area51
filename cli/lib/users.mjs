// Operators, their Autopilot API keys, and the D1 `users` table that holds both.
//
// One row per person. That row is the single source of truth for the two
// independent ways into a deployment:
//
//   · Cloudflare Access: `email` is the identity allowed to open the dashboard.
//     Access never sees a key; Cloudflare mails a one-time PIN to that address.
//   · Autopilot: `key_hash` is what an agent's `Authorization: Bearer` header
//     is checked against. Autopilot never sees the Access allow-list.
//
// Neither authenticator knows about the other; `./a51 users` is what keeps them
// in step. Everything here is plain REST against the D1 HTTP API, so adding or
// removing a user needs no wrangler and no redeploy. It is the same live-table
// model as the `domains` table behind `./a51 black-holes`.
//
// The key format and the reason for its two halves are documented on the table
// itself in db/schema.sql.

import { randomBytes, createHash } from 'node:crypto';
import { saveEnv } from './env.mjs';
import { ok, skip, color } from './log.mjs';
import { ensureAccess, ensureAccessList, ACCESS_LIST_NAME } from './provision.mjs';

/** sha256 of the whole key string, hex. Must match the worker's hash exactly. */
export function hashKey(key) {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

/**
 * Mint a fresh key. Returns the plaintext once. It is never stored anywhere in
 * recoverable form, so a caller that does not show it to a human has thrown it
 * away.
 *
 * This BUILDS the key shape; the Autopilot worker VALIDATES it, with its own
 * regex in workers/autopilot/src/index.js. The two cannot share code, because
 * the CLI hashes with node:crypto and the worker with WebCrypto, so changing the
 * shape here means changing that regex in the same commit. Miss it and this mints
 * keys the worker rejects. (The format itself is documented in db/schema.sql.)
 */
export function mintKey() {
  const keyId = randomBytes(4).toString('hex');
  const secret = randomBytes(32).toString('hex');
  const key = `${keyId}_${secret}`;
  return { keyId, key, keyHash: hashKey(key) };
}

/**
 * Every operator, oldest first.
 *
 * A deployment provisioned before this table existed answers "no such table",
 * which as a raw Cloudflare error reads like a bug rather than a missing
 * migration. Translate it into the one command that fixes it.
 */
export async function listUsers(cf, accountId, databaseId) {
  try {
    return await cf.d1Rows(
      accountId,
      databaseId,
      'SELECT email, key_id, key_hash, created_at FROM users ORDER BY created_at, email',
    );
  } catch (err) {
    if (/no such table: users/i.test(String(err && err.message))) {
      const e = new Error(
        'the users table does not exist in this database yet.\n' +
        '  It arrived with per-operator keys. Apply the schema, then add yourself:\n' +
        '    ./a51 deploy schema\n' +
        '    ./a51 users add',
      );
      e.missingTable = true;
      throw e;
    }
    throw err;
  }
}

/** The Access allow-list, derived from the table rather than stored twice. */
export async function allowListFrom(cf, accountId, databaseId) {
  return (await listUsers(cf, accountId, databaseId)).map((u) => u.email);
}

/**
 * Insert or replace one operator's row, retrying on a key_id collision.
 *
 * A 4-byte id gives 4.3 billion values, so a collision at any realistic number
 * of operators is vanishingly unlikely. But `idx_users_key_id` is UNIQUE, so
 * the database would reject it rather than quietly issue an ambiguous key. Mint
 * again instead of trusting the odds.
 */
export async function upsertUser(cf, accountId, databaseId, email, { attempts = 5 } = {}) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    const minted = mintKey();
    try {
      await cf.d1Query(
        accountId,
        databaseId,
        `INSERT INTO users (email, key_id, key_hash, created_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(email) DO UPDATE SET key_id = excluded.key_id, key_hash = excluded.key_hash`,
        [email, minted.keyId, minted.keyHash, new Date().toISOString()],
      );
      return minted;
    } catch (err) {
      // Only a key_id collision is worth another spin; anything else is real.
      if (!/UNIQUE|constraint/i.test(String(err && err.message))) throw err;
      lastErr = err;
    }
  }
  throw lastErr || new Error('could not allocate a unique key id');
}

/**
 * Normalize and validate an address. Deliberately permissive, because Cloudflare
 * Access is the thing that ultimately has to deliver a PIN to it, and its own
 * validation is the one that counts. This only catches obvious typos.
 */
export function normalizeEmail(raw) {
  const email = String(raw || '').trim().toLowerCase();
  if (!email) return { ok: false, reason: 'an email address is required' };
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return { ok: false, reason: `"${raw}" does not look like an email address` };
  }
  return { ok: true, email };
}

/**
 * The line an operator pastes to register their agent. Kept here so setup, the
 * users command and the docs example cannot drift apart.
 */
export function mcpRegisterLines(autopilotHostname, key) {
  return [
    `claude mcp add autopilot https://${autopilotHostname}/mcp \\`,
    `      --transport http --header "Authorization: Bearer ${key}"`,
  ];
}

/**
 * Project the D1 `users` table onto Cloudflare, which is the only way the
 * dashboard door ever changes.
 *
 * Three properties this exists to guarantee:
 *
 *   1. The emails pushed are RE-READ from D1 after the write, never composed in
 *      memory from what we think we just did. If another operator changed the
 *      table between our read and our write, their change is carried along
 *      rather than silently reverted.
 *   2. The list is REPLACED wholesale (PUT, not PATCH), so anything edited by
 *      hand in the Cloudflare dashboard is overwritten on the next operation.
 *      That is what makes D1 authoritative in practice and not just on paper.
 *   3. The Access application is left alone except when the operator count
 *      crosses zero, the one transition that has to change the policy itself
 *      (allow-via-list ↔ deny-everyone). Routine adds and removes never touch
 *      the thing guarding the dashboard.
 *
 * Pass `previousCount` so the zero-crossing can be detected; pass `force` on the
 * repair path (`./a51 users sync`) to reconcile the application too.
 */
export async function syncOperators(cf, accountId, env, { followUps = [], previousCount = null, force = false } = {}) {
  const emails = await allowListFrom(cf, accountId, env.D1_DATABASE_ID);

  const list = await ensureAccessList(cf, accountId, { listId: env.ACCESS_LIST_ID });
  if (list.id !== env.ACCESS_LIST_ID) {
    saveEnv({ ACCESS_LIST_ID: list.id });
    env.ACCESS_LIST_ID = list.id;
  }

  await cf.updateZeroTrustList(accountId, list.id, {
    name: ACCESS_LIST_NAME,
    description: 'Operators who may open the AREA 51 dashboard. Managed by `./a51 users` — edits here are overwritten.',
    items: emails,
  });
  ok(`pushed ${emails.length} operator${emails.length === 1 ? '' : 's'} to the Access list`);

  // Only the zero-crossing changes the policy; everything else is list-only.
  const crossedZero = previousCount === null || (previousCount === 0) !== (emails.length === 0);
  if (force || crossedZero) {
    await ensureAccess(cf, accountId, {
      hostname: env.DASHBOARD_HOSTNAME,
      listId: list.id,
      operatorCount: emails.length,
      sessionDuration: env.ACCESS_SESSION_DURATION || '24h',
      teamName: env.ACCESS_TEAM_NAME || env.CLOUDFLARE_ZONE?.replace(/\./g, '-') || 'area51',
      pagesProjectName: env.PAGES_PROJECT_NAME,
      followUps,
    });
  } else {
    skip(`Access application unchanged ${color.dim('(the policy points at the list, not at names)')}`);
  }

  return { emails, listId: list.id };
}
