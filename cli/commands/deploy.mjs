// `./a51 deploy [target]` — push code. Provisioning stays in `setup`; this
// command only uploads what is already provisioned (plus the two things that
// must travel with a deploy: the Autopilot secret and the Pages bindings).

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
  requireWrangler();
  const targets = target === 'all' ? TARGETS : [target];
  const failed = [];
  resetSteps();

  for (const t of targets) {
    if (t === 'dashboard') {
      step('Dashboard (Cloudflare Pages)');
      const followUps = [];
      await ensurePagesProject(cf, accountId, env, followUps);
      followUps.forEach((f) => failed.push(f.label));
      if (!deployPages(env).ok) failed.push('dashboard upload');
      continue;
    }

    if (t === 'schema') {
      step('D1 schema');
      await applySchema(cf, accountId, env.D1_DATABASE_ID);
      continue;
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

  if (failed.length) {
    heading(color.red('Failed'));
    failed.forEach((f) => plain(`  ✗ ${f}`));
    plain('');
    return 1;
  }

  heading(color.green('Deployed'));
  plain(`  ${targets.join(', ')}`);
  plain('');
  return 0;
}
