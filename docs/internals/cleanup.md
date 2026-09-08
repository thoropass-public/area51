# The cleanup worker, and retention

`workers/cleanup/src/index.js`, service name from `CLEANUP_WORKER_NAME`. Its only
entry point is a `scheduled()` handler: no `fetch`, no `email`, no Custom Domain.
A cron trigger in its config fires it once a day (`CLEANUP_CRON`, default
`0 6 * * *`, meaning 06:00 UTC) and it trims the two append-only logs so neither the
database nor the request log grows without bound.

It is the unattended counterpart to `./a51 purge`
([decisions.md](../decisions.md#retention-is-a-scheduled-worker-not-a-crond-script)).

## What a run does

```
cron (06:00 UTC daily)
   │
   ▼
scheduled(event, env, ctx)
   │
   ├─ purgeRequests(keep = CLEANUP_REQUESTS_KEEP)
   │     DELETE FROM requests
   │      WHERE id NOT IN (SELECT id FROM requests ORDER BY ts DESC LIMIT ?)
   │     → keeps the newest N rows; deletes the rest. Database only.
   │
   └─ purgeEmails(maxAgeDays = CLEANUP_EMAIL_MAX_AGE_DAYS)
         1. SELECT id FROM emails WHERE ts < (now - M days) AND starred = 0
         2. EML.delete([...emails/<id>.eml])   in batches of ≤ 1000 keys   ← R2 first
         3. DELETE FROM emails WHERE id IN (...)  in batches of ≤ 100      ← then D1,
            and only for the ids whose object delete succeeded
```

**Requests are trimmed by count.** `id NOT IN (… ORDER BY ts DESC LIMIT N)`
expresses "keep the newest N" exactly, with no boundary or tie ambiguity. It
costs one scan of `requests` per day, which is negligible against the free read
budget. And unlike a UI `COUNT(*)`
([decisions.md](../decisions.md#no-row-counts-anywhere-in-the-ui)) it happens once,
unattended.

**Emails are deleted by age**, objects before rows, and the row delete targets
only the ids whose object delete confirmed. A transient R2 error therefore leaves
the row in place to retry tomorrow instead of orphaning the blob.

**Starred email is exempt.** The selection carries `AND starred = 0`, so a starred
message and its `.eml` are kept indefinitely regardless of age. Un-star it to let
a future run reclaim it. That is the mechanism for "keep this one, it is evidence".

**What it never touches:** `endpoints` (including the Autopilot `/-/*` namespace),
the endpoint-files bucket, `domains`, `ip_blacklist`, `email_blacklist`. Retention
is scoped to the two logs that grow on their own.

Each table is purged inside its own try/catch and the handler never throws: a
failure in one still lets the other run, and the next day's run simply picks up
from the current state.

Why count for requests but age for emails: requests are high-volume, uniform and
cheap (no objects), so a fixed cap is predictable under traffic spikes. Emails are
lower-volume, each owns an object, and are worth keeping for a fixed
investigation window, so age is the natural axis there, and it matches how manual purges
are framed.

## Configuration

| Value | `.env` key | Default |
|---|---|---|
| Requests retained | `CLEANUP_REQUESTS_KEEP` | `1000` |
| Email max age (days) | `CLEANUP_EMAIL_MAX_AGE_DAYS` | `90` |
| Schedule (UTC cron) | `CLEANUP_CRON` | `0 6 * * *` |

All three are substituted into `wrangler.toml` at deploy time: the thresholds as
`[vars]`, the schedule as the cron trigger. Change them in `.env` and:

```bash
./a51 deploy cleanup
```

The thresholds arrive as strings and are parsed with a non-negative-integer
fallback (`1000` / `90`), so a malformed value degrades to the default rather than
deleting everything or nothing.

Deploying is the entire setup: no secret, no domain, no dashboard clicks. Confirm
the trigger landed under **Workers → *cleanup worker* → Settings → Triggers**.

## Watching it

Read the worker's Logs in the Cloudflare dashboard (Workers & Pages → *worker* →
Logs), or stream a run live:

```bash
npx wrangler tail area51-cleanup
```

| Event | When |
|---|---|
| `cleanup_started` | top of the run, with the resolved `keep` / `maxAgeDays` |
| `cleanup_requests_done` | requests trim finished (`{keep, deleted}`) |
| `cleanup_emails_done` | emails purge finished (`{cutoff, matched, r2_deleted, d1_deleted, r2_failed}`) |
| `cleanup_emails_r2_failed` | a batch object delete threw, so those ids are left for the next run |
| `cleanup_requests_failed` / `cleanup_emails_failed` | one table's purge threw (caught; the other still runs) |
| `cleanup_finished` | end of run, combined summary |

Runs are also visible in the Cloudflare dashboard under the worker's Logs.

## Acting on retention between runs

The worker has no `fetch` handler, so the cron is its only trigger. There is no
way to invoke it on demand, and the local dev server that used to fake one has
been removed.

Use `./a51 purge` instead. It covers the same ground interactively: requests and
emails by age, with the R2 objects deleted in lockstep, behind a typed
confirmation. It is not the same code path, but it is the same outcome, and it
does the coupled email delete correctly.

To confirm the scheduled run itself is happening, watch a real one in the
worker's Logs, or:

```bash
npx wrangler tail area51-cleanup
```

`cleanup_started` and `cleanup_finished` bracket every run, and the trigger is
visible under **Workers → *cleanup worker* → Settings → Triggers**.

## Sizing it

- Free-plan limits: 500 MB of D1, 10 GB of R2. `./a51 status` shows your current
  thresholds; the Cloudflare dashboard shows actual usage.
- 1000 request rows is small (a few MB at most, depending on captured bodies).
  Raise it if you want longer history and you are nowhere near the limit.
- 90 days of email is usually the binding constraint, because each message
  carries its attachments. If you capture heavy mail, lower the age *and* star
  what matters.
- Uploaded endpoint payloads are **never** aged out. If those accumulate, use a
  bucket lifecycle rule on the files bucket, or delete the endpoints.
