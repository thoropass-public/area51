// Email addresses are stored lowercase. Accepts either bare "addr@host" or
// the angle-bracketed "Display <addr@host>" form (mirrors the worker /
// dashboard normalizers).
export function normalizeEmail(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  const m = s.match(/<\s*([^<>\s]+@[^<>\s]+)\s*>/);
  return (m ? m[1] : s).toLowerCase();
}

// Light validation. We don't try to be a full RFC parser — just reject the
// obvious garbage so the table stays clean.
export function looksLikeEmail(v) {
  return typeof v === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v);
}

// Accept v4, v6, or "unknown" (the latter is what the worker stores when
// cf-connecting-ip is missing — useful if someone wants to blacklist the
// stuck-IP bucket).
export function looksLikeIp(v) {
  if (typeof v !== 'string' || !v) return false;
  if (v === 'unknown') return true;
  // IPv4 dotted quad
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(v)) return true;
  // IPv6 — loose check, just ensure colons + hex
  if (/^[0-9a-fA-F:]+$/.test(v) && v.includes(':')) return true;
  return false;
}
