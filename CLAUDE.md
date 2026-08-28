# CLAUDE.md

Guidance for AI agents (Claude Code and others) working in this repository. Read
this before changing code — several invariants here look like accidents and are
not. The long-form reasoning lives in [docs/decisions.md](docs/decisions.md);
this file is the short version plus the rules that must not be broken.

## What this is

AREA 51 is self-hosted out-of-band callback infrastructure for pentesters,
running entirely on one Cloudflare account with no origin server. Targets are
pointed at domains you control; every HTTP request and every email they send is
captured, and you choose what gets served back. Four runtime pieces share one D1
database and two R2 buckets:

| Piece | Path | Role |
|---|---|---|
| Black Holes worker | `workers/black-holes/` | Public catcher: serves endpoints, logs requests, captures email |
| Autopilot worker | `workers/autopilot/` | Secret-auth REST + MCP server for agents, fenced to `/-/*` |
| Cleanup worker | `workers/cleanup/` | Cron-only retention |
| Dashboard | `dashboard/` | Cloudflare Pages (React + `/api/*` Functions), behind Access |
| CLI | `cli/` (`./a51`) | Provisions and deploys everything |

Full map: [docs/internals/architecture.md](docs/internals/architecture.md). Data model:
[docs/reference/database.md](docs/reference/database.md) and [db/schema.sql](db/schema.sql).

## First deploy (install fast-path)

The whole thing installs with one idempotent command. Follow this order; the
full reference with per-step manual fallbacks is [docs/guides/getting-started.md](docs/guides/getting-started.md).

**Prerequisites (the API cannot do these for you — do them first):**
1. A domain already added to the Cloudflare account, ideally a burner with **no
   prior mail (MX) records** — enabling capture takes over inbound mail for the
   whole zone.
2. **R2 enabled**: dashboard → R2 → *Get started* (may ask for a card).
3. **Zero Trust activated once**: dashboard → *Zero Trust* → pick a team name →
   Free plan. Required for the dashboard's Access login; skip only with
   `--no-access`.
4. **Node.js 20+**.

**Deploy:**
```bash
npm install                 # wrangler + postal-mime
cp .env.example .env        # paste CLOUDFLARE_API_TOKEN, then run setup
./a51 setup                 # provisions D1, R2, 3 Workers, Pages, DNS, mail, Access — idempotent
./a51 doctor                # acceptance test: checks every binding, probes live hosts
```

`setup` prompts for the zone, a confirmation that the zone may be taken over,
the fallback inbox and the Access allow-list, then writes every answer back to
`.env`. It does **not** ask about hostnames: the black hole is always the zone
apex with both roles, and the other two are derived as `area51.<zone>` and
`autopilot.<zone>` (the apex is what puts the zone's mail catch-all in place, so
nothing on the zone captures mail until it is a black hole — see
[docs/decisions.md](docs/decisions.md#the-black-hole-is-always-the-zone-apex-and-setup-does-not-ask)).
Re-running it is the normal way to converge after fixing anything — completed
steps report "already correct."

Additional black holes go through `./a51 black-holes add <host> [http,mail]`, which
asks for roles when they are omitted. **Mail on a subdomain is supported** — it
enables Email Routing for that name and reuses the zone catch-all — but it
refuses unless that subdomain's own zone apex is already a mail black hole.

**The API token is where installs fail.** Create it at **My Profile → API
Tokens → Create Token → Custom token** with these **thirteen** permissions (the
full table with per-permission rationale is [docs/guides/getting-started.md#api-token](docs/guides/getting-started.md#api-token)):

| Scope | Permissions |
|---|---|
| **Account** | Workers Scripts:Edit · D1:Edit · Workers R2 Storage:Edit · Cloudflare Pages:Edit · Account Settings:Read · Access: Apps and Policies:Edit · Access: Organizations, Identity Providers, and Groups:Edit · Email Routing Addresses:Edit |
| **Zone** | Zone:Read · **Zone Settings:Edit** · DNS:Edit · Workers Routes:Edit · Email Routing Rules:Edit |

Then, under **Zone Resources**, *Include* the zone you deploy onto (or *All
zones*). All thirteen are required: the primary black hole always carries the
`mail` role, so the Email Routing permissions and Zone Settings are never
optional at setup time.

Three traps account for almost every "permission is set but still denied":
- **Enabling Email Routing needs `Zone · Zone Settings:Edit`**, NOT Email Routing
  Rules. Missing it → `[10000] Authentication error` on the mail step.
- **Zone Resources** must *include* the target zone (or All zones), or every zone
  call fails the same way as a missing permission.
- A **freshly created/edited token takes ~a minute to propagate**; `setup`
  retries auth errors, but a long propagation just needs a re-run.

If a step still fails, it prints the exact dashboard click-path and continues
(exit `2`); fix the cause and re-run `./a51 setup`. `./a51 doctor --fix` repairs
schema, Pages bindings, domain bindings and the Access policy.

## Invariants — do not violate these

1. **Orphan discipline across D1 ↔ R2.** The two stores share no transaction, so
   ordering is deliberate everywhere they are written together:
   - **Create:** write the R2 object *before* the D1 row; if the row write
     fails, compensating-delete the object.
   - **Replace:** repoint the row first, delete the *old* object only after.
   - **Delete:** delete the R2 object *first*, then the D1 row — a failure leaves
     a *visible* broken row, never an invisible orphaned object.
   This governs email capture, endpoint file upload/delete, purge, and cleanup.
   If you touch any of those paths, keep the order.

2. **No `COUNT(*)` anywhere the dashboard or an agent can reach.** D1 bills per
   row read. There are no tab badges, no stats panels, no totals. Lists show
   "{n} loaded". The only permitted full scan is the cleanup worker's daily
   maintenance delete. If counts are ever needed, use a counters table with
   triggers — never `COUNT(*)`.

3. **Autopilot is fenced.** Every managed endpoint URI must start with `/-/`
   (`AUTOPILOT_PREFIX`), hardcoded server-side and not widenable by the client.
   Autopilot has **no `FILES` R2 binding** on purpose: it can see that an
   endpoint serves a file but can never read, replace, or delete that object.
   The 60-minute read window is enforced in D1, never trusted from the caller.

4. **All-or-nothing email capture.** A captured email means both the R2 `.eml`
   object and the D1 row exist. On any failure, both are rolled back and the
   original is forwarded to `FALLBACK_ADDRESS`. There are no marker/partial rows,
   and there is **no body column in D1** — the raw `.eml` in R2 is the single
   source of the body, parsed client-side (dashboard) or via `email_raw` (agent).

5. **Endpoints are exact-match** on `url.pathname` (`WHERE uri = ?`). No globs,
   no regex, no trailing-slash equivalence. The table is the complete source of
   truth. Don't add pattern matching without adding a separate table and
   documenting precedence in decisions.md.

6. **No frontend build step.** React, ReactDOM and Babel come from a CDN; JSX is
   transpiled in the browser. The three `dashboard/js/*.jsx` files share globals
   on `window` (no modules). Don't introduce a bundler, imports, or a package
   step for the frontend without revisiting that decision. Deploys are pure file
   uploads.

7. **`.env` is the only state.** No lock file, no state file, nothing in a home
   dir. ("Lock file" here means a *deployment*-state file, Terraform-style —
   nothing to do with `package-lock.json`, which is gitignored for its own
   separate reason.) The CLI reads and *writes back* to `.env` (surgical per-line
   edits, preserving comments). Provisioning is **GET-then-act and idempotent** —
   every `ensure*` helper checks current state and reports `created: false` when
   there's nothing to do, so `./a51 setup` is always safe to re-run.

## Provisioning specifics (the CLI)

- Provisioning goes through the hand-written REST client
  [cli/lib/cloudflare.mjs](cli/lib/cloudflare.mjs), **not** wrangler. Wrangler
  only uploads code and installs the Autopilot secret. Keep it that way — the
  REST path is what makes every step inspectable and idempotent.
- A step that fails in a way a human can finish records a `followUp` with the
  exact click-path and the run continues (exit `2`); it does not abort.
- Auth-shaped Cloudflare errors (`403` / `[9109]` / `[10000]`) have several
  possible causes, so error hints must list them, not name one permission. Use
  `authFixHint()` in [cli/lib/provision.mjs](cli/lib/provision.mjs). The client
  retries transient auth errors to ride out **API-token propagation** (a
  just-created token takes ~a minute to work).
- **Known Cloudflare permission traps** (documented in
  [docs/guides/getting-started.md#api-token](docs/guides/getting-started.md#api-token)):
  - *Enabling* Email Routing needs **Zone · Zone Settings:Edit**, NOT Email
    Routing Rules (which only covers the catch-all rule). Missing it → `[10000]`.
  - A Zone permission whose **Zone Resources** don't include the target zone
    fails identically to a missing permission.
  - **Cloudflare Access requires Zero Trust to be activated once by hand**; the
    API can't do that first activation. A just-created Zero-Trust org isn't
    instantly usable, so `ensureAccess` polls it before creating the app.

## Working here

- **Deploy / operate:** `./a51 setup` (provision, idempotent), `./a51 deploy
  [target]`, `./a51 status`, `./a51 doctor [--fix]` (the real acceptance test —
  checks bindings and probes live hosts), `./a51 black-holes [list|add|remove]`
  (manage catchers; the D1 table is still named `domains`). `./a51 <cmd> --help`
  for each.
- **Syntax-check CLI edits:** `node --check <file>` (the CLI is plain ESM, no
  build). There is no test suite; `./a51 doctor` is how a deployment is verified.
- **One `package.json` at the root.** Workers have no manifests of their own;
  `postal-mime` and `wrangler` are declared once and resolved at bundle time.
- **`wrangler.toml` files are generated** from `*.template` + `.env` at deploy
  time and are gitignored — edit the template or `.env`, never the rendered file.
- **Match the surrounding style.** These files carry unusually thorough comments
  explaining *why*; preserve that when you edit, and update
  [docs/decisions.md](docs/decisions.md) if you change a documented trade-off.

## Security posture

This is offensive-security tooling for **authorized** engagements. The black
hole is deliberately public (targets must reach it); the dashboard is protected
only by Cloudflare Access; Autopilot only by a shared secret. Don't weaken those
boundaries, don't log secrets, and keep the Autopilot fence (`/-/` + no FILES
binding + 60-min window) intact.

## Where the documentation lives

`docs/` is in three tiers, and a change to behavior must update the matching
page in the same commit:

| Tier | Holds | Update it when you change… |
|---|---|---|
| [docs/guides/](docs/guides/) | getting-started, verify-deployment, usage, operations, troubleshooting | setup steps, an operator workflow, a failure mode |
| [docs/reference/](docs/reference/) | cli, configuration, api, database | a command or flag, a `.env` value, a route, a column |
| [docs/internals/](docs/internals/) | architecture, black-holes, autopilot, dashboard, cleanup | how a runtime piece behaves |

Cross-cutting: [development](docs/development.md) and
[decisions](docs/decisions.md). The index at [docs/README.md](docs/README.md)
carries a table per tier — add new pages there too.

The root [README.md](README.md) is deliberately non-technical: what the tool is,
what it proves, requirements, the four install commands, and links. Keep detail
out of it; put it in the right `docs/` tier instead.

Licensed Apache-2.0 (`LICENSE`, `NOTICE`); © Copyright 2026 Thoropass, Inc. Brand assets that
the README renders live in `.github/assets/brand/`; `media-kit/` is gitignored.
