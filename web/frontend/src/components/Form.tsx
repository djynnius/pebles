import type { CSSProperties, ReactNode } from "react";

/*
 * Small form and admin-row primitives shared by Users, Groups, Engines and
 * Settings. No dialogs: destructive actions confirm inline (a row expands to
 * "Delete x? [Delete] [Cancel]") so nothing blocks the page or automation.
 */

export const inputStyle: CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  border: "1px solid var(--border)",
  borderRadius: 12,
  background: "var(--surface)",
  color: "var(--text)",
  fontSize: 13,
  fontFamily: "'IBM Plex Mono', monospace",
  outline: "none",
};

export const selectStyle: CSSProperties = {
  padding: "7px 10px",
  border: "1px solid var(--border)",
  borderRadius: 11,
  background: "var(--surface)",
  color: "var(--text)",
  fontSize: 12.5,
};

/** Uppercase eyebrow label above a control. */
export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label style={{ display: "block" }}>
      <div
        style={{
          fontSize: 11,
          letterSpacing: "0.6px",
          textTransform: "uppercase",
          color: "var(--text-faint)",
          marginBottom: 6,
        }}
      >
        {label}
      </div>
      {children}
      {hint && <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 5 }}>{hint}</div>}
    </label>
  );
}

export function TextInput({
  value,
  onChange,
  type = "text",
  placeholder,
  autoFocus,
  autoComplete,
  ariaLabel,
  style,
}: {
  value: string;
  onChange: (v: string) => void;
  type?: "text" | "password";
  placeholder?: string;
  autoFocus?: boolean;
  autoComplete?: string;
  ariaLabel?: string;
  style?: CSSProperties;
}) {
  return (
    <input
      type={type}
      value={value}
      placeholder={placeholder}
      autoFocus={autoFocus}
      autoComplete={autoComplete}
      aria-label={ariaLabel}
      spellCheck={false}
      onChange={(e) => onChange(e.target.value)}
      style={{ ...inputStyle, ...style }}
    />
  );
}

type Tone = "accent" | "ok" | "warn" | "dim";

/** Status pill (spec §4 "Badges / pills"). */
export function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  const palette: Record<Tone, CSSProperties> = {
    accent: { background: "var(--accent-tint)", color: "var(--accent-tint-ink)" },
    ok: { background: "var(--ok-tint)", color: "var(--ok-ink)" },
    warn: { background: "var(--warn-tint)", color: "var(--warn)" },
    dim: { background: "var(--track)", color: "var(--text-dim)" },
  };
  return (
    <span
      style={{
        display: "inline-block",
        padding: "3px 9px",
        borderRadius: 20,
        fontSize: 10.5,
        fontWeight: 600,
        letterSpacing: "0.3px",
        whiteSpace: "nowrap",
        ...palette[tone],
      }}
    >
      {children}
    </span>
  );
}

/** Compact row-level button; `danger` gives the error outline. */
export function SmallButton({
  children,
  onClick,
  disabled,
  danger,
  primary,
  type = "button",
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  danger?: boolean;
  primary?: boolean;
  type?: "button" | "submit";
  title?: string;
}) {
  const look: CSSProperties = primary
    ? {
        background: danger ? "var(--err)" : "var(--accent)",
        color: "var(--on-accent)",
        border: "1px solid transparent",
        fontWeight: 600,
      }
    : {
        background: "var(--surface)",
        color: danger ? "var(--err)" : "var(--text-mid)",
        border: `1px solid ${danger ? "var(--err)" : "var(--border)"}`,
      };
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        ...look,
        borderRadius: 9,
        fontSize: 12,
        padding: "5px 11px",
        whiteSpace: "nowrap",
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? "default" : "pointer",
      }}
    >
      {children}
    </button>
  );
}

/** A tinted inline panel holding a confirmation or a small form. */
export function InlinePanel({
  children,
  danger,
  style,
}: {
  children: ReactNode;
  danger?: boolean;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        background: danger ? "var(--accent-tint)" : "var(--surface-alt)",
        border: `1px solid ${danger ? "var(--err)" : "var(--border)"}`,
        borderRadius: 12,
        padding: "12px 14px",
        display: "flex",
        alignItems: "center",
        gap: 10,
        flexWrap: "wrap",
        fontSize: 12.5,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/**
 * "Remove x? [Remove] [Cancel]" — the inline replacement for window.confirm.
 * `busy` swaps the confirm label and disables both buttons (no spinners).
 */
export function InlineConfirm({
  message,
  confirmLabel,
  busyLabel,
  busy,
  onConfirm,
  onCancel,
  children,
  error,
}: {
  message: ReactNode;
  confirmLabel: string;
  busyLabel: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  /** Extra controls (e.g. a checkbox) shown between message and buttons. */
  children?: ReactNode;
  error?: string;
}) {
  return (
    <InlinePanel danger>
      <div style={{ flex: 1, minWidth: 220, color: "var(--text)" }}>
        <div style={{ fontWeight: 600 }}>{message}</div>
        {children}
        {error && (
          <div role="alert" className="mono" style={{ color: "var(--err)", marginTop: 6, fontSize: 12 }}>
            {error}
          </div>
        )}
      </div>
      <SmallButton danger primary disabled={busy} onClick={onConfirm}>
        {busy ? busyLabel : confirmLabel}
      </SmallButton>
      <SmallButton disabled={busy} onClick={onCancel}>
        Cancel
      </SmallButton>
    </InlinePanel>
  );
}

/** One-line success/inline error text under a form. */
export function FormMessage({ tone, children }: { tone: "ok" | "err"; children: ReactNode }) {
  return (
    <div
      role={tone === "err" ? "alert" : "status"}
      className={tone === "err" ? "mono" : undefined}
      style={{
        fontSize: 12,
        color: tone === "ok" ? "var(--ok-ink)" : "var(--err)",
        overflowWrap: "break-word",
      }}
    >
      {children}
    </div>
  );
}

/** Mirrors the server: ^[a-z][a-z0-9_-]{0,31}$. */
export const USERNAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;
export const MIN_PASSWORD = 8;

/** Client-side password check shared by every password form; "" when fine. */
export function passwordProblem(pw: string, confirm: string): string {
  if (pw.length < MIN_PASSWORD) return `Password must be at least ${MIN_PASSWORD} characters.`;
  if (pw !== confirm) return "Passwords don't match.";
  return "";
}
