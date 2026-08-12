import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useSearchParams } from "react-router-dom";
import { sse, type Row, type SqlResult } from "../api";
import { qualify, useCatalogs } from "../catalogs";
import { CatalogTree } from "../components/CatalogTree";
import { Workbench } from "../components/Workbench";
import { ResultGrid, cell } from "./Catalog";

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
  const { catalogs } = useCatalogs();
  // One read of storage seeds both pieces of state — two `loadDocs()` calls
  // would mint different ids for a first-run document and desync the tab strip.
  const seed = useRef<SqlDoc[]>(null as unknown as SqlDoc[]);
  if (seed.current === null) seed.current = loadDocs();
  const [docs, setDocs] = useState<SqlDoc[]>(seed.current);
  const [activeId, setActiveId] = useState<string>(seed.current[0].id);
  const [dirty, setDirty] = useState<Record<string, boolean>>({});

  const [running, setRunning] = useState(false);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState("");
  const [elapsed, setElapsed] = useState<number | null>(null);
  const cancel = useRef<(() => void) | null>(null);

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
  useEffect(() => {
    const q = params.get("q");
    if (q === null) return;
    const cur = docsRef.current;
    const fresh: SqlDoc = {
      ...blank(cur.length + 1),
      sql: q.endsWith("\n") ? q : `${q}\n`,
      catalog: params.get("catalog"),
    };
    commit([...cur, fresh], fresh.id);
    setParams({}, { replace: true });
  }, [params, setParams, commit]);

  useEffect(() => () => cancel.current?.(), []);

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
    const next = docs.filter((d) => d.id !== id);
    const kept = next.length > 0 ? next : [blank(1)];
    commit(kept, id === activeId ? kept[0].id : undefined);
  };

  const run = () => {
    cancel.current?.();
    setRunning(true);
    setRows(null);
    setError("");
    setElapsed(null);
    const started = performance.now();
    const query = `q=${encodeURIComponent(doc.sql)}${
      doc.catalog ? `&catalog=${encodeURIComponent(doc.catalog)}` : ""
    }`;
    cancel.current = sse(`/sql/stream?${query}`, {
      result: (r: SqlResult) => setRows(r.rows ?? []),
      error: (m) => setError(m),
      done: () => {
        setElapsed((performance.now() - started) / 1000);
        setRunning(false);
        cancel.current = null;
      },
    });
  };

  const downloadCsv = () => {
    if (!rows || rows.length === 0) return;
    const cols = Array.from(new Set(rows.flatMap((r) => Object.keys(r))));
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
    a.download = doc.name.replace(/\.sql$/, "") + ".csv";
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
          <>
            <div style={{ padding: "8px 12px", fontSize: 11, color: "var(--text-dim)" }}>
              Click a table to insert its name
            </div>
            {catalogs && catalogs.length > 0 ? (
              <CatalogTree
                catalogs={catalogs}
                onPick={(r) => insert(qualify(r.catalog, r.schema, r.table))}
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
          <span className="mono" style={{ fontSize: 13, fontWeight: 600 }}>
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
              fontSize: 12.5,
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
          <div
            style={{
              flex: "0 0 auto",
              display: "flex",
              alignItems: "center",
              gap: 14,
              flexWrap: "wrap",
              padding: "9px 18px",
              borderBottom: "1px solid var(--border)",
              fontSize: 12,
              color: "var(--text-muted)",
            }}
          >
            {running && <span>Running on your engine session…</span>}
            {!running && rows && (
              <span style={{ color: "var(--ok-ink)", fontWeight: 600 }}>
                ✓ {rows.length.toLocaleString()} row{rows.length === 1 ? "" : "s"}
              </span>
            )}
            {!running && !rows && !error && <span>Results appear here after a run.</span>}
            {elapsed !== null && !running && <span>{elapsed.toFixed(2)} s</span>}
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
            <button
              type="button"
              disabled
              title="arrives with dashboards"
              style={{ ...ghostSmall, color: "var(--text-faint)", cursor: "not-allowed" }}
            >
              Add to dashboard
            </button>
          </div>

          <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: 18 }}>
            {error && (
              <div
                style={{
                  background: "var(--accent-tint)",
                  border: "1px solid var(--err)",
                  borderRadius: 12,
                  padding: "12px 14px",
                  color: "var(--err)",
                  fontSize: 12.5,
                }}
                className="mono"
              >
                {error}
              </div>
            )}
            {!error && rows && rows.length > 0 && <ResultGrid rows={rows} />}
            {!error && rows && rows.length === 0 && (
              <div style={{ fontSize: 12.5, color: "var(--text-dim)" }}>
                The query returned no rows.
              </div>
            )}
          </div>
        </div>
      </div>
    </Workbench>
  );
}

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
  fontSize: 13,
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
  fontSize: 12.5,
  padding: "8px 14px",
};

const ghostSmall: CSSProperties = {
  background: "transparent",
  border: "none",
  fontFamily: "inherit",
  fontSize: 12,
  padding: 0,
};
