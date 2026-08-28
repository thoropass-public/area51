// `./a51 dev <target>` — run a piece locally.
//
// Local runs use LOCAL storage by default: `wrangler dev` has `--remote` set to
// false unless asked, so nothing here touches the real D1 or R2 until you pass
// `-- --remote`. That makes a local mistake a local mistake, and it also means the
// dashboard will look empty — real captures are not there.
//
// `wrangler pages dev` has no `--remote` at all (as of wrangler 4), so the
// dashboard target is local-only: its --d1/--r2 flags name local simulacra of the
// bindings, not the deployed stores.

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
    info(color.dim('Static files from dashboard/, Functions local. Storage is LOCAL: wrangler'));
    info(color.dim('pages dev has no --remote, so captures made against a deployment are not here.'));
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
      { cwd: join(repoRoot, 'dashboard'), env, stream: true },
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
    const { ok } = runWrangler(['dev', ...passthrough], { cwd: join(repoRoot, WORKER_TARGETS[target].dir), env, stream: true });
    return ok ? 0 : 1;
  }

  die(`unknown dev target "${target || ''}".\n  Targets: dashboard, ${Object.keys(WORKER_TARGETS).join(', ')}`);
  return 1;
}
