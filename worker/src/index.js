import PostalMime from 'postal-mime';

const FORWARD_THRESHOLD_BYTES = 1048576;

const log = (event, fields = {}) => {
  try { console.log(JSON.stringify({ event, ...fields })); } catch { /* never crash on logging */ }
};
const logErr = (event, fields = {}) => {
  try { console.error(JSON.stringify({ event, ...fields })); } catch { /* never crash on logging */ }
};

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

  log('http_request_received', { id, method: request.method, route });

  const row = {
    id,
    ts: new Date().toISOString(),
    method: request.method,
    url: request.url,
    ip: request.headers.get('cf-connecting-ip') || 'unknown',
    ua: request.headers.get('user-agent') || 'unknown',
    headers: JSON.stringify(Object.fromEntries(request.headers.entries())),
    body: await readBody(request),
  };

  ctx.waitUntil(insertRequestLog(env, row));

  let endpoint = null;
  try {
    endpoint = await env.DB.prepare(
      'SELECT status, headers, body FROM endpoints WHERE uri = ?'
    ).bind(route).first();
  } catch (err) {
    logErr('http_endpoint_lookup_failed', { id, route, error: String(err && err.message || err) });
  }

  if (!endpoint) {
    log('http_endpoint_not_found', { id, route });
    return new Response('404! Not Found', { status: 404 });
  }

  log('http_endpoint_matched', { id, route, status: endpoint.status });

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
    `INSERT INTO emails (id, ts, from_addr, to_addr, subject, headers, text, html, attachments)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    row.id, row.ts, row.from_addr, row.to_addr, row.subject,
    row.headers, row.text, row.html, row.attachments,
  ).run();
}

async function handleEmail(message, env, ctx) {
  const id = crypto.randomUUID();
  const ts = new Date().toISOString();
  const fromAddr = message.from || '';
  const toAddr = message.to || '';

  try {
    const rawSize = Number(message.rawSize);
    log('email_received', { id, from: fromAddr, to: toAddr, rawSize });

    const rawText = await new Response(message.raw).text();

    let parsed = null;
    try {
      parsed = await PostalMime.parse(rawText);
    } catch (err) {
      logErr('email_parse_failed', { id, error: String(err && err.message || err) });
    }

    const subject = (parsed && parsed.headers && (parsed.headers.find(h => h.key && h.key.toLowerCase() === 'subject') || {}).value) ||
                    (parsed && parsed.subject) || '';
    const headersJson = parsed && parsed.headers ? JSON.stringify(parsed.headers) : null;
    const attachmentsMeta = parsed && parsed.attachments
      ? parsed.attachments.map((a) => ({
          filename: a.filename || '',
          mime: a.mimeType || a.contentType || 'application/octet-stream',
          size: a.content ? (a.content.byteLength || a.content.length || 0) : 0,
        }))
      : [];
    const attachmentsJson = JSON.stringify(attachmentsMeta);

    const hasAttachments = attachmentsMeta.length > 0;
    const tooBig = rawSize > FORWARD_THRESHOLD_BYTES;
    const shouldForward = hasAttachments || tooBig;

    if (shouldForward) {
      log('email_fallback', { id, reason: tooBig ? 'oversize' : 'attachments', hasAttachments, tooBig, rawSize });
      const forwardP = forwardToFallback(message, env, id, tooBig ? 'oversize' : 'attachments');
      const insertP = insertEmail(env, {
        id, ts,
        from_addr: fromAddr,
        to_addr: toAddr,
        subject,
        headers: headersJson,
        text: (parsed && parsed.text) || null,
        html: 'sent_to_fallback',
        attachments: attachmentsJson,
      })
        .then(() => log('email_d1_insert_ok', { id, marker: true }))
        .catch((err) => logErr('email_d1_insert_failed', { id, marker: true, error: String(err && err.message || err) }));
      await Promise.allSettled([forwardP, insertP]);
      return;
    }

    try {
      await insertEmail(env, {
        id, ts,
        from_addr: fromAddr,
        to_addr: toAddr,
        subject,
        headers: headersJson,
        text: (parsed && parsed.text) || null,
        html: (parsed && parsed.html) || null,
        attachments: attachmentsJson,
      });
      log('email_d1_insert_ok', { id, marker: false });
    } catch (err) {
      logErr('email_d1_insert_failed', { id, marker: false, error: String(err && err.message || err) });
      await forwardToFallback(message, env, id, 'd1_insert_failed');
    }
  } catch (err) {
    logErr('email_unhandled_error', { id, error: String(err && err.message || err) });
    await forwardToFallback(message, env, id, 'unhandled_error');
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
