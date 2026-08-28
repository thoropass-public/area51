import { json, errResp, withErrorHandler } from '../_shared.js';

// Detail. For a file-backed row (r2_key set) the response carries a `file`
// object instead of a meaningful body/headers/status to edit: the modal renders
// the upload's identity, not a response editor. `size` and `content_type` come
// from an R2 HEAD rather than duplicated D1 columns, so the object's own
// metadata stays the single source of truth; if the object is gone the row is
// reported with `missing: true` so the UI can say so plainly.
async function getEndpoint({ params, env }) {
  const uri = decodeURIComponent(params.uri);
  const row = await env.DB.prepare(
    'SELECT uri, status, headers, body, r2_key, filename FROM endpoints WHERE uri = ?'
  ).bind(uri).first();
  if (!row) return errResp('Not found', 404);

  const { r2_key: key, filename, ...rest } = row;
  if (!key) return json({ ...rest, file: null });

  let head = null;
  if (env.FILES) {
    try { head = await env.FILES.head(key); }
    catch (err) { console.error('endpoint_file_head_failed', key, err && err.message); }
  }
  return json({
    ...rest,
    file: {
      filename: filename || '',
      content_type: (head && head.httpMetadata && head.httpMetadata.contentType) || '',
      size: head ? head.size : 0,
      missing: !head,
    },
  });
}

// Delete. R2 first, then D1: a failed object delete leaves the row in place to
// retry, which is visible in the UI. The reverse order would leave an orphaned
// object with nothing pointing at it — an invisible storage leak, the failure
// mode the email pipeline is also built to avoid.
async function deleteEndpoint({ params, env }) {
  const uri = decodeURIComponent(params.uri);
  const row = await env.DB.prepare('SELECT r2_key FROM endpoints WHERE uri = ?').bind(uri).first();
  if (row && row.r2_key) {
    if (!env.FILES) return errResp('File storage is not configured on this deployment (missing FILES binding)', 500);
    await env.FILES.delete(row.r2_key);
  }

  const result = await env.DB.prepare('DELETE FROM endpoints WHERE uri = ?').bind(uri).run();
  if (!result.meta || result.meta.changes === 0) return errResp('Not found', 404);
  return json({ ok: true });
}

export const onRequestGet = withErrorHandler(getEndpoint);
export const onRequestDelete = withErrorHandler(deleteEndpoint);
