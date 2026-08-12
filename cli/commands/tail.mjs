// `./a51 tail [target]` — stream a worker's structured JSON logs.
//
// Every worker logs one JSON object per event (docs/black-holes.md lists the
// event names), so this pipes nicely into jq:
//   ./a51 tail black-holes -- --format=json | jq 'select(.event=="email_stored")'

import { loadContext } from '../lib/context.mjs';
import { heading, plain, color, die, info } from '../lib/log.mjs';
import { runWrangler, requireWrangler, WORKER_TARGETS } from '../lib/wrangler.mjs';

export async function run(args) {
  const positional = args.filter((a) => !a.startsWith('--'));
  const passthrough = args.filter((a) => a.startsWith('--'));
  const target = positional[0] || 'black-holes';
  const { env } = await loadContext();
  requireWrangler();

  const spec = WORKER_TARGETS[target];
  if (!spec) die(`unknown target "${target}".\n  Targets: ${Object.keys(WORKER_TARGETS).join(', ')}`);

  const service = env[spec.serviceKey];
  if (!service) die(`${spec.serviceKey} is not set in .env.`);

  heading(`Tailing ${service}`);
  info(color.dim('Ctrl-C to stop. Logs are also queryable in the dashboard (Workers → Logs).'));
  plain('');
  const { ok } = runWrangler(['tail', service, ...passthrough], { env });
  return ok ? 0 : 1;
}
