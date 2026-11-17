import { json, errResp, AUTOPILOT_PREFIX, isAutopilotUri, ARCHIVED_FROZEN } from '../shared.js';

// Detail. For a file-backed row (r2_key set) the response carries a `file`
// object instead of a meaningful body/headers/status to edit: the modal renders
// the upload's identity, not a response editor. `size` and `content_type` come
// from an R2 HEAD rather than duplicated D1 columns, so the object's own
// metadata stays the single source of truth; if the object is gone the row is
// reported with `missing: true` so the UI can say so plainly.
export async function getEndpoint({ params, env }) {
  const uri = decodeURIComponent(params.uri);
  const row = await env.DB.prepare(
    'SELECT uri, status, headers, body, r2_key, filename, archived FROM endpoints WHERE uri = ?'
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

// PATCH: rename the endpoint, archive it, or both in one write.
//
// Both are the same statement because both are a single-row UPDATE and doing
// them separately would let a rename land while the archive that was meant to
// accompany it failed.
//
// RENAME IS A PRIMARY KEY UPDATE, and it is safe to be exactly that. `uri` is
// the key, SQLite updates it in place, and nothing else in either store is
// keyed by it: an endpoint's R2 object is keyed by a random UUID in `r2_key`,
// so a file-backed endpoint keeps its object across a rename with no R2 call at
// all. Captured requests keep the URL they were actually made to, which is a
// historical fact and not something a rename should rewrite.
//
// Two rules the dashboard enforces here rather than in the UI, because the UI
// is not the only thing that can call this:
//
//   * An endpoint under /-/ cannot be archived. Agent-staged endpoints are
//     deleted or converted. Renaming one out of the prefix is the conversion,
//     and that is also what takes it out of Autopilot's reach and out of the
//     purge schedule. Archiving one would leave a row that is agent-owned,
//     unserved, and purged next month regardless, which is three different
//     lifecycles at once.
//   * Renaming INTO /-/ is allowed, and hands the endpoint to Autopilot along
//     with the purge schedule. Allowed because the fence is Autopilot's
//     constraint, not an operator's, but never silently: the dashboard confirms
//     it, and an archived endpoint is refused outright rather than quietly
//     unarchived.
export async function patchEndpoint({ params, request, env }) {
  const uri = decodeURIComponent(params.uri);
  let payload;
  try { payload = await request.json(); } catch { return errResp('Invalid JSON', 400); }

  const row = await env.DB
    .prepare('SELECT uri, archived FROM endpoints WHERE uri = ?')
    .bind(uri)
    .first();
  if (!row) return errResp('Not found', 404);

  const nextUri = typeof payload.uri === 'string' ? payload.uri.trim() : uri;
  const nextArchived = typeof payload.archived === 'boolean'
    ? (payload.archived ? 1 : 0)
    : (row.archived ? 1 : 0);

  if (!nextUri) return errResp('URI is required', 400);
  if (!nextUri.startsWith('/')) return errResp('URI must start with /', 400);

  // An archived row is frozen. The ONE write it accepts is the one that
  // unarchives it, so a rename is refused here even though the same call could
  // technically carry both. "Unarchive and move it somewhere else" is two
  // decisions, and the second one belongs to an endpoint that is being served.
  if (row.archived && nextUri !== uri) return errResp(ARCHIVED_FROZEN, 409);

  if (nextArchived === 1 && isAutopilotUri(nextUri)) {
    return errResp(
      `An endpoint under ${AUTOPILOT_PREFIX} cannot be archived. Delete it, or rename it out of ${AUTOPILOT_PREFIX} first.`,
      409,
    );
  }

  if (nextUri !== uri) {
    const clash = await env.DB
      .prepare('SELECT uri FROM endpoints WHERE uri = ?')
      .bind(nextUri)
      .first();
    if (clash) return errResp(`${nextUri} already exists`, 409);
  }

  try {
    await env.DB
      .prepare('UPDATE endpoints SET uri = ?, archived = ? WHERE uri = ?')
      .bind(nextUri, nextArchived, uri)
      .run();
  } catch (err) {
    // The existence check above is a better error message, not a lock. Two
    // renames onto the same name can still race, and SQLite is the thing that
    // actually decides.
    if (/UNIQUE constraint/i.test(String(err && err.message))) {
      return errResp(`${nextUri} already exists`, 409);
    }
    throw err;
  }

  return json({ ok: true, uri: nextUri, archived: !!nextArchived, renamed: nextUri !== uri });
}

// Delete. R2 first, then D1: a failed object delete leaves the row in place to
// retry, which is visible in the UI. The reverse order would leave an orphaned
// object with nothing pointing at it: an invisible storage leak, and the failure
// mode the email pipeline is also built to avoid.
export async function deleteEndpoint({ params, env }) {
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
