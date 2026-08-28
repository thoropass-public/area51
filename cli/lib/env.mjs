// Read and write the repo-root .env file.
//
// .env is the single source of truth for a deployment, and it is meant to be
// read by humans: it ships as a heavily commented template (.env.example).
// So writes are surgical — an existing `KEY=` line is replaced in place and
// everything else (comments, blank lines, ordering) is left untouched. Keys
// that don't exist yet are appended in one clearly marked block at the end.

import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const envPath = join(repoRoot, '.env');
export const envExamplePath = join(repoRoot, '.env.example');

const KEY_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

function unquote(raw) {
  const v = raw.trim();
  if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) {
    return v.slice(1, -1);
  }
  // An unquoted value ends at the first ` #` comment.
  const hash = v.indexOf(' #');
  return (hash === -1 ? v : v.slice(0, hash)).trim();
}

/** Parse a .env-format string into a plain object. */
export function parseEnv(text) {
  const out = {};
  for (const line of text.split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const m = line.match(KEY_LINE);
    if (m) out[m[1]] = unquote(m[2]);
  }
  return out;
}

/** Load .env, or {} if it does not exist. */
export function loadEnv() {
  if (!existsSync(envPath)) return {};
  return parseEnv(readFileSync(envPath, 'utf8'));
}

/** Create .env from .env.example if it is missing. Returns true if created. */
export function ensureEnvFile() {
  if (existsSync(envPath)) return false;
  copyFileSync(envExamplePath, envPath);
  return true;
}

function quoteIfNeeded(value) {
  const v = String(value);
  if (v === '') return '';
  return /[\s#'"]/.test(v) ? `"${v.replace(/"/g, '\\"')}"` : v;
}

/**
 * Merge `updates` into .env. Existing keys are rewritten in place, preserving
 * the surrounding comments; new keys are appended. Values that are already
 * identical are left completely alone (so re-running setup is a no-op here).
 * Returns the list of keys actually written.
 */
export function saveEnv(updates) {
  ensureEnvFile();
  const lines = readFileSync(envPath, 'utf8').split('\n');
  const pending = new Map(Object.entries(updates));
  const written = [];

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(KEY_LINE);
    if (!m) continue;
    const key = m[1];
    if (!pending.has(key)) continue;
    const value = pending.get(key);
    pending.delete(key);
    if (unquote(m[2]) === String(value)) continue;
    lines[i] = `${key}=${quoteIfNeeded(value)}`;
    written.push(key);
  }

  if (pending.size) {
    if (lines.length && lines[lines.length - 1].trim() !== '') lines.push('');
    lines.push('# ─── Added by ./a51 setup ────────────────────────────────────────────────────');
    for (const [key, value] of pending) {
      lines.push(`${key}=${quoteIfNeeded(value)}`);
      written.push(key);
    }
    lines.push('');
  }

  writeFileSync(envPath, lines.join('\n'), { mode: 0o600 });
  return written;
}

/** First non-empty value among the given keys, else the fallback. */
export function pick(env, key, fallback = '') {
  const v = env[key];
  return v === undefined || v === '' ? fallback : v;
}

/** Parse a comma/space separated list into trimmed, de-duplicated entries. */
export function parseList(value) {
  return [...new Set(String(value || '').split(/[,\s]+/).map((s) => s.trim()).filter(Boolean))];
}
