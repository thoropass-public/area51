CREATE TABLE IF NOT EXISTS endpoints (
  uri TEXT PRIMARY KEY,
  status INTEGER NOT NULL DEFAULT 200,
  headers TEXT,
  body TEXT
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
-- D1 holds only what the list view, quick preview, search, and Autopilot need.
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
  text TEXT,                            -- plain-text body: preview + search + Autopilot
  attachment_count INTEGER NOT NULL DEFAULT 0
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
-- Seeded at deploy from .env's DOMAINS_CONFIG; edit with `wrangler d1 execute`.
CREATE TABLE IF NOT EXISTS domains (
  domain TEXT PRIMARY KEY,
  roles TEXT NOT NULL       -- JSON array, subset of ["http","mail"]
);
