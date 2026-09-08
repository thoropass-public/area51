# CLI reference

`./a51` is the only tool you need to run a deployment. It provisions, deploys,
inspects, repairs and tears down.

```bash
./a51                  # command list
./a51 <command> --help  # usage for one command
```

- **Provisioning goes through the Cloudflare REST API**, not wrangler, so every
  step can inspect current state before changing it. Wrangler is used only to
  upload Worker code and the dashboard.
- **`.env` holds the configuration; D1 holds the live lists.** Commands read
  `.env`, and `setup` / `users` write back into it. There is no lock file and
  nothing cached in a home directory. Who may use the deployment (`users`) and
  which hosts are catchers (`black-holes`) live in D1 instead, so both change
  without a redeploy.
- **Everything is idempotent.** Re-running is the normal way to converge a
  deployment.

**Reading the output.** One symbol per outcome, the same in every command:

| | Means |
|---|---|
| `✓` | created or changed |
| `·` | already correct, dimmed because nothing happened |
| `!` | worth reading, not a failure |
| `✗` | this step did not work; the fix is printed underneath |

Numbered phases show progress as `[3/12]` in `setup`, which is the only command
that declares a step total; elsewhere they are a bare `[3]`. Wrangler's own output is captured and
replaced by one line per upload with its duration; the full log appears only when
an upload **fails**, or when you pass `--verbose`.

## Global behavior

| Flag / variable | Effect |
|---|---|
| `--help`, `-h` | Usage for the command, then exit |
| `--verbose`, `A51_VERBOSE=1` | Show every wrangler invocation and its full output. Off by default: wrangler is chatty enough to bury the CLI's own report |
| `--version`, `-v` | Print the version from `package.json`. `./a51 version` does the same |
| `A51_DEBUG=1` | Print a stack trace on an unhandled error |
| `A51_API_BASE` | Point the API client at another base URL. There is no test suite; this is the hook that would let one run the provisioning path against a local mock ([development](../development.md#testing)) |
| `NO_COLOR` | Disable color; also disabled automatically when stdout is not a TTY |

**Exit codes**

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | Failure, or the operator declined a confirmation |
| `2` | Partial success. The work is done except for steps that need a human, and every one is printed with its dashboard click-path. |

Exit `2` is the interesting one: a missing token permission or an
account-level toggle stops *one* step, not the run. Fix the cause and re-run.

**No single step can abandon a run.** `setup` provisions as much as it can and
lists what it could not; `deploy all` runs every target even if one fails, and
reports how many succeeded; `doctor --fix` keeps checking after a repair throws.
Steps that genuinely depend on a failed one are skipped with a reason rather than
being attempted and failing again. A worker is not uploaded without a database id
to bind, and a hostname blocked by a foreign DNS record is not provisioned. The
only fatal errors are the ones that make everything downstream meaningless: no
API token, a rejected token, no account, or an unresolvable zone.

---

## setup

```
./a51 setup [--dry-run]
```

Provisions and deploys everything: D1 database and schema, both R2 buckets, the
three Workers, the black hole's Custom Domain and mail catch-all, the Pages
project with its bindings, DNS, and the Cloudflare Access application.

It asks for the **zone**, a confirmation that the zone may be taken over, the
fallback inbox, and your own email address as the first operator. Most answers
are written back to `.env`. The operator address is not: it becomes a row in the
D1 `users` table, and a re-run reads that table instead of asking again.
There are no hostname questions: the black hole is the zone apex with both roles,
and the other two hostnames are derived as `area51.<zone>` and
`autopilot.<zone>` ([why](../guides/getting-started.md#why-the-black-hole-is-always-the-apex)).
Setting `DASHBOARD_HOSTNAME` or `AUTOPILOT_HOSTNAME` in `.env` overrides the
derived value without prompting.

The takeover confirmation escalates to a typed `TAKEOVER` when the zone already
has MX or apex records, so hijacking a domain in use cannot happen on a reflexive
Enter. Once confirmed, the apex is really cleared. A Pages project or Worker
holding that hostname is detached from it, a plain DNS record is deleted, and
then the catcher is bound.

If either derived hostname already holds a DNS record belonging to something
else, setup names the record, skips that hostname's own steps, and provisions
everything else. The conflict comes back as a follow-up and the run exits `2`.

| Flag | Effect |
|---|---|
| `--dry-run` | Resolve and save configuration, print the plan, change nothing on Cloudflare |

Safe to re-run at any time. Full step-by-step: [getting-started](../guides/getting-started.md).

## deploy

```
./a51 deploy [all | black-holes | autopilot | cleanup | dashboard | schema]
```

Uploads code that is already provisioned. Defaults to `all`.

| Target | What happens |
|---|---|
| `black-holes` | Render `wrangler.toml` from the template + `.env`, then `wrangler deploy` |
| `autopilot` | Render `wrangler.toml` and deploy. There is no secret to install, because it authenticates against the D1 `users` table |
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
thresholds, and the operators with their key ids. Read-only.

The operator list comes from the D1 `users` table, not from Cloudflare. `status`
never reads the Zero Trust list. Use `./a51 doctor` to check whether Access is
actually enforcing that list.

No row counts, deliberately, because D1 bills per row read
([decisions](../decisions.md#no-row-counts-anywhere-in-the-ui)).

## doctor

```
./a51 doctor [--fix]
```

The acceptance test. It works through six sections in this order, then probes:

1. **Configuration**: `.env` completeness, token validity.
2. **Storage**: the database, its seven tables and the late-added columns, both
   buckets.
3. **Workers**: all three, **and the bindings that actually reached them**. The
   ones each must have, and the one Autopilot and Cleanup must *not*. A `FILES`
   binding on either is a failure, because it would let them reach the uploads
   bucket ([invariant 3](../../CLAUDE.md)).
4. **Black holes**: every one's Custom Domain and mail catch-all, **plus MX
   records of its own for any subdomain that captures mail**.
5. **Dashboard**: the Pages project's bindings on production **and** preview,
   and its custom domain.
6. **Access control**: the operator list and whether Cloudflare Access enforces
   exactly it, the application, its allow policy, and that its destinations
   cover the `*.pages.dev` URL.

Then it probes the live hosts from your machine:

- the black hole answers `404` on an unknown path,
- Autopilot answers `401` with no key, and `401` (not `503`) to an unknown one,
  which proves it can reach D1 to check keys at all,
- the dashboard redirects to the Access login rather than serving content.

| Flag | Effect |
|---|---|
| `--fix` | Re-apply what is safe to re-apply: the schema, Pages bindings and production branch, the dashboard CNAME, black hole domain bindings, and the Access application, policy and destinations |

Read-only without `--fix`. Exit `1` if anything failed. The live probes always
run, because they are the only checks that see what the API cannot: DNS that has
not propagated, a certificate still provisioning, a worker that deployed but is
not routed. A probe that cannot reach its host is reported as a failure with that
reason, which is itself information.

## black-holes

```
./a51 black-holes list
./a51 black-holes add <hostname> [http,mail]
./a51 black-holes remove <hostname>
```

A black hole is up to three things at once, and this command keeps them in step:
a hostname bound to the catcher (for `http`), Email Routing enabled for that name
with the zone catch-all pointed at the catcher (for `mail`), and a row in the
`domains` table so the dashboard and Autopilot know it exists.

The D1 table is still called `domains`. Only the command was renamed.

### add

**Roles are asked when omitted.** With no roles argument you get a three-way
choice: HTTP and email, HTTP only, or email only. Pass them positionally
(`add host http`) to skip the prompt, which is also what anything scripted should
do.

| Roles | What is provisioned |
|---|---|
| `http` | Custom Domain on the catcher. No mail records are touched. |
| `mail` | Email Routing enabled **for that name** (MX + SPF added and locked), and the zone catch-all confirmed to point at the catcher. |
| `http,mail` | Both. |

**Mail works on a subdomain.** Email Routing is enabled per name, and the zone's
catch-all covers the apex plus every enabled subdomain, so
`<anything>@<sub.black-hole.tld>` is captured with no per-address rules.

**But the subdomain's own zone apex must already be a mail black hole**, because
the catch-all is zone-scoped and only exists once the apex has it. Adding a
subdomain first is refused, and the two commands to run instead are printed.
Enabling it would lock MX records whose mail has nowhere to go.

Before provisioning, `add` prints what changes and takes consent for the
destructive part:

- **Apex + mail** always confirms, since Email Routing locks MX for the whole zone.
- **Subdomain** confirms only when records are already in the way.
- Either way, records that will actually be replaced are listed by name and the
  gate becomes a typed `TAKEOVER` rather than a y/N.
- Records listed there are then really replaced. Whatever holds the hostname is
  released first: a Pages project or Worker is detached from it, and a plain DNS
  record is deleted. Anything that could not be released comes back as a
  follow-up naming it.

No redeploy needed: the next page load and the next agent call pick the host up.
DNS and the certificate take a minute.

### remove and list

- `remove` drops the row and detaches the Custom Domain, which stops HTTP
  capture. It deliberately leaves Email Routing alone, since the catch-all is
  zone-wide and another black hole on the same zone may still need it. Captured
  data is kept.

  **A removed subdomain keeps capturing mail.** Its MX records stay, locked by
  Email Routing, and the zone catch-all still covers it, so mail to
  `<anything>@<the removed host>` is still accepted and still stored. Cloudflare
  has no per-name disable (`DELETE …/email/routing/dns` turns routing off for the
  *whole zone*, taking every other black hole on it down too), so the only way to
  stop it is by hand: dashboard → the zone → Email → Email Routing → Settings →
  Subdomains. Treat a host as decommissioned only once you have done that.

  `remove` prints that warning only for a host whose row carried the `mail`
  role. An http-only host has no mail to leave behind, so nothing is printed.
- `list` flags any host that is in the table but not actually bound.

## users

```
./a51 users [list]                  # who has access, and their key ids
./a51 users add [email]             # add an operator and mint their key
./a51 users remove <email>          # revoke the dashboard and Autopilot
./a51 users rotate-key <email>      # issue a new key for one operator
./a51 users sync                    # reconcile Cloudflare with D1
```

Subcommands, matching `./a51 black-holes`. Both manage a list, so both read the
same way. With no action it lists, which is read-only.

One command because a person is one thing, even though a deployment has two
doors, and they authenticate completely differently:

| | Dashboard | Autopilot |
|---|---|---|
| Guarded by | Cloudflare Access | The `users` table |
| Credential | **None**. Cloudflare emails a one-time PIN | `Authorization: Bearer <key>` |
| Changing it | Re-push the Access allow policy | Nothing. The worker reads D1 live |

Neither knows the other exists. Keeping them in step is this command's whole
job: the D1 `users` table is the source of truth for both, and every mutation
re-pushes the Access allow-list derived from it. That is also why there is no
`ALLOWED_EMAILS`: a second copy of the list in `.env` could only ever drift.

`add` and `rotate-key` also manage the Access application itself when needed:
the Zero Trust organization, the One-time PIN login method, the application, its
allow policy, and its destinations (custom domain **plus** the `*.pages.dev`
URLs, so there is no unauthenticated bypass).

### Keys

A key is `<key_id>_<secret>`, meaning 8 hex characters, an underscore, then 64
hex characters. It is sent as `Authorization: Bearer <key>`:

- **`key_id` is public.** It is the database lookup, it is what the worker logs,
  and `users list` prints it. On its own it authenticates nothing.
- **The 64-hex tail is the credential**, 256 bits of entropy.

Only `sha256(<the whole key>)` is stored, so **a key is shown exactly once**,
when it is minted, and cannot be recovered afterwards. A lost key is replaced
with `rotate-key`, never read back. Rotating takes effect immediately and
breaks every agent registered with the old key; there is no dual-key window.

**Rotation replaces both halves**, not just the credential: a new `key_id` is
minted alongside a new secret, and both columns are overwritten in one write.
That is why the command is `rotate-key` and not `rotate-secret`. One consequence
worth knowing, since `key_id` is the attribution handle in the worker's logs: the
same operator appears under a different `key_id` before and after a rotation.
Attribution still holds, because the worker logs `email` next to it, but
correlating by `key_id` alone across a rotation will not.

No key is written to disk, including your own. Not to `.env`, not anywhere
else. Yours goes wherever you put it when it was printed; everyone else's is
handed over out of band. `doctor` therefore has no real key to probe with: it
sends no key and then a deliberately bogus one, and expects `401` both times,
which proves Autopilot is up, routed, and able to reach D1 to check a key at all
(a `503` there means it cannot).

### Removing the last operator

Removing the last operator **shuts the dashboard to everyone.** Their Autopilot
key dies with the row, and the Access application is rewritten with an explicit
**deny-everyone** policy, replacing the allow.

Cloudflare does not document how an `email_list` include rule behaves when the
list it names is empty, and "probably nobody matches" is not a safe inference for
the only control in front of every captured request and email. So the deny is
written explicitly rather than relied upon
([decisions](../decisions.md#one-users-table-for-both-doors-and-per-operator-keys)).
`./a51 users remove` warns before it does this, and `./a51 users add` restores the
allow policy.

The one thing that does *not* end immediately is a session already issued:
Access keeps it until it expires. Revoke active sessions in Zero Trust if that
matters.

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

## destroy

```
./a51 destroy
```

Two gates, each needing a typed word rather than a y/N:

1. Type `REMOVE`. Deletes the three Workers, the Pages project, the dashboard
   DNS record and the Access application. All rebuildable from this repository;
   captured data untouched.
2. Type `DELETE-DATA`. Deletes the D1 database and both R2 buckets, emptying
   them first. Permanent.

Inside the first gate it also **offers to disable Email Routing** on every zone
this deployment enabled it for, which deletes the MX, SPF and DKIM records
Cloudflare added and locked. That is a plain y/N rather than a typed gate, since
it is config and `./a51 setup` puts it back, but it is asked rather than assumed,
because it is the one step that changes how the whole zone behaves. Declining
leaves the records in place and locked.

Answering no to the second gate leaves your captures intact, so `./a51 setup` can
rebuild on top of them. `.env` is never touched.

---

## Recipes

```bash
# first deploy
cp .env.example .env && ./a51 setup

# converge after editing .env or pulling new code
./a51 setup && ./a51 deploy all

# add a second black hole mid-engagement
./a51 black-holes add <other-black-hole.tld> http,mail

# someone joined / left the team
./a51 users add <teammate@domain.tld>      # prints their key once
./a51 users remove <teammate@domain.tld>

# something is off
./a51 doctor            # diagnose
./a51 doctor --fix      # repair what is repairable

# end of engagement
./a51 purge             # requests, emails, or every agent-staged endpoint
```
