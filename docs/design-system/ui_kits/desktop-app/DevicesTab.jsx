/* 设备 tab — 应用安装 (drop + targets) | 已安装应用 (refined list).
   Professional pass: avatars, two-line identity, single action + overflow menu,
   restrained colour, selectable target chips. */

function Checkbox({ checked, onChange }) {
  return (
    <div onClick={onChange}
      style={{ width: 16, height: 16, borderRadius: 4, cursor: "pointer", flex: "none",
        border: "1.5px solid " + (checked ? "var(--accent)" : "var(--border-strong)"),
        background: checked ? "var(--accent)" : "transparent",
        display: "flex", alignItems: "center", justifyContent: "center" }}>
      {checked && <Icon name="check" size={12} color="#fff" />}
    </div>
  );
}

const dtCard = { background: "var(--bg-panel)", border: "1px solid var(--border-subtle)",
  borderRadius: "var(--r-md)", display: "flex", flexDirection: "column", minHeight: 0 };
const eyebrow = { fontSize: 13, fontWeight: 500, color: "var(--fg-tertiary)" };
const panelTitle = { fontSize: 15, fontWeight: 600, color: "var(--fg-primary)", margin: 0 };

function AppRow({ app }) {
  const [running, setRunning] = useState(!!app.running);
  const [hover, setHover] = useState(false);
  return (
    <div onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{ display: "flex", alignItems: "center", gap: 11, padding: "8px 16px",
        borderTop: "1px solid var(--border-subtle)",
        background: hover ? "var(--bg-hover)" : "transparent", transition: "background 110ms" }}>
      <AppAvatar name={app.pkg} size={32} />
      <div style={{ flex: 1, minWidth: 0, fontFamily: "var(--font-mono)", fontSize: 12.5,
        color: "var(--fg-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {app.pkg}
      </div>
      {running && (
        <span style={{ flex: "none", display: "inline-flex", alignItems: "center", gap: 5, height: 20,
          padding: "0 8px", borderRadius: "var(--r-pill)", background: "var(--success-soft)",
          color: "var(--success)", fontSize: 11 }}>
          <span style={{ width: 5, height: 5, borderRadius: 3, background: "var(--success)" }} />运行中
        </span>
      )}
      <button onClick={() => setRunning(r => !r)}
        style={{ flex: "none", display: "inline-flex", alignItems: "center", gap: 5, height: 28, padding: "0 10px",
          border: 0, borderRadius: "var(--r-sm)", cursor: "pointer", fontSize: 12.5, fontWeight: 500,
          fontFamily: "var(--font-sans)", background: hover ? "var(--bg-active)" : "transparent",
          color: hover ? (running ? "var(--fg-primary)" : "var(--accent)") : "var(--fg-tertiary)",
          transition: "all 110ms" }}>
        <Icon name={running ? "square" : "play"} size={13} />{running ? "停止" : "启动"}
      </button>
      <Menu size={28} items={[
        { label: "重启应用", icon: "rotate-cw" },
        { label: "应用信息", icon: "info" },
        { label: "卸载", icon: "trash-2", danger: true },
      ]} />
    </div>
  );
}

function DevicesTab({ devices }) {
  const [concurrency, setConcurrency] = useState(4);
  const [downgrade, setDowngrade] = useState(false);
  const [targets, setTargets] = useState(new Set(devices.map(d => d.id)));
  const [search, setSearch] = useState("");

  const apps = INSTALLED_APPS.filter(a => a.pkg.toLowerCase().includes(search.toLowerCase()));
  const toggleTarget = id => setTargets(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  return (
    <div className="screen">
      <div style={{ flex: 1, minHeight: 0, display: "flex", gap: 16, padding: 18 }}>

        {/* ── 应用安装 ── */}
        <div style={{ ...dtCard, flex: "5 1 0", minWidth: 0, padding: 18, overflowY: "auto" }}>
          <h2 style={panelTitle}>应用安装</h2>

          {/* drop zone */}
          <div style={{ marginTop: 14, padding: "24px 18px", border: "1.5px dashed var(--border-strong)",
            borderRadius: "var(--r-md)", display: "flex", flexDirection: "column", alignItems: "center",
            justifyContent: "center", gap: 11, cursor: "pointer", background: "var(--bg-elevated)",
            textAlign: "center" }}>
            <div style={{ width: 48, height: 48, borderRadius: 12, background: "var(--accent-soft)",
              border: "1px solid var(--accent-soft-bd)", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <Icon name="package-plus" size={24} color="var(--accent)" />
            </div>
            <div style={{ fontSize: 13, color: "var(--fg-secondary)" }}>
              拖入 <b style={{ color: "var(--fg-primary)", fontWeight: 600 }}>.apk</b> 文件，或
            </div>
            <Button variant="secondary" size="sm" icon="folder-open">选择文件</Button>
            <div style={{ fontSize: 11, color: "var(--fg-tertiary)" }}>支持多选 · 拖拽到镜像窗口亦可</div>
          </div>

          {/* options */}
          <div style={{ display: "flex", alignItems: "center", gap: 18, margin: "16px 0",
            paddingBottom: 16, borderBottom: "1px solid var(--border-subtle)", flexWrap: "wrap" }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--fg-secondary)", fontSize: 13 }}>
              并发数
              <select className="nat" value={concurrency} onChange={e => setConcurrency(+e.target.value)}>
                {[1, 2, 4, 8].map(n => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--fg-secondary)",
              fontSize: 13, cursor: "pointer", whiteSpace: "nowrap" }} onClick={() => setDowngrade(d => !d)}>
              <Checkbox checked={downgrade} onChange={() => setDowngrade(d => !d)} />允许降级覆盖
            </label>
          </div>

          {/* target devices */}
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 11 }}>
            <span style={{ ...eyebrow, whiteSpace: "nowrap" }}>目标设备</span>
            <span style={{ fontSize: 12.5, color: "var(--fg-tertiary)" }}>{targets.size}/{devices.length}</span>
            <span className="link" style={{ marginLeft: "auto", fontSize: 12.5 }}
              onClick={() => setTargets(new Set(targets.size === devices.length ? [] : devices.map(d => d.id)))}>
              {targets.size === devices.length ? "全部取消" : "全选"}</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {devices.map(d => {
              const on = targets.has(d.id);
              return (
                <div key={d.id} onClick={() => toggleTarget(d.id)}
                  style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", cursor: "pointer",
                    borderRadius: "var(--r-sm)", border: "1px solid " + (on ? "var(--accent-soft-bd)" : "var(--border-default)"),
                    background: on ? "var(--accent-soft)" : "var(--bg-elevated)" }}>
                  <Checkbox checked={on} onChange={() => toggleTarget(d.id)} />
                  <span style={{ fontSize: 13, color: "var(--fg-primary)", fontWeight: 500 }}>{d.name}</span>
                  <Badge tone={d.conn === "usb" ? "success" : "info"} icon={d.conn === "usb" ? "usb" : "wifi"}>
                    {d.conn === "usb" ? "USB" : "WiFi"}</Badge>
                  <span style={{ marginLeft: "auto", fontFamily: "var(--font-mono)", fontSize: 11.5, color: "var(--fg-tertiary)" }}>{d.id}</span>
                </div>
              );
            })}
          </div>
          <Button variant="primary" icon="download" disabled={targets.size === 0}
            style={{ marginTop: 16, height: 42, justifyContent: "center", fontSize: 13.5, fontWeight: 600, flex: "none" }}>
            安装到 {targets.size} 台设备
          </Button>
        </div>

        {/* ── 已安装应用 ── */}
        <div style={{ ...dtCard, flex: "6 1 0", minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "16px 18px 14px", flex: "none" }}>
            <div style={{ flex: "none" }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 9 }}>
                <h2 style={{ ...panelTitle, whiteSpace: "nowrap" }}>已安装应用</h2>
                <span style={{ color: "var(--fg-tertiary)", fontSize: 12.5, whiteSpace: "nowrap" }}>{apps.length} / {INSTALLED_APPS.length}</span>
              </div>
            </div>
            <div className="field" style={{ flex: "1 1 120px", minWidth: 0, maxWidth: 240, height: 34, marginLeft: "auto" }}>
              <Icon name="search" />
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder="搜索包名" />
            </div>
            <Button variant="secondary" size="sm" icon="refresh-cw">刷新</Button>
          </div>
          <div className="scroll" style={{ flex: 1, minHeight: 0 }}>
            {apps.map(a => <AppRow key={a.pkg} app={a} />)}
            {apps.length === 0 && (
              <div style={{ padding: 40, textAlign: "center", color: "var(--fg-tertiary)", fontSize: 13 }}>无匹配应用</div>
            )}
          </div>
        </div>

      </div>
    </div>
  );
}

window.DevicesTab = DevicesTab;
window.Checkbox = Checkbox;
