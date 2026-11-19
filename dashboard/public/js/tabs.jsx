// Endpoints, Requests, Emails tabs

// ----------------------------------------------------------------
// Generic List view
// ----------------------------------------------------------------
function ListView({
  search, setSearch,
  pins, onPin, onUnpin, onClearPins,
  pinPlaceholder, pinColor,
  rows, loading, hasMore, onLoadMore, loadingMore,
  onRefresh,
  header, renderRow, emptyText, gridClass, total,
  // Two toolbar slots, and the difference between them is the point.
  // `leftToolbar` leads the row: it is for a control that decides WHICH rows
  // exist. `rightToolbar` sits against the search box: it is for a control that
  // narrows the rows you already have, or acts on them. Putting a scope switch
  // and a filter in the same slot is what made the old Endpoints toolbar read
  // as a row of unrelated buttons.
  leftToolbar, rightToolbar,
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
        {leftToolbar}
        <div className="search-wrap">
          <span className="icon"><Icon.search/></span>
          <div className="pin-strip">
            {hasPins && pins.map((p) => {
              const cv = pinColorVars(pinColor && pinColor(p));
              return (
                <span
                  key={p}
                  className="pin-chip"
                  title={`Pinned filter "${p}", click × to remove`}
                  style={{ background: cv.soft, borderColor: cv.edge, color: cv.base }}
                >
                  <span className="pin-glyph" style={{ color: cv.base }}><Icon.pin/></span>
                  <span className="pin-val">{p}</span>
                  <button
                    className="pin-x"
                    onClick={() => onUnpin && onUnpin(p)}
                    aria-label={`Remove pin ${p}`}
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
                <span className="meta">end of results</span>
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

// Which of the three endpoint lists is on screen.
//
// They are mutually exclusive in the DATA, not merely in the interface, and
// that is why this is one control with three positions rather than three
// buttons. The list query in dashboard/src/api/endpoints/index.js is
// `uri NOT LIKE '/-/%'` for the working set and `uri LIKE '/-/%'` for the
// agent-staged one, so no endpoint is ever in both; and an endpoint under `/-/`
// can never be archived (CLAUDE.md invariant 3), so "archived AND agent-staged"
// has no rows by construction.
//
// Independent toggles could ask for that fourth state, and the only honest
// answer to it is an empty list with nothing on screen to explain why it must
// be empty. A three-position switch cannot be asked.
//
// This replaces a `:autopilot:` search token that was handled here: a term
// typed into the search box that did not search, but swapped which list you
// were looking at. Operators read it as a filter that found nothing. Changing
// the list is not something a search box should do, and the fix is to let the
// list switch look like a list switch.
const SCOPES = [
  // "Manual" rather than "Endpoints": this switch lives inside the Endpoints
  // tab, so a position with the same name as its own tab reads as "all of
  // them" when it means the opposite. What separates the first two lists is who
  // made the endpoint, a person or an agent, so the labels say that and the
  // contrast with Autopilot does the explaining.
  //
  // Not "Live" either, which is the tempting one and is wrong: an endpoint
  // under `/-/` is served exactly like any other, so "Live" next to "Autopilot"
  // would claim something false about the agent-staged list.
  { id: "manual", label: "Manual", title: "Endpoints you made by hand" },
  { id: "autopilot", label: "Autopilot", title: "Endpoints staged by agents under /-/" },
  { id: "archived", label: "Archive", title: "Endpoints kept but not served" },
];

// Rendered into ListView's `leftToolbar`, so it reads before the search box:
// which list, then narrow it. It is a radio group, not three buttons: one is
// always on, and choosing one unchooses the others, which is exactly the
// constraint the data already has.
function ScopeSwitch({ scope, setScope }) {
  return (
    <div className="scope-switch" role="radiogroup" aria-label="Which endpoints to show">
      {SCOPES.map((s) => (
        <button
          key={s.id}
          role="radio"
          aria-checked={scope === s.id}
          className={`scope-opt${scope === s.id ? " active" : ""}`}
          onClick={() => setScope(s.id)}
          title={s.title}
        >
          {s.label}
        </button>
      ))}
    </div>
  );
}

// ----------------------------------------------------------------
// Endpoints
// ----------------------------------------------------------------

// Autopilot's fence, mirrored from the worker. Every endpoint an agent can
// create, read or delete lives under this prefix, and the worker enforces it
// server-side. This copy decides three things on this side of the fence, all
// of them about what the interface offers rather than what is permitted:
//
//   * an endpoint under the prefix cannot be archived, so that button is not
//     rendered for one;
//   * a NEW endpoint cannot be created under it at all, so the field refuses
//     the path as it is typed and `+ New endpoint` is absent from the
//     Autopilot scope entirely;
//   * renaming an existing one INTO it is allowed, and confirmed first.
//
// The asymmetry between the last two is the whole point. Everything under the
// prefix is agent-owned and is deleted wholesale on the cleanup schedule;
// typing a path into a text box is not a way to agree to that, and choosing to
// move an endpoint you already have is.
const AUTOPILOT_PREFIX = "/-/";

const isAutopilotUri = (uri) => String(uri || "").startsWith(AUTOPILOT_PREFIX);

// The path an agent-staged endpoint is offered when it is moved out: the same
// path with the prefix taken off, so `/-/acme/oauth-callback` is proposed as
// `/acme/oauth-callback`. A suggestion, not a rule. The operator edits it, and
// the only thing enforced is that the result is not back under the prefix.
const withoutAutopilotPrefix = (uri) =>
  "/" + String(uri || "").slice(AUTOPILOT_PREFIX.length).replace(/^\/+/, "");

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
  // One of SCOPES. Not persisted: the hand-made set is where a session should
  // start, and a dashboard that silently opens on the Archive because of
  // something you did last week is a dashboard that lies about what is being
  // served.
  const [scope, setScope] = useState("manual");
  const manual = scope === "manual";
  const archived = scope === "archived";
  const autopilot = scope === "autopilot";

  const fetchFirst = useCallback(async () => {
    setLoading(true);
    try {
      const r = await API.listEndpoints({ search: terms, archived, autopilot });
      setRows(r);
      setHasMore(r.length === 50);
    } catch (e) {
      toast("Failed to load endpoints: " + e.message, "error");
      setRows([]);
      setHasMore(false);
    } finally {
      setLoading(false);
    }
  }, [terms, toast, archived, autopilot]);

  useEffect(() => { fetchFirst(); }, [fetchFirst]);

  const loadMore = async () => {
    if (rows.length === 0) return;
    setLoadingMore(true);
    try {
      const cursor = rows[rows.length - 1].uri;
      const r = await API.listEndpoints({ search: terms, cursor, archived, autopilot });
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
    setModal({ mode: "edit", uri, fromScope: scope });
  };

  const handleSaved = async () => {
    setModal(null);
    setActiveId(null);
    await fetchFirst();
    toast("Endpoint saved", "success");
  };

  // Close and refresh WITHOUT a toast, for the writes that announce themselves.
  // A move says where the endpoint went and an archive says whether the path is
  // still served; "Endpoint saved" stacked under either one contradicts it a
  // line later. (Both used to do exactly that.)
  //
  // The list does not follow a move, either: the row leaves the Autopilot scope
  // you are standing in, and jumping to Endpoints after every move would make
  // triaging a staged engagement a fight.
  const handleActed = async () => {
    setModal(null);
    setActiveId(null);
    await fetchFirst();
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
        /* Names the scope, so the box reads as "narrow THIS list" rather than
           "search endpoints" while you are looking at the other two. */
        pinPlaceholder={`Search ${SCOPES.find((x) => x.id === scope).label}…`}
        rows={rows} loading={loading} hasMore={hasMore}
        onLoadMore={loadMore} loadingMore={loadingMore}
        gridClass="endpoint-grid"
        total={rows.length}
        header={<>
          <span></span>
          <span>URI</span>
          <span>Status</span>
        </>}
        emptyText={
          search
            ? "no endpoints match that pattern"
            : archived ? "nothing archived"
            : autopilot ? "no agent has staged an endpoint"
            : "no endpoints configured yet"
        }
        leftToolbar={<ScopeSwitch scope={scope} setScope={setScope}/>}
        rightToolbar={
          /* Only on Manual, the one list a dashboard-made endpoint can join.
             In the Archive it would file the row into a list you are not
             looking at. In Autopilot it would offer to create something the
             modal then refuses: `/-/` is the agents' namespace and the
             dashboard does not create there (see `save` in EndpointModal). A
             button that opens a form you cannot submit is worse than no
             button. */
          manual && (
            <button className="btn primary" onClick={() => setModal({ mode: "new" })}>
              <span className="plus">+</span> New endpoint
            </button>
          )
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
          fromScope={modal.fromScope}
          onClose={() => { setModal(null); setActiveId(null); }}
          onSaved={handleSaved}
          onActed={handleActed}
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
    if (!activeDomain) { toast("No default host selected. Pick one on Home", "error"); return; }
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

function EndpointModal({ mode, uri, fromScope, onClose, onSaved, onActed, onDelete }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [loading, setLoading] = useState(mode === "edit");
  const [saving, setSaving] = useState(false);
  // `form.uri` is editable in edit mode now, so the path the row is stored
  // under has to be held separately: every write targets `uri` (the prop, the
  // row as it exists) and may MOVE it to form.uri.
  const [form, setForm] = useState({ uri: "", status: 200, headers: "Content-Type: text/plain", body: "", archived: false });
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
        archived: !!d.archived,
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
  // An archived endpoint is frozen: the modal shows what it holds and offers
  // only Unarchive and Delete. The editors are unmounted rather than disabled,
  // the same treatment file mode gets. A grayed-out field still invites a
  // click, and the server refuses the write anyway.
  const frozen = mode === "edit" && form.archived;

  // An agent-staged endpoint is read-only here, for the same reason an archived
  // one is: it belongs to a lifecycle this modal is not part of. Agents own what
  // is under `/-/`, which Autopilot can read, replace and delete, and the
  // cleanup run deletes all of it on a schedule. An operator editing a response
  // an agent is about to overwrite, on a row that disappears next month, is
  // editing something that is not really theirs.
  //
  // The way out is the same one the fence already had: move it out of the
  // prefix. That is a single primary-key update, it takes the endpoint out of
  // Autopilot's reach and off the purge schedule in one go, and the row arrives
  // in the ordinary Endpoints list, file and all, where everything is editable
  // again. So the modal offers that move rather than an edit.
  const agentOwned = mode === "edit" && isAutopilotUri(uri);
  const [moving, setMoving] = useState(false);
  const [moveTo, setMoveTo] = useState("");
  const [moveError, setMoveError] = useState("");

  // Two different locks. Content is read-only for as long as the row is
  // agent-owned, the move included: moving is a rename, not an edit, and the
  // body you can see is still the agent's until it lands. Only the URI opens
  // up, and only while the move is being typed.
  const contentLocked = frozen || agentOwned;
  const uriLocked = frozen || (agentOwned && !moving);

  // The one path a new endpoint may not take. Checked as you type AND again in
  // `save`, from this same expression, so the field and the Save button can
  // never disagree about what is allowed.
  const newIntoPrefix = mode === "new" && isAutopilotUri(form.uri.trim());

  // The same question for the move target, and the reason it cannot be waved
  // through: a "move" that lands back under `/-/` has moved nothing.
  const moveIntoPrefix = isAutopilotUri(moveTo.trim());

  const beginMove = () => {
    setMoveTo(withoutAutopilotPrefix(uri));
    setMoveError("");
    setMoving(true);
  };

  // The move is ONE write: the rename. Not `save`, which would also push the
  // status, headers and body back. That is a pointless write on a row nobody
  // edited, and one that would quietly make this modal an editor after all.
  //
  // Whether the target is taken is decided by the server, not by a lookup from
  // here first. A check would be a second round trip that is out of date the
  // moment it returns; the rename itself answers 409 with the name, which is
  // the same answer, authoritative, and already the thing that races correctly.
  // So the refusal lands back on the field and the operator picks another.
  const moveOut = async () => {
    const target = moveTo.trim();
    if (!target) { setMoveError("A path is required"); return; }
    if (!target.startsWith("/")) { setMoveError("URI must start with /"); return; }
    if (moveIntoPrefix) { setMoveError(`That is still under ${AUTOPILOT_PREFIX}. Pick a path outside it.`); return; }

    setMoveError("");
    setSaving(true);
    try {
      await API.patchEndpoint(uri, { uri: target });
    } catch (e) {
      setSaving(false);
      if (e.status === 409) { setMoveError(e.message); return; }
      toast("Move failed: " + e.message, "error");
      return;
    }
    // Names the list as well as the path. The row has just left the one you
    // are standing in, so "it is in Manual now" is the half of the answer the
    // empty space in front of you does not give.
    toast(`Moved to ${target}. It is in Manual now, and editable`, "success");
    onActed();
  };

  const pickFile = (f) => {
    if (!f) return;
    if (f.size > MAX_UPLOAD_BYTES) {
      toast(`File is too large. Max ${Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024)} MB`, "error");
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

  // Archive / unarchive. Its own write, and its own button: it is not something
  // you should have to press Save to apply, and it is the one action here that
  // changes whether the black hole serves this path at all.
  const toggleArchive = async () => {
    setSaving(true);
    try {
      await API.patchEndpoint(uri, { archived: !form.archived });
      toast(form.archived ? "Endpoint unarchived. It is served again" : "Endpoint archived. It is no longer served", "success");
      onActed();
    } catch (e) {
      toast((form.archived ? "Unarchive" : "Archive") + " failed: " + e.message, "error");
      setSaving(false);
    }
  };

  const save = async () => {
    const targetUri = form.uri.trim();
    if (!targetUri) { toast("URI is required", "error"); return; }
    if (!targetUri.startsWith("/")) { toast("URI must start with /", "error"); return; }

    // `/-/` is Autopilot's namespace, and the dashboard does not CREATE in it.
    //
    // The prefix looks like a folder but behaves like a lifecycle. Everything
    // under it is agent-owned (an agent can read, replace and delete it), it
    // can never be archived, and the cleanup worker deletes every one of them
    // on the CLEANUP_AUTOPILOT_PURGE schedule, uploaded files included. Typing
    // a path into a text box is not a reasonable way to opt into that, and the
    // operator who does it by accident loses the endpoint on a timer without
    // ever having been told.
    //
    // Only `new` is refused. Renaming an EXISTING endpoint into the prefix is
    // still allowed, and still asks first (below): that path is deliberate by
    // construction: you already have the thing, and you are choosing to hand
    // it over. It is also how a file-backed payload gets to a `/-/` path now,
    // since an upload is a human step: create it outside the prefix, then move
    // it in.
    if (newIntoPrefix) {
      toast(`${AUTOPILOT_PREFIX} is Autopilot's namespace. Create it elsewhere, then rename it in.`, "error");
      return;
    }

    // A rename is its own write, and it goes FIRST: if the name is taken the
    // server answers 409 and nothing has been changed yet, so the modal is
    // still showing exactly what the operator typed.
    const renaming = mode === "edit" && targetUri !== uri;
    if (renaming && isAutopilotUri(targetUri) && !isAutopilotUri(uri)) {
      const ok = await confirm({
        title: "Move into Autopilot's prefix",
        message: `${targetUri} is under ${AUTOPILOT_PREFIX}. Agents will be able to read, replace and delete it, and the monthly cleanup deletes everything under that prefix. It also stops being editable here: to change it again you move it back out. Archived endpoints cannot live there at all.`,
        confirmLabel: "Move it",
      });
      if (!ok) return;
    }

    setSaving(true);
    try {
      if (renaming) await API.patchEndpoint(uri, { uri: targetUri });

      if (file) {
        // Replaces whatever the URI served before, text or an older file, but
        // only for an endpoint that was opened. Creating one at a path that is
        // already taken is refused, the same as a rename onto it would be.
        await API.uploadEndpointFile(targetUri, file, mode === "new");
      } else if (savedFile) {
        // Untouched file endpoint: nothing further to write. Saving text here
        // would silently delete the file the row is serving. A rename above is
        // still a change, so the list is refreshed rather than just closed.
        if (renaming) onSaved(); else onClose();
        return;
      } else {
        await API.saveEndpoint({
          uri: targetUri,
          status: Number(form.status) || 200,
          headers: form.headers,
          body: form.body,
          create: mode === "new",
        });
      }
      onSaved();
    } catch (e) {
      toast("Save failed: " + e.message, "error");
    } finally {
      setSaving(false);
    }
  };

  // The helper line under the URI doubles as that field's error, so it is
  // worked out once here rather than as a five-deep ternary inside the render.
  // Order matters: the state the operator is actually IN wins over the state
  // the row is in.
  const uriHelperIsError = moving ? Boolean(moveError || moveIntoPrefix) : newIntoPrefix;
  let uriHelper;
  if (moving && moveError) {
    uriHelper = <>{moveError} Pick another path.</>;
  } else if (moving && moveIntoPrefix) {
    uriHelper = <>Still under {AUTOPILOT_PREFIX}. Moving it there moves nothing. Pick a path outside the prefix.</>;
  } else if (moving) {
    uriHelper = <>Where it will be served once it leaves {AUTOPILOT_PREFIX}. <span style={{fontFamily:"var(--mono)"}}>{uri}</span> stops serving.</>;
  } else if (newIntoPrefix) {
    uriHelper = <>{AUTOPILOT_PREFIX} is Autopilot's namespace: agents own what lives there and the cleanup run deletes all of it on a schedule. Create this elsewhere, then rename it in if you really mean to hand it over.</>;
  } else if (agentOwned) {
    uriHelper = <>Staged by an agent. Everything under {AUTOPILOT_PREFIX} is Autopilot's to read, replace and delete, and the cleanup run deletes all of it on a schedule, so it is not edited here. Move it out to make it yours.</>;
  } else if (frozen) {
    uriHelper = "Archived. This path is not served. Unarchive it to make any change.";
  } else if (mode === "edit" && form.uri.trim() !== uri) {
    uriHelper = <>Renaming <span style={{fontFamily:"var(--mono)"}}>{uri}</span>. The old path stops serving.</>;
  } else {
    uriHelper = "Path the black hole will serve. Must start with /";
  }

  return (
    <Modal open onClose={onClose}>
      {/* The title names which of the three lists this endpoint is in, using
          the same words as the scope switch, so the modal and the list agree.
          Only a new endpoint is named for the mode, because it is not in any
          list yet.

          It is settled before the fetch returns. `agentOwned` reads the prefix
          off the URI and `fromScope` is the list the row was opened from, so
          the header is correct on the first frame. Deriving "archived" from
          the loaded row instead would show EDIT for as long as the request
          takes and then swap, which looks like a bug in a modal that is
          telling you what you may do to the thing. A move keeps the AUTOPILOT
          title: the row is one until the rename lands, and the field and the
          footer already say what is happening. */}
      <ModalHead
        title={
          mode === "new" ? "NEW ENDPOINT"
            : agentOwned ? "AUTOPILOT ENDPOINT"
              : (frozen || fromScope === "archived") ? "ARCHIVED ENDPOINT"
                : "MANUAL ENDPOINT"
        }
        /* The stored path, not `form.uri`. It is known before the fetch, so it
           does not appear a beat after the title, and it keeps identifying the
           row while the field below holds a rename you have not saved. */
        id={mode === "edit" ? uri : undefined}
        onClose={onClose}
      />
      <div className="modal-body">
        {loading ? (
          <div className="loading"><span className="spinner"/> loading…</div>
        ) : (
          <>
            <div className="field">
              <label>URI</label>
              {/* A rename is an ordinary primary-key update. Nothing else in
                  either store is keyed by the URI, so a file-backed endpoint
                  keeps its object, which is also what makes the move out of
                  `/-/` carry an uploaded payload with it. The write is applied
                  by the button, not as you type.

                  Three renderings, because there are three things this field
                  is: the row's path (locked), a path being edited, and a move
                  target. The move gets its own state rather than borrowing
                  `form.uri`, so abandoning it leaves nothing behind. */}
              {uriLocked ? (
                <div className="readonly-value">{form.uri}</div>
              ) : moving ? (
                <input
                  type="text"
                  placeholder="/acme/oauth-callback"
                  value={moveTo}
                  onChange={(e) => { setMoveTo(e.target.value); setMoveError(""); }}
                  autoFocus
                  spellCheck={false}
                  aria-invalid={uriHelperIsError || undefined}
                />
              ) : (
                <input
                  type="text"
                  placeholder="/api/v1/callback"
                  value={form.uri}
                  onChange={(e) => update("uri", e.target.value)}
                  autoFocus={mode === "new"}
                  spellCheck={false}
                  aria-invalid={newIntoPrefix || undefined}
                />
              )}
              <div className={`helper${uriHelperIsError ? " helper-error" : ""}`}>{uriHelper}</div>
            </div>

            {contentLocked ? (
              <div className="field">
                {savedFile ? (
                  <>
                    <label>Serves a file</label>
                    <div className="readonly-value">
                      {savedFile.filename || "(unnamed)"}
                      {savedFile.content_type ? ` · ${savedFile.content_type}` : ""}
                      {savedFile.missing ? " · object missing" : ""}
                    </div>
                  </>
                ) : (
                  <>
                    <label>Status</label>
                    <div className="readonly-value">{form.status}</div>
                    <label>Headers</label>
                    <pre className="code-block wrap">{form.headers || "(none)"}</pre>
                    <label>Body</label>
                    <pre className="code-block wrap">{form.body || "(empty)"}</pre>
                  </>
                )}
              </div>
            ) : fileMode ? (
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
                    placeholder="Response body. Any text. For a binary, attach a file below instead."
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
        {/* While a move is being typed the footer is the move and nothing else.
            Delete and Archive are still true of this row, but offering them
            mid-decision is offering a different decision. */}
        {mode === "edit" && !moving && (
          <button className="btn danger" onClick={() => onDelete(uri)} disabled={saving || loading}>
            Delete
          </button>
        )}
        <div className="spacer"/>
        {/* ARCHIVE only, not Unarchive, and on the right with the primary
            rather than next to Delete.

            Delete is alone on the left because it is the only thing here you
            cannot take back. Everything on the right is a way of keeping this
            endpoint: Save keeps it serving, Archive keeps it without serving.
            Grouping Archive with Delete filed it under "destroy" and put a
            gap between it and the button it is actually an alternative to.

            Unarchive is not here: it is the opposite errand, the one thing an
            archived endpoint is open to have done to it, so it takes the
            primary slot below. Unmounted for an Autopilot endpoint, matching
            how the file-mode editors are handled: a grayed-out button still
            invites a click, and this one has nothing to offer. An agent-staged
            endpoint is deleted, or moved out of /-/ to become an ordinary
            endpoint that can then be archived. */}
        {mode === "edit" && !loading && !moving && !agentOwned && !form.archived && (
          <button className="btn" onClick={toggleArchive} disabled={saving}>
            Archive
          </button>
        )}
        {/* One ghost button in the whole modal, and only because it is not a
            synonym for closing: cancelling a MOVE returns to the locked view,
            keeping the endpoint you were looking at open. Backing out of a
            path you were choosing should not also throw away what you were
            choosing it for.

            Every other Cancel / Close here did exactly what the ✕ in the
            header does, one pixel-row below it, spending the slot beside the
            primary action on a duplicate, and reading as the cautious half of
            a decision nobody was being asked to make. A modal that can be shut
            with Escape, the backdrop and a ✕ does not need a fourth way. */}
        {moving && (
          <button className="btn ghost" onClick={() => { setMoving(false); setMoveError(""); }}>
            Cancel
          </button>
        )}
        {/* One primary slot, always holding the thing to do here: save your
            edits, unarchive, start the move, or finish it. */}
        {moving ? (
          <button className="btn primary" onClick={moveOut} disabled={saving || moveIntoPrefix || !moveTo.trim()}>
            {saving ? <><span className="spinner"/> moving</> : "Move"}
          </button>
        ) : agentOwned ? (
          <button className="btn primary" onClick={beginMove} disabled={saving || loading}>
            Move to Manual
          </button>
        ) : frozen ? (
          <button className="btn primary" onClick={toggleArchive} disabled={saving}>
            {saving ? <><span className="spinner"/> unarchiving</> : "Unarchive"}
          </button>
        ) : (
          <button className="btn primary" onClick={save} disabled={saving || loading || newIntoPrefix}>
            {saving
              ? <><span className="spinner"/> {file ? "uploading" : "saving"}</>
              : (mode === "new" ? "Create" : "Save")}
          </button>
        )}
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
      title="Grouped. Click to view every message with this From & Subject"
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
      <span className="group-to" title={`${latestTo}, and more in this group`}>
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
              <span className="meta">end of results</span>
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

// ---- Inline (cid:) images in a captured email ------------------------------
//
// An HTML email that shows a picture inline almost never embeds it. It ships the
// picture as a MIME part carrying a Content-ID and refers to it as
// `<img src="cid:whatever@example.com">`. `cid:` is not a scheme a browser can
// resolve. It only means something relative to the message the part came from,
// so the raw HTML renders with a broken image in every mail client that has not
// been told how to resolve it. Ours had not: the parsed HTML went to the iframe
// verbatim, and the parts sat in the attachment list instead.
//
// Resolving it means rewriting each `cid:` reference to a `data:` URL built from
// that part's bytes. `data:` is deliberate rather than `blob:`: the dashboard's
// CSP allows `img-src 'self' data:`, a srcdoc iframe inherits that policy, and
// widening it to `blob:` to save a base64 pass is not a trade worth making.
//
// REMOTE images are left exactly as they are and DO load: the CSP carries
// `img-src ... https:` for them. Worth knowing what that costs, because it is a
// deliberate choice rather than an accident. A remote image in a captured email
// is a beacon, so rendering one tells whoever sent the message the moment an
// operator opened it, from an address belonging to the engagement.
// `Referrer-Policy: no-referrer` keeps the dashboard's own URL out of the
// request; the fetch itself is the part that cannot be hidden.

function base64FromBytes(content) {
  const bytes = content instanceof Uint8Array ? content : new Uint8Array(content);
  // Chunked because String.fromCharCode(...bytes) blows the argument limit on
  // anything bigger than a small icon.
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

// Content-ID arrives as `<id@host>` in the header and is written as `cid:id@host`
// in the markup, so the angle brackets come off before either side is compared.
function normalizeCid(v) {
  return String(v || "").trim().replace(/^</, "").replace(/>$/, "");
}

// Rewrite every cid: reference in `html` that an attachment can satisfy.
// Returns the rewritten HTML plus `missing`: a cid the message referenced but
// shipped no part for, which the viewer reports because it is the one case the
// reader would otherwise read as a bug in the dashboard rather than in the mail.
function resolveInlineImages(html, attachments) {
  if (!html) return { html: "", missing: 0 };

  const byCid = new Map();
  for (const a of attachments || []) {
    const cid = normalizeCid(a.contentId);
    if (cid && a.content) byCid.set(cid, a);
  }

  const dataUrls = new Map();
  const dataUrlFor = (cid) => {
    if (dataUrls.has(cid)) return dataUrls.get(cid);
    const part = byCid.get(cid);
    let url = null;
    if (part) {
      try {
        url = `data:${part.mimeType || "application/octet-stream"};base64,${base64FromBytes(part.content)}`;
      } catch {
        url = null;   // unreadable part: treated as missing, never as a crash
      }
    }
    dataUrls.set(cid, url);
    return url;
  };

  let missing = 0;
  const swap = (cidRaw) => {
    const url = dataUrlFor(normalizeCid(decodeURIComponent(cidRaw.trim())));
    if (url) return url;
    missing++;
    return null;
  };

  // Attribute form: src="cid:x", src='cid:x', src=cid:x. Also href and the
  // legacy background attribute, both of which mail HTML still uses.
  //
  // `srcset` is NOT covered. Its value is a comma-separated list with width and
  // density descriptors, so it needs a parser rather than this substitution,
  // and mail that uses it is rare enough that a half-right replacement would be
  // worse than none. A cid: reference inside a srcset still renders broken.
  let out = html.replace(
    /(\s(?:src|href|background)\s*=\s*)(["']?)cid:([^"'\s>]+)\2/gi,
    (whole, prefix, quote, cid) => {
      const url = swap(cid);
      return url ? `${prefix}${quote || '"'}${url}${quote || '"'}` : whole;
    },
  );

  // CSS form: url(cid:x) in a style attribute or a <style> block.
  out = out.replace(
    /url\(\s*(["']?)cid:([^"')\s]+)\1\s*\)/gi,
    (whole, quote, cid) => {
      const url = swap(cid);
      return url ? `url(${quote || '"'}${url}${quote || '"'})` : whole;
    },
  );

  // `<base target="_blank">` is what makes a link in a captured email open in a
  // new tab instead of trying to navigate the frame. It is injected rather than
  // written onto each anchor because it also covers markup we never see, and a
  // message that sets its own <base> keeps it: the first one in the document
  // wins, so prepending ours only affects documents that declared none.
  return { html: `<base target="_blank">${out}`, missing };
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
        if (!window.PostalMime) throw new Error("Email parser still loading. Try again in a moment");
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
            // Kept so resolveInlineImages can match a `cid:` reference to the
            // part that satisfies it. `related` is postal-mime's own flag for a
            // part the HTML points at, and is what the attachment list uses to
            // say so rather than listing it as a plain file.
            contentId: a.contentId || "",
            related: !!a.related,
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

  // Resolved once per message rather than per render: a message with several
  // inline images base64s every one of them, and the body re-renders on every
  // tab toggle and full-screen press.
  const view = useMemo(
    () => (body ? resolveInlineImages(body.parsed.html, body.parsed.attachments) : null),
    [body],
  );

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
      {view && view.missing > 0 && (
        <div className="notice">
          <span className="glyph">!</span>
          <span>
            {view.missing} inline image{view.missing === 1 ? "" : "s"} referenced but not attached
            to the message.
          </span>
        </div>
      )}
      {/* Scripts stay off: no allow-scripts, no allow-same-origin, so the frame
          keeps its opaque origin and cannot reach the dashboard around it.
          allow-popups plus allow-popups-to-escape-sandbox is what lets a link
          open in a real new tab. Without the second flag the new tab inherits
          the sandbox and lands on a blank page. Browsers only honor it on a
          genuine click, and target=_blank implies noopener everywhere current,
          so the opened page gets no handle back to this one. */}
      <iframe
        sandbox="allow-popups allow-popups-to-escape-sandbox"
        srcDoc={view ? view.html : ""}
        title="email html"
      />
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
                  {/* Whitespace runs are collapsed for display. postal-mime (3.x and later) unfolds
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
                  <span>Body is shown full screen. Press Esc or the collapse button to return.</span>
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
      <div className="body-fullscreen" role="dialog" aria-label="Email body, full screen">
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
