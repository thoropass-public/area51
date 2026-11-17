import { json, errResp } from '../../shared.js';
import { looksLikeIp } from '../shared.js';

export async function listIps({ env }) {
  const { results } = await env.DB.prepare(
    'SELECT ip, ts, note FROM ip_blacklist ORDER BY ts DESC'
  ).all();
  return json(results || []);
}

export async function addIp({ request, env }) {
  let payload;
  try { payload = await request.json(); } catch { return errResp('Invalid JSON', 400); }
  const ip = String((payload && payload.ip) || '').trim();
  const note = String((payload && payload.note) || '').trim() || null;
  if (!looksLikeIp(ip)) return errResp('Invalid ip', 400);
  const ts = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO ip_blacklist (ip, ts, note)
     VALUES (?, ?, ?)
     ON CONFLICT(ip) DO NOTHING`
  ).bind(ip, ts, note).run();
  return json({ ok: true, ip });
}
