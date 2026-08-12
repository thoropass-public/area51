import { json, errResp, withErrorHandler } from '../../_shared.js';
import { normalizeEmail } from '../_shared.js';

async function deleteEmail({ params, env }) {
  const email = normalizeEmail(decodeURIComponent(params.email));
  const result = await env.DB.prepare('DELETE FROM email_blacklist WHERE email = ?').bind(email).run();
  if (!result.meta || result.meta.changes === 0) return errResp('Not found', 404);
  return json({ ok: true });
}

export const onRequestDelete = withErrorHandler(deleteEmail);
