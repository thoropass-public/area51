import { json, errResp, withErrorHandler } from '../../_shared.js';

async function deleteIp({ params, env }) {
  const ip = decodeURIComponent(params.ip);
  const result = await env.DB.prepare('DELETE FROM ip_blacklist WHERE ip = ?').bind(ip).run();
  if (!result.meta || result.meta.changes === 0) return errResp('Not found', 404);
  return json({ ok: true });
}

export const onRequestDelete = withErrorHandler(deleteIp);
