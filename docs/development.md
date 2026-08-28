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

## The development loop

There is no local dev server. `wrangler dev` was wired up as `./a51 dev` and
removed: the two things most worth testing in this project cannot be exercised
locally at all, and for the rest a deploy is a few seconds.

So the loop is deploy-and-look:

```bash
./a51 deploy dashboard      # after a .jsx / .css / Functions change
./a51 deploy black-holes    # after a catcher change
./a51 tail black-holes      # watch what it does
./a51 doctor                # confirm the deployment is intact
```

Use a throwaway zone for this, not the one carrying an engagement.

**What could never be tested locally anyway**

- **Inbound email.** The `email()` handler is only ever invoked by Cloudflare
  Email Routing. Nothing on your machine can trigger it, so every email-capture
  change has to be deployed and exercised with a real message.
- **Cloudflare Access.** The local Pages server has no edge auth, so the
  expired-session reload path only reproduces against a deployment.

**What a local server did give you,** for the record, in case someone wants to
bring it back: a reload loop for the dashboard's JSX and Functions, against an
empty local D1 and R2. Worth knowing that `wrangler pages dev` has no `--remote`
flag, so that loop could never see real captured data — which is what made it
weak enough to drop.

**Exercising the cleanup worker.** It has no `fetch` handler, so its only trigger
is the cron. To act on retention now, use `./a51 purge`, which does the same work
interactively and age-based for both tables. Watch a real scheduled run with
`./a51 tail cleanup`.

## Code map

| Path | What lives there |
|---|---|
| `a51`, `cli/a51.mjs` | CLI entrypoint and command dispatch |
| `cli/lib/cloudflare.mjs` | Cloudflare REST client + resource helpers. Every provisioning call goes through here |
| `cli/lib/provision.mjs` | The idempotent provisioning primitives shared by `setup`, `deploy`, `domains`, `access`, `doctor` |
| `cli/lib/env.mjs` | `.env` parsing and surgical writes |
| `cli/lib/wrangler.mjs` | Worker target table, `wrangler.toml` rendering, wrangler invocation |
| `cli/lib/{log,prompt,context,sql}.mjs` | Output, prompts, per-command bootstrap, SQL splitting |
| `cli/lib/permissions.mjs` | The API-token permission list, printed by both the help screen and `setup` so the two cannot drift |
| `cli/lib/r2s3.mjs` | Dependency-free SigV4 signer + R2 object listing. Used only by `destroy`, because the v4 API has no reliable object list |
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

- **All output goes through `cli/lib/log.mjs`.** It defines the whole visual
  vocabulary — symbols, indentation, `kv`, `table`, `section`, `summary`. If you
  need a shape that is not there, add it there rather than hand-rolling spacing
  in a command, or the columns stop lining up between commands.
- Default verbosity is a summary: what changed, what did not, what needs a human.
  Anything only useful while debugging goes through `trace()`, which prints under
  `--verbose` and is silent otherwise.
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
  [autopilot.md](internals/autopilot.md#smoke-tests), [cleanup.md](internals/cleanup.md#acting-on-retention-between-runs).

If you add automated tests, the CLI is the tractable part: `cli/lib/cloudflare.mjs`
honors `A51_API_BASE`, so the whole provisioning path can run against a local mock
HTTP server with no Cloudflare account involved.

Before shipping a change, at minimum:

```bash
node --check cli/a51.mjs && for f in cli/lib/*.mjs cli/commands/*.mjs; do node --check "$f"; done
./a51 setup --dry-run
./a51 doctor
```
