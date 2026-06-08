/* 文件 — Device file manager */

function FilesScreen({ device }) {
  const [path, setPath] = useState("/sdcard");
  const [sel, setSel] = useState(new Set());
  const [transfer, setTransfer] = useState(null);

  const items = FILES[path] || [];
  const crumbs = path.split("/").filter(Boolean);

  const toggle = (name) => {
    setSel(s => { const n = new Set(s); n.has(name) ? n.delete(name) : n.add(name); return n; });
  };
  const enter = (it) => {
    if (it.dir) {
      const np = path + "/" + it.name;
      if (FILES[np]) { setPath(np); setSel(new Set()); }
    }
  };
  const goCrumb = (i) => {
    const np = "/" + crumbs.slice(0, i + 1).join("/");
    setPath(FILES[np] ? np : "/sdcard"); setSel(new Set());
  };
  const runTransfer = (dir) => {
    setTransfer({ dir, name: sel.size ? [...sel][0] : "app-release.apk", pct: 0 });
  };
  useEffect(() => {
    if (!transfer || transfer.pct >= 100) return;
    const t = setTimeout(() => setTransfer(tr => tr ? { ...tr, pct: Math.min(100, tr.pct + 11) } : null), 220);
    return () => clearTimeout(t);
  }, [transfer]);

  if (!device) return (
    <div className="screen">
      <div className="screen-head"><h2>文件</h2></div>
      <div className="screen-body"><Empty icon="folder-tree" title="未选择设备" sub="选择设备后浏览其文件系统" /></div>
    </div>
  );

  const fileIcon = (it) => it.dir ? "folder"
    : /\.(apk)$/.test(it.name) ? "package"
    : /\.(mp4|mov)$/.test(it.name) ? "film"
    : /\.(zip|tar|gz)$/.test(it.name) ? "file-archive"
    : /\.(png|jpg|webp)$/.test(it.name) ? "image"
    : /\.(json|csv|txt|pdf)$/.test(it.name) ? "file-text" : "file";

  return (
    <div className="screen">
      <div className="screen-head" style={{ gap: 8 }}>
        <h2 style={{ marginRight: 4 }}>文件</h2>
        {/* breadcrumb */}
        <div style={{ display: "flex", alignItems: "center", gap: 4, flex: 1, overflow: "hidden",
          fontFamily: "var(--font-mono)", fontSize: 12.5 }}>
          <Icon name="smartphone" size={14} color="var(--fg-tertiary)" />
          {crumbs.map((c, i) => (
            <React.Fragment key={i}>
              <span onClick={() => goCrumb(i)} style={{ cursor: "pointer",
                color: i === crumbs.length - 1 ? "var(--fg-primary)" : "var(--fg-tertiary)" }}>{c}</span>
              {i < crumbs.length - 1 && <Icon name="chevron-right" size={13} color="var(--fg-disabled)" />}
            </React.Fragment>
          ))}
        </div>
        <div className="sp" />
        {sel.size > 0 && (
          <React.Fragment>
            <span style={{ fontSize: 12, color: "var(--fg-tertiary)" }}>已选 {sel.size}</span>
            <Button variant="secondary" size="sm" icon="download" onClick={() => runTransfer("pull")}>下载</Button>
            <Button variant="danger" size="sm" icon="trash-2">删除</Button>
          </React.Fragment>
        )}
        <Button variant="secondary" size="sm" icon="upload" onClick={() => runTransfer("push")}>上传</Button>
        <Button variant="secondary" size="sm" icon="folder-plus" />
        <Button variant="secondary" size="sm" icon="refresh-cw" />
      </div>

      <div className="screen-body">
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr style={{ background: "var(--bg-elevated)" }}>
            <th style={{ ...cellHead, width: 36 }}></th>
            <th style={cellHead}>名称</th>
            <th style={{ ...cellHead, textAlign: "right", width: 120 }}>大小</th>
            <th style={{ ...cellHead, textAlign: "right", width: 170 }}>修改时间</th>
          </tr></thead>
          <tbody>{items.map(it => {
            const checked = sel.has(it.name);
            return (
              <tr key={it.name} onClick={() => enter(it)}
                style={{ cursor: it.dir ? "pointer" : "default",
                  background: checked ? "var(--accent-soft)" : "transparent" }}
                onMouseEnter={e => { if (!checked) e.currentTarget.style.background = "var(--bg-hover)"; }}
                onMouseLeave={e => { if (!checked) e.currentTarget.style.background = "transparent"; }}>
                <td style={{ ...cell, textAlign: "center" }} onClick={e => { e.stopPropagation(); toggle(it.name); }}>
                  <div style={{ width: 16, height: 16, borderRadius: 4, margin: "0 auto",
                    border: "1.5px solid " + (checked ? "var(--accent)" : "var(--border-strong)"),
                    background: checked ? "var(--accent)" : "transparent", display: "flex",
                    alignItems: "center", justifyContent: "center" }}>
                    {checked && <Icon name="check" size={12} color="var(--fg-on-accent)" />}
                  </div>
                </td>
                <td style={{ ...cell }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <Icon name={fileIcon(it)} size={17}
                      color={it.dir ? "var(--info)" : "var(--fg-tertiary)"} />
                    <span style={{ color: "var(--fg-primary)", fontSize: 13 }}>{it.name}</span>
                  </div>
                </td>
                <td style={{ ...cell, ...mono, textAlign: "right" }}>{it.size}</td>
                <td style={{ ...cell, ...mono, textAlign: "right", color: "var(--fg-tertiary)" }}>{it.mtime}</td>
              </tr>
            );
          })}</tbody>
        </table>
      </div>

      {transfer && (
        <div style={{ flex: "none", padding: "10px 16px", borderTop: "1px solid var(--border-subtle)",
          background: "var(--bg-panel)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 7 }}>
            <Badge tone={transfer.dir === "pull" ? "info" : "success"}
              icon={transfer.dir === "pull" ? "download" : "upload"}>
              {transfer.dir === "pull" ? "下载" : "上传"}</Badge>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--fg-secondary)" }}>{transfer.name}</span>
            <div style={{ flex: 1 }} />
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 12,
              color: transfer.pct >= 100 ? "var(--success)" : "var(--fg-tertiary)" }}>
              {transfer.pct >= 100 ? "完成" : transfer.pct + "%"}</span>
            <Icon name={transfer.pct >= 100 ? "check-circle" : "x"} size={15}
              color={transfer.pct >= 100 ? "var(--success)" : "var(--fg-tertiary)"}
              style={{ cursor: "pointer" }} />
          </div>
          <div style={{ height: 5, borderRadius: 3, background: "var(--bg-active)", overflow: "hidden" }}>
            <div style={{ height: "100%", width: transfer.pct + "%", borderRadius: 3,
              background: transfer.dir === "pull" ? "var(--info)" : "var(--accent)", transition: "width 200ms" }} />
          </div>
        </div>
      )}
    </div>
  );
}

window.FilesScreen = FilesScreen;
