// AREA 51 agent worker (agent-a51.thoropentests.com)
//
// Read-only worker that exposes the last 5 minutes of captured requests and
// emails to authorized Claude Code / Codex agents during pentests.
//
// Endpoints:
//   GET  /requests   →  JSON: last 5 minutes of `requests` rows
//   GET  /emails     →  JSON: last 5 minutes of `emails`   rows
//   POST /mcp        →  MCP (JSON-RPC 2.0 over HTTP). Two tools:
//                          requests_recent_5min
//                          emails_recent_5min
//
// Every request must include `X-A51-Secret: <secret>` (matched against the
// AGENT_SECRET worker secret in constant time). 401 otherwise.
//
// Responses for the REST endpoints are cached at the Cloudflare edge for 60
// seconds, so D1 is queried at most once per minute per data center per
// endpoint regardless of agent polling rate. MCP tool calls hit the same
// cache code path internally.

const WINDOW_MINUTES = 5;
const CACHE_TTL_SECONDS = 60;
const WINDOW_MS = WINDOW_MINUTES * 60 * 1000;

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

// Wraps a D1-querying function with the edge cache. The cache is keyed by a
// synthetic Request whose URL identifies the endpoint. Cache-Control:
// max-age=CACHE_TTL_SECONDS tells the edge how long to keep it.
async function withEdgeCache(cacheUrl, buildResponse) {
  const cacheKey = new Request(cacheUrl, { method: 'GET' });
  const cached = await caches.default.match(cacheKey);
  if (cached) {
    log('agent_cache_hit', { key: cacheUrl });
    return cached;
  }
  log('agent_cache_miss', { key: cacheUrl });
  const fresh = await buildResponse();
  // Clone before storing — Cache API consumes the body.
  await caches.default.put(cacheKey, fresh.clone());
  return fresh;
}

async function buildRequestsResponse(env) {
  const cutoff = new Date(Date.now() - WINDOW_MS).toISOString();
  const t0 = Date.now();
  const { results } = await env.DB.prepare(
    'SELECT id, ts, method, url, ip FROM requests WHERE ts >= ? ORDER BY ts DESC'
  ).bind(cutoff).all();
  log('agent_d1_requests', { rows: (results || []).length, duration_ms: Date.now() - t0 });
  const body = {
    served_at: new Date().toISOString(),
    window_minutes: WINDOW_MINUTES,
    rows: results || [],
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': `public, max-age=${CACHE_TTL_SECONDS}`,
    },
  });
}

async function buildEmailsResponse(env) {
  const cutoff = new Date(Date.now() - WINDOW_MS).toISOString();
  const t0 = Date.now();
  const { results } = await env.DB.prepare(
    'SELECT id, ts, from_addr, to_addr, subject, text FROM emails WHERE ts >= ? ORDER BY ts DESC'
  ).bind(cutoff).all();
  log('agent_d1_emails', { rows: (results || []).length, duration_ms: Date.now() - t0 });
  const body = {
    served_at: new Date().toISOString(),
    window_minutes: WINDOW_MINUTES,
    rows: results || [],
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': `public, max-age=${CACHE_TTL_SECONDS}`,
    },
  });
}

// ----- REST handlers -----

async function handleRequests(env) {
  return withEdgeCache('https://agent-cache.local/requests-v1', () => buildRequestsResponse(env));
}
async function handleEmails(env) {
  return withEdgeCache('https://agent-cache.local/emails-v1', () => buildEmailsResponse(env));
}

// ----- MCP handler -----
//
// We implement MCP's JSON-RPC 2.0 over HTTP transport directly. Only the
// methods needed for the two read-only tools are supported.
//
// Method coverage:
//   initialize                  → handshake, advertises `tools` capability.
//   notifications/initialized   → client ACK, no response body.
//   tools/list                  → returns the two tool schemas.
//   tools/call                  → executes one of the tools and returns the
//                                 JSON payload as a text content block.

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
      "Data lag is at most 60 seconds (server-side cache). No parameters; the",
      "window is fixed server-side and cannot be widened.",
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
      "minimal — check the fallback inbox if a row looks truncated. Data lag",
      "is at most 60 seconds. No parameters.",
    ].join(' '),
    inputSchema: { type: 'object', properties: {}, required: [] },
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
        serverInfo: { name: 'area51-agent', version: '1.0.0' },
      });

    case 'notifications/initialized':
      // Notification: no response required by JSON-RPC. 204 keeps the
      // socket clean.
      return new Response(null, { status: 204 });

    case 'tools/list':
      return jsonRpcResult(msg.id, { tools: MCP_TOOLS });

    case 'tools/call': {
      const name = msg.params && msg.params.name;
      let dataResp;
      if (name === 'requests_recent_5min') {
        dataResp = await handleRequests(env);
      } else if (name === 'emails_recent_5min') {
        dataResp = await handleEmails(env);
      } else {
        return jsonRpcError(msg.id, -32602, `Unknown tool: ${name}`);
      }
      const text = await dataResp.text();
      return jsonRpcResult(msg.id, {
        content: [{ type: 'text', text }],
      });
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
      if (path === '/requests' && request.method === 'GET') return handleRequests(env);
      if (path === '/emails' && request.method === 'GET') return handleEmails(env);
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
