import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { Link, useSearchParams } from "react-router-dom";
import { recordRecent } from "../recents";
import { api, columnsOf, errorText, sse, type Row } from "../api";
import { qualify, useCatalogs } from "../catalogs";
import { CatalogPanel } from "../components/CatalogTree";
import { FormMessage, SmallButton, selectStyle } from "../components/Form";
import { Workbench } from "../components/Workbench";
import { ResultGrid, cell } from "./Catalog";
import { DOC_NAME } from "./Notebooks";

/*
 * /sql — the SQL editor (spec §5 "sql"), on the workbench shell.
 *
 * Documents live in localStorage, so a reload keeps your unsaved-to-disk
 * scratch queries. Execution goes through the SSE endpoint (REQ-31): status →
 * result|error → done, which runs on the signed-in user's engine session.
 */

const STORE = "pebbles.sqldocs.v1";

interface SqlDoc {
  id: string;
  name: string;
  sql: string;
  catalog: string | null;
}

const blank = (n: number): SqlDoc => ({
  id: `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
  name: `query-${n}.sql`,
  sql: "SELECT 1;\n",
  catalog: null,
});

function loadDocs(): SqlDoc[] {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE) ?? "[]");
    if (Array.isArray(raw) && raw.length > 0) {
      return raw
        .filter((d) => d && typeof d.id === "string")
        .map((d) => ({
          id: String(d.id),
          name: String(d.name ?? "query.sql"),
          sql: String(d.sql ?? ""),
          catalog: d.catalog ? String(d.catalog) : null,
        }));
    }
  } catch {
    /* corrupt storage is not worth a crash — start fresh */
  }
  return [blank(1)];
}

export function Sql() {
  const [params, setParams] = useSearchParams();
  const { catalogs, error: catalogError } = useCatalogs();
  // One read of storage seeds both pieces of state — two `loadDocs()` calls
  // would mint different ids for a first-run document and desync the tab strip.
  const seed = useRef<SqlDoc[]>(null as unknown as SqlDoc[]);
  if (seed.current === null) seed.current = loadDocs();
  const [docs, setDocs] = useState<SqlDoc[]>(seed.current);
  const [activeId, setActiveId] = useState<string>(seed.current[0].id);
  const [dirty, setDirty] = useState<Record<string, boolean>>({});

  /** Result tabs per script (keyed by doc id), oldest first, capped at MAX_RESULTS. */
  const [results, setResults] = useState<Record<string, RunResult[]>>({});
  /** The selected result tab per script. */
  const [picked, setPicked] = useState<Record<string, string>>({});
  /** Next "Result N" number per script — never reused after a close. */
  const counters = useRef<Record<string, number>>({});
  const [addOpen, setAddOpen] = useState(false);
  /** One live stream per script; a new run of the same script replaces it. */
  const cancels = useRef<Record<string, () => void>>({});

  const doc = docs.find((d) => d.id === activeId) ?? docs[0];

  const persist = useCallback((next: SqlDoc[]) => {
    localStorage.setItem(STORE, JSON.stringify(next));
  }, []);

  /** Structural change: swap the doc list, persist it, optionally refocus. */
  const commit = useCallback(
    (next: SqlDoc[], focus?: string) => {
      setDocs(next);
      persist(next);
      if (focus) setActiveId(focus);
    },
    [persist],
  );

  // `docs` read from an effect/handler that must not re-subscribe on every edit.
  const docsRef = useRef(docs);
  docsRef.current = docs;

  // ?q= / ?catalog= — how Catalog's Query and Time-travel buttons arrive here.
  // Clicking Query on the same table twice must not pile up identical tabs:
  // a document with the same SQL and catalog is reactivated instead.
  useEffect(() => {
    const q = params.get("q");
    if (q === null) return;
    const cur = docsRef.current;
    const sql = q.endsWith("\n") ? q : `${q}\n`;
    const catalog = params.get("catalog");
    const existing = cur.find((d) => d.sql === sql && d.catalog === catalog);
    if (existing) {
      setActiveId(existing.id);
    } else {
      const fresh: SqlDoc = { ...blank(cur.length + 1), sql, catalog };
      commit([...cur, fresh], fresh.id);
    }
    setParams({}, { replace: true });
  }, [params, setParams, commit]);

  useEffect(() => {
    const live = cancels.current;
    return () => {
      for (const stop of Object.values(live)) stop();
    };
  }, []);

  const update = (patch: Partial<SqlDoc>, markDirty = true) => {
    setDocs((cur) => cur.map((d) => (d.id === doc.id ? { ...d, ...patch } : d)));
    if (markDirty) setDirty((cur) => ({ ...cur, [doc.id]: true }));
  };

  const save = () => {
    persist(docs);
    setDirty((cur) => ({ ...cur, [doc.id]: false }));
  };

  const newDoc = () => {
    const fresh = blank(docs.length + 1);
    commit([...docs, fresh], fresh.id);
  };

  const closeDoc = (id: string) => {
    cancels.current[id]?.();
    delete cancels.current[id];
    setResults((cur) => {
      const rest = { ...cur };
      delete rest[id];
      return rest;
    });
    const next = docs.filter((d) => d.id !== id);
    const kept = next.length > 0 ? next : [blank(1)];
    commit(kept, id === activeId ? kept[0].id : undefined);
  };

  const docResults = results[doc.id] ?? [];
  const selected = docResults.find((r) => r.id === picked[doc.id]) ?? docResults[docResults.length - 1] ?? null;
  const running = docResults.some((r) => r.running);
  const rows = selected?.rows ?? null;
  const ranOk = Boolean(selected && !selected.running && !selected.error && selected.rows);

  /** Patch one result of one script, wherever it now sits in the list. */
  const patchResult = (docId: string, id: string, patch: Partial<RunResult>) =>
    setResults((cur) => ({
      ...cur,
      [docId]: (cur[docId] ?? []).map((r) => (r.id === id ? { ...r, ...patch } : r)),
    }));

  const closeResult = (id: string) => {
    const docId = doc.id;
    const gone = (results[docId] ?? []).find((r) => r.id === id);
    if (gone?.running) {
      cancels.current[docId]?.();
      delete cancels.current[docId];
    }
    setResults((cur) => ({ ...cur, [docId]: (cur[docId] ?? []).filter((r) => r.id !== id) }));
  };

  const run = () => {
    const docId = doc.id;
    // A still-running previous run of this script stops and keeps what it had.
    cancels.current[docId]?.();
    const n = (counters.current[docId] ?? 0) + 1;
    counters.current[docId] = n;
    const id = `${docId}:${n}`;
    const entry: RunResult = {
      id,
      n,
      at: new Date().toLocaleTimeString(undefined, { hour12: false }),
      sql: doc.sql,
      catalog: doc.catalog,
      rows: null,
      error: "",
      running: true,
    };
    setResults((cur) => {
      const list = (cur[docId] ?? []).map((r) => (r.running ? { ...r, running: false } : r));
      return { ...cur, [docId]: [...list, entry].slice(-MAX_RESULTS) };
    });
    setPicked((cur) => ({ ...cur, [docId]: id }));
    setAddOpen(false);
    const started = performance.now();
    const ran = { name: doc.name, catalog: doc.catalog };
    const query = `q=${encodeURIComponent(doc.sql)}${
      doc.catalog ? `&catalog=${encodeURIComponent(doc.catalog)}` : ""
    }`;
    // Progressive rows accumulate here and reach state in their batches.
    let acc: Row[] = [];
    cancels.current[docId] = sse(`/sql/stream?${query}`, {
      // Progressive rendering (REQ-31): batches paint as they arrive; the
      // final `result` replaces with the authoritative complete set.
      rows: (b) => {
        acc = [...acc, ...b.rows];
        patchResult(docId, id, { rows: acc });
      },
      result: (r) => {
        patchResult(docId, id, {
          rows: r.rows ?? [],
          truncated: Boolean(r.truncated),
        });
        recordRecent("query", ran.name, ran.catalog);
      },
      error: (m) => patchResult(docId, id, { error: m }),
      done: () => {
        patchResult(docId, id, { running: false, elapsed: (performance.now() - started) / 1000 });
        delete cancels.current[docId];
      },
    });
  };

  const downloadCsv = () => {
    if (!selected || !rows || rows.length === 0) return;
    const cols = columnsOf(rows);
    const esc = (v: unknown) => {
      const s = v === null || v === undefined ? "" : cell(v) === "∅" ? "" : cell(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join(
      "\n",
    );
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${doc.name.replace(/\.sql$/, "")}-result-${selected.n}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const insert = (text: string) =>
    update({ sql: doc.sql.replace(/\n?$/, "") + (doc.sql.trim() ? ` ${text}` : text) + "\n" });

  return (
    <Workbench
      rail={[{ id: "catalog", icon: "catalog", title: "Catalog" }]}
      defaultPanel="catalog"
      panels={{
        catalog: (
          <CatalogPanel
            catalogs={catalogs}
            error={catalogError}
            onPick={(r) => insert(qualify(r.catalog, r.schema, r.table))}
          />
        ),
      }}
      tabs={{
        items: docs.map((d) => ({
          id: d.id,
          name: dirty[d.id] ? `${d.name} •` : d.name,
          icon: "›_",
        })),
        activeId: doc.id,
        onSelect: setActiveId,
        onClose: closeDoc,
        onNew: newDoc,
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", minHeight: 0, height: "100%" }}>
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
          }}
        >
          <span className="mono" style={{ fontSize: "var(--fs-base)", fontWeight: 600 }}>
            {doc.name}
          </span>
          <select
            value={doc.catalog ?? ""}
            onChange={(e) => update({ catalog: e.target.value || null }, false)}
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
          <div style={{ flex: 1 }} />
          <button type="button" onClick={save} style={ghost}>
            Save
          </button>
          <button
            type="button"
            onClick={run}
            disabled={running}
            style={{
              background: running ? "var(--track)" : "var(--accent)",
              color: running ? "var(--text-dim)" : "var(--on-accent)",
              border: "none",
              borderRadius: 11,
              fontWeight: 600,
              fontSize: "var(--fs-body)",
              padding: "8px 16px",
            }}
          >
            {running ? "Running…" : "▶ Run"}
          </button>
        </div>

        {/* editor */}
        <Editor value={doc.sql} onChange={(sql) => update({ sql })} onRun={run} />

        {/* results */}
        <div
          style={{
            flex: "1 1 auto",
            minHeight: 0,
            display: "flex",
            flexDirection: "column",
            borderTop: "1px solid var(--border)",
            background: "var(--surface-alt)",
          }}
        >
          {/* result tabs — newest right, selected one drives the toolbar */}
          {docResults.length > 0 && (
            <div
              role="tablist"
              aria-label="Results"
              style={{
                flex: "0 0 auto",
                display: "flex",
                alignItems: "stretch",
                overflowX: "auto",
                borderBottom: "1px solid var(--border)",
                background: "var(--surface-alt)",
              }}
            >
              {docResults.map((r) => (
                <ResultTab
                  key={r.id}
                  result={r}
                  on={r.id === selected?.id}
                  onSelect={() => setPicked((cur) => ({ ...cur, [doc.id]: r.id }))}
                  onClose={() => closeResult(r.id)}
                />
              ))}
            </div>
          )}
          <div
            style={{
              flex: "0 0 auto",
              display: "flex",
              alignItems: "center",
              gap: 14,
              flexWrap: "wrap",
              padding: "9px 18px",
              borderBottom: "1px solid var(--border)",
              fontSize: "var(--fs-meta)",
              color: "var(--text-muted)",
            }}
          >
            {selected?.running && <span>Running on your engine session…</span>}
            {selected && !selected.running && !selected.error && rows && (
              <span style={{ color: "var(--ok-ink)", fontWeight: 600 }}>
                ✓ {rows.length.toLocaleString()} row{rows.length === 1 ? "" : "s"}
              </span>
            )}
            {selected && !selected.running && selected.error && (
              <span style={{ color: "var(--err)", fontWeight: 600 }}>✕ Failed</span>
            )}
            {!selected && <span>Results appear here after a run — each run opens its own tab.</span>}
            {selected?.elapsed !== undefined && !selected.running && (
              <span>{selected.elapsed.toFixed(2)} s</span>
            )}
            <div style={{ flex: 1 }} />
            <button
              type="button"
              onClick={downloadCsv}
              disabled={!rows || rows.length === 0}
              style={{
                ...ghostSmall,
                color: rows && rows.length ? "var(--text-mid)" : "var(--text-faint)",
              }}
            >
              Download CSV
            </button>
            <div style={{ position: "relative" }}>
              <button
                type="button"
                disabled={!ranOk}
                title={ranOk ? "Adds the SQL that produced this result" : "Run the query first"}
                onClick={(e) => {
                  e.stopPropagation();
                  setAddOpen((v) => !v);
                }}
                style={{
                  ...ghostSmall,
                  color: ranOk ? "var(--text-mid)" : "var(--text-faint)",
                  cursor: ranOk ? "pointer" : "not-allowed",
                }}
              >
                Add to dashboard
              </button>
              {addOpen && ranOk && selected && (
                <AddToDashboard
                  key={selected.id}
                  sql={selected.sql}
                  catalog={selected.catalog}
                  defaultTitle={doc.name.replace(/\.sql$/, "")}
                  onClose={() => setAddOpen(false)}
                />
              )}
            </div>
          </div>

          <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: 18 }}>
            {selected?.error && (
              <div
                style={{
                  background: "var(--accent-tint)",
                  border: "1px solid var(--err)",
                  borderRadius: 12,
                  padding: "12px 14px",
                  color: "var(--err)",
                  fontSize: "var(--fs-body)",
                  whiteSpace: "pre-wrap",
                }}
                className="mono"
              >
                {selected.error}
              </div>
            )}
            {selected?.truncated && !selected.error && (
              <div style={{ fontSize: "var(--fs-meta)", color: "var(--warn)", marginBottom: 10 }}>
                Result truncated at 100,000 rows — refine the query.
              </div>
            )}
            {!selected?.error && rows && rows.length > 0 && <ResultGrid rows={rows} />}
            {selected && !selected.running && !selected.error && rows && rows.length === 0 && (
              <div style={{ fontSize: "var(--fs-body)", color: "var(--text-dim)" }}>
                The query returned no rows.
              </div>
            )}
          </div>
        </div>
      </div>
    </Workbench>
  );
}

/* ---- result tabs --------------------------------------------------------- */

/** Result tabs kept per script; the oldest drops off when a run exceeds this. */
const MAX_RESULTS = 10;

interface RunResult {
  id: string;
  /** "Result N" — per script, counting every run. */
  n: number;
  /** Wall-clock start, HH:MM:SS. */
  at: string;
  /** The SQL and catalog that produced this result (the editor may have moved on). */
  sql: string;
  catalog: string | null;
  rows: Row[] | null;
  error: string;
  running: boolean;
  truncated?: boolean;
  elapsed?: number;
}

function ResultTab({
  result: r,
  on,
  onSelect,
  onClose,
}: {
  result: RunResult;
  on: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  const meta = r.running
    ? "running…"
    : r.error
      ? "error"
      : `${(r.rows?.length ?? 0).toLocaleString()} row${r.rows?.length === 1 ? "" : "s"}${
          r.elapsed !== undefined ? ` · ${r.elapsed.toFixed(2)} s` : ""
        }`;
  return (
    <div
      role="tab"
      aria-selected={on}
      tabIndex={0}
      title={r.sql}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        flexShrink: 0,
        padding: "7px 10px 7px 14px",
        borderRight: "1px solid var(--border)",
        cursor: "pointer",
        whiteSpace: "nowrap",
        background: on ? "var(--surface)" : "transparent",
        boxShadow: on ? "inset 0 2px 0 var(--accent)" : "none",
      }}
    >
      <span style={{ display: "flex", flexDirection: "column", lineHeight: 1.25 }}>
        <span style={{ fontSize: "var(--fs-meta)", color: on ? "var(--text)" : "var(--text-muted)" }}>
          Result {r.n} · <span className="mono">{r.at}</span>
        </span>
        <span
          className="mono"
          style={{
            fontSize: "var(--fs-xs)",
            color: r.error ? "var(--err)" : r.running ? "var(--text-dim)" : "var(--text-faint)",
          }}
        >
          {meta}
        </span>
      </span>
      <button
        type="button"
        title={`Close result ${r.n}`}
        aria-label={`Close result ${r.n}`}
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        style={{
          width: 18,
          height: 18,
          border: "none",
          borderRadius: 5,
          background: "transparent",
          color: "var(--text-faint)",
          fontSize: "var(--fs-xs)",
          lineHeight: 1,
        }}
      >
        ✕
      </button>
    </div>
  );
}

/* ---- add to dashboard ---------------------------------------------------- */

type TileKind = "table" | "stat" | "bars" | "line" | "donut";
const TILE_KINDS: TileKind[] = ["table", "stat", "bars", "line", "donut"];
const NEW = "__new__"; // DOC_NAME can't start with "_", so no real dashboard collides

interface DashDoc {
  catalog: string | null;
  filters?: unknown[];
  tiles: { title: string; sql: string; kind: string }[];
}

/**
 * Inline popover: pick (or name) a dashboard, title and kind; the current SQL
 * is appended as a tile by read-modify-write of the whole document, so the
 * dashboard's filters and other tiles travel back untouched.
 */
function AddToDashboard({
  sql,
  catalog,
  defaultTitle,
  onClose,
}: {
  sql: string;
  catalog: string | null;
  defaultTitle: string;
  onClose: () => void;
}) {
  const [names, setNames] = useState<string[] | null>(null);
  const [target, setTarget] = useState("");
  const [fresh, setFresh] = useState("");
  const [title, setTitle] = useState(defaultTitle);
  const [kind, setKind] = useState<TileKind>("table");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [added, setAdded] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    api
      .get<string[]>("/dashboards")
      .then((list) => {
        if (!live) return;
        setNames(list);
        setTarget(list[0] ?? NEW);
      })
      .catch((e) => {
        if (!live) return;
        setNames([]);
        setTarget(NEW);
        setError(errorText(e));
      });
    return () => {
      live = false;
    };
  }, []);

  // Click anywhere outside closes; Escape too.
  useEffect(() => {
    const off = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) onClose();
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("click", off);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("click", off);
      document.removeEventListener("keydown", esc);
    };
  }, [onClose]);

  const confirm = async () => {
    const isNew = target === NEW;
    const dash = isNew ? fresh.trim() : target;
    if (isNew) {
      if (!DOC_NAME.test(dash)) {
        setError("Dashboard name: lower-case letters, digits, dash or underscore (max 64).");
        return;
      }
      if (names?.includes(dash)) {
        setError(`“${dash}” already exists — pick it from the list.`);
        return;
      }
    }
    if (!title.trim()) {
      setError("Give the widget a title.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const path = `/dashboards/${encodeURIComponent(dash)}`;
      if (isNew) await api.post("/dashboards", { name: dash });
      const d = await api.get<DashDoc>(path);
      await api.put(path, {
        ...d,
        catalog: d.catalog || catalog,
        tiles: [...(d.tiles ?? []), { title: title.trim().slice(0, 80), sql, kind }],
      });
      setAdded(dash);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      ref={box}
      style={{
        position: "absolute",
        right: 0,
        top: 24,
        zIndex: 40,
        width: 300,
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: 12,
        boxShadow: "0 8px 26px rgba(20,22,16,.22)",
        padding: 14,
        display: "flex",
        flexDirection: "column",
        gap: 10,
        color: "var(--text)",
      }}
    >
      {added ? (
        <>
          <FormMessage tone="ok">
            Added to {added} —{" "}
            <Link to={`/dashboards/${encodeURIComponent(added)}`} style={{ color: "var(--accent-ink)" }}>
              open
            </Link>
          </FormMessage>
          <div>
            <SmallButton onClick={onClose}>Close</SmallButton>
          </div>
        </>
      ) : (
        <>
          <div style={{ fontSize: "var(--fs-body)", fontWeight: 600 }}>Add this query to a dashboard</div>
          <label style={popLabel}>
            Dashboard
            <select
              value={target}
              disabled={names === null}
              onChange={(e) => setTarget(e.target.value)}
              style={{ ...selectStyle, width: "100%" }}
            >
              {names === null && <option value="">Loading…</option>}
              {(names ?? []).map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
              <option value={NEW}>+ New dashboard…</option>
            </select>
          </label>
          {target === NEW && (
            <label style={popLabel}>
              New dashboard name
              <input
                value={fresh}
                onChange={(e) => setFresh(e.target.value)}
                placeholder="claims-overview"
                className="mono"
                style={popInput}
              />
            </label>
          )}
          <label style={popLabel}>
            Widget title
            <input value={title} onChange={(e) => setTitle(e.target.value)} style={popInput} />
          </label>
          <label style={popLabel}>
            Kind
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value as TileKind)}
              style={{ ...selectStyle, width: "100%" }}
            >
              {TILE_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </label>
          {error && <FormMessage tone="err">{error}</FormMessage>}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <SmallButton onClick={onClose} disabled={busy}>
              Cancel
            </SmallButton>
            <SmallButton primary onClick={() => void confirm()} disabled={busy || names === null}>
              {busy ? "Adding…" : "Add"}
            </SmallButton>
          </div>
        </>
      )}
    </div>
  );
}

const popLabel: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  fontSize: "var(--fs-label)",
  color: "var(--text-faint)",
};

const popInput: CSSProperties = {
  height: 30,
  padding: "0 10px",
  borderRadius: 9,
  border: "1px solid var(--border)",
  background: "var(--surface-alt)",
  color: "var(--text)",
  fontSize: "var(--fs-body)",
  outline: "none",
};

/* ---- editor ------------------------------------------------------------ */

/*
 * A transparent <textarea> over a highlighted <pre>. Both share every metric
 * that affects wrapping (font, size, line-height, padding, wrap mode), and the
 * <pre> — not a min-height — establishes the block height, so the two can
 * never scroll out of sync and no §9 layout loop is possible.
 */
function Editor({
  value,
  onChange,
  onRun,
}: {
  value: string;
  onChange: (v: string) => void;
  onRun: () => void;
}) {
  const tokens = useMemo(() => highlight(value), [value]);
  return (
    <div
      style={{
        flex: "0 0 auto",
        maxHeight: "42vh",
        overflow: "auto",
        background: "var(--surface)",
      }}
    >
      <div style={{ position: "relative", minHeight: 150 }}>
        <pre aria-hidden="true" className="mono" style={{ ...code, margin: 0 }}>
          {tokens}
          {"\n"}
        </pre>
        <textarea
          value={value}
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              onRun();
            }
          }}
          aria-label="SQL query"
          className="mono"
          style={{
            ...code,
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            border: "none",
            outline: "none",
            resize: "none",
            overflow: "hidden",
            background: "transparent",
            color: "transparent",
            caretColor: "var(--accent)",
          }}
        />
      </div>
    </div>
  );
}

const code: CSSProperties = {
  display: "block",
  padding: "14px 18px",
  fontSize: "var(--fs-base)",
  lineHeight: "22px",
  whiteSpace: "pre-wrap",
  overflowWrap: "break-word",
  wordBreak: "break-word",
  tabSize: 2,
  color: "var(--text)",
};

const KEYWORDS = new Set(
  `select from where group by order having limit offset join inner left right full outer on as with union all
   distinct insert into values update set delete create table view schema catalog drop alter add column grant to
   and or not null is in like between case when then else end asc desc count sum avg min max cast at version
   snapshot describe show explain using primary key foreign references default exists`
    .split(/\s+/)
    .filter(Boolean),
);

/** Tiny SQL tokenizer — enough for colour, never for semantics. */
function highlight(src: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re =
    /(--[^\n]*|\/\*[\s\S]*?\*\/)|('(?:''|[^'])*'|"(?:[^"\n])*")|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][A-Za-z0-9_]*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(src)) !== null) {
    if (m.index > last) out.push(src.slice(last, m.index));
    const [text, comment, str, num, word] = m;
    if (comment) {
      out.push(
        <span key={key++} style={{ color: "var(--text-dim)", fontStyle: "italic" }}>
          {text}
        </span>,
      );
    } else if (str) {
      out.push(
        <span key={key++} style={{ color: "var(--code-str)" }}>
          {text}
        </span>,
      );
    } else if (num) {
      out.push(
        <span key={key++} style={{ color: "var(--code-num)" }}>
          {text}
        </span>,
      );
    } else if (word && KEYWORDS.has(word.toLowerCase())) {
      out.push(
        <span key={key++} style={{ color: "var(--accent-ink)", fontWeight: 500 }}>
          {text}
        </span>,
      );
    } else {
      out.push(text);
    }
    last = m.index + text.length;
  }
  if (last < src.length) out.push(src.slice(last));
  return out;
}

const ghost: CSSProperties = {
  background: "var(--surface)",
  color: "var(--text-mid)",
  border: "1px solid var(--border)",
  borderRadius: 11,
  fontSize: "var(--fs-body)",
  padding: "8px 14px",
};

const ghostSmall: CSSProperties = {
  background: "transparent",
  border: "none",
  fontFamily: "inherit",
  fontSize: "var(--fs-meta)",
  padding: 0,
};
