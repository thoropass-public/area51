# CLAUDE.md

Guidance for AI agents (Claude Code and others) working in this repository. Read
it before changing code. Several of the invariants here look like accidents, but
they are not. The long-form reasoning lives in
[docs/decisions.md](docs/decisions.md); this file is the short version, plus the
rules that must not be broken.

## What this is

AREA 51 is self-hosted out-of-band callback infrastructure for pentesters,
running entirely on one Cloudflare account with no origin server. Targets are
pointed at domains you control; every HTTP request and every email they send is
captured, and you choose what gets served back. Four runtime pieces share one D1
database and two R2 buckets, and a CLI provisions and deploys them:

| Piece | Path | Role |
|---|---|---|
| Black Holes worker | `workers/black-holes/` | Public catcher: serves endpoints, logs requests, captures email |
| Autopilot worker | `workers/autopilot/` | Key-auth REST + MCP server for agents, fenced to `/-/*` |
| Cleanup worker | `workers/cleanup/` | Cron-only retention |
| Dashboard worker | `dashboard/` | Worker with static assets: React UI from `public/`, `/api/*` from `src/`, behind Access |
| CLI | `cli/` (`./a51`) | Provisions and deploys everything |

Full map: [docs/internals/architecture.md](docs/internals/architecture.md). Data model:
[docs/reference/database.md](docs/reference/database.md) and [db/schema.sql](db/schema.sql).

## First deploy (install fast-path)

The whole thing installs with one idempotent command. Follow this order; the
full reference with per-step manual fallbacks is [docs/guides/getting-started.md](docs/guides/getting-started.md).

**Prerequisites. The API cannot do these for you, so do them first:**
1. A domain already added to the Cloudflare account. Ideally a burner with **no
   prior mail (MX) records**, because enabling capture takes over inbound mail
   for the whole zone.
2. **R2 enabled**: dashboard → R2 → *Get started* (may ask for a card).
3. **Zero Trust activated once**: dashboard → *Zero Trust* → pick a team name →
   Free plan. The dashboard's Access login needs this, and there is no way to
   skip it, so turn it on before running setup.
4. **Node.js 20+**.

**Deploy:**
```bash
npm install                 # wrangler + postal-mime
cp .env.example .env        # paste CLOUDFLARE_API_TOKEN, then run setup
./a51 setup                 # provisions D1, R2, 4 Workers, DNS, mail, Access (idempotent)
./a51 doctor                # acceptance test: checks every binding, probes live hosts
```

`setup` prompts for the zone, a confirmation that the zone may be taken over,
the fallback inbox and your own email address (as the first operator). Most
answers are written back to `.env`. The operator address is not: it becomes a
row in the D1 `users` table, and a re-run reads that table instead of asking
again. It does **not** ask about hostnames: the black hole is always the zone
apex with both roles, and the other two are derived as `area51.<zone>` and
`autopilot.<zone>` (the apex is what puts the zone's mail catch-all in place, so
nothing on the zone captures mail until it is a black hole. See
[docs/decisions.md](docs/decisions.md#the-black-hole-is-always-the-zone-apex-and-setup-does-not-ask)).
Re-running it is the normal way to converge after fixing something. Completed
steps re-report as `·` (already correct) rather than running again.

Additional black holes go through `./a51 black-holes add <host> [http,mail]`, which
asks for roles when they are omitted. **Mail on a subdomain is supported.** It
enables Email Routing for that name and reuses the zone catch-all, but it
refuses unless that subdomain's own zone apex is already a mail black hole.

**The API token is where installs fail.** Create it at **My Profile → API
Tokens → Create Token → Custom token** with these **fourteen** permissions (the
full table with per-permission rationale is [docs/guides/getting-started.md#api-token](docs/guides/getting-started.md#api-token)):

| Scope | Permissions |
|---|---|
| **Account** | Workers Scripts:Edit · D1:Edit · Workers R2 Storage:Edit · Cloudflare Pages:Edit · Account Settings:Read · Access: Apps and Policies:Edit · Access: Organizations, Identity Providers, and Groups:Edit · **Zero Trust:Edit** · Email Routing Addresses:Edit |
| **Zone** | Zone:Read · **Zone Settings:Edit** · DNS:Edit · Workers Routes:Edit · Email Routing Rules:Edit |

Then, under **Zone Resources**, *Include* the zone you deploy onto (or *All
zones*). All fourteen are required: the primary black hole always carries the
`mail` role, so the Email Routing permissions and Zone Settings are never
optional at setup time.

`Cloudflare Pages:Edit` looks like a leftover — nothing here creates a Pages
project any more, since the dashboard became a Worker. It is not: it is what lets
a confirmed takeover **detach a Pages project's custom domain** when one holds a
hostname a black hole needs, and a domain worth taking over very often has
someone else's Pages site on it. Removing it degrades that takeover to a manual
dashboard step.

Four traps account for almost every "permission is set but still denied":
- **The operator email list needs `Account · Zero Trust:Edit`**, NOT Access: Apps
  and Policies. Zero Trust lists live under the Gateway resource tree, so a token
  that can write the Access application still cannot write the list its policy
  points at.
- **Enabling Email Routing needs `Zone · Zone Settings:Edit`**, NOT Email Routing
  Rules. Missing it → `[10000] Authentication error` on the mail step.
- **Zone Resources** must *include* the target zone (or All zones), or every zone
  call fails the same way as a missing permission.
- A **freshly created/edited token takes ~a minute to propagate**; `setup`
  retries auth errors, but a long propagation just needs a re-run.

If a step still fails, it prints the exact dashboard click-path and continues
(exit `2`); fix the cause and re-run `./a51 setup`. `./a51 doctor --fix` repairs
schema, domain bindings and the Access policy.

## Invariants: do not violate these

1. **Orphan discipline across D1 ↔ R2.** The two stores share no transaction, so
   ordering is deliberate everywhere they are written together:
   - **Create:** write the R2 object *before* the D1 row; if the row write
     fails, compensating-delete the object.
   - **Replace:** repoint the row first, delete the *old* object only after.
   - **Delete:** delete the R2 object *first*, then the D1 row. A failure then
     leaves a *visible* broken row, never an invisible orphaned object.
   This governs email capture, endpoint file upload/delete, purge, and cleanup.
   If you touch any of those paths, keep the order.

2. **No `COUNT(*)` anywhere the dashboard or an agent can reach.** D1 bills per
   row read. There are no tab badges, no stats panels, no totals. Lists show
   "{n} loaded". The only permitted full scan is the cleanup worker's daily
   maintenance delete. If counts are ever needed, use a counters table with
   triggers, never `COUNT(*)`.

3. **Autopilot is fenced.** Every managed endpoint URI must start with `/-/`
   (`AUTOPILOT_PREFIX`), hardcoded server-side and not widenable by the client.
   Autopilot has **no `FILES` R2 binding** on purpose: it can see that an
   endpoint serves a file but can never read, replace, or delete that object.
   The 60-minute read window is enforced in D1, never trusted from the caller.

4. **All-or-nothing email capture.** A captured email means both the R2 `.eml`
   object and the D1 row exist. On any failure, both are rolled back and the
   original is forwarded to `FALLBACK_ADDRESS`. There are no marker/partial rows,
   and there is **no body column in D1**. The raw `.eml` in R2 is the single
   source of the body, parsed client-side (dashboard) or via `email_raw` (agent).

5. **Endpoints are exact-match** on `url.pathname` (`WHERE uri = ?`). No globs,
   no regex, no trailing-slash equivalence. The table is the complete source of
   truth. Don't add pattern matching without adding a separate table and
   documenting precedence in decisions.md.

6. **No frontend build step.** React, ReactDOM and Babel come from a CDN; JSX is
   transpiled in the browser. The three `dashboard/public/js/*.jsx` files share
   globals on `window` (no modules). Don't introduce a bundler, imports, or a
   package step for the frontend without revisiting that decision. Deploys are
   pure file uploads — moving the dashboard onto Workers static assets did not
   change that.

   Two rules come with the `public/` ÷ `src/` split, and both matter:
   - **Everything in `public/` is served** to anyone who can reach the hostname.
     `[assets] directory` points there. Server-side code goes in `src/`, never
     `public/`.
   - **`[assets] run_worker_first` stays scoped to `["/api/*"]`.** Setting it to
     `true` makes every static request a billable Worker invocation; scoped, the
     asset layer serves them free and unlimited without entering the Worker. The
     Worker gets no `assets` `binding` either, because it never serves an asset.

7. **Dashboard routing is an explicit table, and literal paths win.** Pages
   derived routes from the `functions/` directory and resolved precedence for
   free. `dashboard/src/index.js` now holds the `ROUTES` table and
   `dashboard/src/router.js` matches it. Two properties must hold: a **literal
   path is settled before any `:param` route, including when the method does not
   match** (that answers 405, it does not fall through — otherwise
   `GET /api/endpoints/upload` does a D1 lookup for an endpoint named "upload");
   and **matching splits the raw `url.pathname` by segment**, never `URLPattern`,
   which canonicalizes the path and would decode the `%2F` that every endpoint
   URI arrives with. This is the one thing here that breaks *silently*, so it has
   the repo's only test file. Adding a route means editing the table and running
   `node dashboard/src/router.test.mjs`.

8. **Operators live in D1, and a key is shown once.** The `users` table is the
   single source of truth for *both* doors, and the only thing `./a51 users`
   writes. Autopilot reads `key_hash` live. Cloudflare Access cannot read D1,
   because its policies are enforced at Cloudflare's edge, so the `email` column
   is **projected** into a Zero Trust email list (`ACCESS_LIST_ID`) that the
   policy points at. That projection is mandatory, and it is the only copy
   allowed: don't reintroduce `ALLOWED_EMAILS` or a shared secret.

   Rules that must hold when you touch this:
   - **Write D1, re-read D1, then `PUT` the full list.** Never compose the pushed
     set in memory from what you think you just wrote. A concurrent change from
     another machine would be silently reverted. `PUT`, never `PATCH`, so a hand
     edit in the Cloudflare dashboard does not survive.
   - **Only the zero-crossing touches the Access application.** Routine adds and
     removes rewrite the list alone. An empty operator set writes an **explicit
     deny-everyone** policy rather than relying on an empty list matching nobody,
     which Cloudflare does not document.
   - **Only `sha256(<whole key>)` is stored**, so keys are rotated, never
     recovered. That includes your own. No key is ever written to `.env`.
   - Look rows up by the **public** `key_id` and compare hashes in **constant
     time**; never key a query on something derived from the secret. D1
     unreachable answers **503, not 401**.
   - Managing the list needs `Account · Zero Trust:Edit`, which is a *different*
     permission from `Access: Apps and Policies:Edit`.

9. **`.env` is the only state.** No lock file, no state file, nothing in a home
   dir. ("Lock file" here means a *deployment*-state file, Terraform-style. It
   has nothing to do with `package-lock.json`, which is gitignored for its own
   separate reason.) The CLI reads and *writes back* to `.env`, with surgical
   per-line edits that preserve comments. Provisioning is **GET-then-act and
   idempotent**: every `ensure*` helper inspects current state before it writes, so
   `./a51 setup` is always safe to re-run. Return shapes vary and are not a
   contract: `ensureDatabase` and `ensureAccessList` report `created: false`,
   the rest return whatever their caller needs (a resource, a boolean, nothing).
   Read the helper before depending on what it hands back.

## Provisioning specifics (the CLI)

- Provisioning goes through the hand-written REST client
  [cli/lib/cloudflare.mjs](cli/lib/cloudflare.mjs), **not** wrangler. Wrangler
  only uploads code. Keep it that way: the REST path is what makes every step
  inspectable and idempotent. (Autopilot has no Worker Secret at all: it
  authenticates against the D1 `users` table.)
- A step that fails in a way a human can finish records a `followUp` with the
  exact click-path and the run continues (exit `2`); it does not abort.
- Auth-shaped Cloudflare errors (`403` / `[9109]` / `[10000]`) have several
  possible causes, so error hints must list them, not name one permission. Use
  `authFixHint()` in [cli/lib/provision.mjs](cli/lib/provision.mjs). The client
  retries transient auth errors, but only briefly, about five seconds per call.
  That absorbs a blip, not the ~minute a just-created token can take to
  propagate. A token that is still propagating needs a re-run of `./a51 setup`,
  which is safe because every step is idempotent.
- **A confirmed takeover clears the hostname itself.** Cloudflare refuses a
  Worker Custom Domain on a name that already has an address record it did not
  create (`[100117] ... externally managed DNS records`), and that is the normal
  state of a domain worth taking over. `ensureBlackHole` treats the refusal as a
  step: it detaches the Worker or Pages custom domain holding the name, deletes
  any plain DNS record left, then binds again. It asks the owning product first,
  because deleting a Cloudflare-managed record behind its owner's back leaves
  that product claiming a host it no longer serves. This runs only *after*
  Cloudflare says the name is occupied, so a re-run never deletes anything, and
  only for the black hole, whose callers took a typed `TAKEOVER` naming those
  exact records. The derived hostnames get no such prompt, so they still report
  the conflict and skip. See [docs/decisions.md](docs/decisions.md#a-confirmed-takeover-clears-the-name-itself).
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
  [target]`, `./a51 status`, `./a51 doctor [--fix]` (the real acceptance test:
  it checks bindings and probes live hosts), `./a51 black-holes [list|add|remove]`
  (manage catchers; the D1 table is still named `domains`), `./a51 users
  [list|add|remove|rotate-key|sync]` (manage operators, meaning dashboard access
  and Autopilot keys together). `./a51 <cmd> --help` for each.
- **Syntax-check CLI edits:** `node --check <file>` (the CLI is plain ESM, no
  build). There is no test suite; `./a51 doctor` is how a deployment is verified.
  **One deliberate exception:** `node dashboard/src/router.test.mjs` pins the
  dashboard's route precedence, because that is the one behavior here that breaks
  *silently* — a mis-resolved route runs the wrong handler and answers a
  plausible 404, which no binding check or live probe can see. Run it after
  touching `dashboard/src/router.js` or the `ROUTES` table. Don't generalize it
  into a suite without revisiting
  [decisions.md](docs/decisions.md#one-test-file-for-route-precedence-and-only-that).
- **One `package.json` at the root.** Workers have no manifests of their own;
  `postal-mime` and `wrangler` are declared once and resolved at bundle time.
- **`wrangler.toml` files are generated** from `*.template` + `.env` at deploy
  time and are gitignored. Edit the template or `.env`, never the rendered file.
- **Match the surrounding style.** These files carry unusually thorough comments
  explaining *why*; preserve that when you edit, and update
  [docs/decisions.md](docs/decisions.md) if you change a documented trade-off.

## Security posture

This is offensive-security tooling for **authorized** engagements. The black
hole is deliberately public (targets must reach it); the dashboard is protected
only by Cloudflare Access; Autopilot only by a per-operator API key. Don't weaken
those boundaries, don't log keys (the public `key_id` is fine and is what makes a
call attributable; the key itself never is), and keep the Autopilot fence (`/-/`
+ no FILES binding + 60-min window) intact.

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
carries a table per tier, so add new pages there too.

The root [README.md](README.md) is deliberately non-technical: what the tool is,
what it proves, requirements, the four install commands, and links. Keep detail
out of it; put it in the right `docs/` tier instead.

Licensed Apache-2.0 (`LICENSE`, `NOTICE`); © Copyright 2026 Thoropass, Inc. Brand assets that
the README renders live in `.github/assets/brand/`; `media-kit/` is gitignored.
