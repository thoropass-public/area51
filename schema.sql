-- Endpoints are either TEXT-backed (status/headers/body authored in the
-- dashboard) or FILE-backed (an upload streamed to the area51-files R2 bucket).
-- `r2_key IS NULL` is the discriminator. For a file-backed row the response is
-- owned by the server: status is 200, headers hold the detected Content-Type,
-- body is '' — a file can't be mixed with a hand-written body or status.
CREATE TABLE IF NOT EXISTS endpoints (
  uri TEXT PRIMARY KEY,
  status INTEGER NOT NULL DEFAULT 200,
  headers TEXT,
  body TEXT,
  r2_key TEXT,             -- R2 object key (random UUID) in area51-files; NULL = text endpoint
  filename TEXT            -- original upload filename, display only
);

CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  method TEXT NOT NULL,
  url TEXT NOT NULL,
  ip TEXT,
  ua TEXT,
  headers TEXT,
  body TEXT
);
CREATE INDEX IF NOT EXISTS idx_requests_ts ON requests(ts DESC);

-- Emails are stored lean in D1; the full raw .eml lives in R2 at emails/<id>.eml.
-- D1 holds only what the list view, search, and Autopilot need — NOT the body.
-- Both the dashboard and Autopilot read the body (plain-text OR HTML) from the
-- raw .eml in R2 on demand; there is no body column here.
-- Capture is all-or-nothing: a row exists here only when its R2 object also
-- exists. On any capture error the worker rolls back both and forwards the
-- original to the fallback inbox, so there are never partial/marker rows.
DROP TABLE IF EXISTS emails;
CREATE TABLE emails (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  from_addr TEXT NOT NULL,
  to_addr TEXT NOT NULL,
  subject TEXT,
  attachment_count INTEGER NOT NULL DEFAULT 0,
  -- Per-email UI state. Both default to 0 (unread / unstarred) and are written
  -- ONLY by the dashboard (PATCH /api/emails/<id>). The capture worker inserts
  -- with the defaults and never sets them; Autopilot/MCP is read-only and can
  -- never change them. `starred` backs the dashboard's :star: filter.
  read INTEGER NOT NULL DEFAULT 0,
  starred INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_emails_ts ON emails(ts DESC);

-- Write-filter blacklists. Worker reads these before storing a request or email
-- and silently drops the D1 write on a match. Exact-match only; no patterns.
-- Email address is stored lowercase.

CREATE TABLE IF NOT EXISTS ip_blacklist (
  ip TEXT PRIMARY KEY,
  ts TEXT NOT NULL,        -- when added (ISO 8601 UTC)
  note TEXT                -- optional human label (e.g. "shodan scanner")
);

CREATE TABLE IF NOT EXISTS email_blacklist (
  email TEXT PRIMARY KEY,  -- stored lowercase
  ts TEXT NOT NULL,
  note TEXT
);

-- Configured black hole domains. Single source of truth (replaces the old
-- DOMAINS_CONFIG Pages env var): read live by the dashboard's
-- /api/config/domains (Home orbit chips) and by the Autopilot worker (so an
-- agent can build full callback URLs like https://<domain>/-/<path>).
-- Not seeded automatically — populate/edit it directly with `wrangler d1 execute`
-- (see README §8 Step 8); changes take effect on the next page load / agent call.
CREATE TABLE IF NOT EXISTS domains (
  domain TEXT PRIMARY KEY,
  roles TEXT NOT NULL       -- JSON array, subset of ["http","mail"]
);
