export const PAGE_SIZE = 50;

export function json(data, init) {
  return Response.json(data, init);
}

// `headers` carries the few cases that need one, such as `Allow` on a 405.
export function errResp(message, status, headers) {
  return Response.json({ error: message }, headers ? { status, headers } : { status });
}

// ---- Endpoint file uploads (FILES R2 binding) ----

// Product cap, re-checked server-side against Content-Length. Cloudflare's own
// request-body ceiling is far higher; this is about keeping the dashboard and
// the bucket sane, not about a platform limit.
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

// A file-backed endpoint's response is owned by the server: 200, the detected
// Content-Type, empty body. These are written into the row so every existing
// reader (worker fallback, Autopilot, the dashboard) sees a coherent record.
export const FILE_ENDPOINT_STATUS = 200;

// Accept `type/subtype` with optional parameters (`text/html; charset=utf-8`).
// Anything malformed, over-long, or carrying control characters falls back to
// octet-stream rather than being echoed into a response header.
export function sanitizeContentType(raw) {
  const s = String(raw || '').trim();
  if (!s || s.length > 200) return 'application/octet-stream';
  if (/[\r\n\0]/.test(s)) return 'application/octet-stream';
  if (!/^[\w.+-]+\/[\w.+-]+(\s*;.*)?$/.test(s)) return 'application/octet-stream';
  return s;
}

// Display only, never used to build a response header. Still stripped of
// control characters and path separators so it can't smuggle anything into the
// UI or a future header.
export function sanitizeFilename(raw) {
  const s = String(raw || '').replace(/[\r\n\0]/g, '').replace(/[\\/]/g, '_').trim();
  return s.slice(0, 200);
}

// Best-effort R2 delete for an endpoint's uploaded object. Never throws: the
// caller has already made (or is about to make) the authoritative D1 change,
// and a failed delete is a logged orphan, not a broken endpoint.
export async function deleteEndpointFile(env, key) {
  if (!key || !env.FILES) return false;
  try {
    await env.FILES.delete(key);
    return true;
  } catch (err) {
    console.error('endpoint_file_delete_failed', key, err && err.message);
    return false;
  }
}

export function parseHeaderLines(raw) {
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
