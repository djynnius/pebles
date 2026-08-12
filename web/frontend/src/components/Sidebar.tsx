import { useEffect, useState } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { NAV } from "../nav";
import { Wordmark } from "./Wordmark";

/** What "+ New" can make. Each is an existing route that starts the thing. */
const NEW_ITEMS: { label: string; glyph: string; path: string }[] = [
  { label: "Notebook", glyph: "▧", path: "/notebooks" },
  { label: "SQL query", glyph: "›_", path: "/sql" },
  { label: "Dashboard", glyph: "▦", path: "/dashboards" },
  { label: "Job", glyph: "⇄", path: "/jobbuilder" },
  { label: "Catalog", glyph: "◨", path: "/newcatalog" },
];

export function Sidebar() {
  const [collapsed, setCollapsed] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const nav = useNavigate();
  const loc = useLocation();

  // Dismiss the New menu on any click elsewhere or on Escape.
  useEffect(() => {
    if (!newOpen) return;
    const close = () => setNewOpen(false);
    const key = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("click", close);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", key);
    };
  }, [newOpen]);

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
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-expanded={!collapsed}
          style={railBtn}
        >
          {collapsed ? "»" : "«"}
        </button>
      </div>

      {/* new */}
      <div style={{ padding: collapsed ? "0 12px 8px" : "0 14px 8px", position: "relative" }}>
        <button
          type="button"
          title="New…"
          aria-haspopup="menu"
          aria-expanded={newOpen}
          onClick={(e) => {
            e.stopPropagation();
            setNewOpen((v) => !v);
          }}
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
        {newOpen && (
          <div
            role="menu"
            onClick={(e) => e.stopPropagation()}
            style={{
              position: "absolute",
              left: collapsed ? 56 : 14,
              right: collapsed ? "auto" : 14,
              top: 40,
              minWidth: 168,
              zIndex: 40,
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: 11,
              boxShadow: "0 8px 26px rgba(20,22,16,.22)",
              padding: "5px 0",
            }}
          >
            {NEW_ITEMS.map((item) => (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                onClick={() => {
                  setNewOpen(false);
                  nav(item.path);
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  width: "100%",
                  textAlign: "left",
                  border: "none",
                  background: "transparent",
                  padding: "8px 14px",
                  fontSize: 12.5,
                  fontFamily: "inherit",
                  color: "var(--text-mid)",
                }}
              >
                <span style={{ width: 14, color: "var(--text-faint)" }}>{item.glyph}</span>
                {item.label}
              </button>
            ))}
          </div>
        )}
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
