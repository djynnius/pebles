import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { AccentButton, Page } from "../components/Page";

/*
 * /notebooks — the notebook index (spec §5 "notebook" is the document itself;
 * this is its list). Notebooks are JSON documents in the signed-in user's home
 * (~/notebooks/<name>.json), created and deleted through the session broker —
 * Flask never touches the filesystem itself (NFR-01).
 */

/** Server-side rule, mirrored so the form can refuse before the round trip. */
export const DOC_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function Notebooks() {
  const nav = useNavigate();
  const [names, setNames] = useState<string[] | null>(null);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api
      .get<string[]>("/notebooks")
      .then(setNames)
      .catch((e) => {
        setError(String(e.message ?? e));
        setNames([]);
      });
  }, []);

  useEffect(load, [load]);

  const create = () => {
    const n = name.trim();
    if (!DOC_NAME.test(n)) {
      setError("Use lower-case letters, digits, dash or underscore (max 64).");
      return;
    }
    setBusy(true);
    setError("");
    api
      .post(`/notebooks`, { name: n })
      .then(() => nav(`/notebooks/${encodeURIComponent(n)}`))
      .catch((e) => setError(String(e.message ?? e)))
      .finally(() => setBusy(false));
  };

  const remove = (n: string) => {
    if (!confirm(`Delete notebook “${n}”? This removes ~/notebooks/${n}.json.`)) return;
    api
      .del(`/notebooks/${encodeURIComponent(n)}`)
      .then(load)
      .catch((e) => setError(String(e.message ?? e)));
  };

  return (
    <Page title="Notebooks" eyebrow="Analysis">
      {/* new notebook */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          flexWrap: "wrap",
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: 14,
          padding: 14,
          marginBottom: 18,
        }}
      >
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") create();
          }}
          placeholder="claims-exploration"
          aria-label="New notebook name"
          className="mono"
          style={{
            flex: 1,
            minWidth: 200,
            height: 34,
            padding: "0 12px",
            borderRadius: 11,
            border: "1px solid var(--border)",
            background: "var(--surface-alt)",
            color: "var(--text)",
            fontSize: 12.5,
            outline: "none",
          }}
        />
        <AccentButton onClick={busy ? undefined : create}>
          {busy ? "Creating…" : "New notebook"}
        </AccentButton>
      </div>

      {error && (
        <p style={{ color: "var(--err)", fontSize: 12.5, marginBottom: 12 }}>{error}</p>
      )}

      {names && names.length > 0 ? (
        <div
          style={{
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 14,
            overflow: "hidden",
          }}
        >
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={th}>Notebook</th>
                <th style={th}>Path</th>
                <th style={{ ...th, width: 60 }} />
              </tr>
            </thead>
            <tbody>
              {names.map((n) => (
                <tr key={n}>
                  <td style={td}>
                    <button
                      type="button"
                      onClick={() => nav(`/notebooks/${encodeURIComponent(n)}`)}
                      className="mono"
                      style={{
                        border: "none",
                        background: "transparent",
                        padding: 0,
                        fontSize: 13,
                        fontWeight: 500,
                        color: "var(--text)",
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                      }}
                    >
                      <span style={{ color: "var(--text-faint)" }}>▧</span>
                      {n}
                    </button>
                  </td>
                  <td className="mono" style={{ ...td, color: "var(--text-dim)", fontSize: 11.5 }}>
                    ~/notebooks/{n}.json
                  </td>
                  <td style={{ ...td, textAlign: "right" }}>
                    <button
                      type="button"
                      title={`Delete ${n}`}
                      aria-label={`Delete ${n}`}
                      onClick={() => remove(n)}
                      style={{
                        border: "none",
                        background: "transparent",
                        color: "var(--text-faint)",
                        fontSize: 12,
                        padding: "2px 6px",
                        borderRadius: 6,
                      }}
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p style={{ color: "var(--text-dim)", fontSize: 13 }}>
          {names ? "No notebooks yet — name one above to start." : "Loading…"}
        </p>
      )}
    </Page>
  );
}

const th: CSSProperties = {
  textAlign: "left",
  background: "var(--surface-alt)",
  borderBottom: "1px solid var(--border)",
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: "0.5px",
  textTransform: "uppercase",
  color: "var(--text-faint)",
  padding: "10px 16px",
};

const td: CSSProperties = {
  padding: "10px 16px",
  borderBottom: "1px solid var(--border-soft)",
  fontSize: 13,
};
