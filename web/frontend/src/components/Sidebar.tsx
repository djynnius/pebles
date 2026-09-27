import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { NAV, SETTINGS_ID, activeNavId } from "../nav";
import { Wordmark } from "./Wordmark";
import { APP_VERSION } from "../version";
import { ImportTableDialog } from "./ImportTableDialog";

/**
 * What "+ New" can make. Each is an existing route that starts the thing,
 * except Table, which opens the import wizard in place (no route of its own).
 */
const NEW_ITEMS: { label: string; glyph: string; path: string }[] = [
  { label: "Table", glyph: "▤", path: "" },
  { label: "Notebook", glyph: "▧", path: "/notebooks" },
  { label: "SQL query", glyph: "›_", path: "/sql" },
  { label: "Dashboard", glyph: "▦", path: "/dashboards" },
  { label: "Job", glyph: "⇄", path: "/jobbuilder" },
  { label: "Catalog", glyph: "◨", path: "/newcatalog" },
];

export function Sidebar({ admin }: { admin: boolean }) {
  const [collapsed, setCollapsed] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [importing, setImporting] = useState(false);
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

  // Longest-prefix match with an alias table (nav.ts): nested routes like
  // /notebooks/:name or /jobs/:name/runs/:id keep their section lit.
  const activeId = activeNavId(loc.pathname);
  const settingsOn = activeId === SETTINGS_ID;

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
          flexShrink: 0,
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
      <div
        style={{
          padding: collapsed ? "0 12px 8px" : "0 14px 8px",
          position: "relative",
          flexShrink: 0,
          zIndex: 2,
        }}
      >
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
            fontSize: "var(--fs-base)",
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
                  if (item.path) nav(item.path);
                  else setImporting(true);
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
                  fontSize: "var(--fs-body)",
                  fontFamily: "inherit",
                  color: "var(--text-mid)",
                }}
              >
                <span style={{ width: 18, textAlign: "center", fontSize: "var(--fs-md)", color: "var(--text-faint)" }}>
                  {item.glyph}
                </span>
                {item.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Portalled: the sticky rail is its own stacking context, and the
          dialog must sit above the workbench, not inside the sidebar. */}
      {importing && createPortal(<ImportTableDialog onClose={() => setImporting(false)} />, document.body)}

      {/* nav groups — the only part that scrolls. `minHeight: 0` lets the
          flex item shrink below its content so it scrolls inside the rail
          instead of running under the footer on short viewports. */}
      <div
        className="pb-rail-scroll"
        style={{
          flex: "1 1 auto",
          minHeight: 0,
          overflowY: "auto",
          overscrollBehavior: "contain",
          padding: "6px 10px 10px",
        }}
      >
        {NAV.filter((g) => admin || !g.adminOnly).map((group) => (
          <div key={group.title} style={{ marginBottom: 10 }}>
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
                    padding: "7px 10px 7px 8px",
                    borderRadius: 10,
                    fontSize: "var(--fs-lead)",
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
                      width: 21,
                      flexShrink: 0,
                      textAlign: "center",
                      fontSize: "var(--icon-nav)",
                      lineHeight: 1,
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
      <div
        style={{
          borderTop: "1px solid var(--deep-border)",
          padding: "8px 10px",
          flexShrink: 0,
          background: "var(--deep)",
        }}
      >
        <NavLink
          to="/settings"
          style={{
            ...footItem,
            justifyContent: collapsed ? "center" : "flex-start",
            background: settingsOn ? "var(--nav-active-bg)" : "transparent",
            color: settingsOn ? "var(--deep-text)" : "var(--deep-muted)",
          }}
        >
          <span style={{ width: 21, flexShrink: 0, textAlign: "center", fontSize: "var(--icon-nav)", lineHeight: 1 }}>
            ⚙
          </span>
          {!collapsed && <span>Account &amp; Settings</span>}
        </NavLink>
        {!collapsed && (
          <div className="mono" style={{ fontSize: "var(--fs-label)", color: "var(--deep-faint)", padding: "6px 10px 2px" }}>
            v{APP_VERSION} · self-hosted
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
  fontSize: "var(--fs-lg)",
};
const eyebrow: React.CSSProperties = {
  fontSize: "var(--fs-eyebrow)",
  letterSpacing: "0.8px",
  textTransform: "uppercase",
  color: "var(--deep-faint)",
  padding: "6px 10px 4px",
};
const footItem: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 9,
  padding: "7px 10px",
  borderRadius: 10,
  fontSize: "var(--fs-lead)",
  color: "var(--deep-muted)",
  textDecoration: "none",
};
