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
  raw_eml TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_emails_ts ON emails(ts DESC);
