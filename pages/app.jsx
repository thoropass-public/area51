// AREA 51 — main app: tab navigation, Home, Settings, shell.

// Pulsar-ping theme transition: a circle of the destination theme expands
// radially from the toggle button, with a frost-blue drop-shadow glow at the
// leading edge. Total duration matches the CSS keyframe in styles.css.
const THEME_PING_MS = 700;

function App() {
  const [tab, setTab] = useState("home");
  const [theme, setTheme] = useState(() => {
    try {
      const saved = window.localStorage.getItem("area51:theme");
      if (saved === "light" || saved === "dark") return saved;
    } catch {}
    return "dark";
  });
  // When non-null, a transition overlay is rendered until the wave completes.
  // Shape: { x, y, r, nextTheme }. Set by clicking the toggle; cleared on a
  // timer that fires THEME_PING_MS after the click.
  const [ping, setPing] = useState(null);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    try { window.localStorage.setItem("area51:theme", theme); } catch {}
  }, [theme]);

  // Drive the post-animation cleanup: swap theme, then drop the overlay.
  useEffect(() => {
    if (!ping) return;
    const t = setTimeout(() => {
      setTheme(ping.nextTheme);
      // Tiny buffer so the underlying app has finished its repaint to the
      // new theme by the time the overlay disappears — avoids a one-frame
      // flash of the old theme when the wave is removed.
      setTimeout(() => setPing(null), 40);
    }, THEME_PING_MS);
    return () => clearTimeout(t);
  }, [ping]);

  const toggleTheme = useCallback((e) => {
    // Debounce: ignore additional clicks while a wave is in flight.
    if (ping) return;
    const next = theme === "dark" ? "light" : "dark";

    // Honor the user's OS-level motion preference: skip the wave entirely.
    const reduceMotion = window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduceMotion) {
      setTheme(next);
      return;
    }

    // Origin of the wave = center of the toggle button that was clicked.
    const target = e && e.currentTarget;
    const rect = target && target.getBoundingClientRect();
    const x = rect ? rect.left + rect.width / 2 : window.innerWidth - 24;
    const y = rect ? rect.top + rect.height / 2 : 24;
    const w = window.innerWidth;
    const h = window.innerHeight;
    // Distance from (x, y) to the furthest viewport corner — the radius the
    // wave needs to reach to fully cover the screen.
    const r = Math.sqrt(
      Math.pow(Math.max(x, w - x), 2) +
      Math.pow(Math.max(y, h - y), 2)
    );
    setPing({ x, y, r, nextTheme: next });
  }, [theme, ping]);

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
            <TopBar tab={tab} setTab={setTab} theme={theme} toggleTheme={toggleTheme} pinging={!!ping}/>
            <div className="workspace">
              {tab === "home" && <Home setTab={setTab}/>}
              {tab === "endpoints" && <EndpointsTab/>}
              {tab === "requests" && <RequestsTab/>}
              {tab === "emails" && <EmailsTab/>}
              {tab === "settings" && <Settings/>}
            </div>
          </div>
          {ping && (
            <div
              className="theme-ping"
              data-theme={ping.nextTheme}
              style={{
                "--ping-x": `${ping.x}px`,
                "--ping-y": `${ping.y}px`,
                "--ping-r": `${ping.r}px`,
              }}
              aria-hidden="true"
            />
          )}
        </BlacklistProvider>
      </ToastProvider>
    </ConfirmProvider>
  );
}

// ----------------------------------------------------------------
// TopBar
// ----------------------------------------------------------------

function TopBar({ tab, setTab, theme, toggleTheme, pinging }) {
  const TABS = [
    { id: "endpoints", label: "Endpoints" },
    { id: "requests", label: "Requests" },
    { id: "emails", label: "Emails" },
    { id: "settings", label: "Settings" },
  ];
  return (
    <div className="topbar">
      <button className="brand" onClick={() => setTab("home")} title="Home" aria-label="Home">
        <svg className="alien" width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M12 2.2c-4.4 0-7.2 3.1-7.2 7.5 0 3 1.3 5.6 3 7.6 1.2 1.5 2.6 2.7 3.4 3.7.4.6 1.2.6 1.6 0 .8-1 2.2-2.2 3.4-3.7 1.7-2 3-4.6 3-7.6 0-4.4-2.8-7.5-7.2-7.5Z" fill="currentColor"/>
          <ellipse cx="8.6" cy="11.4" rx="2.1" ry="2.9" fill="var(--n0)" transform="rotate(-22 8.6 11.4)"/>
          <ellipse cx="15.4" cy="11.4" rx="2.1" ry="2.9" fill="var(--n0)" transform="rotate(22 15.4 11.4)"/>
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
      <div className="topbar-right">
        <button
          className={`theme-toggle ${pinging ? "pinging" : ""}`}
          onClick={toggleTheme}
          disabled={pinging}
          title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          aria-label="Toggle theme"
        >
          {theme === "dark" ? (
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
              <circle cx="8" cy="8" r="3" fill="currentColor" stroke="none"/>
              <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.2 3.2l1.4 1.4M11.4 11.4l1.4 1.4M3.2 12.8l1.4-1.4M11.4 4.6l1.4-1.4"/>
            </svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M13.5 9.2A5.5 5.5 0 1 1 6.8 2.5a4.5 4.5 0 0 0 6.7 6.7Z" fill="currentColor"/>
            </svg>
          )}
        </button>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------
// Home
// ----------------------------------------------------------------

// Domains bound to the AREA 51 workers. Rendered as chips orbiting the alien
// on the Home hero. Edit this list to add or remove domains — the orbit
// layout adapts automatically to any N.
//
// Each entry:
//   - domain: the bare hostname (no protocol)
//   - roles:  array containing any of "http" and "mail", describing what
//             the worker(s) on that domain accept.
const DOMAINS = [
  { domain: "0r0.us",             roles: ["http", "mail"] },
  { domain: "thoropentests.com",  roles: ["http", "mail"] },
];

function fmtRoles(roles) {
  return (roles || []).map((r) => r.toLowerCase()).join(" · ");
}

// Compute a chip's (left%, top%) inside the .orbit-stage. Distributes N
// chips evenly around the alien's center, alternating between inner and
// outer orbit rings for visual rhythm. The radius is then clamped per-angle
// so chips never fall outside the visible stage box.
function chipPlacement(i, n) {
  // Stage viewBox: 640 × 320, alien centered at (320, 160).
  const cx = 320, cy = 160, stageW = 640;
  // The .orbit-stage has margin-bottom: -60, so the effective bottom edge
  // (where chips can still be fully visible) is at y ≈ 260, not 320.
  const effectiveBottom = 260;
  // Approximate chip half-extents (we want padding, not pixel-perfect).
  const chipHalfH = 20;
  const chipHalfW = 100;

  const startAngleDeg = -45;
  const stepDeg = 360 / n;
  const angle = ((startAngleDeg + i * stepDeg) * Math.PI) / 180;

  const maxDown = effectiveBottom - chipHalfH - cy;
  const maxUp   = cy - chipHalfH;
  const maxSide = (stageW / 2) - chipHalfW;

  // Desired radius alternates inner/outer ring (matches the two SVG rings).
  let r = i % 2 === 0 ? 132 : 92;

  const sinA = Math.sin(angle);
  const cosA = Math.cos(angle);
  if (sinA > 0) r = Math.min(r, maxDown / sinA);
  if (sinA < 0) r = Math.min(r, maxUp   / -sinA);
  if (cosA !== 0) r = Math.min(r, maxSide / Math.abs(cosA));
  // Never pull the chip into the alien's silhouette.
  r = Math.max(r, 76);

  return {
    leftPct: ((cx + r * cosA) / stageW) * 100,
    topPct:  ((cy + r * sinA) / 320)    * 100,
  };
}

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
          <div className="orbit-stage">
            <svg
              className="orbit-rings"
              viewBox="0 0 640 320"
              preserveAspectRatio="xMidYMid meet"
              aria-hidden="true"
            >
              <circle cx="320" cy="160" r="92"  fill="none" stroke="currentColor" strokeWidth="1" strokeDasharray="2 8"  opacity="0.45"/>
              <circle cx="320" cy="160" r="132" fill="none" stroke="currentColor" strokeWidth="1" strokeDasharray="2 12" opacity="0.28"/>
            </svg>
            <svg className="alien-xl" width="140" height="140" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M12 2.2c-4.4 0-7.2 3.1-7.2 7.5 0 3 1.3 5.6 3 7.6 1.2 1.5 2.6 2.7 3.4 3.7.4.6 1.2.6 1.6 0 .8-1 2.2-2.2 3.4-3.7 1.7-2 3-4.6 3-7.6 0-4.4-2.8-7.5-7.2-7.5Z" fill="currentColor"/>
              <ellipse cx="8.6" cy="11.4" rx="2.1" ry="2.9" fill="var(--n0)" transform="rotate(-22 8.6 11.4)"/>
              <ellipse cx="15.4" cy="11.4" rx="2.1" ry="2.9" fill="var(--n0)" transform="rotate(22 15.4 11.4)"/>
            </svg>
            {DOMAINS.map((d, i) => {
              const p = chipPlacement(i, DOMAINS.length);
              return (
                <div
                  key={d.domain}
                  className="orbit-anchor"
                  style={{ left: `${p.leftPct}%`, top: `${p.topPct}%` }}
                >
                  <div
                    className="orbit-domain"
                    style={{ animationDelay: `${-(i * 1.7) % 7}s` }}
                  >
                    <span className="dot"/>
                    <span className="addr">{d.domain}</span>
                    <span className="scope">{fmtRoles(d.roles)}</span>
                  </div>
                </div>
              );
            })}
          </div>
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

  const isAutopilot = table === "autopilot";
  // Plural noun used in the danger banner, confirm dialog, and toast.
  // Same shape for all three purge targets so the UI reads uniformly.
  const tableLabel = isAutopilot ? "autopilot endpoints" : table;

  const doPurge = async () => {
    const keepNum = Number(keep);
    if (!Number.isInteger(keepNum) || keepNum < 0) {
      toast("Keep value must be a non-negative integer", "error");
      return;
    }
    const ok = await confirm({
      title: "Purge " + tableLabel,
      message: `This will keep the latest ${keepNum} ${tableLabel} and permanently delete all older rows. This cannot be undone.`,
      confirmLabel: "Purge",
      danger: true,
    });
    if (!ok) return;
    setPurging(true);
    try {
      const res = isAutopilot
        ? await API.purgeAutopilot({ keep: keepNum })
        : await API.purge({ table, keep: keepNum });
      toast(`Purged ${(res.deleted || 0).toLocaleString()} ${isAutopilot ? "autopilot endpoints" : "rows from " + table}`, "success");
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
          <h2>Purge data</h2>
          <p className="desc">
            Cloudflare D1 is free, but not unlimited. To make sure we stay under the limits, it is important to actively purge unwanted records.
          </p>
          <div className="settings-card">
            <div className="settings-row">
              <div className="field" style={{marginBottom:0}}>
                <label>Target</label>
                <select value={table} onChange={(e) => setTable(e.target.value)}>
                  <option value="requests">Requests</option>
                  <option value="emails">Emails</option>
                  <option value="autopilot">Autopilot Endpoints</option>
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
                will keep the latest <b style={{color:"var(--s2)"}}>{keep}</b> {tableLabel} · older rows permanently deleted · no undo
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
