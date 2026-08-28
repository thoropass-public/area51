// `./a51 deploy [target]` — push code. Provisioning stays in `setup`; this
// command only uploads what is already provisioned (plus the two things that
// must travel with a deploy: the Autopilot secret and the Pages bindings).
//
// Targets are independent, and `deploy all` is the common case, so each one runs
// in its own try/catch: a schema error must not stop the workers from shipping,
// and a worker that fails to bundle must not stop the dashboard. Failures are
// collected and reported together with a count of what did succeed.

import { loadContext } from '../lib/context.mjs';
import { step, ok, warn, heading, plain, color, resetSteps, die } from '../lib/log.mjs';
import { deployWorker, deployPages, putWorkerSecret, requireWrangler, WORKER_TARGETS } from '../lib/wrangler.mjs';
import { ensurePagesProject, applySchema } from '../lib/provision.mjs';

const TARGETS = ['black-holes', 'autopilot', 'cleanup', 'dashboard', 'schema'];

export async function run(args) {
  const positional = args.filter((a) => !a.startsWith('--'));
  const target = positional[0] || 'all';

  if (target !== 'all' && !TARGETS.includes(target)) {
    die(`unknown deploy target "${target}".\n  Targets: ${TARGETS.join(', ')}, all`);
  }

  const { env, cf, accountId } = await loadContext({ needDatabase: true });
  const targets = target === 'all' ? TARGETS : [target];
  // `schema` is pure REST — it needs no wrangler. Only insist on the binary when
  // a target actually uploads something, so `deploy schema` works on a checkout
  // where `npm install` has not run.
  if (targets.some((t) => t !== 'schema')) requireWrangler();
  const failed = [];
  resetSteps();

  // Each target is independent, and `deploy all` is the common case: a schema
  // error must not stop the workers from shipping, and a worker that fails to
  // bundle must not stop the dashboard. So every target runs inside its own
  // try/catch and contributes to `failed` rather than unwinding the loop.
  for (const t of targets) {
    try {
      await deployTarget(t, cf, accountId, env, failed);
    } catch (err) {
      failed.push(`${t}: ${err && err.message ? err.message : err}`);
    }
  }

  if (failed.length) {
    heading(color.red('Failed'));
    failed.forEach((f) => plain(`  ✗ ${f}`));
    plain('');
    plain(color.dim(`  ${targets.length - failed.length} of ${targets.length} target(s) succeeded. Re-run to retry just the rest.`));
    plain('');
    return 1;
  }

  heading(color.green('Deployed'));
  plain(`  ${targets.join(', ')}`);
  plain('');
  return 0;
}

async function deployTarget(t, cf, accountId, env, failed) {
  {
    if (t === 'dashboard') {
      step('Dashboard (Cloudflare Pages)');
      const followUps = [];
      await ensurePagesProject(cf, accountId, env, followUps);
      followUps.forEach((f) => failed.push(f.label));
      if (!deployPages(env).ok) failed.push('dashboard upload');
      return;
    }

    if (t === 'schema') {
      step('D1 schema');
      await applySchema(cf, accountId, env.D1_DATABASE_ID);
      return;
    }

    step(WORKER_TARGETS[t].label);
    if (t === 'autopilot') {
      if (!env.AGENT_SECRET) {
        warn('AGENT_SECRET is empty in .env — run `./a51 rotate-secret` to generate and install one');
      } else if (putWorkerSecret('autopilot', env, 'AGENT_SECRET', env.AGENT_SECRET).ok) {
        ok('AGENT_SECRET installed (encrypted Worker Secret)');
      } else {
        failed.push('AGENT_SECRET install');
      }
    }
    if (!deployWorker(t, env).ok) failed.push(`${t} deploy`);
  }
}
