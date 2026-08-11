import { useState } from "react";
import { api, ApiError, type User } from "../api";
import { Wordmark } from "../components/Wordmark";

export function Login({ onAuthed }: { onAuthed: (u: User) => void }) {
  const [step, setStep] = useState<1 | 2>(1);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (step === 1) {
      if (username.trim()) setStep(2);
      return;
    }
    try {
      const u = await api.post<User>("/login", { username, password });
      onAuthed(u);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Sign-in failed");
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

          {step === 1 ? (
            <>
              <label style={label}>Username</label>
              <input
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
              </div>
              <label style={label}>Password</label>
              <input
                type="password"
                autoFocus
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                style={input}
              />
              <button type="submit" style={cta}>
                Sign in
              </button>
            </>
          )}

          {error && (
            <div
              style={{
                marginTop: 14,
                padding: "9px 12px",
                borderRadius: 10,
                background: "var(--accent-tint)",
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
