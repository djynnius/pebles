import { useTheme } from "../theme";
import type { User } from "../api";

export function Topbar({ user, onSignOut }: { user: User; onSignOut: () => void }) {
  const { theme, toggle } = useTheme();
  const initials = user.username.slice(0, 2).toUpperCase();
  return (
    <header
      style={{
        height: 52,
        flex: "0 0 52px",
        background: "var(--surface)",
        borderBottom: "1px solid var(--border)",
        display: "flex",
        alignItems: "center",
        padding: "0 18px",
        gap: 16,
        position: "sticky",
        top: 0,
        zIndex: 20,
      }}
    >
      <span
        className="mono"
        style={{
          fontSize: 11.5,
          color: "var(--accent-deep)",
          border: "1px solid var(--border)",
          borderRadius: 8,
          padding: "3px 9px",
        }}
      >
        pebbles
      </span>

      {/* Chrome only until global search ships: hidden from assistive tech and
          from the tab order so nobody is offered a control that does nothing. */}
      <div
        aria-hidden="true"
        title="Global search arrives in a later phase"
        style={{
          flex: 1,
          maxWidth: 560,
          height: 32,
          display: "flex",
          alignItems: "center",
          gap: 8,
          background: "var(--surface-alt)",
          border: "1px solid var(--border)",
          borderRadius: 11,
          padding: "0 12px",
          color: "var(--text-faint)",
          fontSize: 13,
        }}
      >
        <span>⌕</span>
        <span style={{ flex: 1 }}>Search tables, notebooks, jobs…</span>
        <span className="mono" style={{ fontSize: 11 }}>
          ⌘K
        </span>
      </div>

      <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 }}>
        <span
          title={`Signed in as ${user.username}`}
          style={{
            width: 29,
            height: 29,
            borderRadius: "50%",
            background: "var(--accent-deep)",
            color: "var(--deep-text)",
            display: "grid",
            placeItems: "center",
            fontSize: 12,
            fontWeight: 600,
          }}
        >
          {initials}
        </span>
        <button
          type="button"
          onClick={toggle}
          title={theme === "light" ? "Switch to Night" : "Switch to Daylight"}
          aria-label={theme === "light" ? "Switch to Night theme" : "Switch to Daylight theme"}
          style={iconBtn}
          className="pb-icon-btn"
        >
          {theme === "light" ? "☾" : "☀"}
        </button>
        <button
          type="button"
          onClick={onSignOut}
          title="Sign out"
          aria-label="Sign out"
          style={iconBtn}
          className="pb-icon-btn signout"
        >
          ⏻
        </button>
      </div>
    </header>
  );
}

const iconBtn: React.CSSProperties = {
  width: 29,
  height: 29,
  borderRadius: 11,
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--text-mid)",
  fontSize: 14,
};
