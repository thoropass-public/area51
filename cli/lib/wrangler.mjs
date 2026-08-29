// Wrangler is used for exactly two things — uploading Worker code and uploading
// the dashboard to Pages. Everything else (provisioning, DNS, domains, Email
// Routing, Access, SQL) goes through the REST API in cloudflare.mjs, because
// those calls need to be inspectable and idempotent rather than interactive.
//
// It used to install Worker secrets too. Nothing does any more: Autopilot
// authenticates against the D1 `users` table, so there is no secret to install
// and a deploy is a pure code upload.
//
// Wrangler is always invoked non-interactively: the API token and account id
// come from the environment (so it never tries a browser OAuth login) and
// telemetry prompts are disabled.
//
// Its output is also captured rather than inherited — see runWrangler. Wrangler
// is chatty enough that four uploads used to bury the CLI's own report, so each
// one reports a single line and the full log appears only on failure, or under
// --verbose. `tail` is the exception: for it the output IS the product, so it
// keeps the terminal.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from './env.mjs';
import { die, color, plain, trace, isVerbose, sym } from './log.mjs';

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
 * progress output). Returns { ok, status }.
 *
 * Output handling is the point of this wrapper. Wrangler is chatty — three
 * worker deploys plus a Pages upload used to bury `setup`'s own report under
 * several screens of build logs, which is how an operator misses the one line
 * that mattered. So:
 *
 *   * `stream: true` hands the terminal over, for commands that ARE the output
 *     (`tail`). Those must never be captured.
 *   * otherwise output is captured, and a single line reports the result with
 *     how long it took. The full log is replayed only when the command FAILS,
 *     which is exactly when you want it, or when --verbose asks for it up front.
 *
 * `input` is piped to stdin, which is how secrets are installed without ever
 * touching argv.
 */
export function runWrangler(args, { cwd = repoRoot, env = {}, input, stream = false, label } = {}) {
  const bin = requireWrangler();
  trace(`$ wrangler ${args.join(' ')}`);

  // --verbose falls back to inheriting, so the raw output arrives live rather
  // than after the fact.
  const inherit = stream || isVerbose();
  const interactive = process.stdout.isTTY && !inherit && Boolean(label);
  const started = Date.now();

  if (interactive) process.stdout.write(`  ${color.dim('·')} ${label}…`);

  const res = spawnSync(bin, args, {
    cwd,
    env: wranglerEnv(env),
    stdio: inherit
      ? (input === undefined ? 'inherit' : ['pipe', 'inherit', 'inherit'])
      : ['pipe', 'pipe', 'pipe'],
    input,
    encoding: inherit ? undefined : 'utf8',
  });

  if (res.error) die(`failed to run wrangler: ${res.error.message}`);
  const succeeded = res.status === 0;
  const secs = ((Date.now() - started) / 1000).toFixed(1);

  if (label && !inherit) {
    const line = `  ${succeeded ? sym.ok : sym.fail} ${label} ${color.dim(`(${secs}s)`)}`;
    // Overwrite the "working" line in place on a TTY; print a fresh one otherwise
    // (a \r in a log file is just noise).
    if (interactive) process.stdout.write(`\r\x1b[K${line}\n`);
    else console.log(line);
  }

  // A failure is the one time the full log earns its space.
  if (!succeeded && !inherit) {
    const out = `${res.stdout || ''}\n${res.stderr || ''}`.trim();
    if (out) {
      plain('');
      for (const l of out.split('\n')) console.log(`      ${color.dim(l)}`);
      plain('');
    }
  }

  return { ok: succeeded, status: res.status };
}

/** Render the target's config, then `wrangler deploy` from its directory. */
export function deployWorker(target, env, extraArgs = []) {
  renderWranglerConfig(target, env);
  const spec = WORKER_TARGETS[target];
  return runWrangler(['deploy', ...extraArgs], {
    cwd: join(repoRoot, spec.dir),
    env,
    label: `uploaded ${env[spec.serviceKey] || target}`,
  });
}


/** Upload dashboard/ to the Pages project. */
export function deployPages(env, extraArgs = []) {
  return runWrangler(
    ['pages', 'deploy', '.', '--project-name', env.PAGES_PROJECT_NAME, '--branch', 'main', '--commit-dirty=true', ...extraArgs],
    { cwd: join(repoRoot, 'dashboard'), env, label: `uploaded the dashboard to ${env.PAGES_PROJECT_NAME}` },
  );
}
