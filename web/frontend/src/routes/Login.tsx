import { useState } from "react";
import { api, errorText, type User } from "../api";
import { Wordmark } from "../components/Wordmark";

export function Login({
  onAuthed,
  expired,
}: {
  onAuthed: (u: User) => void;
  /** Set when a mid-session 401 dropped us here rather than a sign-out. */
  expired?: boolean;
}) {
  const [step, setStep] = useState<1 | 2>(1);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (step === 1) {
      if (username.trim()) setStep(2);
      return;
    }
    if (busy) return;
    setBusy(true);
    try {
      const u = await api.post<User>("/login", { username, password });
      onAuthed(u);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "flex", minHeight: "100vh" }}>
      {/* left dark panel */}
      <div
        style={{
          width: "46%",
          background: "var(--deep)",
          color: "var(--deep-text)",
          padding: "56px 52px",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          gap: 20,
        }}
      >
        <Wordmark size={52} />
        <h2 style={{ fontSize: 22, fontWeight: 600, maxWidth: 360, lineHeight: 1.4 }}>
          Your lake, your engines, your hardware.
        </h2>
        <p style={{ color: "var(--deep-muted)", maxWidth: 380, lineHeight: 1.7 }}>
          A complete data platform on hardware you already own. No licence cost, no
          metered compute, no data leaving your network.
        </p>
        <p className="mono" style={{ fontSize: 11, color: "var(--deep-faint)", marginTop: 24 }}>
          v0.1.0 · self-hosted
        </p>
      </div>

      {/* right form */}
      <div style={{ flex: 1, display: "grid", placeItems: "center", padding: 24 }}>
        <form onSubmit={submit} style={{ width: 370, maxWidth: "100%" }}>
          <h1 style={{ fontSize: 24, fontWeight: 600, marginBottom: 6 }}>Sign in</h1>
          <p style={{ color: "var(--text-dim)", marginBottom: 24 }}>
            Use your Pebbles username and password.
          </p>

          {expired && (
            <div
              role="status"
              style={{
                marginBottom: 18,
                padding: "9px 12px",
                borderRadius: 10,
                background: "var(--warn-tint)",
                color: "var(--warn)",
                fontSize: 12.5,
              }}
            >
              You were signed out — your session expired. Sign in to pick up where you left off.
            </div>
          )}

          {step === 1 ? (
            <>
              <label htmlFor="pb-username" style={label}>
                Username
              </label>
              <input
                id="pb-username"
                name="username"
                autoComplete="username"
                className="mono"
                autoFocus
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                style={input}
              />
              <button type="submit" style={cta}>
                Continue
              </button>
            </>
          ) : (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
                <span
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: "50%",
                    background: "var(--accent-deep)",
                    color: "var(--deep-text)",
                    display: "grid",
                    placeItems: "center",
                    fontSize: 12,
                    fontWeight: 600,
                  }}
                >
                  {username.slice(0, 2).toUpperCase()}
                </span>
                <span className="mono" style={{ fontSize: 13 }}>
                  {username}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setStep(1);
                    setPassword("");
                    setError("");
                  }}
                  style={{
                    marginLeft: "auto",
                    border: "none",
                    background: "transparent",
                    color: "var(--accent-ink)",
                    fontSize: 12,
                    padding: 0,
                  }}
                >
                  Not you?
                </button>
              </div>
              <label htmlFor="pb-password" style={label}>
                Password
              </label>
              <input
                id="pb-password"
                name="password"
                autoComplete="current-password"
                type="password"
                autoFocus
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                style={input}
              />
              <button type="submit" disabled={busy} style={busy ? { ...cta, ...ctaBusy } : cta}>
                {busy ? "Signing in…" : "Sign in"}
              </button>
            </>
          )}

          {error && (
            <div
              role="alert"
              style={{
                marginTop: 14,
                padding: "9px 12px",
                borderRadius: 10,
                background: "var(--accent-tint)",
                border: "1px solid var(--err)",
                color: "var(--err)",
                fontSize: 13,
              }}
            >
              {error}
            </div>
          )}
        </form>
      </div>
    </div>
  );
}

const label: React.CSSProperties = {
  display: "block",
  fontSize: 11,
  letterSpacing: "0.6px",
  textTransform: "uppercase",
  color: "var(--text-faint)",
  marginBottom: 6,
};
const input: React.CSSProperties = {
  width: "100%",
  padding: "11px 13px",
  border: "1px solid var(--border)",
  borderRadius: 12,
  background: "var(--surface)",
  color: "var(--text)",
  fontSize: 14,
  fontFamily: "'IBM Plex Mono', monospace",
  outline: "none",
};
const cta: React.CSSProperties = {
  width: "100%",
  marginTop: 18,
  padding: "11px",
  border: "none",
  borderRadius: 12,
  background: "var(--accent)",
  color: "var(--on-accent)",
  fontWeight: 600,
  fontSize: 14,
};
const ctaBusy: React.CSSProperties = {
  background: "var(--track)",
  color: "var(--text-dim)",
  cursor: "not-allowed",
};
