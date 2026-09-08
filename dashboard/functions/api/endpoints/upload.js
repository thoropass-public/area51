import {
  json, errResp, withErrorHandler,
  MAX_UPLOAD_BYTES, FILE_ENDPOINT_STATUS,
  sanitizeContentType, sanitizeFilename, deleteEndpointFile,
} from '../_shared.js';

// POST /api/endpoints/upload?uri=<uri>
//
// Creates or replaces a FILE-BACKED endpoint. The request body is the raw file
// rather than multipart, so the bytes stream straight into R2 and never
// materialize in the Function's memory:
//
//   Content-Type: <the file's type>      → stored as the object's metadata and
//                                          served back verbatim by the worker
//   X-Filename:   <URI-encoded name>     → display only
//   body:         <bytes>
//
// The response a file endpoint serves is owned by the server (200 + detected
// Content-Type + empty body), which is why this route takes no status, headers,
// or body. Mixing an uploaded file with a hand-written body or a 404 has no
// coherent meaning. Text endpoints keep using POST /api/endpoints.
//
// Ordering is R2-first, D1-second, mirroring the email capture path: if the D1
// write fails the freshly-uploaded object is deleted again, so a failed upload
// leaves nothing behind. Any object the row previously pointed at is deleted
// only AFTER the row has been repointed, so the endpoint is never briefly
// pointing at a key that no longer exists.
//
// This route is a static sibling of the [uri] param route; Pages matches static
// segments first, and real endpoint URIs are percent-encoded (they start with
// "/"), so they can never collide with the literal path "upload".
async function uploadEndpointFile({ request, env }) {
  if (!env.FILES) {
    // `./a51 setup` attaches FILES to the Pages project (production AND
    // preview) before the first upload, so a missing one means provisioning did
    // not complete. That is a deploy-time fault, not a bad request, and
    // `./a51 doctor --fix` re-attaches it.
    console.error('endpoint_upload_binding_missing');
    return errResp('File storage is not configured on this deployment (missing FILES binding)', 500);
  }

  const url = new URL(request.url);
  const uri = url.searchParams.get('uri');
  if (!uri || typeof uri !== 'string') return errResp('Invalid uri', 400);
  if (!uri.startsWith('/')) return errResp('uri must start with /', 400);

  // R2 needs a known length to accept a stream, and we want to reject oversize
  // uploads before reading a byte. Both come from Content-Length.
  const lengthHeader = request.headers.get('content-length');
  const size = Number(lengthHeader);
  if (!lengthHeader || !Number.isFinite(size) || size <= 0) {
    return errResp('Content-Length is required and must be greater than zero', 411);
  }
  if (size > MAX_UPLOAD_BYTES) {
    return errResp(`File is too large (max ${Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024)} MB)`, 413);
  }
  if (!request.body) return errResp('Request body is empty', 400);

  const contentType = sanitizeContentType(request.headers.get('content-type'));
  let filename = '';
  try { filename = sanitizeFilename(decodeURIComponent(request.headers.get('x-filename') || '')); }
  catch { filename = sanitizeFilename(request.headers.get('x-filename') || ''); }

  // The object this URI currently points at (if any). It is deleted after the
  // row is successfully repointed at the new key.
  const existing = await env.DB.prepare('SELECT r2_key FROM endpoints WHERE uri = ?').bind(uri).first();
  const previousKey = existing && existing.r2_key;

  // Fresh random key per upload rather than one derived from the URI: replacing
  // a file is then a write to a new key plus a delete of the old one, with no
  // read-your-write window and no URI encoding inside object keys.
  const key = crypto.randomUUID();
  await env.FILES.put(key, request.body, { httpMetadata: { contentType } });

  try {
    await env.DB.prepare(
      `INSERT INTO endpoints (uri, status, headers, body, r2_key, filename)
       VALUES (?, ?, ?, '', ?, ?)
       ON CONFLICT(uri) DO UPDATE SET
         status = excluded.status,
         headers = excluded.headers,
         body = '',
         r2_key = excluded.r2_key,
         filename = excluded.filename`
    ).bind(uri, FILE_ENDPOINT_STATUS, JSON.stringify({ 'Content-Type': contentType }), key, filename).run();
  } catch (err) {
    // Compensating delete: the row never took, so the object must not survive.
    await deleteEndpointFile(env, key);
    throw err;
  }

  if (previousKey && previousKey !== key) await deleteEndpointFile(env, previousKey);

  return json({ ok: true, uri, filename, content_type: contentType, size });
}

export const onRequestPost = withErrorHandler(uploadEndpointFile);
