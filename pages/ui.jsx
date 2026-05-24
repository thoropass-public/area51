const { useState, useEffect, useRef, useCallback, useMemo } = React;

// ---- API client ----

async function apiFetch(path, init) {
  const resp = await fetch(path, init);
  const ct = resp.headers.get('content-type') || '';
  const isJson = ct.includes('application/json');
  const body = isJson ? await resp.json().catch(() => null) : null;
  if (!resp.ok) {
    const msg = (body && body.error) || `HTTP ${resp.status}`;
    throw new Error(msg);
  }
  return body;
}

// Build a query string. `search` may be a string OR an array of strings; each
// non-empty term becomes its own ?search=... so the server can AND them.
const qs = (params) => {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) {
      for (const item of v) {
        if (item !== undefined && item !== null && item !== '') sp.append(k, item);
      }
    } else {
      sp.set(k, v);
    }
  }
  const s = sp.toString();
  return s ? '?' + s : '';
};

const API = {
  listEndpoints: ({ cursor, search } = {}) =>
    apiFetch('/api/endpoints' + qs({ cursor, search })),
  getEndpoint: (uri) =>
    apiFetch(`/api/endpoints/${encodeURIComponent(uri)}`),
  saveEndpoint: ({ uri, status, headers, body }) =>
    apiFetch('/api/endpoints', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uri, status: Number(status), headers, body }),
    }),
  deleteEndpoint: (uri) =>
    apiFetch(`/api/endpoints/${encodeURIComponent(uri)}`, { method: 'DELETE' }),

  listRequests: ({ cursor, search } = {}) =>
    apiFetch('/api/requests' + qs({ cursor, search })),
  getRequest: (id) =>
    apiFetch(`/api/requests/${encodeURIComponent(id)}`),

  listEmails: ({ cursor, search } = {}) =>
    apiFetch('/api/emails' + qs({ cursor, search })),
  getEmail: (id) =>
    apiFetch(`/api/emails/${encodeURIComponent(id)}`),

  purge: ({ table, keep }) =>
    apiFetch('/api/purge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ table, keep: Number(keep) }),
    }),

  purgeAutopilot: () =>
    apiFetch('/api/endpoints/autopilot/purge', { method: 'POST' }),

  listBlacklistIps: () => apiFetch('/api/blacklist/ips'),
  addBlacklistIp: (ip) => apiFetch('/api/blacklist/ips', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ip }),
  }),
  removeBlacklistIp: (ip) =>
    apiFetch(`/api/blacklist/ips/${encodeURIComponent(ip)}`, { method: 'DELETE' }),

  listBlacklistEmails: () => apiFetch('/api/blacklist/emails'),
  addBlacklistEmail: (email) => apiFetch('/api/blacklist/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  }),
  removeBlacklistEmail: (email) =>
    apiFetch(`/api/blacklist/emails/${encodeURIComponent(email)}`, { method: 'DELETE' }),
};

// Email normalizer mirrors the worker + Pages Function logic. Accepts either
// bare "addr@host" or "Display <addr@host>" form; returns lowercase addr.
function normalizeEmail(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  const m = s.match(/<\s*([^<>\s]+@[^<>\s]+)\s*>/);
  return (m ? m[1] : s).toLowerCase();
}

// localStorage with JSON. Returns fallback on miss / parse error / no localStorage.
function lsGet(key, fallback) {
  try {
    const v = window.localStorage.getItem(key);
    return v == null ? fallback : JSON.parse(v);
  } catch { return fallback; }
}
function lsSet(key, value) {
  try { window.localStorage.setItem(key, JSON.stringify(value)); } catch { /* quota / private mode */ }
}

// ---- Helpers ----

function fmtTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  }
  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  if (d.toDateString() === yest.toDateString()) {
    return "yest " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  }
  return d.toLocaleDateString([], { month: "short", day: "2-digit" }) + " " +
         d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

function fmtTimeFull(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString([], {
    year: "numeric", month: "short", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  }) + " " + Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function statusClass(code) {
  const c = Number(code);
  if (c >= 500) return "status-5xx";
  if (c >= 400) return "status-4xx";
  if (c >= 300) return "status-3xx";
  if (c >= 200) return "status-2xx";
  return "";
}

function headersObjToLines(obj) {
  if (!obj) return "";
  return Object.entries(obj).map(([k, v]) => `${k}: ${v}`).join("\n");
}

// RFC 2047 encoded-word decoder. Handles =?charset?B?...?= and =?charset?Q?...?=
// in email headers (subject lines, display names, etc.). Linear whitespace between
// adjacent encoded-words is eaten per the spec. Returns the input unchanged on
// failure or if there are no encoded-words to decode.
function decodeMimeWord(s) {
  if (!s || typeof s !== "string") return s;
  const stripped = s.replace(/\?=\s+=\?/g, "?==?");
  return stripped.replace(/=\?([^?]+)\?([BQ])\?([^?]*)\?=/gi, (match, charset, encoding, encoded) => {
    try {
      let bytes;
      if (encoding.toUpperCase() === "B") {
        const bin = atob(encoded);
        bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      } else {
        const buf = [];
        for (let i = 0; i < encoded.length;) {
          const ch = encoded[i];
          if (ch === "_") { buf.push(0x20); i++; }
          else if (ch === "=" && i + 2 < encoded.length) {
            buf.push(parseInt(encoded.slice(i + 1, i + 3), 16));
            i += 3;
          } else { buf.push(encoded.charCodeAt(i)); i++; }
        }
        bytes = new Uint8Array(buf);
      }
      return new TextDecoder(charset).decode(bytes);
    } catch {
      return match;
    }
  });
}

function highlightJson(str) {
  if (!str) return null;
  const escape = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const html = escape(str).replace(
    /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
    (m, str, isKey, bool, num) => {
      if (str) return isKey ? `<span class="k">${str}</span>${isKey}` : `<span class="s">${str}</span>`;
      if (bool) return `<span class="b">${bool}</span>`;
      if (num) return `<span class="n">${num}</span>`;
      return m;
    }
  );
  return { __html: html };
}

function tryPretty(s) {
  try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return s; }
}

function fmtBytes(n) {
  if (!n) return "0 B";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / 1024 / 1024).toFixed(2) + " MB";
}

function stripOrigin(url) {
  try { const u = new URL(url); return u.pathname + u.search; } catch { return url; }
}

// ---- Toasts ----

const ToastCtx = React.createContext(null);
function useToast() { return React.useContext(ToastCtx); }

function ToastProvider({ children }) {
  const [items, setItems] = useState([]);
  const push = useCallback((msg, kind = "info") => {
    const id = Math.random().toString(36).slice(2);
    setItems((xs) => [...xs, { id, msg, kind }]);
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), 3200);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts">
        {items.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            <span style={{ color: t.kind === "error" ? "var(--red)" : t.kind === "success" ? "var(--green)" : "var(--f1)" }}>
              {t.kind === "error" ? "✕" : t.kind === "success" ? "✓" : "ℹ"}
            </span>
            <span>{t.msg}</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

// ---- Modal ----

function Modal({ open, onClose, children, wide }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className={`modal ${wide ? "wide" : ""}`} onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}

function ModalHead({ title, id, onClose, right }) {
  return (
    <div className="modal-head">
      <span className="title">{title}</span>
      {id ? <span className="id">{id}</span> : null}
      {right}
      <button className="close" onClick={onClose} aria-label="Close">
        <svg width="14" height="14" viewBox="0 0 14 14"><path stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" d="M3 3l8 8M11 3l-8 8"/></svg>
      </button>
    </div>
  );
}

// ---- Confirm ----

const ConfirmCtx = React.createContext(null);
function useConfirm() { return React.useContext(ConfirmCtx); }

function ConfirmProvider({ children }) {
  const [state, setState] = useState(null);
  const ask = useCallback((opts) => new Promise((resolve) => {
    setState({ ...opts, resolve });
  }), []);
  const handle = (ok) => {
    if (state) state.resolve(ok);
    setState(null);
  };
  return (
    <ConfirmCtx.Provider value={ask}>
      {children}
      {state && (
        <div className="modal-backdrop" onClick={() => handle(false)}>
          <div className="confirm" onClick={(e) => e.stopPropagation()}>
            <h3>{state.title || "Confirm"}</h3>
            <p>{state.message}</p>
            <div className="actions">
              <button className="btn ghost" onClick={() => handle(false)}>Cancel</button>
              <button
                className={`btn ${state.danger ? "danger" : "primary"}`}
                onClick={() => handle(true)}
                autoFocus
              >
                {state.confirmLabel || "Confirm"}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmCtx.Provider>
  );
}

// ---- Blacklist context ----
//
// Backed by the D1-backed API rather than localStorage (the worker is the
// source of truth — the frontend just mirrors the lists for snappy
// "is this blocked?" checks in modals and the Settings panel). On mount,
// fetches both lists. Mutations update local state optimistically after a
// successful API call. Worker propagation lag is up to 60s due to the
// edge cache; the dashboard's view is instant.

const BlacklistCtx = React.createContext(null);
function useBlacklist() { return React.useContext(BlacklistCtx); }

function BlacklistProvider({ children }) {
  // Each list is an array of {ip|email, ts, note}. We also keep a Set of the
  // bare values for O(1) `isBlocked` checks.
  const [ips, setIps] = useState([]);
  const [emails, setEmails] = useState([]);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [ipRows, emailRows] = await Promise.all([
        API.listBlacklistIps(),
        API.listBlacklistEmails(),
      ]);
      setIps(Array.isArray(ipRows) ? ipRows : []);
      setEmails(Array.isArray(emailRows) ? emailRows : []);
    } catch {
      // Best-effort load. If it fails we just don't show "blacklisted" tags.
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const ipSet = useMemo(() => new Set(ips.map((r) => r.ip)), [ips]);
  const emailSet = useMemo(() => new Set(emails.map((r) => r.email)), [emails]);

  const addIp = useCallback(async (ip) => {
    const v = String(ip || '').trim();
    if (!v) return { ok: false, already: false };
    if (ipSet.has(v)) return { ok: true, already: true };
    await API.addBlacklistIp(v);
    setIps((xs) => xs.some((r) => r.ip === v) ? xs : [{ ip: v, ts: new Date().toISOString(), note: null }, ...xs]);
    return { ok: true, already: false };
  }, [ipSet]);

  const removeIp = useCallback(async (ip) => {
    await API.removeBlacklistIp(ip);
    setIps((xs) => xs.filter((r) => r.ip !== ip));
  }, []);

  const addEmail = useCallback(async (email) => {
    const v = normalizeEmail(email);
    if (!v) return { ok: false, already: false };
    if (emailSet.has(v)) return { ok: true, already: true };
    await API.addBlacklistEmail(v);
    setEmails((xs) => xs.some((r) => r.email === v) ? xs : [{ email: v, ts: new Date().toISOString(), note: null }, ...xs]);
    return { ok: true, already: false };
  }, [emailSet]);

  const removeEmail = useCallback(async (email) => {
    await API.removeBlacklistEmail(email);
    setEmails((xs) => xs.filter((r) => r.email !== email));
  }, []);

  const isIpBlocked = useCallback((ip) => ipSet.has(String(ip || '').trim()), [ipSet]);
  const isSenderBlocked = useCallback((email) => emailSet.has(normalizeEmail(email)), [emailSet]);

  const value = {
    loaded,
    ips, addIp, removeIp, isIpBlocked,
    emails, addEmail, removeEmail, isSenderBlocked,
  };
  return <BlacklistCtx.Provider value={value}>{children}</BlacklistCtx.Provider>;
}

// ---- Debounce hook ----

function useDebouncedValue(value, ms) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

// ---- Icons ----

const Icon = {
  chevron: () => <svg width="11" height="11" viewBox="0 0 12 12"><path d="M4 2l4 4-4 4" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" strokeLinejoin="round"/></svg>,
  search: () => <svg width="13" height="13" viewBox="0 0 14 14"><circle cx="6" cy="6" r="4" stroke="currentColor" strokeWidth="1.3" fill="none"/><path d="M9 9l3 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>,
  link: () => <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"><path d="M5.5 8.5l3-3M6 9.5l-1.2 1.2a2 2 0 1 1-2.8-2.8L3.2 6.7M8 4.5l1.2-1.2a2 2 0 1 1 2.8 2.8L10.8 7.3"/></svg>,
  req: () => <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3"><path d="M2 4h10M2 7h7M2 10h10"/></svg>,
  mail: () => <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3"><rect x="1.5" y="2.5" width="11" height="9" rx="1"/><path d="M1.5 4l5.5 4 5.5-4"/></svg>,
  doc: () => <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3"><path d="M3 1.5h5l3 3v8H3z"/><path d="M8 1.5V5h3"/></svg>,
  paper: () => <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3"><path d="M8.5 3v6a2.5 2.5 0 0 1-5 0V3a1.5 1.5 0 1 1 3 0v6a.5.5 0 0 1-1 0V4"/></svg>,
  refresh: () => <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"><path d="M11.5 6.5A4.5 4.5 0 0 0 3.7 4"/><path d="M2.5 7.5A4.5 4.5 0 0 0 10.3 10"/><path d="M11.5 2.5v4h-4M2.5 11.5v-4h4"/></svg>,
  pin: () => <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"><path d="M9.5 1.5l3 3-2 1-3.5 3.5.5 2.5-4-4-3 1.5 1.5-3-4-4 2.5.5L4 1l1 3z"/></svg>,
  x: () => <svg width="10" height="10" viewBox="0 0 10 10"><path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>,
};

// expose
Object.assign(window, {
  React, useState, useEffect, useRef, useCallback, useMemo,
  API,
  fmtTime, fmtTimeFull, statusClass, headersObjToLines, decodeMimeWord, normalizeEmail, highlightJson, tryPretty, fmtBytes, stripOrigin,
  lsGet, lsSet,
  BlacklistProvider, useBlacklist,
  ToastProvider, useToast, Modal, ModalHead,
  ConfirmProvider, useConfirm, useDebouncedValue, Icon,
});
