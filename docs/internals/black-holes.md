# The Black Holes worker

Single file: `workers/black-holes/src/index.js`. Service name from `WORKER_NAME`.
One npm dependency, `postal-mime`, which is why the config sets
`compatibility_flags = ["nodejs_compat"]`.

One worker serves **every** black hole. It is bound by Custom Domain to each
hostname and does not know or care which one a request arrived on. The hostname
only matters as data (it is part of the captured URL).

```js
export default {
  async fetch(request, env, ctx) { /* HTTP capture + response serving */ },
  async email(message, env, ctx) { /* inbound mail capture */ },
};
```

## Bindings

| Binding | Kind | Purpose |
|---|---|---|
| `DB` | D1 | Endpoints, request log, email index, blacklists |
| `EML` | R2 | Captured email: writes `emails/<id>.eml` |
| `FILES` | R2 | Endpoint uploads: **read-only** here; streams the object named by a row's `r2_key` |
| `FALLBACK_ADDRESS` | var | Where a *failed* email capture is forwarded |

`workers_dev = false` and `preview_urls = false`: the worker has no
`*.workers.dev` URL and no per-version preview URL. It is reachable only through
the Custom Domains bound to it.

Email Routing is **not** configured in `wrangler.toml`, because Wrangler v4 removed the
`[triggers] email` key. The worker exports an `email()` handler and the zone's
catch-all rule delivers to it; `./a51 setup` and `./a51 black-hole add … mail` set
that rule over the API.

## HTTP handler

`handleHttp(request, env, ctx)`:

1. Generate `id` (UUID) and read `cf-connecting-ip`. Log `http_request_received`.
2. **IP blacklist gate.** Load the list (60-minute edge cache) and, on a hit, log
   `http_rejected_blacklist` and return `403! Forbidden` immediately, before the
   body is read, before the endpoint table is consulted, with nothing written.
3. Build the log row: `{id, ts, method, url (full), ip, ua, headers (JSON of
   every header), body}`. A body read error is swallowed and stored as `''`.
4. `ctx.waitUntil(insertRequestLog(...))`, fire and forget, so D1 latency never
   delays the response. A failure logs `http_log_insert_failed` and the capture is
   lost. There is no retry.
5. `SELECT status, headers, body, r2_key FROM endpoints WHERE uri = ?` against
   `url.pathname`. A lookup error logs `http_endpoint_lookup_failed` and is
   treated as "no match" rather than failing the response.
6. **No row** → `404! Not Found`.
7. **Row with `r2_key`** (file-backed) → `env.FILES.get(key)` and stream the
   object back with `200` and its own stored `Content-Type` (falling back to
   `application/octet-stream`), served inline. R2 returns a stream, so object size
   never touches worker memory. A missing binding logs
   `http_file_binding_missing`; a row whose object is gone logs
   `http_file_missing`. Both answer `404` rather than serving an empty `200`.
8. **Text row** → `new Response(body || '', {status: status || 200, headers:
   JSON.parse(headers || '{}')})`. The parse is wrapped in try/catch and falls
   back to `{}`, so a corrupt headers field cannot break serving.

Exact-path matching only ([decisions.md](../decisions.md#endpoints-are-exact-match-not-glob)).

## Email handler

`handleEmail(message, env, ctx)`. Everything is inside one try/catch; the catch is
the **only** path that forwards to the fallback inbox, and the handler never
re-throws.

1. `id = uuid`, `ts = now`, `toAddr = message.to`. The SMTP envelope sender
   (`message.from`) is kept for log lines only. It never reaches storage,
   display, or the blacklist.
2. Buffer the raw message **once**:
   `buf = await new Response(message.raw).arrayBuffer()`. `message.raw` is a
   stream and can only be read once; the same buffer feeds both the parser and R2.
3. `parsed = await PostalMime.parse(buf)` for `subject` and
   `attachment_count`. **No body is extracted:** bodies live only in the raw
   `.eml`. A parse failure logs `email_parse_failed` and is *non-fatal*: the
   object is still stored, so the dashboard's own parse still renders everything.
4. `fromAddr = parsed.from.address`, the `From:` header. **The email blacklist
   gates on this value and only this value.** On a hit: log
   `email_rejected_blacklist`, `message.setReject('Address not accepted')`,
   return. No object, no row, no forward; the sender's server bounces. If the
   message has no `From:` (or parsing failed), `fromAddr` is `''` and the gate is
   skipped.
5. `EML.put('emails/<id>.eml', buf, {httpMetadata: {contentType: 'message/rfc822'}})`.
6. `INSERT INTO emails (id, ts, from_addr, to_addr, subject, attachment_count)`.
   `read` and `starred` take their defaults; the worker never sets them.
7. Log `email_stored`.

**Catch (any failure above):** log `email_capture_failed`, forward the original to
`FALLBACK_ADDRESS` so it is not lost, then roll back whatever landed:
`EML.delete(key)` and `DELETE FROM emails WHERE id = ?`. Both are best-effort
(D1 and R2 share no transaction) and log `email_rollback_r2_failed` /
`email_rollback_d1_failed` on failure.

Consequences worth knowing:

- **No size or attachment threshold.** Every message is stored in full.
- **Capture is binary.** Either both stores hold the message, or neither does and
  it is in the fallback inbox. No marker rows
  ([decisions.md](../decisions.md#all-or-nothing-email-capture-no-marker-rows)).
- **Memory ceiling.** The whole message is buffered to hash it into R2 and parse
  it. Workers cap at 128 MB; SMTP messages are typically ≤ 25–50 MB, so this is
  comfortable, but a pathological message errors and falls to the fallback path.

## Blacklist caching

```
loadBlacklist(env, 'ip' | 'email')
  → caches.default.match(<synthetic key>)   hit  → parse and return a Set
  → SELECT ip|email FROM …_blacklist        miss → cache for 3600 s, return a Set
  → on query error                                → return an empty Set (fail open)
```

The cache key is fixed per list, so every invocation in the same data center
shares one loaded set. `BLACKLIST_CACHE_TTL_SECONDS = 3600` is the knob; raising
it cuts lookups further, lowering it makes dashboard changes land sooner. Failing
*open* is deliberate: a database blip must not stop captures.

## Log events

All logs are one JSON object per line, `console.log` for success and
`console.error` for failure, via the `log()` / `logErr()` helpers. Stream them
with `./a51 tail black-holes`.

| Event | When |
|---|---|
| `http_request_received` | top of the fetch handler |
| `http_rejected_blacklist` | IP on the blacklist; 403 returned, nothing stored |
| `http_endpoint_matched` | a row was found, about to respond |
| `http_endpoint_not_found` | no row for that path |
| `http_endpoint_lookup_failed` | the D1 lookup threw |
| `http_file_served` | file-backed endpoint streamed from R2 |
| `http_file_missing` | the row has an `r2_key` but the object is gone → 404 |
| `http_file_lookup_failed` / `http_file_binding_missing` | R2 GET threw / the `FILES` binding is absent |
| `http_log_insert_ok` / `http_log_insert_failed` | result of the fire-and-forget request log |
| `email_received` | top of the email handler (includes envelope sender and raw size) |
| `email_rejected_blacklist` | sender on the blacklist; message NACKed |
| `email_parse_failed` | postal-mime threw, non-fatal |
| `email_stored` | success: object **and** row exist |
| `email_capture_failed` | the error path fired; forwarded, then rolled back |
| `email_rollback_r2_failed` / `email_rollback_d1_failed` | a compensating delete failed (possible orphan) |
| `email_forward_ok` / `email_forward_failed` | result of `message.forward` |

```bash
./a51 tail black-holes -- --format=json | jq 'select(.event == "email_stored")'
```

Logs are also persisted and queryable in the Cloudflare dashboard
(`[observability] enabled = true`).

## Deploying and testing

```bash
./a51 deploy black-holes        # render wrangler.toml from .env, then wrangler deploy
./a51 dev black-holes           # local dev server against the REMOTE database and buckets
```

Smoke tests:

```bash
curl -i https://<black-hole>/nope            # 404! Not Found, and a row in Requests
curl -i https://<black-hole>/<configured>    # your status, headers and body
```

- Send a plain message to `anything@<mail-enabled-host>`: a row appears with
  `attachment_count = 0` and the object exists
  (`npx wrangler r2 object get <bucket> emails/<id>.eml`).
- Send one with an attachment: the count is right, and the modal renders the body
  and lets you download the attachment.
- Send a multi-megabyte message: same as above. Only a worker error forwards to
  the fallback, leaving no row and no object.
- Blacklist your own IP, hit a black hole within the hour, and expect `403` with
  no new row plus a `http_rejected_blacklist` line in the tail.
