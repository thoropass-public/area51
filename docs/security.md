# Security model

This is offensive-security tooling. It is designed to be *reached* by systems you
are testing, which makes its exposure profile unusual and worth stating plainly.

## Trust model

| Surface | Exposure | Protection |
|---|---|---|
| Black holes (`https://<host>/*`, `*@<host>`) | **Fully public.** Anyone on the internet can hit any path and send mail to any address. | None, by design. Optional IP / sender blacklists as a noise filter. |
| Autopilot (`https://<autopilot-host>/*`) | Publicly reachable, useless without the secret. | `X-A51-Secret` shared secret, constant-time compared. Every route, no exceptions. Writes confined to `/-/*`. |
| Dashboard (`https://<dashboard-host>/*`, including `/api/*`) | Should be reachable only by your team. | **Cloudflare Access only.** The application itself has no login. |
| The CLI | Runs on your machine with a Cloudflare API token in `.env`. | File permissions. |

Everyone who can open the dashboard is fully trusted: there are no roles, no
per-user scoping, and no audit trail of who changed what.

## What lands on a public host

Anything you put in an endpoint response is world-readable, and anything a target
sends you is stored. Assume:

- **Scanners will find the hostname.** Certificate transparency logs publish every
  hostname you bind. Expect background noise within hours.
- **Endpoint responses are public.** Never park a credential, an internal URL, a
  customer name or a real token in an endpoint body. Anyone can request it.
- **The `/-/*` namespace is public too.** It is a *write* guardrail for agents, not
  a read restriction. Stubs staged there are served to anyone who asks.
- **Uploaded payloads are served inline** with their own content type and no
  `Content-Disposition`, because a hosted DTD or script has to execute. That means
  a browser will render them. Upload only what you intend a target to fetch.
- **Captured data is sensitive.** Request bodies and inbound email routinely
  contain tokens, reset links, session identifiers and customer data. Treat the
  database and buckets as evidence storage: purge at the end of an engagement
  (`./a51 purge`), and keep retention short ([cleanup.md](internals/cleanup.md)).

Use a burner domain. It ends up in target logs, threat-intel feeds and blocklists,
and it is publicly linked to your testing.

## Dashboard authentication

Cloudflare Access is the **entire** authentication story. If it is missing or
misconfigured, the dashboard — and its full `/api/*` surface, which can create
endpoints and read every capture — is open to anyone who learns the hostname.

`./a51 setup` configures it: a Zero Trust organisation, the One-time PIN login
method (Access emails a code; no identity provider to integrate), and a
`self_hosted` application on the dashboard hostname with one allow policy built
from `ALLOWED_EMAILS`.

- **The `*.pages.dev` URL is guarded too.** A Pages dashboard is reachable at both
  its custom domain and its `<project>.pages.dev` URL (apex + every preview
  deployment). Guarding only the custom domain would leave the pages.dev URL as an
  unauthenticated way straight into the dashboard, so the Access app's
  `destinations` cover the custom host **and** `<subdomain>.pages.dev` **and**
  `*.<subdomain>.pages.dev`. `./a51 doctor` reports a **failure** if that
  destination is ever missing — treat it as a live bypass, not a warning.
- **`--no-access` leaves it off.** Setup warns; `./a51 doctor` reports it as a
  failure and its live probe checks for a real Access challenge, not just a 200.
- **Tighten it further** in Zero Trust if you want: add a device-posture or
  country rule, require an IdP with MFA instead of one-time PIN, or add an IP
  allow-list for your VPN egress. AREA 51 does not care how the policy is composed.
- **`ACCESS_SESSION_DURATION`** trades convenience against a stolen-laptop window.
  The frontend handles mid-session expiry gracefully
  ([dashboard.md](internals/dashboard.md#expired-session-handling)), so a short duration is
  cheap.
- Pages Functions inherit the protection automatically — Access sits in front of
  the hostname, not in front of a route list.

## Secrets

| Secret | Where it lives | Rotation |
|---|---|---|
| Cloudflare API token | `.env` (gitignored, mode `600`); passed to wrangler via the environment | Create a new token, update `.env`, delete the old token in Cloudflare |
| `AGENT_SECRET` | Encrypted Worker Secret on Cloudflare + mirrored in `.env` | `./a51 rotate-secret`, then re-register every agent |

- `.env` is gitignored, and `.gitignore` allows only `.env.example` through.
  Check `git status` before committing if you have ever renamed it.
- The Autopilot secret never appears in `wrangler.toml`, in `[vars]`, or in a
  command line: it is piped to `wrangler secret put` through stdin.
- Agent clients keep the secret in their own configuration (for Claude Code, its
  MCP config), not in conversation text.
- The API token is powerful: it can create Workers, read your buckets and change
  Access policies. Scope it to the zones you actually deploy to, and delete it if a
  laptop is lost.

## Handling untrusted input

- **Email HTML** renders in `<iframe sandbox="">` with no allowed tokens: no
  scripts, no same-origin access, no forms, no top-level navigation. Do not relax
  it — every captured message is attacker-controlled by definition.
- **Captured request data** (headers, body) is rendered as text, never as markup.
- **SQL** is always parameter-bound. The single historical case of an interpolated
  identifier validated against an allow-list first; keep that pattern if you ever
  need it.
- **Uploads** are size-capped at 25 MB, streamed rather than buffered, and stored
  under a random UUID key. The original filename is display-only and never used to
  build a response header.
- **The email blacklist matches the `From:` header**, not the SMTP envelope — the
  address a human sees in the dashboard is the one blacklisting acts on. Note that
  a `From:` header is trivially forged, so this is a noise filter, not a control.

## Deliberate non-features

Each of these is a conscious trade for an internal tool, and each is a thing to
revisit if the trust model changes:

- **No CSRF tokens on `/api/*`.** Calls are same-origin and session cookies are
  SameSite by default. If a third-party-embedded UI is ever added, revisit.
- **No rate limiting on the black holes.** They must be reachable. Cloudflare WAF
  or rate-limiting rules at the edge are the answer if you get abused.
- **No audit log.** Nothing records which operator created an endpoint or ran a
  purge.
- **No per-user isolation.** One shared view of everything.
- **No transaction isolation in the dashboard.** Two people editing the same
  endpoint: last write wins.
- **Blacklists are not a security boundary.** They are cached for up to an hour and
  fail open on a database error, deliberately: a database blip must not stop
  captures.

## Reporting a problem

There is no public security contact yet. If you find something in this code, open
an issue in the repository you cloned it from, or contact the person who gave you
access.
