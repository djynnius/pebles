import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, sse, type Row } from "../api";
import { qualify, useCatalogs } from "../catalogs";
import { CatalogTree } from "../components/CatalogTree";
import { Workbench } from "../components/Workbench";
import { ResultGrid } from "./Catalog";

/*
 * /notebooks/:name — the notebook document (spec §5 "notebook"), on the
 * workbench shell: icon rail → table of contents / catalog panels, then the
 * document header and a vertical run of cells.
 *
 * The server executes a cell *by index* against the notebook it has on disk,
 * so every run saves first — otherwise an edited-but-unsaved cell would run
 * its stale twin. Outputs live in a plain array kept in lockstep with `cells`
 * (add / delete / move splice both), so a reorder carries its results along.
 */

type CellType = "sql" | "python" | "r";

interface Cell {
  type: CellType;
  source: string;
}

interface NotebookDoc {
  catalog: string | null;
  cells: Cell[];
}

/** The union the stream can carry: rows for SQL, stdio for python/r. */
interface CellResult {
  ok: boolean;
  rows?: Row[];
  stdout?: string;
  stderr?: string;
}

interface CellOut {
  running?: boolean;
  rows?: Row[];
  stdout?: string;
  stderr?: string;
  error?: string;
  seconds?: number;
}

const BADGE: Record<CellType, string> = { sql: "SQL", python: "PY", r: "R" };

export function Notebook() {
  const { name = "" } = useParams();
  const nav = useNavigate();
  const { catalogs } = useCatalogs();

  const [doc, setDoc] = useState<NotebookDoc | null>(null);
  const [outs, setOuts] = useState<CellOut[]>([]);
  const [error, setError] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [runningAll, setRunningAll] = useState(false);
  const [focused, setFocused] = useState(0);

  const cellRefs = useRef<(HTMLDivElement | null)[]>([]);
  const cancels = useRef<Record<number, () => void>>({});
  // Handlers close over the doc; a ref keeps `save` stable without stale reads.
  const docRef = useRef<NotebookDoc | null>(null);
  docRef.current = doc;

  useEffect(() => {
    api
      .get<NotebookDoc>(`/notebooks/${encodeURIComponent(name)}`)
      .then((d) => {
        const cells = d.cells?.length ? d.cells : [{ type: "sql" as CellType, source: "" }];
        setDoc({ catalog: d.catalog ?? null, cells });
        setOuts(cells.map(() => ({})));
      })
      .catch((e) => setError(String(e.message ?? e)));
  }, [name]);

  useEffect(() => {
    const live = cancels.current;
    return () => {
      for (const stop of Object.values(live)) stop();
    };
  }, []);

  /* ---- document mutation ------------------------------------------------ */

  const edit = (mutate: (d: NotebookDoc) => NotebookDoc) => {
    setDoc((cur) => (cur ? mutate(cur) : cur));
    setDirty(true);
  };

  const setSource = (i: number, source: string) =>
    edit((d) => ({ ...d, cells: d.cells.map((c, j) => (j === i ? { ...c, source } : c)) }));

  const addCell = (at: number, type: CellType) => {
    edit((d) => {
      const cells = [...d.cells];
      cells.splice(at, 0, { type, source: "" });
      return { ...d, cells };
    });
    setOuts((cur) => {
      const next = [...cur];
      next.splice(at, 0, {});
      return next;
    });
    setFocused(at);
  };

  const deleteCell = (i: number) => {
    edit((d) => {
      const cells = d.cells.filter((_, j) => j !== i);
      return { ...d, cells: cells.length ? cells : [{ type: "sql", source: "" }] };
    });
    setOuts((cur) => {
      const next = cur.filter((_, j) => j !== i);
      return next.length ? next : [{}];
    });
  };

  const moveCell = (i: number, delta: number) => {
    const j = i + delta;
    if (!doc || j < 0 || j >= doc.cells.length) return;
    edit((d) => {
      const cells = [...d.cells];
      [cells[i], cells[j]] = [cells[j], cells[i]];
      return { ...d, cells };
    });
    setOuts((cur) => {
      const next = [...cur];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
    setFocused(j);
  };

  /* ---- persistence + execution ------------------------------------------ */

  const save = useCallback(async () => {
    const d = docRef.current;
    if (!d) return;
    setSaving(true);
    try {
      await api.put(`/notebooks/${encodeURIComponent(name)}`, d);
      setDirty(false);
      setError("");
    } catch (e) {
      setError(String((e as Error).message ?? e));
      throw e;
    } finally {
      setSaving(false);
    }
  }, [name]);

  const streamCell = (i: number) =>
    new Promise<void>((resolve) => {
      cancels.current[i]?.();
      setOuts((cur) => cur.map((o, j) => (j === i ? { running: true } : o)));
      const started = performance.now();
      let acc: CellOut = {};
      cancels.current[i] = sse(`/notebooks/${encodeURIComponent(name)}/cells/${i}/stream`, {
        result: (r) => {
          const d = r as CellResult;
          acc = { rows: d.rows, stdout: d.stdout, stderr: d.stderr };
        },
        error: (m) => {
          acc = { error: m };
        },
        done: () => {
          const finished = { ...acc, seconds: (performance.now() - started) / 1000 };
          setOuts((cur) => cur.map((o, j) => (j === i ? finished : o)));
          delete cancels.current[i];
          resolve();
        },
      });
    });

  const runCell = async (i: number) => {
    try {
      await save();
    } catch {
      return; // the save error is already on screen; running would use stale state
    }
    await streamCell(i);
  };

  const runAll = async () => {
    if (!doc) return;
    try {
      await save();
    } catch {
      return;
    }
    setRunningAll(true);
    for (let i = 0; i < doc.cells.length; i += 1) {
      await streamCell(i);
    }
    setRunningAll(false);
  };

  const insertAtFocus = (text: string) => {
    if (!doc) return;
    const i = Math.min(focused, doc.cells.length - 1);
    const src = doc.cells[i].source;
    setSource(i, src.replace(/\n?$/, "") + (src.trim() ? ` ${text}` : text) + "\n");
    cellRefs.current[i]?.scrollIntoView({ block: "nearest" });
  };

  const scrollToCell = (i: number) =>
    cellRefs.current[i]?.scrollIntoView({ block: "start", behavior: "smooth" });

  /* ---- render ------------------------------------------------------------ */

  return (
    <Workbench
      rail={[
        { id: "toc", icon: "toc", title: "Table of contents" },
        { id: "catalog", icon: "catalog", title: "Catalog" },
      ]}
      defaultPanel="toc"
      panels={{
        toc: (
          <div style={{ padding: "6px 0 12px" }}>
            <div style={{ padding: "4px 12px 8px", fontSize: 11, color: "var(--text-dim)" }}>
              {doc ? `${doc.cells.length} cell${doc.cells.length === 1 ? "" : "s"}` : "…"}
            </div>
            {(doc?.cells ?? []).map((c, i) => (
              <button
                key={i}
                type="button"
                onClick={() => scrollToCell(i)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  width: "100%",
                  textAlign: "left",
                  border: "none",
                  background: "transparent",
                  padding: "6px 12px",
                  fontFamily: "inherit",
                  fontSize: 12,
                  color: "var(--text-mid)",
                }}
              >
                <span className="mono" style={{ fontSize: 10, color: "var(--text-faint)" }}>
                  {String(i + 1).padStart(2, "0")}
                </span>
                <Badge type={c.type} tiny />
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {headline(c.source) || <span style={{ color: "var(--text-faint)" }}>empty</span>}
                </span>
              </button>
            ))}
          </div>
        ),
        catalog: (
          <>
            <div style={{ padding: "8px 12px", fontSize: 11, color: "var(--text-dim)" }}>
              Click a table to insert its name
            </div>
            {catalogs && catalogs.length > 0 ? (
              <CatalogTree
                catalogs={catalogs}
                onPick={(r) => insertAtFocus(qualify(r.catalog, r.schema, r.table))}
              />
            ) : (
              <div style={{ padding: "8px 12px", fontSize: 11.5, color: "var(--text-dim)" }}>
                {catalogs ? "No catalogs yet." : "Loading…"}
              </div>
            )}
          </>
        ),
      }}
      tabs={{
        items: [{ id: name, name: dirty ? `${name} •` : name, icon: "▧" }],
        activeId: name,
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
        {/* document header */}
        <div
          style={{
            flex: "0 0 auto",
            display: "flex",
            alignItems: "center",
            gap: 10,
            flexWrap: "wrap",
            padding: "12px 18px",
            borderBottom: "1px solid var(--border)",
            position: "sticky",
            top: 0,
            zIndex: 5,
            background: "var(--surface)",
          }}
        >
          <button type="button" onClick={() => nav("/notebooks")} style={crumbBtn}>
            ‹ Notebooks
          </button>
          <span className="mono" style={{ fontSize: 12.5, fontWeight: 600 }}>
            ~/notebooks/{name}.json
          </span>
          {dirty && (
            <span style={{ fontSize: 11, color: "var(--accent-ink)" }}>unsaved changes</span>
          )}
          <div style={{ flex: 1 }} />
          <select
            value={doc?.catalog ?? ""}
            onChange={(e) => edit((d) => ({ ...d, catalog: e.target.value || null }))}
            aria-label="Catalog"
            className="mono"
            style={{
              padding: "5px 10px",
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
          <button type="button" onClick={() => void save()} style={ghost}>
            {saving ? "Saving…" : "Save"}
          </button>
          <button
            type="button"
            onClick={() => void runAll()}
            disabled={runningAll || !doc}
            style={{ ...ghost, color: runningAll ? "var(--text-faint)" : "var(--text-mid)" }}
          >
            {runningAll ? "Running…" : "Run all"}
          </button>
        </div>

        {error && (
          <div
            className="mono"
            style={{
              margin: "14px 18px 0",
              background: "var(--accent-tint)",
              border: "1px solid var(--err)",
              borderRadius: 12,
              padding: "10px 14px",
              color: "var(--err)",
              fontSize: 12.5,
            }}
          >
            {error}
          </div>
        )}

        {/* cells */}
        <div style={{ padding: "16px 18px 80px", display: "flex", flexDirection: "column", gap: 4 }}>
          {!doc && !error && (
            <div style={{ fontSize: 12.5, color: "var(--text-dim)" }}>Loading…</div>
          )}
          {doc?.cells.map((c, i) => (
            <div key={i}>
              <div
                ref={(el) => {
                  cellRefs.current[i] = el;
                }}
                onFocus={() => setFocused(i)}
                style={{
                  background: "var(--surface)",
                  border: "1px solid var(--border)",
                  borderLeft: `3px solid ${
                    focused === i ? "var(--accent)" : "var(--border-strong)"
                  }`,
                  borderRadius: 12,
                  overflow: "hidden",
                }}
              >
                {/* cell toolbar */}
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "7px 10px",
                    background: "var(--surface-alt)",
                    borderBottom: "1px solid var(--border)",
                  }}
                >
                  <span className="mono" style={{ fontSize: 10.5, color: "var(--text-faint)" }}>
                    [{i + 1}]
                  </span>
                  <Badge type={c.type} />
                  <select
                    value={c.type}
                    onChange={(e) =>
                      edit((d) => ({
                        ...d,
                        cells: d.cells.map((x, j) =>
                          j === i ? { ...x, type: e.target.value as CellType } : x,
                        ),
                      }))
                    }
                    aria-label={`Cell ${i + 1} language`}
                    style={{
                      border: "1px solid var(--border)",
                      borderRadius: 8,
                      background: "var(--surface)",
                      color: "var(--text-muted)",
                      fontSize: 11,
                      padding: "2px 6px",
                    }}
                  >
                    <option value="sql">sql</option>
                    <option value="python">python</option>
                    <option value="r">r</option>
                  </select>
                  <div style={{ flex: 1 }} />
                  <IconBtn label="Move up" onClick={() => moveCell(i, -1)}>
                    ↑
                  </IconBtn>
                  <IconBtn label="Move down" onClick={() => moveCell(i, 1)}>
                    ↓
                  </IconBtn>
                  <IconBtn label="Delete cell" onClick={() => deleteCell(i)} danger>
                    ✕
                  </IconBtn>
                  <button
                    type="button"
                    onClick={() => void runCell(i)}
                    disabled={outs[i]?.running || runningAll}
                    style={{
                      background: outs[i]?.running ? "var(--track)" : "var(--accent)",
                      color: outs[i]?.running ? "var(--text-dim)" : "var(--on-accent)",
                      border: "none",
                      borderRadius: 9,
                      fontWeight: 600,
                      fontSize: 11.5,
                      padding: "5px 12px",
                    }}
                  >
                    {outs[i]?.running ? "Running…" : "▶ Run"}
                  </button>
                </div>

                {/* source */}
                <textarea
                  value={c.source}
                  spellCheck={false}
                  rows={rowsFor(c.source)}
                  onFocus={() => setFocused(i)}
                  onChange={(e) => setSource(i, e.target.value)}
                  onKeyDown={(e) => {
                    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                      e.preventDefault();
                      void runCell(i);
                    }
                  }}
                  aria-label={`Cell ${i + 1} source`}
                  className="mono"
                  style={{
                    display: "block",
                    width: "100%",
                    border: "none",
                    outline: "none",
                    resize: "vertical",
                    padding: "12px 14px",
                    background: "var(--surface)",
                    color: "var(--text)",
                    fontSize: 12.5,
                    lineHeight: "20px",
                    tabSize: 2,
                  }}
                />

                {/* output */}
                <Output out={outs[i]} />
              </div>

              {/* add-cell gutter */}
              <AddCell onAdd={(t) => addCell(i + 1, t)} />
            </div>
          ))}
        </div>
      </div>
    </Workbench>
  );
}

/* ---- pieces ------------------------------------------------------------- */

function Output({ out }: { out?: CellOut }) {
  if (!out || (!out.rows && !out.stdout && !out.stderr && !out.error && !out.running)) return null;
  return (
    <div
      style={{
        borderTop: "1px solid var(--border)",
        background: "var(--surface-alt)",
        padding: "10px 14px",
        maxHeight: 420,
        overflow: "auto",
      }}
    >
      {out.running && (
        <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
          Running on your engine session…
        </div>
      )}
      {out.error && (
        <div className="mono" style={{ fontSize: 12, color: "var(--err)", whiteSpace: "pre-wrap" }}>
          {out.error}
        </div>
      )}
      {!out.running && out.rows && (
        <>
          <div
            style={{
              fontSize: 11.5,
              color: "var(--ok-ink)",
              fontWeight: 600,
              marginBottom: 8,
            }}
          >
            ✓ {out.rows.length.toLocaleString()} row{out.rows.length === 1 ? "" : "s"}
            {out.seconds !== undefined && (
              <span style={{ color: "var(--text-dim)", fontWeight: 400 }}>
                {" "}
                · {out.seconds.toFixed(2)} s
              </span>
            )}
          </div>
          {out.rows.length > 0 ? (
            <ResultGrid rows={out.rows} />
          ) : (
            <div style={{ fontSize: 12, color: "var(--text-dim)" }}>No rows.</div>
          )}
        </>
      )}
      {out.stdout && (
        <pre className="mono" style={pre}>
          {out.stdout}
        </pre>
      )}
      {out.stderr && (
        <pre className="mono" style={{ ...pre, color: "var(--err)" }}>
          {out.stderr}
        </pre>
      )}
    </div>
  );
}

function AddCell({ onAdd }: { onAdd: (t: CellType) => void }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "6px 0 6px 10px",
        fontSize: 11,
        color: "var(--text-faint)",
      }}
    >
      <span>+</span>
      {(["sql", "python", "r"] as CellType[]).map((t) => (
        <button
          key={t}
          type="button"
          onClick={() => onAdd(t)}
          style={{
            border: "1px solid var(--border)",
            borderRadius: 8,
            background: "var(--surface)",
            color: "var(--text-muted)",
            fontFamily: "inherit",
            fontSize: 11,
            padding: "2px 9px",
          }}
        >
          {BADGE[t]}
        </button>
      ))}
    </div>
  );
}

function Badge({ type, tiny }: { type: CellType; tiny?: boolean }) {
  const sql = type === "sql";
  return (
    <span
      className="mono"
      style={{
        display: "inline-block",
        borderRadius: 6,
        padding: tiny ? "0 4px" : "1px 7px",
        fontSize: tiny ? 9 : 10,
        fontWeight: 600,
        letterSpacing: "0.4px",
        background: sql ? "var(--accent-tint)" : "var(--track)",
        color: sql ? "var(--accent-tint-ink)" : "var(--text-muted)",
      }}
    >
      {BADGE[type]}
    </span>
  );
}

function IconBtn({
  children,
  label,
  onClick,
  danger,
}: {
  children: string;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      style={{
        width: 22,
        height: 22,
        border: "none",
        borderRadius: 6,
        background: "transparent",
        color: danger ? "var(--err)" : "var(--text-faint)",
        fontSize: 11,
        lineHeight: 1,
      }}
    >
      {children}
    </button>
  );
}

/* ---- helpers ------------------------------------------------------------ */

/** First non-empty line, for the table of contents. */
function headline(source: string): string {
  const line = source.split("\n").find((l) => l.trim().length > 0) ?? "";
  return line.trim().replace(/^(--|#)\s*/, "").slice(0, 48);
}

/**
 * Auto-grow by *counting* lines rather than measuring the element: reading
 * scrollHeight to set height in a scrolling flex column is exactly the kind of
 * feedback that froze the prototype (spec §9).
 */
function rowsFor(source: string): number {
  return Math.min(30, Math.max(3, source.split("\n").length + 1));
}

const pre: CSSProperties = {
  fontSize: 12,
  lineHeight: "18px",
  whiteSpace: "pre-wrap",
  overflowWrap: "break-word",
  color: "var(--text-mid)",
  marginTop: 6,
};

const ghost: CSSProperties = {
  background: "var(--surface)",
  color: "var(--text-mid)",
  border: "1px solid var(--border)",
  borderRadius: 11,
  fontSize: 12.5,
  padding: "7px 14px",
};

const crumbBtn: CSSProperties = {
  border: "none",
  background: "transparent",
  padding: 0,
  font: "inherit",
  fontSize: 11.5,
  color: "var(--text-dim)",
};
