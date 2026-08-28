# Troubleshooting

Start here:

```bash
./a51 doctor
```

It checks the schema, both buckets, all three Workers, every black hole's Custom
Domain and mail routing, the Pages bindings on both environments, the Access
application and its policy, then probes the live hostnames. Most of the table
below is something `doctor` will name for you, and `--fix` repairs a good part of
it. What each check actually asserts is documented in
[reference/cli → doctor](../reference/cli.md#doctor).

## Setup and the CLI

| Symptom | Cause | Fix |
|---|---|---|
| `CLOUDFLARE_API_TOKEN is not set in .env` | No `.env`, or the token line is empty | `cp .env.example .env`, paste a token, re-run |
| `the API token was rejected by Cloudflare` | Token deleted, expired, or mistyped (a trailing space counts) | Create a new token; permissions in [setup.md#api-token](getting-started.md#api-token) |
| `Cloudflare API error … [9109]` or a 403 on one step | The token is missing exactly one permission | Add it and re-run `./a51 setup`; completed steps are skipped |
| `could not enable Email Routing … [10000] Authentication error` | The token has *Email Routing Rules* but not **Zone · Zone Settings:Edit**, and the enable endpoint is a Zone Settings write | Add **Zone · Zone Settings:Edit**, re-run. See [setup.md#api-token](getting-started.md#api-token) |
| An auth error on a step whose permission you *know* you granted | Either the token's **Zone Resources** don't include this zone, or a freshly-edited token hasn't propagated | Set *Zone Resources → Include → your zone*; wait ~a minute and re-run (setup also retries automatically) |
| The Access step fails on the first run but `doctor --fix` fixes it later | A just-created Zero Trust org wasn't live yet | Fixed: setup now polls the org until it's ready. If it still fails, confirm Zero Trust is activated on the account |
| `could not create a Zero Trust organization` / Access denied with correct perms | Zero Trust was never activated on the account | dashboard → *Zero Trust* → pick a team name → Free plan, then `./a51 access` |
| `the API token cannot list accounts` | Missing *Account Settings:Read* | Add it, or set `CLOUDFLARE_ACCOUNT_ID` in `.env` by hand |
| `this account has no active zones` | The domain is not on this Cloudflare account yet | Add the site in Cloudflare and wait for it to go active |
| `no Cloudflare zone found for <host>` | Hostname is on a zone the token cannot see | Add *Zone:Read* for it, or fix the hostname |
| `could not create R2 bucket …` | R2 is not enabled on the account | Dashboard → R2 → *Get started*, then re-run |
| `wrangler is not installed` | Dependencies were never installed | `npm install` at the repository root |
| `could not create a Zero Trust organization` | Team names are globally unique and yours is taken | Set `ACCESS_TEAM_NAME` in `.env`, run `./a51 access` |
| Setup finishes with `Manual follow-ups (n)` and exit code 2 | Some steps could not complete | Each entry prints the dashboard click-path; fix and re-run `./a51 setup` |
| `unsubstituted placeholders in …wrangler.toml.template` | A template references a value not declared for that target | Add the key to the target's `vars` list in `cli/lib/wrangler.mjs` |

## Black holes

| Symptom | Cause | Fix |
|---|---|---|
| Everything returns 404, including configured paths | The hostname is not bound to the catcher | `./a51 doctor` → `./a51 black-hole add <host> http,mail` |
| An endpoint exists but still returns 404 | URI mismatch; matching is exact on `url.pathname` (case, trailing slash, no globs) | Compare the stored `uri` against the path you requested |
| A file endpoint returns 404 with `http_file_missing` in the tail | The row outlived its object (someone emptied the bucket) | Re-upload from the endpoint modal, or delete the endpoint. The modal flags this as *object missing from storage* |
| A file endpoint returns 404 with `http_file_binding_missing` | The `FILES` binding is not on the **worker** | Confirm `R2_FILES_BUCKET_NAME` in `.env`, then `./a51 deploy black-holes` |
| Requests return 403 | Your IP is on `ip_blacklist` | Remove it in Settings, then wait up to 60 minutes for the edge cache |
| A blacklist change has no effect | Blacklists are cached per data center for 60 minutes, in both directions | Wait, or accept the delay, which is deliberate |
| `http_log_insert_failed` in the tail | Transient D1 error, or a quota | Logs are best-effort by design. If it repeats, check D1 health and storage |
| A request served fine but never appeared in Requests | Same as above: the log insert is fire-and-forget | Check the tail for `http_log_insert_failed` |

## Email

| Symptom | Cause | Fix |
|---|---|---|
| Nothing arrives in Emails | Email Routing is off, or its catch-all is not pointed at the catcher | `./a51 doctor` names this; fix with `./a51 black-hole add <host> http,mail` |
| Nothing arrives, and routing looks right | The zone apex has to be the mail domain, because Email Routing catch-alls are zone-wide | Send to `*@<zone>`, not `*@<subdomain>` |
| A subdomain mail black hole captures nothing, and `doctor` says it has no MX records of its own | Email Routing was never enabled for that name, or was removed from the zone's Subdomains list | `./a51 black-hole add <host> mail` re-enables it |
| `<host> cannot capture mail until <zone> does` | You asked for `mail` on a subdomain whose zone apex is not a mail black hole. The catch-all that delivers mail is zone-scoped and only exists once the apex has it | Add the apex first: `./a51 black-hole add <zone> http,mail`, then re-run the subdomain |
| Mail to a subdomain bounces after `black-hole add … mail` reported success | DNS for the newly enabled name can take a minute to propagate | Wait, then retry. `./a51 doctor` confirms the zone catch-all still points at the catcher |
| Sender gets a bounce saying *Address not accepted* | The `From:` address is on `email_blacklist` | Remove it in Settings; up to 60 minutes to propagate |
| A row exists but the body will not load | The `EML` binding is missing on Pages, or the object is gone | `./a51 doctor`; check `npx wrangler r2 object get <bucket> emails/<id>.eml` |
| Messages land in the fallback inbox instead of the dashboard | Capture failed; look for `email_capture_failed` | The tail line carries the real error. Usually a missing R2 binding or an R2 outage |
| Nothing in the fallback inbox either, on a failed capture | `FALLBACK_ADDRESS` is empty or unverified | `./a51 doctor` reports verification state; click Cloudflare's verification link |
| `email_parse_failed` in the tail | postal-mime could not parse the message | Non-fatal: the raw `.eml` is stored and the dashboard parses it itself. Only `subject` / `attachment_count` are affected |

## Dashboard

| Symptom | Cause | Fix |
|---|---|---|
| Setup: `could not create the Pages project … [8000000] An unknown error occurred` | Creating a Pages project *with* bindings in one API call is rejected on some accounts | Fixed. Setup now creates the project bare, then attaches bindings by PATCH. Re-run `./a51 setup` |
| Dashboard serves nothing / 404 after setup, even though it deployed | Wrangler created the project as a fallback with the wrong production branch, so the deploy landed as a *preview* | Re-run `./a51 setup`, which pins `production_branch = main`, attaches bindings and redeploys to production |
| Dashboard host won't resolve; DNS points at `<name>.pages.dev` but the project is `<name>-xxxx.pages.dev` | The `*.pages.dev` name collided globally and Cloudflare suffixed it | Re-run `./a51 setup`, which reads the project's real subdomain and repoints the CNAME automatically |
| `/api/*` returns 500, or HTML instead of JSON | The D1 binding is missing on the Pages project | `./a51 doctor --fix` then `./a51 deploy dashboard` |
| Uploading a file to an endpoint returns 500 | The `FILES` binding is missing on Pages | Same fix. Bindings must exist on **Production and Preview** |
| `/api/emails/<id>/raw` returns 500 | The `EML` binding is missing on Pages | Same fix, and note this breaks *every* email body, not just Download Raw |
| Opening the dashboard shows no Access challenge | No Access application, or it targets a different hostname | `./a51 access` |
| The dashboard opens with **no login** at its `*.pages.dev` URL (but the custom domain asks for one) | The Access app guards only the custom domain, leaving the pages.dev URL an unauthenticated bypass | `./a51 doctor --fix` (or `./a51 access`) adds `*.<project>.pages.dev` to the app's destinations |
| A long-idle tab errors once, then works after a manual reload | The Access session expired | Expected: the app auto-reloads once ([dashboard.md](../internals/dashboard.md#expired-session-handling)). Raise `ACCESS_SESSION_DURATION` to make it rarer |
| The tab reloads repeatedly | Something other than our API is answering `/api/*` | The 15 s cooldown caps this, so a loop means the API is genuinely unreachable, so check the Pages deployment and bindings |
| Search misses matches | `LIKE '%term%'` is exact-substring, not fuzzy | Try a shorter or different substring |
| Timestamps look wrong | Rows store UTC; the UI renders in the browser's timezone | Check the machine's timezone |
| A code change is not visible | Browser cache, or the deploy went to a different project | Hard-refresh; confirm `PAGES_PROJECT_NAME` |
| The endpoint copy button toasts an error | No default host selected | Pick an `http`-role host on the Home tab |

## Autopilot

| Symptom | Cause | Fix |
|---|---|---|
| Every call returns 401 | Wrong secret, or none installed on the worker | `./a51 doctor` compares `.env` against the live worker; `./a51 deploy autopilot` reinstalls |
| An agent's calls 401 but curl works | The agent still has the pre-rotation secret | Re-register: `claude mcp remove autopilot` then add it again |
| `uri must start with /-/` | The agent tried to touch an endpoint outside its namespace | Working as intended. Create it in the dashboard |
| Upsert or delete refuses with a message about the dashboard | The URI is file-backed and Autopilot has no `FILES` binding | Working as intended; a human staged that payload |
| `email_raw` returns 404 for an id the agent just saw | The 60-minute window closed | Working as intended. Read it in the dashboard |
| The agent does not see new tools or guidance | MCP clients read tool descriptions at connect time | Reconnect the server, or restart the session |
| Requests / emails come back empty during an engagement | Nothing arrived in the last 60 minutes, or the black hole is not bound | Confirm with `curl -i https://<black-hole>/probe` |

## Retention

| Symptom | Cause | Fix |
|---|---|---|
| Data older than the retention window is still there | The cleanup worker is not deployed, or its cron did not fire | `./a51 status` shows deployment state; `./a51 tail cleanup` shows runs |
| Emails I need were deleted | Retention is age-based and unattended | Star messages you want kept, since starred email is exempt forever |
| `cleanup_emails_r2_failed` in the tail | A batch object delete threw | Those rows are intentionally left for the next run. Nothing is orphaned |
| The database keeps growing despite cleanup | Request bodies dominate storage, or the keep-count is high | Lower `CLEANUP_REQUESTS_KEEP` and `./a51 deploy cleanup` |
| Uploaded payloads accumulate | They are never aged out, because `endpoints` has no timestamp | Delete the endpoints, or add a lifecycle rule to the files bucket |

## Getting more detail

```bash
A51_DEBUG=1 ./a51 setup          # stack traces from the CLI
./a51 tail black-holes           # live worker logs
./a51 doctor --no-probes         # skip outbound checks if your network blocks them
```

Cloudflare-side: Workers & Pages → *worker* → Logs (persisted), D1 → *database* →
Metrics, and the Pages project's per-deployment logs for Functions.
