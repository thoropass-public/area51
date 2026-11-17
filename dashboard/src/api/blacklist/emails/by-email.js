import { json, errResp } from '../../shared.js';
import { normalizeEmail } from '../shared.js';

export async function deleteEmail({ params, env }) {
  const email = normalizeEmail(decodeURIComponent(params.email));
  const result = await env.DB.prepare('DELETE FROM email_blacklist WHERE email = ?').bind(email).run();
  if (!result.meta || result.meta.changes === 0) return errResp('Not found', 404);
  return json({ ok: true });
}
