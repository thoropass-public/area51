# Operations

The day-two runbook: deploying changes, managing black holes, purging, reading
logs, watching quotas, rotating secrets, and tearing things down.

This page is *when and why*. For the exhaustive per-command surface, every flag and
every exit code, see [reference/cli](../reference/cli.md).

## Deploying

```bash
./a51 deploy all             # everything: three workers, the dashboard, the schema
./a51 deploy black-holes     # the catcher
./a51 deploy autopilot       # the agent worker
./a51 deploy cleanup         # the retention worker (re-registers its cron)
./a51 deploy dashboard       # re-asserts Pages bindings, then uploads
./a51 deploy schema          # re-apply db/schema.sql (idempotent)
```

Each Worker deploy re-renders its `wrangler.toml` from
`wrangler.toml.template` + `.env`, so a configuration change and a code change
ship the same way. The generated files are gitignored; never edit them.

Deploys are independent. Shipping the dashboard does not touch the catcher, and a
schema addition does not require redeploying anything (unless code reads the new
column).

`git push` deploys nothing. There is no CI integration and no Pages Git build:
uploads happen from your machine, through the CLI.

## Adding and removing black holes

```bash
./a51 black-holes list
./a51 black-holes add other.example                  # asks which roles
./a51 black-holes add other.example http,mail        # or pass them
./a51 black-holes add http-only.example http
./a51 black-holes add listen.example mail            # email capture on a subdomain
./a51 black-holes remove other.example
```

`add` does everything a black hole needs: binds the hostname to the catcher as a
Custom Domain (`http`), enables Email Routing **for that name** and confirms the
zone catch-all points at the catcher (`mail`), and writes the row the dashboard
and Autopilot read. No redeploy needed: the next page load and the next agent
call see it.

With no roles argument it asks for HTTP, email, or both.

**Mail on a subdomain** needs no manual step — Email Routing is enabled per name
and the zone catch-all already covers every enabled subdomain. The one
prerequisite is that the subdomain's **own zone apex is already a mail black
hole**; `setup` did that for your primary zone, and for any other zone you add
its apex first:

```bash
./a51 black-holes add other.example.net http,mail    # the foundation
./a51 black-holes add listen.example.net mail        # then the subdomain
```

Adding the subdomain first is refused: the catch-all that delivers its mail only
exists once the apex has it, so enabling the name would lock MX records whose
mail goes nowhere.

An apex `mail` add always asks for confirmation, because Email Routing locks its
MX for the whole zone. If records are actually going to be replaced they are
listed and the gate becomes a typed `TAKEOVER`.

The hostname must be on a zone the API token can see. DNS and the certificate take
a minute or two.

`remove` drops the row and detaches the Custom Domain. It deliberately leaves
Email Routing alone, because that is a zone-wide setting another black hole on the
same zone may still need. Captured data from that host stays until purged.

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

```bash
./a51 tail black-holes
./a51 tail autopilot
./a51 tail cleanup
./a51 tail black-holes -- --format=json | jq 'select(.event=="email_capture_failed")'
```

Every worker emits one JSON object per event. Event names are listed in
[black-holes.md](../internals/black-holes.md#log-events), [autopilot.md](../internals/autopilot.md) and
[cleanup.md](../internals/cleanup.md#watching-it). Logs are also persisted and queryable in the
Cloudflare dashboard (`[observability] enabled = true` in every config).

Pages Functions log to the Pages project's own log stream, not to `wrangler tail`.
Find them under Workers & Pages → *project* → Deployments → *deployment* → Logs.

## Health checks

```bash
./a51 status          # configuration + what is deployed
./a51 doctor          # verify every binding, domain and policy; probe the live hosts
./a51 doctor --fix    # re-apply schema, Pages bindings, domain bindings, Access policy
```

Run `doctor` after any change you did not make through the CLI, after a failed
setup, and when something is behaving strangely. It is read-only without `--fix`.


## Rotating an Autopilot key

```bash
./a51 users rotate-secret <email>
```

Mints a fresh key for that one operator, writes its hash, and prints the new key
and the re-registration line. The old key dies the moment the row is written and
there is no dual-key window, so that operator's agents break until they are
re-registered — but **only theirs**: keys are per person, so rotating one does
not disturb anyone else.

Rotate when someone's key has been pasted somewhere it should not have been, when
a device is lost, or on a schedule you set. When someone leaves, use
`./a51 users remove <email>` instead — that closes the dashboard too.

## Lost or stolen device

The machine that ran `./a51` holds `.env`, which contains the **Cloudflare API
token**. No operator key is stored on any machine the CLI runs on. If a device with
that file is lost or stolen, assume both are exposed and act immediately, in this
order. None of these steps need the lost machine:

1. **Revoke the Cloudflare API token.** Cloudflare dashboard → *My Profile → API
   Tokens* → find the AREA 51 deploy token (named for the deployment, e.g.
   `AREA 51 deploy - <domain>`) → **Roll** or **Delete**. This instantly kills
   provisioning and deploy access. Mint a fresh token when you redeploy and put it
   in the new machine's `.env`.
2. **Rotate the Autopilot secret** from a trusted machine that still has the repo
   and a valid token: `./a51 users rotate-secret <their email>`, then have them
   re-register their agents. The old key stops working the moment the new row is
   written — and because keys are per person, only that one operator is affected,
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
./a51 users                                   # same as `list` — read-only
./a51 users list                              # who has access, and their key ids
./a51 users add teammate@work.com             # add an operator, print their key once
./a51 users remove teammate@work.com          # revoke both doors
./a51 users rotate-secret teammate@work.com   # issue them a new key
./a51 users sync                              # reconcile Cloudflare with D1
```

One command for one person, because a deployment has two doors and they work
completely differently:

| | Dashboard | Autopilot |
|---|---|---|
| Guarded by | Cloudflare Access | The D1 `users` table |
| Credential | **None** — Cloudflare emails a one-time PIN | `Authorization: Bearer <key>` |
| Takes effect | On the next login | Immediately, no redeploy |

The `users` table is the source of truth for both, and every change re-pushes
the Access allow-list derived from it. There is no `ALLOWED_EMAILS` to edit — a
second copy of the list could only ever drift from the one being enforced. If a
push fails (a missing permission, Zero Trust not yet activated), the table is
still correct: fix the cause and run `./a51 users sync`.

**Keys are shown once.** `add` and `rotate-secret` print the new key and only the
hash is kept, so it cannot be read back later. Hand it over out of band; if it is
lost, rotate rather than hunt for it. Rotating revokes the old key instantly, so
every agent using it must be re-registered.

**Removing the last operator** closes Autopilot but not the dashboard: Cloudflare
Access requires at least one identity in an allow policy, so the application
keeps its previous policy until somebody is added. The command says so.


Existing sessions keep working until they expire. Revoke them in Zero Trust →
Access → *your app* if that matters.

## Renaming things

`WORKER_NAME`, `AGENT_WORKER_NAME`, `CLEANUP_WORKER_NAME`, `PAGES_PROJECT_NAME`,
`D1_DATABASE_NAME` and both bucket names are Cloudflare identities. Changing one in
`.env` does **not** rename anything:

- **A Worker.** The next deploy creates a *new* Worker. The old one keeps running
  and keeps its Custom Domains, so both are live and one of them is stale. Rebind
  the domains (`./a51 black-holes add …`) and delete the old Worker in the dashboard.
- **The Pages project.** The next deploy creates a new project with a new
  `*.pages.dev` subdomain; the custom domain stays with the old one until moved.
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
| Workers requests | 100 K/day | every target request, every dashboard API call, every agent call |
| Pages builds | n/a | direct upload, no builds |

Notes:

- **The request log is the storage risk**, not email: bodies are stored inline in
  D1. The cleanup worker's `CLEANUP_REQUESTS_KEEP` is the lever.
- **Search is a full table scan** (`LIKE '%term%'`), and reads are billed per row
  scanned. Prefer narrower terms on large tables.
- **No row counts anywhere in the UI** for exactly this reason
  ([decisions.md](../decisions.md#no-row-counts-anywhere-in-the-ui)).
- Usage lives in the Cloudflare dashboard: D1 → *database* → Metrics, R2 → *bucket*,
  Workers & Pages → *worker* → Metrics.

## Tearing it down

```bash
./a51 destroy
```

Two gates. The first (`REMOVE`) deletes the three Workers, the Pages project, the
dashboard DNS record and the Access application, all rebuildable from this
repository. The second (`DELETE-DATA`) deletes the database and both buckets,
which is permanent. Answering no to the second leaves your captures intact and
lets `./a51 setup` rebuild on top of them.

**No manual dashboard steps.** `destroy` handles the two cases Cloudflare refuses
to do implicitly, so the whole teardown stays one command:

- **Pages custom domains** are detached before the project is deleted (Cloudflare
  will not delete a project that still has one, `[8000028]`).
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
how the whole zone handles mail rather than just removing AREA 51 — but leaving
it behind means the domain still advertises mail service nothing answers, with
records you cannot edit while they stay locked. Declining is fine; you can
disable it later at dashboard → Email → Email Routing → Settings.

`.env` is never touched. Delete it yourself when you are done.
