import { useState, type CSSProperties, type ReactElement, type ReactNode } from "react";
import { useTight } from "../theme";

/*
 * JupyterLab-style workbench shell (spec §3 "Workbench shell").
 *
 * icon rail (46px) | context panel (266px) | [document tabs + document body]
 *
 * At >=1280px the panel participates in the flex row and pushes the document.
 * At <=1279px (`tight`) it overlays the document with a scrim behind it.
 */

/** Inline-SVG icons for the rail (16x16, 1.5 stroke, no fill — spec §6). */
export type WorkbenchIconName = "folder" | "toc" | "widgets" | "dashboards" | "catalog";

export type WorkbenchRailItem = {
  /** Key into `panels`; also the toggle identity. */
  id: string;
  /** A built-in icon name, or your own 16x16 inline SVG element. */
  icon: WorkbenchIconName | ReactElement;
  /** Tooltip + context-panel header title. */
  title: string;
};

export type WorkbenchTab = {
  id: string;
  name: string;
  /** Small leading glyph, e.g. ▧ for a notebook or ›_ for SQL. */
  icon?: ReactNode;
};

export type WorkbenchTabs = {
  items: WorkbenchTab[];
  activeId?: string;
  onSelect?: (id: string) => void;
  onClose?: (id: string) => void;
  onNew?: () => void;
};

export type WorkbenchProps = {
  /** Rail buttons, top to bottom. */
  rail: WorkbenchRailItem[];
  /** Panel content per rail id — each screen supplies its own tree / ToC. */
  panels: Record<string, ReactNode>;
  /** Document tabs strip (notebook / sql). Omit for routes without tabs. */
  tabs?: WorkbenchTabs;
  /** Rail id open on mount; `null` (default) starts with every panel closed. */
  defaultPanel?: string | null;
  /** The document body. */
  children?: ReactNode;
};

export function Workbench({ rail, panels, tabs, defaultPanel = null, children }: WorkbenchProps) {
  const tight = useTight();
  const [open, setOpen] = useState<string | null>(defaultPanel);

  const openItem = open ? (rail.find((r) => r.id === open) ?? null) : null;
  const showPanel = openItem !== null && openItem.id in panels;

  return (
    <div
      style={{
        display: "flex",
        height: "100%",
        minHeight: 0,
        position: "relative",
        overflow: "hidden",
        background: "var(--surface)",
      }}
    >
      {/* icon rail */}
      <div
        style={{
          width: 46,
          flex: "0 0 46px",
          position: "relative",
          zIndex: 31,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 5,
          padding: "10px 0",
          background: "var(--surface-alt)",
          borderRight: "1px solid var(--border)",
        }}
      >
        {rail.map((item) => {
          const on = item.id === open;
          return (
            <button
              key={item.id}
              type="button"
              title={item.title}
              aria-label={item.title}
              aria-pressed={on}
              onClick={() => setOpen((cur) => (cur === item.id ? null : item.id))}
              style={{
                width: 32,
                height: 32,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                border: "none",
                borderRadius: 9,
                background: on ? "var(--accent-tint)" : "transparent",
                color: on ? "var(--accent-tint-ink)" : "var(--text-faint)",
              }}
            >
              {typeof item.icon === "string" ? <RailIcon name={item.icon} /> : item.icon}
            </button>
          );
        })}
      </div>

      {/* scrim (overlay mode only) */}
      {showPanel && tight && (
        <div
          onClick={() => setOpen(null)}
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 29,
            background: "rgba(20,22,16,.30)",
          }}
        />
      )}

      {/* context panel */}
      {showPanel && openItem && (
        <aside
          style={{
            width: 266,
            display: "flex",
            flexDirection: "column",
            minHeight: 0,
            background: "var(--surface-alt)",
            borderRight: "1px solid var(--border)",
            ...(tight
              ? {
                  position: "absolute",
                  left: 46,
                  top: 0,
                  bottom: 0,
                  zIndex: 30,
                  boxShadow: "6px 0 22px rgba(20,22,16,.26)",
                }
              : { flex: "0 0 266px", position: "relative" }),
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
              padding: "10px 12px",
              borderBottom: "1px solid var(--border)",
            }}
          >
            <span
              style={{
                fontSize: 10.5,
                fontWeight: 600,
                letterSpacing: "0.8px",
                textTransform: "uppercase",
                color: "var(--text-faint)",
              }}
            >
              {openItem.title}
            </span>
            <button
              type="button"
              title="Close panel"
              aria-label="Close panel"
              onClick={() => setOpen(null)}
              style={{
                width: 22,
                height: 22,
                border: "none",
                borderRadius: 6,
                background: "transparent",
                color: "var(--text-faint)",
                fontSize: 12,
                lineHeight: 1,
              }}
            >
              ✕
            </button>
          </div>
          <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>{panels[openItem.id]}</div>
        </aside>
      )}

      {/* document column */}
      <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column" }}>
        {tabs && <TabStrip tabs={tabs} />}
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>{children}</div>
      </div>
    </div>
  );
}

function TabStrip({ tabs }: { tabs: WorkbenchTabs }) {
  return (
    <div
      style={{
        flex: "0 0 auto",
        display: "flex",
        alignItems: "stretch",
        overflowX: "auto",
        background: "var(--surface-alt)",
        borderBottom: "1px solid var(--border)",
      }}
    >
      {tabs.items.map((t) => {
        const on = t.id === tabs.activeId;
        return (
          <div
            key={t.id}
            role="tab"
            aria-selected={on}
            // A div with only onClick is unreachable by keyboard; the close
            // control inside rules out making the tab itself a <button>.
            tabIndex={0}
            onClick={() => tabs.onSelect?.(t.id)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                tabs.onSelect?.(t.id);
              }
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              flexShrink: 0,
              padding: "9px 12px",
              borderRight: "1px solid var(--border)",
              fontSize: 12.5,
              whiteSpace: "nowrap",
              cursor: "pointer",
              background: on ? "var(--surface)" : "transparent",
              color: on ? "var(--text)" : "var(--text-muted)",
              boxShadow: on ? "inset 0 2px 0 var(--accent)" : "none",
            }}
          >
            {t.icon && <span style={{ color: "var(--text-faint)" }}>{t.icon}</span>}
            <span>{t.name}</span>
            {tabs.onClose && (
              <button
                type="button"
                title={`Close ${t.name}`}
                aria-label={`Close ${t.name}`}
                onClick={(e) => {
                  e.stopPropagation();
                  tabs.onClose?.(t.id);
                }}
                style={closeBtn}
              >
                ✕
              </button>
            )}
          </div>
        );
      })}
      {tabs.onNew && (
        <button
          type="button"
          title="New document"
          aria-label="New document"
          onClick={tabs.onNew}
          style={{
            flexShrink: 0,
            padding: "9px 12px",
            border: "none",
            background: "transparent",
            color: "var(--text-faint)",
            fontSize: 13,
          }}
        >
          +
        </button>
      )}
    </div>
  );
}

const closeBtn: CSSProperties = {
  width: 16,
  height: 16,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  border: "none",
  borderRadius: 5,
  background: "transparent",
  color: "var(--text-faint)",
  fontSize: 10,
  lineHeight: 1,
};

/** 16x16 stroke icons — folder, ToC headings, ToC widgets, dashboards, catalog. */
export function RailIcon({ name }: { name: WorkbenchIconName }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {name === "folder" && (
        <path d="M2 12.4V4a1 1 0 0 1 1-1h3.1l1.5 1.7H13a1 1 0 0 1 1 1v6.7a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1Z" />
      )}
      {name === "toc" && (
        <>
          <path d="M2.6 3.6h10.8" />
          <path d="M4.6 6.9h8.8" />
          <path d="M4.6 10.1h8.8" />
          <path d="M6.6 13.4h6.8" />
        </>
      )}
      {name === "widgets" && (
        <>
          <rect x="2.2" y="2.4" width="5" height="5" rx="1" />
          <rect x="8.8" y="2.4" width="5" height="5" rx="1" />
          <rect x="2.2" y="8.9" width="5" height="5" rx="1" />
          <rect x="8.8" y="8.9" width="5" height="5" rx="1" />
        </>
      )}
      {name === "dashboards" && (
        <>
          <path d="M2.2 4a1 1 0 0 1 1-1h9.6a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H6.6l-3 2.5V11h-.4a1 1 0 0 1-1-1Z" />
          <path d="M5.6 8.6V7M8 8.6V5.3M10.4 8.6v-1" />
        </>
      )}
      {name === "catalog" && (
        <>
          <path d="M13 3.9c0 1-2.2 1.8-5 1.8s-5-.8-5-1.8S5.2 2.1 8 2.1s5 .8 5 1.8Z" />
          <path d="M3 3.9v8.2c0 1 2.2 1.8 5 1.8s5-.8 5-1.8V3.9" />
          <path d="M3 8c0 1 2.2 1.8 5 1.8s5-.8 5-1.8" />
        </>
      )}
    </svg>
  );
}
