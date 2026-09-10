// Single in-code source for the API-token permission list the CLI prints. Both
// `./a51` (help screen) and `./a51 setup` step 1 use it, so the two can never
// drift from each other. The full table with per-permission rationale lives in
// docs/guides/getting-started.md#api-token; keep this, .env.example and CLAUDE.md in sync if the
// set ever changes.
//
// The token is where installs fail, so the list is shown at the exact moment an
// operator needs it (when pasting the token), not just linked.

import { plain, color } from './log.mjs';

export function printTokenPermissions() {
  plain(`  ${color.bold('API token')} ${color.dim('— 13 permissions · My Profile → API Tokens → Create Token → Custom token')}`);
  plain('');
  plain(`    ${color.bold('Account scope')}`);
  plain(`      ${color.bold('Edit')}   Workers Scripts · D1 · Workers R2 Storage`);
  plain(`             Access: Apps and Policies · Access: Orgs, IdPs and Groups · Email Routing Addresses`);
  plain(`             Zero Trust`);
  plain(`      ${color.bold('Read')}   Account Settings`);
  plain('');
  plain(`    ${color.bold('Zone scope')}`);
  plain(`      ${color.bold('Edit')}   Zone Settings · DNS · Workers Routes · Email Routing Rules`);
  plain(`      ${color.bold('Read')}   Zone`);
  plain('');
  plain(`    ${color.dim('Details: docs/guides/getting-started.md#api-token')}`);
  plain('');
}
