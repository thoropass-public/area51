# Getting started

`./a51 setup` takes a Cloudflare API token and a domain that is already on the
account, and leaves you with a working deployment. This document explains what it
needs, what it does at each step, and how to finish any step by hand if the API
refuses.

Once it is up: [verify-deployment](verify-deployment.md) shows what a healthy
deployment looks like in the Cloudflare dashboard, and
[usage](usage.md) is the playbook for using it on an engagement.

```bash
npm install
cp .env.example .env      # paste CLOUDFLARE_API_TOKEN
./a51 setup
```

The command is **idempotent**. It inspects the current state before changing
anything and reports `·` for "already correct", `✓` for "changed it". Re-running
after a failure, after editing `.env`, or after pulling new code is the normal
way to bring a deployment back in line. It never deletes data.

Useful flags:

| Flag | Effect |
|---|---|
| `--dry-run` | Resolve and save configuration, print the plan, change nothing on Cloudflare. |

---

## Prerequisites

### 1. A domain on the Cloudflare account

Add it as a zone first (Cloudflare dashboard → *Add a site*) and let DNS move
over. Setup lists your active zones and asks which one to use; it cannot
register or transfer a domain for you.

Use a domain you do not mind burning. Targets, scanners and threat-intel feeds
all see it.

### 2. R2 enabled

Captured email and uploaded payloads live in R2 object storage. Enabling R2 is a
one-time click that the API cannot do for you: dashboard → **R2** → *Get
started*. The free tier may still ask for a card.

If you skip this, setup reports `could not create R2 bucket …` and continues; the
deployment works for HTTP capture but email capture and file endpoints fail.

### 3. Zero Trust activated (for the dashboard's login)

The dashboard is protected by Cloudflare Access, which is part of Cloudflare Zero
Trust. On a brand-new account Zero Trust has to be **activated once, by hand**, because
the API cannot do that first activation: dashboard → **Zero Trust**, pick a team
name, and choose the **Free** plan. You do this exactly once per account.

If you skip it, setup's Access step fails with an auth-shaped error even when the
token's Access permissions are correct, because there is no Zero Trust
organization for the API to write into. Setup names this as a candidate cause, and
the step degrades into a follow-up rather than stopping the run — so the rest of
the deployment lands and the summary says plainly that the dashboard is
unprotected until you activate Zero Trust and run `./a51 users sync`.

### 4. A clean zone, with no prior mail (MX) records

Use a domain that is **not already receiving mail**, and that you are not using
for anything else. The zone you pick becomes the black hole itself: Email Routing
adds and **locks** its own MX and SPF records for the whole zone and routes every
inbound message to the catcher, and the apex `@` address record is replaced by a
Custom Domain on that same worker. Any existing mailbox or site on the domain
stops working.

Setup reads the zone first and **stops** if it finds MX or apex records: it lists
them by name and makes you type `TAKEOVER`. A fresh
throwaway domain with only the default records gets a plain y/N instead.

Mail is not optional here — the primary black hole always carries both roles.
`./a51 black-holes add <host> http` still adds an HTTP-only catcher afterwards, on
any hostname, and leaves that zone's mail records alone.

### 5. Node.js 20+

```bash
node --version    # v20 or newer
npm install       # installs wrangler and postal-mime at the repo root
```

Wrangler is used only to upload Worker code and the dashboard. Everything else
goes through the REST API.

### API token

Create it at **My Profile → API Tokens → Create Token → Custom token**.

| Scope | Permission | Needed for |
|---|---|---|
| Account | **Workers Scripts** · Edit | deploying the three Workers |
| Account | **D1** · Edit | creating the database, applying the schema, all SQL the CLI runs |
| Account | **Workers R2 Storage** · Edit | creating both buckets, deleting objects during a purge |
| Account | **Cloudflare Pages** · Edit | creating the Pages project, its bindings and its custom domain |
| Account | **Account Settings** · Read | discovering the account id |
| Account | **Access: Apps and Policies** · Edit | the Access application in front of the dashboard |
| Account | **Access: Organizations, Identity Providers, and Groups** · Edit | creating the Zero Trust organization and enabling one-time PIN login |
| Account | **Zero Trust** · Edit | the operator email list the Access policy points at. Lists live under the Gateway/Zero Trust resource tree, *not* under Access: Apps and Policies — see the note below. |
| Account | **Email Routing Addresses** · Edit | registering the fallback inbox as a destination |
| Zone | **Zone** · Read | resolving hostnames to zones |
| Zone | **Zone Settings** · Edit | **enabling Email Routing** (it writes and locks the MX/SPF records). Easy to miss; see the warning below. |
| Zone | **DNS** · Edit | the dashboard's CNAME record |
| Zone | **Workers Routes** · Edit | binding black hole / Autopilot hostnames to Workers |
| Zone | **Email Routing Rules** · Edit | setting the catch-all rule that points inbound mail at the worker |

That is **fourteen** permissions: nine Account-scoped, five Zone-scoped.

> **The Email Routing trap.** *Enabling* Email Routing lives under **Zone
> Settings**, not **Email Routing Rules**. Email Routing Rules only covers the
> catch-all *rule*. A token with Email Routing Rules but no Zone Settings fails
> with a bare `[10000] Authentication error` on the enable step. Cloudflare does
> not document which permission that endpoint needs, and the error names none.
> All three mail-related permissions are required: the primary black hole always
> carries the `mail` role, so there is no `http`-only path through setup.

> **Zone Resources scope, the other "permission is set but still denied".**
> Under *Zone Resources*, you must **Include → the zone you are deploying to**
> (or *All zones*). A Zone-scoped permission whose *Zone Resources* points at a
> different zone (or none) throws the same auth-shaped error as a missing
> permission, even though the checkbox is ticked. If setup reports an auth error
> on a step whose permission you know you granted, check this first, then allow a
> minute for a freshly-edited token to propagate and re-run.

The token is stored in `.env`, which is gitignored and written with mode `600`.
It is passed to wrangler through the environment, never on a command line.

A token missing one permission does not break the whole run: the step that needs
it fails, prints the exact dashboard click-path (listing every candidate cause —
propagation, the precise permission, Zone Resources scope, Zero Trust
activation), and setup carries on and lists the follow-up at the end (exit code
`2`). Setup also retries auth-shaped failures a few times to ride out token
propagation, so a brand-new token is less likely to fail spuriously on the first
run.

That applies to **any** step failure, not just permissions. Setup provisions
everything it can and reports the rest; steps that truly depend on a failed one
(a worker needs a database id; a hostname needs to be free) are skipped with the
reason rather than attempted and failed. Because every step is idempotent, fixing
the cause and re-running converges — the parts that already worked report
"already correct".

---

## Hostname layout

**You pick the zone. Setup derives everything else.** There are no hostname
questions:

| Role | Hostname | Exposure |
|---|---|---|
| Black hole | `example.com` — the zone apex, always | **Public.** Targets reach it. Serves your endpoints, captures every request and every address. |
| AREA 51 | `area51.example.com` | Behind Cloudflare Access. |
| Autopilot | `autopilot.example.com` | Public but useless without an operator key; every route answers 401. |

The black hole always carries **both roles** (`http` and `mail`), which gives you
two callback surfaces on one domain:

```
HTTP callbacks    https://example.com/<anything>
Email callbacks   <anything>@example.com
```

### Why the black hole is always the apex

The catch-all rule that delivers mail to the catcher is **zone-scoped**: one per
zone, and it covers the apex plus every subdomain enabled for Email Routing.
Nothing anywhere on the zone can capture mail until the apex is a mail black
hole, because the apex is what puts that catch-all there.

So making the apex the primary black hole establishes the foundation once, and it
makes the HTTP host and the mail domain the same string, which means every
callback address the tool prints works. The alternative — a subdomain black hole
with no MX behind it — bounces the target's mail back at the target and shows you
nothing, which reads as "the vulnerability didn't fire."

This does **not** mean subdomains are HTTP-only. See below.

### Adding more black holes

```bash
./a51 black-holes add http-only.example.com http     # HTTP catcher, no mail records touched
./a51 black-holes add listen.example.com mail        # email capture on a subdomain
./a51 black-holes add other.example.net             # asks which roles you want
```

With no roles argument it asks: HTTP and email, HTTP only, or email only.

**Mail on a subdomain works**, and needs nothing manual. AREA 51 enables Email
Routing for that exact name (MX + SPF added and locked for it), and the zone's
existing catch-all — which already covers every enabled subdomain — delivers to
the catcher. `<anything>@listen.example.com` is captured like any other address.

The one rule: **the subdomain's own zone apex must already be a mail black hole.**
For your primary zone `setup` did that. For a *different* zone, add its apex
first:

```bash
./a51 black-holes add other.example.net http,mail    # the foundation
./a51 black-holes add listen.example.net mail        # then the subdomain
```

Adding the subdomain first is refused, because without the apex's catch-all its
mail would be accepted and then silently dropped.

### The two private hostnames

`DASHBOARD_HOSTNAME` and `AUTOPILOT_HOSTNAME` are ordinary `.env` values. Set
either by hand before running setup — including to a hostname on a different
zone — and setup uses it as-is instead of deriving one.

---

## What setup does, step by step

Each step below lists the API call it makes and the equivalent manual action, in
case you need to finish it by hand. The CLI counts the three Worker deploys
separately, so its `[n/12]` progress markers run slightly ahead of the ten
headings here.

### 1. Credentials

Verifies the token (`GET /user/tokens/verify`), lists accounts, and if the
token can see more than one, asks which to use. Writes `CLOUDFLARE_ACCOUNT_ID`
back to `.env`.

*Manual equivalent:* copy the account id from any Workers & Pages project's right
sidebar into `.env`.

### 2. Zone, and the takeover confirmation

Lists your active zones and asks which one to use. That is the only layout
question: the black hole becomes that zone's apex with both roles, and AREA 51
and Autopilot become `area51.<zone>` and `autopilot.<zone>`.

Setup then prints what taking the zone over means, and asks you to confirm it:

- Email Routing is enabled and **locks** its own MX records, redirecting all
  mail for `*@<zone>` to the catcher.
- The apex `@` address record is replaced by a Custom Domain on that worker.
- Every path and every address on the domain becomes a public trap.

**If the zone already has MX or apex records, setup lists them by name and
requires you to type `TAKEOVER`.** That typed confirmation can never be
cleared by a reflexive Enter, so hijacking a domain somebody is using takes
deliberate typing. On a clean burner zone it is an ordinary y/N.

`--dry-run` prints the same disclaimer and the same list of records that would
be lost, then stops without asking for consent — which makes it the safe way to
inspect a zone before committing to it.

Setup also refuses to continue if `area51.<zone>` or `autopilot.<zone>` already
holds a DNS record that is not part of this deployment, naming the record and
telling you to delete it or to set the hostname in `.env`. Records this
deployment created are recognized as its own, so re-running stays a no-op.

Finally it asks for the fallback inbox. All answers are saved to `.env`.

### 3. Your operator account

Asks for **your** email address, and only yours — setup provisions one operator.
It must be a real inbox you can read, because Cloudflare Access emails a one-time
PIN to it; it is not an address on the black-hole domain, which is the trap, not
your mailbox.

The answer is **not** saved to `.env`. Operators live in the D1 `users` table and
nowhere else, so on a re-run setup reads that table instead of asking again — and
stays silent once anyone is in it.

The same address gets an Autopilot API key, minted in step 6 once the database
exists and printed once at the end. Teammates are added later with
`./a51 users add`, which is also the only way to mint a key.

### 4. Plan and confirmation

Prints exactly what will be created, then asks once. `--dry-run` stops here.

### 5. Storage

- `POST /accounts/{a}/d1/database` creates the database if no database with
  that name exists. Writes `D1_DATABASE_ID` to `.env`.
- Applies `db/schema.sql` **statement by statement** through
  `POST /accounts/{a}/d1/database/{id}/query`, then lists the resulting tables.
  Every statement is `CREATE … IF NOT EXISTS`, so re-applying is a no-op.
- Writes your `users` row: the address from step 3, a fresh key id, and the
  sha256 of its key. Re-running finds the existing row and **keeps the existing
  key**, since minting a new one would silently break every agent already
  registered. The key itself is held in memory only and printed once at the end.
  The allow-list pushed to Access in step 10 is read from this table.
- `POST /accounts/{a}/r2/buckets` creates the email bucket and the files
  bucket, tolerating "already exists".

*Manual equivalent:* `npx wrangler d1 create <name>`,
`npx wrangler d1 execute <name> --remote --file=db/schema.sql`,
`npx wrangler r2 bucket create <name>` (twice).

### 6. Workers

For each Worker: renders `wrangler.toml` from `wrangler.toml.template` + `.env`,
then `wrangler deploy` from that directory.

No secrets are installed. Autopilot authenticates every call against the `users`
table in D1, so operator keys travel with the database rather than with a deploy
— which is what makes `./a51 users add` take effect with no redeploy at all.

The cleanup Worker's cron trigger is registered by the deploy itself, so there is
nothing else to configure.

*Manual equivalent:* `./a51 deploy black-holes` / `autopilot` / `cleanup`.

### 7. Black hole hostname

- `PUT /accounts/{a}/workers/domains` with `{hostname, service, zone_id}`
  attaches the hostname to the catcher as a Custom Domain. Cloudflare provisions
  DNS and the certificate. The call is an upsert.
- With the `mail` role: `POST /zones/{z}/email/routing/enable` (adds and locks
  the MX and SPF records; this call is authorized by **Zone Settings:Edit**, not
  Email Routing Rules), then `PUT /zones/{z}/email/routing/rules/catch_all` with a
  `worker` action (authorized by **Email Routing Rules:Edit**) pointing at the
  catcher. Setup warns first if the zone already has MX records, since enabling
  routing takes over inbound mail for the whole zone.
- `INSERT … ON CONFLICT` into the `domains` table so the dashboard and Autopilot
  know the host exists and what it does.
- Registers `FALLBACK_ADDRESS` as an Email Routing destination address. **You
  must click the verification link Cloudflare emails to that address**, otherwise
  forwarding on a failed capture silently fails.

*Manual equivalents:*
Workers & Pages → *worker* → Settings → Domains & Routes → Add → Custom Domain ·
zone → Email → Email Routing → Get started · Routing rules → Catch-all → Edit →
*Send to a Worker* · `./a51 black-holes add <host> http,mail`.

### 8. Autopilot hostname

Same Custom Domain call, pointed at the Autopilot Worker.

### 9. Dashboard

- Creates the Pages project **bare** (name + `production_branch = main`), then
  **PATCHes the bindings** onto it: `d1_databases.DB`, `r2_buckets.EML`,
  `r2_buckets.FILES`, for both the production and preview configurations, before
  the first upload. That ordering avoids the classic "every `/api/*` call returns
  500 until you add the binding and redeploy" trap. (Create-then-patch, rather
  than one create-with-bindings call, because the combined call is rejected on
  some accounts with `[8000000]`; see
  [decisions.md](../decisions.md#pages-bindings-are-set-before-the-first-upload-via-create-then-patch).)
- `wrangler pages deploy .` from `dashboard/`. If the API create had failed and
  wrangler created the project bare as a fallback, setup re-attaches the bindings
  and redeploys so the live deployment carries them.
- `POST /pages/projects/{p}/domains` for the dashboard hostname, plus a proxied
  `CNAME` to the project's **real** `*.pages.dev` subdomain (which Cloudflare may
  suffix, e.g. `area51-xxxx.pages.dev`, when the name is globally taken). A stale
  Pages CNAME is repointed automatically; an unrelated record is left alone with a
  warning.

*Manual equivalent:* Pages → project → Settings → Bindings (D1 `DB`, R2 `EML`,
R2 `FILES`, on Production **and** Preview) → Custom domains → *Set up a custom
domain* → redeploy.

### 10. Cloudflare Access

- `GET /accounts/{a}/access/organizations`, and if the account has no Zero Trust
  organization, creates one with `auth_domain = <ACCESS_TEAM_NAME>.cloudflareaccess.com`,
  then **polls until the new org is live** before creating the login method and
  application (a just-created org isn't instantly usable, which is what used to
  make the first run fail and a second run "fix it"). Team names are **globally
  unique**; if yours is taken, set `ACCESS_TEAM_NAME` in `.env` and re-run
  `./a51 users sync`. This step needs **Zero Trust activated on the account** first
  (Prerequisite 3). Without it there is no organization to create into and the
  step fails with an auth-shaped error.
- Ensures the **One-time PIN** login method exists (Access emails a code, with no
  identity provider to configure).
- Creates or updates a `self_hosted` application with one allow policy built from
  the `users` table, `session_duration` from `ACCESS_SESSION_DURATION`, and
  `auto_redirect_to_identity` so users skip the login-method chooser.
- **Guards the pages.dev URL too, not just the custom domain.** A Cloudflare Pages
  site is reachable at *both* its custom domain **and** its `*.pages.dev` URL: the
  apex (`<project>.pages.dev`) and every preview deployment
  (`main.<project>.pages.dev`, `<hash>.<project>.pages.dev`). If Access only
  covered the custom domain, that pages.dev URL would be an **unauthenticated
  bypass** straight into the dashboard. So the app's `destinations` include the
  custom host **and** `<subdomain>.pages.dev` **and** `*.<subdomain>.pages.dev`.
  (The API's `destinations` array replaced the deprecated `self_hosted_domains`.)
  `./a51 doctor` flags it as a failure if that pages.dev destination is ever
  missing.

*Manual equivalent:* Zero Trust → Access → Applications → *Add an application* →
Self-hosted → add the dashboard hostname **and** `*.<project>.pages.dev` as public
hostname destinations → policy *Allow* with an Emails or Email domain rule.

---

## After setup

```bash
./a51 status     # configuration and what is deployed
./a51 doctor     # verifies every binding and policy, then probes the live hosts
```

`doctor` is the real acceptance test. It checks the schema (including columns
added by later releases), both buckets, all three Workers **and the bindings that
actually reached them**, the operator list and whether Access enforces exactly
it, every black hole's Custom Domain and mail routing — including that a subdomain mail
black hole has MX records of its own — the Pages bindings on both environments,
the Access application and its policy, then makes live requests:

- the black hole answers `404` on an unknown path,
- Autopilot answers `401` without a secret and `200` with the one in `.env`,
- the dashboard redirects to the Access login rather than serving content.

`./a51 doctor --fix` re-applies the schema, repairs Pages bindings, re-binds
black hole hostnames and re-applies the Access policy.

Then, in order:

1. **Eyeball it in the Cloudflare dashboard.**
   [verify-deployment](verify-deployment.md) walks the Workers, the database, both
   buckets and the Access application, screenshot by screenshot.
2. **Create an endpoint** in the dashboard and `curl` it.
3. **Send mail** to `anything@<mail-enabled-host>` and watch **Emails**.
4. **Register Autopilot** with your agent
   ([autopilot](../internals/autopilot.md#registering-with-claude-code)).
5. **Read [usage](usage.md)**, the engagement playbooks, and
   [operations](operations.md) once each.

## Re-running, upgrading, and second deployments

| Situation | Command |
|---|---|
| Pulled new code | `./a51 deploy all` |
| Schema changed upstream | `./a51 deploy schema` (or `./a51 doctor --fix`) |
| Changed a hostname, bucket or worker name in `.env` | `./a51 setup`, but read [operations.md](operations.md#renaming-things) first: renaming a Worker or a bucket creates a *new* one and orphans the old |
| Added a domain | `./a51 black-holes add <host> http,mail` |
| Someone joined or left | `./a51 users add <email>` / `./a51 users remove <email>` — both doors at once |
| Want it gone | `./a51 destroy` |

A second, independent deployment (a separate account, or a separate database on
the same account) is a second clone of the repository with its own `.env`.
Nothing is stored globally.
