import { useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { NAV } from "../nav";
import { Wordmark } from "./Wordmark";

export function Sidebar() {
  const [collapsed, setCollapsed] = useState(false);
  const loc = useLocation();
  const activeId =
    NAV.flatMap((g) => g.items).find(
      (i) => i.path === loc.pathname || (i.id === "dashboards" && loc.pathname.startsWith("/dashboard")),
    )?.id ?? "home";

  return (
    <nav
      style={{
        width: collapsed ? 62 : 236,
        transition: "width .18s ease",
        background: "var(--deep)",
        color: "var(--deep-muted)",
        position: "sticky",
        top: 0,
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        flexShrink: 0,
      }}
    >
      {/* header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: collapsed ? "center" : "space-between",
          padding: "14px 14px 10px",
          minHeight: 52,
        }}
      >
        {!collapsed && <Wordmark />}
        <button
          onClick={() => setCollapsed((c) => !c)}
          title={collapsed ? "Expand" : "Collapse"}
          style={railBtn}
        >
          {collapsed ? "»" : "«"}
        </button>
      </div>

      {/* new */}
      <div style={{ padding: collapsed ? "0 12px 8px" : "0 14px 8px" }}>
        <button
          style={{
            width: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
            padding: "8px 10px",
            borderRadius: 11,
            border: "none",
            background: "var(--accent)",
            color: "var(--on-accent)",
            fontWeight: 600,
            fontSize: 13,
          }}
        >
          + {!collapsed && "New"}
        </button>
      </div>

      {/* nav groups */}
      <div style={{ flex: 1, overflowY: "auto", padding: "6px 10px" }}>
        {NAV.map((group) => (
          <div key={group.title} style={{ marginBottom: 12 }}>
            {!collapsed && <div style={eyebrow}>{group.title}</div>}
            {group.items.map((item) => {
              const on = item.id === activeId;
              return (
                <NavLink
                  key={item.id}
                  to={item.path}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 9,
                    padding: "8px 10px 8px 8px",
                    borderRadius: 10,
                    fontSize: 13.5,
                    justifyContent: collapsed ? "center" : "flex-start",
                    background: on ? "var(--nav-active-bg)" : "transparent",
                    color: on ? "var(--deep-text)" : "var(--deep-muted)",
                    textDecoration: "none",
                  }}
                >
                  {/* reserved active-dot slot (spec §3) */}
                  {!collapsed && (
                    <span
                      style={{
                        width: 5,
                        height: 5,
                        borderRadius: "50%",
                        flexShrink: 0,
                        background: on ? "var(--accent)" : "transparent",
                      }}
                    />
                  )}
                  <span
                    style={{
                      width: 18,
                      textAlign: "center",
                      fontFamily:
                        item.glyph === "N"
                          ? "'Cascadia Code','JetBrains Mono',monospace"
                          : "inherit",
                      color: item.glyph === "N" ? "var(--accent)" : "inherit",
                    }}
                  >
                    {item.glyph}
                  </span>
                  {!collapsed && <span>{item.label}</span>}
                </NavLink>
              );
            })}
          </div>
        ))}
      </div>

      {/* footer */}
      <div style={{ borderTop: "1px solid var(--deep-border)", padding: "8px 10px" }}>
        <NavLink to="/settings" style={{ ...footItem, justifyContent: collapsed ? "center" : "flex-start" }}>
          <span style={{ width: 18, textAlign: "center" }}>⚙</span>
          {!collapsed && <span>Account &amp; Settings</span>}
        </NavLink>
        {!collapsed && (
          <div className="mono" style={{ fontSize: 11, color: "var(--deep-faint)", padding: "8px 10px 4px" }}>
            v0.1.0 · self-hosted
          </div>
        )}
      </div>
    </nav>
  );
}

const railBtn: React.CSSProperties = {
  width: 24,
  height: 24,
  borderRadius: 6,
  border: "none",
  background: "transparent",
  color: "var(--deep-muted)",
  fontSize: 15,
};
const eyebrow: React.CSSProperties = {
  fontSize: 10.5,
  letterSpacing: "0.8px",
  textTransform: "uppercase",
  color: "var(--deep-faint)",
  padding: "6px 10px 4px",
};
const footItem: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 9,
  padding: "8px 10px",
  borderRadius: 10,
  fontSize: 13.5,
  color: "var(--deep-muted)",
  textDecoration: "none",
};
