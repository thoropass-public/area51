import { json, errResp, withErrorHandler } from '../_shared.js';

async function getEmail({ params, env }) {
  const row = await env.DB.prepare(
    'SELECT id, ts, from_addr, to_addr, subject, headers, text, html, attachments FROM emails WHERE id = ?'
  ).bind(params.id).first();
  if (!row) return errResp('Not found', 404);

  let headers = [];
  try { headers = row.headers ? JSON.parse(row.headers) : []; } catch { headers = []; }
  let attachments = [];
  try { attachments = row.attachments ? JSON.parse(row.attachments) : []; } catch { attachments = []; }

  return json({ ...row, headers, attachments });
}

export const onRequestGet = withErrorHandler(getEmail);
