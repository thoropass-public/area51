// Shared bootstrap for every command: read .env, build an API client, and work
// out which account / zone / database we are pointed at.

import { Cloudflare, isAuthError } from './cloudflare.mjs';
import { loadEnv, saveEnv } from './env.mjs';
import { die, warn, skip, ok, color } from './log.mjs';
import { ask, select } from './prompt.mjs';

/**
 * Build the context most commands need.
 *
 *   env        parsed .env
 *   cf         Cloudflare API client
 *   accountId  resolved (and persisted) account id
 */
export async function loadContext({ needAccount = true, needDatabase = false } = {}) {
  const env = loadEnv();

  if (!env.CLOUDFLARE_API_TOKEN) {
    die('CLOUDFLARE_API_TOKEN is not set in .env.\n  Copy .env.example to .env, paste a token, then run `./a51 setup`.');
  }

  const cf = new Cloudflare(env.CLOUDFLARE_API_TOKEN);
  let accountId = env.CLOUDFLARE_ACCOUNT_ID || '';

  if (needAccount && !accountId) {
    accountId = await resolveAccount(cf, env);
  }

  if (needDatabase && !env.D1_DATABASE_ID) {
    die('D1_DATABASE_ID is not set in .env. Run `./a51 setup` first.');
  }

  return { env, cf, accountId };
}

/**
 * Discover the account id and write it to .env.
 *
 * An Account API token belongs to one account, so listing is a convenience
 * rather than the mechanism: it turns the id into a name the operator can
 * recognise. When the listing is unavailable, which an account-scoped token is
 * entitled to be, asking for the id outright is not a degraded path. It is on
 * the first screen of the Cloudflare dashboard and in the URL of every page
 * under it.
 *
 * This runs before anything verifies the token, because verification is itself
 * account-scoped and needs the id this returns.
 */
export async function resolveAccount(cf, env) {
  let accounts = null;
  try {
    accounts = await cf.listAccounts();
  } catch (err) {
    if (!isAuthError(err)) throw err;
  }

  const accountId = (accounts && accounts.length)
    ? await select(
      'Which Cloudflare account should AREA 51 live in?',
      accounts.map((a) => ({ value: a.id, label: a.name, hint: a.id })),
    )
    : await ask(
      'Cloudflare account id (dashboard → the account → it is in the URL)',
      '',
      { required: true },
    );

  saveEnv({ CLOUDFLARE_ACCOUNT_ID: accountId });
  env.CLOUDFLARE_ACCOUNT_ID = accountId;
  return accountId;
}

/**
 * Resolve a hostname to the zone that serves it, walking up the labels so
 * `bh.example.com` matches the `example.com` zone. Returns null if the token
 * can't see a matching zone.
 */
export async function zoneForHostname(cf, accountId, hostname) {
  const labels = String(hostname || '').split('.').filter(Boolean);
  for (let i = 0; i < labels.length - 1; i++) {
    const candidate = labels.slice(i).join('.');
    const zone = await cf.findZone(accountId, candidate);
    if (zone) return zone;
  }
  return null;
}

/** Print a warning if the token is missing something a command needs. */
export async function verifyToken(cf, accountId) {
  try {
    const result = await cf.verifyToken(accountId);
    if (result && result.status !== 'active') {
      warn(`the API token status is "${result.status}", expected "active".`);
      return false;
    }
    ok('API token is valid and active');
    return true;
  } catch (err) {
    die(
      `the API token was rejected by Cloudflare: ${err.message}\n` +
      '  AREA 51 authenticates with an Account API token (dashboard → Manage Account\n' +
      '  → API Tokens). Check that CLOUDFLARE_ACCOUNT_ID in .env is the account the\n' +
      '  token belongs to, and that the token has not been revoked or expired.',
    );
  }
  return false;
}

/** `https://host` with no trailing slash, used all over the summaries. */
export const url = (host) => `https://${host}`;

/** Report a step that failed but has a manual fallback. */
export function degraded(followUps, label, detail) {
  followUps.push({ label, detail });
  console.log(`  ${color.red('✗')} ${label}`);
  for (const line of String(detail).split('\n')) console.log(`      ${color.dim(line)}`);
}

export { skip };
