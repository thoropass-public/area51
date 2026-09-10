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

If counts come back, do it with counters and triggers, not `COUNT(*)`. Note that
`./a51 deploy schema` cannot apply a trigger, so those have to go on with
`wrangler d1 execute --file`
([database.md](reference/database.md#migrations)). The one
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
two also differ in read/write shape, in auth (wide open versus a per-operator
key), and in blast radius. A confused agent can, at worst, scribble over stubs
under `/-/`.

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
R2's S3 endpoint ([cli/lib/r2s3.mjs](../cli/lib/r2s3.mjs), a ~135-line
dependency-free SigV4 signer) and deletes each through the already-used v4
`deleteR2Object`. Keeping the hand-rolled S3 surface to a single signed GET
(no body, no `Content-MD5`, no multi-object-delete XML) is deliberate: less
signing code to get wrong on a destructive path. That minimal surface is the
whole mitigation. There is no test suite here
([development.md](development.md#testing)), so the signer is not verified against
a known-answer vector. If it ever grows past this one GET, that check is the
first thing to add.

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

**Why:** the catch-all rule that delivers mail to the catcher is **zone-scoped**.
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
arrived, and the obvious reading of that is "the vulnerability did not fire": a
false negative on a finding, the most expensive mistake this tool can cause. Two
CLI lines used to hand out exactly that address.

**This does not mean subdomains cannot capture mail.** They can, and
`./a51 black-holes add <sub.black-hole.tld> mail` does it, as the next entry
explains. The apex is the foundation, not the only option.

What this costs: the black hole can no longer sit on a subdomain while the apex
serves a decoy site, and mail can no longer be declined for the primary black
hole. Escape hatches remain. `./a51 black-holes add <host> http` adds an
HTTP-only catcher on any hostname, and `DASHBOARD_HOSTNAME` /
`AUTOPILOT_HOSTNAME` set by hand in `.env` are used as-is (including on another
zone) without a prompt. Deliberate but unadvertised: reachable when someone knows
they need them, never hit by accident.

## Mail on a subdomain: enable the name, reuse the zone catch-all

`./a51 black-holes add <sub.black-hole.tld> mail` works, and it refuses unless
`<black-hole.tld>` is already a mail black hole.

Two Cloudflare facts make it work, and both are load-bearing:

- Email Routing is enabled **per name**. `POST /zones/{id}/email/routing/dns`
  with `{"name": "<sub.black-hole.tld>"}` adds and locks MX + SPF for that name.
  This is a different endpoint from `.../email/routing/enable`, which takes no
  name and only ever addresses the apex. The apex path still uses `enable`,
  because it works and there is no reason to move a live install onto a second
  endpoint.
- The zone's catch-all matches the apex **and** every enabled subdomain. So once
  the name has MX, `<anything>@<sub.black-hole.tld>` reaches the same worker with
  no per-subdomain rule to create, and no per-address rules either.

**Why it refuses without the apex:** the catch-all only exists once the apex is a
mail black hole. Enabling a subdomain first would add and *lock* MX records whose
mail has nowhere to be delivered. That is a black hole that accepts every message
and drops it, which is strictly worse than refusing. The check reads the `domains`
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
setup lists them by name and requires the operator to type `TAKEOVER`, which
a reflexive Enter cannot clear. Hijacking a domain somebody is using now takes
deliberate typing.

A clean burner zone gets a plain y/N. Keeping the loud path rare is the point: a
warning that fires on every run is a warning nobody reads. `--dry-run` prints the
disclaimer and the same list of doomed records, then skips the confirmation,
which makes it the safe way to inspect a zone before committing to it.

A derived hostname that already holds a foreign DNS record is reported rather
than fatal: setup names the record, skips that hostname's own steps, provisions
everything else, and lists the conflict as a follow-up (exit `2`), the same
rule as every other step, below. Ownership is tested against the Pages and
Workers APIs *first*, not inferred from DNS, so re-running recognizes the
records the previous run created and stays a no-op. Without that test the check
would refuse every deployment it had ever built.

## A confirmed takeover clears the name itself

Cloudflare will not create a Worker Custom Domain on a hostname that already has
an address record it did not create for that Worker. It answers
`[100117] Hostname 'x' already has externally managed DNS records (A, CNAME,
etc). Delete them first or try a different hostname.` A domain worth pointing
targets at is usually in exactly that state: a parked A record, or a CNAME left
behind by a Pages project or another Worker.

So `ensureBlackHole` treats that refusal as a step rather than an end. It
releases the name, then binds again. The alternative was a follow-up asking the
operator to go and delete DNS records by hand, right after they had typed
`TAKEOVER` on a screen that listed those same records and said the apex address
record would be replaced. Asking for consent and then not acting on it is worse
than not asking at all.

Three rules keep this from becoming an accident:

- **Nothing is released speculatively.** The clear-out runs only after Cloudflare
  has said the name is occupied. An ordinary re-run binds a name that is already
  ours, the upsert succeeds, and nothing is deleted.
- **It only applies where consent was taken.** Both callers of `ensureBlackHole`
  name the doomed records first and gate on a typed `TAKEOVER`. The derived
  hostnames (`area51.<zone>`, `autopilot.<zone>`) get no such prompt, so they
  keep the older behavior: report the conflict, skip the step, carry on.
- **Ask the owner before touching DNS.** A Worker Custom Domain is detached, a
  Pages custom domain is detached, and only what is left is deleted as a DNS
  record. Deleting Cloudflare's managed record behind its owner's back leaves
  that product still claiming a hostname it no longer serves, and the DNS API
  does not reliably allow it anyway.

Whatever could not be released is named in the follow-up, with the dashboard
click-path for it. `[100117]` on its own does not say which product is holding
the name, which is how this failed the first time.

## Provisioning goes through the REST API, not wrangler

`./a51 setup` uses the Cloudflare REST API for everything except uploading code:
database, buckets, schema, Custom Domains, DNS, Email Routing, Pages project and
bindings, Access.

**Why:** wrangler is a deployment tool, not a provisioning one. It cannot create a
Pages binding, an Access policy, a catch-all rule or a DNS record, and its
interactive prompts and confirmation flows fight unattended use. The REST API lets
every step be **GET-then-act**, which is what makes the whole command idempotent
and re-runnable. Wrangler still owns code upload, where it
is the right tool.

The cost is a hand-written API client (`cli/lib/cloudflare.mjs`) and a dependency
on request shapes Cloudflare could change. It is small, dependency-free, and
`A51_API_BASE` makes it testable against a mock.

## The dashboard is a Worker, not a Pages project

The dashboard is a Worker with static assets (`dashboard/wrangler.toml.template`):
`public/` holds the six static files, `src/` holds the API, and `[assets]
run_worker_first = ["/api/*"]` decides which of the two answers a request. It was
a Cloudflare Pages project with Pages Functions until v1.1.0.

**Why:** one hostname instead of three, and that is a security property rather
than a tidiness one.

A Pages project answers on its custom domain **and** `<project>.pages.dev` **and**
every preview deployment under `*.<project>.pages.dev`. Cloudflare Access is
enforced per hostname at the edge, so guarding only `DASHBOARD_HOSTNAME` left the
`pages.dev` URLs an **unauthenticated bypass** onto every captured request and
email. The old `ensureAccess` therefore read the project back, discovered its real
(possibly globally suffixed) subdomain, and wrote three destinations; `doctor` had
a dedicated check that *failed the deployment* if either extra one went missing,
and `verify-deployment.md` had a section teaching operators to eyeball all three.

A Worker with `workers_dev = false` and `preview_urls = false` has exactly one
hostname. There is no second URL to enumerate, keep in sync, or leave open. The
Access app has one destination because there is only one thing to guard.

Cloudflare also now recommends Workers over Pages for new projects, and ships new
features only there — but that was the tiebreaker, not the reason.

**What it deleted.** Four workarounds that existed solely because Pages behaved
the way it did:

- **Bindings had nowhere to live.** A Pages project's D1 and R2 bindings exist
  only in Cloudflare's API, so `setup` had to `PATCH` them on — onto *both* the
  production and preview deployment configs, before the first upload, or every
  `/api/*` call 500d for a missing `DB`. And creating a project *with*
  `deployment_configs` in one `POST` is rejected on some accounts with a generic
  `[8000000] An unknown error occurred`, so it had to be create-then-patch.
  `doctor --fix` re-applied them to repair hand edits. They are declared in
  `dashboard/wrangler.toml.template` now, under version control, and travel with
  the upload like every other worker's.
- **`production_branch` had to be pinned.** If the API create failed, wrangler
  made the project with its production branch defaulted to the local git branch,
  so `./a51 deploy` landed on `main` as a *preview* and the custom domain served
  nothing. `doctor` checked for this.
- **The `*.pages.dev` subdomain is a global namespace.** A common name like
  `area51` collides, and Cloudflare hands back a suffixed one
  (`area51-xxxx.pages.dev`). Anything pointing at a guessed `<name>.pages.dev`
  pointed at a host that was not ours, so `ensurePagesDomain` had to read the real
  subdomain and repoint stale CNAMEs, and `doctor` had to check the CNAME target.
- **No observability at all.** Pages Functions support neither Workers Logs,
  Logpush, Tail Workers, nor source maps. A 500 from `/api/endpoints/upload` was a
  `console.error` into a void. The worker enables `[observability]` and
  `upload_source_maps`.

**What it costs.** Pages derived the route table from the shape of the
`functions/` directory — `[id]` for a dynamic segment, `onRequestGet` for the
method — and resolved match precedence invisibly. A Worker is one `fetch`
handler, so that table is now written down in `src/index.js` and matched by
`src/router.js`. Adding an endpoint is two edits instead of one, and precedence
is something code has to get right. That is a real, permanent cost; it is smaller
than the four items above.

**Cost on the Cloudflare bill: unchanged.** Static-asset requests are free and
unlimited on both plans and do not count as Worker invocations, and Pages
Functions were billed on the same Workers meter as any other worker. The billable
surface is the same set of `/api/*` calls either way. This is why
`run_worker_first` is scoped to `["/api/*"]` and not set to `true`: `true` — which
is what most examples show — would make every page load, stylesheet and `.jsx`
fetch a billable invocation for nothing. `not_found_handling = "none"` likewise
lets the asset layer 404 unknown paths without invoking the worker.

**What was deliberately NOT done: folding the API into Autopilot.** It looks like
an obvious consolidation — one worker, one binding set, shared D1 helpers, both
are REST over the same database. It must not happen. Autopilot has **no `FILES`
binding on purpose** and is fenced to `/-/*`; the dashboard writes `FILES` and
manages endpoints at any URI. Merging them would hand any Autopilot key holder
the ability to read, replace or delete a payload a human staged. See
[Autopilot is a separate worker, bounded to `/-/*`](#autopilot-is-a-separate-worker-bounded-to--).

**Undoing it** means restoring all four workarounds above, and re-teaching Access
to guard three hostnames — including the wildcard, which does not match the apex,
so both extra destinations are needed and each is separately forgettable.

## One test file, for route precedence, and only that

`dashboard/src/router.test.mjs` is the only test file in the repository. Plain
node, no dependencies, no framework: `node dashboard/src/router.test.mjs`.

**Why an exception to "no test suite":** `./a51 doctor` works as the acceptance
test because nearly everything here fails *loudly* — a missing binding 500s, an
unbound hostname answers 530, a broken worker will not deploy. Route precedence is
the one thing that does not. Two routes can match one path (`/api/endpoints/upload`
matches both the literal route and `/api/endpoints/:uri`), and picking the wrong
one throws nothing, deploys fine, and leaves `doctor` reporting a healthy
dashboard: the request simply reaches the wrong handler. In that specific case it
would run a D1 lookup for an endpoint named `"upload"` and answer a plausible
404. Pages resolved this for free and invisibly; now it is code, and the first
draft of `router.js` got it wrong in exactly that way.

**Why it cannot rot:** it parses the `ROUTES` table out of `src/index.js` rather
than restating it, so a route added there is covered here automatically, and a
renamed table fails the run loudly instead of silently testing nothing.

**Scope discipline:** it asserts precedence, parameter capture (endpoint URIs
arrive percent-encoded, and `%2F` must stay inside one segment), and 404-vs-405.
It does not test handlers, D1, or R2 — those fail loudly and `doctor` covers them.
Turning this into a general test suite is a different decision from the one made
here.

## Cloudflare Access is part of setup, not an afterthought

Setup creates the Zero Trust organization, enables one-time PIN login, and puts an
Access application with an allow policy in front of the dashboard.

**Why:** the dashboard has no authentication of its own, and its API can read every
capture and create endpoints. "Remember to lock this down afterwards" is how an
open dashboard happens. Making it a step means the default deployment is protected,
there is no flag to skip it, and `doctor` treats "no Access application" as a
failure with a live probe to back it up.

One-time PIN was chosen over integrating an identity provider because it needs no
external configuration: Access emails a code to an allow-listed address. Anyone who
wants an IdP, device posture or an IP rule can compose that in Zero Trust; the code
does not care.

## One `users` table for both doors, and per-operator keys

**Decision:** a single D1 `users` table is the source of truth for *both* ways
into a deployment, and `./a51 users` is the only command that touches either.
The Autopilot shared secret and the `access` command are gone, along with
`ALLOWED_EMAILS`.

**Why one command:** a person is one thing. Before this there were two commands
and two mental models for the same teammate:
`./a51 access add <teammate@domain.tld>` for the dashboard, and
`./a51 rotate-secret` (which rotated *everyone's* secret) for agents.
Off-boarding somebody meant remembering both, and rotating for one leaver broke
every other operator's agents.

**Why they still authenticate separately:** they have to. Cloudflare Access
authenticates a *person* by mailing a one-time PIN, so there is no key we could
issue and no exchange we own. Autopilot authenticates a *client* with a bearer
key. Neither can be expressed in the other's terms, so the table is the seam:
Access gets an allow-list derived from `email`, Autopilot reads `key_hash`, and
neither knows the other exists.

**Why D1 and not `.env`:** the same reason as `domains`. A list in `.env` is a
copy of something Cloudflare or a Worker actually enforces, and a copy can drift
invisibly. In D1 it is read live, so `users add` works with no redeploy, and
`doctor` can compare the table against what Access enforces and report drift in
either direction.

**Why hashes, and a key shown once:** storing keys would make `.env` a vault of
other people's credentials and a D1 dump a set of working logins. Only
`sha256(<whole key>)` is kept, so a lost key is rotated rather than recovered.

There is **no exception for your own key.** An earlier draft kept it in `.env` so
`doctor` could prove the deployment accepts a real key. That bought one
diagnostic and cost the model its only clean sentence: "a key is shown once" was
true for everyone except the person most likely to leak one. It also created a
loop nobody would enjoy: rotating your own key left `.env` holding the dead one,
and `doctor`'s fix hint told you to rotate again. `doctor` now proves what it can
without a credential (an unknown key must come back `401`, not `503`), and
rotating takes two seconds.

**Why the key has two halves.** `<key_id>_<secret>`: the 8-hex id is public and
is the row lookup; the 64-hex tail is the credential. Keeping the lookup on a
public value means nothing derived from the secret reaches an index or the query
planner, and the comparison that decides the request stays a constant-time one
over hashes, in the worker. The id is also what makes a call attributable. It
is safe to log, so worker logs name the operator without naming the key.

**Why an empty operator set writes an explicit deny.** When the last operator is
removed there is nobody to put in the list, and Cloudflare does not document how
an include rule behaves when the list it names is empty. "Probably nobody
matches" is not a safe inference for the only control in front of every captured
request and email, so the policy is rewritten to an explicit deny-everyone
instead. Adding an operator restores the allow. This is the one case where a
routine `users` command touches the Access application rather than just the list.

**Why `Authorization: Bearer` and not a custom header.** Log pipelines, proxies,
devtools, HAR exports and Cloudflare's own request logging already redact
`Authorization` by default. `X-A51-Secret` got none of that, and these keys get
pasted into terminals, CI configs and screenshots during engagements.

**What it costs:**

- **Every agent had to be re-registered.** The old raw-hex secret does not match
  `^[0-9a-f]{8}_[0-9a-f]{64}$`, so it fails on shape before any database lookup.
  That is deliberate, but the benefit is in the logs, not the response: the
  caller still gets a plain `401`, while the worker records
  `agent_unauthorized` with `reason: "malformed_key"`, which you can tell apart
  from `unknown_key_id` (a well-formed key that is not in the table) when you
  read the worker's Logs. Troubleshooting a key that stopped working at the upgrade
  is [a documented row](guides/troubleshooting.md); the fix is
  `./a51 users rotate-key <email>`.
- **One D1 row read per Autopilot call.** A primary-key lookup, against a worker
  that already queries D1 on every route. Not cached, so `users remove` revokes
  instantly rather than up to an hour later.
- **D1 becomes an availability dependency for auth.** Handled explicitly: an
  unreachable database answers `503`, never `401`, so nobody debugs a key that is
  fine.
- **Two copies of the allow-list, not one.** Cloudflare Access cannot read D1,
  because its policies are enforced at Cloudflare's edge from Cloudflare's own
  config, so the addresses have to be *projected* into a Zero Trust email list
  the policy points at. That copy is mandatory, which is what separates it from
  `ALLOWED_EMAILS`: the list is the enforcement point, `.env` would have been a
  third copy with no job. Every mutation writes D1, re-reads D1, and `PUT`s the
  full set, so a hand edit in the Cloudflare dashboard does not survive the next
  `users` command. `doctor` reconciles the two and `users sync` repairs them, in
  one direction only.
- **A 14th token permission.** Zero Trust lists live under the Gateway resource
  tree, so `Account · Zero Trust:Edit` is required on top of `Access: Apps and
  Policies:Edit`. A token with the latter can rewrite the whole application and
  still not add one address to the list its policy depends on.

## `.env` is the only state, and the CLI writes to it

There is no separate state file, no lock file, and nothing cached in a home
directory. Setup writes discovered and provisioned values (account id,
database id, hostnames) back into `.env`.

**Why:** an operator can read the whole deployment in one annotated file, and a
teammate can take it over by copying it. Writes are surgical: the `KEY=` line is
replaced in place, with comments and ordering preserved, so it stays the human-readable
document `.env.example` starts as.

The consequence: `.env` is both configuration and state, so losing it means
re-discovering ids, which setup can mostly do by name. It holds exactly one
secret, the Cloudflare API token; no operator key is ever written to it.

What is deliberately *not* in `.env` is any list that Cloudflare or a Worker
enforces live: black holes (`domains`) and operators (`users`) are both D1
tables. A copy in `.env` could only ever drift from what is actually being
enforced, and the drift would be invisible.

## A step that fails does not abort the run

When a provisioning step fails in a way a human can finish in the dashboard, it
prints the exact click-path, records a follow-up, and the run continues. Setup lists
every follow-up at the end and exits `2`.

**Why:** the alternative is a half-provisioned deployment and a stack trace. Most
failures here are one missing token permission or an account-level toggle (R2 not
enabled), and the rest of the deployment is still worth completing. Because every
step is idempotent, fixing the cause and re-running converges. The completed
steps re-report as `·`, meaning already correct, and only the broken one does
work again.

**That now covers unexpected failures too, not just anticipated ones.** The
`followUps` pattern only caught what a helper had been written to expect. Anything
else, such as a Cloudflare error on a call with no specific handler, a network
blip, or a bug, unwound to the top-level catch and abandoned the run. Every step
is now wrapped in `attempt()` (`cli/lib/provision.mjs`), which converts a throw
into a follow-up and reports whether the step worked. The exceptions are the
four upload steps and the Autopilot hostname, which reach the same outcome by
their own route: a `deployWorker(...).ok` / `deployPages(...).ok` check, or a
local try/catch that pushes a follow-up. The rule is the behavior, not the helper: **no step may
abandon the run**, whichever way it reports.

**Dependent steps skip rather than fail again.** `attempt()` returns `{ok, value}`
so a caller can tell the difference between "this failed" and "this cannot be
attempted": no worker is uploaded without a database id to bind, and a hostname
blocked by a foreign DNS record is not provisioned. Four identical errors for one
root cause is worse than one error and three honest skips.

`deploy all` follows the same rule: every target runs even if one fails, and the
report says how many succeeded. So does `doctor --fix`, because a tool whose job
is listing everything wrong must not hide every check after the first repair that
throws.

The only fatal errors left are the ones that make everything downstream
meaningless: no API token, a rejected token, no account, an unresolvable zone.

## There is no local dev server

`./a51 dev` wrapped `wrangler dev` for the workers and `wrangler pages dev` for the
dashboard. It was removed, and the npm `dev:*` scripts with it.

**Why:** the two things most worth testing before a deploy cannot be exercised
locally at all. The `email()` handler is only ever invoked by Cloudflare Email
Routing, so email capture always needed a real deployment; and the local Pages
server has no edge auth, so the expired-session path did too. What remained was a
reload loop for the dashboard against an empty local D1 and R2, and since
`wrangler pages dev` has no `--remote` flag, that loop could never see real
captured data. Against a three-second `./a51 deploy`, it did not earn a command, a
flag surface, and four docs pages explaining what it could not reach.

The loop is now deploy-and-look ([development.md](development.md)), on a throwaway
zone rather than one carrying an engagement.

What went with it, and what replaced it: the cleanup worker's `--test-scheduled`
trigger was a local simulation of a cron the worker has no other entry point for.
Use `./a51 purge` for the same outcome, and the worker's Logs in the Cloudflare
dashboard to watch a real run.

## Wrangler's output is captured, not inherited

Worker and Pages uploads run with piped stdio. Each reports one line with a
duration; the full log appears only when the command fails, or under `--verbose`.

**Why:** wrangler is chatty. Three worker deploys plus a Pages upload used to bury
`setup`'s own report, meaning the plan, the follow-ups and the summary, under
several screens of build output. An operator who has to scroll to find the one line that
mattered will eventually stop looking, and the lines that matter here are things
like "the dashboard is NOT protected".

Failure is the one time the full log earns its space, so that is exactly when it is
replayed. `--verbose` restores the raw stream up front for when a step is
misbehaving and the calls themselves are what you need to see.

## There is no unattended mode

`--yes` / `A51_YES=1` was removed. Every prompt is answered by a person, and the
commands that prompt refuse to run without a TTY rather than hanging on
end-of-input.

**Why:** the flag's whole job was to supply answers nobody had given, and the
worst case was concrete rather than theoretical. On a fresh install `--yes` made
the Access allow-list prompt optional (`required: !isAssumeYes()`), so an
unattended `./a51 setup` skipped Cloudflare Access entirely and published a
world-readable dashboard, one that can read every captured request and email.
The plan block flagged it in yellow, and `--yes` auto-accepted the plan.

Every prompt in this CLI sits in front of something that provisions or destroys
live infrastructure: taking over a zone's mail, replacing an apex record, deleting
a database. "Take the default" is not a safe answer to any of those, and a flag
that says "assume the safe thing" cannot exist when the safe thing is what the
question was asking about.

What this costs: `./a51 setup`, `purge`, `destroy`, `users` and
`black-holes add` cannot run from CI. That is intended, since none of them
should. The read-and-upload commands never call a prompt, so **`status`,
`doctor` and `deploy` remain fully scriptable**, which is the half worth
automating.

`--no-access` went the same way, and for the same reason: a flag whose only effect
is publishing an archive of client data is not a convenience.

## `package-lock.json` is gitignored

The lock file is not committed. `npm install` regenerates it locally.

**Why:** the repo stays at one dependency manifest, and there is no lock file to
review, merge or keep in sync in a project with exactly two direct dependencies.

**What it costs, stated plainly:** installs are not reproducible. Both
dependencies are caret-ranged (`postal-mime: ^3.0.0`, `wrangler: ^4.42.0`), so two
`npm install` runs weeks apart can resolve different minor or patch versions,
including of `wrangler`, which bundles and uploads the Workers, and
`postal-mime`, which parses attacker-controlled email inside the catcher. If a
specific version ever matters, pin the range in `package.json` rather than
committing the lock file back.

Do not read the "`.env` is the only state. No lock file…" invariant in
[CLAUDE.md](../CLAUDE.md) as the reason. That sentence is about *deployment*
state, meaning no Terraform-style state file describing what is provisioned on
Cloudflare, and it has nothing to say about npm.

## One `package.json` at the root

The Workers have no manifests of their own; `postal-mime` and `wrangler` are
declared once at the root and resolved upward at bundle time.

**Why:** three near-identical manifests and three lock files were three things to
keep in sync for one shared dependency and one shared tool. One `npm install` now
sets up the whole repository.

## Copyright is stated, no trademark is claimed

`NOTICE` carries the Thoropass copyright line, the Apache-2.0 pointer and the
third-party component list. It claims no trademarks, and an earlier paragraph
asserting that "the AREA 51 name" and the brand artwork were trademarks of
Thoropass, Inc. has been removed.

**Why:** the two are unrelated and only one of them applies. Copyright arose
automatically when the code was written and belongs to Thoropass as a work made
for hire, and stating it is what makes the Apache-2.0 grant valid: a license
gives away rights the licensor holds, so with no copyright there is nothing to
grant and downstream users have no clear permission. Apache-2.0 also *requires*
the notice to survive redistribution (§4(c), §4(d)).

A trademark is different: it protects a name used to identify who makes
something, and it has to be earned through use as a brand. "AREA 51" is a famous
government facility and a piece of general culture with decades of prior use by
everyone, Thoropass sells nothing under that name, and the term is not
registrable. Asserting a mark that cannot be defended reads as overreach and
achieves nothing.

Nothing is lost by staying silent, because **Apache-2.0 §6 already denies any
trademark grant** to the licensor's trade names, marks and product names. That
protection comes with the license choice; restating it in `NOTICE` was redundant
even where a real mark existed.

**What it costs, stated plainly:** the brand artwork under
`.github/assets/brand` is in an Apache-2.0 repository, so a fork may
redistribute the alien mark and the lockups along with the code. That is
accepted rather than overlooked. If it ever needs to change, carve the directory
out with an explicit note in `NOTICE` naming its own terms, rather than
reintroducing a blanket trademark claim over the project name.

## The stored subject is normalized before it reaches D1

`handleEmail` runs the parsed subject through `collapseFolding()`, which reduces
every whitespace run to a single space, before writing it to the `emails` row.
The raw `.eml` in R2 is never touched.

**Why:** postal-mime 3.0.0 changed how folded headers unfold. Per RFC 5322 it now
removes the CRLF but *keeps* the whitespace that followed it, where 2.x had
collapsed every run to one space. A subject wrapped by the sender's MTA therefore
started arriving with embedded tabs and multi-space runs.

That would have been cosmetic anywhere else, but the stored subject is the email
list's **grouping key**: rows sharing an exact `(from_addr, subject)` pair collapse
into one group, and the same string is passed to `setGroupRead` and
`listEmailGroup`. Storing the folding whitespace would have split otherwise
identical messages into separate groups and, worse, split them *across the upgrade
boundary*, because every row captured under 2.x holds the collapsed form.
Normalizing on write makes a message captured before and after the bump produce a
byte-identical key, so the upgrade is invisible to grouping.

The same reasoning drives the display-side collapse in the dashboard's headers
block ([dashboard.md](internals/dashboard.md)), for a different reason: there it
is only legibility, since Cloudflare's own `Received` and `ARC-*` headers fold
with tabs and long space runs.

**What it costs:** a subject whose *original* whitespace was meaningful — two
spaces the sender actually typed — is stored collapsed. Header folding is
indistinguishable from intentional whitespace once the CRLF is gone, so no parser
can tell them apart, and the raw `.eml` remains the source of truth for anyone who
needs the exact bytes.
