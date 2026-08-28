// `./a51 dev <target>` — run a piece locally.
//
// Local runs talk to the REMOTE D1 and R2 by default, which is what you usually
// want (real captures, real endpoints) but also means a local mistake is a real
// mistake. Pass --local for isolated local storage instead.

import { join } from 'node:path';
import { loadContext } from '../lib/context.mjs';
import { repoRoot } from '../lib/env.mjs';
import { heading, plain, color, die, info } from '../lib/log.mjs';
import { runWrangler, requireWrangler, WORKER_TARGETS } from '../lib/wrangler.mjs';

export async function run(args) {
  const positional = args.filter((a) => !a.startsWith('--'));
  const passthrough = args.filter((a) => a.startsWith('--'));
  const target = positional[0];
  const { env } = await loadContext({ needDatabase: true });
  requireWrangler();

  if (target === 'dashboard') {
    heading('Dashboard — local Pages dev server');
    info(color.dim('Static files are served from dashboard/, Functions run locally against remote D1/R2.'));
    plain('');
    const { ok } = runWrangler(
      [
        'pages', 'dev', '.',
        `--d1=DB=${env.D1_DATABASE_NAME}`,
        `--r2=EML=${env.R2_BUCKET_NAME}`,
        `--r2=FILES=${env.R2_FILES_BUCKET_NAME}`,
        '--compatibility-date=2024-10-11',
        ...passthrough,
      ],
      { cwd: join(repoRoot, 'dashboard'), env },
    );
    return ok ? 0 : 1;
  }

  if (WORKER_TARGETS[target]) {
    heading(`${WORKER_TARGETS[target].label} — local dev`);
    if (target === 'cleanup') {
      info(color.dim('Cron-only worker. With --test-scheduled, trigger a run by hitting:'));
      info(color.dim('  http://localhost:8787/__scheduled?cron=' + encodeURIComponent(env.CLEANUP_CRON || '0 6 * * *')));
    }
    plain('');
    const { ok } = runWrangler(['dev', ...passthrough], { cwd: join(repoRoot, WORKER_TARGETS[target].dir), env });
    return ok ? 0 : 1;
  }

  die(`unknown dev target "${target || ''}".\n  Targets: dashboard, ${Object.keys(WORKER_TARGETS).join(', ')}`);
  return 1;
}
