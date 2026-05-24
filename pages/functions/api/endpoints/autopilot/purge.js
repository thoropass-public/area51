import { json, withErrorHandler } from '../../_shared.js';

// Deletes every endpoint whose URI starts with /autopilot/. The prefix is
// hardcoded — the request body is ignored. We don't return a "would-delete"
// count first because that would cost a COUNT(*) D1 read; the dashboard
// shows the actual deleted count via the toast once the operation succeeds.

async function purgeAutopilot({ env }) {
  const result = await env.DB.prepare(
    "DELETE FROM endpoints WHERE uri LIKE '/autopilot/%'"
  ).run();
  return json({ ok: true, deleted: (result.meta && result.meta.changes) || 0 });
}

export const onRequestPost = withErrorHandler(purgeAutopilot);
