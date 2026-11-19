# Operations

The day-two runbook: deploying changes, managing black holes, purging, reading
logs, watching quotas, rotating keys, and tearing things down.

This page is *when and why*. For the exhaustive per-command surface, every flag and
every exit code, see [reference/cli](../reference/cli.md).

## Deploying

```bash
./a51 deploy all             # everything: four workers (dashboard included), the schema
./a51 deploy black-holes     # the catcher
./a51 deploy autopilot       # the agent worker
./a51 deploy cleanup         # the retention worker (re-registers its cron)
./a51 deploy dashboard       # src/ as the worker, public/ as its static assets
./a51 deploy schema          # re-apply db/schema.sql (idempotent)
```

Each Worker deploy re-renders its `wrangler.toml` from
`wrangler.toml.template` + `.env`, so a configuration change and a code change
ship the same way. The generated files are gitignored; never edit them.

Deploys are independent. Shipping the dashboard does not touch the catcher, and a
schema addition does not require redeploying anything (unless code reads the new
column).

`git push` deploys nothing. There is no CI integration and no Git-connected
build: uploads happen from your machine, through the CLI.

## Adding and removing black holes

```bash
./a51 black-holes list
./a51 black-holes add <other-black-hole.tld>      # a zone apex, nothing else
./a51 black-holes remove <other-black-hole.tld>
```

A black hole is a **whole Cloudflare zone** handed over to the catcher. Every
path on it serves your endpoints, every address on it is captured, and there is
nothing to configure per host: no roles, no surfaces to pick between. Another
black hole is another zone.

`add` does all three parts: binds the apex to the catcher as a Custom Domain,
enables Email Routing on the zone and points its catch-all at the catcher, and
writes the row the dashboard and Autopilot read. No redeploy needed. The next
page load and the next agent call see it.

**`add` takes the zone apex only.** A subdomain is refused, with a pointer to the
recipes below. That is mechanics before it is policy: the catch-all rule that
delivers mail to the catcher is zone-scoped, so the apex is what makes a zone
capture anything at all, and a subdomain was never an alternative to it.

Every add asks for confirmation, because Email Routing locks its MX for the whole
zone. If records are actually going to be replaced they are listed by name and
the gate becomes a typed `TAKEOVER`. Those records are then really replaced: a
Worker holding the hostname is detached from it, a plain DNS record is deleted,
and the catcher is bound in its place. Anything else serving the name is
reported for you to detach yourself.

The zone must be on the Cloudflare account the API token can see. DNS and the
certificate take a minute or two.

### Primary and secondary

The zone you ran `./a51 setup` on is the **primary** black hole. It is a black
hole like any other, with the apex bound to the catcher, a zone catch-all and a
row in the table. What sets it apart is that AREA 51 itself lives on it:
`area51.<zone>` is the dashboard,
`autopilot.<zone>` is Autopilot, and the zone-wide catch-all attached to it is
what makes this deployment capture mail at all.

Every zone you add afterwards is **secondary**: a catcher and nothing else.

`./a51 black-holes list` and `./a51 status` mark which is which, and the
difference shows up in exactly one more place. **The primary cannot be
removed**:

```
$ ./a51 black-holes remove my-zone.tld
my-zone.tld is the primary black hole and cannot be removed.
```

It is read from `BLACK_HOLE_HOSTNAME` in `.env`, not from a column in the table.
To move AREA 51 onto a different zone, point `.env` at it
(`CLOUDFLARE_ZONE`, `BLACK_HOLE_HOSTNAME`, `DASHBOARD_HOSTNAME`,
`AUTOPILOT_HOSTNAME`) and re-run `./a51 setup`; the old apex becomes an ordinary
black hole and `remove` will take it. To tear everything down, use
`./a51 destroy`.

### Removing

`remove` refuses the primary. For any other host it works in this order,
Cloudflare state first and the D1 row last, so a run that dies halfway leaves a
black hole that still reports itself rather than bindings with nothing naming
them:

1. **Mail subdomains on the zone are found and offered up.** Any subdomain
   enabled for Email Routing has locked MX records of its own, and the only
   reason mail to it reaches the catcher is the catch-all this black hole put
   there. Left behind, each one keeps accepting mail that is then delivered
   nowhere, which is worse than bouncing because nobody finds out. They are
   listed and removed on your say-so, records and all.
2. The Custom Domain is detached, which stops HTTP capture.
3. The row is dropped.

**Email Routing on the zone itself is left enabled**, because disabling it is a
decision about the whole zone and it unlocks and deletes the apex MX. Turn it off
at zone → Email → Email Routing when nothing on that zone still needs capture, or
let `./a51 destroy` ask you as part of a full teardown.

Captured requests and emails from the host stay until purged.

Removing a **subdomain** row left over from an older deployment works too, and
offers to take that one name's Email Routing entry and MX records with it.
Nothing creates such rows any more.

## Putting a subdomain on the catcher

Subdomains are deliberately outside the CLI. The catcher needs nothing from AREA
51 to handle one. It serves whatever hostname reaches it, and its email handler
never looks at the `domains` table. So everything in this section is a Cloudflare
dashboard step, opt-in, and AREA 51 stays out of it.

One trade-off applies to all of them. A subdomain added this way is **captured
but not listed**. It will not show up in `./a51 black-holes list`, in the
dashboard's Home chips, or in Autopilot's `list_black_holes`. Captures from it
land in Requests and Emails like any other. Keep your own note of what you turned
on.

### HTTP on one subdomain

Workers & Pages → the catcher worker → Settings → Domains & Routes → Add →
Custom Domain → `<sub.black-hole.tld>`. Cloudflare creates the DNS record and the
certificate. From then on `https://<sub.black-hole.tld>/<any path>` is captured.

### HTTP on every subdomain

A wildcard, so any name a target invents is already live. `https://whatever.<black-hole.tld>/`
is captured without anyone setting it up first.

This has three parts and you need all three. The first two on their own will take
your own dashboard offline.

**1. A wildcard DNS record, proxied.** A Workers Route only runs on a name that
resolves through Cloudflare, so the names have to exist before the route can see
them.

zone → DNS → Records → Add record:

| Field | Value |
|---|---|
| Type | `AAAA` |
| Name | `*` |
| IPv6 address | `100::` |
| Proxy status | Proxied (orange cloud) |

`100::` is the IPv6 discard address. Nothing is ever sent there. The record
exists so the name resolves, and the orange cloud is what puts Cloudflare in the
path.

**2. A wildcard route to the catcher.** Workers & Pages → the catcher worker →
Settings → Domains & Routes → Add → Route:

| Field | Value |
|---|---|
| Zone | `<black-hole.tld>` |
| Route | `*.<black-hole.tld>/*` |

**3. One route each for your own two hostnames.** This is the part that catches
people out. A Workers Route beats a Worker Custom Domain on the same zone, so the
route you just added also swallows `area51.<zone>` and `autopilot.<zone>`. Your
dashboard and your agent API would both start answering as the catcher.

Routes are ranked against each other by how specific they are, and a literal
hostname beats a wildcard. So add one route per hostname, each pointing at its
own worker:

| Worker | Route |
|---|---|
| dashboard, `DASHBOARD_WORKER_NAME` | `area51.<black-hole.tld>/*` |
| Autopilot, `AGENT_WORKER_NAME` | `autopilot.<black-hole.tld>/*` |

Then check it, because a missing carve-out looks fine until someone tries to log
in:

```bash
./a51 doctor
```

`doctor` probes all three hostnames from your machine. It expects the dashboard
to redirect to the Access login and Autopilot to answer `401`. If a carve-out is
missing or points at the wrong worker, the catcher answers instead and those
checks fail.

What the wildcard does not change:

- **The apex.** `*.<zone>` does not match `<zone>` itself. The apex keeps its
  Custom Domain on the catcher and nothing about it moves.
- **Mail.** Email Routing is a separate system. A wildcard HTTP route captures no
  mail at all. See the next section.
- **What AREA 51 knows.** Nothing here writes to the `domains` table, so
  `./a51 black-holes list` still shows the apex and nothing else.

Two limits worth knowing before you rely on it:

- Universal SSL covers `<zone>` and `*.<zone>`, one level deep. A name like
  `a.b.<zone>` matches the route but has no certificate, so HTTPS to it fails.
  Cloudflare sells Advanced Certificate Manager if you need those.
- If you remove the wildcard route later, delete the `*` DNS record too.
  On its own it leaves every subdomain resolving to Cloudflare with no worker
  behind it, which answers an error page rather than not resolving at all.

### Mail on one subdomain

The zone's apex has to be a black hole already, because that is what put the
catch-all rule in place.

Then: zone → Email → Email Routing → Settings → Subdomains → add
`<sub.black-hole.tld>`. Cloudflare adds and locks MX and SPF records for that
name, and the zone catch-all, which covers the apex and every enabled subdomain,
delivers it to the catcher. `<anything>@<sub.black-hole.tld>` is captured right
away.

There is no wildcard version of this. Email Routing enables subdomains one name
at a time, so each one is its own trip through that screen.

Remove it the same way, from the same screen. `./a51 black-holes remove` on the
zone's apex also finds these and offers to clear them for you, which matters
because MX records left pointing at a catch-all that no longer delivers anywhere
will swallow mail instead of bouncing it.

## Purging data

```bash
./a51 purge
```

An interactive menu with three options, each gated by typing `PURGE`:

| Option | What it does |
|---|---|
| **Requests** | Deletes `requests` rows older than N days. Database only. |
| **Emails** | Deletes non-starred `emails` older than N days. The object goes **first**, then the row, and only for objects confirmed deleted. |
| **Autopilot endpoints** | Deletes every `/-/*` row, plus the uploaded object of any file-backed row among them. |

**Never** run `DELETE FROM emails` in the D1 console. The `.eml` objects would
stay behind unreachable, and nothing would ever list them again. The whole reason
this command exists is that the two stores have to move together.

Unattended retention is the cleanup worker's job; see [cleanup.md](../internals/cleanup.md).
Use `./a51 purge` for one-off clear-downs (end of an engagement) and for the
things the worker never touches.

## Reading logs

Every worker emits one JSON object per event, and every worker config sets
`[observability] enabled = true`, so logs are persisted and searchable in the
Cloudflare dashboard: **Workers & Pages → *worker* → Logs**. That is where to
read them, and there is no CLI wrapper for it.

Event names are listed in
[black-holes.md](../internals/black-holes.md#log-events),
[autopilot.md](../internals/autopilot.md#log-events) and
[cleanup.md](../internals/cleanup.md#watching-it).

For a live stream, wrangler does it directly:

```bash
npx wrangler tail area51-black-holes
npx wrangler tail area51-black-holes --format=json | jq 'select(.event=="email_capture_failed")'
```

Those are the default service names; if you changed `WORKER_NAME`,
`AGENT_WORKER_NAME`, `CLEANUP_WORKER_NAME` or `DASHBOARD_WORKER_NAME` in `.env`,
`./a51 status` prints the ones actually deployed.

The dashboard reads the same way as the rest: `wrangler tail area51-dashboard`,
or Workers & Pages → *worker* → Logs. Its config sets `upload_source_maps = true`,
so a 500 from `/api/*` resolves to a real line number rather than a minified
one.

## Health checks

```bash
./a51 status          # configuration + what is deployed
./a51 doctor          # verify every binding, domain and policy; probe the live hosts
./a51 doctor --fix    # re-apply schema, domain bindings, Access policy
```

Run `doctor` after any change you did not make through the CLI, after a failed
setup, and when something is behaving strangely. It is read-only without `--fix`.


## Rotating an Autopilot key

```bash
./a51 users rotate-key <email>
```

Mints a fresh key for that one operator, writes its hash, and prints the new key
and the re-registration line. The old key dies the moment the row is written and
there is no dual-key window, so that operator's agents break until they are
re-registered. But **only theirs**: keys are per person, so rotating one does
not disturb anyone else.

Rotate when someone's key has been pasted somewhere it should not have been, when
a device is lost, or on a schedule you set. When someone leaves, use
`./a51 users remove <email>` instead, which closes the dashboard too.

## Lost or stolen device

The machine that ran `./a51` holds `.env`, which contains the **Cloudflare API
token**, and nothing else secret. No operator key is ever stored on a machine
the CLI runs on. If a device with that file is lost or stolen, assume the token is
exposed, and assume any key that operator kept on it is too. Act immediately, in
this order. None of these steps need the lost machine:

1. **Revoke the Cloudflare API token.** Cloudflare dashboard → *Manage Account → API
   Tokens* → find the AREA 51 deploy token (named for the deployment, e.g.
   `AREA 51 deploy - <domain>`) → **Roll** or **Delete**. This instantly kills
   provisioning and deploy access. Mint a fresh token when you redeploy and put it
   in the new machine's `.env`.
2. **Rotate their Autopilot key** from a trusted machine that still has the repo
   and a valid token: `./a51 users rotate-key <their email>`, then have them
   re-register their agents. The old key stops working the moment the new row is
   written, and because keys are per person, only that one operator is affected,
   not everybody. If the device is gone for good, `./a51 users remove <their
   email>` revokes both doors outright.
3. **Revoke dashboard sessions.** Zero Trust → *Access* → your app → revoke active
   sessions, so a still-logged-in browser on the lost device is cut off. Consider a
   shorter `ACCESS_SESSION_DURATION` going forward.
4. **Treat the black-hole domain as potentially burned** if it was tied to live
   engagements: save any evidence, `./a51 purge` the captures, and move new work to
   a fresh burner domain.

## Changing who can log in

```bash
./a51 users                                   # same as `list`, read-only
./a51 users list                              # who has access, and their key ids
./a51 users add <teammate@domain.tld>         # add an operator, print their key once
./a51 users remove <teammate@domain.tld>      # revoke both doors
./a51 users rotate-key <teammate@domain.tld>  # issue them a new key
./a51 users sync                              # reconcile Cloudflare with D1
```

One command for one person, because a deployment has two doors and they work
completely differently:

| | Dashboard | Autopilot |
|---|---|---|
| Guarded by | Cloudflare Access | The D1 `users` table |
| Credential | **None**. Cloudflare emails a one-time PIN | `Authorization: Bearer <key>` |
| Takes effect | On the next login | Immediately, no redeploy |

The `users` table is the source of truth for both, and every change re-pushes
the Access allow-list derived from it. There is no `ALLOWED_EMAILS` to edit,
because a second copy of the list could only ever drift from the one being
enforced. If a push fails (a missing permission, Zero Trust not yet activated),
the table is still correct: fix the cause and run `./a51 users sync`.

**Keys are shown once.** `add` and `rotate-key` print the new key and only the
hash is kept, so it cannot be read back later. Hand it over out of band; if it is
lost, rotate rather than hunt for it. Rotating revokes the old key instantly, so
every agent using it must be re-registered.

**Removing the last operator shuts the dashboard to everyone.** Their key dies
with the row, and the Access policy is replaced by an explicit deny-everyone.
Cloudflare does not document what an empty allow-list matches, so the deny is
written rather than inferred. The command warns before doing it, and adding
someone restores the allow.


Existing sessions keep working until they expire. Revoke them in Zero Trust →
Access → *your app* if that matters.

## Renaming things

`WORKER_NAME`, `AGENT_WORKER_NAME`, `CLEANUP_WORKER_NAME`,
`DASHBOARD_WORKER_NAME`, `D1_DATABASE_NAME` and both bucket names are Cloudflare
identities. Changing one in `.env` does **not** rename anything:

- **A Worker**, the dashboard included. The next deploy creates a *new* Worker.
  The old one keeps running and keeps its Custom Domains, so both are live and one
  of them is stale. Rebind the domains (`./a51 setup` for the dashboard and
  Autopilot, `./a51 black-holes add …` for a catcher) and delete the old Worker in
  the dashboard.
- **The database or a bucket.** You get a *new empty* one. The old data is still
  there, still billed, and nothing points at it. Migrate deliberately or not at all.

If you must rename, plan it as: create new → move domains → verify → delete old.

## Quotas and cost

Typical pentest volumes sit inside Cloudflare's free tier. The limits that matter:

| Resource | Free limit | What consumes it |
|---|---|---|
| D1 storage | 500 MB | request rows (headers + body) dominate |
| D1 reads | 5 M rows/day | list views, agent polling, the daily requests scan |
| D1 writes | 100 K rows/day | one row per captured request and per captured email |
| R2 storage | 10 GB | captured `.eml` (with attachments) and endpoint uploads |
| R2 egress | free | serving payloads and raw-message downloads |
| Workers requests | 100 K/day | every target request, every `/api/*` dashboard call, every agent call |
| Static assets | free, unlimited | the dashboard's HTML, CSS, `.jsx` and favicon; these do **not** count as Worker requests |

Notes:

- **The request log is the storage risk**, not email: bodies are stored inline in
  D1. The cleanup worker's `CLEANUP_REQUESTS_KEEP` is the lever.
- **Search is a full table scan** (`LIKE '%term%'`), and reads are billed per row
  *scanned*, not returned. A leading wildcard cannot use an index, so one search
  reads the whole table: against 200 K captured requests that is 200 K row reads
  per search, and the free tier's 5 M rows/day allows roughly 25 of them before
  D1 starts refusing queries. On Workers Paid the 25 B rows/month included makes
  this a non-issue. Prefer narrower terms on large tables, and keep
  `CLEANUP_REQUESTS_KEEP` sane.
- **No row counts anywhere in the UI** for exactly this reason
  ([decisions.md](../decisions.md#no-row-counts-anywhere-in-the-ui)).
- Usage lives in the Cloudflare dashboard: D1 → *database* → Metrics, R2 → *bucket*,
  Workers & Pages → *worker* → Metrics.

## Tearing it down

```bash
./a51 destroy
```

Two gates. The first (`REMOVE`) deletes the four Workers, the dashboard DNS
record and the Access application, all rebuildable from this repository. The second (`DELETE-DATA`) deletes the database and both buckets,
which is permanent. Answering no to the second leaves your captures intact and
lets `./a51 setup` rebuild on top of them.

**No manual dashboard steps.** Deleting a Worker takes its Custom Domains and
their DNS records with it, so there is nothing to detach first. That leaves one
case Cloudflare refuses to do implicitly:

- **Non-empty R2 buckets** are emptied before deletion (R2 refuses to delete a
  bucket with objects, `[10008]`). Emptying happens only inside the `DELETE-DATA`
  gate. It lists the objects over R2's S3 API using credentials derived from your
  existing API token, so there is nothing extra to create, and deletes them via the REST
  object API. See [decisions.md](../decisions.md#destroy-empties-buckets-itself-s3-to-list-v4-to-delete).

`destroy` is also safe to re-run over a half-torn-down deployment: anything
already gone (a worker, the database, a bucket) is skipped rather than erroring.

**Email Routing is offered for teardown** inside the first gate: `destroy` finds
every zone this deployment enabled it for, and disabling it deletes the MX, SPF
and DKIM records Cloudflare added and locked. It asks first, because that changes
how the whole zone handles mail rather than just removing AREA 51. But leaving
it behind means the domain still advertises mail service nothing answers, with
records you cannot edit while they stay locked. Declining is fine; you can
disable it later at dashboard → Email → Email Routing → Settings.

`.env` is never touched. Delete it yourself when you are done.
