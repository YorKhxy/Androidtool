/* Left device sidebar — connection, device list, device info, history.
   Pixel-matched to the real 设备 view. */

function BatteryGlyph({ pct }) {
  const low = pct < 30;
  const col = low ? "var(--warning)" : "var(--success)";
  const W = 22, H = 11, fill = Math.max(2, Math.round((W - 4) * pct / 100));
  return (
    <span style={{ display: "inline-flex", alignItems: "center", flex: "none" }} title={pct + "%"}>
      <svg width={W + 3} height={H} viewBox={`0 0 ${W + 3} ${H}`}>
        <rect x="0.5" y="0.5" width={W - 1} height={H - 1} rx="2.5"
          fill="none" stroke="var(--border-strong)" strokeWidth="1" />
        <rect x={W + 0.5} y={H / 2 - 2} width="2.5" height="4" rx="1" fill="var(--border-strong)" />
        <rect x="2" y="2" width={fill} height={H - 4} rx="1" fill={col} />
      </svg>
    </span>
  );
}

function SegCtl({ items }) {
  const [hi, setHi] = useState(-1);
  return (
    <div style={{ display: "flex", border: "1px solid var(--border-default)", borderRadius: "var(--r-sm)",
      overflow: "hidden", background: "var(--bg-elevated)" }} onClick={e => e.stopPropagation()}>
      {items.map((it, i) => (
        <button key={it.label} title={it.label} onMouseEnter={() => setHi(i)} onMouseLeave={() => setHi(-1)}
          style={{ flex: 1, height: 32, display: "inline-flex", alignItems: "center", justifyContent: "center",
            gap: 5, border: 0, borderLeft: i ? "1px solid var(--border-default)" : "0", cursor: "pointer",
            fontSize: 11.5, fontFamily: "var(--font-sans)",
            background: hi === i ? "var(--bg-active)" : "transparent",
            color: hi === i ? "var(--fg-primary)" : "var(--fg-secondary)", transition: "all 110ms" }}>
          <Icon name={it.icon} size={14} />{it.label}
        </button>
      ))}
    </div>
  );
}

function DeviceCard({ dev, selected, onSelect, onOpenFiles }) {
  return (
    <div onClick={() => onSelect(dev.id)}
      style={{ background: "var(--bg-panel)", borderRadius: "var(--r-md)", padding: 15,
        marginBottom: 12, cursor: "pointer",
        border: "1px solid " + (selected ? "var(--border-selected)" : "var(--border-default)"),
        boxShadow: selected ? "0 0 0 1px var(--border-selected)" : "none" }}>
      {/* header */}
      <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
        <span style={{ fontSize: 15, fontWeight: 600, color: "var(--fg-primary)" }}>{dev.name}</span>
        <Badge tone="info" icon="wifi">WiFi</Badge>
        <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 5,
          fontSize: 12, color: "var(--success)" }}>
          <span style={{ width: 6, height: 6, borderRadius: 3, background: "var(--success)" }} />已连接
        </span>
      </div>

      {/* meta */}
      <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--fg-secondary)", marginTop: 9 }}>{dev.id}</div>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-tertiary)", marginTop: 3 }}>SN {dev.serial}</div>

      {/* battery + latency */}
      <div style={{ display: "flex", alignItems: "center", gap: 9, margin: "12px 0",
        paddingBottom: 13, borderBottom: "1px solid var(--border-subtle)" }}>
        <BatteryGlyph pct={dev.battery} />
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 13, fontWeight: 600,
          color: dev.battery < 30 ? "var(--warning)" : "var(--fg-primary)" }}>{dev.battery}%</span>
        <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 5,
          fontFamily: "var(--font-mono)", fontSize: 11.5, color: "var(--info)", whiteSpace: "nowrap" }}>
          <Icon name="activity" size={12} color="var(--info)" />{dev.latency}ms
        </span>
      </div>

      {/* segmented controls */}
      <SegCtl items={[
        { label: "息屏", icon: "moon" },
        { label: "唤醒", icon: "sun" },
        { label: "解锁", icon: "lock-open" },
        { label: "重启", icon: "rotate-cw" },
      ]} />

      {/* primary + disconnect */}
      <div style={{ display: "flex", gap: 8, marginTop: 9 }} onClick={e => e.stopPropagation()}>
        <button onClick={() => onOpenFiles(dev.id)}
          style={{ flex: 1, height: 36, display: "inline-flex", alignItems: "center", justifyContent: "center",
            gap: 8, background: "var(--bg-elevated)", border: "1px solid var(--border-default)",
            borderRadius: "var(--r-sm)", color: "var(--fg-primary)", fontSize: 13, fontWeight: 500,
            cursor: "pointer", fontFamily: "var(--font-sans)" }}>
          <Icon name="folder" size={15} color="var(--gold)" />文件管理
        </button>
        <button title="断开设备"
          style={{ width: 36, height: 36, display: "inline-flex", alignItems: "center", justifyContent: "center",
            background: "transparent", border: "1px solid var(--border-default)", borderRadius: "var(--r-sm)",
            color: "var(--danger)", cursor: "pointer" }}
          onMouseEnter={e => { e.currentTarget.style.background = "var(--danger-soft)"; e.currentTarget.style.borderColor = "var(--danger)"; }}
          onMouseLeave={e => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.borderColor = "var(--border-default)"; }}>
          <Icon name="unplug" size={15} color="var(--danger)" />
        </button>
      </div>
    </div>
  );
}

function InfoRow({ k, v, accent }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 0",
      fontSize: 12.5, borderBottom: "1px solid var(--border-subtle)" }}>
      <span style={{ color: "var(--fg-tertiary)" }}>{k}</span>
      <span style={{ color: accent || "var(--fg-primary)", fontFamily: "var(--font-mono)" }}>{v}</span>
    </div>
  );
}

function Sidebar({ devices, selectedId, onSelect, onConnect, onOpenFiles }) {
  const [ip, setIp] = useState("");
  const dev = devices.find(d => d.id === selectedId);

  return (
    <div className="sidebar">
      {/* built-in ADB status */}
      <div style={{ background: "var(--success-soft)", border: "1px solid #54C08455",
        borderRadius: "var(--r-md)", padding: "11px 13px", marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 13, fontWeight: 600, color: "var(--success)" }}>
          <span style={{ width: 7, height: 7, borderRadius: 4, background: "var(--success)" }} />
          内置 ADB 已就绪 · 1.0.41
        </div>
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--fg-tertiary)",
          marginTop: 7, wordBreak: "break-all", lineHeight: "15px" }}>
          E:\Programs\android-device-monitor\resources\platform-tools\win\platform-tools\adb.exe
        </div>
      </div>

      {/* connect */}
      <div className="seclabel" style={{ marginTop: 0 }}>WiFi 连接</div>
      <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
        <div className="field" style={{ flex: 1 }}>
          <input value={ip} onChange={e => setIp(e.target.value)} placeholder="设备 IP 地址:端口" />
        </div>
        <Button variant="primary" onClick={() => { onConnect(ip); setIp(""); }}>连接</Button>
      </div>
      <div style={{ fontSize: 12.5, marginBottom: 16 }}>
        <span style={{ color: "var(--fg-tertiary)" }}>Android 11+ 无线调试? </span>
        <span className="link">点此配对</span>
      </div>

      <div className="seclabel">设备列表</div>
      <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
        <Button variant="secondary" style={{ flex: 1, justifyContent: "center" }}>刷新设备</Button>
        <Button variant="secondary" style={{ flex: 1, justifyContent: "center" }} icon="usb">连接 USB</Button>
      </div>

      {devices.map(d => (
        <DeviceCard key={d.id} dev={d} selected={d.id === selectedId} onSelect={onSelect} onOpenFiles={onOpenFiles} />
      ))}

      {/* device info */}
      {dev && (
        <div style={{ marginTop: 8 }}>
          <div className="seclabel">设备信息</div>
          <div style={{ fontSize: 12, color: "var(--fg-tertiary)", marginBottom: 6 }}>自定义名称</div>
          <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
            <div className="field" style={{ flex: 1 }}>
              <input defaultValue={dev.name.replace(/\D/g, "") || dev.name} />
            </div>
            <Button variant="secondary">恢复默认</Button>
          </div>
          <InfoRow k="型号" v={dev.model} />
          <InfoRow k="设备序列号" v={dev.serial} />
          <InfoRow k="厂商" v={dev.brand} />
          <InfoRow k="Android 版本" v={dev.android} />
          <InfoRow k="API 等级" v={dev.api} />
          <InfoRow k="连接方式" v={dev.conn === "usb" ? "USB" : "WiFi"} accent="var(--success)" />
        </div>
      )}

      {/* history */}
      <div style={{ marginTop: 20 }}>
        <div className="seclabel">历史设备</div>
        {HISTORY.map(h => (
          <div key={h.serial} style={{ background: "var(--bg-panel)", border: "1px solid var(--border-default)",
            borderRadius: "var(--r-md)", padding: "12px 14px", marginBottom: 10 }}>
            <div style={{ display: "flex", alignItems: "center" }}>
              <span style={{ fontSize: 14, fontWeight: 600, color: "var(--fg-primary)" }}>{h.name}</span>
              <span style={{ marginLeft: "auto", fontSize: 11.5, color: "var(--fg-tertiary)",
                border: "1px solid var(--border-default)", borderRadius: "var(--r-pill)", padding: "1px 8px" }}>未连接</span>
            </div>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-tertiary)", marginTop: 8 }}>SN: {h.serial}</div>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-tertiary)", marginTop: 3 }}>上次地址: {h.lastAddr}</div>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-tertiary)", marginTop: 3 }}>上次连接: {h.lastSeen}</div>
            <div style={{ display: "flex", gap: 8, marginTop: 11 }}>
              <Button variant="primary" size="sm" onClick={() => onConnect(h.lastAddr)}>快速连接</Button>
              <Button variant="outline" className="o-red" size="sm">移除</Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

window.Sidebar = Sidebar;
