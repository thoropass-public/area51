# Troubleshooting

Start here:

```bash
./a51 doctor
```

It checks the schema, both buckets, all four Workers and the bindings that
reached them, every black hole's Custom Domain and mail routing, the dashboard's
Custom Domain, the Access application and its policy, then probes the live
hostnames. Most of the table
below is something `doctor` will name for you, and `--fix` repairs a good part of
it. What each check actually asserts is documented in
[reference/cli → doctor](../reference/cli.md#doctor).

## Setup and the CLI

| Symptom | Cause | Fix |
|---|---|---|
| `CLOUDFLARE_API_TOKEN is not set in .env` | No `.env`, or the token line is empty | `cp .env.example .env`, paste a token, re-run |
| `the API token was rejected by Cloudflare` | Token deleted, expired, or mistyped (a trailing space counts) | Create a new token; permissions in [getting-started.md#api-token](getting-started.md#api-token) |
| `Cloudflare API error … [9109]` or a 403 on one step | The token is missing exactly one permission | Add it and re-run `./a51 setup`; completed steps are skipped |
| `could not enable Email Routing … [10000] Authentication error` | The token has *Email Routing Rules* but not **Zone · Zone Settings:Edit**, and the enable endpoint is a Zone Settings write | Add **Zone · Zone Settings:Edit**, re-run. See [getting-started.md#api-token](getting-started.md#api-token) |
| An auth error on a step whose permission you *know* you granted | Either the token's **Zone Resources** don't include this zone, or a freshly-edited token hasn't propagated | Set *Zone Resources → Include → your zone*; wait ~a minute and re-run (setup also retries automatically) |
| The Access step fails on the first run but `doctor --fix` fixes it later | A just-created Zero Trust org wasn't live yet | Fixed: setup now polls the org until it's ready. If it still fails, confirm Zero Trust is activated on the account |
| `could not create a Zero Trust organization` / Access denied with correct perms | Zero Trust was never activated on the account | dashboard → *Zero Trust* → pick a team name → Free plan, then `./a51 users sync` |
| `the API token cannot list accounts` | Missing *Account Settings:Read* | Add it, or set `CLOUDFLARE_ACCOUNT_ID` in `.env` by hand |
| `this account has no active zones` | The domain is not on this Cloudflare account yet | Add the site in Cloudflare and wait for it to go active |
| `no Cloudflare zone found for <host>` | Hostname is on a zone the token cannot see | Add *Zone:Read* for it, or fix the hostname |
| `could not create R2 bucket …` | R2 is not enabled on the account | Dashboard → R2 → *Get started*, then re-run |
| `wrangler is not installed` | Dependencies were never installed | `npm install` at the repository root |
| `could not create a Zero Trust organization` | Team names are globally unique and yours is taken | Set `ACCESS_TEAM_NAME` in `.env`, run `./a51 users sync` |
| `could not bind <host> to area51-black-holes: [100117] … already has externally managed DNS records` | Something else holds the hostname: a Pages project, another Worker, or a plain A/CNAME record | Fixed. A confirmed takeover now releases the name (detaching the Pages or Worker custom domain, else deleting the record) and binds again. If the follow-up still names a holder, detach it in the dashboard and re-run |
| A command finishes with `Needs a human (n)` and exit code 2 | Some steps could not complete | Each entry prints the dashboard click-path; fix and re-run `./a51 setup` |
| `unsubstituted placeholders in …wrangler.toml.template` | A template references a value not declared for that target | Add the key to the target's `vars` list in `cli/lib/wrangler.mjs` |

## Black holes

| Symptom | Cause | Fix |
|---|---|---|
| Everything returns 404, including configured paths | The hostname is not bound to the catcher | `./a51 doctor` → `./a51 black-holes add <host> http,mail` |
| `black-holes add` reports the bind failed and names a Pages project or Worker still holding the host | The release could not finish: usually a token without *Cloudflare Pages:Edit* / *Workers Routes:Edit*, or a holder on another account | Follow the click-path in the follow-up to detach it, then re-run the command |
| An endpoint exists but still returns 404 | URI mismatch; matching is exact on `url.pathname` (case, trailing slash, no globs) | Compare the stored `uri` against the path you requested |
| A file endpoint returns 404 with `http_file_missing` in the logs | The row outlived its object (someone emptied the bucket) | Re-upload from the endpoint modal, or delete the endpoint. The modal flags this as *object missing from storage* |
| A file endpoint returns 404 with `http_file_binding_missing` | The `FILES` binding is not on the **worker** | Confirm `R2_FILES_BUCKET_NAME` in `.env`, then `./a51 deploy black-holes` |
| Requests return 403 | Your IP is on `ip_blacklist` | Remove it in Settings, then wait up to 60 minutes for the edge cache |
| A blacklist change has no effect | Blacklists are cached per data center for 60 minutes, in both directions | Wait, or accept the delay, which is deliberate |
| `http_log_insert_failed` in the logs | Transient D1 error, or a quota | Logs are best-effort by design. If it repeats, check D1 health and storage |
| A request served fine but never appeared in Requests | Same as above: the log insert is fire-and-forget | Check the worker's Logs for `http_log_insert_failed` |

## Email

| Symptom | Cause | Fix |
|---|---|---|
| Nothing arrives in Emails | Email Routing is off, or its catch-all is not pointed at the catcher | `./a51 doctor` names this; fix with `./a51 black-holes add <host> http,mail` |
| Nothing arrives, and routing looks right | The zone apex has to be the mail domain, because Email Routing catch-alls are zone-wide | Send to `*@<zone>`, not `*@<subdomain>` |
| A subdomain mail black hole captures nothing, and `doctor` says it has no MX records of its own | Email Routing was never enabled for that name, or was removed from the zone's Subdomains list | `./a51 black-holes add <host> mail` re-enables it |
| `<host> cannot capture mail until <zone> does` | You asked for `mail` on a subdomain whose zone apex is not a mail black hole. The catch-all that delivers mail is zone-scoped and only exists once the apex has it | Add the apex first: `./a51 black-holes add <zone> http,mail`, then re-run the subdomain |
| Mail to a subdomain bounces after `black-hole add … mail` reported success | DNS for the newly enabled name can take a minute to propagate | Wait, then retry. `./a51 doctor` confirms the zone catch-all still points at the catcher |
| Sender gets a bounce saying *Address not accepted* | The `From:` address is on `email_blacklist` | Remove it in Settings; up to 60 minutes to propagate |
| A row exists but the body will not load | The `EML` binding is missing on the dashboard worker, or the object is gone | `./a51 doctor`; check `npx wrangler r2 object get <bucket> emails/<id>.eml` |
| Messages land in the fallback inbox instead of the dashboard | Capture failed; look for `email_capture_failed` | The tail line carries the real error. Usually a missing R2 binding or an R2 outage |
| Nothing in the fallback inbox either, on a failed capture | `FALLBACK_ADDRESS` is empty or unverified | `./a51 doctor` reports verification state; click Cloudflare's verification link |
| `email_parse_failed` in the logs | postal-mime could not parse the message | Non-fatal: the raw `.eml` is stored and the dashboard parses it itself. Only `subject` / `attachment_count` are affected |

## Dashboard

| Symptom | Cause | Fix |
|---|---|---|
| Upgrading from v1.0.x: setup says `<host> is already held by something else` | The old Pages project still holds `DASHBOARD_HOSTNAME`. The dashboard is a Worker now, and Cloudflare will not put a Custom Domain on a name another product owns | Detach the custom domain from the Pages project (Workers & Pages → *project* → Custom domains), then re-run `./a51 setup`. Delete the project once the worker serves the name. See the v1.1.0 release notes |
| Upgrading from v1.0.x: `deploy` or `doctor` complains about `DASHBOARD_WORKER_NAME` | It replaced `PAGES_PROJECT_NAME`, which is no longer read | Add `DASHBOARD_WORKER_NAME=area51-dashboard` to `.env`, or run `./a51 setup`, which writes the default |
| `/api/*` returns 500, or HTML instead of JSON | The `DB` binding did not reach the worker | `./a51 doctor` names the missing binding; `./a51 deploy dashboard` re-renders the config and re-uploads. The bindings are declared in `dashboard/wrangler.toml.template`, so check `.env` if it recurs |
| Uploading a file to an endpoint returns 500 | The `FILES` binding did not reach the worker | Same fix |
| `/api/emails/<id>/raw` returns 500 | The `EML` binding did not reach the worker | Same fix, and note this breaks *every* email body, not just Download Raw |
| `/api/*` returns 404 for a route you just added | The handler exists but is not in the `ROUTES` table in `dashboard/src/index.js`. Routing is not file-based any more, so a handler nothing routes to is unreachable | Add it to the table, then run `node dashboard/src/router.test.mjs` |
| A route reaches the *wrong* handler | A new route shadows an existing one | `node dashboard/src/router.test.mjs` — it reads the real route table and names the collision. This is the one class of dashboard bug that `doctor` cannot see, because nothing throws |
| Static files 404 but `/api/*` works | Something is under `dashboard/src/` that belongs in `dashboard/public/`, or vice versa. Only `public/` is served | Move the file. Never put server code in `public/`: everything there is downloadable |
| Opening the dashboard shows no Access challenge | No Access application, or it targets a different hostname | `./a51 users sync` |
| A long-idle tab errors once, then works after a manual reload | The Access session expired | Expected: the app auto-reloads once ([dashboard.md](../internals/dashboard.md#expired-session-handling)). Raise `ACCESS_SESSION_DURATION` to make it rarer |
| The tab reloads repeatedly | Something other than our API is answering `/api/*` | The 15 s cooldown caps this, so a loop means the API is genuinely unreachable, so check that the worker is deployed and its bindings arrived (`./a51 doctor`) |
| Search misses matches | `LIKE '%term%'` is exact-substring, not fuzzy | Try a shorter or different substring |
| Search stops returning results part-way through an engagement | On the free tier, D1 allows 5 M rows read per day, and a leading-wildcard `LIKE` cannot use an index — so each search scans the whole table. Against 200 K requests that is ~25 searches/day | Narrow the search terms, lower `CLEANUP_REQUESTS_KEEP`, or move to Workers Paid (25 B rows/month included). See [operations → quotas](operations.md#quotas-and-cost) |
| Timestamps look wrong | Rows store UTC; the UI renders in the browser's timezone | Check the machine's timezone |
| A code change is not visible | Browser cache, or the deploy went to a different worker | Hard-refresh; confirm `DASHBOARD_WORKER_NAME` |
| The endpoint copy button toasts an error | No default host selected | Pick an `http`-role host on the Home tab |

## Autopilot

| Symptom | Cause | Fix |
|---|---|---|
| Every call returns **401** | The key is unknown, revoked, rotated, or malformed. There is no "installed secret" to be wrong, because keys are checked against the `users` table | `./a51 users list` shows who has one and their key id. Issue a replacement: `./a51 users rotate-key <email>` |
| Every call returns **503** | The worker cannot reach D1, so it cannot check *anybody's* key. Not a credential problem | `./a51 doctor` checks the `DB` binding and that the `users` table exists. `./a51 doctor --fix` applies the schema |
| An agent's calls 401 but curl works | The agent still has a key that was rotated, or is still sending the old `X-A51-Secret` header | Re-register: `claude mcp remove autopilot`, then add it again with `Authorization: Bearer <key>` |
| A key that worked before this version now 401s | Pre-`users` keys were raw 64-hex and no longer match the `<key_id>_<secret>` shape | Every operator needs a new key: `./a51 users rotate-key <email>` |
| `uri must start with /-/` | The agent tried to touch an endpoint outside its namespace | Working as intended. Create it in the dashboard |
| Upsert or delete refuses with a message about the dashboard | The URI is file-backed and Autopilot has no `FILES` binding | Working as intended; a human staged that payload |
| `email_raw` returns 404 for an id the agent just saw | The 60-minute window closed | Working as intended. Read it in the dashboard |
| The agent does not see new tools or guidance | MCP clients read tool descriptions at connect time | Reconnect the server, or restart the session |
| Requests / emails come back empty during an engagement | Nothing arrived in the last 60 minutes, or the black hole is not bound | Confirm with `curl -i https://<black-hole>/probe` |

## Retention

| Symptom | Cause | Fix |
|---|---|---|
| Data older than the retention window is still there | The cleanup worker is not deployed, or its cron did not fire | `./a51 status` shows deployment state; the worker's Logs in the Cloudflare dashboard show runs |
| Emails I need were deleted | Retention is age-based and unattended | Star messages you want kept, since starred email is exempt forever |
| `cleanup_emails_r2_failed` in the logs | A batch object delete threw | Those rows are intentionally left for the next run. Nothing is orphaned |
| The database keeps growing despite cleanup | Request bodies dominate storage, or the keep-count is high | Lower `CLEANUP_REQUESTS_KEEP` and `./a51 deploy cleanup` |
| Uploaded payloads accumulate | They are never aged out, because `endpoints` has no timestamp | Delete the endpoints, or add a lifecycle rule to the files bucket |

## Getting more detail

```bash
A51_DEBUG=1 ./a51 setup                   # stack traces from the CLI
npx wrangler tail area51-black-holes      # live worker logs
```

Cloudflare-side: Workers & Pages → *worker* → Logs (persisted, for all four
workers including the dashboard) and D1 → *database* → Metrics.
