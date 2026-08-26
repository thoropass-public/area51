# The dashboard

A static site plus Pages Functions, both deployed from `dashboard/`. This is what
an operator opens in a browser: configure endpoints, read captures, manage
blacklists.

## No build step

`dashboard/index.html` loads React, ReactDOM and Babel-standalone from a CDN, then
loads three JSX files with `<script type="text/babel">`. Babel transpiles them in
the browser on page load. There is no bundler, no `node_modules` for the frontend,
and deploying is a pure file upload.

The cost is ~3 MB of JavaScript on first load and no tree-shaking or type
checking. For a tool a handful of people open and leave open, that trade is worth
it ([decisions.md](../decisions.md#no-build-pipeline-for-the-frontend)). Because
Babel-standalone does not resolve modules, every shared symbol is published on
`window`, which is why `ui.jsx` assigns its exports to globals.

`postal-mime` is the one exception: it is imported as an ES module from a CDN and
published as `window.PostalMime`, used to parse raw `.eml` in the browser.

## Files

```
dashboard/
├── index.html          CDN script tags, theme bootstrap, mount point
├── styles.css          the whole design system (dense, dark-first, theme-aware)
├── favicon.svg
├── js/
│   ├── ui.jsx          API client, toasts, modals, confirm, pins, formatting, icons
│   ├── tabs.jsx        Endpoints / Requests / Emails tabs and their modals
│   └── app.jsx         shell: App, TopBar, Home, Settings; mounts to #root
└── functions/api/      the JSON API (see api.md)
```

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
Status / Body editors plus a `FILE` drop target. Attaching a file switches to
**file mode**: those three editors are *unmounted* rather than disabled, because
a grayed-out field still invites a click. They are replaced by a chip showing filename,
type and size with *Replace* and *Remove*. Saving in file mode POSTs the raw
`File` as the request body (so it streams); files over 25 MB are rejected before a
byte leaves the browser. Opening an existing file endpoint never shows a response
editor, and saving without touching anything is a no-op rather than a silent
conversion to text.

**Requests.** Read-only. The modal pretty-prints a JSON body when it parses and
shows it raw otherwise.

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
- **`TopBar`** carries the brand mark, tabs, and a refresh button (list tabs only) that
  bumps a `refreshTick` the active tab consumes as a `refreshKey` dependency.
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
./a51 deploy dashboard      # confirms the Pages bindings, then uploads
./a51 dev dashboard         # local server, Functions against the remote stores
```

`deploy dashboard` re-asserts the D1 and R2 bindings on the Pages project before
uploading, so a project whose bindings were removed in the dashboard repairs
itself on the next deploy.

Because there is no build step, editing a `.jsx` file and redeploying is the whole
loop. Hard-refresh to get past the browser cache.
