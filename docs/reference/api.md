# Dashboard HTTP API

Base path `https://<dashboard-host>/api/`, served by Pages Functions in
`dashboard/functions/api/`. It is consumed **same-origin** by the dashboard
frontend and by nothing else: there is no CORS header, no API key, and no
versioning. Authentication is entirely Cloudflare Access at the edge — a request
that reaches a Function has already been authorised.

Autopilot's agent-facing API is a **separate** surface on a separate worker with
its own auth; see [autopilot.md](../internals/autopilot.md).

## Conventions

- **Success** — HTTP 200 with a JSON body. Lists return a bare array. Detail
  routes return the row object. Mutations return `{ok: true}` (plus extras).
- **Errors** — `{error: "message"}` with `400` (bad input), `404`
  (`{error: "Not found"}`), `411` / `413` (upload size), or `500`
  (`{error: "Internal error"}`). Every handler is wrapped in `withErrorHandler`
  (`functions/api/_shared.js`), which logs the real error via `console.error` and
  returns the generic 500.
- **Pagination** — cursor-based. Page size is fixed at **50** (`PAGE_SIZE` in
  `_shared.js`). The cursor is the natural sort key of the last row returned:
  `uri` for endpoints (ascending), `ts` for requests and emails (descending).
  Pass it as `?cursor=`. "Has more" is inferred client-side from
  `results.length === PAGE_SIZE`.
- **Search** — `?search=` may be **repeated**. Terms are ORed inside a
  parenthesised group, which is ANDed with the cursor. Matching is
  `LIKE '%term%'`, i.e. a full table scan; fine at this scale, and
  `ts`-ordered scans stop as soon as 50 rows match.

---

## Endpoints

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/endpoints` | List. Params: `cursor` (last `uri`), `search` (repeatable, matches `uri`). Returns `[{uri, status, filename}]` sorted ascending by `uri`; a non-null `filename` means the row is file-backed (`r2_key` never leaves the server). |
| `POST` | `/api/endpoints` | Upsert a **text** endpoint. Body `{uri, status, headers, body}`. `headers` is a line-separated string (`Key: Value\n…`) parsed to a JSON object server-side. Validates that `uri` starts with `/` and `status` is an integer 100–599. If the URI is currently file-backed this **converts it back to text**: `r2_key`/`filename` are cleared and the object is deleted (response carries `replaced_file: true`). |
| `POST` | `/api/endpoints/upload?uri=<uri>` | Upsert a **file-backed** endpoint. The request **body is the raw file** (not multipart) so it streams into R2; `Content-Type` is the file's type and `X-Filename` is the URI-encoded display name. Takes no status/headers/body — the server owns all three. `400` on a bad URI, `411` without `Content-Length`, `413` over 25 MB, `500` if the `FILES` binding is missing. A failed row write deletes the new object; the previous object is deleted only after the row is repointed. |
| `GET` | `/api/endpoints/[uri]` | Detail; `uri` is URL-encoded in the path. Carries `file`: `null` for a text endpoint, else `{filename, content_type, size, missing}` where `content_type`/`size` come from an R2 `head()` and `missing: true` means the row outlived its object. |
| `DELETE` | `/api/endpoints/[uri]` | Delete. `404` if nothing was deleted. For a file-backed row the object is deleted **first**, then the row — a failed object delete leaves a visible row to retry rather than an orphan. |

`/api/endpoints/upload` is a static route, so Pages matches it before the
`[uri]` parameter route; real URIs arrive percent-encoded and cannot collide.

## Requests

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/requests` | List. Params: `cursor` (last `ts`), `search` (repeatable, matches `url`). Returns `[{id, ts, method, url, ip}]` — no headers or body, to keep the payload small. Sorted descending by `ts`. |
| `GET` | `/api/requests/[id]` | Full row, with `headers` parsed back into an object. `404` if missing. |

## Emails

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/emails` | List. Params: `cursor` (last `ts`); `search` (repeatable — each term ORs across `from_addr`, `to_addr` and `subject`); `starred=1` (a separate `AND starred = 1`, not part of the search OR). Returns `[{id, ts, from_addr, to_addr, subject, read, starred}]`, newest first. **Drill-in mode:** with both `from_eq` and `subject_eq`, the exact-pair predicate `from_addr = ? AND COALESCE(subject,'') = ?` is added *on top of* the normal filter, so a filtered conversation drill-in returns only the members that also match. |
| `PATCH` | `/api/emails` | **Bulk read-state for one conversation.** Body `{from_addr, subject, read, search?, starred?}` (`subject` may be `''`; `read` boolean; `search` an array of terms). Updates rows matching the exact pair, narrowed by the same optional `search`/`starred` filter — so the update is scoped to what the operator can see. Returns `{ok, updated}`. |
| `GET` | `/api/emails/[id]` | Lean detail: `{id, ts, from_addr, to_addr, subject, attachment_count, read, starred}`. **No body** — bodies, headers and attachments come from the raw `.eml`. |
| `PATCH` | `/api/emails/[id]` | Per-email UI state. Body `{read?, starred?}` (booleans; only the keys present are updated). Returns the updated `{read, starred}`. `400` if neither key is given. **Dashboard-only writer** — Autopilot has no path to this. |
| `GET` | `/api/emails/[id]/raw` | Streams the verbatim `.eml` from R2 as `message/rfc822`. `404` if the object is gone. Fetched by the email modal when it opens, and by Download Raw. |

## Blacklists

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/blacklist/ips` | `[{ip, ts, note}]`, newest first |
| `POST` | `/api/blacklist/ips` | Body `{ip, note?}`. Validates an IPv4 dotted quad, an IPv6 address with colons, or the literal `unknown`. `INSERT OR IGNORE` — a duplicate add succeeds without writing. |
| `DELETE` | `/api/blacklist/ips/[ip]` | `404` if not present |
| `GET` | `/api/blacklist/emails` | `[{email, ts, note}]`, newest first |
| `POST` | `/api/blacklist/emails` | Body `{email, note?}`. Accepts `addr@host` or `Display <addr@host>`; stored lowercase; validated against `^[^@\s]+@[^@\s]+\.[^@\s]+$`. |
| `DELETE` | `/api/blacklist/emails/[email]` | Lowercased and URL-decoded path param. `404` if not present. |

Both lists are read by the catcher with a 60-minute edge cache, so changes here
take up to an hour to take effect ([database.md](database.md#ip_blacklist-and-email_blacklist)).

## Config

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/config/domains` | `{domains: [{domain, roles}]}` from the `domains` table, ordered by domain. Backs the Home host picker. Defensive: returns `{domains: []}` on any error or malformed row rather than failing the page. |

---

## The `headers` round-trip

Deliberately asymmetric:

- **Endpoints, write** — the dashboard sends a line-separated string; the server
  parses it to a JSON object before storing.
- **Endpoints, read** — the server returns the stored JSON string as-is; the
  dashboard parses it and formats it back to lines for editing.
- **Requests, read** — the server parses the JSON and returns an object, which is
  what a read-only viewer wants.

## Adding a route

1. Create the file under `dashboard/functions/api/…`. Pages routing is
   file-based: `functions/api/foo/[id].js` serves `/api/foo/:id`, and
   `export async function onRequestGet/Post/Patch/Delete(context)` picks the
   method.
2. Wrap the handler in `withErrorHandler` from `../_shared.js` and use its `json`
   / `errResp` helpers so error shapes stay uniform.
3. Validate input explicitly. Never interpolate user input into SQL — bind it.
   The one place a table name is interpolated (historically, in purge) validated
   against an allow-list first; that pattern is required if you ever need it
   again.
4. Add the route to this document, and to `API` in `dashboard/js/ui.jsx` if the
   frontend calls it.
