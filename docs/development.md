# Development

## Getting a working copy

```bash
git clone <repo> area51 && cd area51
npm install                 # wrangler (dev dependency) + postal-mime (worker dependency)
cp .env.example .env        # paste a Cloudflare API token
./a51 setup                 # or point .env at an existing deployment
```

There is one `package.json`, at the root. The catcher's `postal-mime` import
resolves upward into the root `node_modules` at bundle time, so the Workers need no
manifests of their own.

## Running things locally

```bash
./a51 dev dashboard        # Pages dev server: static files + Functions
./a51 dev black-holes      # the catcher
./a51 dev autopilot        # the agent worker
./a51 dev cleanup -- --test-scheduled
```

**Local runs talk to the remote database and buckets by default.** That is usually
what you want (real endpoints, real captures) and it also means a local mistake is
a real mistake. Pass `--local` to use wrangler's local storage instead:

```bash
./a51 dev dashboard -- --local
```

Two things cannot be exercised locally:

- **Inbound email.** The `email()` handler is only invoked by Cloudflare Email
  Routing. Test it by deploying to a black hole and sending a real message.
- **Cloudflare Access.** The local Pages server has no edge auth, so the
  expired-session path has to be tested against a deployment.

## Code map

| Path | What lives there |
|---|---|
| `a51`, `cli/a51.mjs` | CLI entrypoint and command dispatch |
| `cli/lib/cloudflare.mjs` | Cloudflare REST client + resource helpers. Every provisioning call goes through here |
| `cli/lib/provision.mjs` | The idempotent provisioning primitives shared by `setup`, `deploy`, `domains`, `access`, `doctor` |
| `cli/lib/env.mjs` | `.env` parsing and surgical writes |
| `cli/lib/wrangler.mjs` | Worker target table, `wrangler.toml` rendering, wrangler invocation |
| `cli/lib/{log,prompt,context,sql}.mjs` | Output, prompts, per-command bootstrap, SQL splitting |
| `cli/commands/*.mjs` | One file per command, each exporting `run(args) → exit code` |
| `db/schema.sql` | The D1 schema, idempotent and commented |
| `workers/black-holes/src/index.js` | HTTP + email capture ([black-holes.md](internals/black-holes.md)) |
| `workers/autopilot/src/index.js` | REST + MCP for agents ([autopilot.md](internals/autopilot.md)) |
| `workers/cleanup/src/index.js` | Scheduled retention ([cleanup.md](internals/cleanup.md)) |
| `dashboard/js/*.jsx` | Frontend ([dashboard.md](internals/dashboard.md)) |
| `dashboard/functions/api/**` | The dashboard's JSON API ([api.md](reference/api.md)) |
| `dashboard/functions/api/_shared.js` | `PAGE_SIZE`, `MAX_UPLOAD_BYTES`, `withErrorHandler`, `json` / `errResp` |
| `docs/guides/` | Task-oriented documentation |
| `docs/reference/` | CLI, `.env`, API and schema lookup tables |
| `docs/internals/` | One page per runtime piece |
| `LICENSE`, `NOTICE` | Apache-2.0 text, and the copyright / third-party notice |

## Conventions

**Workers**

- One file per worker, no build step beyond wrangler's own bundling.
- Structured logging only: `log(event, fields)` / `logErr(event, fields)`, one JSON
  object per line. Add the event name to the relevant doc when you add one.
- Handlers never throw out to the runtime. The email handler in particular wraps
  everything and treats its catch as the compensating path.
- Two-store writes go object-first, row-second, with a compensating delete on
  failure. A visible broken row beats an invisible orphaned object.

**Pages Functions**

- Named exports (`onRequestGet`, `onRequestPost`, …), each wrapped in
  `withErrorHandler` from `_shared.js`.
- Bind SQL parameters. Validate input explicitly and return `400` with a message a
  human can act on.
- Keep list payloads narrow; fetch detail on open.

**Frontend**

- No modules: shared symbols are assigned to `window` in `ui.jsx`.
- New shared helper → `ui.jsx`. New list tab or modal → `tabs.jsx`. Shell, Home,
  Settings → `app.jsx`.
- Untrusted HTML only ever renders inside `<iframe sandbox="">`.

**CLI**

- Provisioning uses the REST API, not wrangler, so it can inspect state and be
  idempotent. Wrangler is only for uploading code and installing secrets.
- Every provisioning helper is **GET-then-act** and reports `created: false` when
  nothing changed.
- A step that fails with a human-completable fallback pushes onto `followUps` and
  returns; it does not throw. Setup prints the list and exits `2`.
- Never print a secret except where the operator explicitly needs to copy it (the
  MCP registration command).

**Documentation**

- `docs/` is expected to be exhaustive, and is organized in three tiers:
  `guides/` (how do I…), `reference/` (what is the exact value), `internals/`
  (how does it work). Put a new page in the tier matching *why a reader opens
  it*, and add it to the tables in `docs/README.md`. If a change alters behavior
  described anywhere in `docs/`, update it in the same commit.
- The design decision log ([decisions.md](decisions.md)) records *why*. Add an entry
  when you make a trade-off someone might undo without realizing the cost.

## Common tasks

**Add an API route:** see [api.md#adding-a-route](reference/api.md#adding-a-route).

**Add a column**

1. Add it to `db/schema.sql`.
2. `ALTER TABLE` on live deployments, because `CREATE TABLE IF NOT EXISTS` will not alter
   an existing table ([database.md#migrations](reference/database.md#migrations)).
3. Add a column check to `cli/commands/doctor.mjs` so existing deployments get told.
4. List it explicitly in every `SELECT` / `INSERT` that needs it.
5. Document it in [database.md](reference/database.md).

**Add a CLI command**

1. Create `cli/commands/<name>.mjs` exporting `run(args)`.
2. Register it in the `COMMANDS` map in `cli/a51.mjs` with a summary and usage line.
3. Reuse `loadContext()` for the client and account, and the `lib/provision.mjs`
   primitives for anything that touches Cloudflare.

**Add a Cloudflare API call**

Add a method to `cli/lib/cloudflare.mjs` rather than calling `fetch` from a
command, so error handling and the `A51_API_BASE` test override keep working.

**Add an MCP tool**

1. Implement the REST route in `workers/autopilot/src/index.js`.
2. Add the tool definition. The description is the agent's only instruction
   manual, so say *when* to use it and what the result does **not** contain.
3. Bump `serverInfo.version`; clients read descriptions at connect time.
4. Document it in [autopilot.md](internals/autopilot.md).

## Testing

There is no test suite in the repository. What exists instead:

- **`./a51 doctor`** is the acceptance test for a deployment: bindings, domains,
  routing, policies, plus live probes of all three hostnames.
- **`./a51 setup --dry-run`** resolves configuration and prints the plan without
  touching Cloudflare.
- **Smoke tests** per component: [black-holes.md](internals/black-holes.md#deploying-and-testing),
  [autopilot.md](internals/autopilot.md#smoke-tests), [cleanup.md](internals/cleanup.md#running-it-on-demand).

If you add automated tests, the CLI is the tractable part: `cli/lib/cloudflare.mjs`
honors `A51_API_BASE`, so the whole provisioning path can run against a local mock
HTTP server with no Cloudflare account involved.

Before shipping a change, at minimum:

```bash
node --check cli/a51.mjs && for f in cli/lib/*.mjs cli/commands/*.mjs; do node --check "$f"; done
./a51 setup --dry-run
./a51 doctor
```
