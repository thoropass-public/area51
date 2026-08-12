// Wrangler is used for exactly three things — uploading Worker code, installing
// Worker secrets, and uploading the dashboard to Pages. Everything else
// (provisioning, DNS, domains, Email Routing, Access, SQL) goes through the
// REST API in cloudflare.mjs, because those calls need to be inspectable and
// idempotent rather than interactive.
//
// Wrangler is always invoked non-interactively: the API token and account id
// come from the environment (so it never tries a browser OAuth login) and
// telemetry prompts are disabled.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from './env.mjs';
import { die, color, info } from './log.mjs';

/** Worker targets: CLI name → directory + the .env keys its template needs. */
export const WORKER_TARGETS = {
  'black-holes': {
    dir: 'workers/black-holes',
    label: 'Black Holes worker (HTTP + email catcher)',
    serviceKey: 'WORKER_NAME',
    vars: ['WORKER_NAME', 'D1_DATABASE_NAME', 'D1_DATABASE_ID', 'R2_BUCKET_NAME', 'R2_FILES_BUCKET_NAME', 'FALLBACK_ADDRESS'],
  },
  autopilot: {
    dir: 'workers/autopilot',
    label: 'Autopilot worker (agent REST + MCP server)',
    serviceKey: 'AGENT_WORKER_NAME',
    vars: ['AGENT_WORKER_NAME', 'D1_DATABASE_NAME', 'D1_DATABASE_ID', 'R2_BUCKET_NAME'],
  },
  cleanup: {
    dir: 'workers/cleanup',
    label: 'Cleanup worker (scheduled retention)',
    serviceKey: 'CLEANUP_WORKER_NAME',
    vars: ['CLEANUP_WORKER_NAME', 'D1_DATABASE_NAME', 'D1_DATABASE_ID', 'R2_BUCKET_NAME', 'CLEANUP_REQUESTS_KEEP', 'CLEANUP_EMAIL_MAX_AGE_DAYS', 'CLEANUP_CRON'],
  },
};

/** Path to the local wrangler binary, or null when dependencies are missing. */
export function wranglerBin() {
  const local = join(repoRoot, 'node_modules', '.bin', 'wrangler');
  return existsSync(local) ? local : null;
}

export function requireWrangler() {
  const bin = wranglerBin();
  if (!bin) {
    die('wrangler is not installed. Run `npm install` in the repository root first.');
  }
  return bin;
}

/**
 * Substitute ${VAR} placeholders in a worker's wrangler.toml.template from the
 * given env, writing wrangler.toml next to it. Only the keys the target
 * declares are substituted, so a typo in a template fails loudly instead of
 * quietly becoming an empty string.
 */
export function renderWranglerConfig(target, env) {
  const spec = WORKER_TARGETS[target];
  if (!spec) die(`unknown worker target "${target}". Known: ${Object.keys(WORKER_TARGETS).join(', ')}`);

  const templatePath = join(repoRoot, spec.dir, 'wrangler.toml.template');
  const outputPath = join(repoRoot, spec.dir, 'wrangler.toml');
  if (!existsSync(templatePath)) die(`missing template: ${templatePath}`);

  const missing = spec.vars.filter((k) => env[k] === undefined || env[k] === '');
  // FALLBACK_ADDRESS is the one legitimately-optional value: with no fallback
  // inbox the worker simply has nowhere to forward on a capture error.
  const fatal = missing.filter((k) => k !== 'FALLBACK_ADDRESS');
  if (fatal.length) {
    die(`.env is missing required values for ${target}: ${fatal.join(', ')}\n  Run \`./a51 setup\` or fill them in by hand.`);
  }

  let rendered = readFileSync(templatePath, 'utf8');
  for (const key of spec.vars) {
    rendered = rendered.split(`\${${key}}`).join(env[key] ?? '');
  }

  const leftover = rendered.match(/\$\{[A-Za-z_][A-Za-z0-9_]*\}/g);
  if (leftover) {
    die(`unsubstituted placeholders in ${spec.dir}/wrangler.toml.template: ${[...new Set(leftover)].join(', ')}`);
  }

  writeFileSync(outputPath, rendered);
  return outputPath;
}

function wranglerEnv(env) {
  return {
    ...process.env,
    CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN || '',
    CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID || '',
    WRANGLER_SEND_METRICS: 'false',
  };
}

/**
 * Run wrangler with stdio inherited (so its progress output is the user's
 * progress output). Returns { ok, status }. `input` is piped to stdin, which is
 * how secrets are installed without ever touching argv.
 */
export function runWrangler(args, { cwd = repoRoot, env = {}, input } = {}) {
  const bin = requireWrangler();
  info(color.dim(`$ wrangler ${args.join(' ')}`));
  const res = spawnSync(bin, args, {
    cwd,
    env: wranglerEnv(env),
    stdio: input === undefined ? 'inherit' : ['pipe', 'inherit', 'inherit'],
    input,
  });
  if (res.error) die(`failed to run wrangler: ${res.error.message}`);
  return { ok: res.status === 0, status: res.status };
}

/** Render the target's config, then `wrangler deploy` from its directory. */
export function deployWorker(target, env, extraArgs = []) {
  renderWranglerConfig(target, env);
  const spec = WORKER_TARGETS[target];
  return runWrangler(['deploy', ...extraArgs], { cwd: join(repoRoot, spec.dir), env });
}

/** Install (or overwrite) a Worker secret, piping the value through stdin. */
export function putWorkerSecret(target, env, name, value) {
  const spec = WORKER_TARGETS[target];
  return runWrangler(['secret', 'put', name], { cwd: join(repoRoot, spec.dir), env, input: value });
}

/** Upload dashboard/ to the Pages project. */
export function deployPages(env, extraArgs = []) {
  return runWrangler(
    ['pages', 'deploy', '.', '--project-name', env.PAGES_PROJECT_NAME, '--branch', 'main', '--commit-dirty=true', ...extraArgs],
    { cwd: join(repoRoot, 'dashboard'), env },
  );
}
