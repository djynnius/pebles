import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Link } from "react-router-dom";
import { api, errorText, type Row } from "../api";
import { useCatalogs, type TreeResponse } from "../catalogs";
import { Dialog, DialogActions } from "./Dialog";
import { FileIcon } from "./FileIcon";
import { FormMessage, SmallButton, selectStyle } from "./Form";

/*
 * "+ New → Table" and Catalog's "Upload table…": one wizard for turning a data
 * file into lake tables.
 *
 *   1. pick a file → POST /api/files/upload (dir=uploads) → POST /api/import/inspect
 *      (Excel cleaning runs on the user's engine session and can take a while)
 *   2. choose catalog + schema, then keep / name each detected table (one per
 *      sheet for Excel), with the cleaning notes and a preview
 *   3. POST /api/import/commit → created tables (linked into /catalog) and
 *      per-table errors, which can be sent back to step 2 to fix.
 */

/** Mirrors the server's identifier rule for tables and schemas. */
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Window event fired after an import created tables (Catalog re-reads its tree). */
export const TABLES_CHANGED = "pebbles:tables-changed";

export const IMPORT_ACCEPT = ".csv,.tsv,.txt,.parquet,.json,.ndjson,.jsonl,.xlsx";

interface InspectTable {
  key: string;
  name: string;
  rows: number;
  columns: { name: string; type: string }[];
  preview: Row[];
  cleaning: string[];
  empty: boolean;
}

interface InspectResult {
  path: string;
  kind: "excel" | "file";
  tables: InspectTable[];
}

interface CommitResult {
  created: { name: string; rows: number }[];
  errors: { key: string; error: string }[];
}

interface Draft extends InspectTable {
  keep: boolean;
  /** The editable table name. */
  target: string;
}

type Step =
  | { kind: "pick"; busy: "" | "Uploading…" | "Reading and cleaning…" }
  | { kind: "review"; file: string; path: string; excel: boolean }
  | { kind: "done"; file: string; path: string; excel: boolean; catalog: string; schema: string; result: CommitResult };

const seg = encodeURIComponent;
const NEW_SCHEMA = "\u0000new";

export function ImportTableDialog({
  catalog: initialCatalog,
  schema: initialSchema,
  onClose,
  onCreated,
}: {
  /** Preselected catalog + schema (Catalog's "Upload table…"). */
  catalog?: string;
  schema?: string;
  onClose: () => void;
  /** Fires after a commit created at least one table. */
  onCreated?: (catalog: string, schema: string, tables: string[]) => void;
}) {
  const { catalogs, error: catalogsError } = useCatalogs();
  const accessible = useMemo(
    () => (catalogs ?? []).filter((c) => c.accessible !== false).map((c) => c.name),
    [catalogs],
  );

  const [step, setStep] = useState<Step>({ kind: "pick", busy: "" });
  const [error, setError] = useState("");
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [dragging, setDragging] = useState(false);
  const picker = useRef<HTMLInputElement>(null);

  const [catalog, setCatalog] = useState(initialCatalog ?? "");
  const [schemas, setSchemas] = useState<string[] | null>(null);
  const [schemasError, setSchemasError] = useState("");
  const [schema, setSchema] = useState(initialSchema ?? "");
  const [newSchema, setNewSchema] = useState("");
  const [creatingSchema, setCreatingSchema] = useState(false);
  const [committing, setCommitting] = useState(false);

  // Default the catalog once the list lands.
  useEffect(() => {
    if (!catalog && accessible.length > 0) setCatalog(accessible[0]);
  }, [accessible, catalog]);

  // Schemas of the chosen catalog.
  useEffect(() => {
    if (!catalog) return;
    let live = true;
    setSchemas(null);
    setSchemasError("");
    api
      .get<TreeResponse>(`/catalogs/${seg(catalog)}/tree`)
      .then((t) => {
        if (!live) return;
        const names = (t.schemas ?? []).map((s) => s.name);
        setSchemas(names);
        setSchema((cur) => (cur && cur !== NEW_SCHEMA && names.includes(cur) ? cur : names.includes("main") ? "main" : (names[0] ?? NEW_SCHEMA)));
      })
      .catch((e) => {
        if (!live) return;
        setSchemas([]);
        setSchemasError(errorText(e));
      });
    return () => {
      live = false;
    };
  }, [catalog]);

  const busy = (step.kind === "pick" && step.busy !== "") || committing || creatingSchema;

  /* ---- step 1: upload + inspect ----------------------------------------- */

  const takeFile = async (file: File) => {
    setError("");
    try {
      setStep({ kind: "pick", busy: "Uploading…" });
      const body = new FormData();
      body.append("dir", "uploads");
      body.append("file", file);
      const up = await api.upload<{ uploaded?: string[] }>("/files/upload", body);
      const path = up.uploaded?.[0];
      if (!path) throw new Error("The upload finished but the server didn't say where the file went.");
      setStep({ kind: "pick", busy: "Reading and cleaning…" });
      const got = await api.post<InspectResult>("/import/inspect", { path });
      const tables = got.tables ?? [];
      if (tables.length === 0) throw new Error("No tables were found in that file.");
      setDrafts(tables.map((t) => ({ ...t, keep: !t.empty, target: t.name || "" })));
      setOpen(new Set(tables.length === 1 ? [tables[0].key] : []));
      setStep({ kind: "review", file: file.name, path: got.path || path, excel: got.kind === "excel" });
    } catch (e) {
      setError(errorText(e));
      setStep({ kind: "pick", busy: "" });
    }
  };

  /* ---- step 2: validation ------------------------------------------------ */

  const kept = drafts.filter((d) => d.keep);
  const problems = useMemo(() => {
    const out: Record<string, string> = {};
    const seen = new Map<string, string>();
    for (const d of drafts) {
      if (!d.keep) continue;
      const n = d.target.trim();
      if (!n) out[d.key] = "Name the table.";
      else if (!IDENT_RE.test(n)) out[d.key] = "Letters, digits and underscores; must not start with a digit.";
      else {
        const lower = n.toLowerCase();
        const other = seen.get(lower);
        if (other !== undefined) {
          out[d.key] = "Another table in this import has that name.";
          out[other] = out[other] ?? "Another table in this import has that name.";
        } else seen.set(lower, d.key);
      }
    }
    return out;
  }, [drafts]);

  const schemaReady = schema !== "" && schema !== NEW_SCHEMA;
  const canCommit =
    step.kind === "review" && !busy && catalog !== "" && schemaReady && kept.length > 0 && Object.keys(problems).length === 0;

  const patchDraft = (key: string, patch: Partial<Draft>) =>
    setDrafts((cur) => cur.map((d) => (d.key === key ? { ...d, ...patch } : d)));

  const addSchema = async () => {
    const n = newSchema.trim();
    if (!IDENT_RE.test(n) || !catalog) return;
    setCreatingSchema(true);
    setError("");
    try {
      await api.post(`/catalogs/${seg(catalog)}/schemas`, { name: n });
      setSchemas((cur) => [...(cur ?? []), n].sort());
      setSchema(n);
      setNewSchema("");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setCreatingSchema(false);
    }
  };

  /* ---- step 3: commit ---------------------------------------------------- */

  const commit = async () => {
    if (!canCommit || step.kind !== "review") return;
    setCommitting(true);
    setError("");
    try {
      const result = await api.post<CommitResult>("/import/commit", {
        path: step.path,
        catalog,
        schema,
        tables: kept.map((d) => ({ key: d.key, name: d.target.trim() })),
      });
      const created = result.created ?? [];
      const errors = result.errors ?? [];
      setStep({ ...step, kind: "done", catalog, schema, result: { created, errors } });
      if (created.length > 0) {
        window.dispatchEvent(new Event(TABLES_CHANGED));
        onCreated?.(catalog, schema, created.map((c) => c.name));
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setCommitting(false);
    }
  };

  /** Back to step 2 with only the failed tables kept, to rename and retry. */
  const retryFailed = () => {
    if (step.kind !== "done") return;
    const failed = new Set(step.result.errors.map((e) => e.key));
    setDrafts((cur) => cur.map((d) => ({ ...d, keep: failed.has(d.key) })));
    setStep({ kind: "review", file: step.file, path: step.path, excel: step.excel });
  };

  const reset = () => {
    setDrafts([]);
    setError("");
    setStep({ kind: "pick", busy: "" });
  };

  /* ---- render ------------------------------------------------------------ */

  const title =
    step.kind === "pick" ? "Import a table" : step.kind === "review" ? `Import ${step.file}` : "Import finished";

  return (
    <Dialog title={title} onClose={() => !busy && onClose()} width={step.kind === "pick" ? 520 : 780}>
      <StepDots at={step.kind === "pick" ? 0 : step.kind === "review" ? 1 : 2} />

      {step.kind === "pick" && (
        <div style={{ display: "grid", gap: 12 }}>
          <input
            ref={picker}
            type="file"
            hidden
            accept={IMPORT_ACCEPT}
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void takeFile(f);
            }}
          />
          <div
            role="button"
            tabIndex={0}
            aria-disabled={busy}
            onClick={() => !busy && picker.current?.click()}
            onKeyDown={(e) => {
              if ((e.key === "Enter" || e.key === " ") && !busy) {
                e.preventDefault();
                picker.current?.click();
              }
            }}
            onDragOver={(e) => {
              e.preventDefault();
              if (!busy) setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              const f = e.dataTransfer.files?.[0];
              if (f && !busy) void takeFile(f);
            }}
            style={{
              border: `1.5px dashed ${dragging ? "var(--accent)" : "var(--border-strong)"}`,
              borderRadius: 14,
              background: dragging ? "var(--accent-tint)" : "var(--surface-alt)",
              padding: "30px 20px",
              textAlign: "center",
              cursor: busy ? "default" : "pointer",
            }}
          >
            <div style={{ display: "flex", justifyContent: "center", marginBottom: 10 }}>
              <FileIcon kind="table" size={28} />
            </div>
            {step.busy ? (
              <>
                <div style={{ fontSize: "var(--fs-base)", fontWeight: 600 }} aria-live="polite">
                  {step.busy}
                </div>
                <div style={{ fontSize: "var(--fs-small)", color: "var(--text-dim)", marginTop: 6 }}>
                  {step.busy === "Uploading…"
                    ? "Saving the file to ~/uploads."
                    : "Finding the header, dropping title, blank and total rows — Excel files can take several seconds."}
                </div>
              </>
            ) : (
              <>
                <div style={{ fontSize: "var(--fs-base)", fontWeight: 600 }}>
                  Choose a data file, or drop one here
                </div>
                <div style={{ fontSize: "var(--fs-small)", color: "var(--text-dim)", marginTop: 6 }}>
                  CSV, TSV, TXT, Parquet, JSON, NDJSON or Excel (.xlsx). Each Excel sheet becomes its own table.
                </div>
              </>
            )}
          </div>
          <div style={{ fontSize: "var(--fs-small)", color: "var(--text-dim)" }}>
            The file is saved to <span className="mono">~/uploads</span> first, then read on your engine session.
          </div>
          {error && <FormMessage tone="err">{error}</FormMessage>}
          <DialogActions>
            <SmallButton onClick={onClose} disabled={busy}>
              Cancel
            </SmallButton>
            <SmallButton primary disabled={busy} onClick={() => picker.current?.click()}>
              {step.busy || "Choose file…"}
            </SmallButton>
          </DialogActions>
        </div>
      )}

      {step.kind === "review" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void commit();
          }}
          style={{ display: "grid", gap: 14 }}
        >
          {/* destination */}
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
            <label style={pickLabel}>
              Catalog
              <select
                value={catalog}
                onChange={(e) => setCatalog(e.target.value)}
                disabled={busy}
                className="mono"
                style={{ ...selectStyle, minWidth: 180 }}
              >
                {catalogs === null && !catalogsError && <option value="">Loading…</option>}
                {catalogs !== null && accessible.length === 0 && <option value="">No catalogs you can open</option>}
                {accessible.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
            <label style={pickLabel}>
              Schema
              <select
                value={schema}
                onChange={(e) => setSchema(e.target.value)}
                disabled={busy || schemas === null}
                className="mono"
                style={{ ...selectStyle, minWidth: 180 }}
              >
                {schemas === null && <option value="">Loading…</option>}
                {(schemas ?? []).map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
                {schemas !== null && <option value={NEW_SCHEMA}>+ New schema…</option>}
              </select>
            </label>
            {schema === NEW_SCHEMA && (
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <input
                  value={newSchema}
                  onChange={(e) => setNewSchema(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void addSchema();
                    }
                  }}
                  placeholder="staging"
                  aria-label="New schema name"
                  autoFocus
                  className="mono"
                  style={{
                    ...nameInput,
                    width: 160,
                    borderColor:
                      newSchema.trim() && !IDENT_RE.test(newSchema.trim()) ? "var(--err)" : "var(--border)",
                  }}
                />
                <SmallButton
                  onClick={() => void addSchema()}
                  disabled={creatingSchema || !IDENT_RE.test(newSchema.trim())}
                >
                  {creatingSchema ? "Creating…" : "Create schema"}
                </SmallButton>
              </div>
            )}
          </div>
          {catalogsError && <FormMessage tone="err">{catalogsError}</FormMessage>}
          {schemasError && <FormMessage tone="err">{schemasError}</FormMessage>}

          {/* tables */}
          <div style={{ fontSize: "var(--fs-small)", color: "var(--text-dim)" }}>
            {step.excel
              ? `${drafts.length} sheet${drafts.length === 1 ? "" : "s"} found — each kept sheet becomes a table in `
              : "Creates "}
            <span className="mono" style={{ color: "var(--text-mid)" }}>
              {catalog || "…"}.{schemaReady ? schema : "…"}
            </span>
            .
          </div>
          <div style={{ display: "grid", gap: 8 }}>
            {drafts.map((d) => (
              <DraftRow
                key={d.key || "_"}
                draft={d}
                problem={problems[d.key]}
                expanded={open.has(d.key)}
                disabled={busy}
                onToggle={() =>
                  setOpen((cur) => {
                    const next = new Set(cur);
                    if (next.has(d.key)) next.delete(d.key);
                    else next.add(d.key);
                    return next;
                  })
                }
                onPatch={(p) => patchDraft(d.key, p)}
              />
            ))}
          </div>

          {kept.length === 0 && <FormMessage tone="err">Keep at least one table.</FormMessage>}
          {error && <FormMessage tone="err">{error}</FormMessage>}

          <DialogActions>
            <SmallButton onClick={reset} disabled={busy}>
              ‹ Other file
            </SmallButton>
            <div style={{ flex: 1 }} />
            <SmallButton onClick={onClose} disabled={busy}>
              Cancel
            </SmallButton>
            <SmallButton type="submit" primary disabled={!canCommit}>
              {committing
                ? "Creating tables…"
                : `Create ${kept.length} table${kept.length === 1 ? "" : "s"}`}
            </SmallButton>
          </DialogActions>
        </form>
      )}

      {step.kind === "done" && (
        <div style={{ display: "grid", gap: 12 }}>
          {step.result.created.length > 0 && (
            <div>
              <div style={sectionLabel}>Created in {step.catalog}.{step.schema}</div>
              <div style={{ display: "grid", gap: 4 }}>
                {step.result.created.map((c) => (
                  <Link
                    key={c.name}
                    to={`/catalog?table=${encodeURIComponent(`${step.catalog}.${step.schema}.${c.name}`)}`}
                    onClick={onClose}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "7px 10px",
                      borderRadius: 9,
                      background: "var(--surface-alt)",
                      border: "1px solid var(--border-soft)",
                      textDecoration: "none",
                      color: "var(--text)",
                      fontSize: "var(--fs-body)",
                    }}
                  >
                    <span style={{ color: "var(--ok-ink)" }}>✓</span>
                    <span className="mono" style={{ flex: 1 }}>
                      {c.name}
                    </span>
                    <span style={{ color: "var(--text-dim)", fontSize: "var(--fs-small)" }}>
                      {Number(c.rows ?? 0).toLocaleString()} rows
                    </span>
                    <span style={{ color: "var(--accent-ink)", fontSize: "var(--fs-small)" }}>Open in Catalog ›</span>
                  </Link>
                ))}
              </div>
            </div>
          )}
          {step.result.errors.length > 0 && (
            <div>
              <div style={sectionLabel}>Not created</div>
              <div style={{ display: "grid", gap: 4 }}>
                {step.result.errors.map((e) => {
                  const d = drafts.find((x) => x.key === e.key);
                  return (
                    <div
                      key={e.key || "_"}
                      style={{
                        padding: "7px 10px",
                        borderRadius: 9,
                        border: "1px solid var(--err)",
                        background: "var(--accent-tint)",
                        fontSize: "var(--fs-body)",
                      }}
                    >
                      <span className="mono" style={{ fontWeight: 600 }}>
                        {d?.target || e.key || "table"}
                      </span>
                      {step.excel && e.key && (
                        <span style={{ color: "var(--text-dim)", fontSize: "var(--fs-small)" }}> (sheet {e.key})</span>
                      )}
                      <div className="mono" style={{ color: "var(--err)", fontSize: "var(--fs-meta)", marginTop: 3 }}>
                        {e.error}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          {step.result.created.length === 0 && step.result.errors.length === 0 && (
            <div style={{ fontSize: "var(--fs-body)", color: "var(--text-dim)" }}>Nothing was created.</div>
          )}
          <DialogActions>
            {step.result.errors.length > 0 && (
              <SmallButton onClick={retryFailed}>‹ Fix and retry failed</SmallButton>
            )}
            <SmallButton onClick={reset}>Import another file</SmallButton>
            <SmallButton primary onClick={onClose}>
              Done
            </SmallButton>
          </DialogActions>
        </div>
      )}
    </Dialog>
  );
}

/* ---- pieces -------------------------------------------------------------- */

function StepDots({ at }: { at: number }) {
  const steps = ["File", "Tables", "Done"];
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
      {steps.map((s, i) => (
        <span
          key={s}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontSize: "var(--fs-label)",
            color: i === at ? "var(--text)" : "var(--text-faint)",
            fontWeight: i === at ? 600 : 400,
          }}
        >
          <span
            style={{
              width: 18,
              height: 18,
              borderRadius: "50%",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: "var(--fs-2xs)",
              background: i <= at ? "var(--accent)" : "var(--track)",
              color: i <= at ? "var(--on-accent)" : "var(--text-dim)",
            }}
          >
            {i < at ? "✓" : i + 1}
          </span>
          {s}
          {i < steps.length - 1 && <span style={{ color: "var(--text-faint)" }}>—</span>}
        </span>
      ))}
    </div>
  );
}

function DraftRow({
  draft: d,
  problem,
  expanded,
  disabled,
  onToggle,
  onPatch,
}: {
  draft: Draft;
  problem?: string;
  expanded: boolean;
  disabled: boolean;
  onToggle: () => void;
  onPatch: (p: Partial<Draft>) => void;
}) {
  const cols = d.columns.map((c) => c.name);
  return (
    <div
      style={{
        border: `1px solid ${problem ? "var(--err)" : "var(--border)"}`,
        borderRadius: 12,
        background: d.keep ? "var(--surface)" : "var(--surface-alt)",
        overflow: "hidden",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", flexWrap: "wrap" }}>
        <input
          type="checkbox"
          checked={d.keep}
          disabled={disabled}
          onChange={(e) => onPatch({ keep: e.target.checked })}
          aria-label={`Keep ${d.key || d.name}`}
          style={{ accentColor: "var(--accent)" }}
        />
        {d.key && (
          <span
            title="Sheet"
            style={{
              fontSize: "var(--fs-small)",
              color: "var(--text-muted)",
              maxWidth: 160,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {d.key}
          </span>
        )}
        <span style={{ color: "var(--text-faint)" }}>→</span>
        <input
          value={d.target}
          disabled={disabled || !d.keep}
          onChange={(e) => onPatch({ target: e.target.value })}
          aria-label={`Table name for ${d.key || "the file"}`}
          className="mono"
          style={{
            ...nameInput,
            flex: "1 1 180px",
            minWidth: 140,
            opacity: d.keep ? 1 : 0.6,
            borderColor: problem ? "var(--err)" : "var(--border)",
          }}
        />
        <span className="mono" style={{ fontSize: "var(--fs-small)", color: "var(--text-dim)", whiteSpace: "nowrap" }}>
          {d.empty ? "no data" : `${d.rows.toLocaleString()} rows · ${d.columns.length} cols`}
        </span>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          disabled={d.empty && d.preview.length === 0}
          style={{
            border: "none",
            background: "transparent",
            fontFamily: "inherit",
            fontSize: "var(--fs-small)",
            color: "var(--accent-ink)",
            padding: 0,
            opacity: d.empty && d.preview.length === 0 ? 0.4 : 1,
          }}
        >
          {expanded ? "Hide preview ▴" : "Preview ▾"}
        </button>
      </div>
      {problem && d.keep && (
        <div style={{ padding: "0 12px 8px 38px", fontSize: "var(--fs-small)", color: "var(--err)" }}>{problem}</div>
      )}
      {d.cleaning.length > 0 && (
        <div
          style={{
            padding: "0 12px 9px 38px",
            display: "flex",
            flexWrap: "wrap",
            gap: 6,
          }}
        >
          {d.cleaning.map((c, i) => (
            <span
              key={i}
              style={{
                fontSize: "var(--fs-xs)",
                color: "var(--text-muted)",
                background: "var(--track)",
                borderRadius: 6,
                padding: "2px 7px",
              }}
            >
              {c}
            </span>
          ))}
        </div>
      )}
      {expanded && (
        <div style={{ borderTop: "1px solid var(--border-soft)", overflowX: "auto", maxHeight: 220 }}>
          {d.preview.length === 0 ? (
            <div style={{ padding: "10px 12px", fontSize: "var(--fs-small)", color: "var(--text-dim)" }}>
              No rows to preview.
            </div>
          ) : (
            <table style={{ borderCollapse: "collapse", minWidth: "100%" }}>
              <thead>
                <tr>
                  {cols.map((c, i) => (
                    <th key={c} style={previewTh}>
                      {c}
                      <div style={{ fontWeight: 400, color: "var(--viz-5)", textTransform: "none" }}>
                        {d.columns[i]?.type}
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {d.preview.map((r, i) => (
                  <tr key={i}>
                    {cols.map((c) => (
                      <td key={c} className="mono" style={previewTd}>
                        {r[c] === null || r[c] === undefined ? (
                          <span style={{ color: "var(--text-faint)" }}>∅</span>
                        ) : (
                          String(r[c])
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

const pickLabel: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 5,
  fontSize: "var(--fs-label)",
  letterSpacing: "0.6px",
  textTransform: "uppercase",
  color: "var(--text-faint)",
};

const sectionLabel: CSSProperties = {
  fontSize: "var(--fs-label)",
  letterSpacing: "0.6px",
  textTransform: "uppercase",
  color: "var(--text-faint)",
  marginBottom: 6,
};

const nameInput: CSSProperties = {
  height: 30,
  padding: "0 10px",
  borderRadius: 9,
  border: "1px solid var(--border)",
  background: "var(--surface-alt)",
  color: "var(--text)",
  fontSize: "var(--fs-body)",
  outline: "none",
};

const previewTh: CSSProperties = {
  textAlign: "left",
  position: "sticky",
  top: 0,
  background: "var(--surface-alt)",
  borderBottom: "1px solid var(--border)",
  fontSize: "var(--fs-xs)",
  fontWeight: 600,
  color: "var(--text-muted)",
  padding: "6px 10px",
  whiteSpace: "nowrap",
};

const previewTd: CSSProperties = {
  borderBottom: "1px solid var(--border-soft)",
  fontSize: "var(--fs-small)",
  padding: "5px 10px",
  whiteSpace: "nowrap",
  maxWidth: 240,
  overflow: "hidden",
  textOverflow: "ellipsis",
};
