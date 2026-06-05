/* 日志 — Logcat viewer. Matches the real toolbar: colored actions, filter row,
   V/D/I/W/E/F count chips, and a watermark empty state until started. */

const LV_ORDER = { V: 0, D: 1, I: 2, W: 3, E: 4, F: 5 };

function LogcatScreen({ device }) {
  const [running, setRunning] = useState(false);
  const [logs, setLogs] = useState([]);
  const [filter, setFilter] = useState("");
  const [pkg, setPkg] = useState("");
  const [tag, setTag] = useState("");
  const [pid, setPid] = useState("");
  const [level, setLevel] = useState("ALL");
  const [regex, setRegex] = useState(false);
  const [autoscroll, setAutoscroll] = useState(true);
  const [levelsOn, setLevelsOn] = useState({ V: 1, D: 1, I: 1, W: 1, E: 1, F: 1 });
  const bodyRef = useRef(null);

  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setLogs(ls => [...ls.slice(-600), makeLogLine()]), 600);
    return () => clearInterval(t);
  }, [running]);
  useEffect(() => {
    if (autoscroll && bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [logs, autoscroll]);

  const counts = { V: 0, D: 0, I: 0, W: 0, E: 0, F: 0 };
  logs.forEach(l => counts[l.lvl]++);
  const shown = logs.filter(l => {
    if (!levelsOn[l.lvl]) return false;
    if (level !== "ALL" && LV_ORDER[l.lvl] < LV_ORDER[level]) return false;
    const q = filter.toLowerCase();
    if (q && !(l.tag.toLowerCase().includes(q) || l.msg.toLowerCase().includes(q))) return false;
    if (tag && !l.tag.toLowerCase().includes(tag.toLowerCase())) return false;
    return true;
  });

  if (!device) return <div className="screen"><div className="screen-body">
    <Empty icon="scroll-text" title="未选择设备" sub="选择设备后开始抓取 logcat" /></div></div>;

  const solid = bg => ({ background: bg, color: "#fff", borderColor: bg });
  const lvColors = { V: "var(--log-verbose)", D: "var(--log-debug)", I: "var(--log-info)",
    W: "var(--log-warn)", E: "var(--log-error)", F: "var(--log-fatal)" };

  return (
    <div className="screen">
      {/* toolbar */}
      <div style={{ padding: "14px 16px 0", display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <Button className="btn" style={solid(running ? "var(--bg-elevated)" : "var(--success)")}
            onClick={() => setRunning(true)}>{running ? "运行中" : "开始"}</Button>
          <Button variant="secondary" onClick={() => setRunning(false)}>暂停</Button>
          <Button variant="secondary" onClick={() => setLogs([])}>清空</Button>
          <Button variant="secondary">导出</Button>
          <Button variant="secondary">导出完整日志</Button>
          <Button variant="secondary">按包名导出完整日志</Button>
          <Button className="btn" style={solid("var(--danger)")}>崩溃/ANR</Button>
          <Button className="btn" style={solid("var(--accent)")}
            onClick={() => { setAutoscroll(true); if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight; }}>到底部</Button>
          <Button className="btn" style={solid(autoscroll ? "var(--success)" : "var(--bg-elevated)")}
            onClick={() => setAutoscroll(a => !a)}>自动滚动</Button>
          <div style={{ flex: 1 }} />
          <span style={{ fontSize: 12.5, color: "var(--fg-tertiary)" }}>
            {running ? "● 运行中" : "已停止"} · 运行设备 {running ? 1 : 0} · {shown.length}/{logs.length} 条日志
          </span>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <select className="nat" value={level} onChange={e => setLevel(e.target.value)} style={{ width: 130 }}>
            <option value="ALL">All levels</option>
            {["V", "D", "I", "W", "E", "F"].map(l => <option key={l} value={l}>{l}+</option>)}
          </select>
          <div className="field" style={{ width: 150, height: 34 }}><input value={pkg} onChange={e => setPkg(e.target.value)} placeholder="应用/包名" /></div>
          <div className="field" style={{ width: 130, height: 34 }}><input value={tag} onChange={e => setTag(e.target.value)} placeholder="标签" /></div>
          <div className="field" style={{ flex: 1, height: 34 }}><input value={filter} onChange={e => setFilter(e.target.value)} placeholder="搜索日志" /></div>
          <div className="field" style={{ width: 110, height: 34 }}><input value={pid} onChange={e => setPid(e.target.value)} placeholder="进程 PID" /></div>
          <Button variant={regex ? "outline" : "secondary"} className={regex ? "o-blue" : ""} onClick={() => setRegex(r => !r)}>正则</Button>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {["V", "D", "I", "W", "E", "F"].map(l => {
            const on = levelsOn[l];
            return (
              <div key={l} onClick={() => setLevelsOn(s => ({ ...s, [l]: s[l] ? 0 : 1 }))}
                style={{ display: "inline-flex", alignItems: "center", gap: 6, height: 24, padding: "0 11px",
                  borderRadius: "var(--r-sm)", cursor: "pointer", fontFamily: "var(--font-mono)", fontSize: 12,
                  background: "var(--bg-elevated)", border: "1px solid var(--border-default)",
                  opacity: on ? 1 : 0.4, color: lvColors[l] }}>
                <b>{l}</b><span style={{ color: "var(--fg-tertiary)" }}>{counts[l]}</span>
              </div>
            );
          })}
          <div style={{ flex: 1 }} />
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 11.5, color: "var(--fg-tertiary)" }}>保留 20000 · 批量 50</span>
        </div>
      </div>

      {/* body */}
      <div ref={bodyRef} className="scroll"
        onScroll={e => { const el = e.currentTarget; setAutoscroll(el.scrollHeight - el.scrollTop - el.clientHeight < 40); }}
        style={{ flex: 1, marginTop: 12, background: "var(--bg-mirror)", borderTop: "1px solid var(--border-subtle)",
          fontFamily: "var(--font-mono)", fontSize: 12, padding: shown.length ? "8px 0" : 0, position: "relative" }}>
        {shown.length === 0 ? (
          <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column",
            alignItems: "center", justifyContent: "center", gap: 18 }}>
            <div style={{ fontSize: 72, fontWeight: 700, color: "var(--border-default)", letterSpacing: ".1em" }}>日志</div>
            {!running && <Button variant="primary" onClick={() => setRunning(true)}>开始日志</Button>}
          </div>
        ) : shown.map(l => (
          <div key={l.id} style={{ display: "flex", gap: 10, padding: "1px 16px", lineHeight: "21px" }}>
            <span style={{ color: "var(--fg-tertiary)", flex: "none" }}>{l.ts}</span>
            <span style={{ color: lvColors[l.lvl], fontWeight: 700, width: 10, flex: "none", textAlign: "center" }}>{l.lvl}</span>
            <span style={{ color: lvColors[l.lvl], flex: "none", width: 132, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{l.tag}</span>
            <span style={{ color: "var(--fg-secondary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{l.msg}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

window.LogcatScreen = LogcatScreen;
