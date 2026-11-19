# The dashboard

A Worker with static assets, deployed from `dashboard/`. This is what an operator
opens in a browser: configure endpoints, read captures, manage blacklists.

It answers on exactly one hostname. The Worker sets `workers_dev = false` and
`preview_urls = false`, so there is no second name and no preview URL, which is
what lets Cloudflare Access guard the whole thing with a single destination. See
[decisions.md](../decisions.md#the-dashboard-is-a-worker-not-a-pages-project).

## No build step

`dashboard/public/index.html` loads React, ReactDOM and Babel-standalone from a CDN, then
loads three JSX files with `<script type="text/babel">`. Babel transpiles them in
the browser on page load. There is no bundler, no `node_modules` for the frontend,
and deploying is a pure file upload.

`index.html` loads React and ReactDOM's **production** builds
(`react.production.min.js`, `react-dom.production.min.js`). The development
builds keep React's runtime warnings in the console, which is worth something
with no build step and no type checking, but they cost roughly 1.1 MB on every
page load of a console an operator leaves open all day. Nothing in the app
depends on them, so swap the two script tags locally when you want the
warnings.

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

This is defense in depth, not a fix. Both places the dashboard renders
attacker-controlled content already handle it: a captured email's HTML body goes
into a sandboxed `srcdoc` iframe (opaque origin, no scripts, no forms), and a
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
browser pins `postal-mime@4.2.0` in `index.html`, while the catcher bundles
whatever `^4.2.0` in `package.json` resolved to at deploy time. They agree today;
if the subject or attachment count in a list row ever disagrees with what the
modal renders, this skew is the first thing to check. Bump both together.

The headers block in the email modal collapses whitespace runs before rendering.
postal-mime 3.x and later unfold headers per RFC 5322, which drops the CRLF but
keeps the whitespace that followed it, so `Received`, `DKIM-Signature` and the
`ARC-*` headers Cloudflare adds would otherwise render with tabs and 8-space
gaps in the middle of a value. This is display only: **Download raw** serves the
stored `.eml` untouched, still folded, for anyone who needs the bytes as they
arrived.

## Files

```
dashboard/
├── wrangler.toml.template   name, bindings, [assets] routing (generated → wrangler.toml)
├── public/                  EVERYTHING HERE IS PUBLIC, served to anyone who reaches the host
│   ├── _headers             CSP + security headers, applied by the asset layer (not served)
│   ├── index.html           CDN script tags, theme bootstrap, mount point
│   ├── styles.css           the whole design system (dense, dark-first, theme-aware)
│   ├── favicon.svg
│   └── js/
│       ├── ui.jsx           API client, toasts, modals, confirm, pins, formatting, icons
│       ├── tabs.jsx         Endpoints / Requests / Emails tabs and their modals
│       └── app.jsx          shell: App, TopBar, Home, Blacklists; mounts to #root
└── src/                     server side; never served
    ├── index.js             the Worker: entry, guard, route table, one try/catch
    ├── router.js            the matcher (literal-beats-param, raw-pathname segments)
    ├── router.test.mjs      the repo's only test file; precedence fails silently
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
Cloudflare's asset layer, never entering the Worker, which is also why they cost
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
  the path is declared but the method is not. That answers 405 rather than
  falling through. Order within `ROUTES` cannot affect this.
- **Matching splits the raw `url.pathname` by segment.** No `URLPattern`, no
  regex. Endpoint URIs arrive percent-encoded (`/-/callback` →
  `%2F-%2Fcallback`), and `URLPattern` canonicalizes the pathname it matches,
  which risks decoding that `%2F` back into a separator and splitting one
  parameter across two segments.

`router.test.mjs` pins both. It is the only test file in the repository because
this is the only behavior here that breaks *silently*. See
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

**Endpoints.** The list shows URI plus a color-coded status tag. Headers and
body are fetched only when the modal opens. The leading row icon is a **copy
button**: it copies `https://<active host><uri>` to the clipboard, flips to a
check mark, and toasts the host it used. Clicking it does not open the modal. The
active host comes from the Home picker, and with none selected the button toasts
an error instead.

*What the list contains.* There are **three lists, and one control that picks
between them**: a scope switch at the head of the toolbar, before the search
box, so the row reads coarse to fine. Which list, narrow it, act on it.

| Scope | Rows | *New endpoint* |
|---|---|---|
| **Manual** | made by hand, `uri NOT LIKE '/-/%'` | shown |
| **Autopilot** | staged by agents, `uri LIKE '/-/%'` | hidden |
| **Archive** | `archived = 1` | hidden |

The first two are named for **who made the endpoint**, which is what actually
separates them. The switch sits inside the Endpoints tab, so a position called
*Endpoints* would read as "all of them" while meaning the opposite, and *Live*
would be worse: an endpoint under `/-/` is served exactly like any other.

`{n} loaded` counts the rows on screen, so it is a count of the scope you are
in, never of everything.

The three are mutually exclusive **in the data**, which is why one switch
replaced two independent controls. No row is in two of them: the Manual query
excludes `/-/` and the Autopilot query requires it. And nothing is in Archive
*and* Autopilot, because an endpoint under the prefix can never be archived
([invariant 3](../../CLAUDE.md)). Two toggles could be set to that fourth
combination; the only honest answer to it is an empty list with nothing on
screen explaining why it must be empty. A three-position switch cannot be asked
the question.

*New endpoint* appears on **Manual** only, because that is the only list a
dashboard-made endpoint can join. In the Archive it would file the row into the
list you are not looking at. In Autopilot it would open a form the modal then
refuses, and a button that opens a form you cannot submit is worse than no
button.

**The dashboard does not create under `/-/`.** The modal refuses it as you
type: the helper line under the URI turns into the reason, the field borders
red and *Create* is disabled, with the same check repeated in `save()` so the
field and the button cannot disagree.

The prefix looks like a folder but behaves like a lifecycle. Everything under
it is agent-owned, can never be archived, and is deleted wholesale on the
`CLEANUP_AUTOPILOT_PURGE` schedule. Typing a path into a text box is not a
reasonable way to opt into that.

**Renaming into `/-/` is still allowed**, and still asks first. That path is
deliberate by construction: you already have the endpoint and you are choosing
to hand it over. It is also how a file-backed payload reaches a `/-/` path,
since an upload is a human step and Autopilot has no `FILES` binding. Create
it outside the prefix with its file, then rename it in. The file moves with the
rename, because nothing but the row is keyed by the URI. Autopilot's own
instructions walk an operator through those two steps.

The `/-/` exclusion happens in SQL rather than the browser, and the reason is
paging. `/-/` sorts first under `ORDER BY uri ASC`, because `-` is 0x2D and sits
below `.`, `/`, the digits and both cases. An engagement that leaves more
agent-staged endpoints than fit on a page would fill the whole first page with
them. Filtered in the browser, the operator gets an empty list with a *Load more*
button under it and their own endpoints not yet fetched. Filtered in the query, a
page of this list is a page of what they asked for.

The scope switch replaced a `:autopilot:` search token, and the reason it had to
go is that it was a term typed into the search box that did not search: it
swapped which list you were looking at. Nothing in the interface advertised it,
so the operators who did know it read a scope change as a filter that found
nothing. Changing the list is not a thing a search box should do.

The scope is not persisted. A session starts on the working set, because a
dashboard that quietly opens on the Archive because of something you clicked
last week is a dashboard that misreports what is being served.

*The modal is read-only for two kinds of endpoint*, and the pair is deliberate:
an **archived** one and an **agent-staged** one both belong to a lifecycle the
editor is not part of. Archived rows are frozen by the server. Agent-staged rows
are Autopilot's, which can read, replace and delete them, and the cleanup run
takes all of them on a schedule. An operator editing one is editing a response
an agent may overwrite, on a row that disappears next month.

Each says so in its own header. The title names **which list the endpoint is
in**, in the same words as the scope switch, so the modal and the list agree:
`MANUAL ENDPOINT`, `AUTOPILOT ENDPOINT`, `ARCHIVED ENDPOINT`. Only a new
endpoint is named for the mode, `NEW ENDPOINT`, because it is not in any list
yet.

The header settles before the row loads. The prefix comes off the URI and the
list the row was opened from is passed in with it, so both the title and the
path under it are right on the first frame. Reading "archived" off the fetched
row instead would show one title for as long as the request takes and then swap
it, which looks like a bug in a modal whose job is telling you what you may do
to the thing.

Each also gets the one action that ends that state, in the modal's single
primary slot: **Unarchive** for the first, **Move to Endpoints** for the
second.

*The footer holds no Close or Cancel*, in any of the modal's states but one.
A ghost button that only shuts the modal says what the ✕ in the header already
says one row above it, and spends the slot beside the primary action on a
duplicate. It also reads as the cautious half of a decision nobody is being
asked to make. The modal already closes on Escape, on the backdrop and on that
✕. The exception is **Cancel during a move**, which is not a synonym for
closing: it returns to the locked view with the endpoint still open, because
backing out of a path you were choosing should not throw away what you were
choosing it for.

A write that announces itself, such as a move, an archive or an unarchive,
closes and refreshes the list without the generic *Endpoint saved* toast. That
toast would otherwise stack under the specific one and contradict it.
*Move to Endpoints* opens the URI field and nothing else. The body stays
locked, because a move is a rename and not an edit. The field is prefilled with
the path minus the prefix, so `/-/acme/oauth-callback` is proposed as
`/acme/oauth-callback`. The operator
edits it freely; the only thing refused is a target still under `/-/`, which
would have moved nothing.

Whether the target is taken is settled by the **server**, not by a lookup from
the browser first. `PATCH` already answers `409 <uri> already exists`, and that
answer is authoritative where a pre-check would be a second round trip that is
stale the moment it returns. The refusal lands back on the URI field rather than
in a toast, so the path is still there to edit. `apiFetch` carries the HTTP
status on the thrown error for exactly this: a caller distinguishing one refusal
from another without matching on message text. A successful move closes and
refreshes but does **not** follow the endpoint to the Endpoints scope. The row
leaves the list you are standing in, and jumping scope after every move would
make triaging a staged engagement a fight. The toast names where it went.

*Otherwise the modal* is in exactly one of two states. In **text mode** it shows Headers /
Status / Body editors plus a **Serve a file** drop target. Attaching a file
switches to **file mode**: those three editors are *unmounted* rather than
disabled, because a grayed-out field still invites a click. They are replaced by
a chip showing filename, type and size with *Replace* and *Remove*. Saving in
file mode POSTs the raw `File` as the request body so it streams, and files over
25 MB are rejected before a byte leaves the browser. Opening an existing file
endpoint never shows a response editor, and saving without touching anything is a
no-op rather than a silent conversion to text.

*Creating is not the same write as saving.* Both go through the same upsert, so
the New endpoint modal sends `create` and the server answers `409` on a URI that
is already taken rather than overwriting the row that holds it.

*The URI is editable*, and a rename is an ordinary primary-key `UPDATE`. Nothing
else in either store is keyed by it: an endpoint's R2 object is keyed by a random
UUID, so a file-backed endpoint keeps its object with no R2 call, and captured
requests keep the URL they were actually made to. The rename is sent before the
body write, so a name clash comes back as `409` with nothing changed and the
modal still showing what was typed. Renaming *into* `/-/` is allowed and
confirmed first, because it hands the endpoint to Autopilot, to the purge
schedule, and to the read-only treatment above. After that, changing it again
means moving it back out.

*Archiving* sits beside Delete, as the undo-able half of it. An archived endpoint
keeps its row and its R2 object and stops being served, because the catcher's
lookup filters on `archived = 0`. The button is unmounted for an endpoint under
`/-/`: agent-staged endpoints are deleted, or renamed out of the prefix first,
which is what converts one into an ordinary endpoint.

Opening an archived endpoint gives a **read-only** modal showing its path,
status, headers and body, or the file it serves. The only actions are Unarchive,
Delete and Close. That is the visible half of a rule the API enforces on every
write path, since the modal is not the only caller: rename, text upsert and file
upload all answer `409` on an archived row. Unarchiving should return what was
archived, not whatever was edited into it while nothing was serving it.

**Requests.** The capture itself is read-only, and nothing edits a stored request.
The modal pretty-prints a JSON body when it parses and shows it raw otherwise,
and its **Remote IP** row carries a *blacklist* button (and a *blacklisted* tag
once the IP is on the list), so noise can be filtered from the row that produced
it rather than by retyping the address in Blacklists. The Emails modal does the
same for the **From** address.

**Emails.** Opening a message shows the envelope metadata from the database and
immediately fetches the raw `.eml`, parsing it in the browser. The body renders
the **HTML part** in a near-strict sandboxed iframe if present, else the plain-text
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
  `localStorage['area51:activeDomain']`. Every black hole serves HTTP, so every
  chip is selectable; a chip is its address and nothing else. Only black holes
  appear here. A subdomain an operator added by hand is captured just the same,
  but it is not in the `domains` table and so is not listed.
- **`Blacklists`** is the two blacklists and nothing else, which is why it is
  named for them. It runs full width: the two lists sit side by side as equal
  halves and their entries flow into as many columns as the card has room for,
  while the explanation above stays at a readable measure. Purging is
  deliberately not in the UI
  ([decisions.md](../decisions.md#no-purge-in-the-dashboard)); use
  `./a51 purge`.

## Untrusted content

Email HTML is rendered as:

```jsx
<iframe
  sandbox="allow-popups allow-popups-to-escape-sandbox"
  srcDoc={resolveInlineImages(parsed.html, parsed.attachments).html}
  title="email html"
/>
```

The sandbox carries exactly two tokens. What it still withholds is the part that
matters:

- **no `allow-scripts`**, so nothing in the message executes
- **no `allow-same-origin`**, so the frame keeps an opaque origin and can reach
  neither the dashboard's DOM nor its cookies
- **no `allow-forms`**
- **no `allow-top-navigation`**, so the message cannot move the tab under you
 Email
arrives from attackers by definition. **Those four stay off.**

The two that are on exist so a link in a captured email opens in a new tab. An
empty `sandbox` blocks the navigation outright, so the click does nothing. `allow-popups` permits the new tab;
`allow-popups-to-escape-sandbox` is what stops that tab inheriting the sandbox
and landing on a blank page. Both are gated on a real user gesture by every
current browser, and `target="_blank"` implies `noopener`, so the opened page
gets no handle back. The `<base target="_blank">` that directs links there is
injected by `resolveInlineImages`.

Captured request bodies and headers are rendered as text, never as markup.

### Inline images

An HTML email that shows a picture inline ships it as a MIME part with a
Content-ID and refers to it as `<img src="cid:...">`. No browser resolves `cid:`,
so until `resolveInlineImages` existed every one of them rendered broken while
the part sat in the attachment list. It rewrites each reference the message can
satisfy (attribute form and CSS `url()`) to a `data:` URL built from that
part's bytes. `data:` rather than `blob:` because the CSP already allows
`img-src 'self' data:` and a srcdoc iframe inherits it.

**Remote images do load**, and the CSP carries `img-src ... https:` for them.
Know what that costs, because it was chosen rather than inherited: a remote image
in a captured email is a beacon, so rendering one tells whoever sent the message
the moment an operator opened it, from an address belonging to the engagement.
`Referrer-Policy: no-referrer` keeps the dashboard's own URL out of the request,
so what leaks is the fetch, not where it came from. Narrowing `img-src` back to
Narrowing `img-src` back to `'self' data:` reverts it, if an engagement ever
needs that.

Plain `http:` images are not listed and will still not render: the dashboard is
https, so the browser blocks or upgrades mixed content whatever the policy says.

The viewer reports only the images the message *referenced but never attached*,
a broken `cid:`, because that is the case a reader would otherwise take for a
bug in the dashboard rather than in the mail.

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
attach over the API first.

Because there is no build step, editing a `.jsx` file and redeploying is the whole
loop. There is no local server, and an upload takes a few seconds. Hard-refresh
to get past the browser cache.

A 500 from `/api/*` is now debuggable: `[observability]` and
`upload_source_maps` are on, so the error and a real line number land in Workers
Logs. Pages Functions supported neither.
