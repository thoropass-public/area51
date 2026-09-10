// `./a51 deploy [target]` pushes code. Provisioning stays in `setup`; this
// command only uploads what is already provisioned.
//
// Targets are independent, and `deploy all` is the common case, so each one runs
// in its own try/catch: a schema error must not stop the workers from shipping,
// and a worker that fails to bundle must not stop the dashboard. Failures are
// collected and reported together with a count of what did succeed.

import { loadContext } from '../lib/context.mjs';
import { step, heading, plain, color, resetSteps, die } from '../lib/log.mjs';
import { deployWorker, requireWrangler, WORKER_TARGETS } from '../lib/wrangler.mjs';
import { applySchema } from '../lib/provision.mjs';

const TARGETS = ['black-holes', 'autopilot', 'cleanup', 'dashboard', 'schema'];

export async function run(args) {
  const positional = args.filter((a) => !a.startsWith('--'));
  const target = positional[0] || 'all';

  if (target !== 'all' && !TARGETS.includes(target)) {
    die(`unknown deploy target "${target}".\n  Targets: ${TARGETS.join(', ')}, all`);
  }

  const { env, cf, accountId } = await loadContext({ needDatabase: true });
  const targets = target === 'all' ? TARGETS : [target];
  // `schema` is pure REST and needs no wrangler. Only insist on the binary when
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
  if (t === 'schema') {
    step('D1 schema');
    await applySchema(cf, accountId, env.D1_DATABASE_ID);
    return;
  }

  // Every remaining target, the dashboard included, is a worker whose bindings
  // are declared in its own wrangler.toml.template. There is nothing to attach
  // over the API before uploading, which is what the dashboard's old Pages
  // branch existed to do.
  //
  // Autopilot has no secret to install either: it authenticates every call
  // against the D1 users table, so operator keys travel with the database and
  // `./a51 users add` takes effect with no deploy at all.
  step(WORKER_TARGETS[t].label);
  if (!deployWorker(t, env).ok) failed.push(`${t} deploy`);
}
