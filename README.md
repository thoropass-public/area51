# AREA 51 · Black Holes · Autopilot

Internal out-of-band callback infrastructure for the Thoropass security team. Hosted on Cloudflare.

This document is the **canonical, exhaustive technical primer** for the project. It's written so a first-time user can use it, a new developer can take over from cold, and an oncall engineer can debug an outage without paging anyone. **Keep it in sync with every code change.** If a change affects anything described here, update this file as part of the same commit.

The original design spec (`pre-context.md`) and the Claude Design handoff bundle are kept internal to the team and aren't in this repo. Ask Apaar if you need them.

---

## Table of contents

1. [What it is](#1-what-it-is)
2. [Architecture](#2-architecture)
3. [Repository layout](#3-repository-layout)
4. [The Black Holes worker](#4-the-black-holes-worker)
5. [AREA 51 — the dashboard (Cloudflare Pages)](#5-area-51--the-dashboard-cloudflare-pages)
6. [D1 database](#6-d1-database)
7. [HTTP API contract](#7-http-api-contract-pages-functions)
8. [Deployment from a clean slate](#8-deployment-from-a-clean-slate)
9. [Local development](#9-local-development)
10. [Operations](#10-operations)
11. [Smoke tests](#11-smoke-tests)
12. [Debugging](#12-debugging-common-issues)
13. [Known constraints & caveats](#13-known-constraints--caveats)
14. [Autopilot — agent worker + MCP server](#14-autopilot--agent-worker--mcp-server)
15. [Design decisions](#15-design-decision-log)
16. [The area51-cleanup worker](#16-the-area51-cleanup-worker)

---

## 1. What it is

Internal out-of-band callback infrastructure for the Thoropass pentest team. Pentesters interact with three named pieces:

- **AREA 51** — the dashboard. Configure endpoints, browse captured requests and emails, manage blacklists.
- **Black Holes** — attacker-controlled domains, each acting as an entry-point for incoming **HTTP requests**, incoming **email**, or both. Anything a target sends to a black hole ends up captured in D1 for the pentester to inspect via AREA 51.
- **Autopilot** — the MCP server (with a REST mirror) that authorized Claude Code / Codex agents connect to during engagements. Surfaces recent requests + emails and CRUD over a reserved `/-/*` endpoint namespace so an agent can stage response stubs and observe callbacks on its own.

Each black hole's role is configurable per domain — some catch only HTTP, some only mail, some both. The list of currently-bound black holes is **not hardcoded in this repo**; it lives in the D1 `domains` table, read live by the dashboard ([`/api/config/domains`](#7-http-api-contract-pages-functions), for the Home orbit chips) and by the Autopilot worker (so an agent can build full callback URLs). To add or remove a black hole: edit the `domains` table (`wrangler d1 execute`) and bind/unbind the domain to the Black Holes worker via Cloudflare's Custom Domain UI. No redeploy needed for the table change.

Targets that fetch URLs, send webhooks, click email links, or otherwise reach out to "the internet" can be steered to one of these black holes, where:

- the **HTTP traffic** is captured (full request, headers, body), and
- the **server's response** is whatever the pentester has configured for that path.

Use cases:
- SSRF / blind SSRF (capture the callback and inspect what came through)
- OAuth `redirect_uri` abuse (host a redirect or token-grab page)
- XXE / SSRF data exfiltration (host a DTD or follow-up payload)
- CSRF / clickjacking PoC hosting
- Phishing landing pages and email-based interaction proofs (any address at a mail-enabled black hole is a catch-all inbox)
- Generic "callback received" confirmation for interaction-based vulnerabilities

It is **not customer-facing**. All users are trusted Thoropass team members. Design prioritizes simplicity and maintainability over hardening or scale. The black holes themselves are open to the internet because they have to be reachable by targets.

---

## 2. Architecture

```
                ┌────────────────────────────────────────────────────────┐
                │ Cloudflare                                             │
                │                                                        │
  Internet ─────┼─► <black-hole-domain>/*   (Black Holes worker)         │
  (targets,     │     ├── HTTP fetch handler ──┐                         │
   email)       │     └── Email handler ────┐  │                         │
                │                           │  │                         │
                │                           │  ▼                         │
                │                           │ ┌────────────────────────┐ │
                │                           │ │ D1: area51 database    │ │
                │                           │ │  ├── endpoints         │ │
                │                           │ │  ├── requests          │ │
                │                           │ │  ├── emails (lean)      │ │
                │                           │ │  └── *_blacklist       │ │
                │                           │ └────────────────────────┘ │
                │           raw .eml ───────┤  ▲                         │
                │           ▼               │  │                         │
                │ ┌────────────────────────┐│  │                         │
                │ │ R2: area51-emails      ││  │                         │
                │ │  emails/<id>.eml       ││  │                         │
                │ └────────────────────────┘│  │                         │
  Pentester ────┼─► AREA 51 dashboard       │  │                         │
   (browser)    │   (Cloudflare Pages)      │  │                         │
                │   ├── index.html, *.jsx ──┘  │ (read/write D1;         │
                │   └── /functions/api/* ──────┘  read R2 for raw .eml)  │
                │                              │                         │
  AI agent ─────┼─► Autopilot worker           │                         │
   (REST / MCP) │   /requests, /emails,        │                         │
                │   /emails/<id>/raw, ─────────┘                         │
                │   /-/*, /mcp                                   │
                │                                                        │
                │                              ┌────────────────────────┐│
                │ Email Routing fallback ─────►│  FALLBACK_ADDRESS      ││
                │ (only on capture error:      │  (catch-all inbox)     ││
                │  R2 PUT / handler throws)    └────────────────────────┘│
                └────────────────────────────────────────────────────────┘
```

The same Cloudflare account hosts three runtime pieces, backed by one D1 database (lean rows) and one R2 bucket (raw `.eml` blobs):

| Piece (user lingo) | Implementation | What it does |
|---|---|---|
| **AREA 51** (the dashboard) | Cloudflare Pages site (project `area51`) | Static React dashboard + Pages Functions JSON API; manage endpoints, browse captures, manage IP / email blacklists |
| **Black Holes** (the catch-all domains) | one Worker (service `area51-worker`), bound via Custom Domain to each black hole | Serves arbitrary HTTP responses from D1; captures every request; receives `*@<black-hole>` email, stores the raw `.eml` to R2, writes a lean index row to D1 |
| **Autopilot** (the agent interface) | a second Worker (service `agent-a51-worker`), bound to its own Custom Domain | Bearer-auth REST + MCP server; recent requests / emails reads, on-demand raw `.eml` download (60-min gated), and `/-/*` endpoint CRUD for authorized Claude Code / Codex agents |
| **area51-cleanup** (scheduled retention) | a third Worker (service `area51-cleanup`), **no Custom Domain** — cron-triggered only | Runs daily; trims `requests` to the newest N rows and deletes `emails` older than M days (D1 rows **and** their R2 `.eml` blobs, in lockstep), **except starred emails, which are kept indefinitely**. See [§16](#16-the-area51-cleanup-worker) |
| **R2** (`area51-emails`) | bucket binding `EML` on worker, agent worker, Pages | Verbatim raw `.eml` per email at `emails/<id>.eml`; read on demand by the email modal (fetched on open, for the body/headers/attachments) + Download Raw, and by Autopilot |
| **D1 database** | binding `DB`, name `area51` | Single SQLite-style DB shared by Pages and both workers |
| **Email Routing** | on each mail-enabled black hole zone | Catch-all delivers incoming mail to the Black Holes worker's email handler |

### 2.1 HTTP request flow (target → black hole)

```
target ──► <black-hole>/some/path
              │
              ▼
         BlackHolesWorker.fetch()
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

### 2.2 Email flow (sender → *@<black-hole>)

```
sender ──► *@<black-hole>
              │  (Cloudflare Email Routing catch-all)
              ▼
         BlackHolesWorker.email(message)
              │
              ├─ id = uuid, ts = now
              ├─ blacklist check → setReject + return if sender is listed
              ├─ buf = await message.raw → ArrayBuffer   (read once)
              ├─ parsed = postal-mime.parse(buf)         (subject, attachment count — no body)
              │
              ├─ R2.put("emails/<id>.eml", buf)          (verbatim raw .eml)
              ├─ INSERT lean row into emails
              │     (id, ts, from, to, subject, attachment_count)
              │     read/starred default to 0; the worker never sets them
              │
              └─ on ANY error (raw read / R2 PUT / D1 INSERT throws):
                    forward(message → FALLBACK_ADDRESS)
                    R2.delete + DELETE FROM emails   (roll back any partial write)
```

Capture is **all-or-nothing**: on success both the R2 object and the D1 row exist; on any failure the original is forwarded to the fallback inbox and any partial write is rolled back, so D1 and R2 never keep a half-record — there are no marker rows. There is no size or attachment threshold; every email's raw `.eml` goes to R2 in full. The handler never re-throws. (D1 and R2 share no transaction, so the rollback is best-effort compensating deletes; a failed cleanup delete is logged and at worst leaves an invisible orphaned R2 object.)

### 2.3 Dashboard flow (pentester → AREA 51)

```
pentester ──► AREA 51 dashboard (Pages)
                 ├─ /, /index.html, /styles.css, /*.jsx → static files
                 └─ /api/* → Pages Functions
                            │
                            ▼
                       { GET /api/endpoints, POST, GET/[uri], DELETE /[uri],
                         GET /api/requests, GET /[id],
                         GET /api/emails, GET /[id], PATCH /[id], GET /[id]/raw,
                         GET/POST/DELETE /api/blacklist/{ips,emails},
                         GET /api/config/domains }
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
├── .env.example               ← template for the gitignored .env (single source of truth)
├── scripts/                   ← bash deploy helpers (source .env, render wrangler.toml, deploy)
│   ├── render-wrangler.sh     ← envsubst worker/wrangler.toml.template → worker/wrangler.toml
│   ├── deploy-worker.sh       ← Black Holes worker
│   ├── deploy-agent.sh        ← Autopilot worker (also installs AGENT_SECRET)
│   ├── deploy-cleanup.sh      ← area51-cleanup worker (scheduled retention; no Custom Domain)
│   ├── deploy-pages.sh        ← AREA 51 dashboard (Pages)
│   └── purge.sh               ← interactive admin purge (D1 + R2)
├── worker/                    ← Black Holes worker (one Cloudflare Worker, many bound domains)
│   ├── wrangler.toml.template ← Worker config template (D1 + R2 bindings, FALLBACK_ADDRESS)
│   ├── package.json           ← deps: postal-mime, wrangler
│   └── src/
│       └── index.js           ← single-file Worker with fetch + email handlers
├── agent-worker/              ← Autopilot worker (REST + MCP server)
│   ├── wrangler.toml.template ← Worker config template (D1 + R2 bindings; AGENT_SECRET is a Secret)
│   └── src/
│       └── index.js           ← REST handlers + MCP JSON-RPC 2.0 server
├── cleanup-worker/            ← area51-cleanup worker (scheduled retention trimmer)
│   ├── wrangler.toml.template ← Worker config template (D1 + R2 bindings, cron trigger, [vars] thresholds)
│   ├── package.json           ← deps: wrangler only (no runtime deps)
│   └── src/
│       └── index.js           ← single-file Worker with only a scheduled() handler
└── pages/                     ← AREA 51 dashboard (Cloudflare Pages site)
    ├── index.html             ← entry point; loads React/Babel UMD + the three .jsx files
    ├── styles.css             ← Nord-inspired dark dashboard, dense developer UI
    ├── ui.jsx                 ← helpers, API client, toast/modal/confirm
    ├── tabs.jsx               ← EndpointsTab, RequestsTab, EmailsTab + their modals
    ├── app.jsx                ← shell: App, TopBar, Home, Settings; mounts to #root
    └── functions/             ← Pages Functions (server-side)
        └── api/
            ├── _shared.js              ← json/errResp helpers, withErrorHandler, parseHeaderLines
            ├── config/domains.js       ← GET — reads D1 `domains` table, returns {domains:[…]}
            ├── endpoints/
            │   ├── index.js            ← GET (list+search+cursor), POST (upsert)
            │   └── [uri].js            ← GET (detail), DELETE
            ├── requests/
            │   ├── index.js            ← GET (list+search+cursor)
            │   └── [id].js             ← GET (detail; headers parsed back to object)
            ├── emails/
            │   ├── index.js            ← GET (list+search+cursor)
            │   ├── [id].js             ← GET (lean detail: subject/from/to/attachment_count/read/starred — no body) + PATCH (read/starred)
            │   └── [id]/raw.js         ← GET — streams the raw .eml from R2 (EML binding)
            └── blacklist/
                ├── ips/index.js & [ip].js       ← list/add, delete
                └── emails/index.js & [email].js ← list/add, delete
```

The three workers and the Pages project are **deployed independently** but share a single D1 database (and the `area51-emails` R2 bucket) via separate Wrangler bindings.

---

## 4. The Black Holes worker

Single-file Worker at `worker/src/index.js`, service name `area51-worker`. One npm dep: `postal-mime` (for email parsing). Compatibility flags: `nodejs_compat` (postal-mime needs it). Bound via Custom Domain to each black hole — the same worker code serves every domain, and the worker doesn't know or care which black hole a given request came in on.

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

`handleEmail(message, env, ctx)` in `worker/src/index.js`. Everything is wrapped in a top-level try/catch; the catch is the only path that forwards to the fallback inbox.

Steps:

1. `id = uuid`, `ts = now()`, `toAddr = message.to`. Envelope-from (`message.from`) is kept only for diagnostic logging — it never participates in storage, display, or blacklisting.
2. Buffer the raw EML once → parse with `postal-mime` (step 3 below) → derive `fromAddr = parsed.from.address` (the `From:` header). **Blacklist gate runs on this value, and only this value** — never on the envelope. If parsing failed or the message has no `From:` header, `fromAddr` is empty and the gate simply skips. On a hit: `message.setReject('Address not accepted')` and return — no R2 object, no D1 row (see [§6.4](#64-ip_blacklist-and-email_blacklist)).
3. Buffer the raw EML **once**: `buf = await new Response(message.raw).arrayBuffer()`. The same buffer feeds both R2 and the parser. The `message.raw` stream can only be read once.
4. `parsed = await PostalMime.parse(buf)` — used to extract `subject` and `attachment_count` (`parsed.attachments.length`). **No body is extracted or stored** — the plain-text and HTML bodies live only in the raw `.eml` and are parsed in the browser on demand. Parse failures are caught and logged; processing continues (the raw `.eml` is still stored, so the rich view works even when the worker's parse fails).
5. **`R2.put('emails/<id>.eml', buf)`** with `Content-Type: message/rfc822` — the verbatim raw message. If this throws, control falls to the catch (step 7).
6. **Lean `INSERT into emails`**: `(id, ts, from_addr, to_addr, subject, attachment_count)`. No body (`text`/`html`), `headers`, or attachment bytes are stored in D1; those live only in the R2 object. If this throws, control falls to the catch (step 7).
7. **Catch (error path):** anything above throwing (raw read, R2 PUT, **or** the D1 INSERT) → `forward(message, env.FALLBACK_ADDRESS)` so the original isn't lost, then roll back any partial write: `EML.delete('emails/<id>.eml')` and `DELETE FROM emails WHERE id = ?`. Both are best-effort (no shared transaction) and logged on failure. The handler never re-throws.

Capture is **all-or-nothing** — success means both R2 and D1 hold the email; any failure means neither does and the original is in the fallback inbox. There is no size or attachment threshold. The dashboard's email modal fetches the raw `.eml` from R2 (via `/api/emails/<id>/raw`) **immediately when it opens** and parses it in the browser — the body (plain-text and HTML), full headers, and attachments all come from that single fetch. D1 no longer stores any body text.

### 4.3 Bindings & env vars

In `worker/wrangler.toml` (rendered by `scripts/render-wrangler.sh` from `worker/wrangler.toml.template` + `.env`):

| Binding / Var | Purpose |
|---|---|
| `DB` (D1) | Cloudflare D1 binding to the `area51` database |
| `EML` (R2) | R2 bucket `area51-emails`; the worker PUTs every email's raw `.eml` to `emails/<id>.eml`. Bucket name from `R2_BUCKET_NAME` in `.env`. |
| `FALLBACK_ADDRESS` (var) | Last-resort email forward target — used only on the error path (R2 PUT / handler throws). Value set in `.env` and substituted into `worker/wrangler.toml` at render time. |
| `workers_dev = false` | Disables the auto-generated `*.workers.dev` URL — the worker is reachable only via the Custom Domains bound to it in the dashboard |
| `preview_urls = false` | Disables Cloudflare's per-version preview URLs — same lockdown rationale |

**Email Routing is configured in the Cloudflare dashboard, not `wrangler.toml`.** Wrangler v4 deprecated the `[triggers] email` config. The worker exports an `email` handler; the dashboard's Email Routing → "Send to a Worker" feature is what actually delivers inbound mail to it. See the deployment steps in [§8](#8-deployment-from-a-clean-slate).

The real `worker/wrangler.toml` (with the live D1 ID) is gitignored. The committed template is `worker/wrangler.toml.template`; `scripts/render-wrangler.sh worker` reads `.env` and substitutes the placeholders.

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
| `http_rejected_blacklist` | IP on the ip_blacklist; 403 returned, no D1 write, no endpoint serve |
| `http_endpoint_matched` | endpoint row found, about to respond |
| `http_endpoint_not_found` | no endpoint row for path |
| `http_endpoint_lookup_failed` | D1 lookup threw (rare) |
| `http_log_insert_ok` / `http_log_insert_failed` | result of the `ctx.waitUntil` request log |
| `email_received` | top of email handler |
| `email_rejected_blacklist` | sender on the email_blacklist; `setReject` invoked, no R2 object, no D1 write |
| `email_parse_failed` | postal-mime threw (non-fatal — raw `.eml` still stored, row still written) |
| `email_stored` | success: raw `.eml` in R2 **and** lean row in D1 |
| `email_capture_failed` | error path fired — forwarded to fallback, then rolled back partial writes |
| `email_rollback_r2_failed` / `email_rollback_d1_failed` | a compensating delete failed (possible orphan) |
| `email_forward_ok` / `email_forward_failed` | message.forward result |

Tail with `wrangler tail` (see [Operations](#10-operations)).

---

## 5. AREA 51 — the dashboard (Cloudflare Pages)

A static site + Pages Functions, both deployed from `pages/`. Cloudflare Pages project name `area51`. This is what pentesters open in a browser to manage the platform.

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
  - `ListView` — generic search + paginated list wrapper used by all three tabs. The whole search field is a single visual unit: pin chips wrap inline alongside the input via flexbox; the field's border lives on the wrapper, not the input. Keyboard: **Enter** pins the current text, **Backspace** on an empty input pops the last pin, **Escape** clears the input. A `pin-add` icon button (frost color) appears at the right of the field when there's text to pin; a `clear` text-button appears whenever there's anything (search text or pins) to clear and wipes both at once. Adjacent to "X loaded" in the toolbar-meta, a small `meta-filter` badge reads "N pinned · OR" when at least one pin exists. Each pin chip is **tinted with its assigned color** (`pinColorVars` → CSS vars), and the optional `specialPins` map lets a tab render a known token as a glyph chip (Emails uses it for the `:star:` filter).
  - `usePinnedFilters(<tab>)` in `ui.jsx` loads/saves pins to `localStorage` under `area51:pins:<tab>` and a parallel color map under `area51:pins:<tab>:colors`; it returns `{pins, addPin, removePin, clearPins, colors, pinColor}`. `addPin` returns `false` if the value is empty or already pinned (case-insensitive dupe check), so the caller can avoid clearing the input on a no-op. Each value gets a color the first time it's pinned: drawn at random from a curated, theme-aware palette (`purple, orange, green, red, frost`), **preferring a color not already in use**. Yellow is reserved (not used for text pins).
  - **Color-coded match ribbons** (`pinMatches` + `PinRibbon`, both in `ui.jsx`): every row matched by a **text** pin gets a left-edge color spine, split into one segment per matching pin, so a row caught by two pins shows both colors stacked. Matching is done on the right field per tab — URI (Endpoints), URL (Requests), and for Emails the combined `from_addr + to_addr + subject` string (matching the broadened server-side search). The left edge belongs **exclusively to ribbons** — unread state is shown with a background tint (not a rail), so the two cues never collide. Ribbons are a 6px spine.
  - The effective list of search terms sent to the API is `[<live-input-text>, ...pins]` (built per-tab via the `effectiveSearch(input, pins)` helper) — all ORed server-side (any term matches → row included).
  - `EndpointsTab` + `EndpointModal` — list shows URI + color-coded HTTP status (uses the same `status-2xx/3xx/4xx/5xx` tag styling as the Requests tab). Click a row to open the modal with all fields editable; the URI is read-only on edit. Delete button on the modal asks for confirmation. The list endpoint returns just `{uri, status}` per row; full `headers` and `body` are fetched only when the modal opens. **The leading row icon is a copy button** (`EndpointRow`): it copies the full URL — `https://` + the active default host + the URI — to the clipboard, flips to a check-mark for ~1.4s, and fires a toast naming the host (e.g. *Copied oob.example/api/v1/callback*). Clicking it does **not** open the edit modal (the click is stopped); clicking anywhere else on the row still does. The active default host comes from `useActiveDomain` (see `Home`); with no host selected the button toasts an error instead of copying.
  - `RequestsTab` + `RequestModal` — read-only. The modal pretty-prints the body as JSON if it parses, otherwise shows it raw.
  - `EmailsTab` + `EmailModal` — opening an email shows the envelope metadata (from/to/subject/received/attachment count) from the lean D1 row **and immediately fetches the raw `.eml`** from `/api/emails/<id>/raw`, parsing it in the browser with postal-mime (loaded lazily as `window.PostalMime`) — there is no "More" step anymore. **Only the HTML body is rendered** (in a strict `sandbox=""` iframe) — there is no HTML/plain-text switcher. Emails with no HTML part show a small "no HTML body — use Download Raw" notice instead (the plain-text body is not surfaced in the modal; it's still in the raw `.eml`). The full headers (collapsible) and a clickable attachment list (each downloads its decoded bytes as a Blob) are also rendered from that parse. A **full-screen toggle** (the `expand`/`collapse` icon, the only body control, shown only when there's an HTML body) promotes **just the body** (the HTML iframe) — not the whole modal — to a fixed overlay covering the entire browser canvas. It's rendered via `ReactDOM.createPortal` to `document.body` (the modal backdrop's `backdrop-filter` establishes a containing block that would otherwise trap a `position: fixed` child), styled by `.body-fullscreen`. Not OS full-screen — a CSS overlay. Pressing **Esc** or the collapse button exits back to the modal (a capture-phase key handler intercepts Esc so it exits full-screen instead of closing the whole modal); the toggle rides along in the overlay's top bar. **Download Raw** in the footer saves the in-memory `.eml`. Until **both** the metadata and the parsed raw body have loaded, the whole modal body shows a single centered loader (same pattern as `RequestModal`) — nothing partial renders — then the full view appears at once. Every D1 row has a matching R2 object (capture is all-or-nothing), so it normally always resolves.
  - **Read / unread** (`EmailRow`) — **DB-backed** via the `emails.read` column. Unread pops (lighter `--n1` background, bold high-contrast subject, frost icon); read recedes (page-baseline background, muted text, open envelope). The **exact same treatment applies to group rows** — a group is unread if *any* loaded member is unread — so read/unread reads identically whether a row is a singleton or a group; the *only* group/singleton differentiators are the leftmost icon (stack vs envelope) and the trailing chevron on groups. Opening an email marks it read; the leading envelope icon toggles read ↔ unread *without* opening. Both write through `PATCH /api/emails/<id>` and update the row optimistically (rolled back on failure). **Autopilot/MCP never touches read state** — the PATCH endpoint is the sole writer.
  - **Starring + Starred filter** — **DB-backed** via the `emails.starred` column. A star toggle at the end of each row (faint on hover, gold when on) is mirrored in the modal header (`modal-star`); both write through the same PATCH. A dedicated **Starred** toggle button in the toolbar (gold when active) filters the list to starred mail. It is an **AND** constraint, not a search pin: with nothing else active it shows all starred; with pins/search active it shows only starred mail that *also* matches. Server-side this is `?starred=1` → a separate `AND starred = 1` (not part of the search OR group). Un-starring a row while the filter is active drops it from the list (refetch). *(This replaced the old `:star:` search-bar pin, which OR-combined instead.)*
  - **Search spans From / To / Subject** — each Emails search term ORs across all three columns server-side (Requests still searches `url`, Endpoints `uri`). No extra D1 cost: broadening the OR only makes the filter *less* selective, so the `ts`-ordered scan hits its 50 matches at least as fast (rows read is unchanged-or-fewer; the extra `LIKE`s are CPU, which isn't billed as rows).
  - **Conversation grouping** (`groupEmails` + `EmailGroupRow` + `EmailGroupView`) — **always on and enforced (no toggle)**: every set of ≥2 loaded rows sharing the **exact** `(from_addr, to_addr, subject)` triple collapses into one **group row**. Grouping is **global** (all matching loaded rows fold in, positioned at the newest member's `ts`) and a pure client-side view transform over the loaded rows. A group row shows the latest ts + from + to + subject and carries the **same read/unread treatment as any row** (unread if any loaded member is unread); it differs from a singleton only by its leftmost **stack icon** (vs the envelope) and a trailing **chevron**. It is **non-interactive except the click** — no star toggle, and its icon isn't a read toggle. Clicking it **drills in**: the tab swaps to `EmailGroupView`, a self-contained, **server-backed** list of *every* message with that exact triple (via `GET /api/emails?from_eq&to_eq&subject_eq`, its own cursor + Load More), with a **← Back** control and the triple shown in the header. Inside the drill-in each message is a normal `EmailRow` (read/star/open-modal all work); the already-loaded root rows are irrelevant — it re-fetches authoritatively. Singletons at the root open the modal directly. There is intentionally **no count** on the group row (an accurate total would need a per-group `COUNT(*)`, the per-row-billing pattern [§15.1](#151-no-row-counts-anywhere-in-the-ui) avoids).
  - **Fill-to-50 pagination** (`DISPLAY_TARGET`, `displayedCount`) — because grouping can collapse a 50-row page into a handful of displayed rows, `fetchFirst`/`loadMore` **loop**: they keep paging (cursor on the underlying row `ts`, since grouping is view-only) until at least ~50 rows are *displayed* (groups counted as 1) or the data runs out. **No cap** — a spam-dominated load may pull several pages in one go, bounded only by the table.
  - HTML body is rendered in a strict-sandbox `<iframe sandbox="" srcDoc={...}>`. Plain-text body in a `<pre>`. Attachments are surfaced as `{filename, mime, size}` rows — content bytes are never stored or exposed.
  - `decodeMimeWord(s)` (in `ui.jsx`) decodes RFC 2047 encoded-words (`=?charset?B?...?=` / `=?charset?Q?...?=`) before display. Applied to `from_addr`, `to_addr`, `subject`, and rendered header values. Worker-side extraction prefers postal-mime's already-decoded `parsed.subject` over the raw header value, so new rows arrive decoded; `decodeMimeWord` is a defense-in-depth pass for any encoded-word that slips through (older rows, display names in envelope fields, header values).

- **`app.jsx`** — the shell.
  - `App` — top-level component. Tab state, keyboard shortcut handler (⌘/Ctrl + 1–4 → endpoints/requests/emails/settings), wraps everything in `ConfirmProvider` + `ToastProvider`.
  - `TopBar` — brand mark + tabs + a refresh button on the far right that's visible only on list tabs (endpoints / requests / emails). The button increments an `App`-level `refreshTick` counter that the active list tab consumes as a `refreshKey` prop in its `fetchFirst` `useEffect` dependency array, causing a re-fetch of the first page. The icon spins briefly (~600ms) on click for visual feedback; the spin isn't synced to the actual loading state since each tab already shows its own spinner over the list rows.
  - `Home` — the marketing-style landing tab: AREA 51 hero, intro copy, four navigation tiles. The hero's **orbit chips double as a default-host picker**: clicking a chip sets it as the active host for copied endpoint URLs (persisted to `localStorage` under `area51:activeDomain`, with an unmistakable selected state — frost ring + glow, frost dot, bolder address). Only hosts that serve `http` (http-only or http+mail) are selectable; **mail-only hosts are locked out**. The domain list is fetched once into `window.DOMAINS` (shared cache) by `useDomains`/`useActiveDomain` in `ui.jsx`, so the copy button on the Endpoints tab resolves a default even if Home was never opened; `resolveActiveDomain` falls back to the first eligible host when nothing is stored.
  - `Settings` — blacklist management only. Purging data is intentionally not exposed in the UI; see [Operations → Manual purge](#manual-purge).

### 5.2 HTML iframe sandbox for email bodies

When `ParsedEmailView` renders an email's HTML body, it does so in:

```jsx
<iframe sandbox="" srcDoc={parsed.html} title="email html"/>
```

`sandbox=""` (no allowed tokens) is the **strictest** sandbox: no scripts, no same-origin access, no form submission, no top-navigation. Even though this is internal-only, emails arrive from untrusted senders, so HTML bodies must be treated as hostile. Do not relax this sandbox.

### 5.3 Pages Functions (`/functions/api/*`)

Each file under `pages/functions/api/` exports `onRequestGet` / `onRequestPost` / `onRequestDelete` named handlers. Every handler is wrapped in `withErrorHandler` (`_shared.js`), which try/catches, logs the error via `console.error`, and returns `{ error: "Internal error" }` with HTTP 500 on any uncaught throw.

The full HTTP API contract is in [§7](#7-http-api-contract-pages-functions). Note: the `/-/*` namespace inside `endpoints` is reserved for the **Autopilot** worker (see [§14](#14-autopilot--agent-worker--mcp-server)); AREA 51's UI treats it as a normal endpoint table.

---

## 6. D1 database (+ R2 for raw emails)

Schema in `schema.sql`. Five tables (`endpoints`, `requests`, `emails`, `ip_blacklist`, `email_blacklist`) plus the R2 bucket for raw `.eml` blobs ([§6.6](#66-r2-raw-eml-storage)). Apply the schema with:

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

No `ts` / `created_at` — the worker doesn't need it, and nothing surfaces it. (This is why the Autopilot Endpoints purge in `scripts/purge.sh` wipes the whole `/-/*` namespace rather than purging by age — there's no timestamp to age against.)

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

A **lean index row** per captured email. The full message — all headers, both bodies (plain-text and HTML), attachment bytes — lives only in the raw `.eml` in R2 ([§6.6](#66-r2-raw-eml-storage)); D1 holds just the envelope metadata the list, search, and Autopilot need. **There is no body column** — the body is always read from the raw `.eml` on demand.

| Column | Type | Notes |
|---|---|---|
| `id` | `TEXT PRIMARY KEY` | UUIDv4 generated in the worker; also the R2 key (`emails/<id>.eml`) |
| `ts` | `TEXT NOT NULL` | ISO 8601 UTC. Indexed `DESC`. |
| `from_addr` | `TEXT NOT NULL` | The `From:` header address (`parsed.from.address`), i.e. what the dashboard shows. Empty (`''`) if parsing failed or the message has no `From:` header — the envelope sender is intentionally not used as a fallback. The full envelope is recoverable from the raw `.eml` in R2 if you ever need it. |
| `to_addr` | `TEXT NOT NULL` | `message.to` (envelope recipient) |
| `subject` | `TEXT` | Extracted from parsed headers / `parsed.subject` |
| `attachment_count` | `INTEGER NOT NULL DEFAULT 0` | `parsed.attachments.length`. Shown as a count in the modal; full attachment details come from the raw `.eml`. |
| `read` | `INTEGER NOT NULL DEFAULT 0` | Per-email UI state: `0` = unread, `1` = read. Written **only** by the dashboard (`PATCH /api/emails/<id>`) — the worker inserts with the default and Autopilot/MCP is read-only, so neither can change it. Drives the unread/read row styling. |
| `starred` | `INTEGER NOT NULL DEFAULT 0` | Per-email UI state: `0` = unstarred, `1` = starred. Same dashboard-only write path as `read`. Backs the `:star:` filter (`GET /api/emails?starred=1`). |

Index: `idx_emails_ts ON emails(ts DESC)`.

> **Migration note** — `read` and `starred` were added after initial deploy via `ALTER TABLE emails ADD COLUMN read INTEGER NOT NULL DEFAULT 0;` / `… starred …`. Existing rows default to unread/unstarred. Re-applying `schema.sql` from scratch already includes both columns. The capture worker's `INSERT` lists explicit columns, so it was unaffected by the addition.
>
> The `text` (plain-text body) column was later **removed** — the dashboard now fetches the full body from the raw `.eml` on open, and Autopilot's `emails_recent_1hr` returns envelope metadata only. Drop it on a live DB with `ALTER TABLE emails DROP COLUMN text;`. Re-applying `schema.sql` from scratch already omits it. The worker `INSERT` and every `SELECT` list explicit columns, so none reference `text` anymore.

Every row has a matching `emails/<id>.eml` object in R2 — capture is all-or-nothing (see [§4.2](#42-email-handler)), so there are no marker or partial rows. A failed capture leaves nothing in D1 and forwards the original to the fallback inbox instead.

### 6.4 `ip_blacklist` and `email_blacklist`

Active-reject lists consulted by the worker at the top of each handler. Exact-match only — no patterns, no CIDR ranges.

| Column | Type | Notes |
|---|---|---|
| `ip` / `email` | `TEXT PRIMARY KEY` | Exact value. `email` is stored lowercase; the worker lowercases the `From:` header address before comparing. |
| `ts` | `TEXT NOT NULL` | ISO 8601 UTC when added |
| `note` | `TEXT` | Optional human label (e.g. "shodan scanner"). Not currently surfaced in the UI but available in the API. |

No additional indexes — the PK suffices for both reads (worker checks `WHERE ip = ?`) and writes.

Worker behavior on a match:
- **IP blacklist hit** → return `403 Forbidden` immediately. The body is never read, the endpoint table is never consulted, no row is written to `requests`. The target sees a hard reject.
- **Email blacklist hit** → `message.setReject('Address not accepted')`. The email is NACKed back to the upstream SMTP server so the sender gets a bounce. No row is written to `emails`, no fallback forward happens.

Worker reads each list at most **once per 60 minutes per data center** (edge-cached via `caches.default`). Dashboard mutations take up to **60 minutes** to fully propagate — applies to both adds and removes. The long TTL is intentional: at moderate pentest traffic (~100 callbacks/min), this drops blacklist-related D1 reads from ~8K/day to ~150/day per edge. Acceptable because blacklisting is a noise filter, not a security boundary; the cost of hour-long staleness on an add is "we keep accepting a few more requests/emails from the source than necessary," and on a remove is "we keep rejecting a freshly un-blacklisted source for slightly longer than expected."

The cache miss path returns an empty set on D1 error so a transient D1 outage never blocks captures (fail-open: an outage means we don't enforce, rather than rejecting everyone).

### 6.5 What's not in the schema (and why)

- **No counters table.** Tab badges and stats panels were dropped because counting rows on D1 bills per row scanned. Re-litigate this before adding counters; see [§15](#15-design-decision-log).
- **No foreign keys.** Endpoints, requests, and emails are independent — request rows are NOT linked to the endpoint that matched. The dashboard treats them as separate logs.
- **No soft-delete columns.** Delete is delete. Purging is done out-of-band via `scripts/purge.sh` (which handles the email R2 coupling) or D1-console SQL for requests / autopilot endpoints. No recovery once purged.
- **No created_by / actor tracking.** The dashboard is single-tenant from the database's perspective. Access control happens at the network edge, not in the data model.

### 6.6 R2 raw `.eml` storage

Bucket `area51-emails`, bound as `EML` on the worker, agent worker, and Pages. One object per email at key `emails/<id>.eml` — the verbatim raw RFC-822 message (`Content-Type: message/rfc822`). Written by the worker on capture; read on demand by the dashboard (`/api/emails/<id>/raw`) and Autopilot (`/emails/<id>/raw`). To delete emails, use `scripts/purge.sh` — it drops the D1 row **and** the R2 object together. A raw D1 `DELETE FROM emails` leaves orphaned `.eml` blobs (invisible storage leak), so prefer the script. R2's free tier (10 GB storage, no egress fees) is the reason emails no longer threaten the 500 MB D1 limit — D1 now carries only the lean rows.

### 6.7 `domains`

The configured black holes — the single source of truth (replaces the old `DOMAINS_CONFIG` Pages env var).

| Column | Type | Notes |
|---|---|---|
| `domain` | `TEXT PRIMARY KEY` | The black hole host, e.g. `oob.example` |
| `roles` | `TEXT NOT NULL` | JSON array, subset of `["http", "mail"]` |

Read live by the dashboard's `/api/config/domains` (Home orbit chips) and by the Autopilot worker's `/domains` + `list_black_holes` tool (so an agent can build `https://<domain>/-/<path>`). Both workers/sites share the D1 binding, so there's no drift. **Not seeded automatically** — populate and edit it directly with `wrangler d1 execute` (e.g. `INSERT OR REPLACE INTO domains (domain, roles) VALUES ('oob.example', '["http","mail"]')`); there is no longer a `DOMAINS_CONFIG` mirror in `.env`.

---

## 7. HTTP API contract (Pages Functions)

Base path: `https://<dashboard-domain>/api/`. Same-origin only — this API is consumed by the AREA 51 frontend.

**Response conventions:**
- Success: JSON body, HTTP 200. Lists return a bare JSON array. Detail endpoints return the row object. Mutations return `{ok: true}`.
- Error: `{error: "message"}` with status 400 (bad input) or 500 (server error). 404 returns `{error: "Not found"}`.
- Pagination: cursor-based. Page size is fixed at 50 (`PAGE_SIZE` in `_shared.js`). The cursor is the natural sort key of the last row returned — pass it as `?cursor=` for the next page. `hasMore` is inferred client-side from `results.length === PAGE_SIZE`.

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/endpoints` | List endpoints. Params: `cursor` (last `uri`), `search` (LIKE `%search%` on `uri` — **may be repeated**; multiple values are ORed (parenthesized OR group ANDed with the cursor)). Returns array of `{uri, status}`. Sorted ASC by `uri`. |
| `POST` | `/api/endpoints` | Upsert. Body: `{uri, status, headers, body}`. `headers` is a line-separated string (`Key: Value\n…`) — server parses to a JSON object before storing. Validates `uri` starts with `/`, `status` is integer 100–599. |
| `GET` | `/api/endpoints/[uri]` | Detail. `uri` is URL-encoded in the path. 404 if missing. |
| `DELETE` | `/api/endpoints/[uri]` | Delete. 404 if nothing deleted (via `meta.changes === 0`). |
| `GET` | `/api/requests` | List. Params: `cursor` (last `ts`), `search` (LIKE on `url` — **may be repeated**; multiple values are ORed (parenthesized OR group ANDed with the cursor)). Returns `{id, ts, method, url, ip}` (no headers/body in the list — saves payload). Sorted DESC by `ts`. |
| `GET` | `/api/requests/[id]` | Detail. Returns the full row including `headers` (parsed back to an object) and `body`. 404 if missing. |
| `GET` | `/api/emails` | List. Params: `cursor` (last `ts`), `search` (**may be repeated**; each term ORs across `from_addr`/`to_addr`/`subject` via LIKE), `starred` (`1` = starred-only, from the toolbar Starred toggle). The per-term OR groups form one parenthesized **OR** group; `starred=1` is a **separate `AND starred = 1`** constraint (starred *and* matching the search, not OR); both are ANDed with the cursor. Returns `{id, ts, from_addr, to_addr, subject, read, starred}` per row. Sorted DESC by `ts`. **Drill-in mode:** if `from_eq` **and** `to_eq` **and** `subject_eq` are all present, the endpoint instead returns only the exact `(from, to, subject)` group — `from_addr = ? AND to_addr = ? AND COALESCE(subject,'') = ?` (paginated by `cursor`); `search`/`starred` are ignored. Used by the conversation drill-in. |
| `GET` | `/api/emails/[id]` | Lean detail. Returns `{id, ts, from_addr, to_addr, subject, attachment_count, read, starred}`. No body — the plain-text/HTML bodies, headers, and attachment bytes are **not** here; they're in the raw `.eml`, fetched on modal open. 404 if missing. |
| `PATCH` | `/api/emails/[id]` | Set per-email UI state. Body: `{read?, starred?}` (booleans; only the keys present are updated). Returns the updated `{read, starred}`. 404 if missing, 400 if neither key is given. **Dashboard-only writer** — read/starred have no MCP/Autopilot write path. |
| `GET` | `/api/emails/[id]/raw` | Streams the verbatim raw `.eml` from R2 (`message/rfc822`). 404 if no object (fallback rows, purged, or never stored). Consumed by the email modal (fetched on open to render the body/headers/attachments) and Download Raw. |
| `GET` | `/api/blacklist/ips` | List blacklisted IPs. Returns `[{ip, ts, note}, …]` newest-first. |
| `POST` | `/api/blacklist/ips` | Body: `{ip, note?}`. IP validated (IPv4 dotted quad, IPv6 with colons, or the literal `unknown`). `INSERT OR IGNORE` semantics — duplicate adds return success without writing. |
| `DELETE` | `/api/blacklist/ips/[ip]` | Remove. 404 if not present. |
| `GET` | `/api/blacklist/emails` | List blacklisted senders. Returns `[{email, ts, note}, …]` newest-first. |
| `POST` | `/api/blacklist/emails` | Body: `{email, note?}`. Accepts bare `addr@host` or angle-bracketed `Display <addr@host>`; stored lowercase. Validated as `^[^@\s]+@[^@\s]+\.[^@\s]+$`. |
| `DELETE` | `/api/blacklist/emails/[email]` | Remove. Lowercased + URL-decoded path param. 404 if not present. |
| `GET` | `/api/config/domains` | Returns `{domains: [{domain, roles}, …]}` read from the D1 `domains` table (`roles` is a subset of `["http", "mail"]`). Rendered by the AREA 51 Home hero as orbit chips around the alien (which double as the **default-host picker** — http-serving hosts are selectable, mail-only hosts are locked), and read independently by the Autopilot worker. Edit via `wrangler d1 execute` against `domains`; no redeploy needed — next page load picks up the new value. Handler is defensive: returns `{domains: []}` on error or malformed rows. |

The `headers` round-trip is asymmetric on purpose:
- **Endpoints (write):** dashboard sends a line-separated string; server parses to JSON object before storing.
- **Endpoints (read):** server returns the JSON string as-is; dashboard parses + formats back to lines for editing.
- **Requests (read):** server parses the JSON string and returns an object directly (cleaner for the read-only request modal).

---

## 8. Deployment from a clean slate

Prereqs:
- A Cloudflare account with at least **one black-hole zone** (a domain you want the worker to receive HTTP and/or email on) and **one dashboard zone** (a domain to host the Pages site) already added as Cloudflare-managed zones.
- Node.js 18+ and `npm`. On Kali / Debian-derived: `sudo apt install nodejs npm`.
- A **Cloudflare API token** with permissions for Workers Scripts (Edit), D1 (Edit), Pages (Edit). The "Edit Cloudflare Workers" template is sufficient. **Zone-level permissions are not required** — DNS / Custom Domain mapping is intentionally manual.
- Copy `.env.example` → `.env` and fill in the values. The deploy scripts (`scripts/*.sh`) source `.env` and render the worker config templates from it.

### Step 1 — Install worker dependencies

```sh
cd worker && npm install
```

This pulls in `postal-mime` and `wrangler` (v4+). Verify with `npx wrangler whoami` — should print the Cloudflare account name your token belongs to.

### Step 2 — Create the D1 database

```sh
npx wrangler d1 create area51
```

Copy the printed `database_id` into `.env` under `D1_DATABASE_ID`. (Each deploy script renders `wrangler.toml` from the template + `.env` — the live `wrangler.toml` files are gitignored.)

### Step 2b — Create the R2 bucket

Enable R2 on the account (Dashboard → R2; the free tier may still ask for a card), then:

```sh
npx wrangler r2 bucket create area51-emails
```

The bucket name must match `R2_BUCKET_NAME` in `.env`. The worker and agent worker bind it as `EML` via their templates automatically; the Pages binding is added by hand in Step 7.

### Step 3 — Apply the schema

From the repo root:

```sh
npx wrangler d1 execute area51 --file=schema.sql --remote
```

Verify the tables exist:

```sh
npx wrangler d1 execute area51 --command "SELECT name FROM sqlite_master WHERE type='table'" --remote
```

Should list `endpoints`, `requests`, `emails`, `ip_blacklist`, `email_blacklist` (and `_cf_KV`, which is Cloudflare's internal D1 metadata table — ignore it).

### Step 4 — Deploy the Black Holes worker

```sh
./scripts/deploy-worker.sh
```

This renders `worker/wrangler.toml` from `worker/wrangler.toml.template` using values from `.env`, then runs `wrangler deploy`. The worker is uploaded but has **no public URL yet** — `workers_dev` is disabled in the template, and no routes are declared.

### Step 5 — Bind each black hole domain to the worker (dashboard, manual)

For every domain you want the worker to receive HTTP requests on:

1. **Cloudflare → Workers & Pages → `area51-worker` → Settings → Domains & Routes → Add → Custom Domain.**
2. Enter the domain (or subdomain). Cloudflare provisions the cert and DNS automatically.

Repeat for every black hole. The worker code is domain-agnostic — it serves whatever it has been bound to.

### Step 6 — Enable Email Routing per mail-enabled black hole (dashboard, manual)

For each zone where the black hole should also receive email:

1. **Cloudflare → that zone → Email → Email Routing → Get Started** (if not already enabled).
2. **Routing rules → Catch-all address → Edit.**
3. Action: **Send to a Worker** → pick `area51-worker` → Save.

After this, any email to `*@<that-zone>` invokes the worker's `email` handler.

### Step 7 — Deploy AREA 51 (the dashboard)

```sh
./scripts/deploy-pages.sh
```

The first deploy creates the Pages project. Then in the dashboard:

- **Pages → `area51` → Settings → Functions → D1 database bindings:** add a binding `DB` → `area51` for **both Production and Preview**. ⚠️ Without this, every `/api/*` call returns 500.
- **Pages → `area51` → Settings → Functions → R2 bucket bindings:** add a binding `EML` → `area51-emails` for **both Production and Preview**. ⚠️ Without this, `/api/emails/<id>/raw` 500s — and since the email modal fetches it on open, **every email body fails to load**, not just Download Raw.
- **Pages → `area51` → Custom domains:** add the dashboard domain.

Redeploy once after adding the D1 binding so the new env is picked up: `./scripts/deploy-pages.sh`.

### Step 8 — Seed the `domains` table

The configured black holes drive the orbit chips on the Home page, the `/api/config/domains` response, and the Autopilot worker's `list_black_holes`. They live in the D1 `domains` table (created by `schema.sql`). There's no `.env` seed and no script for this — write the rows directly, e.g.:

```sh
npx wrangler d1 execute area51 --remote --command \
  "INSERT OR REPLACE INTO domains (domain, roles) VALUES ('<host-1>', '[\"http\",\"mail\"]'), ('<host-2>', '[\"http\"]')"
```

`roles` is a JSON array, subset of `["http", "mail"]`. To add/remove a black hole later, run another `wrangler d1 execute` against `domains` — no redeploy needed; the next page load and the next agent call pick it up.

### Step 9 — Deploy the Autopilot worker (optional, for agent use)

If pentesters will be driving the platform via Claude Code / Codex agents, also deploy the Autopilot worker. See [§14](#14-autopilot--agent-worker--mcp-server) for the full setup.

### Step 10 — Deploy the area51-cleanup worker (recommended)

Keeps the shared stores from growing unbounded. From the repo root:

```sh
./scripts/deploy-cleanup.sh
```

This renders `cleanup-worker/wrangler.toml` from its template + `.env` and runs `wrangler deploy`. Deploying registers the daily cron automatically — **no Custom Domain and no secret to install**. Confirm the trigger landed under **Workers → `area51-cleanup` → Settings → Triggers → Cron Triggers** (should show `0 6 * * *`). See [§16](#16-the-area51-cleanup-worker) for what it does and how to tune it.

### Step 11 — Smoke

Run the tests in [§11](#11-smoke-tests).

---

## 9. Local development

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

## 10. Operations

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

### Automated retention (area51-cleanup worker)

The `area51-cleanup` worker ([§16](#16-the-area51-cleanup-worker)) runs **daily at 06:00 UTC** and keeps the two high-churn stores bounded without anyone touching them: it trims `requests` to the newest `CLEANUP_REQUESTS_KEEP` rows (default 1000) and deletes `emails` (D1 rows **and** their R2 `.eml` blobs) older than `CLEANUP_EMAIL_MAX_AGE_DAYS` days (default 90), **excluding starred emails, which are retained indefinitely**. It does **not** touch `endpoints` (including the Autopilot `/-/*` namespace), `domains`, or the blacklists. Watch a run with `wrangler tail area51-cleanup` (look for the `cleanup_finished` summary line). The manual paths below remain for ad-hoc purges and for the things the worker leaves alone.

### Manual purge

Purging is intentionally **not** in the dashboard — there's no UI and no API endpoint. Two paths to keep the stores tidy:

**Option 1 — `scripts/purge.sh` (recommended for emails).** Interactive admin script in the repo. Sources `.env`, no arguments. Run it:

```sh
./scripts/purge.sh
```

Menu offers: 1) Autopilot Endpoints (wipes every `/-/*` row), 2) Requests (older than N days), 3) Emails (older than N days). The emails branch is the reason this script exists — it deletes the D1 rows **and** the matching `emails/<id>.eml` objects in R2 so they stay in lockstep.

**Option 2 — D1 console (Cloudflare web app).** For requests and autopilot endpoints, raw SQL is fine:

```sql
-- requests older than 30 days
DELETE FROM requests WHERE ts < datetime('now','-30 days');

-- every autopilot endpoint
DELETE FROM endpoints WHERE uri LIKE '/-/%';
```

⚠️ **Don't** purge `emails` from the D1 console directly — `DELETE FROM emails` leaves the `.eml` blobs orphaned in R2 (invisible storage leak). Use `scripts/purge.sh` for emails.

D1 storage limit on Free is **500 MB**. Check usage in the Cloudflare dashboard (D1 → area51). R2 is **10 GB** on Free (D1 → R2 dashboard). Purge when either gets uncomfortable.

### Rotating the fallback inbox

Set `FALLBACK_ADDRESS` in the repo-root `.env`, then run `./scripts/deploy-worker.sh`. The render step substitutes the value into `worker/wrangler.toml` and the deploy ships it as a `[vars]` entry. It's not treated as a secret (the value isn't sensitive — it just identifies the destination inbox).

---

## 11. Smoke tests

Run these after any non-trivial deploy.

1. **Schema applied** — `wrangler d1 execute area51 --command "SELECT name FROM sqlite_master WHERE type='table'" --remote` lists `endpoints`, `requests`, `emails`, `ip_blacklist`, `email_blacklist`.
2. **HTTP 404 + capture** — `curl https://<black-hole>/test` returns `404! Not Found`. A row appears in `requests`.
3. **HTTP endpoint serving** — Create an endpoint via AREA 51 for `/health` returning `200 ok`. `curl https://<black-hole>/health` returns it. A request row is logged.
4. **Email basic** — Send a plain-text email to `anything@<mail-enabled-black-hole>`. A lean row appears in `emails` (`attachment_count=0`) and an object exists at `emails/<id>.eml` in R2 (`wrangler r2 object get area51-emails emails/<id>.eml`). No forward.
5. **Email with attachment** — Send an email with an attachment. Row shows the right `attachment_count`; opening it immediately renders the HTML body, headers, and the attachment — clicking the attachment downloads the file. The **full-screen toggle** promotes just the body to a full-canvas overlay (Esc or collapse to exit). **Download Raw** saves the `.eml`. (A plain-text-only email shows a "no HTML body" notice — use Download Raw for its contents.)
6. **Email large** — Send a multi-MB email. Same outcome as #4/#5 — no threshold, it's stored in full. (Only a worker error would forward to fallback, leaving no D1 row and no R2 object.)
7. **AREA 51 CRUD** — Create, edit, delete an endpoint via the modal; live behavior on the worker updates immediately.
8. **Search** — Filter each tab; results match.
9. **Pagination** — "Load more" appends without duplicates; eventually shows "— end of results —".
10. **Purge** — Run `./scripts/purge.sh`; pick a target, confirm. For emails, verify a doomed `emails/<id>.eml` is gone from R2 too (not just D1).
11. **Blacklist reject (HTTP)** — Add a test IP to `ip_blacklist`; hit a black hole from that IP within an hour; confirm the response is `403 Forbidden` and no row appears in `requests`. Also expect a `http_rejected_blacklist` log line in `wrangler tail`.
12. **Blacklist reject (email)** — Add a test sender to `email_blacklist`; send from that address within an hour; confirm the sender receives a bounce ("Address not accepted") and no row appears in `emails`. Expect `email_rejected_blacklist` in the tail.
13. **Autopilot** (only if deployed) — see [§14.7](#147-smoke-tests-for-the-autopilot-worker).

---

## 12. Debugging common issues

| Symptom | Probable cause | What to check |
|---|---|---|
| `/api/*` returns HTML instead of JSON | D1 binding missing | Cloudflare → Pages → area51 → Settings → Functions → D1 bindings. Add `DB` → `area51` for both Production and Preview. Redeploy. |
| Black hole returns 404 for everything | Custom Domain not bound to Black Holes worker, OR endpoint table empty | Workers → `area51-worker` → Settings → Domains & Routes should show the black hole as a Custom Domain. Confirm `SELECT * FROM endpoints` returns rows. |
| Endpoint exists but worker returns 404 | URI mismatch (case, trailing slash, query) | `endpoints.uri` matches `url.pathname` **exactly**. Re-check the path stored. |
| Email isn't arriving in `emails` table | Email Routing not enabled or not pointed at worker | Cloudflare → the black hole zone → Email → Email Routing. Catch-all destination must be `area51-worker`. |
| Email row exists but the modal body won't load | R2 object missing/unreadable, or `/api/emails/<id>/raw` failing (the modal fetches it on open now) | Confirm the `EML` R2 binding on Pages, and that `emails/<id>.eml` exists (`wrangler r2 object get area51-emails emails/<id>.eml`). Worker-side `email_parse_failed` only affects the stored `subject`/`attachment_count`; the body always comes from the browser parse of the raw `.eml`, so it renders regardless as long as R2 has the object. |
| Request count keeps dropping | Someone ran `scripts/purge.sh` (or a D1-console `DELETE`) | No audit trail. Ask. |
| Worker logs show `http_log_insert_failed` | D1 transient error or quota | Logs are best-effort by design — but if it's repeated, check D1 health and storage. |
| AREA 51's Endpoints search misses matches | LIKE search is `uri LIKE '%query%'` — full-table scan, but exact-substring | Try a shorter / different substring. There's no fuzzy search. |
| Wrong timestamps in AREA 51 | Browser timezone vs UTC | `ts` is UTC ISO 8601; AREA 51 renders in the local timezone via `Intl.DateTimeFormat`. Confirm system tz. |

---

## 13. Known constraints & caveats

- **D1 row size limit: 2 MB.** No longer a concern for emails — the lean row holds only envelope metadata (no body at all), and the raw `.eml` (which can be large) lives in R2, not D1. Endpoint bodies aren't validated client-side — if someone tries to save a >2 MB endpoint body, the INSERT will fail and the dashboard will surface "Save failed".
- **Email memory ceiling.** The worker buffers the whole raw `.eml` in memory to PUT it to R2 and parse it. Workers cap at 128 MB; SMTP messages are typically ≤25–50 MB, so this is comfortable, but a pathologically huge message would error and fall to the fallback path.
- **D1 storage limit: 500 MB on Free tier.** Purge regularly. No automatic eviction.
- **Search is full-table scan.** `LIKE '%query%'` doesn't use indexes. Fine at thousands of rows; switch to FTS5 if volume grows.
- **Pagination is best-effort during writes.** Cursor pagination is stable only as long as the data between pages doesn't change. New emails arriving during a scroll won't appear until you re-search/refresh.
- **No optimistic UI.** Every action awaits the API response. Slightly slower-feeling but simpler.
- **No transaction isolation in the dashboard.** Two pentesters editing the same endpoint at the same time: last write wins. Accepted for internal tooling.
- **`message.rawSize` BigInt quirk.** Cloudflare's email worker types declared `rawSize` as `number` but historically returned `BigInt`. We wrap in `Number()`. If a future Workers release changes the type, the `Number()` is still safe.
- **Pages Functions cold start.** First request after idle can take 1–2s. Subsequent requests are fast. Not worth optimizing.
- **No rate limiting on the black holes.** They're meant to be reachable. If abuse happens, layer Cloudflare WAF or rate limiting at the edge.
- **postal-mime only runs in the worker.** The dashboard no longer parses any EML in the browser — it reads pre-parsed columns from D1. Removes the prior dependency on `esm.sh` for the frontend, and the lazy-load latency on first email modal open.
- **The dashboard relies on Babel-standalone in the browser.** Initial load is ~3 MB. Acceptable for an internal tool used by ~5 people who keep it open.
- **No CSRF protection on `/api/*`.** AREA 51 calls `/api/*` same-origin and session cookies are SameSite by default, so CSRF risk is bounded — but if you ever ship a third-party-embedded UI, revisit this.

---

## 14. Autopilot — agent worker + MCP server

**Autopilot** is the third runtime piece. A separate Cloudflare Worker (service name `agent-a51-worker`, code in `agent-worker/`) that exposes (a) the last 60 minutes of captured `requests` and `emails` and (b) CRUD over `/-/*` endpoint stubs to authorized Claude Code / Codex agents during pentests. Think of it as **programmatic access to the Black Holes** — what's been falling into them recently, plus the ability to stage response stubs under `/-/*` — wrapped in an MCP server so an LLM-driven agent can use the data and shape responses without any human in the loop.

### 14.1 What it serves

All endpoints behind the same bearer-style header `X-A51-Secret: <secret>`:

| Method | Path | Returns |
|---|---|---|
| `GET` | `/requests` | `{served_at, window_minutes: 60, rows: [{id, ts, method, url, ip}, …]}` — newest-first, all rows in the last 60 minutes. |
| `GET` | `/emails` | `{served_at, window_minutes: 60, rows: [{id, ts, from_addr, to_addr, subject}, …]}` — newest-first, all rows in the last 60 minutes. **Envelope metadata only — no body**; use `/emails/<id>/raw` (the `email_raw` tool) to read an email's contents. |
| `GET` | `/emails/<id>/raw` | Raw `.eml` (`message/rfc822`) for one email. **Hard 60-minute gate:** serves only if `SELECT id FROM emails WHERE id=? AND ts>=now-60min` matches — otherwise 404. An old or unknown id can't be fetched even if the caller knows it. |
| `GET` | `/domains` | `{served_at, endpoint_prefix: "/-/", domains: [{domain, roles}, …]}` — the configured black holes (from the same D1 `domains` table the dashboard reads), so an agent can build `https://<domain>/-/<path>`. |
| `GET` | `/autopilot/endpoints` | List endpoints whose URI starts with `/-/`. Returns `{rows: [{uri, status, headers, body}, …]}` — sorted ASC by uri. |
| `POST` | `/autopilot/endpoints` | Upsert. Body: `{uri, status, headers, body}`. `uri` MUST start with `/-/` — server returns 400 otherwise. |
| `GET` | `/autopilot/endpoints/<uri>` | Read one. URI is URL-encoded in the path. Same `/-/` prefix rule. |
| `DELETE` | `/autopilot/endpoints/<uri>` | Delete one. Same prefix rule. |
| `POST` | `/mcp` | MCP JSON-RPC 2.0 server. Eight tools (see §14.4). |

**No parameters on the read endpoints.** Window (60 min) and result schema are hardcoded server-side. Agents cannot widen the window, change the polling cadence, or get more rows. The CRUD endpoints under `/-/*` have no time restriction — the only guardrail there is the URI prefix.

**The `/-/` prefix is hardcoded** in the worker and applies to every CRUD path. The Autopilot worker has no ability to read, create, update, or delete an endpoint outside that namespace — a separate guardrail from AREA 51's full-namespace CRUD via `/api/endpoints`.

### 14.2 Why a separate worker

- **Different domain semantics.** The Black Holes worker catches every path on every bound domain as a target endpoint; mixing in reserved paths there would pollute the namespace and let probes touch the reserved paths.
- **Different read pattern.** The Black Holes worker is write-heavy on the request log path. Autopilot is read-oriented (with bounded writes via the `/-/*` CRUD path).
- **Different auth model.** The Black Holes are wide open (they have to be reachable by targets). Autopilot is locked behind a shared secret. Different surface, different rules.
- **Different blast radius.** A runaway agent making mistakes through Autopilot is bounded to `/-/*` and recent reads. It cannot touch the rest of the endpoint table or the blacklists.

Both workers share the same D1 binding (`area51` database). Schema doesn't change.

### 14.3 No edge cache on Autopilot

Earlier versions of the Autopilot worker wrapped the read endpoints in a 60-second `caches.default` edge cache. **Removed** because:

- During an active engagement an agent polling `/requests` or `/emails` wants the freshest possible view (a 60s stale snapshot can hide a just-arrived callback that the agent's reasoning depends on).
- D1 read budget at realistic pentest volume is small enough that the cache wasn't earning its complexity — even with one agent polling every 30 seconds at 100 callbacks/min, you land at ~3M reads/day worst case across both endpoints, still under the 5M/day free quota.

So every call hits D1. The `/-/*` CRUD endpoints are also uncached — they're mutations or fresh reads. The `Cache-Control: no-store` header is set on all responses to discourage clients from caching on their end either.

### 14.4 MCP server (what it is and how Claude Code uses it)

The Model Context Protocol is Anthropic's spec for letting LLMs talk to external tools through a typed interface. `POST /mcp` on this worker speaks MCP's JSON-RPC 2.0 transport (single-request HTTP, no SSE needed because our tools complete fast). Eight tools exposed:

| Tool | Wraps | Args |
|---|---|---|
| `requests_recent_1hr` | `GET /requests` | — |
| `emails_recent_1hr` | `GET /emails` | — |
| `email_raw` | `GET /emails/<id>/raw` | `{id}` — explicit, on-demand only; returns the raw `.eml` text. Not for routine polling. Subject to the same 60-min hard gate. |
| `list_black_holes` | `GET /domains` | — returns the configured domains + `endpoint_prefix` so the agent can build `https://<domain>/-/<path>`. |
| `autopilot_endpoints_list` | `GET /autopilot/endpoints` | — |
| `autopilot_endpoints_get` | `GET /autopilot/endpoints/<uri>` | `{uri}` |
| `autopilot_endpoints_upsert` | `POST /autopilot/endpoints` | `{uri, status, headers?, body?}` |
| `autopilot_endpoints_delete` | `DELETE /autopilot/endpoints/<uri>` | `{uri}` |

Each tool has an agent-friendly description in the tool schema explaining *when* to use it. The `initialize` response also returns an `instructions` field giving the agent a brief preamble: what the Black Holes are, what the tools do, and the `/-/` prefix rule.

To register Autopilot in Claude Code on a pentester's machine:

```sh
claude mcp add autopilot https://<autopilot-domain>/mcp \
  --transport http \
  --header "X-A51-Secret: <secret-from-.env>"
```

After that, any Claude Code session on that machine has all eight `mcp__autopilot__*` tools available as native tool calls. The model invokes them directly; no curl, no header juggling, no JSON-parsing instructions in the system prompt. The bearer header lives in Claude Code's config (`~/.claude/...`), not in the conversation.

### 14.5 Auth + secret management

- Secret name: `AGENT_SECRET`. Long random hex, generated with `openssl rand -hex 32`.
- **Header**: clients send `X-A51-Secret: <secret>` on every request (REST and MCP).
- **Comparison**: constant-time `XOR` byte compare (see `agent-worker/src/index.js` `constantTimeEqual`) — eliminates timing-side-channel info about the secret.
- **Storage on the worker**: installed via `wrangler secret put AGENT_SECRET`, encrypted in Cloudflare's vault. Never appears in `wrangler.toml` or `[vars]`.
- **Storage locally**: lives in the repo-root `.env` (gitignored) so `scripts/deploy-agent.sh` can re-install it after rotation without anyone having to remember the value.
- **Rotation**: `openssl rand -hex 32 > newvalue`, update `.env`, run `./scripts/deploy-agent.sh`. Then teammates re-run `claude mcp add` (or edit their MCP config) with the new value.

### 14.6 Deploying Autopilot

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

- **Workers → `agent-a51-worker` → Settings → Domains & Routes** → Add Custom Domain → the domain you want Autopilot on. (Manual because DNS / Custom Domain mapping is intentionally not part of the deploy automation.)

That's it. Six endpoints + an MCP server live behind Autopilot's bound domain.

### 14.7 Smoke tests for the Autopilot worker

```sh
SECRET=$(grep ^AGENT_SECRET .env | cut -d= -f2)
BASE=https://<autopilot-domain>

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
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"requests_recent_1hr","arguments":{}}}' \
  $BASE/mcp | jq '.result.content[0].text | fromjson | .rows | length'
```

The expected steady-state cost of all this: a few hundred to a few thousand D1 reads per day. We could run dozens of concurrent pentest agents continuously and still not stress the free tier.

---

## 15. Design decision log

These are the non-obvious choices. Each is here because someone might be tempted to undo it without realizing the cost.

### 15.1 No row counts anywhere in the UI

The original design had tab-count badges ("Endpoints 42 · Requests 5,183 · Emails 926") and a Settings stats panel. We removed both. **D1 bills per row scanned** — `SELECT COUNT(*) FROM emails` over 1k rows is 1k row reads, and a dashboard refresh would burn ~6k row reads on counts alone. At our usage that's still well under the Free tier (5M reads/day), but the polish-to-cost ratio is bad: scans grow linearly with table size and offer ~zero user value at this scale.

The textbook fix is a separate `counters` table updated by `AFTER INSERT/DELETE` triggers — O(1) reads forever, +1 write per mutation, +50 lines of schema. We rejected it as **schema complexity not worth the polish**. The dashboard does show `{rows.length} loaded` in each tab's toolbar — that's free.

If you bring counts back, do it via counters + triggers, not COUNT(*).

### 15.2 Endpoints list shows URI + status (and only those)

The original design showed URI, status, header count, and body length per row, populated via N+1 lazy fetches. We re-shaped that: the list endpoint returns just `{uri, status}` (two columns), the row renders status using the same color-coded `status-2xx/3xx/4xx/5xx` tags as the Requests tab, and the full headers/body are fetched only when the modal opens.

Why this shape:
- **Status is high-signal at-a-glance** (lets you spot a misconfigured 500 or an unintentional 200 OK at a glance).
- **Headers count and body length aren't** — both require either an extra round-trip per row or fattening the list payload, and neither tells you anything that the modal doesn't show better.
- One query per page (10 rows) instead of 11 (1 list + 10 lazy details).

### 15.3 No purge in the dashboard (script-only, intentionally)

The dashboard originally had a purge UI and a `/api/purge` Pages Function; both were removed. Reasons:

- **Emails couple D1 + R2.** The right purge has to drop the lean row and the matching `.eml` from R2 in lockstep. Doable from a single API, but it adds a chunky destructive surface inside the dashboard for a once-in-a-while admin task.
- **D1 console SQL handles two of three tables trivially** — `DELETE FROM requests WHERE ts < …` and `DELETE FROM endpoints WHERE uri LIKE '/-/%'`. Adding a UI for those is pure churn.
- **`scripts/purge.sh` covers the email case** with the right R2 coupling, plus a y/N gate per step. CLI + an admin keeps a destructive-by-design tool out of the casual-click surface.

If purging ever needs to be team-accessible (not just admin-only), the right path is to bring back the Pages Function (which already handled the R2 coupling correctly) and re-add a UI — not to make `scripts/purge.sh` a service.

### 15.4 No build pipeline for the frontend

React + Babel-standalone loaded from unpkg, JSX transpiled in the browser. **Pro:** zero build deps, zero version-skew chores, deploys are pure file uploads. **Con:** ~3 MB of JS on first load, no tree-shaking, no TypeScript. For a 5-person internal tool, the trade is worth it. If the dashboard grows past ~2 k lines of frontend code, revisit Vite + a real build.

### 15.5 Raw `.eml` in R2; D1 stays lean; browser parses on demand

This area went through two designs. The first stored the raw EML in D1 and re-parsed in the browser. The second parsed worker-side into wide D1 columns (`headers`/`html`/`attachments`) and forwarded oversized/attachment mail to a fallback inbox to dodge D1's 2 MB row / 500 MB store limits. **The current design moves the raw `.eml` to R2** and keeps D1 to a lean index row.

- **Why:** D1's 500 MB limit made emails the one table that could realistically fill it, and the forward-on-attachment behavior meant attachments were *lost* to a mailbox rather than retained. R2 (10 GB free, no egress) is the right home for opaque blobs, retains everything, and removes the size/attachment thresholds entirely — one write path instead of two.
- **D1 holds** only `subject`, `from`, `to`, `ts`, `attachment_count` (plus `read`/`starred`) — enough for the list, search, and Autopilot, with no R2 fetch. **No body column at all** (the `text` column was removed — see below).
- **Browser parses on demand** — this deliberately reverses the "parse once on the worker" decision: the modal fetches the raw `.eml` (one R2 GET) and postal-mime-parses it in the browser to get both bodies, headers, and attachments. Originally this was gated behind a **More** button so the common glance stayed cheap; that was later dropped in favor of fetching **on open** (see [§15.9](#159-eager-r2-fetch-on-email-open-no-text-column)), so the D1 `text` column became dead weight and was removed. Now there is exactly one body source (the raw `.eml`), never two.
- **Attachments are retained** in the raw `.eml` and downloadable from the parsed bytes — they're no longer metadata-only.

### 15.6 All-or-nothing email capture (no marker rows)

Earlier designs kept "partial" email records — a `"sent_to_fallback"` sentinel, then an `is_fallback` marker row — for messages that couldn't be fully stored. We dropped that entirely. Capture is now binary:

- **Success:** the raw `.eml` is in R2 **and** the lean row is in D1.
- **Failure (anything throws):** the original is forwarded to the fallback inbox and any partial write is rolled back (`R2.delete` + `DELETE FROM emails`), so neither system keeps a half-record.

Why: a row that exists but can't be opened (no R2 object) is worse than no row — it's a dead end in the UI and a trap for Autopilot. Keeping D1 and R2 strictly in lockstep means every row the dashboard or an agent sees is fully retrievable, and the schema loses a column and a special-case render path. The trade-off is that D1 and R2 have no shared transaction, so rollback is best-effort compensating deletes; a failed cleanup delete is logged (`email_rollback_*`) and at worst leaves an invisible orphaned R2 object — never a visible half-email.

### 15.7 Endpoints are exact-match, not glob

The worker matches `url.pathname` against `endpoints.uri` with `WHERE uri = ?`. No wildcards, no regex. A request to `/foo/bar` only matches an endpoint with `uri = '/foo/bar'`. This is intentional for now:
- Predictability: the table is the source of truth, no precedence rules to reason about.
- Simplicity: a `WHERE uri = ?` against the primary key is the cheapest possible lookup.

If you need patterns, add a separate `endpoint_patterns` table queried only on cache miss, and document the precedence order here.

### 15.8 Retention is a scheduled worker, not a cron'd `purge.sh`

`scripts/purge.sh` already deletes old requests/emails with the right R2 coupling, so automated retention *could* have been the same script run from a host crontab or a CI schedule. We made it a dedicated Cloudflare Worker ([§16](#16-the-area51-cleanup-worker)) instead because:

- **No host to own the cron.** The rest of the platform is serverless on Cloudflare; a crontab on someone's laptop or a CI runner is an out-of-band dependency that silently stops when that machine/account changes. A Worker cron trigger lives in the same account as everything else and is visible in the same dashboard.
- **It already has the bindings.** A Worker gets the `DB` and `EML` bindings natively — the same coupling `purge.sh` reaches for via the R2 REST API and `wrangler d1 execute`, but in-process and without an API token on disk.
- **Different guarantee.** `purge.sh` is interactive, admin-run, and **age-based for both tables** (and can wipe the `/-/*` namespace). The worker is unattended and intentionally narrower: requests are trimmed by **count** (keep newest N), emails by **age**, and it never touches endpoints/domains/blacklists. The two coexist — see the split in [Operations](#10-operations).
- **Coupling preserved, made self-healing.** Like `purge.sh`, the worker deletes R2 objects before D1 rows. It goes one step further: it deletes D1 rows only for the ids whose R2 delete succeeded, so a transient R2 error leaves the row to be retried on the next daily run rather than orphaning the blob.

Why **count**-based for requests but **age**-based for emails: requests are high-volume, uniform, and cheap (D1-only) — "keep the last 1000" is a predictable cap regardless of traffic spikes. Emails are lower-volume but each owns an R2 blob and is worth keeping for a fixed investigation window; age is the natural axis there and matches how `purge.sh` already framed it.

### 15.9 Eager R2 fetch on email open; no `text` column

The email modal used to open on the **lean D1 row** (showing the stored plain-text body) and fetch the raw `.eml` from R2 only when the user clicked **More**. That meant D1 carried a `text` column purely to power the pre-**More** glance. We changed the modal to fetch and parse the raw `.eml` **immediately on open**, which made the `text` column redundant, so we **dropped it entirely**. (The modal renders **only the HTML body** — no HTML/plain switcher; a plain-text-only email shows a "no HTML body, use Download Raw" notice. The plain-text body is therefore never shown in the modal, which is another reason the D1 `text` column earned its removal rather than being repurposed for a plain-text view.)

- **Why eager:** the two-step (lean → More) split the body across two sources (D1 `text` vs R2 raw) and two render paths. Fetching on open collapses that to one source and one path — the view is always the real message, HTML included, with no "click More to see the rest" cliff. The cost is one R2 GET + one in-browser parse per open (a few hundred ms behind a spinner), which is acceptable for a tool where you open one email at a time.
- **Why drop `text`:** once the body always comes from R2, the D1 `text` column fed nothing on the dashboard. Keeping it would be a second, divergent copy of the body for no reader. Removing it shrinks each row and deletes a column.
- **Autopilot impact (intended):** `emails_recent_1hr` no longer returns `text` — it's envelope metadata only (`{id, ts, from_addr, to_addr, subject}`). Agents that need an email's contents call `email_raw` (the 60-min-gated raw `.eml` fetch). The MCP tool descriptions were updated to say so explicitly, so agents know the list carries no body and reach for `email_raw` when they need one. This trades an inline body for one extra call on the emails an agent actually cares about — cheap, and it keeps D1 lean.
- **Trade-off:** if the R2 object is missing/unreadable, the modal now has *no* body to show (previously the lean `text` was a fallback). Since capture is all-or-nothing, every D1 row has its R2 object, so in practice this only surfaces a genuine R2/binding outage — which the body area reports as an error rather than silently showing a stale copy.

### 15.10 Email grouping is client-side + exact-triple, drill-in is server-backed

The Emails tab collapses identical mail into conversation rows (see [§5.1](#51-frontend-no-build-step)). The non-obvious choices:

- **Grouping key is the *exact* `(from, to, subject)` triple, not fuzzy.** One-way capture means there are no `Re:`/`Fwd:` chains to normalize, and the flood we're actually fighting is an automated sender blasting the catch-all — those are byte-identical across all three fields. Exact-match is conservative: it *only* ever merges genuinely identical mail, never unrelated messages that happen to share a generic subject. It also sidesteps the empty-subject trap (blank subjects only group when `from` **and** `to` also match).
- **Grouping is client-side, over loaded rows — no server aggregation.** A `GROUP BY` list query would scan the table on every load (the per-row-billing cost [§15.1](#151-no-row-counts-anywhere-in-the-ui) avoids) and complicate cursor pagination. Instead the frontend groups whatever it has loaded. The cost is that a group's membership is only as complete as what's loaded — which is why the drill-in re-fetches (below).
- **No count on the group row.** An accurate total per group would require a `COUNT(*)` per group — exactly the scan-per-render pattern we rejected for tab badges. So the group row shows the triple + latest ts and nothing more; the drill-in is where you see the actual messages.
- **The drill-in is server-backed and authoritative, ignoring loaded rows.** Clicking a group fires a fresh exact-triple query (`from_eq`/`to_eq`/`subject_eq`) paginated on its own. This is the one place we *do* filter the table by content, but it's bounded (one group, `LIMIT 50` + Load More) and, for a contiguous burst, the matches are clustered so it's cheap. It means the root fill-loop never has to fully load a giant group to be correct.
- **Fill-to-50 loop has no cap.** Since grouping can collapse a page to a few visible rows, the loop keeps paging until ~50 are displayed. We deliberately left off a page cap: at this tool's scale the loop terminates naturally at end-of-data, and a cap would just mean a half-filled view on a spam-heavy load. Reads are the same as clicking Load More manually, just eager. (If flooding ever gets bad enough that a single load walks an uncomfortable share of the table, a cap or a server-side collapse is the escalation — not needed yet.)

---

## 16. The area51-cleanup worker

The third runtime piece. A Cloudflare Worker (service name `area51-cleanup`, code in `cleanup-worker/`) whose **only** entry point is a `scheduled()` handler — there's no `fetch`, no `email`, and no Custom Domain. A cron trigger in its `wrangler.toml` fires it **once a day at 06:00 UTC**, and it trims the two high-churn stores so neither D1 (500 MB Free limit) nor the request log grows without bound. It is the unattended counterpart to `scripts/purge.sh`; see [§15.8](#158-retention-is-a-scheduled-worker-not-a-crond-purgesh) for why it's a worker and not a cron'd script.

### 16.1 What each run does

```
cron (06:00 UTC daily)
   │
   ▼
scheduled(event, env, ctx)
   │
   ├─ purgeRequests(keep = CLEANUP_REQUESTS_KEEP)
   │     DELETE FROM requests
   │      WHERE id NOT IN (SELECT id FROM requests ORDER BY ts DESC LIMIT ?)
   │     → keeps the newest N rows by ts; deletes the rest. D1-only (requests
   │       have no R2 objects).
   │
   └─ purgeEmails(maxAgeDays = CLEANUP_EMAIL_MAX_AGE_DAYS)
         1. SELECT id FROM emails WHERE ts < (now - M days) AND starred = 0
         2. EML.delete([...emails/<id>.eml]) in batches of ≤1000 keys   ← R2 first
         3. DELETE FROM emails WHERE id IN (...confirmed-deleted ids)    ← then D1
```

- **Requests — keep newest N (count-based).** Default `N = 1000`. The `id NOT IN (… ORDER BY ts DESC LIMIT N)` form expresses "keep the most recent N" exactly, with no boundary/tie ambiguity. It costs one full scan of `requests` per day (D1 bills per row read) — negligible against the 5M reads/day Free budget at our volume, and it's not a UI `COUNT(*)` (the thing [§15.1](#151-no-row-counts-anywhere-in-the-ui) warns about), it's a once-daily maintenance delete.
- **Emails — older than M days (age-based), D1 + R2 in lockstep.** Default `M = 90`. The cutoff is `new Date(Date.now() - M*86400000).toISOString()`, the same ISO-8601 format stored in `ts`, so the comparison is a plain string compare. R2 objects are deleted **before** the D1 rows, and the D1 delete targets only the ids whose R2 delete succeeded — a transient R2 failure leaves that row in place to retry on the next run instead of orphaning the blob ([§4.2](#42-email-handler) / [§6.6](#66-r2-raw-eml-storage) explain why orphaned blobs are the failure mode to avoid). **Starred emails are exempt** — the selection carries `AND starred = 0`, so a starred row (and its `.eml`) is kept indefinitely regardless of age. Unstar it to let a future run reclaim it.
- **What it never touches:** `endpoints` (including the Autopilot `/-/*` namespace — wipe those with `scripts/purge.sh` if needed), `domains`, `ip_blacklist`, `email_blacklist`. Retention is scoped to the two append-only logs.

The two tables are purged independently inside a try/catch each, and the handler never throws — a failure in one (or a transient D1/R2 error) is logged and the next daily run simply retries from the current state.

### 16.2 Bindings & vars

Rendered into `cleanup-worker/wrangler.toml` by `scripts/render-wrangler.sh cleanup` from `cleanup-worker/wrangler.toml.template` + `.env`:

| Binding / Var | Purpose |
|---|---|
| `DB` (D1) | The shared `area51` database — same binding the other two workers use. |
| `EML` (R2) | The shared `area51-emails` bucket. The cleanup worker only **deletes** from it (`emails/<id>.eml`). |
| `CLEANUP_REQUESTS_KEEP` (var) | How many newest `requests` rows to retain. Default `1000`. From `.env`, substituted into `[vars]` at render. |
| `CLEANUP_EMAIL_MAX_AGE_DAYS` (var) | Max age in days for `emails` before purge. Default `90`. From `.env`. |
| `[triggers] crons` | From `CLEANUP_CRON` in `.env` (default `0 6 * * *` = daily at 06:00 UTC), substituted into the template at render. Change it there and `./scripts/deploy-cleanup.sh`. |
| `workers_dev` / `preview_urls` `= false` | No public surface; the worker is cron-only. |

All three knobs live in `.env` so they can be tuned without a code edit, then applied with `./scripts/deploy-cleanup.sh`: the thresholds (`CLEANUP_REQUESTS_KEEP` / `CLEANUP_EMAIL_MAX_AGE_DAYS`) and the schedule (`CLEANUP_CRON`). The thresholds are quoted in the template (arrive as strings) and parsed in the worker with a safe non-negative-integer fallback (`1000` / `90`) so a malformed value degrades gracefully instead of purging everything or nothing.

### 16.3 Deploying & operating

```sh
./scripts/deploy-cleanup.sh        # render wrangler.toml + wrangler deploy; registers the cron
```

No secret, no Custom Domain, no Email Routing — deploying is the whole setup. Verify the trigger under **Workers → `area51-cleanup` → Settings → Triggers** (`0 6 * * *`).

Logging is structured JSON via `console.log` / `console.error`, same convention as the other workers. Tail it with `wrangler tail area51-cleanup`. Event names:

| Event | When |
|---|---|
| `cleanup_started` | top of the scheduled handler (includes resolved `keep` / `maxAgeDays`) |
| `cleanup_requests_done` | requests trim finished (`{keep, deleted}`) |
| `cleanup_emails_done` | emails purge finished (`{cutoff, matched, r2_deleted, d1_deleted, r2_failed}`) |
| `cleanup_emails_r2_failed` | an R2 batch delete threw — those ids are left for the next run |
| `cleanup_requests_failed` / `cleanup_emails_failed` | the whole table's purge threw (caught; the other table still runs) |
| `cleanup_finished` | end of run, with the combined summary |

To run it on demand for testing without waiting for 06:00 UTC, trigger the scheduled handler locally:

```sh
cd cleanup-worker
npx wrangler dev --test-scheduled     # then hit http://localhost:8787/__scheduled?cron=0+6+*+*+*
```

(`wrangler dev` talks to the remote D1/R2 by default, so this exercises the real stores — point it at a local D1 with `--local` first if you want a dry run.)
