import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { AccentButton, Page } from "../components/Page";
import { DOC_NAME } from "./Notebooks";

/*
 * /dashboards — the dashboard index (spec §5 "dashboards"): a grid of cards,
 * each with a mini bar sparkline preview and a meta line.
 *
 * The sparkline is decoration, not data: listing dashboards is one cheap
 * directory read, and running every tile's SQL to draw thumbnails would put
 * real query load behind a navigation. The bars are therefore derived from a
 * hash of the name — deterministic, so a card never jumps between renders.
 */

const TILE = ["var(--tile-2)", "var(--tile-3)", "var(--tile-4)", "var(--tile-5)", "var(--tile-3)"];

export function Dashboards() {
  const nav = useNavigate();
  const [names, setNames] = useState<string[] | null>(null);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api
      .get<string[]>("/dashboards")
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
      .post("/dashboards", { name: n })
      .then(() => nav(`/dashboards/${encodeURIComponent(n)}`))
      .catch((e) => setError(String(e.message ?? e)))
      .finally(() => setBusy(false));
  };

  const remove = (n: string) => {
    if (!confirm(`Delete dashboard “${n}”? This removes ~/dashboards/${n}.json.`)) return;
    api
      .del(`/dashboards/${encodeURIComponent(n)}`)
      .then(load)
      .catch((e) => setError(String(e.message ?? e)));
  };

  return (
    <Page title="Dashboards" eyebrow="Analysis">
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
          placeholder="patient-demographics"
          aria-label="New dashboard name"
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
          {busy ? "Creating…" : "New dashboard"}
        </AccentButton>
      </div>

      {error && <p style={{ color: "var(--err)", fontSize: 12.5, marginBottom: 12 }}>{error}</p>}

      {names && names.length > 0 ? (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
            gap: 14,
          }}
        >
          {names.map((n) => (
            <div
              key={n}
              onClick={() => nav(`/dashboards/${encodeURIComponent(n)}`)}
              style={{
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: 14,
                padding: 14,
                cursor: "pointer",
                position: "relative",
              }}
            >
              <button
                type="button"
                title={`Delete ${n}`}
                aria-label={`Delete ${n}`}
                onClick={(e) => {
                  e.stopPropagation();
                  remove(n);
                }}
                style={{
                  position: "absolute",
                  top: 10,
                  right: 10,
                  width: 22,
                  height: 22,
                  border: "none",
                  borderRadius: 6,
                  background: "transparent",
                  color: "var(--text-faint)",
                  fontSize: 11,
                  lineHeight: 1,
                }}
              >
                ✕
              </button>

              {/* decorative preview — see the note at the top of this file */}
              <div
                aria-hidden="true"
                style={{
                  display: "flex",
                  alignItems: "flex-end",
                  gap: 6,
                  height: 74,
                  padding: "0 2px",
                  marginBottom: 12,
                }}
              >
                {bars(n).map((h, i) => (
                  <div
                    key={i}
                    style={{
                      flex: 1,
                      height: `${h}%`,
                      borderRadius: "5px 5px 2px 2px",
                      background: TILE[i % TILE.length],
                    }}
                  />
                ))}
              </div>

              <div
                style={{
                  fontSize: 14,
                  fontWeight: 600,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {n}
              </div>
              <div className="mono" style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 3 }}>
                ~/dashboards/{n}.json
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p style={{ color: "var(--text-dim)", fontSize: 13 }}>
          {names ? "No dashboards yet — name one above to start." : "Loading…"}
        </p>
      )}
    </Page>
  );
}

/** FNV-1a, so the same name always draws the same five bars. */
function bars(name: string): number[] {
  let h = 2166136261;
  for (let i = 0; i < name.length; i += 1) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const out: number[] = [];
  let x = h >>> 0;
  for (let i = 0; i < 5; i += 1) {
    out.push(30 + (x % 71));
    x = Math.imul(x ^ (x >>> 7), 2654435761) >>> 0;
  }
  return out;
}
