// Black Holes worker.
//
// Cloudflare Worker bound to one or more "black hole" domains as Custom Domains,
// attached over the API by `./a51 setup` and `./a51 black-holes add`, not by
// hand. Each black hole is a catch-all entry-point that accepts incoming HTTP
// requests, incoming email, or both: anything a target sends ends up captured in
// D1 for the pentester to inspect via the AREA 51 dashboard.
//
// The worker is domain-agnostic. It never checks which black hole a request
// arrived on, so adding one needs no redeploy. The hostname only matters as
// data, since it is part of the captured URL.
//
// Two handlers, one D1 binding, one optional fallback inbox:
//   fetch(request)  serves an arbitrary response from `endpoints` and logs the
//                     request to `requests`. A row with an r2_key is
//                     file-backed: the uploaded object is streamed from the
//                     endpoint-files bucket (FILES binding) with its stored
//                     Content-Type, instead of the `body` column. IPs on the
//                     ip_blacklist get a 403 immediately (no body read, no D1
//                     write, no endpoint serve).
//   email(message)  is all-or-nothing capture. On success the verbatim raw
//                     .eml is in R2 (emails/<id>.eml) AND a lean row is in D1
//                     (subject, attachment count, no body). On ANY error both
//                     are rolled back (no partial record) and the original is
//                     forwarded to the fallback inbox. Senders on the
//                     email_blacklist are rejected via message.setReject so
//                     the upstream SMTP gets a bounce.

import PostalMime from 'postal-mime';

// 60 minutes. Blacklist changes from the dashboard take up to this long to be
// enforced (in both directions: adds, and removes). Acceptable for a noise
// filter, and the trade is dramatically fewer D1 lookups on the hot path.
const BLACKLIST_CACHE_TTL_SECONDS = 3600;

const log = (event, fields = {}) => {
  try { console.log(JSON.stringify({ event, ...fields })); } catch { /* never crash on logging */ }
};
const logErr = (event, fields = {}) => {
  try { console.error(JSON.stringify({ event, ...fields })); } catch { /* never crash on logging */ }
};

// Email addresses are stored lowercase in D1, so the address being tested is
// lowercased before comparing. The address tested is the From: HEADER (see
// handleEmail), never the SMTP envelope sender, which is kept for log lines
// only. IPs are stored verbatim (no normalization beyond trim).
function normalizeEmail(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  // Accept either "addr@host" or "Display <addr@host>", matching the dashboard's normalizer.
  const m = s.match(/<\s*([^<>\s]+@[^<>\s]+)\s*>/);
  return (m ? m[1] : s).toLowerCase();
}

// Load a blacklist (IPs or emails) from D1 with a 60-minute edge cache
// (BLACKLIST_CACHE_TTL_SECONDS above is the knob). Returns a
// JS Set for O(1) membership. The cache key is fixed per list so all worker
// invocations in the same data center share the same loaded set.
async function loadBlacklist(env, kind) {
  const cacheUrl = `https://blacklist-cache.local/${kind}-v1`;
  const cacheKey = new Request(cacheUrl, { method: 'GET' });
  const cached = await caches.default.match(cacheKey);
  if (cached) {
    const arr = await cached.json();
    return new Set(arr);
  }
  let arr = [];
  try {
    if (kind === 'ip') {
      const { results } = await env.DB.prepare('SELECT ip FROM ip_blacklist').all();
      arr = (results || []).map((r) => r.ip);
    } else if (kind === 'email') {
      const { results } = await env.DB.prepare('SELECT email FROM email_blacklist').all();
      arr = (results || []).map((r) => r.email);
    }
  } catch (err) {
    logErr('blacklist_load_failed', { kind, error: String(err && err.message || err) });
    // On query failure, return an empty set. Never block writes on a flaky lookup.
    return new Set();
  }
  const body = JSON.stringify(arr);
  const fresh = new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': `public, max-age=${BLACKLIST_CACHE_TTL_SECONDS}`,
    },
  });
  await caches.default.put(cacheKey, fresh.clone());
  return new Set(arr);
}

async function readBody(request) {
  try { return await request.text(); } catch { return ""; }
}

async function insertRequestLog(env, row) {
  try {
    await env.DB.prepare(
      `INSERT INTO requests (id, ts, method, url, ip, ua, headers, body)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(row.id, row.ts, row.method, row.url, row.ip, row.ua, row.headers, row.body).run();
    log('http_log_insert_ok', { id: row.id });
  } catch (err) {
    logErr('http_log_insert_failed', { id: row.id, error: String(err && err.message || err) });
  }
}

async function handleHttp(request, env, ctx) {
  const url = new URL(request.url);
  const route = url.pathname;
  const id = crypto.randomUUID();
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';

  log('http_request_received', { id, method: request.method, route, ip });

  // Blacklist gate (active reject). Checked before reading the body or looking
  // up an endpoint so a blacklisted IP costs us as little as possible. No D1
  // write, no endpoint serve, just a 403 back at the source.
  const ipBlacklist = await loadBlacklist(env, 'ip');
  if (ipBlacklist.has(ip)) {
    log('http_rejected_blacklist', { id, ip });
    return new Response('403! Forbidden', { status: 403 });
  }

  const row = {
    id,
    ts: new Date().toISOString(),
    method: request.method,
    url: request.url,
    ip,
    ua: request.headers.get('user-agent') || 'unknown',
    headers: JSON.stringify(Object.fromEntries(request.headers.entries())),
    body: await readBody(request),
  };

  ctx.waitUntil(insertRequestLog(env, row));

  let endpoint = null;
  try {
    endpoint = await env.DB.prepare(
      'SELECT status, headers, body, r2_key FROM endpoints WHERE uri = ?'
    ).bind(route).first();
  } catch (err) {
    logErr('http_endpoint_lookup_failed', { id, route, error: String(err && err.message || err) });
  }

  if (!endpoint) {
    log('http_endpoint_not_found', { id, route });
    return new Response('404! Not Found', { status: 404 });
  }

  log('http_endpoint_matched', { id, route, status: endpoint.status });

  // File-backed endpoint: stream the uploaded object straight from R2 instead of
  // serving the `body` column. Content-Type comes from the object's own stored
  // metadata, so D1 never has to be the authority on it. Served inline (no
  // Content-Disposition), because a hosted payload has to execute, not download.
  // R2 hands back a stream, so object size never touches worker memory.
  if (endpoint.r2_key) {
    if (!env.FILES) {
      logErr('http_file_binding_missing', { id, route });
      return new Response('404! Not Found', { status: 404 });
    }
    let obj = null;
    try {
      obj = await env.FILES.get(endpoint.r2_key);
    } catch (err) {
      logErr('http_file_lookup_failed', { id, route, error: String(err && err.message || err) });
    }
    if (!obj) {
      // Row survived but its object didn't, so the D1/R2 pair broke somewhere.
      // Surface it loudly rather than serving an empty 200.
      logErr('http_file_missing', { id, route, key: endpoint.r2_key });
      return new Response('404! Not Found', { status: 404 });
    }
    log('http_file_served', { id, route, key: endpoint.r2_key, size: obj.size });
    return new Response(obj.body, {
      status: 200,
      headers: {
        'Content-Type': (obj.httpMetadata && obj.httpMetadata.contentType) || 'application/octet-stream',
      },
    });
  }

  let headers = {};
  try { headers = JSON.parse(endpoint.headers || '{}'); } catch { headers = {}; }

  return new Response(endpoint.body || '', {
    status: endpoint.status || 200,
    headers,
  });
}

async function forwardToFallback(message, env, id, reason) {
  try {
    await message.forward(env.FALLBACK_ADDRESS);
    log('email_forward_ok', { id, reason });
  } catch (err) {
    logErr('email_forward_failed', { id, reason, error: String(err && err.message || err) });
  }
}

async function insertEmail(env, row) {
  await env.DB.prepare(
    `INSERT INTO emails (id, ts, from_addr, to_addr, subject, attachment_count)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(
    row.id, row.ts, row.from_addr, row.to_addr, row.subject,
    row.attachment_count,
  ).run();
}

async function handleEmail(message, env, ctx) {
  const id = crypto.randomUUID();
  const ts = new Date().toISOString();
  const envelopeFrom = message.from || '';   // SMTP MAIL FROM, kept only for diagnostic logging
  const toAddr = message.to || '';
  const key = `emails/${id}.eml`;
  let fromAddr = '';                          // populated from parsed.from.address below; never falls back to envelope

  try {
    log('email_received', { id, envelope_from: envelopeFrom, to: toAddr, rawSize: Number(message.rawSize) });

    // Buffer the raw EML once. It feeds the parser, the R2 object, and lets
    // us derive the From: header address (what the dashboard shows and the
    // blacklist gates on).
    const buf = await new Response(message.raw).arrayBuffer();

    // Parse failure is non-fatal: the raw .eml is still valid and gets stored,
    // and the rich view re-parses in the browser. We just lose the extracted
    // subject/text/count and fall back to envelope-from for the row.
    let parsed = null;
    try {
      parsed = await PostalMime.parse(buf);
    } catch (err) {
      logErr('email_parse_failed', { id, error: String(err && err.message || err) });
    }

    // From: header address, the canonical (and only) sender we store, show,
    // and blacklist against. If parsing failed or the message has no From:
    // header, fromAddr stays empty: the row is still captured, but the
    // blacklist gate below skips (nothing to compare) and D1 stores ''.
    // The envelope sender is intentionally NOT consulted as a fallback.
    fromAddr = (parsed && parsed.from && typeof parsed.from.address === 'string' && parsed.from.address) || '';

    // Blacklist gate (active reject). It matches the From: header that the
    // dashboard displays, so "blacklist this sender" actually catches future
    // mail from the same visible address. message.setReject NACKs upstream
    // so the sender gets a clear bounce; no R2 object, no D1 write.
    const normalizedFrom = normalizeEmail(fromAddr);
    if (normalizedFrom) {
      const emailBlacklist = await loadBlacklist(env, 'email');
      if (emailBlacklist.has(normalizedFrom)) {
        log('email_rejected_blacklist', { id, from: normalizedFrom });
        message.setReject('Address not accepted');
        return;
      }
    }

    const subject = (parsed && parsed.subject) ||
                    (parsed && parsed.headers && (parsed.headers.find(h => h.key && h.key.toLowerCase() === 'subject') || {}).value) ||
                    '';
    const attachmentCount = parsed && parsed.attachments ? parsed.attachments.length : 0;

    // All-or-nothing: both writes must land. Either throwing sends us to the
    // catch, which rolls back any partial write and forwards to fallback.
    // The body (plain-text + HTML) is NOT stored in D1. It's read from the
    // raw .eml in R2 on demand by the dashboard and Autopilot.
    await env.EML.put(key, buf, { httpMetadata: { contentType: 'message/rfc822' } });
    await insertEmail(env, {
      id, ts, from_addr: fromAddr, to_addr: toAddr,
      subject, attachment_count: attachmentCount,
    });
    log('email_stored', { id, key, attachment_count: attachmentCount });
  } catch (err) {
    // Anything failed (raw read, R2 PUT, D1 insert). Forward the original so
    // it isn't lost, then roll back any partial write so D1/R2 never keep a
    // half-record. Compensating deletes are best-effort (no shared txn).
    logErr('email_capture_failed', { id, error: String(err && err.message || err) });
    await forwardToFallback(message, env, id, 'capture_failed');
    try { await env.EML.delete(key); }
    catch (e) { logErr('email_rollback_r2_failed', { id, error: String(e && e.message || e) }); }
    try { await env.DB.prepare('DELETE FROM emails WHERE id = ?').bind(id).run(); }
    catch (e) { logErr('email_rollback_d1_failed', { id, error: String(e && e.message || e) }); }
  }
}

export default {
  async fetch(request, env, ctx) {
    return handleHttp(request, env, ctx);
  },
  async email(message, env, ctx) {
    return handleEmail(message, env, ctx);
  },
};
