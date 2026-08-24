-- AREA 51 — D1 schema.
--
-- Applied by `./a51 setup` (statement by statement, over the D1 HTTP API) and
-- re-applied by `./a51 doctor --fix`. Every statement is `IF NOT EXISTS`, so
-- running it against a live database is safe and never drops data.
--
-- Six tables, one R2 bucket for captured email, one R2 bucket for endpoint file
-- uploads. Full column-by-column reference: docs/reference/database.md.

-- ─── endpoints ──────────────────────────────────────────────────────────────
-- The map of `URI path -> response` the Black Holes worker serves. Matching is
-- exact on url.pathname; there are no globs or path parameters.
--
-- A row is either TEXT-backed (status / headers / body authored in the
-- dashboard) or FILE-backed (an upload streamed to the endpoint-files R2
-- bucket). `r2_key IS NULL` is the discriminator. For a file-backed row the
-- response is owned by the server: status is 200, headers hold the detected
-- Content-Type, body is '' — a file cannot be mixed with a hand-written body
-- or a custom status.
CREATE TABLE IF NOT EXISTS endpoints (
  uri TEXT PRIMARY KEY,
  status INTEGER NOT NULL DEFAULT 200,
  headers TEXT,            -- JSON object, stringified: {"Header-Name": "value"}
  body TEXT,
  r2_key TEXT,             -- R2 object key (random UUID); NULL = text endpoint
  filename TEXT            -- original upload filename, display only
);

-- ─── requests ───────────────────────────────────────────────────────────────
-- Every HTTP request that reaches a black hole. Written fire-and-forget by the
-- worker (ctx.waitUntil), so a failed insert costs a log line, not a response.
CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY,     -- UUIDv4, generated in the worker
  ts TEXT NOT NULL,        -- ISO 8601 UTC
  method TEXT NOT NULL,
  url TEXT NOT NULL,       -- full URL including scheme, host, path and query
  ip TEXT,                 -- cf-connecting-ip, or 'unknown'
  ua TEXT,                 -- user-agent, or 'unknown'
  headers TEXT,            -- JSON object, stringified
  body TEXT                -- raw body as text; read errors store ''
);
CREATE INDEX IF NOT EXISTS idx_requests_ts ON requests(ts DESC);

-- ─── emails ─────────────────────────────────────────────────────────────────
-- A lean index row per captured email. The full message — every header, both
-- bodies, attachment bytes — lives only in the raw .eml in R2 at
-- emails/<id>.eml. There is deliberately NO body column: the dashboard and
-- Autopilot both read the body from R2 on demand.
--
-- Capture is all-or-nothing: a row exists here only when its R2 object also
-- exists. On any capture error the worker rolls back both and forwards the
-- original to the fallback inbox, so there are never partial or marker rows.
CREATE TABLE IF NOT EXISTS emails (
  id TEXT PRIMARY KEY,     -- UUIDv4; also the R2 key (emails/<id>.eml)
  ts TEXT NOT NULL,        -- ISO 8601 UTC
  from_addr TEXT NOT NULL, -- the From: header address; '' if unparseable
  to_addr TEXT NOT NULL,   -- envelope recipient
  subject TEXT,
  attachment_count INTEGER NOT NULL DEFAULT 0,
  -- Per-email UI state. Written ONLY by the dashboard (PATCH /api/emails/...).
  -- The capture worker inserts the defaults and never sets them; Autopilot is
  -- read-only and can never change them. Starred email is exempt from the
  -- cleanup worker's age-based retention.
  read INTEGER NOT NULL DEFAULT 0,
  starred INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_emails_ts ON emails(ts DESC);

-- ─── blacklists ─────────────────────────────────────────────────────────────
-- Write filters consulted by the worker before it stores anything. Exact match
-- only: no CIDR ranges, no patterns. The worker caches each list for 60 minutes
-- per data centre, so dashboard changes take up to an hour to fully propagate.
--
-- An IP hit answers 403 and stores nothing. An email hit rejects the message at
-- SMTP level (the sender gets a bounce) and stores nothing.
CREATE TABLE IF NOT EXISTS ip_blacklist (
  ip TEXT PRIMARY KEY,
  ts TEXT NOT NULL,        -- when it was added (ISO 8601 UTC)
  note TEXT                -- optional human label, e.g. 'shodan scanner'
);

CREATE TABLE IF NOT EXISTS email_blacklist (
  email TEXT PRIMARY KEY,  -- stored lowercase
  ts TEXT NOT NULL,
  note TEXT
);

-- ─── domains ────────────────────────────────────────────────────────────────
-- The configured black holes, and the single source of truth for them. Read
-- live by the dashboard (/api/config/domains, for the Home host picker) and by
-- the Autopilot worker (so an agent can build https://<domain>/-/<path>).
--
-- Managed with `./a51 domains add|remove|list`; changes take effect on the next
-- page load or agent call, with no redeploy.
CREATE TABLE IF NOT EXISTS domains (
  domain TEXT PRIMARY KEY,
  roles TEXT NOT NULL      -- JSON array, subset of ["http","mail"]
);
