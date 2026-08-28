# CLI reference

`./a51` is the only tool you need to run a deployment. It provisions, deploys,
inspects, repairs and tears down.

```bash
./a51                  # command list
./a51 <command> --help  # usage for one command
```

- **Provisioning goes through the Cloudflare REST API**, not wrangler, so every
  step can inspect current state before changing it. Wrangler is used only to
  upload Worker code, install the Autopilot secret and upload the dashboard.
- **`.env` is the only state.** Commands read it, and `setup` / `access` /
  `rotate-secret` write back into it. There is no lock file and nothing cached in
  a home directory.
- **Everything is idempotent.** `·` means "already correct", `✓` means "changed
  it". Re-running is the normal way to converge a deployment.

## Global behavior

| Flag / variable | Effect |
|---|---|
| `--help`, `-h` | Usage for the command, then exit |
| `--yes`, `-y`, `A51_YES=1` | Non-interactive: take every default, never prompt. Fails rather than guessing a value with no default. **Never** satisfies a destructive typed confirmation. |
| `--version` | Print the version from `package.json` |
| `A51_DEBUG=1` | Print a stack trace on an unhandled error |
| `A51_API_BASE` | Point the API client at another base URL (used to run the CLI against a mock server in tests) |
| `NO_COLOR` | Disable color; also disabled automatically when stdout is not a TTY |

**Exit codes**

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | Failure, or the operator declined a confirmation |
| `2` | Partial success. The work is done except for steps that need a human, and every one is printed with its dashboard click-path. |

Exit `2` is the interesting one: a missing token permission or an
account-level toggle stops *one* step, not the run. Fix the cause and re-run.

---

## setup

```
./a51 setup [--yes] [--dry-run] [--no-access]
```

Provisions and deploys everything: D1 database and schema, both R2 buckets, the
three Workers, the black hole's Custom Domain and mail catch-all, the Pages
project with its bindings, DNS, and the Cloudflare Access application.

It asks for the **zone**, a confirmation that the zone may be taken over, the
fallback inbox and the Access allow-list, then writes every answer to `.env`.
There are no hostname questions: the black hole is the zone apex with both roles,
and the other two hostnames are derived as `area51.<zone>` and
`autopilot.<zone>` ([why](../guides/getting-started.md#why-the-black-hole-is-always-the-apex)).
Setting `DASHBOARD_HOSTNAME` or `AUTOPILOT_HOSTNAME` in `.env` overrides the
derived value without prompting.

The takeover confirmation escalates to a typed `TAKEOVER` when the zone already
has MX or apex records — which `--yes` cannot satisfy, so an unattended run
cannot hijack a domain in use. Setup also refuses to start if either derived
hostname already holds a DNS record belonging to something else.

| Flag | Effect |
|---|---|
| `--dry-run` | Resolve and save configuration, print the plan, change nothing on Cloudflare |
| `--yes` | Accept defaults, no prompts |
| `--no-access` | Skip Cloudflare Access. **The dashboard is then readable by anyone who finds the hostname.** |

Safe to re-run at any time. Full step-by-step: [getting-started](../guides/getting-started.md).

## deploy

```
./a51 deploy [all | black-holes | autopilot | cleanup | dashboard | schema]
```

Uploads code that is already provisioned. Defaults to `all`.

| Target | What happens |
|---|---|
| `black-holes` | Render `wrangler.toml` from the template + `.env`, then `wrangler deploy` |
| `autopilot` | Install `AGENT_SECRET` as an encrypted Worker Secret, then deploy |
| `cleanup` | Deploy, which re-registers the cron trigger from `CLEANUP_CRON` |
| `dashboard` | Re-assert the Pages D1/R2 bindings, then upload `dashboard/` |
| `schema` | Re-apply `db/schema.sql` (idempotent; never drops data) |

A configuration change and a code change ship the same way, since the Worker
config is regenerated from `.env` on every deploy.

## status

```
./a51 status
```

One screen: account, zone, database, buckets, the three hostnames, every
configured black hole with its roles, which Workers are deployed, the retention
thresholds and the Access allow-list. Read-only.

No row counts, deliberately, because D1 bills per row read
([decisions](../decisions.md#no-row-counts-anywhere-in-the-ui)).

## doctor

```
./a51 doctor [--fix] [--no-probes]
```

The acceptance test. Verifies, in order: `.env` completeness · token validity ·
the database and its six tables and late-added columns · both buckets · all three
Workers **and the bindings that actually reached them** (including whether
`AGENT_SECRET` is installed) · every black hole's Custom Domain and mail
catch-all · the Pages project's bindings on production **and** preview · its
custom domain · the Access application, its allow policy, and that its
destinations cover the `*.pages.dev` URL.

Then it probes the live hosts from your machine:

- the black hole answers `404` on an unknown path,
- Autopilot answers `401` with no secret and `200` with the one in `.env`,
- the dashboard redirects to the Access login rather than serving content.

| Flag | Effect |
|---|---|
| `--fix` | Re-apply what is safe to re-apply: the schema, Pages bindings, black hole domain bindings, the Access policy and destinations |
| `--no-probes` | Skip the outbound HTTP checks (useful on a network that blocks them) |

Read-only without `--fix`. Exit `1` if anything failed.

## black-hole

```
./a51 black-hole list
./a51 black-hole add <hostname> [http,mail]
./a51 black-hole remove <hostname>
```

A black hole is up to three things at once, and this command keeps them in step:
a hostname bound to the catcher (for `http`), Email Routing enabled for that name
with the zone catch-all pointed at the catcher (for `mail`), and a row in the
`domains` table so the dashboard and Autopilot know it exists.

The D1 table is still called `domains` — only the command was renamed.

### add

**Roles are asked when omitted.** With no roles argument you get a three-way
choice: HTTP and email, HTTP only, or email only. Pass them positionally
(`add host http`) to skip the prompt, which is also what anything scripted should
do. Under `--yes` the first option (both) is taken, matching the old default.

| Roles | What is provisioned |
|---|---|
| `http` | Custom Domain on the catcher. No mail records are touched. |
| `mail` | Email Routing enabled **for that name** (MX + SPF added and locked), and the zone catch-all confirmed to point at the catcher. |
| `http,mail` | Both. |

**Mail works on a subdomain.** Email Routing is enabled per name, and the zone's
catch-all covers the apex plus every enabled subdomain, so
`<anything>@listen.example.com` is captured with no per-address rules.

**But the subdomain's own zone apex must already be a mail black hole**, because
the catch-all is zone-scoped and only exists once the apex has it. Adding a
subdomain first is refused with the two commands to run instead — enabling it
would lock MX records whose mail has nowhere to go.

Before provisioning, `add` prints what changes and takes consent for the
destructive part:

- **Apex + mail** always confirms, since Email Routing locks MX for the whole zone.
- **Subdomain** confirms only when records are already in the way.
- Either way, records that will actually be replaced are listed by name and the
  gate becomes a typed `TAKEOVER`, which `--yes` cannot satisfy.

No redeploy needed: the next page load and the next agent call pick the host up.
DNS and the certificate take a minute.

### remove and list

- `remove` drops the row and detaches the Custom Domain. It deliberately leaves
  Email Routing alone, since the catch-all is zone-wide and another black hole on
  the same zone may still need it. Captured data is kept.
- `list` flags any host that is in the table but not actually bound.

## access

```
./a51 access --list                          # show the allow-list (no network)
./a51 access --add <email|domain>[,...]      # add entries, keep the rest
./a51 access --remove <email|domain>[,...]   # drop entries, keep the rest
./a51 access                                 # re-apply ALLOWED_EMAILS from .env
```

Manages the Cloudflare Access application in front of the dashboard: the Zero
Trust organization, the One-time PIN login method, the application itself, its
allow policy, and its destinations (custom domain **plus** the `*.pages.dev`
URLs, so there is no unauthenticated bypass).

Entries are full addresses (`you@example.com`) or bare domains (`example.com` =
anyone with that email domain). Everything is lowercased and de-duplicated.

There is deliberately **no positional "replace the list" form**. `--add` and
`--remove` express every change without the footgun of silently dropping entries
you forgot to retype. To set the list wholesale, edit `ALLOWED_EMAILS` in `.env`
and run the bare command. Refuses to leave the list empty; use
`./a51 setup --no-access` if you genuinely want a public dashboard.

## purge

```
./a51 purge
```

Interactive, admin-only deletion. Three options, each gated by typing `PURGE`:

| Option | What it deletes |
|---|---|
| Requests | `requests` rows older than N days. Database only. |
| Emails | Non-starred `emails` older than N days. **The R2 object goes first, then the row**, and only for objects confirmed deleted |
| Autopilot endpoints | Every `/-/*` row, plus the uploaded object of any file-backed row among them |

This exists because email lives in two stores at once. A bare
`DELETE FROM emails` in the D1 console leaves the `.eml` objects behind
unreachable, which is an invisible storage leak. Starred email is never purged.

Unattended retention is the cleanup worker's job
([internals/cleanup](../internals/cleanup.md)).

## rotate-secret

```
./a51 rotate-secret [value]
```

Generates 32 random bytes (or takes the value you pass), installs it as the
Autopilot Worker Secret, writes it to `.env`, and prints the re-registration
command. Every agent breaks until re-registered; there is no dual-secret window.

## tail

```
./a51 tail [black-holes | autopilot | cleanup] [-- <wrangler flags>]
```

Streams a Worker's structured JSON logs. Defaults to `black-holes`. Flags after
`--` pass through to wrangler:

```bash
./a51 tail black-holes -- --format=json | jq 'select(.event=="email_stored")'
```

Event names are documented per Worker in
[internals/black-holes](../internals/black-holes.md#log-events),
[internals/autopilot](../internals/autopilot.md) and
[internals/cleanup](../internals/cleanup.md#watching-it). Logs are also persisted
and queryable in the Cloudflare dashboard.

## dev

```
./a51 dev <dashboard | black-holes | autopilot | cleanup> [-- <wrangler flags>]
```

Runs one piece locally. **Local runs talk to the remote database and buckets by
default:** real endpoints, real captures, and real mistakes. Pass `-- --local`
for isolated local storage.

Two things cannot be exercised locally: inbound email (only Cloudflare Email
Routing invokes the `email()` handler) and Cloudflare Access (the local server
has no edge auth).

## destroy

```
./a51 destroy
```

Two gates, neither satisfiable by `--yes`:

1. Type `REMOVE`. Deletes the three Workers, the Pages project, the dashboard
   DNS record and the Access application. All rebuildable from this repository;
   captured data untouched.
2. Type `DELETE-DATA`. Deletes the D1 database and both R2 buckets, emptying
   them first. Permanent.

Answering no to the second leaves your captures intact, so `./a51 setup` can
rebuild on top of them. Email Routing is left enabled: it is a zone-wide setting
with its own locked DNS records. `.env` is never touched.

---

## Recipes

```bash
# first deploy
cp .env.example .env && ./a51 setup

# converge after editing .env or pulling new code
./a51 setup && ./a51 deploy all

# add a second black hole mid-engagement
./a51 black-hole add other-domain.example http,mail

# someone joined / left the team
./a51 access --add them@example.com
./a51 access --remove them@example.com

# something is off
./a51 doctor            # diagnose
./a51 doctor --fix      # repair what is repairable

# end of engagement
./a51 purge             # requests, emails, or every agent-staged endpoint
```
