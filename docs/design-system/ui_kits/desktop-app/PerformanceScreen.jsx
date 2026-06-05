/* 性能 — Pico performance diagnostics. VR-specific metrics (MTP, ATW, frame
   timings). Idle shows "--"; 开启采集 starts live sampling. */

const cellHead = { padding: "9px 14px", fontSize: 11, fontWeight: 600, color: "var(--fg-tertiary)",
  textTransform: "uppercase", letterSpacing: ".04em", textAlign: "left" };
const cell = { padding: "9px 14px", fontSize: 12.5, color: "var(--fg-secondary)", borderTop: "1px solid var(--border-subtle)" };
const mono = { fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" };

const perfCard = { background: "var(--bg-sidebar)", border: "1px solid var(--border-default)",
  borderRadius: "var(--r-md)", padding: "16px 18px" };

const METRICS = [
  { code: "FPS", name: "Pico 实时帧率", unit: "", color: "var(--chart-fps)", base: 72, jit: 8, min: 45, max: 90, dp: 0 },
  { code: "CPU", name: "CPU 占用率", unit: "%", color: "var(--chart-cpu)", base: 38, jit: 12, min: 8, max: 95, dp: 1 },
  { code: "MEM", name: "内存占用", unit: "MB", color: "var(--chart-mem)", base: 1840, jit: 60, min: 1600, max: 2400, dp: 0 },
  { code: "GPU", name: "GPU 利用率", unit: "%", color: "#46C6C0", base: 64, jit: 14, min: 20, max: 99, dp: 1 },
  { code: "MTP", name: "Motion-to-Photon", unit: "ms", color: "var(--warning)", base: 18, jit: 5, min: 8, max: 42, dp: 1 },
  { code: "FrmCpu", name: "CPU 帧耗时", unit: "ms", color: "var(--chart-cpu)", base: 9, jit: 3, min: 4, max: 22, dp: 1 },
  { code: "FrmGpu", name: "App GPU 帧耗时", unit: "ms", color: "var(--chart-mem)", base: 11, jit: 3, min: 5, max: 24, dp: 1 },
  { code: "ATWGPU", name: "Compositor GPU", unit: "ms", color: "#46C6C0", base: 3.4, jit: 1, min: 1.5, max: 8, dp: 1 },
];

function MetricCard({ m, collecting, series }) {
  const v = collecting ? series[series.length - 1] : null;
  return (
    <div style={{ ...perfCard, padding: "15px 17px" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 9 }}>
        <span style={{ fontSize: 17, fontWeight: 700, color: collecting ? m.color : "var(--fg-secondary)" }}>{m.code}</span>
        <span style={{ fontSize: 12, color: "var(--fg-tertiary)" }}>{m.name}</span>
      </div>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: 26, fontWeight: 600, margin: "10px 0 8px",
        color: collecting ? "var(--fg-primary)" : "var(--fg-disabled)", fontVariantNumeric: "tabular-nums" }}>
        {v == null ? "--" : v.toFixed(m.dp)}
        {m.unit && <span style={{ fontSize: 13, color: "var(--fg-tertiary)", fontWeight: 500 }}> {m.unit}</span>}
      </div>
      <div style={{ height: 30, margin: "0 -3px" }}>
        {collecting
          ? <LineChart data={series} color={m.color} height={30} fill={false} />
          : <div style={{ height: 1, background: "var(--border-subtle)", marginTop: 22 }} />}
      </div>
    </div>
  );
}

function ReportRow({ title, right, sub }) {
  return (
    <div style={{ ...perfCard, marginTop: 0 }}>
      <div style={{ display: "flex", alignItems: "center" }}>
        <h3>{title}</h3>
        <div style={{ flex: 1 }} />
        {right && <span style={{ fontSize: 12, color: "var(--fg-tertiary)" }}>{right}</span>}
      </div>
      <div style={{ fontSize: 12.5, color: "var(--fg-tertiary)", marginTop: 8 }}>{sub}</div>
    </div>
  );
}

function PerformanceScreen({ device }) {
  const [collecting, setCollecting] = useState(false);
  const [series, setSeries] = useState(() => METRICS.map(m => genSeries(40, m.base, m.jit, m.min, m.max)));

  useEffect(() => {
    if (!collecting) return;
    const t = setInterval(() => {
      setSeries(prev => prev.map((s, i) => {
        const m = METRICS[i];
        const n = Math.max(m.min, Math.min(m.max, s[s.length - 1] + (Math.random() - 0.45) * m.jit));
        return [...s.slice(1), n];
      }));
    }, 850);
    return () => clearInterval(t);
  }, [collecting]);

  if (!device) return <div className="screen"><div className="screen-body">
    <Empty icon="activity" title="未选择设备" sub="选择设备后开始性能诊断" /></div></div>;

  return (
    <div className="screen">
      <div className="scroll" style={{ flex: 1, padding: 18, display: "flex", flexDirection: "column", gap: 14 }}>
        {/* top two panels */}
        <div style={{ display: "flex", gap: 14 }}>
          <div style={{ ...perfCard, flex: 1 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <h2>Pico 性能诊断</h2>
              <div style={{ flex: 1 }} />
              <Badge tone={collecting ? "success" : "neutral"} dot={collecting}>{collecting ? "采集中" : "未采集"}</Badge>
            </div>
            <div style={{ fontSize: 13, color: "var(--fg-secondary)", marginTop: 12 }}>
              {collecting ? "正在实时获取当前设备的性能参数。" : "性能采集已关闭。点击开启后才会获取当前设备的性能参数。"}
            </div>
            <div style={{ fontSize: 12.5, color: "var(--fg-tertiary)", marginTop: 8 }}>
              录制会标记 Pico provider，后续可接入 Pico SDK / 实时流通道。
            </div>
          </div>
          <div style={{ ...perfCard, width: 430, flex: "none" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 13 }}>
              <h3>取证操作</h3>
              <div style={{ flex: 1 }} />
              <Button className="btn" style={{ background: collecting ? "var(--danger)" : "var(--success)", color: "#fff", borderColor: "transparent" }}
                onClick={() => setCollecting(c => !c)}>{collecting ? "停止采集" : "开启采集"}</Button>
            </div>
            <div style={{ display: "flex", gap: 10, marginBottom: 10 }}>
              <Button variant="primary" icon="camera" style={{ flex: 1, justifyContent: "center" }} disabled={!collecting}>抓取快照</Button>
              <Button variant="secondary" icon="file-down" style={{ flex: 1, justifyContent: "center" }} disabled>导出报告</Button>
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              {["10s", "30s", "60s"].map(s => (
                <Button key={s} className="btn" disabled={!collecting} style={{ flex: 1, justifyContent: "center",
                  background: collecting ? "var(--purple)" : "var(--bg-elevated)", color: collecting ? "#fff" : "var(--fg-disabled)",
                  borderColor: "transparent" }}>{s} 录制</Button>
              ))}
            </div>
          </div>
        </div>

        {/* metric grid */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 14 }}>
          {METRICS.map((m, i) => <MetricCard key={m.code} m={m} collecting={collecting} series={series[i]} />)}
        </div>

        {/* reports */}
        <ReportRow title="本次采集报告" right={`采样 ${collecting ? series[0].length : 0} 条 / 快照 0 张`}
          sub={collecting ? "采集进行中，曲线与快照标记将在此累积。" : "开启采集后，这里会显示本次采集曲线和快照标记。"} />
        <ReportRow title="性能快照" sub="还没有快照，先抓一张看看当时的页面和指标。" />
        <ReportRow title="性能录制" right="共 0 段" sub="还没有录制，遇到卡顿时录一段 10s / 30s / 60s 视频。" />
      </div>
    </div>
  );
}

Object.assign(window, { PerformanceScreen, cellHead, cell, mono });
