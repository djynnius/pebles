import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, sse, type Row } from "../api";
import { useCatalogs } from "../catalogs";
import { ResultGrid, cell } from "./Catalog";

/*
 * /dashboards/:name — the dashboard view (spec §5 "dashboard").
 *
 * Two stores, deliberately: the *document* (title / sql / kind per tile) is
 * server state in ~/dashboards/<name>.json — the API sanitizer drops anything
 * else — while *layout* (each tile's column and row span) is a per-browser
 * preference in localStorage, keyed by dashboard name. That keeps the saved
 * document portable and avoids sending keys the server would silently strip.
 *
 * Widget kinds are table / stat / bars: the three the tile stream can feed.
 * The prototype's MAP / LINE / DONUT / PYRAMID widgets need shapes the API
 * does not describe yet (and the US cartogram needs baked geometry, §9), so
 * they are not offered here.
 */

type Kind = "table" | "stat" | "bars";

interface Tile {
  title: string;
  sql: string;
  kind: Kind;
}

interface DashDoc {
  catalog: string | null;
  tiles: Tile[];
}

interface Span {
  w: number;
  h: number;
}

interface Out {
  running?: boolean;
  rows?: Row[];
  error?: string;
}

const KINDS: { kind: Kind; label: string }[] = [
  { kind: "stat", label: "Stat" },
  { kind: "table", label: "Table" },
  { kind: "bars", label: "Bars" },
];

const DEFAULT_SPAN: Record<Kind, Span> = {
  stat: { w: 1, h: 1 },
  table: { w: 2, h: 2 },
  bars: { w: 2, h: 2 },
};

const layoutKey = (name: string) => `pebbles.dashlayout.${name}`;

export function Dashboard() {
  const { name = "" } = useParams();
  const nav = useNavigate();
  const { catalogs } = useCatalogs();

  const [doc, setDoc] = useState<DashDoc | null>(null);
  const [spans, setSpans] = useState<Span[]>([]);
  const [outs, setOuts] = useState<Out[]>([]);
  const [error, setError] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [addMenu, setAddMenu] = useState(false);
  const [menu, setMenu] = useState<number | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [drag, setDrag] = useState<number | null>(null);

  const docRef = useRef<DashDoc | null>(null);
  docRef.current = doc;
  const cancels = useRef<Record<number, () => void>>({});

  /* ---- load -------------------------------------------------------------- */

  useEffect(() => {
    let live = true;
    api
      .get<DashDoc>(`/dashboards/${encodeURIComponent(name)}`)
      .then((d) => {
        if (!live) return;
        const tiles = d.tiles ?? [];
        setDoc({ catalog: d.catalog ?? null, tiles });
        setSpans(readLayout(name, tiles));
        setOuts(tiles.map(() => ({})));
      })
      .catch((e) => live && setError(String(e.message ?? e)));
    return () => {
      live = false;
    };
  }, [name]);

  useEffect(() => {
    const live = cancels.current;
    return () => {
      for (const stop of Object.values(live)) stop();
    };
  }, []);

  // Close whichever popover is open on the next click anywhere else.
  useEffect(() => {
    if (!addMenu && menu === null) return;
    const off = () => {
      setAddMenu(false);
      setMenu(null);
    };
    document.addEventListener("click", off);
    return () => document.removeEventListener("click", off);
  }, [addMenu, menu]);

  /* ---- persistence ------------------------------------------------------- */

  const saveLayout = useCallback(
    (next: Span[]) => {
      setSpans(next);
      localStorage.setItem(layoutKey(name), JSON.stringify(next));
    },
    [name],
  );

  const save = useCallback(async () => {
    const d = docRef.current;
    if (!d) return;
    setSaving(true);
    try {
      // Only title/sql/kind travel — layout stays client-side on purpose.
      await api.put(`/dashboards/${encodeURIComponent(name)}`, {
        catalog: d.catalog,
        tiles: d.tiles.map((t) => ({ title: t.title, sql: t.sql, kind: t.kind })),
      });
      setDirty(false);
      setError("");
    } catch (e) {
      setError(String((e as Error).message ?? e));
      throw e;
    } finally {
      setSaving(false);
    }
  }, [name]);

  /* ---- execution --------------------------------------------------------- */

  const streamTile = (i: number) =>
    new Promise<void>((resolve) => {
      cancels.current[i]?.();
      setOuts((cur) => cur.map((o, j) => (j === i ? { running: true } : o)));
      let acc: Out = {};
      cancels.current[i] = sse(`/dashboards/${encodeURIComponent(name)}/tiles/${i}/stream`, {
        result: (r) => {
          acc = { rows: r.rows ?? [] };
        },
        error: (m) => {
          acc = { error: m };
        },
        done: () => {
          setOuts((cur) => cur.map((o, j) => (j === i ? acc : o)));
          delete cancels.current[i];
          resolve();
        },
      });
    });

  /** The server runs tile *i* of the file on disk, so save first. */
  const runTile = async (i: number) => {
    try {
      await save();
    } catch {
      return;
    }
    await streamTile(i);
  };

  const runAll = useCallback(
    async (tiles: Tile[]) => {
      // Sequential: each tile is a real query on the user's engine session.
      for (let i = 0; i < tiles.length; i += 1) await streamTile(i);
    },
    // streamTile closes over `name` only, which is stable for the mounted route
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [name],
  );

  // Fill the tiles once, on arrival.
  const ranOnce = useRef(false);
  useEffect(() => {
    if (!doc || ranOnce.current || doc.tiles.length === 0) return;
    ranOnce.current = true;
    void runAll(doc.tiles);
  }, [doc, runAll]);

  /* ---- mutation ---------------------------------------------------------- */

  const edit = (mutate: (d: DashDoc) => DashDoc) => {
    setDoc((cur) => (cur ? mutate(cur) : cur));
    setDirty(true);
  };

  const setTile = (i: number, patch: Partial<Tile>) =>
    edit((d) => ({ ...d, tiles: d.tiles.map((t, j) => (j === i ? { ...t, ...patch } : t)) }));

  const addTile = (kind: Kind) => {
    const tile: Tile = {
      title: `New ${kind}`,
      sql: kind === "stat" ? "SELECT 1 AS value" : "SELECT 1 AS label, 1 AS value",
      kind,
    };
    const at = doc?.tiles.length ?? 0;
    edit((d) => ({ ...d, tiles: [...d.tiles, tile] }));
    saveLayout([...spans, { ...DEFAULT_SPAN[kind] }]);
    setOuts((cur) => [...cur, {}]);
    setEditing(at); // a fresh widget opens straight into its SQL drawer
  };

  const deleteTile = (i: number) => {
    edit((d) => ({ ...d, tiles: d.tiles.filter((_, j) => j !== i) }));
    saveLayout(spans.filter((_, j) => j !== i));
    setOuts((cur) => cur.filter((_, j) => j !== i));
    setEditing(null);
  };

  const resize = (i: number, dw: number, dh: number) =>
    saveLayout(
      spans.map((s, j) =>
        j === i
          ? { w: clamp((s?.w ?? 1) + dw, 1, 4), h: clamp((s?.h ?? 1) + dh, 1, 3) }
          : (s ?? { w: 1, h: 1 }),
      ),
    );

  const resetLayout = () => {
    localStorage.removeItem(layoutKey(name));
    setSpans((doc?.tiles ?? []).map((t) => ({ ...DEFAULT_SPAN[t.kind] })));
  };

  /** Drag-reorder (spec §7): move the dragged tile into the hovered slot. */
  const dropOn = (target: number) => {
    if (drag === null || drag === target) return;
    const move = <T,>(arr: T[]): T[] => {
      const next = [...arr];
      const [held] = next.splice(drag, 1);
      next.splice(target, 0, held);
      return next;
    };
    edit((d) => ({ ...d, tiles: move(d.tiles) }));
    saveLayout(move(spans));
    setOuts((cur) => move(cur));
    setDrag(target);
  };

  /* ---- render ------------------------------------------------------------ */

  const tiles = doc?.tiles ?? [];

  return (
    <div
      style={
        fullscreen
          ? {
              position: "fixed",
              inset: 0,
              zIndex: 70,
              overflowY: "auto",
              background: "var(--bg)",
            }
          : undefined
      }
    >
      <div style={{ maxWidth: fullscreen ? "none" : 1240, margin: "0 auto", padding: "26px 34px 60px" }}>
        {/* header */}
        <div
          style={{
            display: "flex",
            alignItems: "flex-end",
            gap: 12,
            flexWrap: "wrap",
            marginBottom: 18,
          }}
        >
          <div style={{ flex: 1, minWidth: 200 }}>
            <button type="button" onClick={() => nav("/dashboards")} style={crumbBtn}>
              ‹ Dashboards
            </button>
            <h1 style={{ fontSize: 24, fontWeight: 600, letterSpacing: "-0.4px", marginTop: 2 }}>
              {name}
            </h1>
            <div className="mono" style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 3 }}>
              ~/dashboards/{name}.json · {tiles.length} widget{tiles.length === 1 ? "" : "s"}
              {dirty && <span style={{ color: "var(--accent-ink)" }}> · unsaved changes</span>}
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <select
              value={doc?.catalog ?? ""}
              onChange={(e) => edit((d) => ({ ...d, catalog: e.target.value || null }))}
              aria-label="Catalog"
              className="mono"
              style={{
                padding: "6px 10px",
                borderRadius: 20,
                border: "1px solid var(--border)",
                background: "var(--surface-alt)",
                color: "var(--accent-deep)",
                fontSize: 11.5,
              }}
            >
              <option value="">no catalog</option>
              {(catalogs ?? []).map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name}
                </option>
              ))}
            </select>
            <button type="button" onClick={resetLayout} style={ghost}>
              Reset layout
            </button>
            <button type="button" onClick={() => setFullscreen((v) => !v)} style={ghost}>
              {fullscreen ? "Exit full-screen" : "Full-screen"}
            </button>
            <button type="button" onClick={() => window.print()} style={ghost}>
              Download PDF
            </button>
            <button type="button" onClick={() => void save()} style={ghost}>
              {saving ? "Saving…" : "Save"}
            </button>
            <div style={{ position: "relative" }}>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setAddMenu((v) => !v);
                }}
                style={{
                  background: "var(--accent)",
                  color: "var(--on-accent)",
                  border: "none",
                  borderRadius: 11,
                  fontWeight: 600,
                  fontSize: 12.5,
                  padding: "8px 16px",
                }}
              >
                Add widget ▾
              </button>
              {addMenu && (
                <div style={{ ...popover, position: "absolute", top: 38, right: 0 }}>
                  {KINDS.map((k) => (
                    <MenuItem
                      key={k.kind}
                      label={k.label}
                      onClick={() => {
                        setAddMenu(false);
                        addTile(k.kind);
                      }}
                    />
                  ))}
                  <div style={{ borderTop: "1px solid var(--border)", margin: "5px 0" }} />
                  <div style={{ padding: "6px 14px 8px", fontSize: 11, color: "var(--text-faint)" }}>
                    Map, line and donut widgets arrive with Auto ETL.
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {error && (
          <div
            className="mono"
            style={{
              background: "var(--accent-tint)",
              border: "1px solid var(--err)",
              borderRadius: 12,
              padding: "10px 14px",
              color: "var(--err)",
              fontSize: 12.5,
              marginBottom: 14,
            }}
          >
            {error}
          </div>
        )}

        {/* widget grid */}
        {tiles.length === 0 ? (
          <div
            style={{
              background: "var(--surface)",
              border: "1px dashed var(--border-strong)",
              borderRadius: 14,
              padding: "48px 20px",
              textAlign: "center",
              color: "var(--text-dim)",
              fontSize: 13,
            }}
          >
            {doc ? "No widgets yet — add a stat, table or bars widget." : "Loading…"}
          </div>
        ) : (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
              gridAutoRows: "140px",
              gap: 14,
            }}
          >
            {tiles.map((t, i) => {
              const span = spans[i] ?? DEFAULT_SPAN[t.kind];
              return (
                <div
                  key={i}
                  onDragOver={(e) => {
                    e.preventDefault();
                    dropOn(i);
                  }}
                  onDrop={(e) => e.preventDefault()}
                  style={{
                    gridColumn: `span ${span.w}`,
                    gridRow: `span ${span.h}`,
                    display: "flex",
                    flexDirection: "column",
                    minWidth: 0,
                    minHeight: 0,
                    background: "var(--surface)",
                    border: "1px solid var(--border)",
                    borderRadius: 14,
                    overflow: "hidden",
                    opacity: drag === i ? 0.5 : 1,
                  }}
                >
                  {/* tile header — the drag handle (spec §7) */}
                  <div
                    draggable
                    onDragStart={() => setDrag(i)}
                    onDragEnd={() => setDrag(null)}
                    style={{
                      flex: "0 0 auto",
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      padding: "8px 10px 8px 12px",
                      borderBottom: "1px solid var(--border)",
                      background: "var(--surface-alt)",
                      cursor: "grab",
                    }}
                  >
                    <span style={{ color: "var(--text-faint)", fontSize: 11 }}>⠿</span>
                    <input
                      value={t.title}
                      onChange={(e) => setTile(i, { title: e.target.value })}
                      aria-label={`Widget ${i + 1} title`}
                      style={{
                        flex: 1,
                        minWidth: 0,
                        border: "none",
                        background: "transparent",
                        color: "var(--text)",
                        fontSize: 12.5,
                        fontWeight: 600,
                        outline: "none",
                      }}
                    />
                    <span
                      className="mono"
                      style={{ fontSize: 9.5, color: "var(--text-faint)", letterSpacing: "0.5px" }}
                    >
                      {t.kind.toUpperCase()}
                    </span>
                    <div style={{ position: "relative" }}>
                      <button
                        type="button"
                        title="Widget menu"
                        aria-label="Widget menu"
                        onClick={(e) => {
                          e.stopPropagation();
                          setMenu((cur) => (cur === i ? null : i));
                        }}
                        style={{
                          width: 22,
                          height: 22,
                          border: "none",
                          borderRadius: 6,
                          background: "transparent",
                          color: "var(--text-faint)",
                          fontSize: 13,
                          lineHeight: 1,
                        }}
                      >
                        ⋯
                      </button>
                      {menu === i && (
                        <div
                          onClick={(e) => e.stopPropagation()}
                          style={{ ...popover, position: "absolute", top: 26, right: 0 }}
                        >
                          <MenuItem
                            label={editing === i ? "Hide SQL" : "Edit SQL…"}
                            onClick={() => {
                              setEditing((cur) => (cur === i ? null : i));
                              setMenu(null);
                            }}
                          />
                          <MenuItem
                            label="Run"
                            onClick={() => {
                              setMenu(null);
                              void runTile(i);
                            }}
                          />
                          <div style={{ borderTop: "1px solid var(--border)", margin: "5px 0" }} />
                          <Stepper
                            label="Width"
                            value={span.w}
                            max={4}
                            onStep={(d) => resize(i, d, 0)}
                          />
                          <Stepper
                            label="Height"
                            value={span.h}
                            max={3}
                            onStep={(d) => resize(i, 0, d)}
                          />
                          <div style={{ borderTop: "1px solid var(--border)", margin: "5px 0" }} />
                          <MenuItem
                            label="Delete"
                            danger
                            onClick={() => {
                              setMenu(null);
                              deleteTile(i);
                            }}
                          />
                        </div>
                      )}
                    </div>
                  </div>

                  {/* SQL drawer */}
                  {editing === i && (
                    <div
                      style={{
                        flex: "0 0 auto",
                        padding: 10,
                        borderBottom: "1px solid var(--border)",
                        background: "var(--surface-alt)",
                      }}
                    >
                      <textarea
                        value={t.sql}
                        rows={4}
                        spellCheck={false}
                        onChange={(e) => setTile(i, { sql: e.target.value })}
                        aria-label={`Widget ${i + 1} SQL`}
                        className="mono"
                        style={{
                          display: "block",
                          width: "100%",
                          border: "1px solid var(--border)",
                          borderRadius: 9,
                          outline: "none",
                          resize: "vertical",
                          padding: "8px 10px",
                          background: "var(--surface)",
                          color: "var(--text)",
                          fontSize: 12,
                          lineHeight: "18px",
                        }}
                      />
                      <div
                        style={{ display: "flex", gap: 6, marginTop: 8, alignItems: "center" }}
                      >
                        <select
                          value={t.kind}
                          onChange={(e) => setTile(i, { kind: e.target.value as Kind })}
                          aria-label={`Widget ${i + 1} kind`}
                          style={{
                            border: "1px solid var(--border)",
                            borderRadius: 8,
                            background: "var(--surface)",
                            color: "var(--text-muted)",
                            fontSize: 11,
                            padding: "3px 7px",
                          }}
                        >
                          {KINDS.map((k) => (
                            <option key={k.kind} value={k.kind}>
                              {k.label}
                            </option>
                          ))}
                        </select>
                        <div style={{ flex: 1 }} />
                        <button
                          type="button"
                          onClick={() => void runTile(i)}
                          style={{
                            background: "var(--accent)",
                            color: "var(--on-accent)",
                            border: "none",
                            borderRadius: 9,
                            fontWeight: 600,
                            fontSize: 11.5,
                            padding: "5px 12px",
                          }}
                        >
                          Save &amp; run
                        </button>
                      </div>
                    </div>
                  )}

                  {/* body */}
                  <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: 12 }}>
                    <TileBody tile={t} out={outs[i]} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/* ---- widget bodies ------------------------------------------------------- */

function TileBody({ tile, out }: { tile: Tile; out?: Out }) {
  if (!out || out.running) {
    return <div style={hint}>{out?.running ? "Running…" : "Not run yet."}</div>;
  }
  if (out.error) {
    return (
      <div className="mono" style={{ fontSize: 11.5, color: "var(--err)", whiteSpace: "pre-wrap" }}>
        {out.error}
      </div>
    );
  }
  const rows = out.rows ?? [];
  if (rows.length === 0) return <div style={hint}>No rows.</div>;

  if (tile.kind === "stat") {
    const first = rows[0];
    const key = Object.keys(first)[0];
    return (
      <div style={{ display: "flex", flexDirection: "column", justifyContent: "center", height: "100%" }}>
        <div
          style={{
            fontSize: 34,
            fontWeight: 650,
            letterSpacing: "-1px",
            lineHeight: 1.1,
            color: "var(--text)",
          }}
        >
          {format(first[key])}
        </div>
        <div
          style={{
            fontSize: 11,
            letterSpacing: "0.6px",
            textTransform: "uppercase",
            color: "var(--text-faint)",
            marginTop: 4,
          }}
        >
          {tile.title || key}
        </div>
      </div>
    );
  }

  if (tile.kind === "bars") return <Bars rows={rows} />;

  return <ResultGrid rows={rows} />;
}

/**
 * Horizontal bars from the first two useful columns (label, number) — no chart
 * library and no `aspect-ratio` (spec §9); widths are plain percentages of the
 * largest magnitude in the series.
 */
function Bars({ rows }: { rows: Row[] }) {
  const keys = Object.keys(rows[0]);
  const valueKey =
    keys.find((k, i) => i > 0 && typeof rows[0][k] === "number") ?? keys[1] ?? keys[0];
  const labelKey = keys.find((k) => k !== valueKey) ?? keys[0];
  const values = rows.map((r) => Number(r[valueKey]) || 0);
  const max = Math.max(...values.map(Math.abs), 1);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
      {rows.slice(0, 24).map((r, i) => (
        <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <div
            style={{
              width: 92,
              flex: "0 0 92px",
              fontSize: 11.5,
              color: "var(--text-mid)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={cell(r[labelKey])}
          >
            {cell(r[labelKey])}
          </div>
          <div style={{ flex: 1, minWidth: 0, height: 12, background: "var(--track)", borderRadius: 6 }}>
            <div
              style={{
                width: `${(Math.abs(values[i]) / max) * 100}%`,
                height: "100%",
                borderRadius: 6,
                background: "var(--accent)",
              }}
            />
          </div>
          <div
            className="mono"
            style={{ fontSize: 11, color: "var(--text-muted)", flex: "0 0 auto" }}
          >
            {format(r[valueKey])}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ---- small pieces -------------------------------------------------------- */

function MenuItem({
  label,
  onClick,
  danger,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: "block",
        width: "100%",
        textAlign: "left",
        border: "none",
        background: "transparent",
        padding: "7px 14px",
        fontSize: 12.5,
        fontFamily: "inherit",
        color: danger ? "var(--err)" : "var(--text-mid)",
      }}
    >
      {label}
    </button>
  );
}

function Stepper({
  label,
  value,
  max,
  onStep,
}: {
  label: string;
  value: number;
  max: number;
  onStep: (delta: number) => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "4px 14px",
        fontSize: 12,
        color: "var(--text-muted)",
      }}
    >
      <span style={{ flex: 1 }}>{label}</span>
      <button type="button" aria-label={`${label} smaller`} onClick={() => onStep(-1)} style={step}>
        −
      </button>
      <span className="mono" style={{ fontSize: 11, minWidth: 24, textAlign: "center" }}>
        {value}/{max}
      </span>
      <button type="button" aria-label={`${label} larger`} onClick={() => onStep(1)} style={step}>
        +
      </button>
    </div>
  );
}

/* ---- helpers -------------------------------------------------------------- */

function readLayout(name: string, tiles: Tile[]): Span[] {
  let stored: unknown = null;
  try {
    stored = JSON.parse(localStorage.getItem(layoutKey(name)) ?? "null");
  } catch {
    stored = null; // a corrupt preference is not worth a blank dashboard
  }
  const list = Array.isArray(stored) ? stored : [];
  return tiles.map((t, i) => {
    const s = list[i] as Partial<Span> | undefined;
    return {
      w: clamp(Number(s?.w) || DEFAULT_SPAN[t.kind].w, 1, 4),
      h: clamp(Number(s?.h) || DEFAULT_SPAN[t.kind].h, 1, 3),
    };
  });
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Numbers get thousands separators; everything else goes through `cell`. */
function format(v: unknown): string {
  if (typeof v === "number") {
    return Number.isInteger(v) ? v.toLocaleString() : v.toLocaleString(undefined, {
      maximumFractionDigits: 2,
    });
  }
  return cell(v);
}

const hint: CSSProperties = { fontSize: 11.5, color: "var(--text-dim)" };

const ghost: CSSProperties = {
  background: "var(--surface)",
  color: "var(--text-mid)",
  border: "1px solid var(--border)",
  borderRadius: 11,
  fontSize: 12.5,
  padding: "8px 14px",
};

const crumbBtn: CSSProperties = {
  border: "none",
  background: "transparent",
  padding: 0,
  font: "inherit",
  fontSize: 11.5,
  color: "var(--text-dim)",
};

const popover: CSSProperties = {
  minWidth: 172,
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: 11,
  boxShadow: "0 8px 26px rgba(20,22,16,.22)",
  padding: "5px 0",
  zIndex: 40,
};

const step: CSSProperties = {
  width: 20,
  height: 20,
  border: "1px solid var(--border)",
  borderRadius: 6,
  background: "var(--surface)",
  color: "var(--text-mid)",
  fontSize: 12,
  lineHeight: 1,
  padding: 0,
};
