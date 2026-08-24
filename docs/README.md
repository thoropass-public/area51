<div align="center">
  <img src="../.github/assets/brand/mark.png" alt="" width="64"/>
  <h1>AREA 51 documentation</h1>
  <p><em>Everything, in detail.</em></p>
</div>

The [project README](../README.md) is the introduction. These documents are the
reference: exhaustive enough that a newcomer can take the codebase over, and an
operator can debug an outage without paging anyone.

Three tiers, organised by *why you opened the page*:

- **[guides/](#guides)** — task-oriented. "How do I do this?"
- **[reference/](#reference)** — lookup. "What is the exact value, flag or route?"
- **[internals/](#internals)** — mechanism. "How does this actually work?"

Plus two cross-cutting documents everyone reads eventually:
[development](development.md) and [decisions](decisions.md).

---

## Start here

| If you are… | Read, in order |
|---|---|
| **Deploying it for the first time** | [guides/getting-started](guides/getting-started.md) → [guides/verify-deployment](guides/verify-deployment.md) |
| **Running an engagement with it** | [guides/usage](guides/usage.md) → [reference/cli](reference/cli.md) |
| **Operating it day to day** | [guides/operations](guides/operations.md) → [reference/configuration](reference/configuration.md) → [guides/troubleshooting](guides/troubleshooting.md) |
| **Wiring it into an AI agent** | [guides/usage → hand it to an agent](guides/usage.md#hand-the-engagement-to-an-agent) → [internals/autopilot](internals/autopilot.md) |
| **Taking over the codebase** | [internals/architecture](internals/architecture.md) → [development](development.md) → [decisions](decisions.md) |
| **Reviewing it before you trust it** | [internals/architecture](internals/architecture.md) → [reference/database](reference/database.md) → [decisions](decisions.md) |

## Guides

Task-oriented. Read top to bottom the first time; skim by heading afterwards.

| Document | Covers |
|---|---|
| [getting-started](guides/getting-started.md) | Prerequisites, the API token and its exact permissions, hostname layout, what `./a51 setup` does at each step **and the manual dashboard equivalent for every one of them**, then verification |
| [verify-deployment](guides/verify-deployment.md) | What a healthy deployment looks like in the Cloudflare dashboard, screenshot by screenshot — Workers, D1, R2, and the Access application including the closed `*.pages.dev` bypass |
| [usage](guides/usage.md) | The engagement playbooks: blind SSRF, response control and redirects, XXE exfiltration, blind XSS beacons, email-driven flows, OAuth `redirect_uri` interception, payload hosting, agent-driven testing, noise control, evidence and clean-up |
| [operations](guides/operations.md) | Day-two: deploying changes, adding and removing black holes, purging, retention, reading logs, health checks, secret rotation, quotas and cost, renaming things, teardown |
| [troubleshooting](guides/troubleshooting.md) | Symptom → probable cause → fix, grouped by subsystem. Start with `./a51 doctor` — most rows here are something it names for you |

## Reference

Lookup tables. Not meant to be read end to end.

| Document | Covers |
|---|---|
| [cli](reference/cli.md) | Every `./a51` command: arguments, flags, exit codes, what each one changes, plus recipes for common situations |
| [configuration](reference/configuration.md) | Every `.env` value — what reads it, what changing it costs, whether it needs a redeploy — and the constants that are deliberately hardcoded |
| [api](reference/api.md) | The dashboard's HTTP API: routes, parameters, response shapes, pagination and error conventions |
| [database](reference/database.md) | D1 tables column by column, both R2 buckets, indexes, migrations, and what is deliberately *not* stored |

## Internals

How each runtime piece behaves. Read the relevant page before changing one.

| Document | Covers |
|---|---|
| [architecture](internals/architecture.md) | The whole system on one page: components, both capture flows, and where every piece of state lives |
| [black-holes](internals/black-holes.md) | The catcher worker: HTTP handler, email handler, all-or-nothing capture, blacklist caching, file-backed endpoints, every log event |
| [autopilot](internals/autopilot.md) | The agent interface: REST routes, the eight MCP tools, constant-time auth, the `/-/*` guardrail, registering it with a client |
| [dashboard](internals/dashboard.md) | The frontend: the no-build-step rationale, file responsibilities, pins and match ribbons, conversation grouping, email rendering, expired-session handling |
| [cleanup](internals/cleanup.md) | The retention worker: what it deletes and in what order, why requests go by count and email by age, and what it never touches |

## Cross-cutting

| Document | Covers |
|---|---|
| [development](development.md) | Running pieces locally, the code map, conventions per layer, testing, and how to add a route, a column, a command or an MCP tool |
| [decisions](decisions.md) | The design decision log — every non-obvious trade-off and what undoing it costs. Read this before "fixing" something that looks wrong |

---

## Conventions used throughout

- **Black hole** — a hostname that captures everything sent to it. One worker
  serves all of them; each has roles (`http`, `mail`, or both) recorded in the
  `domains` table.
- **Endpoint** — a row mapping an exact URI path to a response. *Text-backed*
  (typed body, your status and headers) or *file-backed* (an uploaded object,
  server-owned response).
- **Capture** — a stored request or email.
- **Autopilot** — the agent-facing worker, and the `/-/*` namespace it is confined
  to.
- `./a51 …` — the CLI at the repository root. Anything routine has a command;
  where the Cloudflare dashboard is genuinely required, it is called out
  explicitly.

Documentation is expected to stay exhaustive. If a change alters behaviour
described here, update the relevant document in the same commit — see
[development → conventions](development.md#conventions).
