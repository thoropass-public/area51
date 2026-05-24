export const PAGE_SIZE = 50;

export function json(data, init) {
  return Response.json(data, init);
}

export function errResp(message, status) {
  return Response.json({ error: message }, { status });
}

export function withErrorHandler(handler) {
  return async (context) => {
    try {
      return await handler(context);
    } catch (err) {
      console.error('api_error', err && err.message, err && err.stack);
      return errResp('Internal error', 500);
    }
  };
}

export function parseHeaderLines(raw) {
  const out = {};
  if (!raw || typeof raw !== 'string') return out;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue;
    const key = trimmed.slice(0, colonIdx).trim();
    const value = trimmed.slice(colonIdx + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}
