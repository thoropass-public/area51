# Operations

The day-two runbook: deploying changes, managing black holes, purging, reading
logs, watching quotas, rotating secrets, and tearing things down.

## Deploying

```bash
./a51 deploy all             # everything: three workers, the dashboard, the schema
./a51 deploy black-holes     # the catcher
./a51 deploy autopilot       # the agent worker (also reinstalls AGENT_SECRET)
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
./a51 domains list
./a51 domains add other.example http,mail
./a51 domains add http-only.example http
./a51 domains remove other.example
```

`add` does all three things a black hole needs: binds the hostname to the catcher
as a Custom Domain, enables Email Routing on the zone with a catch-all to the
catcher (with the `mail` role), and writes the row the dashboard and Autopilot
read. No redeploy — the next page load and the next agent call see it.

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
| **Emails** | Deletes non-starred `emails` older than N days — the object **first**, then the row, and only for objects confirmed deleted. |
| **Autopilot endpoints** | Deletes every `/-/*` row, plus the uploaded object of any file-backed row among them. |

**Never** run `DELETE FROM emails` in the D1 console. The `.eml` objects would
stay behind unreachable, and nothing would ever list them again. The whole reason
this command exists is that the two stores have to move together.

Unattended retention is the cleanup worker's job — see [cleanup.md](cleanup.md).
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
[black-holes.md](black-holes.md#log-events), [autopilot.md](autopilot.md) and
[cleanup.md](cleanup.md#watching-it). Logs are also persisted and queryable in the
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

`--no-probes` skips the outbound HTTP checks (useful when your network blocks
them).

## Rotating the Autopilot secret

```bash
./a51 rotate-secret
```

Generates 32 fresh bytes, installs them as the Worker Secret, updates `.env`, and
prints the re-registration command. Every agent breaks until re-registered; there
is no dual-secret window. Rotate when someone leaves, when a secret has been
pasted somewhere it should not have been, or on a schedule you set.

## Changing who can log in

```bash
./a51 access --list                             # show the current allow-list (read-only)
./a51 access --add new@gmail.com,asca.com       # add entries, keep the existing ones
./a51 access --remove new@gmail.com             # remove entries, keep the rest
./a51 access                                    # re-apply ALLOWED_EMAILS from .env
```

`--add` / `--remove` edit the allow-list incrementally against what is already in
`ALLOWED_EMAILS`. Entries are full addresses (`you@example.com`) or bare domains
(`example.com`), normalised to lowercase. Both write the result to the Access
policy **and** back to `ALLOWED_EMAILS` in `.env`.

There is no positional "replace the whole list" form — it was removed as a
footgun (it silently wiped any entry you forgot to re-type). **To set the list
wholesale**, edit `ALLOWED_EMAILS` in `.env` and run a bare `./a51 access`, which
re-applies exactly what the file says. You cannot leave the list empty (that would
make the dashboard public — use `./a51 setup --no-access` if you truly want that).
Existing sessions keep working until they expire — revoke them in Zero Trust →
Access → *your app* if that matters.

## Renaming things

`WORKER_NAME`, `AGENT_WORKER_NAME`, `CLEANUP_WORKER_NAME`, `PAGES_PROJECT_NAME`,
`D1_DATABASE_NAME` and both bucket names are Cloudflare identities. Changing one in
`.env` does **not** rename anything:

- **A Worker** — the next deploy creates a *new* Worker. The old one keeps running
  and keeps its Custom Domains, so both are live and one of them is stale. Rebind
  the domains (`./a51 domains add …`) and delete the old Worker in the dashboard.
- **The Pages project** — the next deploy creates a new project with a new
  `*.pages.dev` subdomain; the custom domain stays with the old one until moved.
- **The database or a bucket** — you get a *new empty* one. The old data is still
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
  ([decisions.md](decisions.md#no-row-counts-anywhere-in-the-ui)).
- Usage lives in the Cloudflare dashboard: D1 → *database* → Metrics, R2 → *bucket*,
  Workers & Pages → *worker* → Metrics.

## Tearing it down

```bash
./a51 destroy
```

Two gates. The first (`REMOVE`) deletes the three Workers, the Pages project, the
dashboard DNS record and the Access application — all rebuildable from this
repository. The second (`DELETE-DATA`) deletes the database and both buckets,
which is permanent. Answering no to the second leaves your captures intact and
lets `./a51 setup` rebuild on top of them.

**No manual dashboard steps.** `destroy` handles the two cases Cloudflare refuses
to do implicitly, so the whole teardown stays one command:

- **Pages custom domains** are detached before the project is deleted (Cloudflare
  will not delete a project that still has one — `[8000028]`).
- **Non-empty R2 buckets** are emptied before deletion (R2 refuses to delete a
  bucket with objects — `[10008]`). Emptying happens only inside the `DELETE-DATA`
  gate. It lists the objects over R2's S3 API using credentials derived from your
  existing API token — nothing extra to create — and deletes them via the REST
  object API. See [decisions.md](decisions.md#destroy-empties-buckets-itself-s3-to-list-v4-to-delete).

`destroy` is also safe to re-run over a half-torn-down deployment: anything
already gone (a worker, the database, a bucket) is skipped rather than erroring.

Email Routing is left enabled on the zone — it has its own locked DNS records,
and disabling it is a zone-level decision (dashboard → Email → Email Routing).

`.env` is never touched. Delete it yourself when you are done.
