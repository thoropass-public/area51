// Endpoints, Requests, Emails tabs

// ----------------------------------------------------------------
// Generic List view
// ----------------------------------------------------------------
function ListView({
  search, setSearch,
  pins, onPin, onUnpin, onClearPins,
  pinPlaceholder, pinColor, specialPins,
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
            {hasPins && pins.map((p) => {
              const sp = specialPins && specialPins[p];
              const cv = pinColorVars(pinColor && pinColor(p));
              return (
                <span
                  key={p}
                  className={`pin-chip${sp ? " pin-special" : ""}`}
                  title={sp ? sp.title : `Pinned filter "${p}" — click × to remove`}
                  style={{ background: cv.soft, borderColor: cv.edge, color: cv.base }}
                >
                  <span className="pin-glyph" style={{ color: cv.base }}>{sp ? sp.glyph : <Icon.pin/>}</span>
                  <span className="pin-val">{sp ? sp.label : p}</span>
                  <button
                    className="pin-x"
                    onClick={() => onUnpin && onUnpin(p)}
                    aria-label={`Remove pin ${sp ? sp.label : p}`}
                  >
                    <Icon.x/>
                  </button>
                </span>
              );
            })}
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

// Pin state + colors live in usePinnedFilters (ui.jsx), persisted under
// `area51:pins:<tab>` (values) and `area51:pins:<tab>:colors` (color map).

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
  const { pins, addPin, removePin, clearPins, colors, pinColor } = usePinnedFilters("endpoints");
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
        pins={pins} onPin={addPin} onUnpin={removePin} onClearPins={clearPins} pinColor={pinColor}
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
          <EndpointRow
            key={r.uri}
            row={r}
            active={activeId === r.uri}
            matches={pinMatches(pins, colors, r.uri)}
            onOpen={() => open(r.uri)}
          />
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

// Endpoint row. The leading icon is a copy button: it copies the full URL
// (https:// + the active default host + the URI) and never opens the edit
// modal. Clicking anywhere else on the row opens the editor.
function EndpointRow({ row, active, matches, onOpen }) {
  const toast = useToast();
  const [activeDomain] = useActiveDomain();
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef(null);
  useEffect(() => () => clearTimeout(copyTimer.current), []);

  const copyUrl = async (e) => {
    e.stopPropagation();
    if (!activeDomain) { toast("No default host selected — pick one on Home", "error"); return; }
    const url = `https://${activeDomain}${row.uri}`;
    const ok = await copyText(url);
    if (!ok) { toast("Copy failed", "error"); return; }
    setCopied(true);
    clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(false), 1400);
    toast(`Copied ${activeDomain}${row.uri}`, "success");
  };

  return (
    <div
      className={`row endpoint-grid ${active ? "active" : ""}${matches.length ? " has-ribbon" : ""}`}
      onClick={onOpen}
    >
      <PinRibbon matches={matches}/>
      <button
        type="button"
        className={`row-icon copy-link${copied ? " copied" : ""}`}
        onClick={copyUrl}
        title={activeDomain ? `Copy https://${activeDomain}${row.uri}` : "Pick a default host on Home to copy URLs"}
        aria-label="Copy endpoint URL to clipboard"
      >
        {copied ? <Icon.check/> : <Icon.link/>}
      </button>
      <span className="mono cell-trunc" title={row.uri}>{row.uri}</span>
      <span><span className={`status-tag ${statusClass(row.status)}`}>{row.status}</span></span>
    </div>
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
  const { pins, addPin, removePin, clearPins, colors, pinColor } = usePinnedFilters("requests");
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
        pins={pins} onPin={addPin} onUnpin={removePin} onClearPins={clearPins} pinColor={pinColor}
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
        renderRow={(r) => {
          const matches = pinMatches(pins, colors, r.url);
          return (
            <div
              key={r.id}
              className={`row request-grid ${activeId === r.id ? "active" : ""}${matches.length ? " has-ribbon" : ""}`}
              onClick={() => setActiveId(r.id)}
            >
              <PinRibbon matches={matches}/>
              <span className="row-icon"><Icon.req/></span>
              <span className="mono" style={{color:"var(--n4)"}}>{fmtTime(r.ts)}</span>
              <span><span className={`method-tag method-${r.method}`}>{r.method}</span></span>
              <span className="mono cell-trunc" title={r.url}>{stripOrigin(r.url)}</span>
              <span className="mono" style={{color:"var(--n4)"}}>{r.ip}</span>
            </div>
          );
        }}
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

const STAR_TOKEN = ":star:";

function EmailsTab() {
  const toast = useToast();
  const [search, setSearch] = useState("");
  const dq = useDebouncedValue(search, 300);
  const { pins, addPin, removePin, clearPins, colors, pinColor } = usePinnedFilters("emails");
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [activeId, setActiveId] = useState(null);

  // ":star:" is a special pin (and a live preview while typing it) that filters
  // to starred mail. It's not a recipient search term, so we split it out and
  // pass starredOnly to the API; text pins still combine with it via OR.
  const starredPinned = pins.includes(STAR_TOKEN);
  const textPins = useMemo(() => pins.filter((p) => p !== STAR_TOKEN), [pins]);
  const liveStar = dq.trim().toLowerCase() === STAR_TOKEN;
  const effStarredOnly = starredPinned || liveStar;
  const terms = useMemo(
    () => effectiveSearch(liveStar ? "" : dq, textPins),
    [liveStar, dq, textPins]
  );

  // Map ":star:" (any case) to the canonical token so it renders as the star chip.
  const addPinNorm = useCallback((v) => {
    const t = String(v || "").trim().toLowerCase();
    return addPin(t === STAR_TOKEN ? STAR_TOKEN : v);
  }, [addPin]);

  const fetchFirst = useCallback(async () => {
    setLoading(true);
    try {
      const r = await API.listEmails({ search: terms, starred: effStarredOnly });
      setRows(r);
      setHasMore(r.length === 50);
    } catch (e) {
      toast("Failed to load emails: " + e.message, "error");
      setRows([]); setHasMore(false);
    } finally {
      setLoading(false);
    }
  }, [terms, effStarredOnly, toast]);

  useEffect(() => { fetchFirst(); }, [fetchFirst]);

  const loadMore = async () => {
    if (rows.length === 0) return;
    setLoadingMore(true);
    try {
      const cursor = rows[rows.length - 1].ts;
      const r = await API.listEmails({ search: terms, starred: effStarredOnly, cursor });
      setRows((xs) => [...xs, ...r]);
      setHasMore(r.length === 50);
    } catch (e) {
      toast("Failed to load more: " + e.message, "error");
    } finally {
      setLoadingMore(false);
    }
  };

  // Per-email read/starred state is DB-backed (PATCH /api/emails/<id>). We update
  // the row optimistically and roll back on failure. Autopilot never writes these.
  const patchRow = (id, patch) =>
    setRows((xs) => xs.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  const markRead = async (id) => {
    const row = rows.find((r) => r.id === id);
    if (!row || row.read) return;
    patchRow(id, { read: 1 });
    try { await API.setEmailFlags(id, { read: true }); }
    catch (e) { patchRow(id, { read: 0 }); toast("Couldn't mark read: " + e.message, "error"); }
  };

  const toggleRead = async (id) => {
    const row = rows.find((r) => r.id === id);
    if (!row) return;
    const next = row.read ? 0 : 1;
    patchRow(id, { read: next });
    try { await API.setEmailFlags(id, { read: !!next }); }
    catch (e) { patchRow(id, { read: row.read }); toast("Couldn't update: " + e.message, "error"); }
  };

  const toggleStar = async (id) => {
    const row = rows.find((r) => r.id === id);
    if (!row) return;
    const next = row.starred ? 0 : 1;
    patchRow(id, { starred: next });
    try { await API.setEmailFlags(id, { starred: !!next }); }
    catch (e) { patchRow(id, { starred: row.starred }); toast("Couldn't update star: " + e.message, "error"); return; }
    // While the star filter is active, a row that's just been unstarred no
    // longer belongs in the list — refetch to drop it.
    if (effStarredOnly && !next) fetchFirst();
  };

  const open = (id) => { markRead(id); setActiveId(id); };

  const activeRow = rows.find((r) => r.id === activeId);

  return (
    <>
      <ListView
        search={search} setSearch={setSearch}
        pins={pins} onPin={addPinNorm} onUnpin={removePin} onClearPins={clearPins} pinColor={pinColor}
        specialPins={{ [STAR_TOKEN]: { label: "starred", glyph: <Icon.starOn/>, title: "Showing starred only — click × to remove" } }}
        onRefresh={fetchFirst}
        pinPlaceholder="Search recipients…  ↵ to pin  ·  :star: for starred"
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
          <span></span>
        </>}
        emptyText={effStarredOnly && !textPins.length ? "no starred emails" : ((search || pins.length) ? "no emails match these filters" : "no emails captured yet")}
        renderRow={(r) => (
          <EmailRow
            key={r.id}
            row={r}
            active={activeId === r.id}
            matches={pinMatches(pins, colors, r.to_addr, !!r.starred)}
            onOpen={() => open(r.id)}
            onToggleRead={() => toggleRead(r.id)}
            onToggleStar={() => toggleStar(r.id)}
          />
        )}
      />
      {activeId && (
        <EmailModal
          id={activeId}
          starred={!!(activeRow && activeRow.starred)}
          onToggleStar={() => toggleStar(activeId)}
          onClose={() => setActiveId(null)}
        />
      )}
    </>
  );
}

// Email row. Unread is the bright state (frost left rail, closed envelope, bold
// subject); read is muted with an open envelope. The leading envelope toggles
// read ↔ unread without opening; the trailing star toggles starred. When pin
// ribbons are present they take over the left edge from the unread rail.
function EmailRow({ row, active, matches, onOpen, onToggleRead, onToggleStar }) {
  const unread = !row.read;
  const starred = !!row.starred;
  return (
    <div
      className={`row email-grid ${active ? "active" : ""} ${unread ? "unread" : "read"}${matches.length ? " has-ribbon" : ""}`}
      onClick={onOpen}
    >
      <PinRibbon matches={matches}/>
      <button
        type="button"
        className="row-icon mail-toggle"
        onClick={(e) => { e.stopPropagation(); onToggleRead(); }}
        title={unread ? "Mark as read" : "Mark as unread"}
        aria-label={unread ? "Mark as read" : "Mark as unread"}
      >
        {unread ? <Icon.mail/> : <Icon.mailOpen/>}
      </button>
      <span className="mono" style={{color:"var(--n4)"}}>{fmtTime(row.ts)}</span>
      <span className="mono cell-trunc from" title={decodeMimeWord(row.from_addr)}>{decodeMimeWord(row.from_addr)}</span>
      <span className="mono cell-trunc" style={{color:"var(--n4)"}} title={decodeMimeWord(row.to_addr)}>{decodeMimeWord(row.to_addr)}</span>
      <span className="cell-trunc subject" title={decodeMimeWord(row.subject)}>{decodeMimeWord(row.subject)}</span>
      <button
        type="button"
        className={`star-toggle${starred ? " on" : ""}`}
        onClick={(e) => { e.stopPropagation(); onToggleStar(); }}
        title={starred ? "Unstar" : "Star"}
        aria-label={starred ? "Unstar email" : "Star email"}
        aria-pressed={starred}
      >
        {starred ? <Icon.starOn/> : <Icon.star/>}
      </button>
    </div>
  );
}

function EmailModal({ id, starred, onToggleStar, onClose }) {
  const toast = useToast();
  const confirm = useConfirm();
  const bl = useBlacklist();
  const [data, setData] = useState(null);
  const [expanded, setExpanded] = useState(null);   // { buf: ArrayBuffer, parsed }
  const [expanding, setExpanding] = useState(false);
  const [expandError, setExpandError] = useState(null);
  const [bodyView, setBodyView] = useState("html");

  useEffect(() => {
    let live = true;
    API.getEmail(id).then((d) => { if (live) setData(d); })
      .catch((e) => { if (live) toast("Failed to load email: " + e.message, "error"); });
    return () => { live = false; };
  }, [id, toast]);

  const blockSender = async () => {
    if (!data) return;
    const addr = normalizeEmail(data.from_addr);
    if (!addr) { toast("Could not parse sender address", "error"); return; }
    const ok = await confirm({
      title: "Blacklist sender",
      message: `Drop all future mail from ${addr}? Cloudflare's MX will continue accepting messages, but the worker will reject them without writing to D1 or storing the raw email. Existing captured rows are not affected.`,
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

  // "More": fetch the raw .eml from R2 and parse it in-browser with postal-mime.
  const expand = async () => {
    if (expanding || expanded) return;
    setExpanding(true);
    setExpandError(null);
    try {
      const buf = await API.getEmailRaw(id);          // ArrayBuffer
      if (!window.PostalMime) throw new Error("Email parser still loading — try again in a moment");
      const p = await window.PostalMime.parse(buf);
      const parsed = {
        headers: Array.isArray(p.headers) ? p.headers : [],
        html: p.html || "",
        text: p.text || "",
        attachments: (p.attachments || []).map((a) => ({
          filename: a.filename || "",
          mimeType: a.mimeType || "application/octet-stream",
          content: a.content,
          size: a.content ? (a.content.byteLength || a.content.length || 0) : 0,
        })),
      };
      setExpanded({ buf, parsed });
      setBodyView(parsed.html ? "html" : "text");
    } catch (e) {
      setExpandError(e.message || String(e));
    } finally {
      setExpanding(false);
    }
  };

  const downloadRaw = () => {
    if (!expanded) return;
    const name = filenameFor(data);
    triggerDownload(new Blob([expanded.buf], { type: "message/rfc822" }), name);
    toast("Downloaded " + name, "success");
  };

  const downloadAttachment = (att) => {
    const name = att.filename || "attachment.bin";
    triggerDownload(new Blob([att.content], { type: att.mimeType || "application/octet-stream" }), name);
    toast("Downloaded " + name, "success");
  };

  return (
    <Modal open onClose={onClose} wide>
      <ModalHead title="EMAIL" id={data ? data.id : null} onClose={onClose} right={
        <button
          type="button"
          className={`modal-star${starred ? " on" : ""}`}
          onClick={onToggleStar}
          title={starred ? "Unstar" : "Star"}
          aria-label={starred ? "Unstar email" : "Star email"}
          aria-pressed={starred}
        >
          {starred ? <Icon.starOn/> : <Icon.star/>}
        </button>
      }/>
      <div className="modal-body">
        {!data ? (
          <div className="loading"><span className="spinner"/> loading…</div>
        ) : (
          <>
            <dl className="detail-grid">
              <dt>From</dt><dd><FromCell from={data.from_addr} onBlock={blockSender}/></dd>
              <dt>To</dt><dd>{decodeMimeWord(data.to_addr)}</dd>
              <dt>Subject</dt><dd style={{color:"var(--s2)"}}>{decodeMimeWord(data.subject)}</dd>
              <dt>Received</dt><dd>{fmtTimeFull(data.ts)}</dd>
              {data.attachment_count > 0 && (
                <>
                  <dt>Attachments</dt>
                  <dd>
                    <span className="att-count">{data.attachment_count} {data.attachment_count === 1 ? "file" : "files"}</span>
                    {!expanded && <span className="att-hint"> · expand for details</span>}
                  </dd>
                </>
              )}
            </dl>

            {expanded && (
              <div className="section">
                <details className="headers-collapse">
                  <summary>
                    <span className="caret"><Icon.chevron/></span>
                    Headers <span style={{color:"var(--n4)", fontWeight:400}}>· {expanded.parsed.headers.length}</span>
                  </summary>
                  <pre className="code-block">
                    {expanded.parsed.headers.map((h) => `${h.key}: ${decodeMimeWord(h.value)}`).join("\n")}
                  </pre>
                </details>
              </div>
            )}

            <div className="section">
              <div className="section-title section-title-toggle">
                <span>Body</span>
                {expanded && expanded.parsed.html && expanded.parsed.text && (
                  <div className="toggle-group">
                    <button className={bodyView === "html" ? "active" : ""} onClick={() => setBodyView("html")}>HTML</button>
                    <button className={bodyView === "text" ? "active" : ""} onClick={() => setBodyView("text")}>Plain</button>
                  </div>
                )}
              </div>
              {expanded && bodyView === "html" && expanded.parsed.html ? (
                <div className="iframe-wrap">
                  <iframe sandbox="" srcDoc={expanded.parsed.html} title="email html"/>
                </div>
              ) : (
                <pre className="code-block wrap">
                  {expanded ? (expanded.parsed.text || "(no plain text part)") : (data.text || "(no plain-text body stored — click More for the full email)")}
                </pre>
              )}
            </div>

            {expandError && (
              <div className="notice notice-error">
                <span className="glyph">!</span>
                <span>Couldn't load full email: {expandError}</span>
              </div>
            )}

            {expanded && expanded.parsed.attachments.length > 0 && (
              <div className="section">
                <div className="section-title">
                  Attachments <span style={{color:"var(--n4)", fontWeight:400}}>· {expanded.parsed.attachments.length}</span>
                  <span className="att-hint" style={{marginLeft:"8px", textTransform:"none", letterSpacing:0}}>click to download</span>
                </div>
                <div className="attachment-list">
                  {expanded.parsed.attachments.map((a, i) => (
                    <button
                      key={i}
                      className="attachment attachment-row"
                      onClick={() => downloadAttachment(a)}
                      title="Download attachment"
                    >
                      <span className="ico"><Icon.paper/></span>
                      <span className="name">{a.filename || "(unnamed)"}</span>
                      <span className="mime">{a.mimeType}</span>
                      <span className="size">{fmtBytes(a.size)}</span>
                      <span className="dl-affordance" aria-hidden="true">
                        <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M7 1.5v8M4 6.5l3 3 3-3M2 12h10"/>
                        </svg>
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
      <div className="modal-foot">
        {data && (
          expanded ? (
            <button className="btn" onClick={downloadRaw} title="Download raw .eml">
              <span className="dl-glyph" aria-hidden="true">
                <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M7 1.5v8M4 6.5l3 3 3-3M2 12h10"/>
                </svg>
              </span>
              Download Raw
            </button>
          ) : (
            <button className="btn" onClick={expand} disabled={expanding}>
              {expanding ? <><span className="spinner"/> loading</> : "More"}
            </button>
          )
        )}
        <div className="spacer"/>
        <button className="btn ghost" onClick={onClose}>Close</button>
      </div>
    </Modal>
  );
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 500);
}

// <ts>__<sanitized-subject>.eml
function filenameFor(data) {
  const ts = (data.ts || "").replace(/[:.]/g, "-").replace("T", "_").replace(/Z$/, "");
  const subj = (data.subject || "email")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "email";
  return `${ts || "email"}__${subj}.eml`;
}

function FromCell({ from, onBlock }) {
  const bl = useBlacklist();
  const addr = normalizeEmail(from);
  return (
    <span className="dd-with-action">
      <span>{decodeMimeWord(from)}</span>
      {bl.isSenderBlocked(addr) ? (
        <span className="blocked-tag" title="This sender is currently blacklisted">
          <span className="ban-glyph">⊘</span> blacklisted
        </span>
      ) : (
        <button className="ban-btn" onClick={onBlock} title="Blacklist this sender">
          <span className="ban-glyph">⊘</span> blacklist
        </button>
      )}
    </span>
  );
}

// expose
Object.assign(window, { EndpointsTab, RequestsTab, EmailsTab });
