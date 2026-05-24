// AREA 51 agent worker (agent-a51.ops.example)
//
// Read endpoints + autopilot CRUD for authorized Claude Code / Codex agents
// during pentests.
//
// Endpoints:
//   GET    /requests                     →  last 5 minutes of `requests` rows
//   GET    /emails                       →  last 5 minutes of `emails`   rows
//   GET    /autopilot/endpoints          →  list all endpoints under /autopilot/*
//   POST   /autopilot/endpoints          →  upsert (body: {uri, status, headers, body})
//   GET    /autopilot/endpoints/<uri>    →  read one
//   DELETE /autopilot/endpoints/<uri>    →  delete one
//
//   POST   /mcp                          →  MCP (JSON-RPC 2.0 over HTTP)
//
// MCP tools exposed:
//   requests_recent_5min
//   emails_recent_5min
//   autopilot_endpoints_list
//   autopilot_endpoints_get
//   autopilot_endpoints_upsert
//   autopilot_endpoints_delete
//
// Every request must include `X-A51-Secret: <secret>` (matched against the
// AGENT_SECRET worker secret in constant time). 401 otherwise.
//
// The /autopilot/* prefix on managed endpoint URIs is hardcoded server-side
// and cannot be widened by the client. Any CRUD call referencing a URI that
// doesn't start with /autopilot/ returns 400.
//
// No edge caching. Every call hits D1 directly. (Earlier versions of this
// worker cached the read responses for 60s; removed because agents polling
// during active engagements want freshness over read-cost optimization.)

const WINDOW_MINUTES = 5;
const WINDOW_MS = WINDOW_MINUTES * 60 * 1000;
const AUTOPILOT_PREFIX = '/autopilot/';

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
    'SELECT id, ts, from_addr, to_addr, subject, text FROM emails WHERE ts >= ? ORDER BY ts DESC'
  ).bind(cutoff).all();
  log('agent_d1_emails', { rows: (results || []).length, duration_ms: Date.now() - t0 });
  return json({
    served_at: new Date().toISOString(),
    window_minutes: WINDOW_MINUTES,
    rows: results || [],
  });
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

async function autopilotList(env) {
  // LIKE '/autopilot/%' uses the endpoints PK (uri) index for range matching.
  const { results } = await env.DB.prepare(
    "SELECT uri, status, headers, body FROM endpoints WHERE uri LIKE '/autopilot/%' ORDER BY uri ASC"
  ).all();
  // Parse headers JSON back into objects on the way out so agents don't have
  // to do it themselves.
  const rows = (results || []).map((r) => {
    let headers = {};
    try { headers = r.headers ? JSON.parse(r.headers) : {}; } catch { headers = {}; }
    return { uri: r.uri, status: r.status, headers, body: r.body || '' };
  });
  return json({ rows });
}

async function autopilotGet(env, uri) {
  if (!isAutopilotUri(uri)) return errResp('uri must start with /autopilot/', 400);
  const row = await env.DB.prepare(
    'SELECT uri, status, headers, body FROM endpoints WHERE uri = ?'
  ).bind(uri).first();
  if (!row) return errResp('Not found', 404);
  let headers = {};
  try { headers = row.headers ? JSON.parse(row.headers) : {}; } catch { headers = {}; }
  return json({ uri: row.uri, status: row.status, headers, body: row.body || '' });
}

async function autopilotUpsert(env, payload) {
  const uri = (payload && payload.uri) || '';
  const status = (payload && payload.status);
  const rawHeaders = (payload && payload.headers);
  const body = (payload && payload.body) || '';

  if (!isAutopilotUri(uri)) return errResp('uri must start with /autopilot/', 400);
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
  if (!isAutopilotUri(uri)) return errResp('uri must start with /autopilot/', 400);
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
    name: 'requests_recent_5min',
    description: [
      "Returns HTTP requests captured by the AREA 51",
      "in the last 5 minutes. Use this during authorized pentests to detect",
      "out-of-band callbacks — e.g., to confirm whether an SSRF, XXE, blind",
      "command-injection, or other interaction-based payload has triggered a",
      "callback to AREA 51's callback infrastructure. The result is JSON: an",
      "object with `served_at` (ISO timestamp), `window_minutes` (5), and",
      "`rows` (an array of {id, ts, method, url, ip} objects, newest first).",
      "Data is live (no server-side cache). No parameters; the window is",
      "fixed server-side and cannot be widened.",
    ].join(' '),
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'emails_recent_5min',
    description: [
      "Returns emails received by the AREA 51",
      "in the last 5 minutes. Use this during authorized pentests to",
      "detect email-based out-of-band callbacks — e.g., to confirm an",
      "email-injection or password-reset-redirect payload triggered delivery",
      "to a controlled address. The result is JSON: an object with",
      "`served_at`, `window_minutes` (5), and `rows` (an array of",
      "{id, ts, from_addr, to_addr, subject, text} objects, newest first).",
      "Note: emails forwarded to the fallback inbox (size > 1 MB or",
      "attachments present) are still listed here but the body fields may be",
      "minimal — check the fallback inbox if a row looks truncated. Data is",
      "live (no server-side cache). No parameters.",
    ].join(' '),
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'autopilot_endpoints_list',
    description: [
      "Lists all configured endpoints under /autopilot/*. Use this to see",
      "what response stubs the AREA 51 black holes are currently serving",
      "for autopilot paths. Returns JSON: {rows: [{uri, status, headers, body}, ...]}.",
      "Only endpoints with URIs starting with /autopilot/ are returned;",
      "manually-defined endpoints outside that prefix are not visible. No",
      "parameters.",
    ].join(' '),
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'autopilot_endpoints_get',
    description: [
      "Returns the configured response stub for a single /autopilot/* URI.",
      "Use this to inspect what a particular autopilot endpoint is set to",
      "return. The `uri` argument must start with /autopilot/ — otherwise",
      "the call returns an error. Result is JSON: {uri, status, headers, body}.",
      "Returns 404-equivalent error if the URI is not configured.",
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        uri: {
          type: 'string',
          description: "Endpoint URI to read. Must start with /autopilot/",
        },
      },
      required: ['uri'],
    },
  },
  {
    name: 'autopilot_endpoints_upsert',
    description: [
      "Creates or updates an endpoint configuration under /autopilot/*. Use",
      "this to set the response the AREA 51 worker will serve when a target",
      "calls a specific /autopilot/* path during a pentest — e.g., stage a",
      "fake OAuth callback, a malicious .well-known file, or any other",
      "controlled response. Upsert semantics: if the URI already exists, its",
      "status / headers / body are overwritten.",
      "",
      "The `uri` MUST start with /autopilot/ — any other prefix returns an",
      "error. `status` is an integer 100–599. `headers` is an object",
      "(key→value strings). `body` is a string (any text or base64-encoded",
      "binary; the worker serves it verbatim).",
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        uri: { type: 'string', description: "Endpoint URI. Must start with /autopilot/" },
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
      "Deletes an /autopilot/* endpoint configuration. The worker will start",
      "returning 404 for that URI immediately on the next request. The `uri`",
      "must start with /autopilot/ — otherwise the call returns an error.",
      "Returns success on delete; 404-equivalent error if the URI was not",
      "configured.",
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        uri: { type: 'string', description: "Endpoint URI to delete. Must start with /autopilot/" },
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
        serverInfo: { name: 'area51-agent', version: '1.1.0' },
        instructions: [
          "AREA 51 is Thoropass's internal callback infrastructure: a worker",
          "behind a set of 'black hole' domains that catch both HTTP requests",
          "and email sent to them. Use the requests_recent_5min and emails_recent_5min",
          "tools to detect out-of-band callbacks during authorized pentests.",
          "Use the autopilot_endpoints_* tools to stage response stubs under",
          "/autopilot/* paths (e.g., fake OAuth callbacks, controlled .well-known",
          "responses). The /autopilot/ prefix is mandatory and enforced",
          "server-side; you cannot create or modify endpoints outside it.",
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
        if (name === 'requests_recent_5min') {
          dataResp = await handleRequests(env);
        } else if (name === 'emails_recent_5min') {
          dataResp = await handleEmails(env);
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
