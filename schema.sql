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

CREATE TABLE IF NOT EXISTS emails (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  from_addr TEXT NOT NULL,
  to_addr TEXT NOT NULL,
  subject TEXT,
  headers TEXT,        -- JSON-stringified array [{key, value}, ...] from postal-mime
  text TEXT,           -- postal-mime parsed.text (plain body); NULL on fallback rows
  html TEXT,           -- postal-mime parsed.html (rendered body); literal "sent_to_fallback" on fallback rows
  attachments TEXT     -- JSON-stringified [{filename, mime, size}, ...]; metadata only, no content bytes
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
