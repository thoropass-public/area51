# The dashboard

A Worker with static assets, deployed from `dashboard/`. This is what an operator
opens in a browser: configure endpoints, read captures, manage blacklists.

It was a Cloudflare Pages project with Pages Functions until v1.1.0. The move was
about hostnames, not hosting: a Pages project answers on its custom domain *and*
`<project>.pages.dev` *and* every `*.pages.dev` preview, all of which Cloudflare
Access had to be told to guard separately or leave open. This Worker sets
`workers_dev = false` and `preview_urls = false`, so it answers on exactly one
name. See [decisions.md](../decisions.md#the-dashboard-is-a-worker-not-a-pages-project).

## No build step

`dashboard/public/index.html` loads React, ReactDOM and Babel-standalone from a CDN, then
loads three JSX files with `<script type="text/babel">`. Babel transpiles them in
the browser on page load. There is no bundler, no `node_modules` for the frontend,
and deploying is a pure file upload.

`index.html` loads React and ReactDOM's **production** builds
(`react.production.min.js`, `react-dom.production.min.js`). It used to load the
development builds so the browser console kept React's runtime warnings, which
is worth something with no build step and no type checking — but it cost roughly
1.1 MB on every page load of a console an operator opens and leaves open all day.
Nothing in the app depends on the dev builds; swap the two script tags back
locally when you want the warnings.

Babel-standalone is still the bulk of what remains (~2.8 MB), and it still
transpiles ~116 KB of JSX in the browser on every load. No tree-shaking, no type
checking. For a tool a handful of people use, that trade is worth it
([decisions.md](../decisions.md#no-build-pipeline-for-the-frontend)). Because
Babel-standalone does not resolve modules, every shared symbol is published on
`window`, which is why `ui.jsx` assigns its exports to globals.

## Response headers

`public/_headers` sets `Content-Security-Policy`, `X-Frame-Options: DENY`,
`X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` and a
`Permissions-Policy` on every static asset. Cloudflare's asset layer applies
them, so they cost no Worker invocation, and the file is consumed at deploy time
rather than published. They do **not** apply to `/api/*`, which the Worker
generates.

This is defence in depth, not a fix. Both places the dashboard renders
attacker-controlled content already handle it: a captured email's HTML body goes
into `<iframe sandbox="" srcdoc>` (opaque origin, no scripts, no forms), and a
captured request body is HTML-escaped before `highlightJson` wraps tokens in
spans.

The CSP carries `'unsafe-inline'` and `'unsafe-eval'` in `script-src`, and that
is forced rather than sloppy: Babel-standalone compiles JSX with `Function()`,
and `index.html` has an
inline script that applies the saved theme before React paints. Tightening those
two is the one thing a bundler would buy, and it is not worth a bundler. What the
policy still buys with them in place is script-origin pinning (injected markup
cannot pull code from a host that is not unpkg or esm.sh), `object-src 'none'`,
`base-uri 'self'`, `form-action 'none'` (the dashboard posts via `fetch`, never a
form) and `frame-ancestors 'none'`.

`frame-src 'self'` is what permits the email viewer's sandboxed `srcdoc` iframe.
Removing it breaks HTML email display.

`postal-mime` is the one exception: it is imported as an ES module from a CDN and
published as `window.PostalMime`, used to parse raw `.eml` in the browser.

Note that the same message gets parsed by **two** copies of that library: the
browser pins `postal-mime@3.0.0` in `index.html`, while the catcher bundles
whatever `^3.0.0` in `package.json` resolved to at deploy time. They agree today;
if the subject or attachment count in a list row ever disagrees with what the
modal renders, this skew is the first thing to check. Bump both together.

The headers block in the email modal collapses whitespace runs before rendering.
postal-mime 3.x unfolds headers per RFC 5322, which drops the CRLF but keeps the
whitespace that followed it, so `Received`, `DKIM-Signature` and the `ARC-*`
headers Cloudflare adds would otherwise render with tabs and 8-space gaps in the
middle of a value. This is display only: **Download raw** serves the stored
`.eml` untouched, still folded, for anyone who needs the bytes as they arrived.

## Files

```
dashboard/
├── wrangler.toml.template   name, bindings, [assets] routing (generated → wrangler.toml)
├── public/                  EVERYTHING HERE IS PUBLIC — served to anyone who reaches the host
│   ├── _headers             CSP + security headers, applied by the asset layer (not served)
│   ├── index.html           CDN script tags, theme bootstrap, mount point
│   ├── styles.css           the whole design system (dense, dark-first, theme-aware)
│   ├── favicon.svg
│   └── js/
│       ├── ui.jsx           API client, toasts, modals, confirm, pins, formatting, icons
│       ├── tabs.jsx         Endpoints / Requests / Emails tabs and their modals
│       └── app.jsx          shell: App, TopBar, Home, Settings; mounts to #root
└── src/                     server side; never served
    ├── index.js             the Worker: entry, guard, route table, one try/catch
    ├── router.js            the matcher (literal-beats-param, raw-pathname segments)
    ├── router.test.mjs      the repo's only test file — precedence fails silently
    └── api/                 the JSON API handlers (see api.md)
```

The `public/` ÷ `src/` split is load-bearing, not cosmetic. `[assets] directory`
points at `public/`, and everything under it is downloadable by anyone who can
reach the hostname. Server-side code must stay outside it.

**Which of the two answers a request** is decided by one line in
`wrangler.toml.template`:

```toml
run_worker_first = ["/api/*"]
```

Only `/api/*` invokes `src/`. The six files in `public/` are served by
Cloudflare's asset layer, never entering the Worker — which is also why they cost
nothing: static-asset requests are free and unlimited. Setting
`run_worker_first = true` would make every page load a billable invocation.
`not_found_handling = "none"` 404s unknown paths the same way.

### Routing

Pages derived the route table from the directory tree: `functions/api/emails/[id].js`
became `/api/emails/:id`, and the export name (`onRequestGet`) chose the method.
A Worker is a single `fetch` handler, so that table is written out in
`src/index.js` and matched by `src/router.js`. Two properties are deliberate:

- **A literal path beats a parameter route, whatever the method.**
  `/api/endpoints/upload` matches both the literal route and `/api/endpoints/:uri`.
  Literal paths are held in a separate table and settled first, *including* when
  the path is declared but the method is not — that answers 405 rather than
  falling through. Order within `ROUTES` cannot affect this.
- **Matching splits the raw `url.pathname` by segment.** No `URLPattern`, no
  regex. Endpoint URIs arrive percent-encoded (`/-/callback` →
  `%2F-%2Fcallback`), and `URLPattern` canonicalizes the pathname it matches,
  which risks decoding that `%2F` back into a separator and splitting one
  parameter across two segments.

`router.test.mjs` pins both. It is the only test file in the repository because
this is the only behavior here that breaks *silently* — see
[decisions.md](../decisions.md#one-test-file-for-route-precedence-and-only-that).

`index.html` also applies the saved theme **synchronously** before React paints,
to avoid a flash of the wrong theme; both it and `App` write
`localStorage['area51:theme']`.

### `ui.jsx`, the shared machinery

- **`API`** is the JSON client, one method per route, always same-origin `/api/…`.
- **Expired-session handling:** see [below](#expired-session-handling).
- **`ToastProvider` / `useToast`** for transient bottom-right notifications.
- **`ConfirmProvider` / `useConfirm`** is a promise-returning confirm dialog, awaited
  by every destructive action.
- **`Modal` / `ModalHead`** is the modal shell with Escape and backdrop-click closing.
- **`useDebouncedValue`** gives a 300 ms debounce for search inputs.
- **`usePinnedFilters(tab)`** holds the persistent search pins (below).
- **`useDomains` / `useActiveDomain`** fetch `/api/config/domains` once into a
  shared `window.DOMAINS` cache and track the operator's chosen default host.
- **Formatting helpers:** `fmtTime`, `fmtTimeFull`, `statusClass`,
  `headersObjToLines`, `highlightJson`, `tryPretty`, `fmtBytes`, `stripOrigin`,
  `decodeMimeWord`.
- **`Icon`** is the inline SVG icon map.

`decodeMimeWord` decodes RFC 2047 encoded-words (`=?utf-8?B?…?=`) before display,
applied to `from_addr`, `to_addr`, `subject` and rendered header values. The worker
already prefers postal-mime's decoded subject, so this is defense in depth for
older rows and for display names inside envelope fields.

### `tabs.jsx`, the three list tabs

**`ListView`** is the shared search + pagination wrapper. The search field is one
visual unit: pin chips wrap inline beside the input, and the border lives on the
wrapper. Keyboard: **Enter** pins the current text, **Backspace** on an empty
input removes the last pin, **Escape** clears the input. While any full reload is
in flight the list shows a centered `querying…` loader instead of stale rows;
*Load more* keeps the rows and spins its own button.

**Pins** are saved per tab in `localStorage` (`area51:pins:<tab>` plus a color
map). Each pinned value gets a color from a curated theme-aware palette,
preferring one not already in use. The effective query sent to the API is
`[<live input>, ...pins]`, all ORed server-side. A `N pinned · OR` badge appears
next to the loaded count.

**Match ribbons.** Every row matched by a pin gets a 6 px left-edge spine, split
into one segment per matching pin, so a row caught by two pins shows both colors.
Matching is per tab: `uri` for Endpoints, `url` for Requests, and
`from + to + subject` for Emails (mirroring the server-side search). The left edge
belongs *exclusively* to ribbons; unread state uses a background tint so the two
cues never collide.

**Endpoints.** The list shows URI plus a color-coded status tag; headers and
body are fetched only when the modal opens. The leading row icon is a **copy
button**: it copies `https://<active host><uri>` to the clipboard, flips to a
check mark, and toasts the host it used (clicking it does not open the modal). The
active host comes from the Home picker; with none selected the button toasts an
error instead.

The modal is in exactly one of two states. In **text mode** it shows Headers /
Status / Body editors plus a **Serve a file** drop target ("Drop a file here or
click to browse"). Attaching a file switches to
**file mode**: those three editors are *unmounted* rather than disabled, because
a grayed-out field still invites a click. They are replaced by a chip showing filename,
type and size with *Replace* and *Remove*. Saving in file mode POSTs the raw
`File` as the request body (so it streams); files over 25 MB are rejected before a
byte leaves the browser. Opening an existing file endpoint never shows a response
editor, and saving without touching anything is a no-op rather than a silent
conversion to text.

**Requests.** The capture itself is read-only, and nothing edits a stored request.
The modal pretty-prints a JSON body when it parses and shows it raw otherwise,
and its **Remote IP** row carries a *blacklist* button (and a *blacklisted* tag
once the IP is on the list), so noise can be filtered from the row that produced
it rather than by retyping the address in Settings. The Emails modal does the
same for the **From** address.

**Emails.** Opening a message shows the envelope metadata from the database and
immediately fetches the raw `.eml`, parsing it in the browser. The body renders
the **HTML part** in a strict `sandbox=""` iframe if present, else the plain-text
part in a `<pre>`, else a "no body" notice; when both exist an HTML / Plain
switcher appears. Full headers (collapsible) and a clickable attachment list (each
downloads its decoded bytes as a Blob) come from the same parse. A **full-screen
toggle** promotes just the body, not the whole modal, to a fixed overlay
rendered through `ReactDOM.createPortal` to `document.body` (the modal backdrop's
`backdrop-filter` would otherwise trap a `position: fixed` child); Escape exits
full-screen without closing the modal. **Download Raw** saves the in-memory
`.eml`. Nothing renders until both the metadata and the parsed body have loaded.

**Read / unread** is database-backed (`emails.read`). Unread pops and read recedes
via theme-aware background tokens, because which end of the scale reads as
"prominent" flips between light and dark. Opening a message marks it read; the
envelope icon toggles read state without opening. Both write through
`PATCH /api/emails/<id>` with an optimistic update, rolled back on failure.
Autopilot has no write path to this.

**Starring** is database-backed too, mirrored between the row and the modal
header, and the toolbar's **Starred** toggle filters to starred mail as an **AND**
constraint (`?starred=1`): starred *and* matching the search, not OR. Starred
mail is also exempt from retention ([cleanup.md](cleanup.md)).

**Conversation grouping** is always on. Any set of ≥ 2 loaded rows sharing the
*exact* `(from_addr, subject)` pair collapses into one group row. Recipient is
deliberately **not** part of the identity, so one sender blasting many catch-all
aliases with the same subject folds into a single row. Grouping is a pure
client-side transform over loaded rows, positioned at the newest member's
timestamp. A group is marked by three things that do not collide with the channels
already in use (left edge = ribbons, background = read state): a **stack icon**, a
To cell reading `<latest recipient>, and more`, and three fanned "page edge" bars
on the row's right edge. There is deliberately **no count**
([decisions.md](../decisions.md#email-grouping-is-client-side-and-exact-pair)).

Clicking the stack icon confirms, then bulk-toggles the group's read state via
`PATCH /api/emails`, scoped to the active filter when one is set. Clicking
anywhere else drills in: the tab swaps to a **server-backed** list of that exact
sender+subject (`?from_eq&subject_eq`), narrowed by the active search and starred
filter, with its own cursor and *Load more*. Coming back syncs read and starred
changes onto the collapsed row by id.

Because grouping can collapse a 50-row page into a handful of visible rows,
`fetchFirst` / `loadMore` **loop** until ~50 rows are *displayed* or the data runs
out. A monotonic request id guards the loop, so a fetch started before a
filter change cannot land late and clobber the filtered view.

### `app.jsx`, the shell

- **`App`** holds tab state, keyboard shortcuts (⌘/Ctrl + 1–4), theme, and the
  `ConfirmProvider` + `ToastProvider` wrappers.
- **`TopBar`** carries the brand mark (which returns to Home), the four tabs, and
  a **light/dark theme toggle**. Refresh is not here: each list owns its own
  refresh button in `ListView`'s toolbar, which re-runs that tab's `fetchFirst`.
  The theme is applied to `document.documentElement` as `data-theme` and persisted
  to `localStorage['area51:theme']`; `index.html` re-applies it synchronously
  before React paints so there is no flash of the wrong theme.
- **`Home`** is the landing tab. Its orbit chips double as the **default-host
  picker** for copied endpoint URLs, persisted to
  `localStorage['area51:activeDomain']`. Only hosts with the `http` role are
  selectable; mail-only hosts are locked out.
- **`Settings`** is blacklist management only. Purging is deliberately not in the
  UI ([decisions.md](../decisions.md#no-purge-in-the-dashboard)); use `./a51 purge`.

## Untrusted content

Email HTML is rendered as:

```jsx
<iframe sandbox="" srcDoc={parsed.html} title="email html"/>
```

`sandbox=""` with no tokens is the strictest sandbox: no scripts, no same-origin
access, no form submission, no top-level navigation. Email arrives from
attackers by definition. **Do not relax this.**

Captured request bodies and headers are rendered as text, never as markup.

## Expired session handling

The dashboard holds no session of its own. The only session is Cloudflare
Access's, and it expires on its own schedule. A tab left open past that point
keeps rendering, but every `/api/*` call gets a redirect to the login host instead
of JSON. Under fetch's default redirect mode the browser follows that cross-origin
hop, gets no CORS headers, and the call fails as a bare `Failed to fetch`,
indistinguishable from a real outage.

So every API call goes out with `redirect: "manual"` (a same-origin `/api/*` call
never legitimately redirects), and a response that came from the edge rather than
our API triggers a reload:

- an **opaque redirect** (`type === "opaqueredirect"`, `status === 0`),
- a **401 or 403** (our API issues neither),
- or an **ok response whose body is not the expected content type** (some Access
  configurations serve the login page with a 200).

The reload happens after ~900 ms behind a `session expired, reloading…` toast.
Being a *navigation*, it follows the Access hop properly and either silently
re-mints the cookie or lands on the login screen. A
`sessionStorage['area51:sessionReloadAt']` timestamp caps this at one auto-reload
per 15 s, so a page that still cannot reach the API surfaces the error instead of
thrashing. A genuine network `TypeError` does **not** reload, because reloading an offline
page replaces the app with the browser's error page.

Known trade-off: the reload discards unsaved modal state. Raising
`ACCESS_SESSION_DURATION` is the cheap mitigation.

## Deploying and developing

```bash
./a51 deploy dashboard          # renders wrangler.toml from .env, then uploads
node dashboard/src/router.test.mjs   # after touching router.js or the ROUTES table
```

`deploy dashboard` renders `wrangler.toml` from the template plus `.env` and runs
`wrangler deploy`, exactly like the other three workers. The D1 and R2 bindings
are declared in the template, so they travel with the upload; there is nothing to
attach over the API first. (As a Pages project they lived only in Cloudflare's
API, had to be `PATCH`ed onto both the production and preview configs before the
first upload, and were re-asserted on every deploy to repair hand edits.)

Because there is no build step, editing a `.jsx` file and redeploying is the whole
loop. There is no local server, and an upload takes a few seconds. Hard-refresh
to get past the browser cache.

A 500 from `/api/*` is now debuggable: `[observability]` and
`upload_source_maps` are on, so the error and a real line number land in Workers
Logs. Pages Functions supported neither.
