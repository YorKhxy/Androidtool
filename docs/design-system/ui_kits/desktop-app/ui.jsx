/* Shared UI primitives for the 安卓设备监控 UI kit. */

const { useState, useEffect, useRef, useMemo } = React;

/* Lucide icon — renders real Lucide SVG into a React-owned span, sidestepping
   reconciliation by managing innerHTML manually. */
function Icon({ name, size = 16, color, className = "", style = {} }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !window.lucide) return;
    el.innerHTML = "";
    const i = document.createElement("i");
    i.setAttribute("data-lucide", name);
    el.appendChild(i);
    window.lucide.createIcons({ root: el });
  }, [name]);
  return (
    <span
      ref={ref}
      className={"icon " + className}
      style={{ width: size, height: size, color, ...style }}
    />
  );
}

function Button({ variant = "secondary", size, icon, children, className = "", ...rest }) {
  const cls = ["btn", variant, size === "sm" ? "sm" : "", !children ? "iconbtn" : "", className]
    .filter(Boolean).join(" ");
  return (
    <button className={cls} {...rest}>
      {icon && <Icon name={icon} />}
      {children}
    </button>
  );
}

function Badge({ tone = "neutral", icon, dot, children }) {
  const map = {
    success: { bg: "var(--success-soft)", fg: "var(--success)" },
    info:    { bg: "var(--info-soft)",    fg: "var(--info)" },
    warning: { bg: "var(--warning-soft)", fg: "var(--warning)" },
    danger:  { bg: "var(--danger-soft)",  fg: "var(--danger)" },
    neutral: { bg: "var(--bg-elevated)",  fg: "var(--fg-secondary)" },
  };
  const c = map[tone] || map.neutral;
  return (
    <span className="badge" style={{ background: c.bg, color: c.fg }}>
      {dot && <span className="dot" style={{ background: c.fg }} />}
      {icon && <Icon name={icon} />}
      {children}
    </span>
  );
}

const Tag = ({ children }) => <span className="tag">{children}</span>;

/* App-icon avatar — cohesive cool-tone tile keyed off the package name.
   Non-semantic palette so green/red stay reserved for status. */
const AV_COLORS = ["#5597DC", "#46C6C0", "#A78BFA", "#6E8BE8", "#8C7BE0", "#5BA8C4", "#7C89A8", "#C77DD6"];
function AppAvatar({ name, size = 36 }) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  const col = AV_COLORS[h % AV_COLORS.length];
  const letter = ((name.replace(/^[a-z0-9]+\.[a-z0-9]+\./i, "").replace(/[^a-zA-Z0-9]/g, "")[0]) ||
    name.replace(/[^a-zA-Z0-9]/g, "")[0] || "?").toUpperCase();
  return (
    <span style={{ width: size, height: size, flex: "none", borderRadius: size * 0.28,
      background: col + "1F", border: "1px solid " + col + "44", color: col,
      display: "flex", alignItems: "center", justifyContent: "center",
      fontWeight: 700, fontSize: size * 0.42, fontFamily: "var(--font-sans)" }}>{letter}</span>
  );
}

/* Overflow (kebab) menu */
function Menu({ items, size = 30 }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ position: "relative" }}>
      <button className="btn iconbtn" style={{ width: size, height: size }}
        onClick={() => setOpen(o => !o)}><Icon name="more-horizontal" size={16} /></button>
      {open && (
        <React.Fragment>
          <div style={{ position: "fixed", inset: 0, zIndex: 40 }} onClick={() => setOpen(false)} />
          <div style={{ position: "absolute", top: size + 4, right: 0, zIndex: 41, minWidth: 132,
            background: "var(--bg-elevated)", border: "1px solid var(--border-default)",
            borderRadius: "var(--r-md)", boxShadow: "var(--sh-pop)", padding: 5 }}>
            {items.map((it, i) => (
              <div key={i} onClick={() => { setOpen(false); it.onClick && it.onClick(); }}
                style={{ display: "flex", alignItems: "center", gap: 9, height: 32, padding: "0 10px",
                  borderRadius: "var(--r-sm)", cursor: "pointer", fontSize: 13, whiteSpace: "nowrap",
                  color: it.danger ? "var(--danger)" : "var(--fg-secondary)" }}
                onMouseEnter={e => e.currentTarget.style.background = it.danger ? "var(--danger-soft)" : "var(--bg-hover)"}
                onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                {it.icon && <Icon name={it.icon} size={15} />}{it.label}
              </div>
            ))}
          </div>
        </React.Fragment>
      )}
    </div>
  );
}

function Empty({ icon, title, sub, children }) {
  return (
    <div className="empty">
      <Icon name={icon} size={40} />
      <div className="et">{title}</div>
      {sub && <div className="es">{sub}</div>}
      {children}
    </div>
  );
}

/* Segmented control (tabs) */
function Segmented({ value, onChange, options }) {
  return (
    <div style={{ display: "inline-flex", background: "var(--bg-elevated)",
      border: "1px solid var(--border-default)", borderRadius: "var(--r-sm)", padding: 2, gap: 2 }}>
      {options.map(o => {
        const active = o.value === value;
        return (
          <button key={o.value} onClick={() => onChange(o.value)}
            style={{ display: "inline-flex", alignItems: "center", gap: 6, height: 24, padding: "0 11px",
              border: 0, borderRadius: 4, cursor: "pointer", fontSize: 12.5, fontFamily: "var(--font-sans)",
              fontWeight: active ? 600 : 500,
              background: active ? "var(--bg-active)" : "transparent",
              color: active ? "var(--fg-primary)" : "var(--fg-tertiary)" }}>
            {o.icon && <Icon name={o.icon} size={14} />}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/* A tiny SVG line chart for performance series */
function LineChart({ data, color, height = 120, max, fill = true }) {
  const w = 600, h = height, pad = 6;
  const mx = max || Math.max(...data, 1);
  const step = (w - pad * 2) / (data.length - 1);
  const pts = data.map((v, i) => [pad + i * step, h - pad - (v / mx) * (h - pad * 2)]);
  const line = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ");
  const area = line + ` L ${pad + (data.length - 1) * step} ${h - pad} L ${pad} ${h - pad} Z`;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ width: "100%", height }}>
      {[0.25, 0.5, 0.75].map(g => (
        <line key={g} x1={pad} x2={w - pad} y1={h * g} y2={h * g}
          stroke="var(--chart-grid)" strokeWidth="1" />
      ))}
      {fill && <path d={area} fill={color} opacity="0.10" />}
      <path d={line} fill="none" stroke={color} strokeWidth="2"
        strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

Object.assign(window, { Icon, Button, Badge, Tag, AppAvatar, Menu, Empty, Segmented, LineChart,
  useState, useEffect, useRef, useMemo });
