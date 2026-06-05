/* 安卓设备监控 — App shell: header, device sidebar, top tabs, content router. */

const TABS = [
  { key: "devices", label: "设备", icon: "smartphone" },
  { key: "logcat", label: "日志", icon: "scroll-text" },
  { key: "perf", label: "性能", icon: "activity" },
  { key: "network", label: "网络", icon: "network" },
  { key: "mirror", label: "投屏", icon: "cast" },
];

function App() {
  const [devices, setDevices] = useState(DEVICES_SEED);
  const [selectedId, setSelectedId] = useState(DEVICES_SEED[1].id);
  const [tab, setTab] = useState("devices");
  const [audio, setAudio] = useState("device");
  const [showNotes, setShowNotes] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);

  const device = devices.find(d => d.id === selectedId) || null;

  const connect = (addr) => {
    if (!addr || devices.some(d => d.id === addr)) return;
    const id = addr.includes(":") ? addr : addr + ":5555";
    if (devices.some(d => d.id === id)) { setSelectedId(id); return; }
    const dev = { id, name: "WiFi " + (devices.length + 4), model: "A9210", brand: "Pico",
      type: "headset", conn: "wifi", android: "14", api: 34, abi: "arm64-v8a",
      battery: 70 + ((devices.length * 7) % 25), latency: 40 + devices.length * 6,
      serial: "PA9410MG" + (250000 + devices.length * 137) };
    setDevices(ds => [...ds, dev]); setSelectedId(dev.id);
  };
  const openFiles = (id) => { setSelectedId(id); setFilesOpen(true); };

  return (
    <div className="win">
      {/* Windows title strip */}
      <div className="titlebar">
        <Icon name="monitor-smartphone" size={14} color="var(--accent)" />
        <span className="tt"><b>安卓设备监控</b></span>
        <div className="wc">
          <div className="wb"><Icon name="minus" /></div>
          <div className="wb"><Icon name="square" /></div>
          <div className="wb close"><Icon name="x" /></div>
        </div>
      </div>

      {/* App header */}
      <div className="appbar">
        <span className="title">安卓设备监控</span>
        <a className="ver" onClick={() => setShowNotes(true)}>v1.0.14</a>
        <Button variant="secondary" size="sm" icon="refresh-cw">检查更新</Button>
      </div>

      {/* Body */}
      <div className="main">
        <Sidebar devices={devices} selectedId={selectedId} onSelect={setSelectedId}
          onConnect={connect} onOpenFiles={openFiles} />

        <div className="stage">
          <div className="panel">
            <div className="tabs">
              {TABS.map(t => (
                <div key={t.key} className={"tab" + (tab === t.key ? " active" : "")} onClick={() => setTab(t.key)}>
                  <Icon name={t.icon} />{t.label}
                </div>
              ))}
            </div>
            {tab === "devices" && <DevicesTab devices={devices} />}
            {tab === "logcat" && <LogcatScreen device={device} embedded />}
            {tab === "perf" && <PerformanceScreen device={device} embedded />}
            {tab === "network" && <NetworkTab device={device} />}
            {tab === "mirror" && <MirrorScreen device={device} audio={audio} setAudio={setAudio}
              onStop={() => setTab("devices")} embedded />}
          </div>
        </div>
      </div>

      {filesOpen && (
        <div className="scrim" onClick={() => setFilesOpen(false)}>
          <div className="modal" style={{ width: 920, height: 600, display: "flex", flexDirection: "column" }}
            onClick={e => e.stopPropagation()}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px",
              borderBottom: "1px solid var(--border-subtle)", flex: "none" }}>
              <Icon name="folder" size={17} color="var(--gold)" />
              <span style={{ fontSize: 14, fontWeight: 600, color: "var(--fg-primary)" }}>文件管理</span>
              <Badge tone="success" dot>{device && device.name}</Badge>
              <div style={{ flex: 1 }} />
              <Icon name="x" size={18} color="var(--fg-tertiary)" style={{ cursor: "pointer" }}
                onClick={() => setFilesOpen(false)} />
            </div>
            <FilesScreen device={device} embedded />
          </div>
        </div>
      )}

      {showNotes && <ReleaseNotes onClose={() => setShowNotes(false)} />}
    </div>
  );
}

function ReleaseNotes({ onClose }) {
  const notes = [
    "新增「按当前包名导出完整日志」",
    "投屏声音支持设备与电脑两边同时出声（低版本自动降级）",
    "文件管理支持批量删除（带二次确认）",
    "传输恢复提示区分上传 / 下载方向",
    "标题栏显示应用版本号，点击查看更新日志",
  ];
  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal" style={{ width: 440 }} onClick={e => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "16px 18px",
          borderBottom: "1px solid var(--border-subtle)" }}>
          <Icon name="sparkles" size={18} color="var(--accent)" />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: "var(--fg-primary)" }}>更新日志</div>
            <div style={{ fontSize: 12, color: "var(--fg-tertiary)", fontFamily: "var(--font-mono)" }}>v1.0.14 · 2026-06-04</div>
          </div>
          <Icon name="x" size={18} color="var(--fg-tertiary)" style={{ cursor: "pointer" }} onClick={onClose} />
        </div>
        <div style={{ padding: "14px 18px", display: "flex", flexDirection: "column", gap: 10 }}>
          {notes.map((n, i) => (
            <div key={i} style={{ display: "flex", gap: 9, fontSize: 13, color: "var(--fg-secondary)", lineHeight: "19px" }}>
              <Icon name="check" size={15} color="var(--accent)" style={{ marginTop: 2, flex: "none" }} />{n}
            </div>
          ))}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "12px 18px",
          borderTop: "1px solid var(--border-subtle)", background: "var(--bg-sidebar)" }}>
          <Badge tone="success" dot>已是最新版本</Badge>
          <div style={{ flex: 1 }} />
          <Button variant="primary" onClick={onClose}>知道了</Button>
        </div>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
