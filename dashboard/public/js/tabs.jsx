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
              placeholder={hasPins ? "+ filter" : (pinPlaceholder || "Search…")}
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
        {loading ? (
          // Any full reload (initial load, filter/pin change, refresh) shows the
          // centered loader spanning the list; prior rows are hidden meanwhile.
          // (Load more uses `loadingMore`, not `loading`, so it keeps rows.)
          <div className="loading"><span className="spinner"/> querying…</div>
        ) : rows.length === 0 ? (
          <div className="empty">
            <div className="glyph">∅</div>
            {emptyText}
          </div>
        ) : (
          <>
            {rows.map(renderRow)}
            <div className="loadmore-wrap">
              {hasMore ? (
                <button className="btn" onClick={onLoadMore} disabled={loadingMore}>
                  {loadingMore ? <><span className="spinner"/> loading</> : "Load more"}
                </button>
              ) : (
                <span className="meta">— end of results —</span>
              )}
            </div>
          </>
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
        pinPlaceholder="Search Endpoints…"
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
      <span className="mono cell-trunc uri-cell" title={row.uri}>
        {row.uri}
        {row.filename != null && (
          <span className="file-tag" title={`Serves an uploaded file: ${row.filename || "(unnamed)"}`}>
            <Icon.paper/>
            <span className="cell-trunc">{row.filename || "file"}</span>
          </span>
        )}
      </span>
      <span><span className={`status-tag ${statusClass(row.status)}`}>{row.status}</span></span>
    </div>
  );
}

// Product cap on uploads, checked here so an oversize file never leaves the
// browser. The upload handler re-checks it against Content-Length.
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

function EndpointModal({ mode, uri, onClose, onSaved, onDelete }) {
  const toast = useToast();
  const [loading, setLoading] = useState(mode === "edit");
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ uri: "", status: 200, headers: "Content-Type: text/plain", body: "" });
  // An endpoint is EITHER text-backed or file-backed, never both: a hosted file
  // can't be mixed with a hand-written body or a chosen status. `file` is a
  // picked-but-not-yet-uploaded File; `savedFile` is what the row already serves
  // ({filename, content_type, size, missing}). Either one puts the modal in file
  // mode, where the status/headers/body editors are unmounted rather than
  // disabled, because a grayed-out field still invites a click.
  const [file, setFile] = useState(null);
  const [savedFile, setSavedFile] = useState(null);
  const fileInput = useRef(null);

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
      setSavedFile(d.file || null);
      setLoading(false);
    }).catch((e) => {
      if (live) toast("Failed to load endpoint: " + e.message, "error");
    });
    return () => { live = false; };
  }, [mode, uri, toast]);

  const update = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const fileMode = !!(file || savedFile);

  const pickFile = (f) => {
    if (!f) return;
    if (f.size > MAX_UPLOAD_BYTES) {
      toast(`File is too large — max ${Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024)} MB`, "error");
      return;
    }
    if (f.size === 0) { toast("File is empty", "error"); return; }
    setFile(f);
  };

  // Dropping the pending file returns the modal to the text editors. If the row
  // already serves a file, this stages the conversion: saving then writes a text
  // response and the server deletes the object.
  const clearFile = () => {
    setFile(null);
    setSavedFile(null);
    if (fileInput.current) fileInput.current.value = "";
  };

  const save = async () => {
    const targetUri = form.uri.trim();
    if (mode === "new" && !targetUri) { toast("URI is required", "error"); return; }
    if (mode === "new" && !targetUri.startsWith("/")) { toast("URI must start with /", "error"); return; }
    setSaving(true);
    try {
      if (file) {
        // Upload replaces whatever the URI served before, text or an older file.
        await API.uploadEndpointFile(targetUri, file);
      } else if (savedFile) {
        // Untouched file endpoint: nothing to write. Saving text here would
        // silently delete the file the row is serving.
        onClose();
        return;
      } else {
        await API.saveEndpoint({
          uri: targetUri,
          status: Number(form.status) || 200,
          headers: form.headers,
          body: form.body,
        });
      }
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

            {fileMode ? (
              <FileEndpointField
                file={file}
                savedFile={savedFile}
                onClear={clearFile}
                onReplace={() => fileInput.current && fileInput.current.click()}
              />
            ) : (
              <>
                <div className="field-row">
                  <div className="field">
                    <label>Headers</label>
                    <textarea
                      value={form.headers}
                      onChange={(e) => update("headers", e.target.value)}
                      spellCheck={false}
                      placeholder="Content-Type: application/json"
                    />
                    <div className="helper">One header per line, <span style={{fontFamily:"var(--mono)"}}>Key: Value</span></div>
                  </div>
                  <div className="field">
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
                    placeholder="Response body — any text. For a binary, attach a file below instead."
                  />
                </div>

                <FileDropZone onPick={pickFile} onBrowse={() => fileInput.current && fileInput.current.click()}/>
              </>
            )}

            <input
              ref={fileInput}
              type="file"
              style={{display:"none"}}
              onChange={(e) => { pickFile(e.target.files && e.target.files[0]); }}
            />
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
          {saving
            ? <><span className="spinner"/> {file ? "uploading" : "saving"}</>
            : (mode === "new" ? "Create" : "Save changes")}
        </button>
      </div>
    </Modal>
  );
}

// Drop target shown only in TEXT mode. Attaching a file switches the modal to
// file mode, where the status/headers/body editors are gone. Kept below the body
// so the common case (typing a response) is unchanged.
function FileDropZone({ onPick, onBrowse }) {
  const [over, setOver] = useState(false);
  return (
    <div className="field">
      <label>File</label>
      <div
        className={`file-drop${over ? " over" : ""}`}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          onPick(e.dataTransfer.files && e.dataTransfer.files[0]);
        }}
        onClick={onBrowse}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onBrowse(); } }}
      >
        <span className="ico"><Icon.paper/></span>
        <span className="file-drop-text">
          <b>Serve a file</b>
          <span className="helper">Drop a file here or click to browse.</span>
        </span>
      </div>
    </div>
  );
}

// File mode. Shows what the endpoint serves (pending upload or the stored
// object) and the two escapes: replace the file, or drop back to a text
// response. No status/headers/body, because the server owns all three for file
// endpoints, so there is nothing here to edit.
function FileEndpointField({ file, savedFile, onClear, onReplace }) {
  const pending = !!file;
  const name = pending ? file.name : (savedFile.filename || "(unnamed)");
  const type = pending ? (file.type || "application/octet-stream") : (savedFile.content_type || "unknown");
  const size = pending ? file.size : savedFile.size;
  const missing = !pending && savedFile.missing;

  return (
    <div className="field">
      <label>File</label>
      <div className={`file-chip${missing ? " missing" : ""}`}>
        <span className="ico"><Icon.paper/></span>
        <span className="file-meta">
          <span className="name" title={name}>{name}</span>
          <span className="sub">
            <span className="mono">{type}</span>
            <span className="sep">·</span>
            <span className="mono">{fmtBytes(size)}</span>
            {pending && <><span className="sep">·</span><span className="pending">not uploaded yet</span></>}
            {missing && <><span className="sep">·</span><span className="pending">object missing from storage</span></>}
          </span>
        </span>
        <span className="file-actions">
          <button className="btn ghost" onClick={onReplace}>Replace</button>
          <button className="btn ghost" onClick={onClear} title="Serve a text response instead">Remove</button>
        </span>
      </div>
    </div>
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
        pinPlaceholder="Search Requests…"
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
              <span className="mono cell-trunc" style={{color:"var(--n4)"}} title={r.ip}>{r.ip}</span>
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

// Target number of DISPLAYED rows (groups count as 1) the list tries to fill on
// each fetch, so a burst that collapses to one group row doesn't leave the view
// nearly empty. There is no cap: the fill loop pages until this many are shown
// or the data runs out.
const DISPLAY_TARGET = 50;

// Global grouping: rows sharing the exact (from_addr, subject) pair
// collapse into one group item positioned at the newest member's ts. Groups of 1
// stay as singles. Input must be ts-DESC; output preserves first-appearance
// order, so a group sits where its newest member would.
function groupEmails(rows) {
  const groups = new Map();
  const order = [];
  for (const r of rows) {
    const key = JSON.stringify([r.from_addr || "", r.subject || ""]);
    let g = groups.get(key);
    if (!g) { g = []; groups.set(key, g); order.push(key); }
    g.push(r);
  }
  return order.map((key) => {
    const members = groups.get(key);
    if (members.length >= 2) {
      const head = members[0];
      // A group is unread if ANY loaded member is unread (mail-client behavior).
      // matchText spans from + subject + every loaded member's recipient, so pin
      // ribbons light for recipient-matching pins too, not just from/subject.
      const toAll = members.map((m) => m.to_addr || "").join(" ");
      // The To cell shows the LATEST member's recipient (head is newest, since
      // input is ts-DESC) with an ", and more" suffix, rather than a count: a group is
      // always ≥2 messages, so the suffix is true by construction and claims
      // nothing about rows that aren't loaded (an exact total would need a
      // per-group COUNT(*); see docs/decisions.md, "Email grouping is
      // client-side and exact-pair" and "No row counts anywhere in the UI").
      return { type: "group", key, from_addr: head.from_addr, subject: head.subject, ts: head.ts, to_addr: head.to_addr, read: members.every((m) => m.read) ? 1 : 0, matchText: `${head.from_addr || ""} ${head.subject || ""} ${toAll}` };
    }
    return { type: "single", key: members[0].id, row: members[0] };
  });
}

// Shared per-email read/starred actions (optimistic update + PATCH), used by both
// the Emails list and the group drill-in. Operates on whatever rows array the
// given setter manages. toggleStar resolves to the new starred boolean so callers
// can react (e.g. drop a row from an active star filter).
function useEmailFlags(setRows) {
  const toast = useToast();
  const patchRow = useCallback((id, patch) =>
    setRows((xs) => xs.map((r) => (r.id === id ? { ...r, ...patch } : r))), [setRows]);
  const markRead = useCallback(async (row) => {
    if (!row || row.read) return;
    patchRow(row.id, { read: 1 });
    try { await API.setEmailFlags(row.id, { read: true }); }
    catch (e) { patchRow(row.id, { read: 0 }); toast("Couldn't mark read: " + e.message, "error"); }
  }, [patchRow, toast]);
  const toggleRead = useCallback(async (row) => {
    if (!row) return;
    const next = row.read ? 0 : 1;
    patchRow(row.id, { read: next });
    try { await API.setEmailFlags(row.id, { read: !!next }); }
    catch (e) { patchRow(row.id, { read: row.read }); toast("Couldn't update: " + e.message, "error"); }
  }, [patchRow, toast]);
  const toggleStar = useCallback(async (row) => {
    if (!row) return false;
    const next = row.starred ? 0 : 1;
    patchRow(row.id, { starred: next });
    try { await API.setEmailFlags(row.id, { starred: !!next }); return !!next; }
    catch (e) { patchRow(row.id, { starred: row.starred }); toast("Couldn't update star: " + e.message, "error"); return !!row.starred; }
  }, [patchRow, toast]);
  return { markRead, toggleRead, toggleStar };
}

function EmailsTab() {
  const toast = useToast();
  const confirm = useConfirm();
  const [search, setSearch] = useState("");
  const dq = useDebouncedValue(search, 300);
  const { pins, addPin, removePin, clearPins, colors, pinColor } = usePinnedFilters("emails");
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [activeId, setActiveId] = useState(null);
  // Drill-in target: {from_addr, to_addr, subject} of a clicked group, or null.
  const [drill, setDrill] = useState(null);

  // "Starred only" filter, a dedicated toolbar toggle (no longer a search pin).
  // When on, results are restricted to starred mail AND whatever the search/pins
  // already match (an AND constraint, not an OR term).
  const [starOnly, setStarOnly] = useState(false);
  const terms = useMemo(() => effectiveSearch(dq, pins), [dq, pins]);

  // One-time cleanup: ":star:" used to be a pin. Drop any stale one from storage
  // so it isn't now treated as a literal search term.
  useEffect(() => { if (pins.includes(":star:")) removePin(":star:"); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const { markRead, toggleRead, toggleStar } = useEmailFlags(setRows);

  // Monotonic request id, bumped by every fresh fetch so a slower in-flight
  // fetch (e.g. one started before a filter/pin change) can detect it's been
  // superseded and discard its result instead of clobbering the current view.
  const reqSeq = useRef(0);

  // How many rows the current view would DISPLAY for a given raw set (groups
  // always collapse to 1). Drives the fill loop.
  const displayedCount = useCallback((rs) => groupEmails(rs).length, []);

  // Fetch pages (cursor on the underlying row ts) until at least DISPLAY_TARGET
  // rows are displayed or the data runs out. Grouping is a pure view transform,
  // so the cursor is always the last raw row's ts.
  const fetchFirst = useCallback(async () => {
    const seq = ++reqSeq.current;
    setLoading(true);
    try {
      let acc = [];
      let cursor;
      let more = true;
      for (;;) {
        const r = await API.listEmails({ search: terms, starred: starOnly, cursor });
        if (seq !== reqSeq.current) return;   // superseded by a newer fetch, so discard
        acc = cursor ? acc.concat(r) : r;
        more = r.length === 50;
        cursor = acc.length ? acc[acc.length - 1].ts : undefined;
        if (displayedCount(acc) >= DISPLAY_TARGET || !more) break;
      }
      setRows(acc);
      setHasMore(more);
    } catch (e) {
      if (seq !== reqSeq.current) return;
      toast("Failed to load emails: " + e.message, "error");
      setRows([]); setHasMore(false);
    } finally {
      if (seq === reqSeq.current) setLoading(false);   // don't clear a newer fetch's loading
    }
  }, [terms, starOnly, displayedCount, toast]);

  useEffect(() => { fetchFirst(); }, [fetchFirst]);

  const loadMore = async () => {
    if (rows.length === 0) return;
    const seq = reqSeq.current;   // capture; a fresh fetchFirst bumps this and supersedes us
    setLoadingMore(true);
    try {
      let acc = rows;
      let cursor = rows[rows.length - 1].ts;
      let more = true;
      const target = displayedCount(acc) + DISPLAY_TARGET;
      for (;;) {
        const r = await API.listEmails({ search: terms, starred: starOnly, cursor });
        if (seq !== reqSeq.current) return;   // superseded by a filter change, so discard
        acc = acc.concat(r);
        more = r.length === 50;
        cursor = acc.length ? acc[acc.length - 1].ts : cursor;
        if (displayedCount(acc) >= target || !more) break;
      }
      setRows(acc);
      setHasMore(more);
    } catch (e) {
      toast("Failed to load more: " + e.message, "error");
    } finally {
      setLoadingMore(false);
    }
  };

  const open = (row) => { markRead(row); setActiveId(row.id); };
  const handleToggleStar = async (row) => {
    const nowStarred = await toggleStar(row);
    // Under an active star filter, an unstarred row no longer belongs, so refetch.
    if (starOnly && !nowStarred) fetchFirst();
  };

  // Clicking a group's stack icon toggles read state for every DB row sharing
  // that (from, subject) pair, across all recipients, loaded or not. A read
  // group becomes unread and vice versa, behind a confirm.
  const toggleGroupRead = async (item) => {
    const makeRead = !item.read;                 // read group → unread; unread → read
    const verb = makeRead ? "read" : "unread";
    const filtered = terms.length > 0 || starOnly;
    const ok = await confirm({
      title: makeRead ? "Mark group as read" : "Mark group as unread",
      message: (
        <>
          Mark all emails from <span className="confirm-em">{decodeMimeWord(item.from_addr) || "(unknown sender)"}</span>
          {" "}with subject <span className="confirm-subj">{decodeMimeWord(item.subject) || "(no subject)"}</span>
          {filtered ? " that match the current filter" : ""} as {verb}?
          {filtered
            ? " This updates every matching record in the database (only those matching the active search/starred filter)."
            : " This updates every matching record in the database, including any not currently loaded."}
        </>
      ),
      confirmLabel: makeRead ? "Mark read" : "Mark unread",
    });
    if (!ok) return;
    try {
      // Scope the DB update to the active filter. Loaded root rows are already
      // filter-matched (the root list was fetched with the same filter), so the
      // local patch by from+subject is inherently filter-scoped too.
      await API.setGroupRead(item.from_addr, item.subject, makeRead, { search: terms, starred: starOnly });
      setRows((xs) => xs.map((r) =>
        (r.from_addr === item.from_addr && (r.subject || "") === (item.subject || "")) ? { ...r, read: makeRead ? 1 : 0 } : r
      ));
      toast(`Group marked as ${verb}`, "success");
    } catch (e) {
      toast(`Couldn't mark group ${verb}: ` + e.message, "error");
    }
  };

  const displayed = useMemo(() => groupEmails(rows), [rows]);

  const activeRow = rows.find((r) => r.id === activeId);

  // Drill-in replaces the whole tab view with the group's own list. On Back it
  // hands back its member rows so we can sync any read-state changes into the
  // loaded root rows by id. Otherwise the collapsed group row would stay stale,
  // since the drill-in has its own state. No refetch; scroll/loaded pages are kept.
  if (drill) {
    return (
      <EmailGroupView
        group={drill}
        terms={terms}
        starOnly={starOnly}
        onBack={(memberRows) => {
          setDrill(null);
          // Under the Starred filter, star changes inside the drill-in can add or
          // remove rows from the filtered view, so refetch to reconcile fully.
          if (starOnly) { fetchFirst(); return; }
          // Otherwise sync BOTH read and starred back onto matching loaded rows
          // by id (no refetch, scroll preserved) so the group row isn't stale.
          if (memberRows && memberRows.length) {
            const byId = new Map(memberRows.map((m) => [m.id, { read: m.read, starred: m.starred }]));
            setRows((xs) => xs.map((r) => (byId.has(r.id) ? { ...r, ...byId.get(r.id) } : r)));
          }
        }}
      />
    );
  }

  return (
    <>
      <ListView
        search={search} setSearch={setSearch}
        pins={pins} onPin={addPin} onUnpin={removePin} onClearPins={clearPins} pinColor={pinColor}
        onRefresh={fetchFirst}
        pinPlaceholder="Search Emails…"
        rows={displayed} loading={loading} hasMore={hasMore}
        onLoadMore={loadMore} loadingMore={loadingMore}
        gridClass="email-grid"
        total={displayed.length}
        rightToolbar={
          <button
            className={`btn star-filter-btn${starOnly ? " active" : ""}`}
            onClick={() => setStarOnly((s) => !s)}
            title="Show starred emails only"
            aria-pressed={starOnly}
          >
            {starOnly ? <Icon.starOn/> : <Icon.star/>} Starred
          </button>
        }
        header={<>
          <span></span>
          <span>Timestamp</span>
          <span>From</span>
          <span>To</span>
          <span>Subject</span>
          <span></span>
        </>}
        emptyText={starOnly && !pins.length && !search ? "no starred emails" : ((search || pins.length || starOnly) ? "no emails match these filters" : "no emails captured yet")}
        renderRow={(item) => (
          item.type === "group" ? (
            <EmailGroupRow
              key={item.key}
              item={item}
              matches={pinMatches(pins, colors, item.matchText)}
              onOpen={() => setDrill({ from_addr: item.from_addr, subject: item.subject })}
              onToggleGroupRead={() => toggleGroupRead(item)}
            />
          ) : (
            <EmailRow
              key={item.key}
              row={item.row}
              active={activeId === item.row.id}
              matches={pinMatches(pins, colors, `${item.row.from_addr} ${item.row.to_addr} ${item.row.subject || ""}`)}
              onOpen={() => open(item.row)}
              onToggleRead={() => toggleRead(item.row)}
              onToggleStar={() => handleToggleStar(item.row)}
            />
          )
        )}
      />
      {activeId && (
        <EmailModal
          id={activeId}
          starred={!!(activeRow && activeRow.starred)}
          onToggleStar={() => handleToggleStar(activeRow)}
          onClose={() => setActiveId(null)}
        />
      )}
    </>
  );
}

// A grouped row (identical From/Subject). Non-interactive except the click,
// which drills into the group's own view. No star or read-unread here; those
// live on the individual messages inside.
//
// Three cues separate it from a singleton, none of which touches the left edge
// (pin ribbons) or the background (read/unread): the leftmost stack icon (vs the
// envelope), a To cell reading "<latest recipient>, and more" instead of a
// single address, and the fanned `group-stack` bars on the right edge.
function EmailGroupRow({ item, matches, onOpen, onToggleGroupRead }) {
  const latestTo = decodeMimeWord(item.to_addr) || "(no recipient)";
  return (
    <div
      className={`row email-grid email-group-row ${item.read ? "read" : "unread"}${matches.length ? " has-ribbon" : ""}`}
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); } }}
      title="Grouped — click to view every message with this From & Subject"
    >
      <PinRibbon matches={matches}/>
      <button
        type="button"
        className="row-icon group-icon"
        onClick={(e) => { e.stopPropagation(); onToggleGroupRead(); }}
        title={item.read ? "Mark entire group as unread" : "Mark entire group as read"}
        aria-label={item.read ? "Mark entire group as unread" : "Mark entire group as read"}
      >
        <Icon.stack/>
      </button>
      <span className="mono" style={{color:"var(--n4)"}}>{fmtTime(item.ts)}</span>
      <span className="mono cell-trunc from" title={decodeMimeWord(item.from_addr)}>{decodeMimeWord(item.from_addr)}</span>
      <span className="group-to" title={`${latestTo} — and more in this group`}>
        <span className="mono group-to-addr">{latestTo}</span>
        <span className="group-to-more">, and more</span>
      </span>
      <span className="cell-trunc subject" title={decodeMimeWord(item.subject)}>{decodeMimeWord(item.subject)}</span>
      <span aria-hidden="true"/>
      <span className="group-stack" aria-hidden="true"><i/><i/><i/></span>
    </div>
  );
}

// Drill-in view for one group: a self-contained, server-backed list of every
// message sharing the exact (from, subject) pair, paginated on its own and
// further narrowed by the active search terms + starred filter so it mirrors the
// root view. The already-loaded root rows are irrelevant, since this re-fetches
// authoritatively.
function EmailGroupView({ group, terms, starOnly, onBack }) {
  const toast = useToast();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [activeId, setActiveId] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const { markRead, toggleRead, toggleStar } = useEmailFlags(setRows);

  const fetchFirst = useCallback(async () => {
    setLoading(true);
    try {
      const r = await API.listEmailGroup({ fromAddr: group.from_addr, subject: group.subject, search: terms, starred: starOnly });
      setRows(r);
      setHasMore(r.length === 50);
    } catch (e) {
      toast("Failed to load group: " + e.message, "error");
      setRows([]); setHasMore(false);
    } finally {
      setLoading(false);
    }
  }, [group, terms, starOnly, toast]);

  useEffect(() => { fetchFirst(); }, [fetchFirst]);

  const loadMore = async () => {
    if (rows.length === 0) return;
    setLoadingMore(true);
    try {
      const cursor = rows[rows.length - 1].ts;
      const r = await API.listEmailGroup({ fromAddr: group.from_addr, subject: group.subject, search: terms, starred: starOnly, cursor });
      setRows((xs) => xs.concat(r));
      setHasMore(r.length === 50);
    } catch (e) {
      toast("Failed to load more: " + e.message, "error");
    } finally {
      setLoadingMore(false);
    }
  };

  const open = (row) => { markRead(row); setActiveId(row.id); };
  const activeRow = rows.find((r) => r.id === activeId);

  // Same refresh affordance as ListView: spin briefly, re-fetch this group.
  const handleRefresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try { await fetchFirst(); } finally { setTimeout(() => setRefreshing(false), 250); }
  };

  return (
    <>
      <div className="toolbar group-detail-toolbar">
        <button className="btn ghost back-btn" onClick={() => onBack(rows)}>← Back</button>
        <div className="group-detail-context">
          <span className="mono cell-trunc" title={decodeMimeWord(group.from_addr)}>{decodeMimeWord(group.from_addr)}</span>
          <span className="sep">·</span>
          <span className="subject cell-trunc" title={decodeMimeWord(group.subject)}>{decodeMimeWord(group.subject) || "(no subject)"}</span>
        </div>
        <div className="toolbar-meta">
          <span>{rows.length} loaded</span>
          <button
            className={`refresh-btn ${refreshing ? "spinning" : ""}`}
            onClick={handleRefresh}
            disabled={refreshing}
            title="Refresh"
            aria-label="Refresh"
          >
            <Icon.refresh/>
          </button>
        </div>
      </div>
      <div className="content">
        <div className="table-header email-grid">
          <span></span>
          <span>Timestamp</span>
          <span>From</span>
          <span>To</span>
          <span>Subject</span>
          <span></span>
        </div>
        {loading && rows.length === 0 && (
          <div className="loading"><span className="spinner"/> querying…</div>
        )}
        {!loading && rows.length === 0 && (
          <div className="empty"><div className="glyph">∅</div>no messages in this group</div>
        )}
        {rows.map((r) => (
          <EmailRow
            key={r.id}
            row={r}
            active={activeId === r.id}
            matches={[]}
            onOpen={() => open(r)}
            onToggleRead={() => toggleRead(r)}
            onToggleStar={() => toggleStar(r)}
          />
        ))}
        {rows.length > 0 && (
          <div className="loadmore-wrap">
            {hasMore ? (
              <button className="btn" onClick={loadMore} disabled={loadingMore}>
                {loadingMore ? <><span className="spinner"/> loading</> : "Load more"}
              </button>
            ) : (
              <span className="meta">— end of results —</span>
            )}
          </div>
        )}
      </div>
      {activeId && (
        <EmailModal
          id={activeId}
          starred={!!(activeRow && activeRow.starred)}
          onToggleStar={() => toggleStar(activeRow)}
          onClose={() => setActiveId(null)}
        />
      )}
    </>
  );
}

// Email row. Unread is the bright state (background tint, closed envelope, bold
// subject, frost-colored toggle); read is muted with an open envelope. The
// leading envelope toggles read ↔ unread without opening; the trailing star
// toggles starred.
//
// Unread deliberately has NO left rail: the left edge is reserved for pin
// ribbons, so the two cues can never collide and a row can show both at once
// (see the .email-grid.unread rules in styles.css, and dashboard.md).
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
  const [data, setData] = useState(null);            // lean envelope metadata (no body)
  const [body, setBody] = useState(null);            // { buf: ArrayBuffer, parsed } from the raw .eml
  const [bodyLoading, setBodyLoading] = useState(true);
  const [bodyError, setBodyError] = useState(null);
  const [bodyView, setBodyView] = useState("html");   // active part when both exist
  const [fullscreen, setFullscreen] = useState(false);

  // Envelope metadata (from/to/subject/ts/read/starred/attachment_count) from
  // one fast, lean D1 read. No body: D1 no longer stores any body text.
  useEffect(() => {
    let live = true;
    API.getEmail(id).then((d) => { if (live) setData(d); })
      .catch((e) => { if (live) toast("Failed to load email: " + e.message, "error"); });
    return () => { live = false; };
  }, [id, toast]);

  // Body: fetch the raw .eml from R2 and parse it in-browser IMMEDIATELY on
  // open, with no "More" step. This single R2 fetch is the sole source of the
  // plain-text body, the HTML body, the full headers, and attachments (D1
  // holds none of them). Every D1 row has a matching R2 object (capture is
  // all-or-nothing), so this normally always resolves.
  useEffect(() => {
    let live = true;
    setBody(null);
    setBodyLoading(true);
    setBodyError(null);
    (async () => {
      try {
        const buf = await API.getEmailRaw(id);          // ArrayBuffer
        if (!window.PostalMime) throw new Error("Email parser still loading — try again in a moment");
        const p = await window.PostalMime.parse(buf);
        if (!live) return;
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
        setBody({ buf, parsed });
        setBodyView(parsed.html ? "html" : "text");   // default to HTML when present
      } catch (e) {
        if (live) setBodyError(e.message || String(e));
      } finally {
        if (live) setBodyLoading(false);
      }
    })();
    return () => { live = false; };
  }, [id]);

  // While the body is full-screened, ESC exits full-screen rather than closing
  // the whole modal. Capture phase + stopImmediatePropagation so it runs before
  // (and suppresses) Modal's own bubble-phase ESC-to-close listener on window.
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e) => {
      if (e.key === "Escape") { e.stopImmediatePropagation(); setFullscreen(false); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [fullscreen]);

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

  const downloadRaw = () => {
    if (!body) return;
    const name = filenameFor(data);
    triggerDownload(new Blob([body.buf], { type: "message/rfc822" }), name);
    toast("Downloaded " + name, "success");
  };

  const downloadAttachment = (att) => {
    const name = att.filename || "attachment.bin";
    triggerDownload(new Blob([att.content], { type: att.mimeType || "application/octet-stream" }), name);
    toast("Downloaded " + name, "success");
  };

  const hasHtml = !!(body && body.parsed.html);
  const hasText = !!(body && body.parsed.text);

  const bothBodies = hasHtml && hasText;
  // Body view: HTML/Plain switcher only when BOTH parts exist; with one part it's
  // just shown; with neither, a "no body" notice. The full-screen toggle is
  // shown whenever there's a body (HTML or text). bodyControls + bodyContent are
  // computed once and reused inline, and in a portal overlay when
  // full-screened (mutually exclusive, so the iframe/pre is only mounted once).
  const bodyControls = (hasHtml || hasText) ? (
    <div className="body-controls">
      {bothBodies && (
        <div className="toggle-group">
          <button className={bodyView === "html" ? "active" : ""} onClick={() => setBodyView("html")}>HTML</button>
          <button className={bodyView === "text" ? "active" : ""} onClick={() => setBodyView("text")}>Plain</button>
        </div>
      )}
      <button
        type="button"
        className="expand-btn"
        onClick={() => setFullscreen((f) => !f)}
        title={fullscreen ? "Exit full screen" : "Full screen"}
        aria-label={fullscreen ? "Exit full screen" : "Full screen"}
        aria-pressed={fullscreen}
      >
        {fullscreen ? <Icon.collapse/> : <Icon.expand/>}
      </button>
    </div>
  ) : null;

  const bodyContent = bodyError ? (
    <div className="notice notice-error">
      <span className="glyph">!</span>
      <span>Couldn't load email body: {bodyError}</span>
    </div>
  ) : (hasHtml && (!hasText || bodyView === "html")) ? (
    <div className="iframe-wrap">
      <iframe sandbox="" srcDoc={body.parsed.html} title="email html"/>
    </div>
  ) : hasText ? (
    <pre className="code-block wrap">{body.parsed.text}</pre>
  ) : (
    <div className="notice">
      <span className="glyph">∅</span>
      <span>This email has no body.</span>
    </div>
  );

  return (
    <>
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
        {(!data || bodyLoading) ? (
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
                  </dd>
                </>
              )}
            </dl>

            {body && (
              <div className="section">
                <details className="headers-collapse">
                  <summary>
                    <span className="caret"><Icon.chevron/></span>
                    Headers <span style={{color:"var(--n4)", fontWeight:400}}>· {body.parsed.headers.length}</span>
                  </summary>
                  {/* Whitespace runs are collapsed for display. postal-mime 3.x unfolds
                      per RFC 5322, keeping the whitespace that folding introduced, so
                      long values (Received, DKIM-Signature, ARC-*) would otherwise render
                      with tabs and 8-space gaps mid-value. One header still occupies one
                      line either way; "Download raw" serves the untouched .eml for anyone
                      who needs the bytes as they arrived. */}
                  <pre className="code-block">
                    {body.parsed.headers.map((h) => `${h.key}: ${decodeMimeWord(h.value).replace(/\s+/g, " ").trim()}`).join("\n")}
                  </pre>
                </details>
              </div>
            )}

            <div className="section">
              <div className="section-title section-title-toggle">
                <span>Body</span>
                {bodyControls}
              </div>
              {fullscreen ? (
                <div className="notice">
                  <span className="glyph">⛶</span>
                  <span>Body is shown full screen — press Esc or the collapse button to return.</span>
                </div>
              ) : bodyContent}
            </div>

            {body && body.parsed.attachments.length > 0 && (
              <div className="section">
                <div className="section-title">
                  Attachments <span style={{color:"var(--n4)", fontWeight:400}}>· {body.parsed.attachments.length}</span>
                  <span className="att-hint" style={{marginLeft:"8px", textTransform:"none", letterSpacing:0}}>click to download</span>
                </div>
                <div className="attachment-list">
                  {body.parsed.attachments.map((a, i) => (
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
        {body && (
          <button className="btn" onClick={downloadRaw} title="Download raw .eml">
            <span className="dl-glyph" aria-hidden="true">
              <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                <path d="M7 1.5v8M4 6.5l3 3 3-3M2 12h10"/>
              </svg>
            </span>
            Download Raw
          </button>
        )}
        <div className="spacer"/>
        <button className="btn ghost" onClick={onClose}>Close</button>
      </div>
    </Modal>
    {fullscreen && (hasHtml || hasText) && ReactDOM.createPortal(
      <div className="body-fullscreen" role="dialog" aria-label="Email body — full screen">
        <div className="body-fullscreen-bar">
          <span className="section-title" style={{ margin: 0 }}>Body</span>
          {bodyControls}
        </div>
        <div className="body-fullscreen-content">{bodyContent}</div>
      </div>,
      document.body
    )}
    </>
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
