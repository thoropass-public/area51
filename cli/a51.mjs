#!/usr/bin/env node
// AREA 51 command line. One entrypoint for provisioning, deploying and
// operating a deployment.
//
//   ./a51 setup            provision everything from a token and a domain
//   ./a51 <command> --help what each command does
//
// Design notes for anyone extending this:
//   * Commands live in cli/commands/<name>.mjs and export `run(args) -> exit code`.
//   * Provisioning goes through the Cloudflare REST API (cli/lib/cloudflare.mjs)
//     so it can be inspected and made idempotent; only code uploads use wrangler.
//   * .env is the only state. Nothing is cached anywhere else.

import { setAssumeYes, closePrompts } from './lib/prompt.mjs';
import { color, plain, die } from './lib/log.mjs';
import { CloudflareError } from './lib/cloudflare.mjs';
import { printTokenPermissions } from './lib/permissions.mjs';

const COMMANDS = {
  setup: {
    module: './commands/setup.mjs',
    summary: 'provision the whole deployment on Cloudflare (safe to re-run)',
    usage: './a51 setup [--yes] [--dry-run] [--no-access]',
  },
  deploy: {
    module: './commands/deploy.mjs',
    summary: 'upload code: all | black-holes | autopilot | cleanup | dashboard | schema',
    usage: './a51 deploy [target]',
  },
  status: {
    module: './commands/status.mjs',
    summary: 'show what is deployed and where',
    usage: './a51 status',
  },
  doctor: {
    module: './commands/doctor.mjs',
    summary: 'check every binding, domain and policy; probe the live hosts',
    usage: './a51 doctor [--fix] [--no-probes]',
  },
  domains: {
    module: './commands/domains.mjs',
    summary: 'manage black holes (list, add, remove)',
    usage: './a51 domains [list | add <host> [http,mail] | remove <host>]',
  },
  access: {
    module: './commands/access.mjs',
    summary: 'edit who may open the dashboard (Cloudflare Access) — --add / --remove',
    usage: [
      './a51 access --list                          show the current allow-list (read-only)',
      '  ./a51 access --add <email|domain>[,...]      add entries to the allow-list',
      '  ./a51 access --remove <email|domain>[,...]   remove entries from it',
      '  ./a51 access                                 re-apply ALLOWED_EMAILS from .env',
      '',
      '  e.g.  ./a51 access --add new@gmail.com,asca.com',
      '        ./a51 access --remove new@gmail.com',
      '',
      '  To set the whole list at once, edit ALLOWED_EMAILS in .env, then run ./a51 access.',
    ].join('\n'),
  },
  purge: {
    module: './commands/purge.mjs',
    summary: 'delete captured data (D1 rows and their R2 objects, in lockstep)',
    usage: './a51 purge',
  },
  'rotate-secret': {
    module: './commands/rotate-secret.mjs',
    summary: 'replace the Autopilot shared secret',
    usage: './a51 rotate-secret [value]',
  },
  tail: {
    module: './commands/tail.mjs',
    summary: 'stream a worker\'s structured logs',
    usage: './a51 tail [black-holes | autopilot | cleanup]',
  },
  dev: {
    module: './commands/dev.mjs',
    summary: 'run a piece locally against the remote stores',
    usage: './a51 dev <dashboard | black-holes | autopilot | cleanup>',
  },
  destroy: {
    module: './commands/destroy.mjs',
    summary: 'tear the deployment down — empties buckets, no manual steps (two typed confirmations)',
    usage: './a51 destroy',
  },
};

function usage() {
  plain('');
  plain(`${color.bold('AREA 51')} — the exploit server for out-of-band findings`);
  plain('');
  plain(`  ${color.dim('usage:')} ./a51 <command> [options]`);
  plain('');
  const width = Math.max(...Object.keys(COMMANDS).map((c) => c.length));
  for (const [name, spec] of Object.entries(COMMANDS)) {
    plain(`  ${color.bold(name.padEnd(width))}  ${spec.summary}`);
  }
  plain('');
  printTokenPermissions();
  plain(`  ${color.dim('first run:')}  cp .env.example .env  &&  ./a51 setup`);
  plain(`  ${color.dim('docs:')}       README.md, then docs/README.md`);
  plain('');
}

async function main() {
  const argv = process.argv.slice(2);
  const commandIndex = argv.findIndex((a) => !a.startsWith('-'));
  const command = commandIndex === -1 ? undefined : argv[commandIndex];
  // Remove only the command itself, not a later positional that happens to
  // repeat it (`./a51 domains remove domains` must keep its argument).
  const args = argv.filter((_, i) => i !== commandIndex);

  // Version — checked BEFORE the help/no-command fallthrough. `./a51 --version`
  // has no positional command, so without this it would be treated as "no
  // command" and print the help screen instead of the version.
  if (argv.includes('--version') || argv.includes('-v') || command === 'version') {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { repoRoot } = await import('./lib/env.mjs');
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
    plain(pkg.version);
    return 0;
  }

  if (!command || argv.includes('--help') || argv.includes('-h')) {
    if (command && COMMANDS[command]) {
      plain('');
      plain(`  ${color.bold(command)} — ${COMMANDS[command].summary}`);
      plain('');
      plain(`  ${COMMANDS[command].usage}`);
      plain('');
      return 0;
    }
    usage();
    return command ? 1 : 0;
  }

  const spec = COMMANDS[command];
  if (!spec) {
    usage();
    die(`unknown command "${command}"`);
  }

  if (args.includes('--yes') || args.includes('-y') || process.env.A51_YES === '1') setAssumeYes(true);

  const mod = await import(spec.module);
  const code = await mod.run(args);
  return typeof code === 'number' ? code : 0;
}

main()
  .then((code) => {
    closePrompts();
    process.exit(code);
  })
  .catch((err) => {
    closePrompts();
    plain('');
    if (err instanceof CloudflareError) {
      console.error(`${color.red('Cloudflare API error')} on ${err.method} ${err.path}`);
      console.error(`  ${err.message}`);
      if (err.status === 403 || err.status === 401) {
        console.error(`  ${color.dim('This usually means the API token is missing a permission — see docs/guides/getting-started.md#api-token.')}`);
      }
    } else {
      console.error(`${color.red('error')} ${err && err.message ? err.message : err}`);
      if (process.env.A51_DEBUG === '1' && err && err.stack) console.error(color.dim(err.stack));
    }
    console.error(`  ${color.dim('Re-run with A51_DEBUG=1 for a stack trace.')}`);
    console.error('');
    process.exit(1);
  });
