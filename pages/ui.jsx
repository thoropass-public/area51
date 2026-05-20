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

const qs = (params) => {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') sp.set(k, v);
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
};

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
};

// expose
Object.assign(window, {
  React, useState, useEffect, useRef, useCallback, useMemo,
  API,
  fmtTime, fmtTimeFull, statusClass, headersObjToLines, highlightJson, tryPretty, fmtBytes, stripOrigin,
  ToastProvider, useToast, Modal, ModalHead,
  ConfirmProvider, useConfirm, useDebouncedValue, Icon,
});
