/* 投屏 — Screen mirror controls. scrcpy opens a SEPARATE window, so this tab is
   start/settings + Pico-specific warnings + usage notes (no embedded preview). */

const mirrorCard = {
  background: "var(--bg-sidebar)", border: "1px solid var(--border-default)",
  borderRadius: "var(--r-md)", padding: "16px 18px",
};

function MirrorScreen({ device }) {
  const [res, setRes] = useState(1280);
  const [bitrate, setBitrate] = useState("4M");
  const [sound, setSound] = useState(false);
  const [running, setRunning] = useState(false);
  const [keys, setKeys] = useState(false);

  if (!device) return <div className="screen"><div className="screen-body">
    <Empty icon="cast" title="未选择设备" sub="先在「设备」中选择一台设备" /></div></div>;

  return (
    <div className="screen">
      <div className="scroll" style={{ flex: 1, padding: 18, display: "flex", flexDirection: "column", gap: 14 }}>
        {/* control */}
        <div style={mirrorCard}>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
            <div style={{ flex: 1 }}>
              <h2 style={{ marginBottom: 8 }}>投屏镜像与操控</h2>
              <div style={{ fontSize: 13, color: "var(--fg-secondary)" }}>
                当前设备：<b style={{ color: "var(--fg-primary)" }}>{device.name.replace(/\D/g, "") || device.name}</b>
                <span style={{ color: "var(--fg-tertiary)" }}> · Pico 单眼裁切</span>
              </div>
              <div style={{ fontSize: 12.5, marginTop: 6,
                color: running ? "var(--success)" : "var(--fg-tertiary)" }}>
                {running ? "● 投屏中（独立窗口）" : "已停止"}
              </div>
            </div>
            <Button variant={running ? "outline" : "primary"} className={running ? "o-red" : ""}
              icon={running ? "square" : "cast"} onClick={() => setRunning(r => !r)}>
              {running ? "停止投屏" : "开始投屏"}
            </Button>
          </div>
        </div>

        {/* settings */}
        <div style={{ ...mirrorCard, display: "flex", alignItems: "center", gap: 26, flexWrap: "wrap" }}>
          <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, color: "var(--fg-secondary)" }}>
            分辨率上限
            <select className="nat" value={res} onChange={e => setRes(+e.target.value)}>
              {[720, 1280, 1920].map(r => <option key={r} value={r}>{r}</option>)}
            </select>
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, color: "var(--fg-secondary)" }}>
            码率
            <select className="nat" value={bitrate} onChange={e => setBitrate(e.target.value)}>
              {["2M", "4M", "8M", "12M"].map(b => <option key={b} value={b}>{b}</option>)}
            </select>
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 9, fontSize: 13, color: "var(--fg-secondary)", cursor: "pointer", whiteSpace: "nowrap" }}
            onClick={() => setSound(s => !s)}>
            <Checkbox checked={sound} onChange={() => setSound(s => !s)} />把设备声音传到电脑
          </label>
        </div>

        {/* Pico warning */}
        <div style={{ background: "var(--warning-soft)", border: "1px solid #DCA84455",
          borderRadius: "var(--r-md)", padding: "13px 16px", display: "flex", gap: 11 }}>
          <Icon name="triangle-alert" size={17} color="var(--warning)" style={{ flex: "none", marginTop: 1 }} />
          <div style={{ fontSize: 13, color: "var(--fg-secondary)", lineHeight: "20px" }}>
            <b style={{ color: "var(--warning)" }}>Pico 设备：</b>仅支持 <b style={{ color: "var(--fg-primary)" }}>2D 界面</b>
            （启动器、平面应用）的触屏操控；VR 沉浸场景的 <b style={{ color: "var(--fg-primary)" }}>6DoF 手柄无法操控</b>
            （手柄输入走 VR runtime，非标准 Android 事件，scrcpy 无法注入）。画面已自动裁切为单眼显示。
          </div>
        </div>

        {/* usage */}
        <div style={mirrorCard}>
          <h3 style={{ marginBottom: 12 }}>使用说明</h3>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: "var(--fg-secondary)", lineHeight: "23px" }}>
            <li>点击「开始投屏」会调起独立的 scrcpy 镜像窗口，高帧率显示并可操控设备。</li>
            <li>在镜像窗口内用鼠标点击 / 拖拽操作触屏，键盘可直接输入文字。</li>
            <li>把 .apk 文件拖进镜像窗口可直接安装；拖其他文件则推送到设备 /sdcard/Download/。</li>
            <li>关闭镜像窗口或点「停止投屏」即结束，设备上无需安装任何应用。</li>
          </ul>
          <div className="link" style={{ marginTop: 12, fontSize: 13 }} onClick={() => setKeys(k => !k)}>
            {keys ? "▾ 收起快捷键速查" : "▸ 展开快捷键速查"}
          </div>
          {keys && (
            <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "6px 24px" }}>
              {[["Ctrl+C", "复制设备剪贴板"], ["Ctrl+V", "粘贴到设备"], ["Ctrl+S", "切换应用"],
                ["Ctrl+F", "全屏"], ["Ctrl+O", "息屏（保持镜像）"], ["Ctrl+P", "电源键"]].map(([k, v]) => (
                <div key={k} style={{ display: "flex", gap: 10, fontSize: 12.5 }}>
                  <span className="tag">{k}</span><span style={{ color: "var(--fg-tertiary)" }}>{v}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

window.MirrorScreen = MirrorScreen;
