// Single in-code source for the API-token permission list the CLI prints. Both
// `./a51` (help screen) and `./a51 setup` step 1 use it, so the two can never
// drift from each other. The full table with per-permission rationale lives in
// docs/guides/getting-started.md#api-token; keep this, .env.example and CLAUDE.md in sync if the
// set ever changes.
//
// The token is where installs fail, so the list is shown at the exact moment an
// operator needs it (when pasting the token), not just linked.
//
// AREA 51 authenticates with an ACCOUNT API token, which belongs to the account
// rather than to a person and so outlives whoever created it. The permissions go
// in two policies, and the two blocks printed below are those policies: one
// scoped to the account, one scoped to the zones you deploy on.

import { plain, color } from './log.mjs';

export function printTokenPermissions() {
  plain(`  ${color.bold('Account API token')} ${color.dim('14 permissions · Manage Account → API Tokens → Create Token')}`);
  plain('');
  plain(`    ${color.bold('Policy 1 · the account')}`);
  plain(`      ${color.bold('Edit')}   Workers Scripts · D1 · Workers R2 Storage`);
  plain(`             Access: Apps · Access: Policies · Access: Orgs, IdPs and Groups`);
  plain(`             Email Routing Addresses`);
  plain(`             Zero Trust`);
  plain(`      ${color.bold('Read')}   Account Settings`);
  plain('');
  plain(`    ${color.bold('Policy 2 · the zones you deploy on')}`);
  plain(`      ${color.bold('Edit')}   Zone Settings · DNS · Workers Routes · Email Routing Rules`);
  plain(`      ${color.bold('Read')}   Zone`);
  plain('');
  plain(`    ${color.dim('Details: docs/guides/getting-started.md#api-token')}`);
  plain('');
}
