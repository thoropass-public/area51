# The cleanup worker, and retention

`workers/cleanup/src/index.js`, service name from `CLEANUP_WORKER_NAME`.

Its only entry point is a `scheduled()` handler. No `fetch`, no `email`, no
Custom Domain, no public surface of any kind. A cron trigger fires it on
`CLEANUP_CRON` (default `0 6 * * *`, meaning 06:00 UTC daily) and it keeps the
stores from growing without bound.

It is the unattended counterpart to `./a51 purge`
([decisions.md](../decisions.md#retention-is-a-scheduled-worker-not-a-crond-script)).

## What a run does

```
cron (CLEANUP_CRON, default 06:00 UTC daily)
   │
   ▼
scheduled(event, env, ctx)
   │
   ├─ purgeRequests(keep = CLEANUP_REQUESTS_KEEP)
   │     DELETE FROM requests
   │      WHERE id NOT IN (SELECT id FROM requests ORDER BY ts DESC LIMIT ?)
   │     → keeps the newest N rows, deletes the rest. Database only.
   │
   ├─ purgeEmails(maxAgeDays = CLEANUP_EMAIL_MAX_AGE_DAYS)
   │     1. SELECT id FROM emails WHERE ts < (now - M days) AND starred = 0
   │     2. EML.delete([...emails/<id>.eml])   batches of ≤ 1000   ← R2 first
   │     3. DELETE FROM emails WHERE id IN (...)  batches of ≤ 100 ← then D1, and
   │        only for the ids whose object delete confirmed
   │
   └─ purgeAutopilotEndpoints()      only on the days CLEANUP_AUTOPILOT_PURGE names
         1. SELECT uri, r2_key FROM endpoints WHERE uri LIKE '/-/%'
         2. FILES.delete([...r2_key])   for rows that serve a file  ← R2 first
         3. DELETE FROM endpoints WHERE uri IN (...)                ← then D1
```

Each job runs in its own try/catch and the handler never throws. A failure in one
still lets the others run, and the next day's run picks up from wherever the
stores actually are.

## Requests are trimmed by count

`id NOT IN (… ORDER BY ts DESC LIMIT N)` expresses "keep the newest N" exactly,
with no boundary or tie ambiguity. It costs one scan of `requests` per day, which
is negligible against the free read budget, and unlike a `COUNT(*)` in the UI
([decisions.md](../decisions.md#no-row-counts-anywhere-in-the-ui)) it happens
once, unattended.

Requests are high volume, uniform and own no objects, so a fixed cap behaves
predictably under a traffic spike.

## Emails are deleted by age

Objects before rows, and the row delete targets only the ids whose object delete
confirmed. A transient R2 error leaves the row in place to retry tomorrow rather
than orphaning the blob.

**Starred email is exempt.** The selection carries `AND starred = 0`, so a
starred message and its `.eml` are kept indefinitely regardless of age. Un-star
it to let a future run reclaim it. That is the mechanism for "keep this one, it
is evidence".

Email is lower volume, each message owns an object, and it is worth keeping for a
fixed investigation window, so age is the natural axis and it matches how a
manual purge is framed.

## The Autopilot purge

On the days `CLEANUP_AUTOPILOT_PURGE` names, the run also deletes **every**
endpoint under Autopilot's `/-/` prefix. Hand-written endpoints are never
touched: the prefix is the only thing it matches on.

| Value | Runs on |
|---|---|
| `off` | never. The prefix grows until `./a51 purge` clears it by hand |
| `daily` | every run |
| `weekly` | Sundays |
| `monthly` | the first Sunday of the month (default) |

**Every one of them, with no age test, because there is nothing to test
against.** The `endpoints` table has no timestamp column. Its contract is
exact-match lookup by `uri`, and adding a column to carry a periodic sweep would
be a schema migration the sweep does not need. Agent-staged stubs are engagement
scratch, and an agent restages one in a single call.

**A file an operator uploaded to a `/-/` path goes with the rest.** It is under
the prefix, so the purge takes it. A payload meant to outlive the schedule
belongs at a path outside `/-/`.

**These are date tests in code, not cron expressions**, and that is not
stylistic. In a cron field set, restricting both day-of-month and day-of-week
makes them an OR rather than an AND: `0 7 1-7 * SUN` fires on the 1st through the
7th *and* on every Sunday, which is most of the month. So the trigger stays the
ordinary daily one and the handler decides which days count.

So **every schedule rides on the daily run.** `CLEANUP_CRON` has to fire at least once a day for any of them to land on
the right date. The default does. A cron edited down to Mondays would purge on
Mondays under `weekly`, and never under `monthly`.

An unreadable value falls back to `monthly` rather than to `off`, the same way
the two integer settings fall back. A typo should not quietly disable retention,
and it should not quietly enable a delete either. The schedule that was actually
applied appears in `cleanup_started` and `cleanup_finished`.

This worker holds the `FILES` binding so it can delete an endpoint's object
before the row that points at it. That does not loosen Autopilot's fence:
Autopilot still has no `FILES` binding, which is what stops an agent reaching a
payload a human uploaded. This worker has no `fetch` handler and no domain, so
nothing can ask it for an object. It never reads the bucket and never writes to
it.

## What retention never touches

`domains`, `ip_blacklist`, `email_blacklist`, `users`, and any endpoint outside
`/-/`. Uploaded payloads outside the prefix are never aged out either. If those
accumulate, use a bucket lifecycle rule on the files bucket, or delete the
endpoints.

## Configuration

| Value | `.env` key | Default |
|---|---|---|
| Requests retained | `CLEANUP_REQUESTS_KEEP` | `1000` |
| Email max age (days) | `CLEANUP_EMAIL_MAX_AGE_DAYS` | `90` |
| Autopilot purge schedule | `CLEANUP_AUTOPILOT_PURGE` | `monthly` |
| Run schedule (UTC cron) | `CLEANUP_CRON` | `0 6 * * *` |

The first three are substituted into `wrangler.toml` as `[vars]`, the fourth as
the cron trigger. Change them in `.env` and redeploy:

```bash
./a51 deploy cleanup
```

Every value arrives as a string and is parsed with a fallback, so a malformed one
degrades to the default rather than deleting everything or nothing.
`CLEANUP_AUTOPILOT_PURGE` is optional: a `.env` without it renders an empty value
and the worker uses `monthly`.

Deploying is the entire setup. No secret, no domain, no dashboard clicks. Confirm
the trigger landed under **Workers → *cleanup worker* → Settings → Triggers**.

## Watching it

Stream a run live, or read the worker's Logs in the Cloudflare dashboard:

```bash
npx wrangler tail area51-cleanup
```

| Event | When |
|---|---|
| `cleanup_started` | top of the run, with the resolved `keep`, `maxAgeDays` and `purgeSchedule` |
| `cleanup_requests_done` | requests trim finished (`{keep, deleted}`) |
| `cleanup_emails_done` | emails purge finished (`{cutoff, matched, r2_deleted, d1_deleted, r2_failed}`) |
| `cleanup_emails_r2_failed` | a batch object delete threw, so those ids are left for the next run |
| `cleanup_autopilot_done` | `/-/` purge finished (`{matched, files, r2_deleted, d1_deleted, r2_failed}`) |
| `cleanup_autopilot_r2_failed` | a batch file delete threw, so those rows are left for the next run |
| `cleanup_requests_failed` / `cleanup_emails_failed` / `cleanup_autopilot_failed` | one job threw and was caught, the others still ran |
| `cleanup_finished` | end of run, with `purgeToday` and a combined summary |

## Acting between runs

The worker has no `fetch` handler, so the cron is its only trigger and there is
no way to invoke it on demand.

Use `./a51 purge` instead. It covers the same ground interactively, behind a
typed confirmation: requests and emails by age with their R2 objects in lockstep,
and every `/-/` endpoint with its uploaded files. It is a different code path to
the same outcome.

## Sizing it

- Free-plan limits are 500 MB of D1 and 10 GB of R2. `./a51 status` shows your
  thresholds, the Cloudflare dashboard shows actual usage.
- 1000 request rows is small, a few MB at most depending on captured bodies.
  Raise it if you want longer history and you are nowhere near the limit, and
  think about raising it before a noisy engagement rather than after.
- 90 days of email is usually the binding constraint, because each message
  carries its attachments. If you capture heavy mail, lower the age and star
  what matters.
