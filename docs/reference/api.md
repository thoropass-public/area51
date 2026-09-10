# Dashboard HTTP API

Base path `https://<dashboard-host>/api/`, served by the dashboard Worker from
`dashboard/src/api/`, with the route table in `dashboard/src/index.js`. It is
consumed **same-origin** by the dashboard frontend and by nothing else: there is
no CORS header, no API key, and no versioning. Authentication is entirely
Cloudflare Access at the edge, so a request that reaches a handler has already
been authorized.

`[assets] run_worker_first = ["/api/*"]` is what routes these paths to the Worker
at all; everything else on the host is served from `public/` without invoking it.

Autopilot's agent-facing API is a **separate** surface on a separate worker with
its own auth; see [autopilot.md](../internals/autopilot.md).

## Conventions

- **Success:** HTTP 200 with a JSON body. Lists return a bare array. Detail
  routes return the row object. Mutations return `{ok: true}` (plus extras).
- **Errors:** `{error: "message"}` with `400` (bad input), `404`
  (`{error: "Not found"}`), `411` / `413` (upload size), or `500`
  (`{error: "Internal error"}`). Every handler is wrapped in `withErrorHandler`
  (one `try/catch` in `src/index.js`), which logs the real error via `console.error` and
  returns the generic 500.
- **Pagination:** cursor-based. Page size is fixed at **50** (`PAGE_SIZE` in
  `_shared.js`). The cursor is the natural sort key of the last row returned:
  `uri` for endpoints (ascending), `ts` for requests and emails (descending).
  Pass it as `?cursor=`. "Has more" is inferred client-side from
  `results.length === PAGE_SIZE`, but the client cannot import `PAGE_SIZE` (no
  build step), so `dashboard/public/js/tabs.jsx` hardcodes `50` in each has-more test and
  in `DISPLAY_TARGET`. The two copies must be changed together.
- **Search:** `?search=` may be **repeated**. Terms are ORed inside a
  parenthesized group, which is ANDed with the cursor. Matching is
  `LIKE '%term%'`, i.e. a full table scan; fine at this scale, and
  `ts`-ordered scans stop as soon as 50 rows match.

---

## Endpoints

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/endpoints` | List. Params: `cursor` (last `uri`), `search` (repeatable, matches `uri`). Returns `[{uri, status, filename}]` sorted ascending by `uri`; a non-null `filename` means the row is file-backed (`r2_key` never leaves the server). |
| `POST` | `/api/endpoints` | Upsert a **text** endpoint. Body `{uri, status, headers, body}`. `headers` is a line-separated string (`Key: Value\n…`) parsed to a JSON object server-side. Validates that `uri` starts with `/` and `status` is an integer 100–599. If the URI is currently file-backed this **converts it back to text**: `r2_key`/`filename` are cleared and the object is deleted (response carries `replaced_file: true`). |
| `POST` | `/api/endpoints/upload?uri=<uri>` | Upsert a **file-backed** endpoint. The request **body is the raw file** (not multipart) so it streams into R2; `Content-Type` is the file's type and `X-Filename` is the URI-encoded display name. Takes no status/headers/body, since the server owns all three. `400` on a bad URI, `411` without `Content-Length`, `413` over 25 MB, `500` if the `FILES` binding is missing. A failed row write deletes the new object; the previous object is deleted only after the row is repointed. |
| `GET` | `/api/endpoints/:uri` | Detail; `uri` is URL-encoded in the path. Carries `file`: `null` for a text endpoint, else `{filename, content_type, size, missing}` where `content_type`/`size` come from an R2 `head()` and `missing: true` means the row outlived its object. |
| `DELETE` | `/api/endpoints/:uri` | Delete. `404` if nothing was deleted. For a file-backed row the object is deleted **first**, then the row, so a failed object delete leaves a visible row to retry rather than an orphan. |

`/api/endpoints/upload` is a **literal** route, and `src/router.js` settles
literal paths before it considers `:uri` — including when the path is declared
but the method is not, which answers `405` rather than falling through. Real
endpoint URIs arrive percent-encoded (so a leading `%2F`) and could not collide
with the literal string `upload` in any case. `router.test.mjs` pins this.

## Requests

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/requests` | List. Params: `cursor` (last `ts`), `search` (repeatable, matches `url`). Returns `[{id, ts, method, url, ip}]`, with no headers or body, to keep the payload small. Sorted descending by `ts`. |
| `GET` | `/api/requests/[id]` | Full row, with `headers` parsed back into an object. `404` if missing. |

## Emails

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/emails` | List. Params: `cursor` (last `ts`); `search` (repeatable, and each term ORs across `from_addr`, `to_addr` and `subject`); `starred=1` (a separate `AND starred = 1`, not part of the search OR). Returns `[{id, ts, from_addr, to_addr, subject, read, starred}]`, newest first. **Drill-in mode:** with both `from_eq` and `subject_eq`, the exact-pair predicate `from_addr = ? AND COALESCE(subject,'') = ?` is added *on top of* the normal filter, so a filtered conversation drill-in returns only the members that also match. |
| `PATCH` | `/api/emails` | **Bulk read-state for one conversation.** Body `{from_addr, subject, read, search?, starred?}` (`subject` may be `''`; `read` boolean; `search` an array of terms). Updates rows matching the exact pair, narrowed by the same optional `search`/`starred` filter, so the update is scoped to what the operator can see. Returns `{ok, updated}`. |
| `GET` | `/api/emails/[id]` | Lean detail: `{id, ts, from_addr, to_addr, subject, attachment_count, read, starred}`. **No body:** bodies, headers and attachments come from the raw `.eml`. |
| `PATCH` | `/api/emails/[id]` | Per-email UI state. Body `{read?, starred?}` (booleans; only the keys present are updated). Returns the updated `{read, starred}`. `400` if neither key is given. **Dashboard-only writer**; Autopilot has no path to this. |
| `GET` | `/api/emails/[id]/raw` | Streams the verbatim `.eml` from R2 as `message/rfc822`. `404` if the object is gone. Fetched by the email modal when it opens, and by Download Raw. |

## Blacklists

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/blacklist/ips` | `[{ip, ts, note}]`, newest first |
| `POST` | `/api/blacklist/ips` | Body `{ip, note?}`. Validates an IPv4 dotted quad, an IPv6 address with colons, or the literal `unknown`. `INSERT OR IGNORE` semantics, so a duplicate add succeeds without writing. |
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

- **Endpoints, write:** the dashboard sends a line-separated string; the server
  parses it to a JSON object before storing.
- **Endpoints, read:** the server returns the stored JSON string as-is; the
  dashboard parses it and formats it back to lines for editing.
- **Requests, read:** the server parses the JSON and returns an object, which is
  what a read-only viewer wants.

## Adding a route

1. Create the file under `dashboard/src/api/…` and `export` the handler by
   name. It receives `{ request, env, ctx, params }`; `params` holds the dynamic
   segments, still percent-encoded, so decode them yourself.
2. Add it to the `ROUTES` table in `dashboard/src/index.js` as
   `['METHOD', '/api/path/:param', handler]`. Routing is **not** file-based any
   more — the file's location and the export's name mean nothing to the router,
   so a handler that is not in that table is simply unreachable. Position in the
   list does not matter: literal paths always beat `:param` routes.
3. Do **not** wrap the handler in error handling. `src/index.js` applies one
   `try/catch` around every route, so a handler cannot forget it. Use the `json`
   / `errResp` helpers from `../shared.js` so error shapes stay uniform.
4. Run `node dashboard/src/router.test.mjs`. It reads the `ROUTES` table out of
   `index.js`, so your new route is covered automatically — and a route that
   shadows an existing one fails there rather than silently in production.
5. Validate input explicitly. Never interpolate user input into SQL. Bind it.
   The one place a table name is interpolated (historically, in purge) validated
   against an allow-list first; that pattern is required if you ever need it
   again.
6. Add the route to this document, and to `API` in `dashboard/public/js/ui.jsx`
   if the frontend calls it.
