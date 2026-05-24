// Endpoints, Requests, Emails tabs

// ----------------------------------------------------------------
// Generic List view
// ----------------------------------------------------------------
function ListView({
  search, setSearch,
  pins, onPin, onUnpin, onClearPins,
  pinPlaceholder,
  rows, loading, hasMore, onLoadMore, loadingMore,
  onRefresh,
  header, renderRow, emptyText, gridClass, total,
  rightToolbar,
}) {
  const canPin = !!(search && search.trim());
  const hasPins = Array.isArray(pins) && pins.length > 0;
  const [refreshing, setRefreshing] = useState(false);
  const handleRefresh = async () => {
    if (!onRefresh || refreshing) return;
    setRefreshing(true);
    try { await onRefresh(); } finally {
      // Small delay so the spin animation registers visually even on a fast call.
      setTimeout(() => setRefreshing(false), 250);
    }
  };
  const onKeyDown = (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (canPin && onPin) {
        const ok = onPin(search.trim());
        if (ok) setSearch("");
      }
    } else if (e.key === "Backspace" && search === "" && hasPins) {
      onUnpin && onUnpin(pins[pins.length - 1]);
    } else if (e.key === "Escape") {
      setSearch("");
    }
  };
  return (
    <>
      <div className="toolbar">
        <div className="search-wrap">
          <span className="icon"><Icon.search/></span>
          <div className="pin-strip">
            {hasPins && pins.map((p) => (
              <span key={p} className="pin-chip" title={`Pinned filter "${p}" — click × to remove`}>
                <span className="pin-glyph"><Icon.pin/></span>
                <span className="pin-val">{p}</span>
                <button
                  className="pin-x"
                  onClick={() => onUnpin && onUnpin(p)}
                  aria-label={`Remove pin ${p}`}
                >
                  <Icon.x/>
                </button>
              </span>
            ))}
            <input
              type="text"
              placeholder={hasPins ? "+ filter" : (pinPlaceholder || "Search…  ↵ to pin")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={onKeyDown}
            />
          </div>
          {canPin && onPin && (
            <button
              className="pin-add"
              onClick={() => {
                const ok = onPin(search.trim());
                if (ok) setSearch("");
              }}
              title="Pin this filter (Enter)"
              aria-label="Pin filter"
            >
              <Icon.pin/>
            </button>
          )}
          {(search || hasPins) && (
            <button
              className="clear"
              onClick={() => { setSearch(""); if (hasPins && onClearPins) onClearPins(); }}
              title={hasPins ? "Clear search and pins" : "Clear"}
            >
              clear
            </button>
          )}
        </div>
        {rightToolbar}
        <div className="toolbar-meta">
          {hasPins && (
            <span className="meta-filter">{pins.length} pinned · OR</span>
          )}
          <span>{total} loaded</span>
          {onRefresh && (
            <button
              className={`refresh-btn ${refreshing ? "spinning" : ""}`}
              onClick={handleRefresh}
              disabled={refreshing}
              title="Refresh"
              aria-label="Refresh"
            >
              <Icon.refresh/>
            </button>
          )}
        </div>
      </div>
      <div className="content">
        <div className={`table-header ${gridClass}`}>{header}</div>
        {loading && rows.length === 0 && (
          <div className="loading"><span className="spinner"/> querying…</div>
        )}
        {!loading && rows.length === 0 && (
          <div className="empty">
            <div className="glyph">∅</div>
            {emptyText}
          </div>
        )}
        {rows.map(renderRow)}
        {rows.length > 0 && (
          <div className="loadmore-wrap">
            {hasMore ? (
              <button className="btn" onClick={onLoadMore} disabled={loadingMore}>
                {loadingMore ? <><span className="spinner"/> loading</> : "Load more"}
              </button>
            ) : (
              <span className="meta">— end of results —</span>
            )}
          </div>
        )}
      </div>
    </>
  );
}

// Shared hook: pins state persisted to localStorage under `area51:pins:<tab>`.
// Returns { pins, addPin, removePin, clearPins }. addPin returns true if the
// input was non-empty (so the caller can clear the search field); the dedupe
// (case-insensitive) happens inside the setPins updater and is a no-op when
// already pinned. We deliberately do NOT track "was this actually added" via
// a closure variable — React 18 may run setState updaters lazily, so the
// closure read can be stale at return time.
function usePins(tab) {
  const key = `area51:pins:${tab}`;
  const [pins, setPins] = useState(() => {
    const raw = lsGet(key, []);
    return Array.isArray(raw) ? raw.filter((x) => typeof x === "string" && x.length > 0) : [];
  });
  useEffect(() => { lsSet(key, pins); }, [key, pins]);
  const addPin = useCallback((value) => {
    const v = String(value || "").trim();
    if (!v) return false;
    setPins((xs) => (xs.some((p) => p.toLowerCase() === v.toLowerCase()) ? xs : [...xs, v]));
    return true;
  }, []);
  const removePin = useCallback((value) => {
    setPins((xs) => xs.filter((x) => x !== value));
  }, []);
  const clearPins = useCallback(() => setPins([]), []);
  return { pins, addPin, removePin, clearPins };
}

// Build the effective list of search terms = current input (if any) + pins.
function effectiveSearch(input, pins) {
  const trimmed = (input || "").trim();
  const all = [...(pins || [])];
  if (trimmed && !all.includes(trimmed)) all.push(trimmed);
  return all;
}

// ----------------------------------------------------------------
// Endpoints
// ----------------------------------------------------------------

function EndpointsTab() {
  const toast = useToast();
  const confirm = useConfirm();

  const [search, setSearch] = useState("");
  const dq = useDebouncedValue(search, 300);
  const { pins, addPin, removePin, clearPins } = usePins("endpoints");
  const terms = useMemo(() => effectiveSearch(dq, pins), [dq, pins]);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [activeId, setActiveId] = useState(null);
  const [modal, setModal] = useState(null); // {mode:'edit'|'new', uri?}

  const fetchFirst = useCallback(async () => {
    setLoading(true);
    try {
      const r = await API.listEndpoints({ search: terms });
      setRows(r);
      setHasMore(r.length === 50);
    } catch (e) {
      toast("Failed to load endpoints: " + e.message, "error");
      setRows([]);
      setHasMore(false);
    } finally {
      setLoading(false);
    }
  }, [terms, toast]);

  useEffect(() => { fetchFirst(); }, [fetchFirst]);

  const loadMore = async () => {
    if (rows.length === 0) return;
    setLoadingMore(true);
    try {
      const cursor = rows[rows.length - 1].uri;
      const r = await API.listEndpoints({ search: terms, cursor });
      setRows((xs) => [...xs, ...r]);
      setHasMore(r.length === 50);
    } catch (e) {
      toast("Failed to load more: " + e.message, "error");
    } finally {
      setLoadingMore(false);
    }
  };

  const open = (uri) => {
    setActiveId(uri);
    setModal({ mode: "edit", uri });
  };

  const handleSaved = async () => {
    setModal(null);
    setActiveId(null);
    await fetchFirst();
    toast("Endpoint saved", "success");
  };

  const handleDelete = async (uri) => {
    const ok = await confirm({
      title: "Delete endpoint",
      message: `Permanently delete ${uri}? Requests to this path will return 404.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await API.deleteEndpoint(uri);
    } catch (e) {
      toast("Delete failed: " + e.message, "error");
      return;
    }
    setModal(null);
    setActiveId(null);
    await fetchFirst();
    toast("Endpoint deleted", "success");
  };

  return (
    <>
      <ListView
        search={search} setSearch={setSearch}
        pins={pins} onPin={addPin} onUnpin={removePin} onClearPins={clearPins}
        onRefresh={fetchFirst}
        pinPlaceholder="Search URIs…  ↵ to pin"
        rows={rows} loading={loading} hasMore={hasMore}
        onLoadMore={loadMore} loadingMore={loadingMore}
        gridClass="endpoint-grid"
        total={rows.length}
        header={<>
          <span></span>
          <span>URI</span>
          <span>Status</span>
        </>}
        emptyText={search ? "no endpoints match that pattern" : "no endpoints configured"}
        rightToolbar={
          <button className="btn primary" onClick={() => setModal({ mode: "new" })}>
            <span className="plus">+</span> New endpoint
          </button>
        }
        renderRow={(r) => (
          <div
            key={r.uri}
            className={`row endpoint-grid ${activeId === r.uri ? "active" : ""}`}
            onClick={() => open(r.uri)}
          >
            <span className="row-icon"><Icon.link/></span>
            <span className="mono cell-trunc" title={r.uri}>{r.uri}</span>
            <span><span className={`status-tag ${statusClass(r.status)}`}>{r.status}</span></span>
          </div>
        )}
      />
      {modal && (
        <EndpointModal
          mode={modal.mode}
          uri={modal.uri}
          onClose={() => { setModal(null); setActiveId(null); }}
          onSaved={handleSaved}
          onDelete={handleDelete}
        />
      )}
    </>
  );
}

function EndpointModal({ mode, uri, onClose, onSaved, onDelete }) {
  const toast = useToast();
  const [loading, setLoading] = useState(mode === "edit");
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ uri: "", status: 200, headers: "Content-Type: text/plain", body: "" });

  useEffect(() => {
    if (mode !== "edit") return;
    let live = true;
    API.getEndpoint(uri).then((d) => {
      if (!live) return;
      let parsedHeaders = {};
      try { parsedHeaders = JSON.parse(d.headers || "{}"); } catch {}
      setForm({
        uri: d.uri,
        status: d.status,
        headers: headersObjToLines(parsedHeaders),
        body: d.body || "",
      });
      setLoading(false);
    }).catch((e) => {
      if (live) toast("Failed to load endpoint: " + e.message, "error");
    });
    return () => { live = false; };
  }, [mode, uri, toast]);

  const update = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    if (mode === "new" && !form.uri.trim()) { toast("URI is required", "error"); return; }
    if (mode === "new" && !form.uri.startsWith("/")) { toast("URI must start with /", "error"); return; }
    setSaving(true);
    try {
      await API.saveEndpoint({
        uri: form.uri.trim(),
        status: Number(form.status) || 200,
        headers: form.headers,
        body: form.body,
      });
      onSaved();
    } catch (e) {
      toast("Save failed: " + e.message, "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open onClose={onClose}>
      <ModalHead
        title={mode === "new" ? "NEW ENDPOINT" : "EDIT ENDPOINT"}
        id={mode === "edit" ? form.uri : undefined}
        onClose={onClose}
      />
      <div className="modal-body">
        {loading ? (
          <div className="loading"><span className="spinner"/> loading…</div>
        ) : (
          <>
            <div className="field">
              <label>URI</label>
              {mode === "edit" ? (
                <div className="readonly-value">{form.uri}</div>
              ) : (
                <input
                  type="text"
                  placeholder="/api/v1/callback"
                  value={form.uri}
                  onChange={(e) => update("uri", e.target.value)}
                  autoFocus
                />
              )}
              <div className="helper">Path the black hole will serve. Must start with /</div>
            </div>

            <div className="field-row">
              <div className="field" style={{marginBottom:0}}>
                <label>Headers</label>
                <textarea
                  value={form.headers}
                  onChange={(e) => update("headers", e.target.value)}
                  spellCheck={false}
                  placeholder="Content-Type: application/json"
                />
                <div className="helper">One header per line, <span style={{fontFamily:"var(--mono)"}}>Key: Value</span></div>
              </div>
              <div className="field" style={{marginBottom:0}}>
                <label>Status</label>
                <input
                  type="number"
                  value={form.status}
                  onChange={(e) => update("status", e.target.value)}
                  min="100" max="599"
                />
                <div className="helper">HTTP status, default 200</div>
              </div>
            </div>

            <div className="field">
              <label>Body</label>
              <textarea
                className="body"
                value={form.body}
                onChange={(e) => update("body", e.target.value)}
                spellCheck={false}
                placeholder="Response body (any text or encoded binary)"
              />
            </div>
          </>
        )}
      </div>
      <div className="modal-foot">
        {mode === "edit" && (
          <button className="btn danger" onClick={() => onDelete(form.uri)} disabled={saving || loading}>
            Delete
          </button>
        )}
        <div className="spacer"/>
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={save} disabled={saving || loading}>
          {saving ? <><span className="spinner"/> saving</> : (mode === "new" ? "Create" : "Save changes")}
        </button>
      </div>
    </Modal>
  );
}

// ----------------------------------------------------------------
// Requests
// ----------------------------------------------------------------

function RequestsTab() {
  const toast = useToast();
  const [search, setSearch] = useState("");
  const dq = useDebouncedValue(search, 300);
  const { pins, addPin, removePin, clearPins } = usePins("requests");
  const terms = useMemo(() => effectiveSearch(dq, pins), [dq, pins]);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [activeId, setActiveId] = useState(null);

  const fetchFirst = useCallback(async () => {
    setLoading(true);
    try {
      const r = await API.listRequests({ search: terms });
      setRows(r);
      setHasMore(r.length === 50);
    } catch (e) {
      toast("Failed to load requests: " + e.message, "error");
      setRows([]); setHasMore(false);
    } finally {
      setLoading(false);
    }
  }, [terms, toast]);

  useEffect(() => { fetchFirst(); }, [fetchFirst]);

  const loadMore = async () => {
    if (rows.length === 0) return;
    setLoadingMore(true);
    try {
      const cursor = rows[rows.length - 1].ts;
      const r = await API.listRequests({ search: terms, cursor });
      setRows((xs) => [...xs, ...r]);
      setHasMore(r.length === 50);
    } catch (e) {
      toast("Failed to load more: " + e.message, "error");
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <>
      <ListView
        search={search} setSearch={setSearch}
        pins={pins} onPin={addPin} onUnpin={removePin} onClearPins={clearPins}
        onRefresh={fetchFirst}
        pinPlaceholder="Search URLs…  ↵ to pin"
        rows={rows} loading={loading} hasMore={hasMore}
        onLoadMore={loadMore} loadingMore={loadingMore}
        gridClass="request-grid"
        total={rows.length}
        header={<>
          <span></span>
          <span>Timestamp</span>
          <span>Method</span>
          <span>URL</span>
          <span>IP</span>
        </>}
        emptyText={search ? "no requests match" : "no requests captured yet"}
        renderRow={(r) => (
          <div
            key={r.id}
            className={`row request-grid ${activeId === r.id ? "active" : ""}`}
            onClick={() => setActiveId(r.id)}
          >
            <span className="row-icon"><Icon.req/></span>
            <span className="mono" style={{color:"var(--n4)"}}>{fmtTime(r.ts)}</span>
            <span><span className={`method-tag method-${r.method}`}>{r.method}</span></span>
            <span className="mono cell-trunc" title={r.url}>{stripOrigin(r.url)}</span>
            <span className="mono" style={{color:"var(--n4)"}}>{r.ip}</span>
          </div>
        )}
      />
      {activeId && (
        <RequestModal
          id={activeId}
          onClose={() => setActiveId(null)}
        />
      )}
    </>
  );
}

function RequestModal({ id, onClose }) {
  const toast = useToast();
  const confirm = useConfirm();
  const bl = useBlacklist();
  const [data, setData] = useState(null);
  useEffect(() => {
    let live = true;
    API.getRequest(id).then((d) => { if (live) setData(d); })
      .catch((e) => { if (live) toast("Failed to load request: " + e.message, "error"); });
    return () => { live = false; };
  }, [id, toast]);

  const blockIp = async () => {
    if (!data) return;
    const ok = await confirm({
      title: "Blacklist IP",
      message: `Drop all future requests from ${data.ip}? The worker will continue serving its configured response but will not write the request to D1. Existing captured rows are not affected.`,
      confirmLabel: "Blacklist",
      danger: true,
    });
    if (!ok) return;
    try {
      const res = await bl.addIp(data.ip);
      if (!res.ok) { toast("Invalid IP", "error"); return; }
      toast(res.already ? `${data.ip} already on list` : `${data.ip} blacklisted`, res.already ? "info" : "success");
    } catch (e) {
      toast("Blacklist failed: " + e.message, "error");
    }
  };

  return (
    <Modal open onClose={onClose} wide>
      <ModalHead title="REQUEST" id={data ? data.id : null} onClose={onClose}/>
      <div className="modal-body">
        {!data ? (
          <div className="loading"><span className="spinner"/> loading…</div>
        ) : (
          <>
            <dl className="detail-grid">
              <dt>Timestamp</dt><dd>{fmtTimeFull(data.ts)}</dd>
              <dt>Method</dt><dd><span className={`method-tag method-${data.method}`}>{data.method}</span></dd>
              <dt>URL</dt><dd>{data.url}</dd>
              <dt>Remote IP</dt>
              <dd className="dd-with-action">
                <span>{data.ip}</span>
                {bl.isIpBlocked(data.ip) ? (
                  <span className="blocked-tag" title="This IP is currently blacklisted">
                    <span className="ban-glyph">⊘</span> blacklisted
                  </span>
                ) : (
                  <button className="ban-btn" onClick={blockIp} title="Blacklist this IP">
                    <span className="ban-glyph">⊘</span> blacklist
                  </button>
                )}
              </dd>
              <dt>User-Agent</dt><dd style={{color:"var(--s0)"}}>{data.ua}</dd>
            </dl>

            <div className="section">
              <details className="headers-collapse">
                <summary>
                  <span className="caret"><Icon.chevron/></span>
                  Headers <span style={{color:"var(--n4)", fontWeight:400}}>· {Object.keys(data.headers || {}).length}</span>
                </summary>
                <pre className="code-block">
                  {Object.entries(data.headers || {}).sort(([a],[b]) => a.localeCompare(b)).map(([k, v]) => `${k}: ${v}`).join("\n")}
                </pre>
              </details>
            </div>

            <div className="section">
              <div className="section-title">Body {data.body ? <span style={{color:"var(--n4)", fontWeight:400}}>· {data.body.length} bytes</span> : <span style={{color:"var(--n4)", fontWeight:400}}>· empty</span>}</div>
              {data.body ? (
                <pre className="code-block wrap json" dangerouslySetInnerHTML={highlightJson(tryPretty(data.body))}/>
              ) : (
                <div className="notice"><span className="glyph">∅</span><span>No request body.</span></div>
              )}
            </div>
          </>
        )}
      </div>
      <div className="modal-foot">
        <div className="spacer"/>
        <button className="btn ghost" onClick={onClose}>Close</button>
      </div>
    </Modal>
  );
}

// ----------------------------------------------------------------
// Emails
// ----------------------------------------------------------------

function EmailsTab() {
  const toast = useToast();
  const [search, setSearch] = useState("");
  const dq = useDebouncedValue(search, 300);
  const { pins, addPin, removePin, clearPins } = usePins("emails");
  const terms = useMemo(() => effectiveSearch(dq, pins), [dq, pins]);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [activeId, setActiveId] = useState(null);

  const fetchFirst = useCallback(async () => {
    setLoading(true);
    try {
      const r = await API.listEmails({ search: terms });
      setRows(r);
      setHasMore(r.length === 50);
    } catch (e) {
      toast("Failed to load emails: " + e.message, "error");
      setRows([]); setHasMore(false);
    } finally {
      setLoading(false);
    }
  }, [terms, toast]);

  useEffect(() => { fetchFirst(); }, [fetchFirst]);

  const loadMore = async () => {
    if (rows.length === 0) return;
    setLoadingMore(true);
    try {
      const cursor = rows[rows.length - 1].ts;
      const r = await API.listEmails({ search: terms, cursor });
      setRows((xs) => [...xs, ...r]);
      setHasMore(r.length === 50);
    } catch (e) {
      toast("Failed to load more: " + e.message, "error");
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <>
      <ListView
        search={search} setSearch={setSearch}
        pins={pins} onPin={addPin} onUnpin={removePin} onClearPins={clearPins}
        onRefresh={fetchFirst}
        pinPlaceholder="Search to addresses…  ↵ to pin"
        rows={rows} loading={loading} hasMore={hasMore}
        onLoadMore={loadMore} loadingMore={loadingMore}
        gridClass="email-grid"
        total={rows.length}
        header={<>
          <span></span>
          <span>Timestamp</span>
          <span>From</span>
          <span>To</span>
          <span>Subject</span>
        </>}
        emptyText={search ? "no emails to that address" : "no emails captured yet"}
        renderRow={(r) => (
          <div
            key={r.id}
            className={`row email-grid ${activeId === r.id ? "active" : ""}`}
            onClick={() => setActiveId(r.id)}
          >
            <span className="row-icon"><Icon.mail/></span>
            <span className="mono" style={{color:"var(--n4)"}}>{fmtTime(r.ts)}</span>
            <span className="mono cell-trunc" style={{color:"var(--s0)"}} title={decodeMimeWord(r.from_addr)}>{decodeMimeWord(r.from_addr)}</span>
            <span className="mono cell-trunc" style={{color:"var(--n4)"}} title={decodeMimeWord(r.to_addr)}>{decodeMimeWord(r.to_addr)}</span>
            <span className="cell-trunc" style={{color:"var(--s1)"}} title={decodeMimeWord(r.subject)}>{decodeMimeWord(r.subject)}</span>
          </div>
        )}
      />
      {activeId && (
        <EmailModal
          id={activeId}
          onClose={() => setActiveId(null)}
        />
      )}
    </>
  );
}

function EmailModal({ id, onClose }) {
  const toast = useToast();
  const confirm = useConfirm();
  const bl = useBlacklist();
  const [data, setData] = useState(null);
  useEffect(() => {
    let live = true;
    API.getEmail(id).then((d) => { if (live) setData(d); })
      .catch((e) => { if (live) toast("Failed to load email: " + e.message, "error"); });
    return () => { live = false; };
  }, [id, toast]);

  const forwarded = data && data.html === "sent_to_fallback";

  const blockSender = async () => {
    if (!data) return;
    const addr = normalizeEmail(data.from_addr);
    if (!addr) { toast("Could not parse sender address", "error"); return; }
    const ok = await confirm({
      title: "Blacklist sender",
      message: `Drop all future mail from ${addr}? Cloudflare's MX will continue accepting messages, but the worker will discard them without writing to D1 or forwarding. Existing captured rows are not affected.`,
      confirmLabel: "Blacklist",
      danger: true,
    });
    if (!ok) return;
    try {
      const res = await bl.addEmail(addr);
      if (!res.ok) { toast("Invalid email address", "error"); return; }
      toast(res.already ? `${addr} already on list` : `${addr} blacklisted`, res.already ? "info" : "success");
    } catch (e) {
      toast("Blacklist failed: " + e.message, "error");
    }
  };

  return (
    <Modal open onClose={onClose} wide>
      <ModalHead title="EMAIL" id={data ? data.id : null} onClose={onClose}/>
      <div className="modal-body">
        {!data ? (
          <div className="loading"><span className="spinner"/> loading…</div>
        ) : (
          <EmailView data={data} forwarded={forwarded} onBlockSender={blockSender}/>
        )}
      </div>
      <div className="modal-foot">
        <div className="spacer"/>
        <button className="btn ghost" onClick={onClose}>Close</button>
      </div>
    </Modal>
  );
}

function EmailView({ data, forwarded, onBlockSender }) {
  const bl = useBlacklist();
  const headers = Array.isArray(data.headers) ? data.headers : [];
  const attachments = Array.isArray(data.attachments) ? data.attachments : [];
  const text = data.text || "";
  const html = forwarded ? "" : (data.html || "");
  const hasText = !!text;
  const hasHtml = !!html;
  const [view, setView] = useState(hasHtml ? "html" : "text");
  const senderBlocked = bl.isSenderBlocked(data.from_addr);

  return (
    <>
      {forwarded && (
        <div className="notice">
          <span className="glyph">!</span>
          <span>This email was forwarded to the fallback inbox due to attachments or size. The full message body is not stored here — check the fallback inbox for the original.</span>
        </div>
      )}

      <div className={forwarded ? "section" : ""}>
        <dl className="detail-grid">
          <dt>From</dt>
          <dd className="dd-with-action">
            <span>{decodeMimeWord(data.from_addr)}</span>
            {senderBlocked ? (
              <span className="blocked-tag" title="This sender is currently blacklisted">
                <span className="ban-glyph">⊘</span> blacklisted
              </span>
            ) : (
              <button className="ban-btn" onClick={onBlockSender} title="Blacklist this sender">
                <span className="ban-glyph">⊘</span> blacklist
              </button>
            )}
          </dd>
          <dt>To</dt><dd>{decodeMimeWord(data.to_addr)}</dd>
          <dt>Subject</dt><dd style={{color:"var(--s2)"}}>{decodeMimeWord(data.subject)}</dd>
          <dt>Received</dt><dd>{fmtTimeFull(data.ts)}</dd>
        </dl>
      </div>

      {headers.length > 0 && (
        <div className="section">
          <details className="headers-collapse">
            <summary>
              <span className="caret"><Icon.chevron/></span>
              Headers <span style={{color:"var(--n4)", fontWeight:400}}>· {headers.length}</span>
            </summary>
            <pre className="code-block">
              {headers.map((h) => `${h.key}: ${decodeMimeWord(h.value)}`).join("\n")}
            </pre>
          </details>
        </div>
      )}

      {(hasHtml || hasText) && (
        <div className="section">
          <div className="section-title" style={{display:"flex", alignItems:"center", justifyContent:"space-between"}}>
            <span>Body</span>
            {hasHtml && hasText && (
              <div className="toggle-group">
                <button className={view === "html" ? "active" : ""} onClick={() => setView("html")}>HTML</button>
                <button className={view === "text" ? "active" : ""} onClick={() => setView("text")}>Plain</button>
              </div>
            )}
          </div>
          {view === "html" && hasHtml && (
            <div className="iframe-wrap">
              <iframe
                sandbox=""
                srcDoc={html}
                title="email html"
              />
            </div>
          )}
          {view === "text" && hasText && (
            <pre className="code-block wrap">{text}</pre>
          )}
        </div>
      )}

      {attachments.length > 0 && (
        <div className="section">
          <div className="section-title">Attachments <span style={{color:"var(--n4)", fontWeight:400}}>· {attachments.length}</span></div>
          <div className="attachment-list">
            {attachments.map((a, i) => (
              <div className="attachment" key={i}>
                <span className="ico"><Icon.paper/></span>
                <span className="name">{a.filename || "(unnamed)"}</span>
                <span className="mime">{a.mime}</span>
                <span className="size">{fmtBytes(a.size)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

// expose
Object.assign(window, { EndpointsTab, RequestsTab, EmailsTab });
