// `./a51 rotate-secret` — replace the Autopilot shared secret.
//
// The secret lives in two places: an encrypted Worker Secret (what the worker
// compares against) and .env (so it can be re-installed without anyone having
// memorised it). Rotating writes both, then every agent has to be re-registered
// with the new value.

import { randomBytes } from 'node:crypto';
import { loadContext } from '../lib/context.mjs';
import { saveEnv } from '../lib/env.mjs';
import { heading, plain, ok, color, die } from '../lib/log.mjs';
import { putWorkerSecret, requireWrangler } from '../lib/wrangler.mjs';
import { confirm, closePrompts } from '../lib/prompt.mjs';

export async function run(args) {
  const { env } = await loadContext();
  requireWrangler();

  const explicit = args.find((a) => !a.startsWith('--'));
  const secret = explicit || randomBytes(32).toString('hex');

  heading('Rotate the Autopilot secret');
  plain('');
  plain('  Every agent currently registered against this deployment stops working');
  plain('  until it is re-registered with the new secret.');
  plain('');
  if (!(await confirm('  Continue?', true))) {
    plain('  Canceled.');
    closePrompts();
    return 1;
  }

  if (!putWorkerSecret('autopilot', env, 'AGENT_SECRET', secret).ok) {
    die('wrangler failed to install the secret — the old one is still in effect.');
  }
  ok(`installed a new AGENT_SECRET on ${env.AGENT_WORKER_NAME}`);
  saveEnv({ AGENT_SECRET: secret });
  ok('updated .env');

  plain('');
  plain(`  ${color.bold('Re-register each agent:')}`);
  plain('');
  plain(`    claude mcp remove autopilot`);
  plain(`    claude mcp add autopilot https://${env.AUTOPILOT_HOSTNAME}/mcp \\`);
  plain(`      --transport http --header "X-A51-Secret: ${secret}"`);
  plain('');
  closePrompts();
  return 0;
}
