# AREA 51 documentation

The project [README](../README.md) gets you deployed. These documents explain
how the thing actually works, and are meant to be exhaustive enough that a
newcomer can take the codebase over, and an operator can debug an outage without
asking anyone.

**Keep them in sync with the code.** If a change alters behaviour described
here, update the relevant document in the same commit.

## Reading order

For a first read, in this order:

1. **[architecture.md](architecture.md)** — the whole system on one page: the
   three runtimes, the two stores, and the exact path a captured request or
   email takes.
2. **[setup.md](setup.md)** — the API token, the hostname layout, and what
   `./a51 setup` does at each step (with the manual dashboard equivalent for
   every one of them, in case a step fails).
3. **[configuration.md](configuration.md)** — every `.env` value: what reads it,
   what changing it costs, and whether it needs a redeploy.
4. **[operations.md](operations.md)** — the day-two runbook: deploying, adding
   black holes, purging, reading logs, quotas, rotating secrets.

## Reference

| Document | Covers |
|---|---|
| [deployment.md](deployment.md) | What a healthy deployment looks like in the Cloudflare dashboard — annotated screenshots of Workers & Pages, D1, R2 and Access (a visual companion to `./a51 doctor`) |
| [database.md](database.md) | D1 tables column by column, both R2 buckets, indexes, migrations, what is deliberately *not* stored |
| [api.md](api.md) | Every dashboard API route: parameters, response shapes, pagination, error conventions |
| [dashboard.md](dashboard.md) | The frontend: file responsibilities, list/pin/grouping behaviour, modals, email rendering, session handling |
| [black-holes.md](black-holes.md) | The catcher worker: HTTP handler, email handler, blacklists, file-backed endpoints, every log event |
| [autopilot.md](autopilot.md) | The agent interface: REST routes, the eight MCP tools, auth, the `/-/*` guardrail, registering it with Claude Code |
| [cleanup.md](cleanup.md) | The scheduled retention worker: what it deletes, in what order, and how to tune it |
| [security.md](security.md) | Trust model, what is exposed, Cloudflare Access, secret handling, untrusted-content handling |
| [troubleshooting.md](troubleshooting.md) | Symptom → probable cause → fix, including every "it returns 500" case |
| [development.md](development.md) | Running pieces locally, the code map, conventions, how to add an API route or a tab |
| [decisions.md](decisions.md) | The design decision log — the non-obvious trade-offs and why undoing them costs something |

## Conventions used throughout

- **Black hole** — a hostname that captures traffic. One worker serves all of
  them; each has roles (`http`, `mail`, or both) recorded in the `domains` table.
- **Endpoint** — a row in the `endpoints` table: an exact URI path mapped to a
  response. *Text-backed* (typed body) or *file-backed* (uploaded object).
- **Capture** — a stored request or email.
- `./a51 …` — the CLI at the repository root. Everything an operator does
  routinely has a command; anything that needs the Cloudflare dashboard is
  called out explicitly.
