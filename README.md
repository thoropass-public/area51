# AREA 51

**Out-of-band callback infrastructure you run on your own Cloudflare account.**

Point a target at one of your domains, and every HTTP request and every email it
sends lands in a dashboard you control — with whatever response you want served
back. Built for penetration testers: SSRF, blind XSS, XXE, OAuth `redirect_uri`
abuse, email verification flows, payload hosting, and any other
interaction-based finding that needs proof it fired.

Three pieces, one Cloudflare account, no servers:

| | | |
|---|---|---|
| **AREA 51** | the dashboard | Configure endpoints, read captured requests and email, manage blacklists. Locked behind Cloudflare Access. |
| **Black Holes** | your catch-all domains | Every path on them serves a response you define; every request and every email to `*@domain` is captured. |
| **Autopilot** | an MCP server | Lets a Claude Code / Codex agent read recent callbacks and stage its own response stubs, unattended. |

Setup is one command. You provide a Cloudflare API token and a domain that is
already on the account; the CLI provisions everything else — database, storage,
three Workers, the dashboard, DNS, TLS, email routing, and the access policy in
front of the dashboard.

```bash
git clone <this-repo> area51 && cd area51
npm install
cp .env.example .env      # paste your Cloudflare API token
./a51 setup
```

---

## How it works

![AREA 51 architecture](docs/arch.png)

- A request to any path on a black hole is **logged** (method, URL, IP, headers,
  body) and answered with the endpoint you configured for that exact path — or
  `404! Not Found` if you configured nothing.
- An endpoint can serve typed text (with your own status and headers) **or an
  uploaded file** (a DTD, a payload, an image) streamed straight from storage.
- Mail to *any* address at a mail-enabled black hole is captured: metadata into
  the database, the verbatim `.eml` into object storage, rendered in the
  dashboard with headers, HTML body (strictly sandboxed) and attachments.
- Nothing has an origin server. Cost at pentest volumes sits inside
  Cloudflare's free tier ([details](docs/operations.md#quotas-and-cost)).

---

## Requirements

- **A Cloudflare account** with a domain already added as a zone. A cheap
  throwaway domain with **no prior mail (MX) records** is ideal — targets will
  see it, and enabling mail capture takes over inbound mail for the whole zone.
- **R2 enabled** on the account (dashboard → R2 → *Get started*; the free tier
  may still ask for a card). Captured email and uploaded payloads live there.
- **Zero Trust activated once** (dashboard → *Zero Trust* → pick a team name →
  Free plan) — this backs the dashboard's login and the API can't activate it for
  you. Skip only if you deploy with `--no-access`.
- **Node.js 20+** and npm.
- **A Cloudflare API token** with the permissions listed in
  [docs/setup.md#api-token](docs/setup.md#api-token) — one token, thirteen
  checkboxes. The easy one to miss is **Zone · Zone Settings · Edit**, which is
  what actually enables Email Routing.

Everything else — the D1 database, both R2 buckets, three Workers, the Pages
project, DNS records, Email Routing, and the Cloudflare Access policy — is
created for you. See [docs/setup.md](docs/setup.md) for the full prerequisite and
permission detail, including the two "permission is set but still denied" traps
(Zone Resources scope and token propagation).

---

## Quick start

```bash
npm install                # wrangler + postal-mime
cp .env.example .env       # then paste CLOUDFLARE_API_TOKEN into it
./a51 setup                # provisions and deploys everything
```

`setup` asks a handful of things and remembers the answers in `.env`:

| Prompt | Default | What it becomes |
|---|---|---|
| Which domain? | *(pick from your zones)* | the zone everything is provisioned on |
| Black hole hostname | `example.com` (apex) | where targets send traffic and mail |
| Dashboard hostname | `area51.example.com` | the console, behind Cloudflare Access |
| Autopilot hostname | `autopilot.example.com` | the MCP endpoint for agents |
| Who may open the dashboard? | — | the Access allow-list (emails or domains) |

Then it provisions, in order: the D1 database and schema → both R2 buckets →
the three Workers → the black hole's Custom Domain and mail catch-all → the
Pages project *with its bindings already attached* → DNS → Cloudflare Access.
Every step is idempotent, so `./a51 setup` is also the way to converge a
deployment after editing `.env` or pulling new code.

When it finishes it prints your three URLs and the command that registers
Autopilot with Claude Code.

### Verify

```bash
./a51 status     # what is deployed, and where
./a51 doctor     # checks every binding, domain and policy, then probes the live hosts
```

```bash
curl -i https://<your-black-hole>/anything
```

You should get `404! Not Found` — and see that request appear under **Requests**
in the dashboard. If a mail role is enabled, send an email to
`literally-anything@<your-black-hole>` and watch it land under **Emails**.

### First endpoint

In the dashboard: **Endpoints → + New**, path `/callback`, status `200`, headers
`Content-Type: application/json`, body `{"ok":true}`. Save, then:

```bash
curl -i https://<your-black-hole>/callback
```

The leading icon on each endpoint row copies its full URL to your clipboard.

### Hand it to an agent

```bash
claude mcp add autopilot https://<your-autopilot-host>/mcp \
  --transport http --header "X-A51-Secret: <AGENT_SECRET from .env>"
```

The agent gets eight tools: read the last hour of requests and emails, fetch a
raw message, list your black holes, and create/read/update/delete response stubs
under the reserved `/-/*` path space. It cannot touch anything else.
See [docs/autopilot.md](docs/autopilot.md).

---

## The CLI

```
./a51 setup            provision the whole deployment (safe to re-run)
./a51 deploy [target]  upload code: all | black-holes | autopilot | cleanup | dashboard | schema
./a51 status           show what is deployed and where
./a51 doctor [--fix]   verify every binding, domain and policy; probe the live hosts
./a51 domains          list | add <host> [http,mail] | remove <host>
./a51 access           edit who may open the dashboard: --list | --add | --remove <email|domain>,...
./a51 purge            delete captured data (database rows and their objects, in lockstep)
./a51 rotate-secret    replace the Autopilot shared secret
./a51 tail [target]    stream a worker's structured logs
./a51 dev <target>     run a piece locally against the remote stores
./a51 destroy          tear it all down — empties buckets, no manual steps (two typed confirmations)
```

Add a second black hole any time — no redeploy, no code change:

```bash
./a51 domains add other-domain.example http,mail
```

---

## Repository layout

```
.
├── a51                     CLI entrypoint (./a51 <command>)
├── .env.example            every configuration value, documented
├── CLAUDE.md               guidance for AI agents working in this repo
├── cli/                    the CLI: provisioning over the Cloudflare API
│   ├── a51.mjs             command dispatch
│   ├── lib/                API client, .env I/O, prompts, wrangler wrapper, R2 S3 signer
│   └── commands/           one file per command
├── db/
│   └── schema.sql          the D1 schema (idempotent, commented)
├── workers/
│   ├── black-holes/        the catcher: HTTP + email handlers
│   ├── autopilot/          the agent-facing REST + MCP server
│   └── cleanup/            scheduled retention trimmer (cron only)
├── dashboard/              Cloudflare Pages site
│   ├── index.html          no build step: React + Babel from a CDN
│   ├── styles.css
│   ├── js/                 ui.jsx (shared), tabs.jsx (lists), app.jsx (shell)
│   └── functions/api/      Pages Functions — the dashboard's JSON API
└── docs/                   the full documentation set
```

---

## Documentation

Start at **[docs/README.md](docs/README.md)**. In reading order:

| Doc | What is in it |
|---|---|
| [architecture.md](docs/architecture.md) | Every component, both capture flows, what talks to what |
| [setup.md](docs/setup.md) | API token permissions, what setup does step by step, manual fallbacks |
| [deployment.md](docs/deployment.md) | What a healthy deployment looks like in the Cloudflare dashboard — annotated screenshots |
| [configuration.md](docs/configuration.md) | Every `.env` value: meaning, default, what changing it costs |
| [database.md](docs/database.md) | Table-by-table schema, both R2 buckets, migrations |
| [api.md](docs/api.md) | The dashboard's HTTP API contract |
| [dashboard.md](docs/dashboard.md) | Frontend internals: tabs, grouping, pins, modals |
| [black-holes.md](docs/black-holes.md) | The catcher worker: handlers, blacklists, log events |
| [autopilot.md](docs/autopilot.md) | The MCP server: tools, auth, guardrails, agent setup |
| [cleanup.md](docs/cleanup.md) | Retention: what is deleted, when, and what is never touched |
| [operations.md](docs/operations.md) | Day-two: deploys, domains, purging, logs, quotas, rotation |
| [security.md](docs/security.md) | Trust model, what is public, what protects what |
| [troubleshooting.md](docs/troubleshooting.md) | Symptom → cause → fix |
| [development.md](docs/development.md) | Local dev, the code map, conventions, common tasks (add an API route or tab), and testing |
| [decisions.md](docs/decisions.md) | Why the non-obvious choices are the way they are |

---

## Notes before you deploy

- **The black holes are public on purpose.** Targets have to reach them. Never
  put anything sensitive in an endpoint response, and assume scanners will find
  the hostname.
- **The dashboard has no login of its own.** Cloudflare Access is the only thing
  in front of it. `./a51 setup` configures it; `./a51 doctor` fails loudly if it
  is missing. Do not skip it.
- **Autopilot is a shared secret away from your capture data.** Treat
  `AGENT_SECRET` like a password and rotate it when someone leaves.
- **Use a domain you do not mind burning.** It ends up in target logs, threat
  intel feeds and blocklists.
- Only test systems you are authorised to test.

## License

No license has been chosen for this code yet, so no rights are granted by
default. If you want to use it outside your own account, open an issue and ask.
