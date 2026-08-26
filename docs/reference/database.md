# Data model

Storage is split in two on purpose:

- **D1** (SQLite at the edge) holds *metadata*: small, queryable rows the list
  views, search and the agent API need.
- **R2** (object storage) holds *opaque blobs*: verbatim `.eml` messages and
  uploaded endpoint payloads.

The split exists because D1's limits (2 MB per row, 500 MB per database on the
free plan) make it the wrong home for a 12 MB email with attachments, while R2 is
10 GB free with no egress fees. See
[decisions.md](../decisions.md#raw-eml-in-r2-d1-stays-lean-browser-parses-on-demand).

The schema is `db/schema.sql`. Apply or re-apply it with:

```bash
./a51 deploy schema      # or ./a51 doctor --fix
```

Every statement is `CREATE … IF NOT EXISTS`, so this is safe against a live
database and never drops data.

---

## `endpoints`

The map of `URI path → response` the catcher serves. A row is either
**text-backed** or **file-backed**; `r2_key IS NULL` is the discriminator.

| Column | Type | Notes |
|---|---|---|
| `uri` | `TEXT PRIMARY KEY` | Exact `url.pathname` match. `/api/foo` matches only `/api/foo`. No globs, no parameters, no trailing-slash equivalence. |
| `status` | `INTEGER NOT NULL DEFAULT 200` | Status to serve. Forced to `200` on file-backed rows. |
| `headers` | `TEXT` | JSON object, stringified. Stored as JSON so arbitrary header sets need no side table. On a file-backed row it is exactly `{"Content-Type":"<detected>"}`, written by the server. |
| `body` | `TEXT` | Response body. Subject to D1's 2 MB row limit. Always `''` on a file-backed row. |
| `r2_key` | `TEXT` | Object key (a random UUID) in the files bucket. `NULL` = text endpoint. Internal, never returned by the API. |
| `filename` | `TEXT` | Original upload name. **Display only**; never used to build a response header. |

No timestamp column. Nothing surfaces one, the catcher does not need one, and
its absence is why uploads have no automatic retention and why the Autopilot
purge wipes the whole `/-/*` namespace rather than purging by age.

**File-backed endpoints** exist so you can host a real artifact (a DTD, a
compiled payload, an image, a `.well-known` document) instead of pasting text
into a body field. The response is entirely server-owned: `200`, the detected
`Content-Type`, served **inline** (no `Content-Disposition`, because a hosted
payload has to execute rather than download). The trade: a file endpoint cannot
carry a custom status or extra headers, so a test needing a `302 Location` or an
`Access-Control-Allow-Origin` must use a text endpoint.

The `/-/*` prefix inside this table is reserved for Autopilot
([autopilot.md](../internals/autopilot.md)). The dashboard treats those rows like any other.

## `requests`

Every HTTP request that reached a black hole.

| Column | Type | Notes |
|---|---|---|
| `id` | `TEXT PRIMARY KEY` | UUIDv4 from the worker |
| `ts` | `TEXT NOT NULL` | ISO 8601 UTC. Indexed `DESC`. |
| `method` | `TEXT NOT NULL` | |
| `url` | `TEXT NOT NULL` | Full URL including scheme, host, path and query. This is how you tell which black hole was hit |
| `ip` | `TEXT` | `cf-connecting-ip`, or `'unknown'` |
| `ua` | `TEXT` | User-Agent, or `'unknown'` |
| `headers` | `TEXT` | JSON object of every request header, stringified |
| `body` | `TEXT` | Raw body as text; a read error stores `''` |

Index: `idx_requests_ts ON requests(ts DESC)`, which backs newest-first cursor
pagination.

Trimmed by count by the cleanup worker (newest `CLEANUP_REQUESTS_KEEP` kept).

## `emails`

A **lean index row** per captured message. The full message lives only in the
raw `.eml` in R2. **There is no body column:** the dashboard and Autopilot both
read the body from the object on demand.

| Column | Type | Notes |
|---|---|---|
| `id` | `TEXT PRIMARY KEY` | UUIDv4; also the object key (`emails/<id>.eml`) |
| `ts` | `TEXT NOT NULL` | ISO 8601 UTC. Indexed `DESC`. |
| `from_addr` | `TEXT NOT NULL` | The **`From:` header** address (`parsed.from.address`), which is what the dashboard shows and what the blacklist matches. `''` if parsing failed or the message had no `From:`. The SMTP envelope sender is deliberately *not* used as a fallback; it is recoverable from the raw `.eml`. |
| `to_addr` | `TEXT NOT NULL` | Envelope recipient (`message.to`), the catch-all address the sender used |
| `subject` | `TEXT` | From the parsed message |
| `attachment_count` | `INTEGER NOT NULL DEFAULT 0` | Attachment details come from the raw `.eml`; this is just the count for the list view |
| `read` | `INTEGER NOT NULL DEFAULT 0` | UI state. Written **only** by the dashboard. |
| `starred` | `INTEGER NOT NULL DEFAULT 0` | UI state, dashboard-only. Backs the Starred filter **and exempts the row from retention**. |

Index: `idx_emails_ts ON emails(ts DESC)`.

Every row has a matching object in R2, because capture is all-or-nothing
([black-holes.md](../internals/black-holes.md#email-handler)), so a row the UI or an agent can
see is always fully retrievable.

## `ip_blacklist` and `email_blacklist`

Write filters consulted at the top of each handler. Exact match only: no CIDR
ranges, no patterns.

| Column | Type | Notes |
|---|---|---|
| `ip` / `email` | `TEXT PRIMARY KEY` | Exact value. Email is stored lowercase; the worker lowercases the `From:` address before comparing. |
| `ts` | `TEXT NOT NULL` | When it was added |
| `note` | `TEXT` | Optional label ("shodan scanner"). Available in the API; not surfaced in the UI. |

Behavior on a match:

- **IP** → immediate `403`. The body is never read, the endpoint table is never
  consulted, nothing is written to `requests`.
- **Email** → `message.setReject('Address not accepted')`. The message is NACKed
  so the sender's server generates a bounce. No object, no row, no forward.

The worker reads each list at most **once per 60 minutes per data center**
(`caches.default`). Dashboard changes therefore take up to an hour to propagate
in both directions. That is intentional: a blacklist here is a noise filter, not
a security boundary, and the long TTL removes the list lookup from the hot path.
On a query error the worker uses an empty set, since a database blip must not block
captures.

## `domains`

The configured black holes, and the single source of truth for them.

| Column | Type | Notes |
|---|---|---|
| `domain` | `TEXT PRIMARY KEY` | The hostname, e.g. `example.com` |
| `roles` | `TEXT NOT NULL` | JSON array, subset of `["http","mail"]` |

Read live by the dashboard (`/api/config/domains`, for the Home host picker) and by
Autopilot (`/domains`, `list_black_holes`), so an agent can build
`https://<domain>/-/<path>`. Managed by `./a51 domains`; changes apply on the
next page load or agent call, with no redeploy.

A row here does **not** by itself make a hostname work. The Custom Domain and
mail routing are the other two thirds. `./a51 domains add` does all three;
`./a51 doctor` flags a row whose hostname is not actually bound.

---

## R2: captured email

Bucket `R2_BUCKET_NAME`, bound as `EML` on the catcher, Autopilot, the cleanup
worker and Pages. One object per message:

```
emails/<uuid>.eml      Content-Type: message/rfc822
```

Written by the catcher on capture. Read on demand by the dashboard
(`/api/emails/<id>/raw`, fetched when the modal opens) and by Autopilot
(`/emails/<id>/raw`, gated to messages from the last 60 minutes). Deleted by the
cleanup worker and by `./a51 purge`.

**Never delete rows from `emails` with raw SQL.** The objects would stay behind
as an invisible storage leak. `./a51 purge` deletes the object first and only
then the row, so a failure leaves a visible row to retry rather than an
unreachable object.

## R2: endpoint files

Bucket `R2_FILES_BUCKET_NAME`, bound as `FILES` on the catcher (read) and Pages
(write + delete). One object per file-backed endpoint, keyed by a **random
UUID**, not derived from the URI, so replacing a file writes a fresh key and
deletes the old one, with no read-your-write window and no percent-encoding
inside keys. The object's own `httpMetadata.contentType` is the authority on what
gets served; D1 stores no duplicate.

**Autopilot has no `FILES` binding.** It can see that an endpoint is file-backed
(the `file` descriptor in its responses) but cannot read, replace or delete the
object, and its upsert/delete tools refuse file-backed URIs outright, because a human
staged that payload, and an agent deleting the row would orphan the blob.

Nothing ages these out: `endpoints` has no timestamp. An upload lives until its
endpoint is deleted (or `./a51 purge` wipes its `/-/*` row). A bucket lifecycle
rule is the lever if that ever becomes a problem.

---

## Deliberate omissions

- **No counters table, and no `COUNT(*)` in the UI.** D1 bills per row *read*, so
  counting scans. See [decisions.md](../decisions.md#no-row-counts-anywhere-in-the-ui).
- **No foreign keys.** Requests are not linked to the endpoint that matched them;
  the three logs are independent.
- **No soft deletes.** Delete is delete. Purging is out-of-band and unrecoverable.
- **No actor / created_by columns.** Access control happens at the network edge,
  not in the data model; from the database's point of view there is one user.

## Migrations

There is no migration framework. The schema is idempotent and additive, so:

- **New table or index:** add it to `db/schema.sql` with `IF NOT EXISTS` and run
  `./a51 deploy schema`.
- **New column:** add it to `db/schema.sql` *and* apply an `ALTER TABLE` to
  existing deployments, because `CREATE TABLE IF NOT EXISTS` will not alter an
  existing table:

  ```bash
  npx wrangler d1 execute <db> --remote \
    --command "ALTER TABLE emails ADD COLUMN priority INTEGER NOT NULL DEFAULT 0"
  ```

  `./a51 doctor` checks for the columns added after the first release
  (`emails.read`, `emails.starred`, `emails.attachment_count`, `endpoints.r2_key`,
  `endpoints.filename`) and prints the exact `ALTER TABLE` if one is missing. Add
  new checks there when you add a column.
- **Dropped column:** remove it from the schema and every `SELECT`, then
  `ALTER TABLE … DROP COLUMN` on live deployments. Every query in the codebase
  lists columns explicitly, so a dropped column fails loudly rather than
  silently.

## Ad-hoc queries

```bash
# newest requests
npx wrangler d1 execute area51 --remote \
  --command "SELECT ts, method, url, ip FROM requests ORDER BY ts DESC LIMIT 10"

# all endpoints
npx wrangler d1 execute area51 --remote \
  --command "SELECT uri, status, filename FROM endpoints ORDER BY uri"
```

The Cloudflare dashboard's D1 console works too. Remember that reads are billed
per row scanned, and that `DELETE FROM emails` there is the one query you must
not run.
