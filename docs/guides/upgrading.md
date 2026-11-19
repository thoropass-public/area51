# Upgrading

One page per upgrade that needs more than `git pull && ./a51 deploy all`.

## v1.1.0 → v1.2.0

**Your captured data is not touched by this upgrade.** It changes one schema
column and the shape of one CLI command. Budget five minutes.

### What changes

| | v1.1.0 | v1.2.0 |
|---|---|---|
| `domains` table | `domain`, `roles` | `domain` |
| `black-holes add` | `<host> [http,mail]`, any hostname | `<zone>`, a zone apex only |
| `black-holes remove` | leaves a subdomain's MX records behind | offers to clear the zone's mail subdomains first |
| `.env` | `BLACK_HOLE_ROLES` | gone, and ignored if left in the file |
| Home orbit chips | address + an `http · mail` label | address only |
| Endpoints toolbar | an **Archive** toggle, plus a `:autopilot:` search term nothing advertised | one scope switch: **Endpoints · Autopilot · Archive** |

A black hole is now a whole Cloudflare zone that always captures both HTTP and
mail, so there is nothing left to record per host and nothing to choose when
adding one. The reasoning is in
[decisions](../decisions.md#a-black-hole-is-a-whole-zone-and-has-no-roles).

**Nothing stops capturing during this upgrade**, and no hostname changes. The
catcher reads neither `roles` nor the `domains` table on its HTTP or its email
path, so every black hole and every mail subdomain keeps working throughout.

### 1. Back up D1

```
npx wrangler d1 export area51 --remote --output area51-pre-1.2.0.sql
```

This one is worth doing even though the upgrade is small: `DROP COLUMN` is
irreversible and the backup is the only way back to the `roles` values.

### 2. Deploy the workers, then the schema

Order matters here, and it is the opposite of the usual one. The migration drops
a column that the running code still selects, so ship the code that has stopped
selecting it first:

```
git pull
./a51 deploy black-holes
./a51 deploy autopilot
./a51 deploy cleanup
./a51 deploy dashboard
./a51 deploy schema
```

`./a51 deploy all` works too, and applies the schema first. The cost is a few
seconds in which the old dashboard and Autopilot query a column that is gone;
both degrade to an empty host list rather than erroring, and both recover as soon
as their upload lands. Capture is unaffected either way.

### 3. Check it

```
./a51 black-holes list
./a51 doctor
```

`list` loses its ROLES column. `doctor` reports a **subdomain black hole** from
an older deployment as a warning rather than a failure: such a row keeps working,
and `./a51 black-holes remove <that host>` takes it out when you no longer want
it, offering that one name's Email Routing entry and MX records with it.

### Leftovers you can clean up

- `BLACK_HOLE_ROLES` in `.env` is no longer read by anything. Delete the line, or
  leave it; nothing depends on it either way.
- **Tell anyone who used `:autopilot:` that it is gone.** Typing it now searches
  for that literal string and finds nothing. Agent-staged endpoints are the
  **Autopilot** position on the new scope switch, and searching inside it
  narrows within that list. Nothing about the stored data changes.
- Adding a subdomain to the catcher is no longer a CLI command. Both recipes —
  HTTP on one subdomain, mail on one subdomain — are now in
  [operations](operations.md#putting-a-subdomain-on-the-catcher), and both are
  Cloudflare dashboard steps that need nothing from AREA 51.

### If it goes wrong

`git switch` back to the previous tag and `./a51 deploy all` puts the old workers
back, but they will fail to read `domains` until the column exists again. Restore
it from the step 1 backup, or re-add it by hand:

```
npx wrangler d1 execute area51 --remote --command \
  "ALTER TABLE domains ADD COLUMN roles TEXT NOT NULL DEFAULT '[\"http\",\"mail\"]'"
```

## v1.0.0 → v1.1.0

**Your captured data is not touched by this upgrade.** Nothing in it deletes a
row, an email or an uploaded file. Read [what changes](#what-changes) anyway,
because one of the new features deletes data on a schedule, starting about a
month after you finish.

Budget 20 minutes, most of it waiting for Cloudflare.

### What changes

| | v1.0.0 | v1.1.0 |
|---|---|---|
| Dashboard | Cloudflare Pages project | a Worker with static assets |
| `endpoints` table | no `archived` column | `archived INTEGER NOT NULL DEFAULT 0` |
| Cleanup worker bindings | `DB`, `EML` | `DB`, `EML`, `FILES` |
| `.env` | `PAGES_PROJECT_NAME` | `DASHBOARD_WORKER_NAME` |

**Operator keys are untouched.** They live in the D1 `users` table, and nothing
here writes to it. Autopilot reads `key_hash` live, so every key keeps working
through the upgrade. Keys change only when you run `./a51 users rotate-key`.

**Autopilot's fence is untouched.** It still has no `FILES` binding. The cleanup
worker gains one so the purge can delete an endpoint's object before the
row pointing at it.

Why the dashboard moved is in
[decisions.md](../decisions.md#the-dashboard-is-a-worker-not-a-pages-project).
The short version: a Pages project answers on its custom domain **and**
`<project>.pages.dev` **and** every preview deployment, and Access is enforced
per hostname, so the extra names had to be enumerated and guarded or they were an
unauthenticated way in. A Worker with `workers_dev = false` and
`preview_urls = false` has one name.

### 1. Back up D1

```
npx wrangler d1 export area51 --remote --output area51-pre-upgrade.sql
```

Use your `D1_DATABASE_NAME` if you changed it. Wrangler needs
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in the environment; both are
in your `.env`.

Move the file somewhere outside the repository. There is no backup command in
the CLI, which is a gap and not a deliberate omission.

R2 needs no backup. Nothing in the upgrade writes or deletes an object.

### 2. Update and provision

```
git pull && npm install && ./a51 setup
```

Answer the prompts as you did originally. **Give the same operator address**: a
different one adds that person as a new operator with dashboard access, which is
additive rather than a rotation, but probably not what you meant.

`setup` applies `db/schema.sql` at its Storage step, before it deploys any
worker. That order matters here. The catcher's endpoint lookup is
`WHERE uri = ? AND archived = 0`, so a catcher deployed ahead of its column would
answer **404 for every endpoint on every black hole** until the schema landed.

**Expect exit code 2 and two follow-ups.** They are the expected state, not a
failure:

- `<host> already has a DNS record that is not part of this deployment`, because
  the Pages project still holds your dashboard hostname
- `the Pages project <name> still serves this dashboard`, because Access is
  keeping its `pages.dev` names guarded on purpose while that project is still
  live and still bound to D1 and both R2 buckets

At this point all four workers are deployed, the schema is migrated, and your
dashboard is still being served by Pages. Everything works.

### 3. Hand the hostname over

In the Cloudflare dashboard: **Workers & Pages → your Pages project → Custom
domains → remove your dashboard hostname.**

Do it at the owning product, **not in DNS**. Cloudflare manages that CNAME on the
project's behalf; deleting the record directly leaves the project still claiming
the name, and the next `setup` hits the same conflict.

```
./a51 setup
```

The Custom Domain now binds to the Worker. The dashboard is unreachable between
the detach and this run.

### 4. Delete the Pages project

Once `https://<your dashboard host>` loads and redirects you to the Access login,
the Worker owns the name and the project is dead weight: **Workers & Pages → the
project → Settings → Delete project.**

Until you do, it still answers on its `pages.dev` URLs with live D1 and R2
bindings. Access guards those names, so it is not open, but it is a second live
copy of your console.

### 5. Narrow the Access destinations

```
./a51 users sync
```

Deleting the project does **not** update the Access application by itself.
Nothing reads Cloudflare's state until something asks it to, and this is the
command that does: it re-reads the operators from D1, rewrites the Zero Trust
list, and rewrites the application itself.

Then check **Zero Trust → Access → Applications → AREA 51 dashboard →
Destinations** by hand. You want exactly one: your dashboard hostname.

Before this point three destinations is the **correct** state, not a bug. While
the Pages project is alive it still answers on `<project>.pages.dev` and every
`*.pages.dev` preview with its D1 and R2 bindings attached, so setup keeps those
names guarded rather than narrowing to the Worker and leaving them open. The
extra entries go when the project does.

`doctor` reports the policy count, not the destination list, so it shows green
either way. This is the one step of the upgrade it cannot verify for you.

### 6. Verify

```
./a51 doctor
```

Everything should pass. Two lines are worth reading rather than skimming:

- `emails / endpoints columns match the current schema` means the `archived`
  migration landed
- `<host> → Custom Domain on <dashboard worker>` means the handover finished

Then try the new behavior:

| Feature | Check |
|---|---|
| robots.txt | `curl https://<black-hole>/robots.txt` returns `Disallow: /` |
| Archive | Archive an endpoint. `curl` it and get a 404, find it under **Archive**, unarchive it and it serves again |
| Rename | Rename an endpoint. The old path 404s, the new one serves |
| Autopilot endpoints | Stage one under `/-/`. It does not appear in the Endpoints list; the **Autopilot** scope shows it |
| Inline images | Send yourself an email with an inline image to a mail black hole and open it |

### Decide what the purge should do

v1.1.0 adds one job that deletes data on a timer. By default the cleanup run
deletes **every** endpoint under `/-/` on the first Sunday of each month,
including any file an operator uploaded to such a path from the dashboard.

Decide this now rather than in a month. `CLEANUP_AUTOPILOT_PURGE` in `.env`
takes `off`, `daily`, `weekly` or `monthly`, and you do not have to add the key:
without it the worker uses `monthly`. Redeploy the cleanup worker after a
change. Full detail in
[internals/cleanup](../internals/cleanup.md#the-autopilot-purge).

Whatever you choose, move anything under `/-/` that you want to keep to a path
outside the prefix.

### If step 3 goes wrong

`git switch main` and `./a51 deploy all` puts the v1.0.0 workers back. The
`archived` column is additive, so the old code ignores it and your data is
unaffected. The `.sql` backup from step 1 covers everything else.
