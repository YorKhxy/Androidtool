/* 网络 tab — captured network requests (inferred reconstruction). */

function NetworkTab({ device }) {
  if (!device) return <div className="screen"><div className="screen-body">
    <Empty icon="network" title="未选择设备" sub="选择设备后抓取网络请求" /></div></div>;

  const codeColor = c => c >= 500 ? "var(--danger)" : c >= 300 ? "var(--warning)" : "var(--success)";
  return (
    <div className="screen">
      <div className="ph">
        <h2>网络请求</h2>
        <Badge tone="success" dot>抓取中</Badge>
        <span style={{ color: "var(--fg-tertiary)", fontSize: 12 }}>com.DefaultCompany.PicoClient</span>
        <div className="sp" />
        <Button variant="secondary" size="sm" icon="trash-2">清空</Button>
        <Button variant="secondary" size="sm" icon="download">导出</Button>
      </div>
      <div className="scroll" style={{ flex: 1 }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr style={{ background: "var(--bg-elevated)" }}>
            <th style={cellHead}>方法</th><th style={cellHead}>URL</th>
            <th style={{ ...cellHead, textAlign: "right" }}>状态</th>
            <th style={{ ...cellHead, textAlign: "right" }}>大小</th>
            <th style={{ ...cellHead, textAlign: "right" }}>耗时</th>
          </tr></thead>
          <tbody>{NETWORK.concat(NETWORK).map((r, i) => (
            <tr key={i}>
              <td style={{ ...cell, ...mono, color: "var(--info)" }}>{r.method}</td>
              <td style={{ ...cell, ...mono, color: "var(--fg-primary)" }}>{r.url}</td>
              <td style={{ ...cell, ...mono, textAlign: "right", color: codeColor(r.code) }}>{r.code}</td>
              <td style={{ ...cell, ...mono, textAlign: "right" }}>{r.size}</td>
              <td style={{ ...cell, ...mono, textAlign: "right", color: r.ms > 400 ? "var(--warning)" : "var(--fg-secondary)" }}>{r.ms}ms</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
    </div>
  );
}

window.NetworkTab = NetworkTab;
