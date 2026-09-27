import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, errorText, sse, type Row } from "../api";
import { recordRecent } from "../recents";
import { qualify, useCatalogs } from "../catalogs";
import { CatalogPanel } from "../components/CatalogTree";
import { Markdown, markdownHeadings } from "../components/Markdown";
import { Workbench } from "../components/Workbench";
import { WorkspaceTree } from "../components/WorkspaceTree";
import { leafOf, notebookApi, notebookUrl, useNotebookTree } from "../notebooks";
import { ResultGrid } from "./Catalog";

/*
 * /notebooks/<path> — the notebook document (spec §5 "notebook"), on the
 * workbench shell: icon rail → table of contents / catalog panels, then the
 * document header and a vertical run of cells.
 *
 * The server executes a cell *by index* against the notebook it has on disk,
 * so every run saves first — otherwise an edited-but-unsaved cell would run
 * its stale twin. Outputs live in a plain array kept in lockstep with `cells`
 * (add / delete / move splice both), so a reorder carries its results along.
 *
 * Outputs are persisted with the document (the server whitelists the fields
 * and caps the total), so a reopened notebook shows what it last produced —
 * marked "from last run" until the cell runs again. After a run the notebook
 * saves itself once more (debounced) so the fresh outputs reach disk.
 *
 * Markdown cells never run: they toggle between a textarea and the safe
 * renderer in components/Markdown.tsx, and feed the table of contents.
 */

type CellType = "sql" | "python" | "r" | "md";

/** A DataFrame result from a python/r cell. */
interface DfTable {
  columns: string[];
  rows: Row[];
  total: number;
  truncated?: boolean;
}

/** The union the stream can carry — and what the server persists per cell. */
interface CellResult {
  ok?: boolean;
  rows?: Row[];
  stdout?: string;
  stderr?: string;
  error?: string;
  images?: string[];
  table?: DfTable;
  truncated?: boolean;
}

interface Cell {
  type: CellType;
  source: string;
  output?: CellResult;
}

interface NotebookDoc {
  catalog: string | null;
  cells: Cell[];
}

interface CellOut extends CellResult {
  running?: boolean;
  seconds?: number;
  /** Loaded from disk, not produced in this visit. */
  stale?: boolean;
}

const BADGE: Record<CellType, string> = { sql: "SQL", python: "PY", r: "R", md: "MD" };
const CELL_TYPES: CellType[] = ["sql", "python", "r", "md"];

/** The `/notebooks/*` route: the splat is the notebook's path in ~/notebooks. */
export function NotebookRoute() {
  const path = (useParams()["*"] ?? "").replace(/^\/+|\/+$/g, "");
  // Keyed by path: switching notebooks from the workspace tree starts clean
  // instead of carrying the last document's outputs and streams across.
  return <Notebook key={path} name={path} />;
}

export function Notebook({ name }: { name: string }) {
  const nav = useNavigate();
  const { catalogs, error: catalogError } = useCatalogs();
  const workspace = useNotebookTree();

  const [doc, setDoc] = useState<NotebookDoc | null>(null);
  const [outs, setOuts] = useState<CellOut[]>([]);
  const [error, setError] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [runningAll, setRunningAll] = useState(false);
  const [focused, setFocused] = useState(0);
  /** The markdown cell currently in edit mode (one at a time). */
  const [mdEdit, setMdEdit] = useState<number | null>(null);

  const cellRefs = useRef<(HTMLDivElement | null)[]>([]);
  const cancels = useRef<Record<number, () => void>>({});
  // Handlers close over the doc; a ref keeps `save` stable without stale reads.
  const docRef = useRef<NotebookDoc | null>(null);
  docRef.current = doc;
  const outsRef = useRef<CellOut[]>([]);
  outsRef.current = outs;
  const autoSave = useRef<number | undefined>(undefined);

  useEffect(() => {
    api
      .get<NotebookDoc>(notebookApi(name))
      .then((d) => {
        const loaded: Cell[] = d.cells?.length ? d.cells : [{ type: "sql", source: "" }];
        const cells = loaded.map((c) => ({
          type: CELL_TYPES.includes(c.type) ? c.type : "sql",
          source: c.source ?? "",
        }));
        setDoc({ catalog: d.catalog ?? null, cells });
        recordRecent("notebook", name, d.catalog ?? null);
        setOuts(loaded.map((c) => (c.output && c.type !== "md" ? { ...c.output, stale: true } : {})));
      })
      .catch((e) => setError(errorText(e)));
  }, [name]);

  useEffect(() => {
    const live = cancels.current;
    return () => {
      for (const stop of Object.values(live)) stop();
      window.clearTimeout(autoSave.current);
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
    setMdEdit((cur) => (type === "md" ? at : cur !== null && cur >= at ? cur + 1 : cur));
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
    setMdEdit(null);
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
    setMdEdit((cur) => (cur === i ? j : cur === j ? i : cur));
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
    window.clearTimeout(autoSave.current);
    const outs = outsRef.current;
    const payload = {
      catalog: d.catalog,
      cells: d.cells.map((c, i) => {
        const output = c.type === "md" ? undefined : persistable(outs[i]);
        return output ? { type: c.type, source: c.source, output } : { type: c.type, source: c.source };
      }),
    };
    setSaving(true);
    try {
      await api.put(notebookApi(name), payload);
      setDirty(false);
      setError("");
    } catch (e) {
      setError(errorText(e));
      throw e;
    } finally {
      setSaving(false);
    }
  }, [name]);

  /** Fresh outputs reach disk shortly after the last run finishes. */
  const scheduleSave = useCallback(() => {
    window.clearTimeout(autoSave.current);
    autoSave.current = window.setTimeout(() => {
      save().catch(() => {}); // the error is already on screen
    }, 800);
  }, [save]);

  const streamCell = (i: number) =>
    new Promise<void>((resolve) => {
      cancels.current[i]?.();
      setOuts((cur) => cur.map((o, j) => (j === i ? { running: true } : o)));
      const started = performance.now();
      let acc: CellOut = {};
      cancels.current[i] = sse(`${notebookApi(name)}/cells/${i}/stream`, {
        result: (r) => {
          const d = r as CellResult;
          acc = {
            ok: d.ok,
            rows: d.rows,
            stdout: d.stdout,
            stderr: d.stderr,
            error: d.error,
            images: d.images,
            table: d.table,
            truncated: d.truncated,
          };
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
    scheduleSave();
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
      if (doc.cells[i].type === "md") continue; // markdown renders, never runs
      await streamCell(i);
    }
    setRunningAll(false);
    scheduleSave();
  };

  /** The export reads the file on disk, so unsaved edits go first. */
  const exportIpynb = async () => {
    if (dirty) {
      try {
        await save();
      } catch {
        return;
      }
    }
    const a = document.createElement("a");
    a.href = `/api${notebookApi(name)}/ipynb`;
    a.download = `${leafOf(name)}.ipynb`;
    a.click();
  };

  /** Switching notebooks from the workspace tree keeps unsaved edits. */
  const openOther = async (path: string) => {
    if (dirty) {
      try {
        await save();
      } catch {
        return; // the save error is on screen; staying keeps the edits
      }
    }
    nav(notebookUrl(path));
  };

  const toc = (doc?.cells ?? []).flatMap((c, i) => {
    if (c.type === "md") {
      const hs = markdownHeadings(c.source);
      if (hs.length) return hs.map((h) => ({ i, type: c.type, text: h.text, level: h.level }));
    }
    return [{ i, type: c.type, text: headline(c.source), level: 0 }];
  });

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
        { id: "toc", icon: "toc", title: "Contents & workspace" },
        { id: "catalog", icon: "catalog", title: "Catalog" },
      ]}
      defaultPanel="toc"
      panels={{
        toc: (
          <div style={{ paddingBottom: 12 }}>
            <PanelSection title="Contents">
            <div style={{ padding: "4px 12px 8px", fontSize: "var(--fs-label)", color: "var(--text-dim)" }}>
              {doc ? `${doc.cells.length} cell${doc.cells.length === 1 ? "" : "s"}` : "…"}
            </div>
            {toc.map((e, k) => (
              <button
                key={k}
                type="button"
                onClick={() => scrollToCell(e.i)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  width: "100%",
                  textAlign: "left",
                  border: "none",
                  background: "transparent",
                  padding: "6px 12px",
                  paddingLeft: 12 + Math.max(0, e.level - 1) * 12,
                  fontFamily: "inherit",
                  fontSize: e.level === 1 ? "var(--fs-body)" : "var(--fs-meta)",
                  fontWeight: e.level === 1 ? 600 : 400,
                  color: e.level ? "var(--text)" : "var(--text-mid)",
                }}
              >
                <span className="mono" style={{ fontSize: "var(--fs-xs)", color: "var(--text-faint)" }}>
                  {String(e.i + 1).padStart(2, "0")}
                </span>
                {e.level === 0 && <Badge type={e.type} tiny />}
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {e.text || <span style={{ color: "var(--text-faint)" }}>empty</span>}
                </span>
              </button>
            ))}
            </PanelSection>
            <PanelSection title="Workspace">
              <WorkspaceTree
                tree={workspace.tree}
                error={workspace.error}
                reload={workspace.reload}
                current={name}
                onOpen={(p) => void openOther(p)}
              />
            </PanelSection>
          </div>
        ),
        catalog: (
          <CatalogPanel
            catalogs={catalogs}
            error={catalogError}
            onPick={(r) => insertAtFocus(qualify(r.catalog, r.schema, r.table))}
          />
        ),
      }}
      tabs={{
        items: [{ id: name, name: dirty ? `${leafOf(name)} •` : leafOf(name), icon: "▧" }],
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
          <Breadcrumb path={name} onFolder={(f) => nav(f ? `/notebooks?folder=${encodeURIComponent(f)}` : "/notebooks")} />
          {dirty && (
            <span style={{ fontSize: "var(--fs-label)", color: "var(--accent-ink)" }}>unsaved changes</span>
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
              fontSize: "var(--fs-small)",
            }}
          >
            <option value="">no catalog</option>
            {(catalogs ?? []).map((c) => (
              <option key={c.name} value={c.name}>
                {c.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => void save()}
            disabled={!doc || saving}
            style={{ ...ghost, color: !doc || saving ? "var(--text-faint)" : "var(--text-mid)" }}
          >
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
          <button
            type="button"
            onClick={() => void exportIpynb()}
            disabled={!doc || saving}
            title="Download as a Jupyter notebook (outputs are left out)"
            style={{ ...ghost, color: !doc || saving ? "var(--text-faint)" : "var(--text-mid)" }}
          >
            Export .ipynb
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
              fontSize: "var(--fs-body)",
            }}
          >
            {error}
          </div>
        )}

        {/* cells */}
        <div style={{ padding: "16px 18px 80px", display: "flex", flexDirection: "column", gap: 4 }}>
          {!doc && !error && (
            <div style={{ fontSize: "var(--fs-body)", color: "var(--text-dim)" }}>Loading…</div>
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
                  <span className="mono" style={{ fontSize: "var(--fs-eyebrow)", color: "var(--text-faint)" }}>
                    [{i + 1}]
                  </span>
                  <Badge type={c.type} />
                  <select
                    value={c.type}
                    onChange={(e) => {
                      const type = e.target.value as CellType;
                      edit((d) => ({
                        ...d,
                        cells: d.cells.map((x, j) => (j === i ? { ...x, type } : x)),
                      }));
                      if (type === "md") {
                        cancels.current[i]?.();
                        delete cancels.current[i];
                        setOuts((cur) => cur.map((o, j) => (j === i ? {} : o)));
                        setMdEdit(i);
                      }
                    }}
                    aria-label={`Cell ${i + 1} language`}
                    style={{
                      border: "1px solid var(--border)",
                      borderRadius: 8,
                      background: "var(--surface)",
                      color: "var(--text-muted)",
                      fontSize: "var(--fs-label)",
                      padding: "2px 6px",
                    }}
                  >
                    <option value="sql">sql</option>
                    <option value="python">python</option>
                    <option value="r">r</option>
                    <option value="md">markdown</option>
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
                  {c.type === "md" ? (
                    <button
                      type="button"
                      // mousedown fires before the textarea's blur, so Done
                      // doesn't re-open what blur just closed.
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => setMdEdit((cur) => (cur === i ? null : i))}
                      style={{ ...ghost, fontSize: "var(--fs-small)", padding: "4px 12px", borderRadius: 9 }}
                    >
                      {mdEdit === i ? "Done" : "Edit"}
                    </button>
                  ) : (
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
                      fontSize: "var(--fs-small)",
                      padding: "5px 12px",
                    }}
                  >
                    {outs[i]?.running ? "Running…" : "▶ Run"}
                  </button>
                  )}
                </div>

                {/* source */}
                {c.type === "md" && mdEdit !== i ? (
                  <div
                    onDoubleClick={() => setMdEdit(i)}
                    title="Double-click to edit"
                    style={{ padding: "14px 18px", background: "var(--surface)", cursor: "text" }}
                  >
                    {c.source.trim() ? (
                      <Markdown source={c.source} />
                    ) : (
                      <div style={{ fontSize: "var(--fs-body)", color: "var(--text-faint)" }}>
                        Empty markdown cell — double-click to write.
                      </div>
                    )}
                  </div>
                ) : (
                <textarea
                  value={c.source}
                  spellCheck={false}
                  rows={rowsFor(c.source)}
                  autoFocus={c.type === "md"}
                  onFocus={() => setFocused(i)}
                  onBlur={() => {
                    if (c.type === "md") setMdEdit((cur) => (cur === i ? null : cur));
                  }}
                  onChange={(e) => setSource(i, e.target.value)}
                  onKeyDown={(e) => {
                    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                      e.preventDefault();
                      if (c.type === "md") setMdEdit(null);
                      else void runCell(i);
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
                    fontSize: "var(--fs-body)",
                    lineHeight: "20px",
                    tabSize: 2,
                  }}
                />
                )}

                {/* output */}
                {c.type !== "md" && <Output out={outs[i]} />}
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

/** `~/notebooks / projects / hedis / q1.json` — each folder opens the index there. */
function Breadcrumb({ path, onFolder }: { path: string; onFolder: (folder: string) => void }) {
  const segs = path.split("/");
  const folders = segs.slice(0, -1);
  return (
    <span
      className="mono"
      title={`~/notebooks/${path}.json`}
      style={{ display: "flex", alignItems: "center", flexWrap: "wrap", fontSize: "var(--fs-body)", minWidth: 0 }}
    >
      <button type="button" onClick={() => onFolder("")} style={{ ...crumbBtn, fontSize: "var(--fs-body)" }}>
        ~/notebooks
      </button>
      {folders.map((f, i) => (
        <span key={i} style={{ display: "inline-flex", alignItems: "center" }}>
          <span style={{ color: "var(--text-faint)" }}>/</span>
          <button
            type="button"
            onClick={() => onFolder(folders.slice(0, i + 1).join("/"))}
            style={{ ...crumbBtn, fontSize: "var(--fs-body)" }}
          >
            {f}
          </button>
        </span>
      ))}
      <span style={{ color: "var(--text-faint)" }}>/</span>
      <span style={{ fontWeight: 600 }}>{segs[segs.length - 1]}.json</span>
    </span>
  );
}

/** A collapsible block inside the workbench panel (Contents, Workspace). */
function PanelSection({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <section style={{ borderBottom: "1px solid var(--border-soft)" }}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          width: "100%",
          border: "none",
          background: "transparent",
          padding: "9px 12px 6px",
          fontFamily: "inherit",
          fontSize: "var(--fs-eyebrow)",
          fontWeight: 600,
          letterSpacing: "0.8px",
          textTransform: "uppercase",
          color: "var(--text-faint)",
          textAlign: "left",
        }}
      >
        <span style={{ width: 10 }}>{open ? "▾" : "▸"}</span>
        {title}
      </button>
      {open && <div style={{ paddingBottom: 6 }}>{children}</div>}
    </section>
  );
}

function Output({ out }: { out?: CellOut }) {
  if (!out || (!hasOutput(out) && !out.running)) return null;
  return (
    <div
      style={{
        borderTop: "1px solid var(--border)",
        background: "var(--surface-alt)",
        padding: "10px 14px",
        maxHeight: 560,
        overflow: "auto",
      }}
    >
      {out.running && (
        <div style={{ fontSize: "var(--fs-meta)", color: "var(--text-muted)" }}>
          Running on your engine session…
        </div>
      )}
      {out.stale && !out.running && (
        <div
          className="mono"
          title="Saved with the notebook — run the cell to refresh"
          style={{ fontSize: "var(--fs-eyebrow)", color: "var(--text-faint)", marginBottom: 6 }}
        >
          from last run
        </div>
      )}
      {out.error && (
        <div className="mono" style={{ fontSize: "var(--fs-meta)", color: "var(--err)", whiteSpace: "pre-wrap" }}>
          {out.error}
        </div>
      )}
      {!out.running && out.rows && (
        <>
          <div
            style={{
              fontSize: "var(--fs-small)",
              color: "var(--ok-ink)",
              fontWeight: 600,
              marginBottom: 8,
            }}
          >
            ✓ {out.rows.length.toLocaleString()} row{out.rows.length === 1 ? "" : "s"}
            {out.truncated && (
              <span style={{ color: "var(--warn)", fontWeight: 400 }}> · truncated</span>
            )}
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
            <div style={{ fontSize: "var(--fs-meta)", color: "var(--text-dim)" }}>No rows.</div>
          )}
        </>
      )}
      {!out.running && out.table && (
        <div style={{ marginBottom: 6 }}>
          <div style={{ fontSize: "var(--fs-small)", color: "var(--text-muted)", marginBottom: 6 }}>
            {out.table.truncated
              ? `${out.table.rows.length.toLocaleString()} of ${out.table.total.toLocaleString()} rows`
              : `${out.table.total.toLocaleString()} row${out.table.total === 1 ? "" : "s"}`}
          </div>
          {out.table.rows.length > 0 ? (
            <ResultGrid rows={out.table.rows} columns={out.table.columns} />
          ) : (
            <div style={{ fontSize: "var(--fs-meta)", color: "var(--text-dim)" }}>Empty frame.</div>
          )}
        </div>
      )}
      {!out.running &&
        out.images?.map((b64, k) => (
          <img
            key={k}
            src={`data:image/png;base64,${b64}`}
            alt={`Figure ${k + 1}`}
            style={{
              display: "block",
              maxWidth: "100%",
              height: "auto",
              margin: "6px 0",
              background: "var(--surface)",
              borderRadius: 8,
            }}
          />
        ))}
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
        fontSize: "var(--fs-label)",
        color: "var(--text-faint)",
      }}
    >
      <span>+</span>
      {CELL_TYPES.map((t) => (
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
            fontSize: "var(--fs-label)",
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
        fontSize: tiny ? "var(--fs-2xs)" : "var(--fs-xs)",
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
        fontSize: "var(--fs-label)",
        lineHeight: 1,
      }}
    >
      {children}
    </button>
  );
}

/* ---- helpers ------------------------------------------------------------ */

function hasOutput(o: CellResult): boolean {
  return Boolean(
    o.rows || o.stdout || o.stderr || o.error || o.images?.length || o.table,
  );
}

/** The whitelisted slice of an output the server persists; none while running. */
function persistable(o?: CellOut): CellResult | undefined {
  if (!o || o.running || !hasOutput(o)) return undefined;
  const { ok, rows, stdout, stderr, error, images, table, truncated } = o;
  return { ok: ok ?? !error, rows, stdout, stderr, error, images, table, truncated };
}

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
  fontSize: "var(--fs-meta)",
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
  fontSize: "var(--fs-body)",
  padding: "7px 14px",
};

const crumbBtn: CSSProperties = {
  border: "none",
  background: "transparent",
  padding: 0,
  font: "inherit",
  fontSize: "var(--fs-small)",
  color: "var(--text-dim)",
};
