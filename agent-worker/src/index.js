// Autopilot worker.
//
// The REST + MCP server that authorized Claude Code / Codex agents talk to
// during pentests. Bound to its own Cloudflare Custom Domain (configured
// manually in the dashboard; see the deploy script + README). Separate from
// the Black Holes worker so it can be locked behind a shared secret without
// affecting the black holes' public reachability.
//
// Surfaces recent captures from the same D1 database AREA 51 reads, plus
// CRUD over the reserved /-/* endpoint URI namespace.
//
// Endpoints:
//   GET    /requests                     →  last 60 minutes of `requests` rows
//   GET    /emails                       →  last 60 minutes of `emails`   rows
//   GET    /emails/<id>/raw              →  raw .eml from R2 (hard 60-min check)
//   GET    /domains                      →  configured black holes (for URL building)
//   GET    /autopilot/endpoints          →  list all endpoints under /-/*
//   POST   /autopilot/endpoints          →  upsert (body: {uri, status, headers, body})
//   GET    /autopilot/endpoints/<uri>    →  read one
//   DELETE /autopilot/endpoints/<uri>    →  delete one
//
//   POST   /mcp                          →  MCP (JSON-RPC 2.0 over HTTP)
//
// MCP tools exposed:
//   requests_recent_1hr
//   emails_recent_1hr
//   email_raw  (explicit, on-demand: full raw .eml for one recent email)
//   list_black_holes  (configured domains, for building https://<domain>/-/...)
//   autopilot_endpoints_list
//   autopilot_endpoints_get
//   autopilot_endpoints_upsert
//   autopilot_endpoints_delete
//
// Every request must include `X-A51-Secret: <secret>` (matched against the
// AGENT_SECRET worker secret in constant time). 401 otherwise.
//
// The /-/* prefix on managed endpoint URIs is hardcoded server-side
// and cannot be widened by the client. Any CRUD call referencing a URI that
// doesn't start with /-/ returns 400.
//
// No edge caching. Every call hits D1 directly. (Earlier versions of this
// worker cached the read responses for 60s; removed because agents polling
// during active engagements want freshness over read-cost optimization.)

const WINDOW_MINUTES = 60;
const WINDOW_MS = WINDOW_MINUTES * 60 * 1000;
const AUTOPILOT_PREFIX = '/-/';

const log = (event, fields = {}) => {
  try { console.log(JSON.stringify({ event, ...fields })); } catch { /* never crash on logging */ }
};
const logErr = (event, fields = {}) => {
  try { console.error(JSON.stringify({ event, ...fields })); } catch { /* never crash on logging */ }
};

// Constant-time string comparison to avoid leaking length / prefix info via
// response timing. Returns true iff the two strings are byte-identical.
function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

function authOk(request, env) {
  const provided = request.headers.get('x-a51-secret') || '';
  const expected = env.AGENT_SECRET || '';
  if (!expected) return false;
  return constantTimeEqual(provided, expected);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}

function errResp(message, status) {
  return json({ error: message }, status);
}

function isAutopilotUri(uri) {
  return typeof uri === 'string' && uri.startsWith(AUTOPILOT_PREFIX) && uri.length > AUTOPILOT_PREFIX.length;
}

// ----- /requests and /emails handlers (no cache) -----

async function handleRequests(env) {
  const cutoff = new Date(Date.now() - WINDOW_MS).toISOString();
  const t0 = Date.now();
  const { results } = await env.DB.prepare(
    'SELECT id, ts, method, url, ip FROM requests WHERE ts >= ? ORDER BY ts DESC'
  ).bind(cutoff).all();
  log('agent_d1_requests', { rows: (results || []).length, duration_ms: Date.now() - t0 });
  return json({
    served_at: new Date().toISOString(),
    window_minutes: WINDOW_MINUTES,
    rows: results || [],
  });
}

async function handleEmails(env) {
  const cutoff = new Date(Date.now() - WINDOW_MS).toISOString();
  const t0 = Date.now();
  const { results } = await env.DB.prepare(
    'SELECT id, ts, from_addr, to_addr, subject FROM emails WHERE ts >= ? ORDER BY ts DESC'
  ).bind(cutoff).all();
  log('agent_d1_emails', { rows: (results || []).length, duration_ms: Date.now() - t0 });
  return json({
    served_at: new Date().toISOString(),
    window_minutes: WINDOW_MINUTES,
    rows: results || [],
  });
}

// ----- raw .eml fetch (hard freshness gate) -----
//
// Returns the verbatim raw .eml from R2, but ONLY if the email is within the
// same 60-minute window the read tools expose. The gate is enforced in D1,
// never trusted from the caller: an id older than the window or unknown simply
// won't match the SELECT, so the object is never fetched. Knowing an old id is
// not enough. (Every D1 row has a matching R2 object — capture is all-or-nothing.)
async function handleEmailRaw(env, id) {
  if (!id || typeof id !== 'string') return errResp('id is required', 400);
  const cutoff = new Date(Date.now() - WINDOW_MS).toISOString();
  const row = await env.DB.prepare(
    'SELECT id FROM emails WHERE id = ? AND ts >= ?'
  ).bind(id, cutoff).first();
  if (!row) {
    log('agent_email_raw_denied', { id });
    return errResp('Email not available: outside the last 60 minutes or unknown', 404);
  }
  const obj = await env.EML.get(`emails/${id}.eml`);
  if (!obj) {
    log('agent_email_raw_missing', { id });
    return errResp('Raw email object not found', 404);
  }
  log('agent_email_raw_ok', { id });
  return new Response(obj.body, {
    status: 200,
    headers: {
      'Content-Type': 'message/rfc822',
      'Content-Disposition': `attachment; filename="${id}.eml"`,
      'Cache-Control': 'no-store',
    },
  });
}

// ----- configured black holes -----
//
// Reads the same D1 `domains` table the dashboard's /api/config/domains
// serves, so the agent can build full callback URLs (https://<domain>/-/...).
async function handleDomains(env) {
  const ALLOWED = new Set(['http', 'mail']);
  const { results } = await env.DB.prepare(
    'SELECT domain, roles FROM domains ORDER BY domain ASC'
  ).all();
  const domains = (results || [])
    .map((r) => {
      let roles = [];
      try { roles = JSON.parse(r.roles); } catch { roles = []; }
      if (!Array.isArray(roles)) roles = [];
      return {
        domain: String(r.domain || '').trim(),
        roles: roles.filter((x) => typeof x === 'string' && ALLOWED.has(x.toLowerCase())).map((x) => x.toLowerCase()),
      };
    })
    .filter((d) => d.domain.length > 0);
  return json({ served_at: new Date().toISOString(), endpoint_prefix: AUTOPILOT_PREFIX, domains });
}

// ----- /autopilot/endpoints CRUD -----

function parseHeaderLines(raw) {
  const out = {};
  if (!raw || typeof raw !== 'string') return out;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue;
    const key = trimmed.slice(0, colonIdx).trim();
    const value = trimmed.slice(colonIdx + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

// Shape one endpoints row for an agent. A file-backed row (r2_key set) serves an
// uploaded object rather than the `body` column, so it reports a `file`
// descriptor — otherwise an agent would read the empty body as "this endpoint
// returns nothing" and be wrong. Autopilot has no FILES binding: it can see that
// a file is being served and its type, but never reads, replaces, or deletes it.
function shapeEndpointRow(r) {
  let headers = {};
  try { headers = r.headers ? JSON.parse(r.headers) : {}; } catch { headers = {}; }
  const out = { uri: r.uri, status: r.status, headers, body: r.body || '' };
  if (r.r2_key) {
    out.file = {
      filename: r.filename || '',
      content_type: headers['Content-Type'] || headers['content-type'] || '',
    };
  }
  return out;
}

async function autopilotList(env) {
  // LIKE '/-/%' uses the endpoints PK (uri) index for range matching.
  const { results } = await env.DB.prepare(
    "SELECT uri, status, headers, body, r2_key, filename FROM endpoints WHERE uri LIKE '/-/%' ORDER BY uri ASC"
  ).all();
  // Parse headers JSON back into objects on the way out so agents don't have
  // to do it themselves.
  return json({ rows: (results || []).map(shapeEndpointRow) });
}

async function autopilotGet(env, uri) {
  if (!isAutopilotUri(uri)) return errResp('uri must start with /-/', 400);
  const row = await env.DB.prepare(
    'SELECT uri, status, headers, body, r2_key, filename FROM endpoints WHERE uri = ?'
  ).bind(uri).first();
  if (!row) return errResp('Not found', 404);
  return json(shapeEndpointRow(row));
}

// A file-backed endpoint was staged by a human through the dashboard, and
// Autopilot can neither upload a replacement nor delete the R2 object it would
// orphan. Both write paths therefore refuse rather than destroy that work.
async function guardFileBacked(env, uri, verb) {
  const row = await env.DB.prepare('SELECT r2_key FROM endpoints WHERE uri = ?').bind(uri).first();
  if (row && row.r2_key) {
    log('autopilot_file_backed_refused', { uri, verb });
    // The message is the agent's only feedback here, so it says what to do
    // next rather than just refusing.
    return errResp(
      `${uri} serves an uploaded file, which can only be ${verb} from the AREA 51 ` +
      `dashboard (Endpoints → open ${uri}). Ask the operator to make the change and ` +
      `confirm it back to you; file uploads are supported, they are just a human action.`,
      400
    );
  }
  return null;
}

async function autopilotUpsert(env, payload) {
  const uri = (payload && payload.uri) || '';
  const status = (payload && payload.status);
  const rawHeaders = (payload && payload.headers);
  const body = (payload && payload.body) || '';

  if (!isAutopilotUri(uri)) return errResp('uri must start with /-/', 400);
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 100 || status > 599) {
    return errResp('status must be an integer between 100 and 599', 400);
  }

  // Accept headers as either an object {Key: Value} or a line-separated string
  // (the dashboard sends the latter; agents will usually send the former).
  let headersObj = {};
  if (rawHeaders && typeof rawHeaders === 'object' && !Array.isArray(rawHeaders)) {
    for (const [k, v] of Object.entries(rawHeaders)) {
      if (typeof k === 'string' && k && (typeof v === 'string' || typeof v === 'number')) {
        headersObj[k] = String(v);
      }
    }
  } else if (typeof rawHeaders === 'string') {
    headersObj = parseHeaderLines(rawHeaders);
  }
  const headersJson = JSON.stringify(headersObj);
  const bodyText = typeof body === 'string' ? body : '';

  const blocked = await guardFileBacked(env, uri, 'replaced');
  if (blocked) return blocked;

  await env.DB.prepare(
    `INSERT INTO endpoints (uri, status, headers, body)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(uri) DO UPDATE SET
       status = excluded.status,
       headers = excluded.headers,
       body = excluded.body`
  ).bind(uri, status, headersJson, bodyText).run();

  log('autopilot_upsert', { uri, status });
  return json({ ok: true, uri });
}

async function autopilotDelete(env, uri) {
  if (!isAutopilotUri(uri)) return errResp('uri must start with /-/', 400);
  const blocked = await guardFileBacked(env, uri, 'deleted');
  if (blocked) return blocked;
  const result = await env.DB.prepare('DELETE FROM endpoints WHERE uri = ?').bind(uri).run();
  if (!result.meta || result.meta.changes === 0) return errResp('Not found', 404);
  log('autopilot_delete', { uri });
  return json({ ok: true });
}

// ----- MCP handler -----
//
// MCP JSON-RPC 2.0 over HTTP. Methods:
//   initialize, notifications/initialized, tools/list, tools/call, ping.

const MCP_TOOLS = [
  {
    name: 'requests_recent_1hr',
    description: [
      "Returns HTTP requests captured by the Black Holes",
      "in the last 60 minutes. Use this during authorized pentests to detect",
      "out-of-band callbacks — e.g., to confirm whether an SSRF, XXE, blind",
      "command-injection, or other interaction-based payload has triggered a",
      "callback to one of our black-hole domains. The result is JSON: an",
      "object with `served_at` (ISO timestamp), `window_minutes` (60), and",
      "`rows` (an array of {id, ts, method, url, ip} objects, newest first).",
      "Data is live (no server-side cache). No parameters; the window is",
      "fixed server-side and cannot be widened.",
    ].join(' '),
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'emails_recent_1hr',
    description: [
      "Returns emails received by the Black Holes",
      "in the last 60 minutes. Use this during authorized pentests to",
      "detect email-based out-of-band callbacks — e.g., to confirm an",
      "email-injection or password-reset-redirect payload triggered delivery",
      "to a controlled address. The result is JSON: an object with",
      "`served_at`, `window_minutes` (60), and `rows` (an array of",
      "{id, ts, from_addr, to_addr, subject} objects, newest first).",
      "IMPORTANT: rows carry envelope metadata ONLY — there is NO body,",
      "headers, or attachment content here. To read an email's body (plain",
      "text or HTML), full headers, or attachments, call email_raw with the",
      "row's id (subject-line and recipient are usually enough to spot a",
      "callback; fetch the raw .eml only when you need the contents). Data is",
      "live (no server-side cache). No parameters.",
    ].join(' '),
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'email_raw',
    description: [
      "Fetches the full raw .eml source for one captured email by id. This is",
      "the ONLY way to read an email's body — emails_recent_1hr returns just",
      "envelope metadata (from/to/subject), never body content. Call this when",
      "you need the plain-text body, the HTML body, the full headers, or to",
      "inspect/extract attachments. Still, don't fetch it for every row during",
      "routine polling — the subject and recipient from emails_recent_1hr are",
      "usually enough to spot a callback; pull the raw .eml only for the ones",
      "whose contents you actually need. The id must come from emails_recent_1hr",
      "and must still be within the 60-minute window — the server hard-checks",
      "freshness and refuses anything older or unknown. Returns the verbatim",
      "RFC-822 message (headers + plain-text and/or HTML bodies + base64-encoded",
      "attachment parts); parse it as MIME to extract parts.",
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: "Email id from emails_recent_1hr. Must be within the last 60 minutes." },
      },
      required: ['id'],
    },
  },
  {
    name: 'list_black_holes',
    description: [
      "Lists the configured black hole domains and their roles (http and/or",
      "mail). Use this to construct a full callback URL for an autopilot",
      "endpoint: pick a domain whose roles include \"http\", create the endpoint",
      "with autopilot_endpoints_upsert (its uri must start with /-/), then hand",
      "out https://<domain><uri> — e.g. https://example.com/-/1. The same URL",
      "shape works for a file-backed endpoint an operator uploaded in the",
      "dashboard: list it with autopilot_endpoints_list and hand out",
      "https://<domain><uri> to serve that file. The response",
      "also includes `endpoint_prefix` (\"/-/\") for reference. No parameters.",
    ].join(' '),
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'autopilot_endpoints_list',
    description: [
      "Lists all configured endpoints under /-/*. Use this to see",
      "what response stubs the Black Holes are currently serving for",
      "autopilot paths. Returns JSON: {rows: [{uri, status, headers, body}, ...]}.",
      "A row that also carries a `file` object ({filename, content_type}) serves",
      "an uploaded file rather than its `body` — the body is empty for those, and",
      "they can only be changed from the AREA 51 dashboard. Check here first when",
      "you need a file served: the operator may already have uploaded one, in",
      "which case you just hand out its URL instead of asking for another.",
      "Only endpoints with URIs starting with /-/ are returned;",
      "manually-defined endpoints outside that prefix are not visible. No",
      "parameters.",
    ].join(' '),
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'autopilot_endpoints_get',
    description: [
      "Returns the configured response stub for a single /-/* URI.",
      "Use this to inspect what a particular autopilot endpoint is set to",
      "return. The `uri` argument must start with /-/ — otherwise",
      "the call returns an error. Result is JSON: {uri, status, headers, body}.",
      "If the result also carries a `file` object ({filename, content_type}),",
      "the endpoint serves an uploaded file: the bytes are in object storage, so",
      "`body` is empty by design, and the URL still responds 200 with that",
      "content type. File-backed endpoints are read-only here — they can only be",
      "changed from the AREA 51 dashboard.",
      "Returns 404-equivalent error if the URI is not configured.",
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        uri: {
          type: 'string',
          description: "Endpoint URI to read. Must start with /-/",
        },
      },
      required: ['uri'],
    },
  },
  {
    name: 'autopilot_endpoints_upsert',
    description: [
      "Creates or updates an endpoint configuration under /-/*. Use",
      "this to set the response the Black Holes worker will serve when a",
      "target calls a specific /-/* path during a pentest — e.g., stage a",
      "fake OAuth callback, a malicious .well-known file, or any other",
      "controlled response. Upsert semantics: if the URI already exists, its",
      "status / headers / body are overwritten.",
      "",
      "The `uri` MUST start with /-/ — any other prefix returns an",
      "error. `status` is an integer 100–599. `headers` is an object",
      "(key→value strings). `body` is a string (any text or base64-encoded",
      "binary; the worker serves it verbatim).",
      "",
      "Use this for anything expressible as TEXT — HTML, JSON, XML, JavaScript,",
      "a DTD, an SVG, a .well-known document — by setting the Content-Type",
      "header and putting the content in `body`. Do NOT base64 a binary into",
      "`body`: the worker serves that column verbatim, so the target would get",
      "base64 text rather than a file. To serve a real file (binary, archive,",
      "image, PDF, anything you cannot type out), ask the operator to create a",
      "file-backed endpoint — AREA 51 → Endpoints → New endpoint → attach the",
      "file under FILE — and to confirm the path back to you.",
      "",
      "If the URI already serves an uploaded file (its row carries a `file`",
      "object), this call is refused — a human staged that file through the",
      "dashboard and only the dashboard can replace or remove it.",
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        uri: { type: 'string', description: "Endpoint URI. Must start with /-/" },
        status: { type: 'integer', minimum: 100, maximum: 599, description: "HTTP status code to return" },
        headers: { type: 'object', description: "Response headers as a key→value object", additionalProperties: { type: 'string' } },
        body: { type: 'string', description: "Response body (any text)" },
      },
      required: ['uri', 'status'],
    },
  },
  {
    name: 'autopilot_endpoints_delete',
    description: [
      "Deletes an /-/* endpoint configuration. The Black Holes worker",
      "will start returning 404 for that URI immediately on the next request.",
      "The `uri`",
      "must start with /-/ — otherwise the call returns an error.",
      "Returns success on delete; 404-equivalent error if the URI was not",
      "configured. Endpoints that serve an uploaded file are refused — delete",
      "those from the AREA 51 dashboard so the stored object goes with them.",
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        uri: { type: 'string', description: "Endpoint URI to delete. Must start with /-/" },
      },
      required: ['uri'],
    },
  },
];

function jsonRpcResult(id, result) {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
function jsonRpcError(id, code, message) {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Reads the JSON payload from a Response (built by one of our handlers) so
// we can wrap it in an MCP `tools/call` response without re-querying D1.
async function responseToMcpText(resp) {
  const text = await resp.text();
  return { content: [{ type: 'text', text }] };
}

async function handleMcp(request, env) {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }
  let msg;
  try {
    msg = await request.json();
  } catch {
    return jsonRpcError(null, -32700, 'Parse error');
  }
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') {
    return jsonRpcError(msg && msg.id != null ? msg.id : null, -32600, 'Invalid Request');
  }
  log('mcp_request', { method: msg.method, id: msg.id });

  switch (msg.method) {
    case 'initialize':
      return jsonRpcResult(msg.id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'autopilot', version: '1.3.0' },
        instructions: [
          "Autopilot is Thoropass's MCP interface to its internal callback",
          "infrastructure. Targets visit attacker-controlled 'black hole'",
          "domains during pentests; every HTTP request and every email sent",
          "to those domains is captured in a shared database. Use the",
          "requests_recent_1hr and emails_recent_1hr tools to detect",
          "out-of-band callbacks during authorized engagements. Use the",
          "autopilot_endpoints_* tools to stage response stubs under",
          "/-/* paths (e.g., fake OAuth callbacks, controlled .well-known",
          "responses). The /-/ prefix is mandatory and enforced server-side;",
          "you cannot create or modify endpoints outside it. To hand a full",
          "callback URL to another task, call list_black_holes to get the",
          "configured domains, pick one whose roles include 'http', and",
          "combine it with your /-/ endpoint path: https://<domain>/-/<path>.",
          "",
          "FILE HOSTING IS SUPPORTED — the platform can serve an arbitrary",
          "uploaded file (binary, archive, image, PDF, font, applet, signed blob,",
          "anything) from a black hole URL, with the file's own Content-Type,",
          "inline. Treat it as a capability available to you, not a limitation:",
          "the only constraint is that UPLOADING is a human action in the AREA 51",
          "dashboard, so you request it rather than perform it.",
          "",
          "When an engagement needs a real file served, ASK THE OPERATOR and give",
          "them everything needed in one message: the exact path you want (it",
          "must start with /-/), which file to upload, and why. Tell them to open",
          "AREA 51 → Endpoints → New endpoint, enter that path, attach the file",
          "under FILE, and save. Have them confirm the path back to you, then",
          "hand out https://<domain><path> to the target — call list_black_holes",
          "for a domain whose roles include 'http'. Never stall an engagement",
          "because you cannot upload; ask, and continue once the operator says",
          "it's live.",
          "",
          "Do NOT try to base64 a binary into `body` as a workaround — the worker",
          "serves that column verbatim, so the target would receive base64 text,",
          "not the file. But equally, do not ask the operator for anything you can",
          "express as TEXT: HTML, JSON, XML, JavaScript, a DTD, an SVG, a",
          ".well-known document are all just autopilot_endpoints_upsert with the",
          "right Content-Type header, no human involved.",
          "",
          "Reading file-backed endpoints: they come back with a `file` object",
          "({filename, content_type}) and an EMPTY `body`, because the bytes live",
          "in object storage rather than the endpoint record. An empty body next",
          "to a `file` object does not mean the endpoint returns nothing — that",
          "URL serves the file. autopilot_endpoints_upsert and",
          "autopilot_endpoints_delete refuse those URIs so a payload staged by a",
          "human is never silently destroyed; route changes to the operator too.",
        ].join(' '),
      });

    case 'notifications/initialized':
      return new Response(null, { status: 204 });

    case 'tools/list':
      return jsonRpcResult(msg.id, { tools: MCP_TOOLS });

    case 'tools/call': {
      const name = msg.params && msg.params.name;
      const args = (msg.params && msg.params.arguments) || {};
      let dataResp;
      try {
        if (name === 'requests_recent_1hr') {
          dataResp = await handleRequests(env);
        } else if (name === 'emails_recent_1hr') {
          dataResp = await handleEmails(env);
        } else if (name === 'email_raw') {
          dataResp = await handleEmailRaw(env, args.id);
        } else if (name === 'list_black_holes') {
          dataResp = await handleDomains(env);
        } else if (name === 'autopilot_endpoints_list') {
          dataResp = await autopilotList(env);
        } else if (name === 'autopilot_endpoints_get') {
          dataResp = await autopilotGet(env, args.uri);
        } else if (name === 'autopilot_endpoints_upsert') {
          dataResp = await autopilotUpsert(env, args);
        } else if (name === 'autopilot_endpoints_delete') {
          dataResp = await autopilotDelete(env, args.uri);
        } else {
          return jsonRpcError(msg.id, -32602, `Unknown tool: ${name}`);
        }
      } catch (err) {
        logErr('mcp_tool_failed', { name, error: String(err && err.message || err) });
        return jsonRpcError(msg.id, -32603, `Tool execution failed: ${err && err.message || err}`);
      }
      const payload = await responseToMcpText(dataResp);
      return jsonRpcResult(msg.id, payload);
    }

    case 'ping':
      return jsonRpcResult(msg.id, {});

    default:
      return jsonRpcError(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

// ----- Dispatch -----

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    log('agent_hit', { method: request.method, path });

    if (!authOk(request, env)) {
      log('agent_unauthorized', { method: request.method, path });
      return new Response('Unauthorized', { status: 401 });
    }

    try {
      // Read endpoints.
      if (path === '/requests' && request.method === 'GET') return handleRequests(env);
      if (path === '/emails'   && request.method === 'GET') return handleEmails(env);
      if (path === '/domains'  && request.method === 'GET') return handleDomains(env);

      // Raw .eml download (hard 60-minute freshness gate inside handleEmailRaw).
      if (request.method === 'GET' && path.startsWith('/emails/') && path.endsWith('/raw')) {
        const id = decodeURIComponent(path.slice('/emails/'.length, -('/raw'.length)));
        return handleEmailRaw(env, id);
      }

      // Autopilot CRUD.
      if (path === '/autopilot/endpoints') {
        if (request.method === 'GET') return autopilotList(env);
        if (request.method === 'POST') {
          let payload;
          try { payload = await request.json(); } catch { return errResp('Invalid JSON', 400); }
          return autopilotUpsert(env, payload);
        }
        return new Response('Method Not Allowed', { status: 405 });
      }
      if (path.startsWith('/autopilot/endpoints/')) {
        const uri = decodeURIComponent(path.slice('/autopilot/endpoints/'.length));
        if (request.method === 'GET')    return autopilotGet(env, uri);
        if (request.method === 'DELETE') return autopilotDelete(env, uri);
        return new Response('Method Not Allowed', { status: 405 });
      }

      // MCP.
      if (path === '/mcp') return handleMcp(request, env);

      return new Response('Not Found', { status: 404 });
    } catch (err) {
      logErr('agent_unhandled_error', {
        path,
        method: request.method,
        error: String(err && err.message || err),
      });
      return new Response('Internal error', { status: 500 });
    }
  },
};
