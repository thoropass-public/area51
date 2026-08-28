# Configuration

`.env` at the repository root is the **only** configuration state. It holds the
Cloudflare credentials, every name and hostname, and the Autopilot secret.
`./a51 setup` writes into it as it discovers or provisions things, so after a
successful run the file describes the whole deployment.

- Gitignored, written with mode `600`. Never commit it.
- `.env.example` is the annotated template; `cp .env.example .env` to start.
- Edits are surgical: the CLI rewrites the `KEY=` line in place and leaves your
  comments and ordering alone.
- Values containing spaces must be quoted (`CLEANUP_CRON="0 6 * * *"`), because
  the file is also intended to be shell-sourceable.

## How a value reaches the thing that uses it

There are three delivery paths, and knowing which one applies tells you what a
change requires:

| Path | Values | To apply a change |
|---|---|---|
| **Rendered into `wrangler.toml`** at deploy time (bindings, `[vars]`, cron) | `WORKER_NAME`, `D1_*`, `R2_*`, `FALLBACK_ADDRESS`, `CLEANUP_*`, `AGENT_WORKER_NAME` | `./a51 deploy <target>` |
| **Set on Cloudflare via the API** (project settings, DNS, policies) | hostnames, `ALLOWED_EMAILS`, `ACCESS_*`, `BLACK_HOLE_ROLES`, Pages bindings | `./a51 setup`, or the narrower `./a51 domains` / `./a51 access` |
| **Used only by the CLI on your machine** | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_ZONE` | nothing to deploy |

`AGENT_SECRET` is special: it is stored as an encrypted **Worker Secret** on
Cloudflare and mirrored in `.env` so it can be reinstalled without anyone
memorising it. Change it with `./a51 rotate-secret`.

Two things are **not** in `.env` on purpose:

- **The list of black holes.** Its source of truth is the D1 `domains` table, so
  the dashboard and Autopilot read the same live list with no redeploy. Manage it
  with `./a51 domains`.
- **Endpoints, blacklists, captures.** All database state, managed in the UI.

---

## A worked example

A filled-in `.env` for a burner black hole on `blackhole.com`, with the console
on a subdomain and one operator:

```ini
CLOUDFLARE_API_TOKEN=cf_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
CLOUDFLARE_ZONE=blackhole.com
BLACK_HOLE_HOSTNAME=blackhole.com            # targets hit this; public by design
BLACK_HOLE_ROLES=http,mail
DASHBOARD_HOSTNAME=area51.blackhole.com      # you log in here, behind Access
AUTOPILOT_HOSTNAME=autopilot.blackhole.com   # agents connect here
ALLOWED_EMAILS=you@gmail.com,teammate@work.com   # your REAL inboxes, who may log in
FALLBACK_ADDRESS=you@gmail.com               # a REAL inbox for bounced captures
```

**The two email fields are different things**, and this is the most common point
of confusion:

| Field | Holds | Example | Never |
|---|---|---|---|
| `ALLOWED_EMAILS` | The real inbox(es) allowed to **log into the dashboard**. Access emails a one-time PIN to these. | `you@gmail.com` | An address at the black-hole domain |
| `FALLBACK_ADDRESS` | A real inbox that receives an email **only when its capture fails** (so it isn't lost). Must be verified once. | `you@gmail.com` | An address at the black-hole domain |

Neither is ever an address *on* the black hole (e.g. `anything@blackhole.com`):
that domain is the trap you point targets at, not a mailbox you own. The same
real inbox can serve both fields.

---

## Reference

### Cloudflare credentials

| Key | Default | Notes |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | — | **Required.** Permissions listed in [setup.md#api-token](../guides/getting-started.md#api-token). Also passed to wrangler through the environment, so wrangler never opens a browser login. |
| `CLOUDFLARE_ACCOUNT_ID` | discovered | Filled in by setup. Set it by hand to skip the account prompt. |
| `CLOUDFLARE_ZONE` | prompted | The zone setup provisions on. Only used to offer sensible hostname defaults and to resolve zone ids. |

### Hostnames

| Key | Default | Notes |
|---|---|---|
| `BLACK_HOLE_HOSTNAME` | the zone apex | **Derived, never prompted.** `./a51 setup` always sets this to `CLOUDFLARE_ZONE` and overwrites what is here, because a subdomain black hole cannot receive mail ([why](../guides/getting-started.md#why-the-black-hole-is-always-the-apex)). Additional black holes are added with `./a51 domains add`, not here. |
| `BLACK_HOLE_ROLES` | `http,mail` | **Derived, never prompted.** Always both. `mail` enables Email Routing **for the whole zone** and points its catch-all at the catcher. Per-host roles still apply to extra black holes via `./a51 domains add <host> <roles>`. |
| `DASHBOARD_HOSTNAME` | `area51.<zone>` | The Pages custom domain, protected by Access. Derived from the zone when blank; **set it here to override**, including onto another zone — setup uses an existing value as-is and never prompts. Changing it means the old hostname keeps serving until you remove it in Pages, and the Access app follows the new name only after `./a51 setup`. |
| `AUTOPILOT_HOSTNAME` | `autopilot.<zone>` | The MCP / REST host. Same derive-or-override rule as above. Changing it invalidates every agent's registration. |

Setup refuses to start if either hostname already holds a DNS record that
belongs to something other than this deployment, naming the record so you can
delete it or point the key somewhere free.

### Cloudflare Access

| Key | Default | Notes |
|---|---|---|
| `ALLOWED_EMAILS` | — | Comma-separated allow-list. `alice@example.com` (exact) or `example.com` (any address at that domain). Empty means **no protection**, and `doctor` treats that as a failure. Edit it incrementally with `./a51 access --add <…>` / `--remove <…>` (both write back here), or set it wholesale by editing this value and running a bare `./a51 access`. |
| `ACCESS_TEAM_NAME` | derived from the zone | Only used when the account has no Zero Trust organization yet; becomes `<name>.cloudflareaccess.com`. **Globally unique across all Cloudflare customers**, so if creation fails, pick another. |
| `ACCESS_SESSION_DURATION` | `24h` | How long a login lasts. Formats: `30m`, `24h`, `730h`. Shorter means more one-time PINs; longer means a stolen laptop stays logged in. The dashboard auto-reloads when a session expires mid-use ([dashboard.md](../internals/dashboard.md#expired-session-handling)). |

### Storage

| Key | Default | Notes |
|---|---|---|
| `D1_DATABASE_NAME` | `area51` | Renaming after creation does **not** rename the database; setup would create a second one. |
| `D1_DATABASE_ID` | filled in by setup | The real identity. If it stops resolving, setup falls back to looking the name up. |
| `R2_BUCKET_NAME` | `area51-emails` | Captured `.eml` objects. Bound as `EML`. |
| `R2_FILES_BUCKET_NAME` | `area51-files` | Endpoint uploads. Bound as `FILES`. Kept separate from email so uploads can be wiped or given a lifecycle rule independently ([decisions.md](../decisions.md#file-backed-endpoints-server-owned-response-separate-bucket)). |

Renaming a bucket in `.env` and redeploying points the Workers at a **new empty
bucket**; the old objects still exist and still cost storage. Migrate
deliberately or not at all.

### Service names

| Key | Default | Notes |
|---|---|---|
| `WORKER_NAME` | `area51-black-holes` | The catcher's Cloudflare service name. |
| `AGENT_WORKER_NAME` | `area51-autopilot` | Autopilot's service name. |
| `CLEANUP_WORKER_NAME` | `area51-cleanup` | The retention worker's service name. |
| `PAGES_PROJECT_NAME` | `area51` | Pages project name; also its `*.pages.dev` subdomain. |

Renaming any of these creates a **new** Worker or project on the next deploy and
leaves the old one running, still bound to its domains. See
[operations.md#renaming-things](../guides/operations.md#renaming-things).

### Black Holes worker

| Key | Default | Notes |
|---|---|---|
| `FALLBACK_ADDRESS` | — | Last-resort inbox, used **only** when capture fails (object write throws, handler errors). Successful captures are never forwarded. Must be a **verified** Email Routing destination on the account or forwarding silently fails. Setup registers it; you click the verification link. Leave empty to accept that a failed capture is simply lost. |

### Autopilot

| Key | Default | Notes |
|---|---|---|
| `AGENT_SECRET` | generated | 32 random bytes as hex. Sent by clients as `X-A51-Secret`, compared in constant time. Stored encrypted on the Worker; the copy here exists so it can be reinstalled. Rotate with `./a51 rotate-secret`, then re-register every agent. |

### Cleanup worker

| Key | Default | Notes |
|---|---|---|
| `CLEANUP_REQUESTS_KEEP` | `1000` | Newest request rows to keep; the rest are deleted daily. Count-based because request volume is spiky. |
| `CLEANUP_EMAIL_MAX_AGE_DAYS` | `90` | Emails older than this are deleted, rows **and** their `.eml` objects. **Starred email is exempt and kept forever.** |
| `CLEANUP_CRON` | `0 6 * * *` | Standard five-field cron, **UTC**. Must be quoted. Applied by `./a51 deploy cleanup`. |

Both thresholds arrive at the Worker as strings and are parsed with a
non-negative-integer fallback (`1000` / `90`), so a typo degrades to the default
instead of deleting everything or nothing.

---

## Things that are hardcoded (and where)

Not everything is configurable. These are deliberate, and each has a note where
it lives:

| Constant | Value | Where |
|---|---|---|
| API page size | 50 rows | `dashboard/functions/api/_shared.js` |
| Endpoint upload limit | 25 MB | `dashboard/functions/api/_shared.js` (`MAX_UPLOAD_BYTES`) |
| Blacklist edge-cache TTL | 60 minutes | `workers/black-holes/src/index.js` |
| Autopilot read window | 60 minutes | `workers/autopilot/src/index.js` (`WINDOW_MINUTES`) |
| Autopilot URI namespace | `/-/` | `workers/autopilot/src/index.js` (`AUTOPILOT_PREFIX`) |
| Auth header name | `X-A51-Secret` | Autopilot worker |
| Compatibility date | `2024-10-11` | the three `wrangler.toml.template` files and `cli/lib/provision.mjs` |

The last one matters: Pages Functions get their compatibility date from the
project's deployment config, which the CLI sets, so it is defined in
`provision.mjs`, not in a config file you can edit.
