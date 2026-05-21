// AREA 51 — main app: tab navigation, Home, Settings, shell.

function App() {
  const [tab, setTab] = useState("home");
  const [refreshTick, setRefreshTick] = useState(0);
  const triggerRefresh = useCallback(() => setRefreshTick((n) => n + 1), []);

  // Keyboard tab switching: ⌘/ctrl + 1..4
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && /^[1-4]$/.test(e.key)) {
        e.preventDefault();
        const map = ["endpoints", "requests", "emails", "settings"];
        setTab(map[Number(e.key) - 1]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <ConfirmProvider>
      <ToastProvider>
        <BlacklistProvider>
          <div className="app">
            <TopBar tab={tab} setTab={setTab} onRefresh={triggerRefresh}/>
            <div className="workspace">
              {tab === "home" && <Home setTab={setTab}/>}
              {tab === "endpoints" && <EndpointsTab refreshKey={refreshTick}/>}
              {tab === "requests" && <RequestsTab refreshKey={refreshTick}/>}
              {tab === "emails" && <EmailsTab refreshKey={refreshTick}/>}
              {tab === "settings" && <Settings/>}
            </div>
          </div>
        </BlacklistProvider>
      </ToastProvider>
    </ConfirmProvider>
  );
}

// ----------------------------------------------------------------
// TopBar
// ----------------------------------------------------------------

function TopBar({ tab, setTab, onRefresh }) {
  const TABS = [
    { id: "endpoints", label: "Endpoints" },
    { id: "requests", label: "Requests" },
    { id: "emails", label: "Emails" },
    { id: "settings", label: "Settings" },
  ];
  const isListTab = tab === "endpoints" || tab === "requests" || tab === "emails";
  const [spinning, setSpinning] = useState(false);
  const handleRefresh = () => {
    setSpinning(true);
    onRefresh();
    setTimeout(() => setSpinning(false), 600);
  };
  return (
    <div className="topbar">
      <button className="brand" onClick={() => setTab("home")} title="Home" aria-label="Home">
        <svg className="alien" width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M12 2.2c-4.4 0-7.2 3.1-7.2 7.5 0 3 1.3 5.6 3 7.6 1.2 1.5 2.6 2.7 3.4 3.7.4.6 1.2.6 1.6 0 .8-1 2.2-2.2 3.4-3.7 1.7-2 3-4.6 3-7.6 0-4.4-2.8-7.5-7.2-7.5Z" fill="currentColor"/>
          <ellipse cx="8.6" cy="11.4" rx="2.1" ry="2.9" fill="#20242c" transform="rotate(-22 8.6 11.4)"/>
          <ellipse cx="15.4" cy="11.4" rx="2.1" ry="2.9" fill="#20242c" transform="rotate(22 15.4 11.4)"/>
        </svg>
      </button>
      <div className="tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`tab ${tab === t.id ? "active" : ""}`}
            onClick={() => setTab(t.id)}
          >
            <span>{t.label}</span>
          </button>
        ))}
      </div>
      {isListTab && (
        <div className="topbar-right">
          <button
            className={`topbar-action ${spinning ? "spinning" : ""}`}
            onClick={handleRefresh}
            title={`Refresh ${tab}`}
            aria-label={`Refresh ${tab}`}
          >
            <Icon.refresh/>
          </button>
        </div>
      )}
    </div>
  );
}

// ----------------------------------------------------------------
// Home
// ----------------------------------------------------------------

function Home({ setTab }) {
  const tiles = [
    { id: "endpoints", num: "01", title: "Endpoints", desc: "Define what gets served to the target — status, headers, body. Use as callback URLs, SSRF probes, OAuth redirects, payload hosts." },
    { id: "requests",  num: "02", title: "Requests",  desc: "Every HTTP hit on the worker, raw. Inspect method, URL, IP, headers and body." },
    { id: "emails",    num: "03", title: "Emails",    desc: "Inbound emails are received and parsed entirely client-side, with HTML bodies rendered in a sandboxed context to contain untrusted content." },
    { id: "settings",  num: "04", title: "Settings",  desc: "Purge captured rows to stay under D1 quotas." },
  ];

  return (
    <div className="content">
      <div className="home">
        <div className="home-hero">
          <svg className="alien-xl" width="120" height="120" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M12 2.2c-4.4 0-7.2 3.1-7.2 7.5 0 3 1.3 5.6 3 7.6 1.2 1.5 2.6 2.7 3.4 3.7.4.6 1.2.6 1.6 0 .8-1 2.2-2.2 3.4-3.7 1.7-2 3-4.6 3-7.6 0-4.4-2.8-7.5-7.2-7.5Z" fill="currentColor"/>
            <ellipse cx="8.6" cy="11.4" rx="2.1" ry="2.9" fill="#20242c" transform="rotate(-22 8.6 11.4)"/>
            <ellipse cx="15.4" cy="11.4" rx="2.1" ry="2.9" fill="#20242c" transform="rotate(22 15.4 11.4)"/>
          </svg>
          <h1>AREA 51</h1>
          <div className="sub">/ɛəriə ˌfɪfti ˈwʌn/</div>
        </div>

        <div className="home-intro">
          <p className="lede">
            Welcome to <b>AREA 51</b> — otherwise forbidden, but exclusively developed for the
            pentest team at <a className="ext" href="https://thoropass.com" target="_blank" rel="noreferrer noopener">Thoropass</a>.
          </p>
          <p>
            This is the management console for our out-of-band callback infrastructure. Use it to
            host custom endpoints during engagements, watch what targets send our way, and prove
            out interaction-based vulnerabilities.
          </p>
        </div>

        <div className="home-tiles">
          {tiles.map((t) => (
            <button key={t.id} className="home-tile" onClick={() => setTab(t.id)}>
              <span className="num">{t.num}</span>
              <span className="title-row">
                <span className="t">{t.title}</span>
                <span className="arrow">→</span>
              </span>
              <span className="desc">{t.desc}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------
// Settings
// ----------------------------------------------------------------

function Settings() {
  const toast = useToast();
  const confirm = useConfirm();
  const [table, setTable] = useState("requests");
  const [keep, setKeep] = useState(100);
  const [purging, setPurging] = useState(false);

  const doPurge = async () => {
    const keepNum = Number(keep);
    if (!Number.isInteger(keepNum) || keepNum < 0) {
      toast("Keep value must be a non-negative integer", "error");
      return;
    }
    const ok = await confirm({
      title: "Purge " + table,
      message: `This will keep the latest ${keepNum} ${table} by timestamp and permanently delete all older rows. This cannot be undone.`,
      confirmLabel: "Purge",
      danger: true,
    });
    if (!ok) return;
    setPurging(true);
    try {
      const res = await API.purge({ table, keep: keepNum });
      toast(`Purged ${(res.deleted || 0).toLocaleString()} rows from ${table}`, "success");
    } catch (e) {
      toast("Purge failed: " + e.message, "error");
    } finally {
      setPurging(false);
    }
  };

  const bl = useBlacklist();

  return (
    <div className="content">
      <div className="settings">
        <div className="settings-section">
          <h2>Purge captured data</h2>
          <p className="desc">
            Cloudflare D1 is free, but not unlimited. To make sure we stay under the limits, it is important to actively purge the request and email records.
          </p>
          <div className="settings-card">
            <div className="settings-row">
              <div className="field" style={{marginBottom:0}}>
                <label>Table</label>
                <select value={table} onChange={(e) => setTable(e.target.value)}>
                  <option value="requests">Requests</option>
                  <option value="emails">Emails</option>
                </select>
              </div>
              <div className="field" style={{marginBottom:0}}>
                <label>Keep latest</label>
                <input
                  type="number"
                  min="0"
                  value={keep}
                  onChange={(e) => setKeep(e.target.value)}
                />
              </div>
              <button className="btn danger" onClick={doPurge} disabled={purging}>
                {purging ? <><span className="spinner"/> purging</> : "Purge"}
              </button>
            </div>
            <div className="danger-banner">
              <span className="glyph">!</span>
              <span>
                will keep the latest <b style={{color:"var(--s2)"}}>{keep}</b> {table} · older rows permanently deleted · no undo
              </span>
            </div>
          </div>
        </div>

        <div className="settings-section">
          <h2>Blacklists</h2>
          <p className="desc">
            The worker checks these lists before writing to D1. Anything matching is dropped silently — never logged, never stored. Existing captured rows are not affected; purge separately if you want them gone. <b>Changes take up to 60 minutes to fully propagate</b> (edge cache TTL) — applies to both additions and removals.
          </p>
          <div className="blacklist-grid">
            <BlacklistManager
              title="Remote IPs"
              caption="HTTP requests from these IPs are dropped before D1 write."
              placeholder="e.g. 203.0.113.42"
              values={bl.ips.map((r) => r.ip)}
              onAdd={async (v) => {
                const trimmed = v.trim();
                if (!trimmed) return;
                try {
                  const res = await bl.addIp(trimmed);
                  if (!res.ok) { toast("Invalid IP", "error"); return; }
                  toast(res.already ? `${trimmed} already on list` : `${trimmed} blacklisted`, res.already ? "info" : "success");
                } catch (e) {
                  toast("Add failed: " + e.message, "error");
                }
              }}
              onRemove={async (v) => {
                try {
                  await bl.removeIp(v);
                  toast(`${v} removed from blacklist`, "success");
                } catch (e) {
                  toast("Remove failed: " + e.message, "error");
                }
              }}
              mono
            />
            <BlacklistManager
              title="Senders"
              caption="Emails from these senders are accepted by MX but dropped before D1 write."
              placeholder="e.g. spam@example.com"
              values={bl.emails.map((r) => r.email)}
              onAdd={async (v) => {
                const trimmed = v.trim();
                if (!trimmed) return;
                try {
                  const res = await bl.addEmail(trimmed);
                  if (!res.ok) { toast("Invalid email", "error"); return; }
                  const shown = normalizeEmail(trimmed);
                  toast(res.already ? `${shown} already on list` : `${shown} blacklisted`, res.already ? "info" : "success");
                } catch (e) {
                  toast("Add failed: " + e.message, "error");
                }
              }}
              onRemove={async (v) => {
                try {
                  await bl.removeEmail(v);
                  toast(`${v} removed from blacklist`, "success");
                } catch (e) {
                  toast("Remove failed: " + e.message, "error");
                }
              }}
              mono
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function BlacklistManager({ title, caption, placeholder, values, onAdd, onRemove, mono }) {
  const [draft, setDraft] = useState("");
  const submit = () => {
    if (!draft.trim()) return;
    onAdd(draft);
    setDraft("");
  };
  return (
    <div className="settings-card blacklist-card">
      <div className="bl-head">
        <h3>{title}</h3>
        <span className="bl-count">{values.length}</span>
      </div>
      <div className="bl-caption">{caption}</div>

      <div className="bl-add">
        <input
          type="text"
          placeholder={placeholder}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } }}
          spellCheck={false}
        />
        <button className="btn" onClick={submit} disabled={!draft.trim()}>
          <span className="plus">+</span> Add
        </button>
      </div>

      {values.length === 0 ? (
        <div className="bl-empty">No entries — list is empty.</div>
      ) : (
        <ul className="bl-list">
          {values.map((v) => (
            <li key={v}>
              <span className={`bl-val ${mono ? "mono" : ""}`}>{v}</span>
              <button className="bl-remove" onClick={() => onRemove(v)} title="Remove from blacklist" aria-label={`Remove ${v}`}>
                <Icon.x/>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ----------------------------------------------------------------
// Mount
// ----------------------------------------------------------------

ReactDOM.createRoot(document.getElementById("root")).render(<App/>);
