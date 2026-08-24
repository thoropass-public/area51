<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/assets/brand/lockup-dark.png">
  <source media="(prefers-color-scheme: light)" srcset=".github/assets/brand/lockup-light.png">
  <img src=".github/assets/brand/lockup-dark.png" alt="AREA 51 — exploit server" width="460">
</picture>

### Every callback, captured.

**The exploit server for out-of-band findings.** Point a target at a domain you
own, and every HTTP request and every email it sends back lands in a dashboard you
control — with whatever response you choose served in return.

[![License](https://img.shields.io/badge/license-Apache--2.0-88C0D0?style=flat-square)](LICENSE)
[![Serverless](https://img.shields.io/badge/origin_servers-none-88C0D0?style=flat-square)](docs/internals/architecture.md)
[![Node](https://img.shields.io/badge/node-20%2B-88C0D0?style=flat-square)](#requirements)
[![MCP](https://img.shields.io/badge/MCP-agent_ready-8FBCBB?style=flat-square)](docs/internals/autopilot.md)
[![Setup](https://img.shields.io/badge/setup-one_command-A3BE8C?style=flat-square)](docs/guides/getting-started.md)

[Getting started](docs/guides/getting-started.md) ·
[Playbooks](docs/guides/usage.md) ·
[CLI](docs/reference/cli.md) ·
[Architecture](docs/internals/architecture.md) ·
[Documentation](docs/README.md)

</div>

---

## Why it exists

Half of what you find on an engagement only proves itself when something calls
home. A blind SSRF. An XXE that exfiltrates over HTTP. A stored XSS firing in an
admin's browser you will never see. A password-reset flow you need to read. An
OAuth `redirect_uri` nobody validated. Each one needs infrastructure that is
reachable from the target, captures everything, and answers exactly how you want.

Public interaction services give you a hostname and a log. AREA 51 gives you the
whole thing, on infrastructure you own:

- **Nothing shared.** Your domains, your storage, your captures. No third party
  holds your clients' tokens, reset links or internal hostnames.
- **Any response you like.** Serve a `302` into a metadata endpoint, a DTD, a
  `.js` beacon, a JSON stub, or a 25 MB binary — per exact path.
- **Email is a first-class capture,** not an add-on. Every address at the domain
  is live, and every message is kept verbatim with headers and attachments.
- **Your agent can drive it.** An MCP server exposes recent captures and a
  sandboxed slice of the endpoint table, so an AI agent can inject a callback URL
  and confirm the hit without you in the loop.
- **One command to stand up, one to tear down.** No servers, no containers, no
  cron host, and no bill at pentest volumes.

## The three pieces

<table>
<tr>
<td width="33%" valign="top">

**AREA 51** · the dashboard

Configure endpoints, read captured requests and email, manage noise filters.
Locked behind single sign-on with an emailed one-time PIN.

</td>
<td width="33%" valign="top">

**Black Holes** · your domains

Every path serves what you defined; every request and every address at the domain
is captured. Public by necessity — targets have to reach it.

</td>
<td width="33%" valign="top">

**Autopilot** · the agent interface

A secret-authenticated MCP + REST server. Reads the last hour of callbacks,
stages its own response stubs, and cannot touch anything else.

</td>
</tr>
</table>

## What it looks like

<table>
<tr>
<td width="50%"><img src=".github/assets/ui-home.png" alt="AREA 51 Home"></td>
<td width="50%"><img src=".github/assets/ui-endpoints.png" alt="Endpoints"></td>
</tr>
<tr>
<td width="50%"><img src=".github/assets/ui-requests.png" alt="Captured requests"></td>
<td width="50%"><img src=".github/assets/ui-emails.png" alt="Captured email"></td>
</tr>
</table>

## What you can do with it

| Finding | How AREA 51 proves it | Playbook |
|---|---|---|
| Blind SSRF | An unconfigured path already captures the hit, with egress IP, User-Agent and every header | [→](docs/guides/usage.md#confirm-a-blind-callback-ssrf) |
| SSRF filter bypass | A text endpoint answers `302` into the address you actually want fetched | [→](docs/guides/usage.md#control-the-response-redirects-and-metadata) |
| XXE / XSLT exfiltration | Host the external DTD, then read the exfiltrated bytes out of the second request | [→](docs/guides/usage.md#host-a-dtd-for-xxe-exfiltration) |
| Blind XSS | Serve the beacon; the capture's `Referer` names the internal page that executed it | [→](docs/guides/usage.md#catch-a-blind-xss-beacon) |
| Email-driven flows | Every address is a live inbox — signup, invite, reset and verification mail arrives in full | [→](docs/guides/usage.md#drive-email-flows-signup-reset-verification) |
| OAuth `redirect_uri` abuse | Stage the landing page and capture the `code`, `state` or token the flow hands over | [→](docs/guides/usage.md#intercept-an-oauth-redirect_uri) |
| Payload delivery | Upload an archive, binary, PDF or font and serve it inline with its own content type | [→](docs/guides/usage.md#host-a-file-payload) |
| Mail authentication review | The full `Received` chain plus SPF, DKIM and DMARC results on real delivered mail | [→](docs/guides/usage.md#drive-email-flows-signup-reset-verification) |

## Requirements

- A **Cloudflare account** with a domain already added as a zone — ideally a
  throwaway with no prior mail records, since it will end up in target logs.
- **R2 object storage** enabled, and **Zero Trust** activated once. One click
  each; neither can be turned on through the API.
- **Node.js 20+**.
- One **API token**. The exact permission list is in
  [getting-started](docs/guides/getting-started.md#api-token).

Everything else — database, storage, three Workers, the dashboard, DNS, TLS, mail
routing and the access policy — is created for you.

## Getting started

```bash
git clone https://github.com/heylaika/area51.git && cd area51
npm install
cp .env.example .env        # paste your API token
./a51 setup                 # provisions and deploys everything
```

`setup` asks which domain to use and what to call the three hostnames, then
provisions in order: database and schema → storage → the three Workers → your
first black hole and its mail catch-all → the dashboard with its bindings already
attached → DNS → the access policy. Every step is idempotent, so it is also the
command you re-run after changing anything.

Then confirm it:

```bash
./a51 doctor
```

`doctor` checks every binding, domain and policy, then probes the live hosts. A
request to any path on your black hole should answer `404! Not Found` and appear
in the dashboard seconds later; mail to any address at it lands in the same place.

Full walkthrough, with the manual fallback for every step:
**[docs/guides/getting-started.md](docs/guides/getting-started.md)**.

## Architecture

<img src=".github/assets/architecture.png" alt="AREA 51 architecture" width="100%">

Four serverless pieces sharing one database and two object-storage buckets. No
origin server exists, so there is nothing to patch, scale or pay for between
engagements. Details in
[docs/internals/architecture.md](docs/internals/architecture.md).

## The CLI

| Command | Does |
|---|---|
| `./a51 setup` | Provision the whole deployment (safe to re-run) |
| `./a51 deploy [target]` | Upload code: `all`, `black-holes`, `autopilot`, `cleanup`, `dashboard`, `schema` |
| `./a51 status` | What is deployed, and where |
| `./a51 doctor [--fix]` | Verify every binding, domain and policy; probe the live hosts |
| `./a51 domains` | `list` · `add <host> [http,mail]` · `remove <host>` |
| `./a51 access` | `--list` · `--add` · `--remove` who may open the dashboard |
| `./a51 purge` | Delete captured data — records and stored messages together |
| `./a51 rotate-secret` | Replace the Autopilot shared secret |
| `./a51 tail [target]` | Stream a Worker's structured logs |
| `./a51 dev <target>` | Run a piece locally against the remote stores |
| `./a51 destroy` | Tear it all down (two typed confirmations) |

Full reference: [docs/reference/cli.md](docs/reference/cli.md).

## Repository layout

```
a51                  the CLI entrypoint
cli/                 provisioning over the Cloudflare API — commands + libraries
db/schema.sql        the database schema, idempotent and commented
workers/
  black-holes/       the catcher: HTTP + email capture
  autopilot/         the agent-facing REST + MCP server
  cleanup/           scheduled retention
dashboard/           the dashboard — no build step, plus its JSON API
docs/                guides, reference, internals
```

Conventions, code map and how to extend each layer:
[docs/development.md](docs/development.md).

## Documentation

| | |
|---|---|
| **[Getting started](docs/guides/getting-started.md)** | Prerequisites, token permissions, every setup step and its manual equivalent |
| **[Playbooks](docs/guides/usage.md)** | Running an engagement: SSRF, XXE, blind XSS, email flows, OAuth, payload hosting, evidence |
| **[Operations](docs/guides/operations.md)** | Deploys, domains, purging, retention, logs, quotas, teardown |
| **[Troubleshooting](docs/guides/troubleshooting.md)** | Symptom → cause → fix |
| **[CLI](docs/reference/cli.md)** · **[Configuration](docs/reference/configuration.md)** | Every command; every `.env` value |
| **[API](docs/reference/api.md)** · **[Database](docs/reference/database.md)** | The dashboard's HTTP API; tables and buckets |
| **[Internals](docs/internals/architecture.md)** | Architecture, catcher, Autopilot, dashboard, retention |
| **[Security](docs/security.md)** | Trust model, exposure, authentication, secrets |
| **[Decisions](docs/decisions.md)** | Why the non-obvious choices are the way they are |

Start at **[docs/README.md](docs/README.md)** for the full map.

## Authorised use only

This is offensive-security tooling. The black holes are deliberately reachable by
anyone on the internet, and everything a target sends is stored, so treat a
deployment as client-data storage: keep retention short, purge when the report
ships, and use a domain you do not mind burning.

Test only what you are authorised to test.

## License and attribution

Licensed under the **[Apache License 2.0](LICENSE)**. Copyright 2026 Thoropass.
See [NOTICE](NOTICE) for third-party components.

The AREA 51 name and the alien mark are trademarks of Thoropass; the Apache-2.0
grant covers the software, not the marks. The brand assets used here live in
[`.github/assets/brand/`](.github/assets/brand); the full media kit — colour,
type, clear space and misuse rules — is available on request.
