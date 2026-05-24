# AREA 51 — Exploit Server

Internal out-of-band callback infrastructure for the Thoropass security team. Hosted on Cloudflare.

This document is the **canonical, exhaustive technical primer** for the project. It's written so a first-time user can use it, a new developer can take over from cold, and an oncall engineer can debug an outage without paging anyone. **Keep it in sync with every code change.** If a change affects anything described here, update this file as part of the same commit.

The original design spec (`pre-context.md`) and the Claude Design handoff bundle are kept internal to the team and aren't in this repo. Ask Apaar if you need them.

---

## Table of contents

1. [What it is](#1-what-it-is)
2. [Architecture](#2-architecture)
3. [Repository layout](#3-repository-layout)
4. [The Worker (`oob.example`)](#4-the-worker-0r0us)
5. [The Pages site (`area51.ops.example`)](#5-the-pages-site-area51thoropentestscom)
6. [D1 database](#6-d1-database)
7. [HTTP API contract](#7-http-api-contract-pages-functions)
8. [Cloudflare Access](#8-cloudflare-access)
9. [Deployment from a clean slate](#9-deployment-from-a-clean-slate)
10. [Local development](#10-local-development)
11. [Operations](#11-operations)
12. [Smoke tests](#12-smoke-tests)
13. [Debugging](#13-debugging-common-issues)
14. [Known constraints & caveats](#14-known-constraints--caveats)
15. [Agent API + MCP server](#15-agent-api--mcp-server-agent-a51thoropentestscom)
16. [Design decisions](#16-design-decision-log)

---

## 1. What it is

AREA 51 is an **exploit server**: an attacker-controlled HTTP and email endpoint that pentesters point targets at during engagements. Targets that fetch URLs, send webhooks, click email links, or otherwise reach out to "the internet" can be steered to `oob.example`, where:

- the **HTTP traffic** is captured (full request, headers, body), and
- the **server's response** is whatever the pentester has configured for that path.

Use cases:
- SSRF / blind SSRF (capture the callback and inspect what came through)
- OAuth `redirect_uri` abuse (host a redirect or token-grab page)
- XXE / SSRF data exfiltration (host a DTD or follow-up payload)
- CSRF / clickjacking PoC hosting
- Phishing landing pages and email-based interaction proofs (`*@oob.example` is a catch-all inbox)
- Generic "callback received" confirmation for interaction-based vulnerabilities

It is **not customer-facing**. All users are trusted Thoropass team members. Design prioritizes simplicity and maintainability over hardening or scale. The dashboard sits behind Cloudflare Access (VPN IP allowlist + `@thoropass.com` email OTP); the exploit server itself (`oob.example`) is open to the internet because it has to be reachable by targets.

---

## 2. Architecture

```
                ┌────────────────────────────────────────────────────────┐
                │ Cloudflare                                             │
                │                                                        │
  Internet ─────┼─► oob.example/*                 (Worker)                    │
  (targets,     │     ├── HTTP fetch handler ──┐                         │
   email)       │     └── Email handler ────┐  │                         │
                │                           │  │                         │
                │                           │  ▼                         │
                │                           │ ┌────────────────────────┐ │
                │                           │ │ D1: area51 database    │ │
                │                           │ │  ├── endpoints         │ │
                │                           │ │  ├── requests          │ │
                │                           │ │  └── emails            │ │
                │                           │ └────────────────────────┘ │
                │                           │  ▲                         │
                │                           │  │                         │
  Pentester ────┼─► area51.ops.example│  │                         │
   (browser,    │   ▲                       │  │                         │
   on VPN +     │   │                       │  │                         │
   thoropass    │  Cloudflare Access        │  │                         │
   email)       │  (IP + email OTP)         │  │                         │
                │   │                       │  │                         │
                │   ▼                       │  │                         │
                │  Pages (static + /api/*)  │  │                         │
                │   ├── index.html, *.jsx ──┘  │ (read/write via         │
                │   └── /functions/api/* ──────┘  D1 binding)            │
                │                                                        │
                │                           ┌────────────────────────┐   │
                │ Email Routing fallback ──►│ apaar.farmaha@thoropass│   │
                │ (forwarded when           │ .com (catch-all bucket)│   │
                │  rawSize >1 MB)           └────────────────────────┘   │
                └────────────────────────────────────────────────────────┘
```

Three deployables, one database, one Cloudflare account:

| Component | Where | What it does |
|---|---|---|
| **Worker** | `oob.example` | Serves arbitrary HTTP responses from D1; captures every request; receives `*@oob.example` email, parses, stores, optionally forwards |
| **Pages site** | `area51.ops.example` | Static React dashboard + Pages Functions JSON API; manage endpoints, browse captures, purge data |
| **D1 database** | binding `DB`, name `area51` | Single SQLite-style DB shared by Worker and Pages |
| **Access policy** | in front of Pages domain | VPN IP allowlist AND `@thoropass.com` email OTP — both required |
| **Email Routing** | on `oob.example` | Catch-all delivers incoming mail to the Worker's email handler |

### 2.1 HTTP request flow (target → oob.example)

```
target ──► oob.example/some/path
              │
              ▼
         Worker.fetch()
              │
              ├─ build request log row (id, ts, method, url, ip, ua, headers, body)
              ├─ ctx.waitUntil( INSERT into requests )   ← fire-and-forget, doesn't block response
              │
              ├─ SELECT status, headers, body FROM endpoints WHERE uri = path
              │
              ├─ match found?
              │     yes → respond with row.status + JSON.parse(row.headers) + row.body
              │     no  → respond 404 "404! Not Found"
              ▼
         response goes out
```

The request log INSERT is scheduled via `ctx.waitUntil` so the response goes out without waiting on D1. If the INSERT fails, the log is lost — accepted per design. There is no retry queue.

### 2.2 Email flow (sender → *@oob.example)

```
sender ──► *@oob.example
              │  (Cloudflare Email Routing catch-all)
              ▼
         Worker.email(message)
              │
              ├─ id = uuid, ts = now
              ├─ read message.raw stream → rawText (string)
              ├─ parsed = postal-mime.parse(rawText)
              ├─ hasAttachments = parsed.attachments.length > 0
              ├─ tooBig = message.rawSize > 1 MiB
              │
              ├─ if hasAttachments OR tooBig:
              │     ├─ forward(message → FALLBACK_ADDRESS)                       } in parallel
              │     └─ INSERT into emails: html = "sent_to_fallback"
              │         (everything else — from/to/subject/headers/text/attachments — still written)
              │   await both via Promise.allSettled
              │
              ├─ else:
              │     ├─ INSERT into emails with parsed.{headers, text, html, attachments}
              │     └─ on INSERT failure: forward to FALLBACK_ADDRESS (compensating, no D1 row)
              │
              └─ on uncaught error anywhere above:
                    forward(message → FALLBACK_ADDRESS)                          } last resort
```

The email handler **never throws out of the handler function** — any uncaught path triggers a last-resort forward so the email isn't dropped silently.

### 2.3 Dashboard flow (pentester → area51.ops.example)

```
pentester (on VPN, @thoropass.com Google)
   │
   ▼
Cloudflare Access
   ├─ check source IP against allowlist     } both must pass
   └─ check email OTP (sent to @thoropass.com)
   │
   ▼ (on success — sticky session cookie)
Pages domain
   ├─ /, /index.html, /styles.css, /*.jsx → static files
   └─ /api/* → Pages Functions
              │
              ▼
         { GET /api/endpoints, POST, GET/[uri], DELETE /[uri],
           GET /api/requests, GET /[id],
           GET /api/emails, GET /[id],
           POST /api/purge }
              │
              ▼
         env.DB (D1 binding) → SQL
```

---

## 3. Repository layout

```
.
├── README.md                  ← you are here (the canonical primer)
├── schema.sql                 ← D1 schema (apply with `wrangler d1 execute`)
├── worker/                    ← oob.example deployable
│   ├── wrangler.toml          ← Worker config: D1 binding, email trigger, FALLBACK_ADDRESS
│   ├── package.json           ← deps: postal-mime, wrangler
│   └── src/
│       └── index.js           ← single-file Worker with fetch + email handlers
└── pages/                     ← area51.ops.example deployable
    ├── index.html             ← entry point; loads React/Babel UMD + the three .jsx files
    ├── styles.css             ← Nord-inspired dark dashboard, dense developer UI
    ├── ui.jsx                 ← helpers, API client, toast/modal/confirm
    ├── tabs.jsx               ← EndpointsTab, RequestsTab, EmailsTab + their modals
    ├── app.jsx                ← shell: App, TopBar, Home, Settings; mounts to #root
    └── functions/             ← Pages Functions (server-side)
        └── api/
            ├── _shared.js              ← json/errResp helpers, withErrorHandler, parseHeaderLines
            ├── endpoints/
            │   ├── index.js            ← GET (list+search+cursor), POST (upsert)
            │   └── [uri].js            ← GET (detail), DELETE
            ├── requests/
            │   ├── index.js            ← GET (list+search+cursor)
            │   └── [id].js             ← GET (detail; headers parsed back to object)
            ├── emails/
            │   ├── index.js            ← GET (list+search+cursor)
            │   └── [id].js             ← GET (detail; headers + attachments parsed back from JSON)
            └── purge/
                └── index.js            ← POST (delete-all-except-latest-N, allowlisted tables only)
```

The Worker and Pages projects are **deployed independently** but share a single D1 database via separate Wrangler bindings.

---

## 4. The Worker (`oob.example`)

Single-file Worker at `worker/src/index.js`. One npm dep: `postal-mime` (for email parsing). Compatibility flags: `nodejs_compat` (postal-mime needs it).

Exports a default object with two handlers:

```js
export default {
  async fetch(request, env, ctx) { /* HTTP */ },
  async email(message, env, ctx) { /* incoming mail */ },
};
```

### 4.1 HTTP handler

`handleHttp(request, env, ctx)` in `worker/src/index.js`:

1. Generate request `id` (UUID) and `ts` (ISO 8601).
2. Build the log row: `{ id, ts, method, url (full), ip, ua, headers (JSON-stringified entries), body (text or "") }`. Body read errors are swallowed and replaced with empty string.
3. `ctx.waitUntil(insertRequestLog(env, row))` — fire and forget. If D1 INSERT fails, it's logged via `console.error` and dropped.
4. `SELECT status, headers, body FROM endpoints WHERE uri = ?` against `env.DB`. Lookup errors don't fail the response — they're logged and treated as "not found."
5. If found: respond with `new Response(row.body || "", { status: row.status || 200, headers: JSON.parse(row.headers || "{}") })`.
6. If not found: respond `new Response("404! Not Found", { status: 404 })`.

Note that step 5's `JSON.parse` is wrapped in try/catch and falls back to `{}` so a corrupt headers field doesn't break serving.

### 4.2 Email handler

`handleEmail(message, env, ctx)` in `worker/src/index.js`. All operations wrapped in a top-level try/catch that triggers a last-resort forward on any uncaught error.

Steps:

1. `id = uuid`, `ts = now()`, `fromAddr = message.from`, `toAddr = message.to`.
2. `rawSize = Number(message.rawSize)` — coerced through `Number()` to defend against a known Cloudflare bug where `rawSize` returns a `BigInt` despite type declarations.
3. Read the raw EML into a string: `rawText = await new Response(message.raw).text()`. This consumes the `message.raw` stream, so it can only happen once. The raw text is never stored in D1 — only the structured fields parsed from it.
4. `parsed = await PostalMime.parse(rawText)` — parse on the **string** (not the stream — already consumed). Used only to extract the subject for the D1 row; not used for any routing decision. Parse failures are caught and `parsed` stays `null`, but processing continues so the row is still stored.
5. Extract `subject` from parsed headers (preferred) or `parsed.subject`.
6. Decide the routing:
   - `hasAttachments = (parsed.attachments || []).length > 0` — any item postal-mime found, inline or not.
   - `tooBig = rawSize > 1048576` (1 MiB).
   - `shouldForward = hasAttachments || tooBig`.

   `message.rawSize` is what Cloudflare reports for the inbound — it runs several times larger than the EML body length we read from `message.raw` because it includes SMTP envelope / routing metadata. The 1 MB cap is set against `message.rawSize`, not body length, and is comfortable for routine Gmail-forwarded mail (including signatures with inline images).
7. **If `shouldForward`:**
   - Start `message.forward(env.FALLBACK_ADDRESS)` — the original email lands in the fallback inbox.
   - Start `INSERT into emails` with the same structured fields as a normal store **except** `html = "sent_to_fallback"` (the literal sentinel string). `text`, `headers`, `attachments` (metadata), `subject`, `from_addr`, `to_addr`, `ts` are all populated normally so the dashboard can still show the email's metadata.
   - `await Promise.allSettled([forwardP, insertP])` — neither blocks the other.
8. **Else (store normally):**
   - `INSERT into emails` with `headers = JSON(parsed.headers)`, `text = parsed.text`, `html = parsed.html`, `attachments = JSON([{filename, mime, size}, …])`. **Attachment content (bytes) is never stored — only metadata.**
   - On INSERT failure: compensating action — forward to `FALLBACK_ADDRESS` so the email isn't lost. (No D1 row exists in this failure case — the marker-row path only fires for the size/attachment triggers.)
9. **Catch-all:** any uncaught error from steps 1–8 → `forward(message, env.FALLBACK_ADDRESS)`. The handler never re-throws.

The `"sent_to_fallback"` literal in the `html` column is what the dashboard's email modal checks to show the yellow "forwarded to fallback inbox" notice (see `tabs.jsx` `EmailModal` / `EmailView`). All other columns are still readable — only the `html` body is replaced with the marker.

### 4.3 Bindings & env vars

In `worker/wrangler.toml`:

| Binding / Var | Purpose |
|---|---|
| `DB` (D1) | Cloudflare D1 binding to the `area51` database |
| `FALLBACK_ADDRESS` (var) | Email forward target for oversized (>1 MB) and failure cases. Currently `you@example.com` |
| `routes` | Custom Domain entry binds the worker to `oob.example` (Cloudflare auto-manages DNS) |
| `workers_dev = false` | Disables the auto-generated `area51-worker.<account-subdomain>.workers.dev` URL — the worker is reachable only via `oob.example` |
| `preview_urls = false` | Disables Cloudflare's per-version preview URLs — same lockdown rationale |

**Email Routing is configured in the Cloudflare dashboard, not `wrangler.toml`.** Wrangler v4 deprecated the `[triggers] email` config. The worker exports an `email` handler; the dashboard's Email Routing → "Send to a Worker" feature is what actually delivers inbound mail to it. See the deployment steps in [§9](#9-deployment-from-a-clean-slate).

The real `worker/wrangler.toml` (with the live D1 ID) is gitignored. The committed template is `worker/wrangler.toml.example` — copy it and paste the `database_id` from `wrangler d1 create area51`.

### 4.4 Logging

All log entries are structured JSON via `console.log` (success) or `console.error` (failure). Helpers in `worker/src/index.js`:

```js
log('event_name', { id, route, ... })       // → console.log(JSON.stringify(...))
logErr('event_name', { id, error, ... })    // → console.error(JSON.stringify(...))
```

Event names emitted:

| Event | When |
|---|---|
| `http_request_received` | top of fetch handler |
| `http_endpoint_matched` | endpoint row found, about to respond |
| `http_endpoint_not_found` | no endpoint row for path |
| `http_endpoint_lookup_failed` | D1 lookup threw (rare) |
| `http_log_insert_ok` / `http_log_insert_failed` | result of the `ctx.waitUntil` request log |
| `email_received` | top of email handler |
| `email_parse_failed` | postal-mime threw (D1 row still gets written with whatever metadata we have) |
| `email_fallback` | shouldForward branch fired; logs `{reason, hasAttachments, tooBig, rawSize}` |
| `email_oversized` | decision to forward (rawSize > 1 MB) |
| `email_d1_insert_ok` / `email_d1_insert_failed` | emails table INSERT result |
| `email_forward_ok` / `email_forward_failed` | message.forward result |
| `email_unhandled_error` | top-level catch fired — last-resort forward attempted |

Tail with `wrangler tail` (see [Operations](#11-operations)).

---

## 5. The Pages site (`area51.ops.example`)

A static site + Pages Functions, both deployed from `pages/`.

### 5.1 Frontend (no build step)

Deliberately **no build pipeline**. `pages/index.html` loads React, ReactDOM, and Babel-standalone from unpkg CDN, then loads the three JSX files with `<script type="text/babel">`. Babel transpiles in the browser on page load.

Why: the codebase is small, the runtime cost is acceptable for an internal tool, and skipping the build pipeline removes an entire category of dependency-management chores. Page load is "slow" (Babel-standalone is ~3 MB before gzip), but it's a tool the team opens once and keeps open.

File responsibilities:

- **`ui.jsx`** — shared utilities. Defines:
  - `API` global — the JSON API client (thin `fetch` wrappers, one method per endpoint). Always uses same-origin `/api/...` URLs.
  - `ToastProvider` / `useToast` — bottom-right transient notifications.
  - `ConfirmProvider` / `useConfirm` — async confirm dialog (returns a promise; awaited in delete / purge flows).
  - `Modal`, `ModalHead` — modal shell with ESC-to-close and backdrop-click-to-close.
  - `useDebouncedValue` — debounces the search input by 300 ms.
  - Display helpers: `fmtTime`, `fmtTimeFull`, `statusClass`, `headersObjToLines`, `highlightJson`, `tryPretty`, `fmtBytes`, `stripOrigin`.
  - `Icon` map — inline SVG icons (chevron, search, link, request, mail, doc, paper).
  - Everything exposed on `window` so the other JSX files can use them as globals (Babel-standalone doesn't do module resolution).

- **`tabs.jsx`** — the three list tabs and their detail modals.
  - `ListView` — generic search + paginated list wrapper used by all three tabs. The whole search field is a single visual unit: pin chips wrap inline alongside the input via flexbox; the field's border lives on the wrapper, not the input. Keyboard: **Enter** pins the current text, **Backspace** on an empty input pops the last pin, **Escape** clears the input. A `pin-add` icon button (frost color) appears at the right of the field when there's text to pin; a `clear` text-button appears whenever there's anything (search text or pins) to clear and wipes both at once. Adjacent to "X loaded" in the toolbar-meta, a small `meta-filter` badge reads "N pinned · OR" when at least one pin exists.
  - `usePins(<tab>)` in `tabs.jsx` loads/saves to `localStorage` under `area51:pins:<tab>` and returns `{pins, addPin, removePin, clearPins}`. `addPin` returns `false` if the value is empty or already pinned (case-insensitive dupe check), so the caller can avoid clearing the input on a no-op.
  - The effective list of search terms sent to the API is `[<live-input-text>, ...pins]` (built per-tab via the `effectiveSearch(input, pins)` helper) — all ORed server-side (any term matches → row included).
  - `EndpointsTab` + `EndpointModal` — list shows URI + color-coded HTTP status (uses the same `status-2xx/3xx/4xx/5xx` tag styling as the Requests tab). Click a row to open the modal with all fields editable; the URI is read-only on edit. Delete button on the modal asks for confirmation. The list endpoint returns just `{uri, status}` per row; full `headers` and `body` are fetched only when the modal opens.
  - `RequestsTab` + `RequestModal` — read-only. The modal pretty-prints the body as JSON if it parses, otherwise shows it raw.
  - `EmailsTab` + `EmailModal` — modal hands off to a single `EmailView` component that reads the structured fields directly from the API response (`data.headers`, `data.text`, `data.html`, `data.attachments`). No postal-mime in the browser any more — the worker parses once on write, the dashboard reads parsed columns on read. The yellow "forwarded to fallback" notice fires when `data.html === "sent_to_fallback"`; all other fields are still shown alongside the notice.
  - HTML body is rendered in a strict-sandbox `<iframe sandbox="" srcDoc={...}>`. Plain-text body in a `<pre>`. Attachments are surfaced as `{filename, mime, size}` rows — content bytes are never stored or exposed.
  - `decodeMimeWord(s)` (in `ui.jsx`) decodes RFC 2047 encoded-words (`=?charset?B?...?=` / `=?charset?Q?...?=`) before display. Applied to `from_addr`, `to_addr`, `subject`, and rendered header values. Worker-side extraction prefers postal-mime's already-decoded `parsed.subject` over the raw header value, so new rows arrive decoded; `decodeMimeWord` is a defense-in-depth pass for any encoded-word that slips through (older rows, display names in envelope fields, header values).

- **`app.jsx`** — the shell.
  - `App` — top-level component. Tab state, keyboard shortcut handler (⌘/Ctrl + 1–4 → endpoints/requests/emails/settings), wraps everything in `ConfirmProvider` + `ToastProvider`.
  - `TopBar` — brand mark + tabs + a refresh button on the far right that's visible only on list tabs (endpoints / requests / emails). The button increments an `App`-level `refreshTick` counter that the active list tab consumes as a `refreshKey` prop in its `fetchFirst` `useEffect` dependency array, causing a re-fetch of the first page. The icon spins briefly (~600ms) on click for visual feedback; the spin isn't synced to the actual loading state since each tab already shows its own spinner over the list rows.
  - `Home` — the marketing-style landing tab: AREA 51 hero, intro copy, four navigation tiles.
  - `Settings` — purge UI. Pick table (requests/emails), pick keep-N, click Purge (red, confirmation-gated). The danger banner reads "will keep the latest N · older rows permanently deleted · no undo" — no live count of what's about to be deleted, because we don't want to query `COUNT(*)` (see [§16](#16-design-decision-log)).

### 5.2 HTML iframe sandbox for email bodies

When `ParsedEmailView` renders an email's HTML body, it does so in:

```jsx
<iframe sandbox="" srcDoc={parsed.html} title="email html"/>
```

`sandbox=""` (no allowed tokens) is the **strictest** sandbox: no scripts, no same-origin access, no form submission, no top-navigation. Even though AREA 51 is internal-only, emails arrive from untrusted senders, so HTML bodies must be treated as hostile. Do not relax this sandbox.

### 5.3 Pages Functions (`/functions/api/*`)

Each file under `pages/functions/api/` exports `onRequestGet` / `onRequestPost` / `onRequestDelete` named handlers. Every handler is wrapped in `withErrorHandler` (`_shared.js`), which try/catches, logs the error via `console.error`, and returns `{ error: "Internal error" }` with HTTP 500 on any uncaught throw.

The full HTTP API contract is in [§7](#7-http-api-contract-pages-functions).

---

## 6. D1 database

Schema in `schema.sql`. Three tables, two indexes. Apply with:

```sh
wrangler d1 execute area51 --file=schema.sql --remote
```

### 6.1 `endpoints`

The map of `URI path → response` that the worker serves.

| Column | Type | Notes |
|---|---|---|
| `uri` | `TEXT PRIMARY KEY` | Exact pathname match. `/api/foo` only matches `/api/foo`. No globs, no params. |
| `status` | `INTEGER NOT NULL DEFAULT 200` | HTTP status to serve |
| `headers` | `TEXT` | JSON-stringified `{key: value}` object. Stored as JSON so D1 can hold arbitrary header sets without a side table. |
| `body` | `TEXT` | Raw response body (text or encoded binary). Capped at D1's 2 MB row limit. |

No `ts` / `created_at` — the worker doesn't need it, and nothing in the dashboard surfaces it. Add one if a feature requires it.

### 6.2 `requests`

Every HTTP hit on the worker.

| Column | Type | Notes |
|---|---|---|
| `id` | `TEXT PRIMARY KEY` | UUIDv4 generated in the worker |
| `ts` | `TEXT NOT NULL` | ISO 8601 UTC. Indexed `DESC` for "latest first" pagination. |
| `method` | `TEXT NOT NULL` | HTTP method |
| `url` | `TEXT NOT NULL` | Full URL incl. scheme/host/path/query |
| `ip` | `TEXT` | From `cf-connecting-ip` header, or `"unknown"` |
| `ua` | `TEXT` | User-Agent, or `"unknown"` |
| `headers` | `TEXT` | JSON-stringified `Object.fromEntries(request.headers.entries())` |
| `body` | `TEXT` | Raw body as text. Read errors → empty string. |

Index: `idx_requests_ts ON requests(ts DESC)` — supports the dashboard's "newer first, then load more" pagination.

### 6.3 `emails`

Every email captured by the worker.

| Column | Type | Notes |
|---|---|---|
| `id` | `TEXT PRIMARY KEY` | UUIDv4 generated in the worker |
| `ts` | `TEXT NOT NULL` | ISO 8601 UTC. Indexed `DESC`. |
| `from_addr` | `TEXT NOT NULL` | `message.from` (envelope sender) |
| `to_addr` | `TEXT NOT NULL` | `message.to` (envelope recipient) |
| `subject` | `TEXT` | Extracted from parsed headers if available |
| `headers` | `TEXT` | JSON-stringified array `[{key, value}, …]` from postal-mime. May be `NULL` if parsing failed. |
| `text` | `TEXT` | Plain-text body from postal-mime's `parsed.text`. May be `NULL` if no text part. Still populated on fallback rows. |
| `html` | `TEXT` | HTML body from postal-mime's `parsed.html`, **OR** the literal string `"sent_to_fallback"` on rows whose original was forwarded to the fallback inbox due to size or attachments. |
| `attachments` | `TEXT` | JSON-stringified `[{filename, mime, size}, …]`. **Metadata only — no attachment bytes are ever stored.** May be `NULL` if parsing failed; `'[]'` if the email parsed but had no attachments. |

Index: `idx_emails_ts ON emails(ts DESC)`.

The literal `"sent_to_fallback"` marker in the `html` column distinguishes "stored normally" rows from "the original was forwarded to the fallback inbox" rows. Both the worker (when writing) and the dashboard's email modal (when reading `data.html`) treat that exact string as the sentinel. Don't change the marker, or the column it lives in, without updating both sides.

Note: even on fallback rows, **everything except `html` is written**: `subject`, `from_addr`, `to_addr`, `ts`, `headers`, `text`, and `attachments` (metadata) are populated from what postal-mime parsed before the fallback decision. The yellow notice in the dashboard appears alongside this real metadata — clicking a fallback row still tells you who sent what, when, and what files were attached.

### 6.4 `ip_blacklist` and `email_blacklist`

Write-filter lists consulted by the worker before storing a captured `request` or `email`. Exact-match only — no patterns, no CIDR ranges.

| Column | Type | Notes |
|---|---|---|
| `ip` / `email` | `TEXT PRIMARY KEY` | Exact value. `email` is stored lowercase; the worker lowercases the envelope sender before comparing. |
| `ts` | `TEXT NOT NULL` | ISO 8601 UTC when added |
| `note` | `TEXT` | Optional human label (e.g. "shodan scanner"). Not currently surfaced in the UI but available in the API. |

No additional indexes — the PK suffices for both reads (worker checks `WHERE ip = ?`) and writes.

Worker behavior on a match:
- **IP blacklist hit** → skip `ctx.waitUntil(insertRequestLog(...))`. The target still receives the configured endpoint response — only the D1 write is suppressed.
- **Email blacklist hit** → silent drop. No D1 row, no fallback forward. Cloudflare's MX has already accepted the message; the worker just discards.

Worker reads each list at most **once per 60 minutes per data center** (edge-cached via `caches.default`). Dashboard mutations take up to **60 minutes** to fully propagate — applies to both adds and removes. The long TTL is intentional: at moderate pentest traffic (~100 callbacks/min), this drops blacklist-related D1 reads from ~8K/day to ~150/day per edge. Acceptable because blacklisting is a noise filter, not a security boundary; the cost of hour-long staleness on an add is "we logged a few more requests from a noisy IP than necessary," and on a remove is "we silently dropped a few legitimate captures for slightly longer than expected."

The cache miss path returns an empty set on D1 error so a transient D1 outage never blocks captures.

### 6.5 What's not in the schema (and why)

- **No counters table.** Tab badges and stats panels were dropped because counting rows on D1 bills per row scanned. Re-litigate this before adding counters; see [§16](#16-design-decision-log).
- **No foreign keys.** Endpoints, requests, and emails are independent — request rows are NOT linked to the endpoint that matched. The dashboard treats them as separate logs.
- **No soft-delete columns.** Delete is delete. Purge is delete-by-position. Recovery is via fallback inbox (for emails) or "we just lost the row" (for requests).
- **No created_by / actor tracking.** The dashboard is single-tenant from the database's perspective. Access control happens at the Cloudflare Access layer, not in the data model.

---

## 7. HTTP API contract (Pages Functions)

Base path: `https://area51.ops.example/api/`. All endpoints sit behind Cloudflare Access.

**Response conventions:**
- Success: JSON body, HTTP 200. Lists return a bare JSON array. Detail endpoints return the row object. Mutations return `{ok: true}` (purge also returns `deleted: N`).
- Error: `{error: "message"}` with status 400 (bad input) or 500 (server error). 404 returns `{error: "Not found"}`.
- Pagination: cursor-based. Page size is fixed at 10 (`PAGE_SIZE` in `_shared.js`). The cursor is the natural sort key of the last row returned — pass it as `?cursor=` for the next page. `hasMore` is inferred client-side from `results.length === PAGE_SIZE`.

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/endpoints` | List endpoints. Params: `cursor` (last `uri`), `search` (LIKE `%search%` on `uri` — **may be repeated**; multiple values are ORed (parenthesized OR group ANDed with the cursor)). Returns array of `{uri, status}`. Sorted ASC by `uri`. |
| `POST` | `/api/endpoints` | Upsert. Body: `{uri, status, headers, body}`. `headers` is a line-separated string (`Key: Value\n…`) — server parses to a JSON object before storing. Validates `uri` starts with `/`, `status` is integer 100–599. |
| `GET` | `/api/endpoints/[uri]` | Detail. `uri` is URL-encoded in the path. 404 if missing. |
| `DELETE` | `/api/endpoints/[uri]` | Delete. 404 if nothing deleted (via `meta.changes === 0`). |
| `GET` | `/api/requests` | List. Params: `cursor` (last `ts`), `search` (LIKE on `url` — **may be repeated**; multiple values are ORed (parenthesized OR group ANDed with the cursor)). Returns `{id, ts, method, url, ip}` (no headers/body in the list — saves payload). Sorted DESC by `ts`. |
| `GET` | `/api/requests/[id]` | Detail. Returns the full row including `headers` (parsed back to an object) and `body`. 404 if missing. |
| `GET` | `/api/emails` | List. Params: `cursor` (last `ts`), `search` (LIKE on `to_addr` — **may be repeated**; multiple values are ORed (parenthesized OR group ANDed with the cursor)). Returns `{id, ts, from_addr, to_addr, subject}` per row. Sorted DESC by `ts`. |
| `GET` | `/api/emails/[id]` | Detail. Returns `{id, ts, from_addr, to_addr, subject, headers, text, html, attachments}` with `headers` and `attachments` parsed back from JSON into arrays. 404 if missing. |
| `POST` | `/api/purge` | Body: `{table: "requests"\|"emails", keep: <non-negative int>}`. Deletes all rows in `table` except the most-recent `keep` by `ts`. Returns `{ok: true, deleted: N}`. **`table` is validated against an allowlist before being interpolated into SQL** — don't remove that validation. |
| `POST` | `/api/endpoints/autopilot/purge` | Deletes every endpoint with `uri LIKE '/autopilot/%'`. No body. Returns `{ok: true, deleted: N}`. Used by the Settings "Purge autopilot endpoints" section. Manually-defined endpoints outside `/autopilot/*` are not touched. |
| `GET` | `/api/blacklist/ips` | List blacklisted IPs. Returns `[{ip, ts, note}, …]` newest-first. |
| `POST` | `/api/blacklist/ips` | Body: `{ip, note?}`. IP validated (IPv4 dotted quad, IPv6 with colons, or the literal `unknown`). `INSERT OR IGNORE` semantics — duplicate adds return success without writing. |
| `DELETE` | `/api/blacklist/ips/[ip]` | Remove. 404 if not present. |
| `GET` | `/api/blacklist/emails` | List blacklisted senders. Returns `[{email, ts, note}, …]` newest-first. |
| `POST` | `/api/blacklist/emails` | Body: `{email, note?}`. Accepts bare `addr@host` or angle-bracketed `Display <addr@host>`; stored lowercase. Validated as `^[^@\s]+@[^@\s]+\.[^@\s]+$`. |
| `DELETE` | `/api/blacklist/emails/[email]` | Remove. Lowercased + URL-decoded path param. 404 if not present. |

The `headers` round-trip is asymmetric on purpose:
- **Endpoints (write):** dashboard sends a line-separated string; server parses to JSON object before storing.
- **Endpoints (read):** server returns the JSON string as-is; dashboard parses + formats back to lines for editing.
- **Requests (read):** server parses the JSON string and returns an object directly (cleaner for the read-only request modal).

---

## 8. Cloudflare Access

Configured **manually** in the Cloudflare dashboard. Not part of the code deliverables. To set up:

1. Cloudflare → Zero Trust → Access → Applications → **Add an application** → Self-hosted.
2. **Application domains** — add **all three**, each as a separate "Application domain" row in the same app:
   - `area51.ops.example` (primary custom domain)
   - `area51-xxxx.pages.dev` (Pages production URL — always exposed by Cloudflare)
   - `*.area51-xxxx.pages.dev` (Pages per-deployment preview URLs)

   Without all three, the dashboard is reachable unprotected via the raw `pages.dev` URLs even after you've set Access on the custom domain.
3. Add **two policies, both required** (set to "Allow" with rule grouping such that both must match):
   - **Rule 1 — IP allowlist:** action Allow, include: IP in range = VPN egress IP(s).
   - **Rule 2 — Email OTP:** action Allow, include: Emails ending in `@thoropass.com`. Auth method: One-time PIN.
4. Save. Pages Functions (`/api/*`) inherit the policy automatically.

If a teammate joins the team and can't get in, they need: VPN access AND a `@thoropass.com` mailbox that can receive the OTP.

---

## 9. Deployment from a clean slate

Prereqs:
- Cloudflare account with both `oob.example` and `ops.example` already added as zones.
- Node.js 18+ and `npm`. On Kali / Debian-derived: `sudo apt install nodejs npm`.
- A **Cloudflare API token** with permissions for: Workers Scripts (Edit), D1 (Edit), Pages (Edit), Workers Routes (Edit, both account- and zone-level for the `oob.example` and `area51.ops.example` zones). The "Edit Cloudflare Workers" template covers most of these — confirm the **Zone Resources** include both target zones, not just the account.
- Export the token: `export CLOUDFLARE_API_TOKEN='cfut_...'`. All `wrangler` commands below assume it's in the environment.

### Step 1 — Install worker dependencies

```sh
cd worker
npm install
```

This pulls in `postal-mime` and `wrangler` (v4+). Verify with `npx wrangler whoami` — should print the account name `Pentest Operations` (or whatever account the token belongs to).

### Step 2 — Create the D1 database

```sh
npx wrangler d1 create area51
```

Copy the printed `database_id`. Then **copy the template** to the live config and paste the ID:

```sh
cp wrangler.toml.example wrangler.toml
# edit wrangler.toml, paste the database_id
```

`worker/wrangler.toml` is **gitignored** — the live ID stays local. The template stays in the repo with the placeholder.

### Step 3 — Apply the schema

From the repo root:

```sh
npx wrangler d1 execute area51 --file=schema.sql --remote
```

Verify:

```sh
npx wrangler d1 execute area51 --command "SELECT name FROM sqlite_master WHERE type='table'" --remote
```

Should list `endpoints`, `requests`, `emails` (and `_cf_KV`, which is Cloudflare's internal D1 metadata table — ignore it).

### Step 4 — Deploy the Worker

```sh
cd worker
npx wrangler deploy
```

The `routes = [{ pattern = "oob.example", custom_domain = true }]` entry in `wrangler.toml` makes Wrangler create the **Custom Domain** binding for `oob.example` automatically. Cloudflare manages the DNS A/AAAA records for you — no manual DNS step.

> **If you get `Authentication error [code: 10000]` on the routes API:** the API token is missing zone-level permissions for the `oob.example` zone. Two ways out:
> 1. Add `Zone → Workers Routes → Edit` for the `oob.example` zone to the token, then re-run `npx wrangler deploy`.
> 2. Or, comment out the `routes` block in `wrangler.toml` and bind the Custom Domain manually: **Workers → area51-worker → Settings → Domains & Routes → Add → Custom Domain → `oob.example`**.

Verify with `curl https://oob.example/anything` — should return `404! Not Found` (no endpoints configured yet, but the worker is responding). Then check that the hit was logged:

```sh
npx wrangler d1 execute area51 --command "SELECT ts, method, url, ip FROM requests ORDER BY ts DESC LIMIT 5" --remote
```

### Step 5 — Enable Email Routing (dashboard only)

Wrangler v4 does not configure email triggers. Do this in the Cloudflare dashboard:

1. **Cloudflare → `oob.example` zone → Email → Email Routing → Get Started** (if not already enabled).
2. Once enabled, go to **Routing rules → Catch-all address → Edit**.
3. Action: **Send to a Worker** → pick `area51-worker`.
4. Save.

After this, any email to `*@oob.example` invokes the worker's `email` handler.

### Step 6 — Deploy Pages

```sh
cd ..
npx wrangler pages deploy pages --project-name area51
```

The first deploy creates the Pages project. Then in the dashboard, two things only the dashboard handles:

- **Cloudflare → Pages → area51 → Settings → Functions → D1 database bindings:** add a binding `DB` → `area51` for **both Production and Preview**. ⚠️ Without this, every `/api/*` call returns 500.
- **Cloudflare → Pages → area51 → Custom domains:** add `area51.ops.example`.

Redeploy once after adding the binding so the new env is picked up: `npx wrangler pages deploy pages --project-name area51`.

### Step 7 — Configure Cloudflare Access

Follow [§8](#8-cloudflare-access). Without this, `area51.ops.example` is open to the world.

**Also cover the Pages-generated URLs.** Pages always exposes the dashboard at `area51-xxxx.pages.dev` (production) and `<hash>.area51-xxxx.pages.dev` (per-deployment previews) regardless of any wrangler.toml setting. Make sure your Access application includes these hostnames so they're locked behind the same IP + OTP policies — see [§8](#8-cloudflare-access) for the exact hostnames to add.

### Step 8 — Smoke

Run the tests in [§12](#12-smoke-tests).

---

## 10. Local development

### Worker

```sh
cd worker
npm install
wrangler dev               # local dev server, talks to remote D1 by default
wrangler dev --local       # also use a local SQLite for D1 (note: no shared state with deployed)
```

`wrangler tail` (after deploy) streams structured-JSON logs from the live worker — useful for watching real callbacks come in.

### Pages

```sh
cd pages
wrangler pages dev . --d1=DB=area51
```

This serves the static files and runs Pages Functions locally against the remote D1 (the `--d1=DB=area51` maps the `DB` binding). You can substitute `--d1=DB=local-db` to use a local SQLite if you want isolation.

### Seeding D1 for development

```sh
wrangler d1 execute area51 --command "INSERT INTO endpoints (uri, status, headers, body) VALUES ('/health', 200, '{\"Content-Type\":\"text/plain\"}', 'ok')" --remote
```

Or via the dashboard's "New endpoint" form once it's running.

---

## 11. Operations

### Tailing worker logs

```sh
wrangler tail area51-worker
```

Each line is a JSON object with `event` and contextual fields. Filter with `jq`:

```sh
wrangler tail area51-worker --format=json | jq 'select(.event == "email_d1_insert_failed")'
```

### Querying D1 directly

```sh
# Most recent 10 requests
wrangler d1 execute area51 --command "SELECT ts, method, url, ip FROM requests ORDER BY ts DESC LIMIT 10" --remote

# All endpoints
wrangler d1 execute area51 --command "SELECT uri, status FROM endpoints ORDER BY uri" --remote

# Storage-ish indicator: count rows per table (note: this scans, do sparingly)
wrangler d1 execute area51 --command "SELECT (SELECT COUNT(*) FROM endpoints) endpoints, (SELECT COUNT(*) FROM requests) requests, (SELECT COUNT(*) FROM emails) emails" --remote
```

### Purging data

- **Via the dashboard:** Settings tab → pick `requests` or `emails`, enter `keep`, click **Purge**, confirm.
- **Via wrangler (manual):**
  ```sh
  wrangler d1 execute area51 --command "DELETE FROM requests WHERE id NOT IN (SELECT id FROM requests ORDER BY ts DESC LIMIT 1000)" --remote
  ```

D1 storage limit on Free is **500 MB**. Check usage in the Cloudflare dashboard (D1 → area51). If Pages Functions logs show "exceeded maximum DB size," purge aggressively or upgrade.

### Rotating the fallback inbox

Currently `FALLBACK_ADDRESS = you@example.com` in `worker/wrangler.toml`. Change the value and redeploy the worker. (It's a `[vars]` entry, not a secret, so it ships with the worker bundle — that's fine because the value isn't sensitive.)

---

## 12. Smoke tests

Run these after any non-trivial deploy.

1. **Schema applied** — `wrangler d1 execute area51 --command "SELECT name FROM sqlite_master WHERE type='table'" --remote` lists `endpoints`, `requests`, `emails`.
2. **HTTP 404 + capture** — `curl https://oob.example/test` returns `404! Not Found`. A row appears in `requests`.
3. **HTTP endpoint serving** — Create an endpoint via the dashboard for `/health` returning `200 ok`. `curl https://oob.example/health` returns it. A request row is logged.
4. **Email basic** — Send a plain text email under 1 MB and with no attachments to `anything@oob.example`. A row appears in `emails` with populated `headers`, `text`, `html`, `attachments='[]'`. No forward.
5. **Email with attachment** — Send any email with an attachment. A row appears with `html = "sent_to_fallback"` while `text`, `headers`, `attachments` (metadata) are still populated. The original lands in the fallback inbox.
6. **Email oversized** — Send a >1 MB email (no attachment required). Same outcome as #5.
7. **Dashboard CRUD** — Create, edit, delete an endpoint via the modal; live behavior on `oob.example` updates immediately.
8. **Search** — Filter each tab; results match.
9. **Pagination** — "Load more" appends without duplicates; eventually shows "— end of results —".
10. **Purge** — With ≥15 rows in `requests`, purge with keep=10; only the 10 most recent remain.
11. **Access (negative)** — From outside VPN: blocked.
12. **Access (positive)** — On VPN, with a `@thoropass.com` email: OTP challenge → access granted.

---

## 13. Debugging common issues

| Symptom | Probable cause | What to check |
|---|---|---|
| Dashboard returns 401 / Access page loops | Access policy misconfigured | Cloudflare → Zero Trust → Access → app for `area51.ops.example`. Confirm IP rule matches your egress; confirm OTP rule targets `@thoropass.com`. |
| `/api/*` returns HTML instead of JSON | D1 binding missing | Cloudflare → Pages → area51 → Settings → Functions → D1 bindings. Add `DB` → `area51` for both Production and Preview. Redeploy. |
| `oob.example` returns 404 for everything | Custom Domain not bound to worker, OR endpoint table empty | In the dashboard: Workers → area51-worker → Settings → Domains & Routes should show `oob.example` as a Custom Domain. Confirm `SELECT * FROM endpoints` returns rows. |
| Endpoint exists but worker returns 404 | URI mismatch (case, trailing slash, query) | `endpoints.uri` matches `url.pathname` **exactly**. Re-check the path stored. |
| Email isn't arriving in `emails` table | Email Routing not enabled or not pointed at worker | Cloudflare → oob.example zone → Email → Email Routing. Catch-all destination must be the worker. |
| Email arrives but body is empty / parse fails | postal-mime parse threw on the worker | Check Workers Logs for `email_parse_failed`. The D1 row still gets written, but `headers`, `text`, `html`, `attachments` may be `NULL`. The dashboard will just show the minimal envelope (from/to/subject/ts). |
| Request count keeps dropping | Someone purged; or a deploy with the wrong `keep` value | Check Pages Functions logs for `/api/purge` calls. There's no audit trail. |
| Worker logs show `http_log_insert_failed` | D1 transient error or quota | Logs are best-effort by design — but if it's repeated, check D1 health and storage. |
| Dashboard's Endpoints search misses matches | LIKE search is `uri LIKE '%query%'` — full-table scan, but exact-substring | Try a shorter / different substring. There's no fuzzy search. |
| Wrong timestamps in the dashboard | Browser timezone vs UTC | `ts` is UTC ISO 8601; the dashboard renders in the local timezone via `Intl.DateTimeFormat`. Confirm system tz. |

---

## 14. Known constraints & caveats

- **D1 row size limit: 2 MB.** Mitigated for emails by the 1 MB forward threshold; the actual body length we write to D1 is typically a fraction of `message.rawSize` (Cloudflare's reported size includes envelope/routing overhead), so 1 MB against `rawSize` leaves comfortable headroom against the 2 MB row cap. Endpoint bodies aren't validated client-side — if someone tries to save a >2 MB endpoint body, the INSERT will fail and the dashboard will surface "Save failed".
- **D1 storage limit: 500 MB on Free tier.** Purge regularly. No automatic eviction.
- **Search is full-table scan.** `LIKE '%query%'` doesn't use indexes. Fine at thousands of rows; switch to FTS5 if volume grows.
- **Pagination is best-effort during writes.** Cursor pagination is stable only as long as the data between pages doesn't change. New emails arriving during a scroll won't appear until you re-search/refresh.
- **No optimistic UI.** Every action awaits the API response. Slightly slower-feeling but simpler.
- **No transaction isolation in the dashboard.** Two pentesters editing the same endpoint at the same time: last write wins. Accepted for internal tooling.
- **`message.rawSize` BigInt quirk.** Cloudflare's email worker types declared `rawSize` as `number` but historically returned `BigInt`. We wrap in `Number()`. If a future Workers release changes the type, the `Number()` is still safe.
- **Pages Functions cold start.** First request after idle can take 1–2s. Subsequent requests are fast. Not worth optimizing.
- **No rate limiting on `oob.example`.** The exploit server is meant to be reachable. If abuse happens, layer Cloudflare WAF or rate limiting at the edge.
- **postal-mime only runs in the worker.** The dashboard no longer parses any EML in the browser — it reads pre-parsed columns from D1. Removes the prior dependency on `esm.sh` for the frontend, and the lazy-load latency on first email modal open.
- **The dashboard relies on Babel-standalone in the browser.** Initial load is ~3 MB. Acceptable for an internal tool used by ~5 people who keep it open.
- **No CSRF protection on `/api/*`.** Cloudflare Access cookies are SameSite by default and the dashboard is same-origin, so CSRF risk is bounded — but if you ever ship a third-party-embedded UI, revisit this.

---

## 15. Agent API + MCP server (`agent-a51.ops.example`)

A separate Cloudflare Worker (`agent-a51-worker`, code in `agent-worker/`) exposes (a) the last 5 minutes of captured `requests` and `emails` and (b) CRUD over `/autopilot/*` endpoint stubs to authorized Claude Code / Codex agents during pentests. Think of it as "Burp Collaborator + a programmable response server, exposed via MCP" — structured access for an LLM-driven agent without any human in the loop.

### 15.1 What it serves

All endpoints behind the same bearer-style header `X-A51-Secret: <secret>`:

| Method | Path | Returns |
|---|---|---|
| `GET` | `/requests` | `{served_at, window_minutes: 5, rows: [{id, ts, method, url, ip}, …]}` — newest-first, all rows in the last 5 minutes. |
| `GET` | `/emails` | `{served_at, window_minutes: 5, rows: [{id, ts, from_addr, to_addr, subject, text}, …]}` — newest-first, all rows in the last 5 minutes. |
| `GET` | `/autopilot/endpoints` | List endpoints whose URI starts with `/autopilot/`. Returns `{rows: [{uri, status, headers, body}, …]}` — sorted ASC by uri. |
| `POST` | `/autopilot/endpoints` | Upsert. Body: `{uri, status, headers, body}`. `uri` MUST start with `/autopilot/` — server returns 400 otherwise. |
| `GET` | `/autopilot/endpoints/<uri>` | Read one. URI is URL-encoded in the path. Same `/autopilot/` prefix rule. |
| `DELETE` | `/autopilot/endpoints/<uri>` | Delete one. Same prefix rule. |
| `POST` | `/mcp` | MCP JSON-RPC 2.0 server. Six tools (see §15.4). |

**No parameters on the read endpoints.** Window (5 min) and result schema are hardcoded server-side. Agents cannot widen the window, change the polling cadence, or get more rows.

**The `/autopilot/` prefix is hardcoded** in the worker and applies to every CRUD path. The agent worker has no ability to read, create, update, or delete an endpoint outside that namespace — a separate guardrail from the dashboard's full-namespace CRUD via `/api/endpoints`.

### 15.2 Why a separate worker

- **Different domain semantics.** `oob.example` catches every path as a target endpoint; mixing in reserved paths there would pollute the namespace and let probes touch the reserved paths.
- **Different read pattern.** The exploit-server worker is write-heavy on the request log path. The agent worker is read-oriented (with bounded writes via the `/autopilot/*` CRUD path).
- **Different auth model.** The exploit server is wide open (it has to be reachable by targets). The agent worker is locked behind a shared secret. Different surface, different rules.
- **Different blast radius.** A runaway agent making mistakes through the agent worker is bounded to `/autopilot/*` and recent reads. It cannot touch the rest of the endpoint table or the blacklists.

Both workers share the same D1 binding (`area51` database). Schema doesn't change.

### 15.3 No edge cache on the agent worker

Earlier versions of this worker wrapped the read endpoints in a 60-second `caches.default` edge cache. **Removed** because:

- During an active engagement an agent polling `/requests` or `/emails` wants the freshest possible view (a 60s stale snapshot can hide a just-arrived callback that the agent's reasoning depends on).
- D1 read budget at realistic pentest volume is small enough that the cache wasn't earning its complexity — even with one agent polling every 30 seconds at 100 callbacks/min, you land at ~3M reads/day worst case across both endpoints, still under the 5M/day free quota.

So every call hits D1. The `/autopilot/*` CRUD endpoints are also uncached — they're mutations or fresh reads. The `Cache-Control: no-store` header is set on all responses to discourage clients from caching on their end either.

### 15.4 MCP server (what it is and how Claude Code uses it)

The Model Context Protocol is Anthropic's spec for letting LLMs talk to external tools through a typed interface. `POST /mcp` on this worker speaks MCP's JSON-RPC 2.0 transport (single-request HTTP, no SSE needed because our tools complete fast). Six tools exposed:

| Tool | Wraps | Args |
|---|---|---|
| `requests_recent_5min` | `GET /requests` | — |
| `emails_recent_5min` | `GET /emails` | — |
| `autopilot_endpoints_list` | `GET /autopilot/endpoints` | — |
| `autopilot_endpoints_get` | `GET /autopilot/endpoints/<uri>` | `{uri}` |
| `autopilot_endpoints_upsert` | `POST /autopilot/endpoints` | `{uri, status, headers?, body?}` |
| `autopilot_endpoints_delete` | `DELETE /autopilot/endpoints/<uri>` | `{uri}` |

Each tool has an agent-friendly description in the tool schema explaining *when* to use it. The `initialize` response also returns an `instructions` field giving the agent a brief preamble: what AREA 51 is, what the tools do, and the `/autopilot/` prefix rule.

To register the MCP server in Claude Code on a pentester's machine:

```sh
claude mcp add area51 https://agent-a51.ops.example/mcp \
  --transport http \
  --header "X-A51-Secret: <secret-from-.env>"
```

After that, any Claude Code session on that machine has all six `mcp__area51__*` tools available as native tool calls. The model invokes them directly; no curl, no header juggling, no JSON-parsing instructions in the system prompt. The bearer header lives in Claude Code's config (`~/.claude/...`), not in the conversation.

### 15.5 Auth + secret management

- Secret name: `AGENT_SECRET`. Long random hex, generated with `openssl rand -hex 32`.
- **Header**: clients send `X-A51-Secret: <secret>` on every request (REST and MCP).
- **Comparison**: constant-time `XOR` byte compare (see `agent-worker/src/index.js` `constantTimeEqual`) — eliminates timing-side-channel info about the secret.
- **Storage on the worker**: installed via `wrangler secret put AGENT_SECRET`, encrypted in Cloudflare's vault. Never appears in `wrangler.toml` or `[vars]`.
- **Storage locally**: lives in the repo-root `.env` (gitignored) so `scripts/deploy-agent.sh` can re-install it after rotation without anyone having to remember the value.
- **Rotation**: `openssl rand -hex 32 > newvalue`, update `.env`, run `./scripts/deploy-agent.sh`. Then teammates re-run `claude mcp add` (or edit their MCP config) with the new value.

### 15.6 Deploying

From a clean clone:

```sh
cp .env.example .env
# fill in CLOUDFLARE_API_TOKEN, AGENT_SECRET (openssl rand -hex 32),
# and all the other values from .env.example's comments

./scripts/deploy-agent.sh
# → renders agent-worker/wrangler.toml from the template + .env
# → wrangler secret put AGENT_SECRET (piped, never in argv)
# → wrangler deploy
```

Then in the Cloudflare dashboard:

- **Workers → agent-a51-worker → Settings → Domains & Routes** → Add Custom Domain → `agent-a51.ops.example`. (Manual because the current API token doesn't have Zone Resources permissions for `ops.example`; if you ever expand the token's zone scope, you can add a `routes = [...]` block to the template.)

That's it. Six endpoints + an MCP server live behind `https://agent-a51.ops.example/`.

### 15.7 Smoke tests for the agent worker

```sh
SECRET=$(grep ^AGENT_SECRET .env | cut -d= -f2)
BASE=https://agent-a51.ops.example

# REST
curl -sS -H "X-A51-Secret: $SECRET" $BASE/requests | jq .served_at
curl -sS -H "X-A51-Secret: $SECRET" $BASE/emails   | jq .served_at

# Auth negative
curl -sS -o /dev/null -w "%{http_code}\n" $BASE/requests   # → 401

# MCP handshake
curl -sS -H "X-A51-Secret: $SECRET" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  $BASE/mcp | jq .

# MCP tools/list
curl -sS -H "X-A51-Secret: $SECRET" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  $BASE/mcp | jq '.result.tools[].name'

# MCP tools/call
curl -sS -H "X-A51-Secret: $SECRET" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"requests_recent_5min","arguments":{}}}' \
  $BASE/mcp | jq '.result.content[0].text | fromjson | .rows | length'
```

The expected steady-state cost of all this: a few hundred to a few thousand D1 reads per day. We could run dozens of concurrent pentest agents continuously and still not stress the free tier.

---

## 16. Design decision log

These are the non-obvious choices. Each is here because someone might be tempted to undo it without realizing the cost.

### 16.1 No row counts anywhere in the UI

The original design had tab-count badges ("Endpoints 42 · Requests 5,183 · Emails 926") and a Settings stats panel. We removed both. **D1 bills per row scanned** — `SELECT COUNT(*) FROM emails` over 1k rows is 1k row reads, and a dashboard refresh would burn ~6k row reads on counts alone. At our usage that's still well under the Free tier (5M reads/day), but the polish-to-cost ratio is bad: scans grow linearly with table size and offer ~zero user value at this scale.

The textbook fix is a separate `counters` table updated by `AFTER INSERT/DELETE` triggers — O(1) reads forever, +1 write per mutation, +50 lines of schema. We rejected it as **schema complexity not worth the polish**. The dashboard does show `{rows.length} loaded` in each tab's toolbar — that's free.

If you bring counts back, do it via counters + triggers, not COUNT(*).

### 16.2 Endpoints list shows URI + status (and only those)

The original design showed URI, status, header count, and body length per row, populated via N+1 lazy fetches. We re-shaped that: the list endpoint returns just `{uri, status}` (two columns), the row renders status using the same color-coded `status-2xx/3xx/4xx/5xx` tags as the Requests tab, and the full headers/body are fetched only when the modal opens.

Why this shape:
- **Status is high-signal at-a-glance** (lets you spot a misconfigured 500 or an unintentional 200 OK at a glance).
- **Headers count and body length aren't** — both require either an extra round-trip per row or fattening the list payload, and neither tells you anything that the modal doesn't show better.
- One query per page (10 rows) instead of 11 (1 list + 10 lazy details).

### 16.3 Purge banner doesn't show a row delete count

To keep "will delete X of Y rows" accurate, we'd need to fetch the current table count every time the user changes the `keep` input. Same row-scan cost as the counts decision. The simplified banner ("will keep the latest N · older rows permanently deleted · no undo") communicates the action; the user sees the resulting `deleted: N` count via the success toast.

### 16.4 No build pipeline for the frontend

React + Babel-standalone loaded from unpkg, JSX transpiled in the browser. **Pro:** zero build deps, zero version-skew chores, deploys are pure file uploads. **Con:** ~3 MB of JS on first load, no tree-shaking, no TypeScript. For a 5-person internal tool, the trade is worth it. If the dashboard grows past ~2 k lines of frontend code, revisit Vite + a real build.

### 16.5 Worker parses once; dashboard reads parsed columns

The earlier design kept the raw EML in D1 and re-parsed it in the browser on every modal open. We replaced that with worker-side parsing into structured columns (`headers`, `text`, `html`, `attachments`). Tradeoffs:

- **Wider schema** — `emails` went from `{id, ts, from_addr, to_addr, subject, raw_eml}` (6 cols) to a 9-col table.
- **Worker does parsing work on the write path** — small CPU cost, well within Cloudflare's free Worker CPU budget.
- **Frontend loses the postal-mime dependency entirely** — no `esm.sh` runtime fetch, no lazy-load latency, no extra `~50 KB` JS on first email open.
- **No re-parsing on read** — dashboard is a thin renderer of the columns.
- **Attachment content is never persisted.** Only metadata. Pentest mail attachments stay in the fallback inbox; D1 carries the filename/mime/size for reference.

### 16.6 `html = "sent_to_fallback"` as a sentinel

We could add a separate `was_forwarded` boolean column. Instead, we overload the `html` column with a literal string marker on rows whose original got forwarded to the fallback inbox (due to size > 1 MB or any attachment present).

- **Pro:** schema stays narrow. Frontend already knows how to render `data.html` — checking for the marker is one extra comparison.
- **Con:** the dashboard has to know the magic string. Both sides reference it directly:
  - Worker writes: `html: 'sent_to_fallback'` in the INSERT
  - Dashboard reads: `data.html === "sent_to_fallback"` to flip on the yellow notice
- **Why `html` and not `text`?** The other fields (`text`, `headers`, `attachments`) are still populated on fallback rows so the user can see *what* triggered the fallback. The `html` body is the one piece we don't want to render (could be huge / not present), so it's the natural home for the sentinel.

If you change the marker or the column it lives in, change both sites in the same commit.

### 16.7 Endpoints are exact-match, not glob

The worker matches `url.pathname` against `endpoints.uri` with `WHERE uri = ?`. No wildcards, no regex. A request to `/foo/bar` only matches an endpoint with `uri = '/foo/bar'`. This is intentional for now:
- Predictability: the table is the source of truth, no precedence rules to reason about.
- Simplicity: a `WHERE uri = ?` against the primary key is the cheapest possible lookup.

If you need patterns, add a separate `endpoint_patterns` table queried only on cache miss, and document the precedence order here.
