import { json, errResp } from '../../shared.js';
import { normalizeEmail, looksLikeEmail } from '../shared.js';

export async function listEmails({ env }) {
  const { results } = await env.DB.prepare(
    'SELECT email, ts, note FROM email_blacklist ORDER BY ts DESC'
  ).all();
  return json(results || []);
}

export async function addEmail({ request, env }) {
  let payload;
  try { payload = await request.json(); } catch { return errResp('Invalid JSON', 400); }
  const raw = (payload && payload.email) || '';
  const email = normalizeEmail(raw);
  const note = String((payload && payload.note) || '').trim() || null;
  if (!looksLikeEmail(email)) return errResp('Invalid email', 400);
  const ts = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO email_blacklist (email, ts, note)
     VALUES (?, ?, ?)
     ON CONFLICT(email) DO NOTHING`
  ).bind(email, ts, note).run();
  return json({ ok: true, email });
}
