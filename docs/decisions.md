# Design decision log

The non-obvious choices, and what undoing them costs. Each entry is here because
someone might reasonably try to "fix" it without knowing the trade.

---

## No row counts anywhere in the UI

There are no tab badges ("Requests 5,183"), no stats panel, and no `COUNT(*)`
anywhere the dashboard can reach.

**Why:** D1 bills per row *read*. `SELECT COUNT(*) FROM emails` over 1,000 rows is
1,000 row reads, and a dashboard refresh showing three counts would burn several
thousand reads for numbers nobody acts on. The scan grows linearly with the table
forever.

The textbook fix, a `counters` table maintained by `AFTER INSERT/DELETE`
triggers, is O(1) reads, one extra write per mutation, and about fifty lines of schema. It
was rejected as complexity that buys polish. Each tab shows `{rows.length} loaded`
instead, which is free.

If counts come back, do it with counters and triggers, not `COUNT(*)`. The one
place a full scan is acceptable is the cleanup worker's once-daily maintenance
delete ([cleanup.md](internals/cleanup.md)).

## Endpoints list shows URI and status, and nothing else

The list query returns two columns; headers and body are fetched only when the
modal opens.

**Why:** status is high-signal at a glance (it catches a misconfigured 500 or an
accidental 200). Header count and body length are not, and getting them costs
either an N+1 fetch per row or a much fatter list payload. One query per page beats
eleven.

## Endpoints are exact-match, not glob

The catcher matches `url.pathname` with `WHERE uri = ?`. No wildcards, no regex, no
trailing-slash equivalence.

**Why:** the table is then the complete, unambiguous source of truth, with no
precedence rules to reason about when two patterns could match. And the lookup is
the cheapest possible query, a primary-key hit.

If patterns become necessary, add a separate `endpoint_patterns` table consulted
only when the exact lookup misses, and document the precedence order here.

## No build pipeline for the frontend

React, ReactDOM and Babel-standalone come from a CDN; JSX is transpiled in the
browser.

**Pros:** zero build dependencies, zero version-skew chores, deploys are pure file
uploads, and a one-line fix is a one-line deploy.
**Cons:** ~3 MB of JavaScript on first load, no tree-shaking, no type checking, no
module resolution (hence globals on `window`).

For a tool a handful of people open and leave open all day, the trade is worth it.
Past roughly two thousand lines of frontend code, revisit with Vite.

## Raw `.eml` in R2, D1 stays lean, browser parses on demand

This area went through three designs. First: raw message in D1, re-parsed in the
browser. Second: parsed worker-side into wide D1 columns, with oversized or
attachment-bearing mail forwarded to a mailbox to dodge D1's limits. Current: the
verbatim `.eml` in R2, a lean index row in D1.

**Why:** D1's 500 MB limit made email the one table that could realistically fill
it, and forwarding on attachment meant attachments were *lost* to a mailbox rather
than retained. R2 (10 GB free, no egress fees) is the right home for opaque blobs,
keeps everything, and removes the size and attachment thresholds entirely. One
write path instead of two.

D1 keeps only what the list, search and agent API need. There is **no body column
at all**; the modal fetches the object and parses it in the browser, so there is
exactly one source for a body, never two that can diverge. Attachments are
retained and downloadable from that parse.

The cost is one object fetch plus an in-browser parse per email opened (a few
hundred milliseconds behind a spinner) and one hard dependency: if the object is
missing, there is no fallback body to show. Since capture is all-or-nothing, that
only happens during a genuine R2 outage, which the UI reports as an error rather
than silently showing a stale copy.

## All-or-nothing email capture (no marker rows)

Earlier designs kept partial records for messages that could not be fully stored:
first a `"sent_to_fallback"` sentinel body, then an `is_fallback` marker row. Both
are gone. Capture is binary: success means the object **and** the row exist;
failure means neither does and the original was forwarded to the fallback inbox.

**Why:** a row that exists but cannot be opened is worse than no row. It is a dead end
in the UI and a trap for an agent. Keeping the two stores strictly in lockstep
means everything the dashboard or an agent can see is fully retrievable, and the
schema loses a column and a special-case render path.

The trade: D1 and R2 share no transaction, so rollback is a pair of compensating
deletes. A failed compensating delete is logged and at worst leaves an invisible
orphaned object, never a visible half-email.

## No purge in the dashboard

Purging lives in `./a51 purge`, not in the UI, and there is no purge API route.

**Why:** emails couple two stores, so a correct purge has to delete the object and
the row in lockstep. That is a chunky destructive surface to put inside a
casual-click UI for a rare admin task. Requests and Autopilot endpoints are
trivially purgeable with SQL. A CLI plus a typed confirmation keeps a
destructive-by-design tool out of the click path.

If purging ever needs to be team-accessible rather than admin-only, bring back a
Function that handles the coupling correctly and put a UI on it. Do not turn the
script into a service.

## Retention is a scheduled worker, not a cron'd script

`./a51 purge` could have been run from a crontab. Retention is a dedicated
Cloudflare Worker instead.

**Why:** there is no host to own a crontab. Everything else here is serverless, and
a laptop or CI schedule silently stops when that machine or account changes. A
Worker cron lives in the same account as everything else and is visible in the same
dashboard. It also gets the bindings natively, in-process, with no API token on
disk.

The two coexist on purpose, with different guarantees: the worker is unattended and
narrow (requests by count, emails by age, nothing else touched); the script is
interactive, age-based for both, and can wipe the `/-/*` namespace.

Requests are trimmed by **count** because volume is spiky and "keep the newest N"
is predictable. Emails are trimmed by **age** because each owns an object and is
worth keeping for a fixed investigation window.

## Eager object fetch when an email opens

The modal used to open on the lean row and fetch the raw message only when the user
clicked *More*, which is why D1 once carried a `text` column.

**Why it changed:** the two-step split the body across two sources and two render
paths. Fetching on open collapses that to one of each, so the view is always the real
message, HTML included, with no "click More for the rest" cliff. That made the
`text` column a second, divergent copy with no reader, so it was dropped.

For agents this was intentional too: `emails_recent_1hr` returns envelope metadata
only, and an agent that needs contents calls `email_raw`. One extra call on the
messages an agent actually cares about, in exchange for a lean database.

## Email grouping is client-side and exact-pair

The Emails tab collapses identical mail into conversation rows.

- **The key is the exact `(from, subject)` pair, and deliberately excludes the
  recipient.** Capture is one-way, so there are no `Re:` / `Fwd:` chains to
  normalize; the flood being fought is an automated sender blasting the same
  subject at many catch-all aliases. Dropping the recipient collapses that whole
  blast into one row, where a from+to+subject key would split it per alias. Exact
  matching stays conservative, and never merges unrelated senders or subjects.
- **Grouping happens client-side over loaded rows.** A `GROUP BY` list query would
  scan the table on every load (the per-row cost the no-counts rule avoids) and
  complicate cursor pagination. The consequence, that a group's membership is
  only as complete as what is loaded, is handled by making the drill-in re-fetch
  authoritatively from the server.
- **No count on a group row.** An accurate total needs a `COUNT(*)` per group. A
  loaded-members count would be free but is a floor dressed up as a figure. So the
  row carries no number: the To cell shows the newest recipient followed by *and
  more*, which is true for any group by construction.
- **Group versus single is marked by shape, not color.** Background is already the
  read/unread channel *and it inverts between themes*; the left edge belongs to pin
  ribbons. That leaves the right edge, where three fanned bars say "not a single
  message" without needing per-theme handling.
- **The fill-to-50 loop has no page cap.** Since grouping can collapse a page to a
  few visible rows, the loop keeps paging until ~50 are displayed. A cap would just
  mean a half-empty view on a spam-heavy load; reads are the same as clicking *Load
  more* manually, just eager.

## Auto-reload on an expired edge session

The dashboard holds no session of its own, so the only session is Cloudflare
Access's. When it expires, an open tab looks healthy until the next API call, which
the edge answers with a redirect the browser follows cross-origin, producing a bare
`Failed to fetch`.

Fixed in the API client rather than at the edge:

- **`redirect: "manual"` on every call.** A same-origin `/api/*` request never
  legitimately redirects, so turning the redirect into an opaque response makes
  session expiry an unambiguous, catchable signal.
- **Reload rather than prompt.** The reload is a navigation, which is exactly what
  the auth hop needs. It either re-mints the cookie silently or lands on the login
  screen. A "click to re-authenticate" banner would be a manual version of the same
  navigation.
- **Narrow trigger.** Only edge-auth-shaped responses reload. An offline
  `TypeError` does not: reloading an offline page replaces the app with the
  browser's error page.
- **Cooldown, not retry.** One auto-reload per 15 seconds, so a page that still
  cannot reach the API shows its error instead of thrashing.

Known trade-off: unsaved modal state is lost. Raising the session duration is the
cheaper mitigation than stashing form drafts.

## File-backed endpoints: server-owned response, separate bucket

- **The server owns status, headers and body for a file endpoint.** A file plus a
  typed body plus a 404 plus a JSON content type has no coherent meaning, so an
  upload forces `200`, the detected `Content-Type`, and an empty body, and the
  modal *unmounts* those editors rather than disabling them, because a grayed-out
  field still invites a click. The trade is worth knowing up front: a test needing
  a `302 Location` or an `Access-Control-Allow-Origin` must use a text endpoint. A
  merge model (user headers underneath, server content type on top) would fit the
  schema if that becomes common.
- **Served inline, never as an attachment.** `Content-Disposition: attachment`
  would break the actual use cases: a DTD, a script, an HTML proof all have to be
  fetched and executed by the target.
- **A separate bucket, not a prefix in the email bucket.** The prefix would have
  cost nothing. The dedicated bucket keeps uploads independently wipeable, leaves
  room for a lifecycle rule (the only retention lever available, since `endpoints`
  has no timestamp), and stops a bucket named for email from quietly holding
  non-email blobs.
- **Raw request body, not multipart.** `request.formData()` buffers the whole upload
  inside the Function; sending the file as the body lets it stream into R2. That
  requires a known `Content-Length` (411 without one), which browsers always send
  for a file, so chunked uploads are simply unsupported.

Orphan discipline mirrors the email pipeline: object written **before** the row with
a compensating delete if the row write fails; the previous object deleted only
**after** the row is repointed; and on delete, object first and row second, so a
failure leaves a visible broken row rather than an invisible orphan. Keys are
random UUIDs so a replace never reuses a key mid-flight.

## No edge cache on Autopilot

An earlier version wrapped the agent read routes in a 60-second edge cache. It was
removed.

**Why:** during an engagement an agent polling `/requests` or `/emails` wants the
freshest possible view, and a stale snapshot can hide the callback its next step
depends on. And the read budget at realistic volumes is small enough that the cache
was not earning its complexity: even one agent polling every 30 seconds against a
busy black hole stays far inside the free daily read quota.

Every call hits D1, and every response sets `Cache-Control: no-store` to discourage
client-side caching too.

## Autopilot is a separate worker, bounded to `/-/*`

Agent access could have been extra routes on the catcher. It is a second worker
with a hardcoded URI prefix instead.

**Why:** the catcher treats every path on every bound domain as target-facing, so
reserved paths there would pollute that namespace and be reachable by probes. The
two also differ in read/write shape, in auth (wide open versus shared secret), and
in blast radius. A confused agent can, at worst, scribble over stubs under `/-/`.

Autopilot also deliberately has **no** binding to the endpoint-files bucket, and
refuses upsert or delete on file-backed URIs: a human staged that payload through
the dashboard, and an agent deleting the row would orphan the object.

## `destroy` empties buckets itself: S3 to list, v4 to delete

`./a51 destroy` removes a non-empty R2 bucket with no manual dashboard step, and
it deletes a Pages project's custom domains before the project. Both are things
Cloudflare refuses to do implicitly (`[10008]` bucket-not-empty, `[8000028]`
project-has-domains).

**Why the split (S3 for listing, v4 for deleting):** the Cloudflare v4 REST API
exposes single-object GET/PUT/DELETE but no dependable object *list*, and the docs
steer you to the S3-compatible API for that. So `destroy` enumerates keys over
R2's S3 endpoint ([cli/lib/r2s3.mjs](../cli/lib/r2s3.mjs), a ~100-line
dependency-free SigV4 signer) and deletes each through the already-used v4
`deleteR2Object`. Keeping the hand-rolled S3 surface to a single signed GET
(no body, no `Content-MD5`, no multi-object-delete XML) is deliberate: less
signing code to get wrong on a destructive path. The signer is checked against
the AWS SigV4 `get-vanilla` known-answer vector.

**No extra credentials.** R2's S3 credentials are derived from the same account
API token the CLI already holds. Access Key ID = the token's id, Secret =
SHA-256 of the token value, so emptying needs nothing a human has to create.

**Only inside the DELETE-DATA gate.** Emptying is destructive, so it runs only
after the second typed confirmation, alongside the database and bucket deletes.
Enumeration is S3-first (not from D1) on purpose: by the time buckets are
deleted the D1 database may already be gone, so D1 can't be the source of keys.

---

# Automation decisions

## The black hole is always the zone apex, and setup does not ask

`./a51 setup` asks which zone to use and nothing else about layout. The black
hole is that zone's apex with both roles; AREA 51 and Autopilot are derived as
`area51.<zone>` and `autopilot.<zone>`. Four prompts (three hostnames and the
roles) were removed.

**Why:** the catch-all rule that delivers mail to the catcher is **zone-scoped** —
`PUT /zones/{id}/email/routing/rules/catch_all` takes no subdomain, and there is
one per zone. It covers the apex *and* every subdomain enabled for Email Routing.
So nothing anywhere on the zone can capture mail until the apex is a mail black
hole, because the apex is what puts the catch-all there in the first place.

Making the apex the primary black hole establishes that foundation once, as part
of the install, and as a bonus makes the HTTP host and the mail domain the same
string so every callback address the CLI prints works. Offering it as a choice
would mean offering a deployment where the mail half silently does nothing: mail
to a subdomain with no MX bounces to the *sender*, which during an engagement is
the target, not the operator. All the operator sees is a callback that never
arrived, and the obvious reading of that is "the vulnerability did not fire" — a
false negative on a finding, the most expensive mistake this tool can cause. Two
CLI lines used to hand out exactly that address.

**This does not mean subdomains cannot capture mail.** They can, and
`./a51 black-holes add sub.example.com mail` does it — see the next entry. The
apex is the foundation, not the only option.

What this costs: the black hole can no longer sit on a subdomain while the apex
serves a decoy site, and mail can no longer be declined for the primary black
hole. Escape hatches remain — `./a51 black-holes add <host> http` adds an
HTTP-only catcher on any hostname, and `DASHBOARD_HOSTNAME` /
`AUTOPILOT_HOSTNAME` set by hand in `.env` are used as-is (including on another
zone) without a prompt. Deliberate but unadvertised: reachable when someone knows
they need them, never hit by accident.

## Mail on a subdomain: enable the name, reuse the zone catch-all

`./a51 black-holes add listen.example.com mail` works, and it refuses unless
`example.com` is already a mail black hole.

Two Cloudflare facts make it work, and both are load-bearing:

- Email Routing is enabled **per name**. `POST /zones/{id}/email/routing/dns`
  with `{"name": "listen.example.com"}` adds and locks MX + SPF for that name.
  This is a different endpoint from `.../email/routing/enable`, which takes no
  name and only ever addresses the apex — the apex path still uses `enable`,
  because it works and there is no reason to move a live install onto a second
  endpoint.
- The zone's catch-all matches the apex **and** every enabled subdomain. So once
  the name has MX, `<anything>@listen.example.com` reaches the same worker with
  no per-subdomain rule to create, and no per-address rules either.

**Why it refuses without the apex:** the catch-all only exists once the apex is a
mail black hole. Enabling a subdomain first would add and *lock* MX records whose
mail has nowhere to be delivered — a black hole that accepts every message and
drops it, which is strictly worse than refusing. The check reads the `domains`
table for the apex row rather than asking Cloudflare, because that table is what
the rest of the tool treats as the truth about which hosts are black holes.

This is also why the subdomain path re-asserts the catch-all after enabling the
name: the `PUT` is idempotent, and it repairs a catch-all somebody repointed by
hand instead of letting the new subdomain's mail vanish alongside the apex's.

## Taking a zone over is confirmed, and typed when the zone is in use

Because mail is no longer opt-in, `setup` states what taking a zone over means
and asks to confirm before provisioning anything.

**Why it escalates:** Email Routing adds and **locks** its own MX for the whole
zone, and the apex address record is replaced by the catcher's Custom Domain.
Neither is undone by walking away. When the zone already has MX or apex records,
setup lists them by name and requires the operator to type `TAKEOVER` — which
`--yes` can never satisfy, matching the rule already in `prompt.mjs` that an
unattended run must not be able to destroy data. An unattended install can no
longer hijack a domain somebody is using.

A clean burner zone gets a plain y/N. Keeping the loud path rare is the point: a
warning that fires on every run is a warning nobody reads. `--dry-run` prints the
disclaimer and the same list of doomed records, then skips the confirmation,
which makes it the safe way to inspect a zone before committing to it.

Setup also refuses to start when a derived hostname already holds a foreign DNS
record. Ownership is tested against the Pages and Workers APIs *first*, not
inferred from DNS, so re-running recognises the records the previous run created
and stays a no-op — without that test the check would refuse every deployment it
had ever built.

## Provisioning goes through the REST API, not wrangler

`./a51 setup` uses the Cloudflare REST API for everything except uploading code:
database, buckets, schema, Custom Domains, DNS, Email Routing, Pages project and
bindings, Access.

**Why:** wrangler is a deployment tool, not a provisioning one. It cannot create a
Pages binding, an Access policy, a catch-all rule or a DNS record, and its
interactive prompts and confirmation flows fight unattended use. The REST API lets
every step be **GET-then-act**, which is what makes the whole command idempotent
and re-runnable. Wrangler still owns code upload and secret installation, where it
is the right tool.

The cost is a hand-written API client (`cli/lib/cloudflare.mjs`) and a dependency
on request shapes Cloudflare could change. It is small, dependency-free, and
`A51_API_BASE` makes it testable against a mock.

## Pages bindings are set before the first upload, via create-then-patch

The project ends up with its D1 and R2 bindings on both the production and preview
configurations *before* the first upload, and its `production_branch` pinned to
`main` (the branch `./a51 deploy` uploads to).

**Why:** the manual flow (deploy, discover every `/api/*` call returns 500, add
three bindings in the dashboard for two environments, redeploy) was the single most
error-prone step in the old setup, and forgetting the preview environment produced
failures that only showed up later. Doing it over the API in the right order
removes the class of problem.

**Why create-then-patch, not create-with-bindings:** creating the project and its
`deployment_configs` in a *single* `POST` is rejected on some accounts with a
generic `[8000000] An unknown error occurred`, while a bare create (name +
`production_branch`) succeeds, which is why wrangler could make the project when
the API couldn't. So `ensurePagesProject` creates minimally, then `PATCH`es the
bindings. The guarantee (bindings present before the upload) is unchanged; only
the call sequence is. `./a51 deploy dashboard` re-asserts the bindings and branch
every time, so a project someone edited by hand, or one wrangler created bare as
a fallback, repairs itself.

**Two failure modes this also closes:**
- **Wrong production branch.** If the API create ever fails outright, wrangler
  creates the project with its production branch defaulted to the local git branch
  and deploys to `main`, a *preview*, so the custom domain serves nothing. Setup
  now pins `production_branch = main` on the patch and redeploys, and treats a
  failed create as "attach bindings + redeploy," not a dead end.
- **Wrong DNS target.** The `*.pages.dev` subdomain is global; a common name like
  `area51` collides and Cloudflare hands back a suffixed one (`area51-xxxx.pages.dev`).
  `ensurePagesDomain` reads the project's *real* subdomain instead of guessing
  `<name>.pages.dev`, and repoints a stale Pages CNAME to it automatically.

## Cloudflare Access is part of setup, not an afterthought

Setup creates the Zero Trust organization, enables one-time PIN login, and puts an
Access application with an allow policy in front of the dashboard.

**Why:** the dashboard has no authentication of its own, and its API can read every
capture and create endpoints. "Remember to lock this down afterwards" is how an
open dashboard happens. Making it a step means the default deployment is protected,
`--no-access` is an explicit choice, and `doctor` can treat "no Access application"
as a failure with a live probe to back it up.

One-time PIN was chosen over integrating an identity provider because it needs no
external configuration: Access emails a code to an allow-listed address. Anyone who
wants an IdP, device posture or an IP rule can compose that in Zero Trust; the code
does not care.

## `.env` is the only state, and the CLI writes to it

There is no separate state file, no lock file, and nothing cached in a home
directory. Setup writes discovered and generated values (account id, database id,
hostnames, generated secret) back into `.env`.

**Why:** an operator can read the whole deployment in one annotated file, and a
teammate can take it over by copying it. Writes are surgical: the `KEY=` line is
replaced in place, with comments and ordering preserved, so it stays the human-readable
document `.env.example` starts as.

The consequence: `.env` is both configuration and state, so losing it means
re-discovering ids (setup can look most of them up by name) and, for
`AGENT_SECRET`, rotating rather than recovering.

## A step that fails does not abort the run

When a provisioning step fails in a way a human can finish in the dashboard, it
prints the exact click-path, records a follow-up, and the run continues. Setup lists
every follow-up at the end and exits `2`.

**Why:** the alternative is a half-provisioned deployment and a stack trace. Most
failures here are one missing token permission or an account-level toggle (R2 not
enabled), and the rest of the deployment is still worth completing. Because every
step is idempotent, fixing the cause and re-running converges. The completed steps
report "already correct" and only the broken one runs again.

## `package-lock.json` is gitignored

The lock file is not committed. `npm install` regenerates it locally.

**Why:** the repo stays at one dependency manifest, and there is no lock file to
review, merge or keep in sync in a project with exactly two direct dependencies.

**What it costs, stated plainly:** installs are not reproducible. Both
dependencies are caret-ranged (`postal-mime: ^2.4.3`, `wrangler: ^4.42.0`), so two
`npm install` runs weeks apart can resolve different minor or patch versions —
including of `wrangler`, which bundles and uploads the Workers, and
`postal-mime`, which parses attacker-controlled email inside the catcher. If a
specific version ever matters, pin the range in `package.json` rather than
committing the lock file back.

Do not read invariant 7 in [CLAUDE.md](../CLAUDE.md) ("`.env` is the only state.
No lock file…") as the reason. That sentence is about *deployment* state — no
Terraform-style state file describing what is provisioned on Cloudflare — and has
nothing to say about npm.

## One `package.json` at the root

The Workers have no manifests of their own; `postal-mime` and `wrangler` are
declared once at the root and resolved upward at bundle time.

**Why:** three near-identical manifests and three lock files were three things to
keep in sync for one shared dependency and one shared tool. One `npm install` now
sets up the whole repository.
