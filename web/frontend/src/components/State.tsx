import type { CSSProperties, ReactNode } from "react";

/*
 * The three states every screen owes the user (REQ-49): loading, empty, error.
 *
 * They live here rather than in 23 copies so a 503 from a restarting pebblesd
 * reads the same on Engines as it does on Jobs, and so an empty list always
 * offers the one action that fills it. Nothing animates — the prototype has no
 * keyframes (spec §7), so "in flight" is a label change and a disabled control.
 */

/**
 * A styled, bordered error panel carrying the server's own text. Always use
 * this instead of a bare red <p>: an error the eye can skip is an error the
 * user will blame on the screen being blank.
 */
export function ErrorBlock({
  error,
  title,
  action,
  style,
}: {
  error: string;
  /** Optional lead-in above the server text, e.g. "Couldn't load engines". */
  title?: string;
  action?: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div
      role="alert"
      style={{
        background: "var(--accent-tint)",
        border: "1px solid var(--err)",
        borderRadius: 12,
        padding: "12px 14px",
        color: "var(--err)",
        fontSize: "var(--fs-body)",
        marginBottom: 14,
        ...style,
      }}
    >
      {title && <div style={{ fontWeight: 600, marginBottom: 4 }}>{title}</div>}
      <div className="mono" style={{ overflowWrap: "break-word" }}>
        {error}
      </div>
      {action && <div style={{ marginTop: 10 }}>{action}</div>}
    </div>
  );
}

/**
 * A purposeful empty state: one line of guidance and, where one exists, the
 * primary action that ends it. `inline` drops the card for places that are
 * already inside one (a panel, a table cell, a drawer).
 */
export function Empty({
  glyph,
  title,
  body,
  action,
  inline,
  style,
}: {
  glyph?: string;
  title: string;
  body?: ReactNode;
  action?: ReactNode;
  inline?: boolean;
  style?: CSSProperties;
}) {
  const content = (
    <>
      {glyph && (
        <div style={{ fontSize: "var(--fs-h2)", color: "var(--text-faint)", marginBottom: 8 }}>{glyph}</div>
      )}
      <div style={{ fontSize: "var(--fs-lg)", fontWeight: 600, marginBottom: 6 }}>{title}</div>
      {body && (
        <div
          style={{
            fontSize: "var(--fs-body)",
            color: "var(--text-dim)",
            maxWidth: 420,
            margin: "0 auto",
            lineHeight: 1.6,
          }}
        >
          {body}
        </div>
      )}
      {action && <div style={{ marginTop: 16 }}>{action}</div>}
    </>
  );

  if (inline) {
    return <div style={{ padding: "18px 16px", textAlign: "center", ...style }}>{content}</div>;
  }
  return (
    <div
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: 14,
        padding: "38px 30px",
        textAlign: "center",
        ...style,
      }}
    >
      {content}
    </div>
  );
}

/**
 * The quiet in-flight line. No spinner by design; the point is to hold the
 * space a result will occupy so nothing jumps when it lands.
 */
export function Loading({ label = "Loading…", style }: { label?: string; style?: CSSProperties }) {
  return (
    <div
      aria-live="polite"
      style={{ fontSize: "var(--fs-body)", color: "var(--text-dim)", padding: "4px 0", ...style }}
    >
      {label}
    </div>
  );
}

/** The accent pill an empty state hands the user; matches spec §4 "Primary". */
export function EmptyAction({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        background: "var(--accent)",
        color: "var(--on-accent)",
        border: "none",
        borderRadius: 11,
        fontWeight: 600,
        fontSize: "var(--fs-base)",
        padding: "9px 18px",
      }}
    >
      {children}
    </button>
  );
}
