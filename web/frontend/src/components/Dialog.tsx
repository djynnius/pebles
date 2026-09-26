import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

/*
 * In-app replacements for window.prompt/confirm and for right-click menus.
 * Both close on Escape; the menu also closes on any click outside it and
 * nudges itself back on-screen when opened near a viewport edge.
 */

/** A centred modal card over a scrim. Escape or a scrim click cancels. */
export function Dialog({
  title,
  children,
  onClose,
  width = 440,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  width?: number;
}) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);

  return (
    <div
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 80,
        background: "var(--scrim)",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        padding: "12vh 16px 16px",
        overflowY: "auto",
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={{
          width: "100%",
          maxWidth: width,
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: 14,
          boxShadow: "var(--shadow-pop)",
          padding: "18px 20px",
          color: "var(--text)",
        }}
      >
        <div style={{ fontSize: "var(--fs-lg)", fontWeight: 600, marginBottom: 12 }}>{title}</div>
        {children}
      </div>
    </div>
  );
}

/** Right-aligned row of dialog buttons. */
export function DialogActions({ children }: { children: ReactNode }) {
  return (
    <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>{children}</div>
  );
}

export interface MenuEntry {
  label: string;
  onSelect?: () => void;
  disabled?: boolean;
  danger?: boolean;
}

/** A fixed-position context menu at (x, y), clamped inside the viewport. */
export function ContextMenu({
  x,
  y,
  items,
  onClose,
  header,
}: {
  x: number;
  y: number;
  items: MenuEntry[];
  onClose: () => void;
  header?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const pad = 8;
    setPos({
      left: Math.max(pad, Math.min(x, window.innerWidth - r.width - pad)),
      top: Math.max(pad, Math.min(y, window.innerHeight - r.height - pad)),
    });
  }, [x, y]);

  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    const away = () => onClose();
    window.addEventListener("mousedown", down);
    window.addEventListener("keydown", key);
    window.addEventListener("resize", away);
    window.addEventListener("blur", away);
    return () => {
      window.removeEventListener("mousedown", down);
      window.removeEventListener("keydown", key);
      window.removeEventListener("resize", away);
      window.removeEventListener("blur", away);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      role="menu"
      onContextMenu={(e) => e.preventDefault()}
      style={{ ...menuBox, left: pos.left, top: pos.top }}
    >
      {header && (
        <div
          className="mono"
          style={{
            padding: "6px 14px 7px",
            fontSize: "var(--fs-label)",
            color: "var(--text-faint)",
            borderBottom: "1px solid var(--border-soft)",
            marginBottom: 4,
            maxWidth: 260,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {header}
        </div>
      )}
      {items.map((it) => (
        <button
          key={it.label}
          type="button"
          role="menuitem"
          disabled={it.disabled}
          onClick={() => {
            if (it.disabled) return;
            onClose();
            it.onSelect?.();
          }}
          style={{
            display: "block",
            width: "100%",
            textAlign: "left",
            border: "none",
            background: "transparent",
            padding: "8px 14px",
            fontSize: "var(--fs-body)",
            fontFamily: "inherit",
            whiteSpace: "nowrap",
            color: it.disabled ? "var(--text-faint)" : it.danger ? "var(--err)" : "var(--text-mid)",
          }}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}

const menuBox: CSSProperties = {
  position: "fixed",
  zIndex: 70,
  minWidth: 180,
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: 11,
  boxShadow: "var(--shadow-pop)",
  padding: "5px 0",
};
