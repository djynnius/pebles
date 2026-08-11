import type { ReactNode } from "react";

// Standard page chrome: centered column, eyebrow + H1 title, optional actions.
export function Page({
  eyebrow,
  title,
  actions,
  children,
  maxWidth = 1080,
}: {
  eyebrow?: string;
  title: string;
  actions?: ReactNode;
  children?: ReactNode;
  maxWidth?: number;
}) {
  return (
    <div style={{ maxWidth, margin: "0 auto", padding: "34px 40px 60px" }}>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 16, marginBottom: 22 }}>
        <div style={{ flex: 1 }}>
          {eyebrow && (
            <div
              style={{
                fontSize: 11,
                letterSpacing: "0.8px",
                textTransform: "uppercase",
                color: "var(--text-faint)",
                marginBottom: 6,
              }}
            >
              {eyebrow}
            </div>
          )}
          <h1 style={{ fontSize: 26, fontWeight: 600, letterSpacing: "-0.5px" }}>{title}</h1>
        </div>
        {actions && <div style={{ display: "flex", gap: 10 }}>{actions}</div>}
      </div>
      {children}
    </div>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: React.CSSProperties }) {
  return (
    <div
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: 14,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

export function AccentButton({
  children,
  onClick,
  type = "button",
}: {
  children: ReactNode;
  onClick?: () => void;
  type?: "button" | "submit";
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      style={{
        background: "var(--accent)",
        color: "var(--on-accent)",
        border: "none",
        borderRadius: 11,
        fontWeight: 600,
        fontSize: 13,
        padding: "8px 16px",
      }}
    >
      {children}
    </button>
  );
}

export function GhostButton({ children, onClick }: { children: ReactNode; onClick?: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        background: "var(--surface)",
        color: "var(--text-mid)",
        border: "1px solid var(--border)",
        borderRadius: 11,
        fontSize: 12.5,
        padding: "8px 14px",
      }}
    >
      {children}
    </button>
  );
}
