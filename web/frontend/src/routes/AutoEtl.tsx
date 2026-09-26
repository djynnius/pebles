import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { api, errorText } from "../api";
import { useCatalogs, type TreeResponse } from "../catalogs";
import { Table, Td } from "../components/Table";
import { ErrorBlock } from "../components/State";

/*
 * /autoetl — Auto ETL (spec §5 "autoetl", REQ-46).
 *
 * One page, three phases stacked: pick a source → review what profiling found →
 * approve. The order is the promise: profiling is read-only (a SUMMARIZE run in
 * the user's own session) and *nothing loads until the approve button*. Every
 * proposed cleaning step is a real checkbox the user can overrule, and the
 * low-confidence ones arrive unticked with their confidence on show.
 */

// ---- wire shapes (web/pebbles_web/api.py + autoetl.py) ---------------------

type Source = { kind: "file"; path: string } | { kind: "table"; name: string };

interface ProfileColumn {
  column_name: string;
  column_type: string;
  min?: string | null;
  max?: string | null;
  approx_unique?: number | string | null;
  avg?: string | null;
  std?: string | null;
  null_percentage?: number | string | null;
}

interface Step {
  id: string;
  kind: "rename" | "cast" | "drop_column" | "drop_null_rows" | "dedupe";
  column?: string;
  to?: string;
  to_type?: string;
  description: string;
  confidence: number;
  ticked: boolean;
}

interface Dim {
  column: string;
  table: string;
}

interface Model {
  kind: "star" | "table";
  fact: string;
  staging: string;
  measures: string[];
  dims: Dim[];
  keeps: string[];
}

interface Proposal {
  name: string;
  cleaning: Step[];
  model: Model;
}

interface ProfileResult {
  source: Source;
  row_count: number | null;
  columns: ProfileColumn[];
  proposal: Proposal;
}

interface FileItem {
  name: string;
  dir: boolean;
  size: number;
  mtime: number;
}

/** Exactly autoetl.py's reader map — anything else has no FROM expression. */
const READABLE = ["csv", "tsv", "txt", "parquet", "json", "ndjson", "jsonl"];
/** Must satisfy both DOC_NAME (workflow) and IDENT (generated table names). */
const PLAN_NAME = /^[a-z][a-z0-9_]{0,63}$/;

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export function AutoEtl() {
  const nav = useNavigate();
  const { catalogs, error: catalogError } = useCatalogs();

  // ---- phase 1: source ----------------------------------------------------
  const [mode, setMode] = useState<"file" | "table">("file");
  const [catalog, setCatalog] = useState("");
  const [dir, setDir] = useState("");
  const [items, setItems] = useState<FileItem[] | null>(null);
  const [file, setFile] = useState("");
  const [filesError, setFilesError] = useState("");
  const [tree, setTree] = useState<TreeResponse | null>(null);
  const [treeError, setTreeError] = useState("");
  const [table, setTable] = useState("");
  const [profiling, setProfiling] = useState(false);

  // ---- phase 2/3: the proposal, as the user has edited it ------------------
  const [profile, setProfile] = useState<ProfileResult | null>(null);
  const [ticked, setTicked] = useState<Record<string, boolean>>({});
  const [name, setName] = useState("");
  const [schedule, setSchedule] = useState("");
  const [repos, setRepos] = useState<string[]>([]);
  const [repo, setRepo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (mode !== "file") return;
    setItems(null);
    setFilesError("");
    api
      .get<{ path: string; items: FileItem[] }>(`/files?path=${encodeURIComponent(dir)}`)
      .then((r) => setItems(r.items))
      // Both pickers used to swallow their failure and claim the folder or the
      // catalog was empty; say what actually happened instead.
      .catch((e) => setFilesError(errorText(e)));
  }, [mode, dir]);

  useEffect(() => {
    setTree(null);
    setTreeError("");
    if (mode !== "table" || !catalog) return;
    api
      .get<TreeResponse>(`/catalogs/${encodeURIComponent(catalog)}/tree`)
      .then(setTree)
      .catch((e) => setTreeError(errorText(e)));
  }, [mode, catalog]);

  useEffect(() => {
    api
      .get<string[]>("/repos")
      .then(setRepos)
      .catch(() => setRepos([]));
  }, []);

  // Default the catalog to the only one there is — a one-item select is noise.
  useEffect(() => {
    if (!catalog && catalogs && catalogs.length === 1) setCatalog(catalogs[0].name);
  }, [catalogs, catalog]);

  const source: Source | null = useMemo(() => {
    if (mode === "file") return file ? { kind: "file", path: file } : null;
    return table ? { kind: "table", name: table } : null;
  }, [mode, file, table]);

  const sourceLabel = mode === "file" ? file : table;

  /** Re-profiling throws away phases 2 and 3 — the old plan described old data. */
  const reset = () => {
    setProfile(null);
    setTicked({});
    setError("");
  };

  const runProfile = () => {
    if (!source || !catalog || profiling) return;
    reset();
    setProfiling(true);
    api
      .post<ProfileResult>("/autoetl/profile", { source, catalog })
      .then((r) => {
        setProfile(r);
        const marks: Record<string, boolean> = {};
        for (const s of r.proposal.cleaning) marks[s.id] = s.ticked;
        setTicked(marks);
        setName(r.proposal.name);
      })
      .catch((e) => setError(errorText(e)))
      .finally(() => setProfiling(false));
  };

  // Memoised: the `?? []` mints a new array each render, which made the
  // effectiveModel memo below recompute every time (react-hooks warning).
  const steps = useMemo(() => profile?.proposal.cleaning ?? [], [profile]);
  const approved = steps.filter((s) => ticked[s.id]);
  const model = profile?.proposal.model;

  /*
   * The model carries FINAL column names. If the user un-ticks a rename those
   * names never come to exist, so map them back before approving — the plan the
   * user sees is the plan that gets built.
   */
  const effectiveModel = useMemo((): Model | null => {
    if (!model) return null;
    const undone = new Map<string, string>();
    for (const s of steps) {
      if (s.kind === "rename" && !ticked[s.id] && s.to && s.column) undone.set(s.to, s.column);
    }
    if (undone.size === 0) return model;
    const back = (c: string) => undone.get(c) ?? c;
    return {
      ...model,
      measures: model.measures.map(back),
      keeps: model.keeps.map(back),
      dims: model.dims.map((d) => {
        const col = back(d.column);
        return { column: col, table: col === d.column ? d.table : `dim_${col}` };
      }),
    };
  }, [model, steps, ticked]);

  const nameOk = PLAN_NAME.test(name);

  const approve = (run: boolean) => {
    if (!profile || !effectiveModel || busy) return;
    if (!nameOk) {
      setError("Plan names start with a lower-case letter, then letters, digits or underscores.");
      return;
    }
    setBusy(true);
    setError("");
    api
      .post("/autoetl/approve", {
        name,
        catalog,
        source: profile.source,
        steps: approved,
        model: effectiveModel,
        schedule: schedule.trim() || null,
        run,
        repo: repo || undefined,
      })
      .then(() => nav("/jobs"))
      .catch((e) => {
        setError(errorText(e));
        setBusy(false);
      });
  };

  const canProfile = Boolean(source && catalog) && !profiling;

  return (
    <div style={{ maxWidth: 1080, margin: "0 auto", padding: "34px 40px 60px" }}>
      <div className="mono" style={{ fontSize: "var(--fs-small)", color: "var(--text-dim)", marginBottom: 8 }}>
        <button type="button" onClick={() => nav("/ingest")} style={crumbBtn}>
          ‹ Data Ingestion
        </button>
      </div>
      <h1 style={{ fontSize: "var(--fs-h2-plus)", fontWeight: 600, letterSpacing: "-0.5px", marginBottom: 6 }}>
        Auto ETL
      </h1>
      <p style={{ fontSize: "var(--fs-body)", color: "var(--text-dim)", marginBottom: 22, maxWidth: 640 }}>
        Point it at a raw file or table. It reads the shape of the data, proposes the cleaning and a
        star schema, and waits — nothing is written until you approve the plan.
      </p>

      {/* ---- phase 1 · source --------------------------------------------- */}
      <Phase n={1} title="Source" done={Boolean(profile)}>
        <div style={{ display: "flex", gap: 6, marginBottom: 18 }}>
          <Seg on={mode === "file"} onClick={() => { setMode("file"); reset(); }}>
            File
          </Seg>
          <Seg on={mode === "table"} onClick={() => { setMode("table"); reset(); }}>
            Table
          </Seg>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(0, 1.4fr) minmax(0, 1fr)",
            gap: 20,
            alignItems: "start",
          }}
        >
          <div>
            <Label>{mode === "file" ? "Pick a file" : "Pick a table"}</Label>
            {mode === "file" ? (
              <FileBrowser
                dir={dir}
                items={items}
                error={filesError}
                selected={file}
                onDir={(d) => {
                  setDir(d);
                  setFile("");
                  reset();
                }}
                onPick={(p) => {
                  setFile(p);
                  reset();
                }}
              />
            ) : (
              <TablePicker
                catalog={catalog}
                tree={tree}
                error={treeError}
                selected={table}
                onPick={(t) => {
                  setTable(t);
                  reset();
                }}
              />
            )}
          </div>

          <div style={{ display: "grid", gap: 16 }}>
            <div>
              <Label>Target catalog</Label>
              {catalogError && (
                <div style={{ fontSize: "var(--fs-small)", color: "var(--err)", marginBottom: 6 }}>
                  {catalogError}
                </div>
              )}
              <select
                value={catalog}
                onChange={(e) => {
                  setCatalog(e.target.value);
                  reset();
                }}
                style={input}
              >
                <option value="">Choose a catalog…</option>
                {(catalogs ?? []).map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.name}
                  </option>
                ))}
              </select>
              <Hint>The cleaned tables land here. Everything is DuckLake · Parquet.</Hint>
            </div>

            <div>
              <Label>Selected</Label>
              <div
                className="mono"
                style={{
                  padding: "10px 12px",
                  border: "1px solid var(--border)",
                  borderRadius: 11,
                  background: "var(--surface-alt)",
                  color: sourceLabel ? "var(--text-mid)" : "var(--text-dim)",
                  fontSize: "var(--fs-body)",
                  overflowWrap: "break-word",
                }}
              >
                {sourceLabel || "nothing selected"}
              </div>
            </div>

            <div>
              <button
                type="button"
                onClick={runProfile}
                disabled={!canProfile}
                style={{
                  background: canProfile ? "var(--accent)" : "var(--track)",
                  color: canProfile ? "var(--on-accent)" : "var(--text-dim)",
                  border: "none",
                  borderRadius: 11,
                  fontWeight: 600,
                  fontSize: "var(--fs-base)",
                  padding: "9px 18px",
                  cursor: canProfile ? "pointer" : "not-allowed",
                }}
              >
                {profiling ? "Profiling…" : "Profile dataset"}
              </button>
              <Hint>Profiling runs read-only as you — nothing is loaded yet.</Hint>
            </div>
          </div>
        </div>
      </Phase>

      {error && !profile && <ErrorBlock error={error} style={{ marginTop: 14, marginBottom: 0 }} />}

      {/* ---- phase 2 · review --------------------------------------------- */}
      {profile && model && (
        <>
          <Phase n={2} title="Review">
            {/* stats strip */}
            <div style={{ display: "flex", flexWrap: "wrap", gap: 26, marginBottom: 20 }}>
              <Stat label="Rows" value={profile.row_count?.toLocaleString() ?? "unknown"} />
              <Stat label="Columns" value={String(profile.columns.length)} />
              <Stat label="Source" value={sourceLabel} mono />
            </div>

            <Label>Profile</Label>
            <Table head={["Column", "Type", "Distinct", "Nulls %", "Min", "Max"]}>
              {profile.columns.map((c) => {
                const nulls = num(c.null_percentage);
                const uniq = num(c.approx_unique);
                return (
                  <tr key={c.column_name}>
                    <Td mono>{c.column_name}</Td>
                    <Td mono>
                      <span style={{ color: "var(--text-dim)" }}>{c.column_type}</span>
                    </Td>
                    <Td mono>{uniq === null ? "—" : uniq.toLocaleString()}</Td>
                    <Td mono>
                      <span style={{ color: nulls !== null && nulls > 50 ? "var(--err)" : undefined }}>
                        {nulls === null ? "—" : `${nulls.toFixed(1)}%`}
                      </span>
                    </Td>
                    <Td mono>
                      <Clip>{c.min}</Clip>
                    </Td>
                    <Td mono>
                      <Clip>{c.max}</Clip>
                    </Td>
                  </tr>
                );
              })}
            </Table>

            {/* ---- cleaning checklist ------------------------------------- */}
            <div style={{ ...card, marginTop: 20 }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 4 }}>
                <Label>Cleaning</Label>
                <div style={{ flex: 1 }} />
                <span style={{ fontSize: "var(--fs-small)", color: "var(--text-dim)" }}>
                  {approved.length} of {steps.length} selected
                </span>
              </div>
              <p style={{ fontSize: "var(--fs-small)", color: "var(--text-dim)", marginBottom: 14 }}>
                Confident steps arrive ticked. Anything below 80% arrives un-ticked with its
                confidence shown — tick it only if you agree.
              </p>
              <div style={{ display: "grid", gap: 2 }}>
                {steps.map((s) => {
                  const on = Boolean(ticked[s.id]);
                  const pct = Math.round(s.confidence * 100);
                  const sure = s.confidence >= 0.8;
                  return (
                    <label
                      key={s.id}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 11,
                        padding: "9px 10px",
                        borderRadius: 10,
                        cursor: "pointer",
                        background: on ? "var(--surface-alt)" : "transparent",
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() => setTicked((t) => ({ ...t, [s.id]: !t[s.id] }))}
                        style={{ accentColor: "var(--accent)", width: 15, height: 15, flexShrink: 0 }}
                      />
                      <span
                        style={{
                          fontSize: "var(--fs-base)",
                          color: on ? "var(--text)" : "var(--text-dim)",
                          flex: 1,
                        }}
                      >
                        {s.description}
                      </span>
                      <span className="mono" style={kindPill}>
                        {s.kind}
                      </span>
                      <span
                        className="mono"
                        style={{
                          fontSize: "var(--fs-label)",
                          fontWeight: 500,
                          padding: "2px 8px",
                          borderRadius: 20,
                          minWidth: 44,
                          textAlign: "center",
                          background: sure ? "var(--ok-tint)" : "var(--warn-tint)",
                          color: sure ? "var(--ok-ink)" : "var(--warn)",
                        }}
                        title={sure ? "High confidence" : "Low confidence — ticked by you, not by us"}
                      >
                        {pct}%
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>

            {/* ---- model --------------------------------------------------- */}
            <div style={{ ...card, marginTop: 20 }}>
              <Label>Model</Label>
              <p style={{ fontSize: "var(--fs-small)", color: "var(--text-dim)", margin: "4px 0 16px" }}>
                {model.kind === "star" ? (
                  <>
                    A star schema: one fact table joined to{" "}
                    {model.dims.length === 1 ? "one dimension" : `${model.dims.length} dimensions`},
                    staged through <span className="mono">{model.staging}</span>.
                  </>
                ) : (
                  <>No dimension candidates — loading a single cleaned table.</>
                )}
              </p>
              <StarDiagram model={model} />
            </div>

            {/* ---- plan settings ------------------------------------------- */}
            <div
              style={{
                ...card,
                marginTop: 20,
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))",
                gap: 18,
              }}
            >
              <div>
                <Label>Plan name</Label>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="mono"
                  style={{
                    ...input,
                    borderColor: name && !nameOk ? "var(--err)" : "var(--border)",
                  }}
                />
                <Hint>The saved workflow's name. Lower-case letter first, then letters, digits or underscores.</Hint>
              </div>
              <div>
                <Label>Schedule</Label>
                <input
                  value={schedule}
                  onChange={(e) => setSchedule(e.target.value)}
                  placeholder="0 1 * * *"
                  className="mono"
                  style={input}
                />
                <Hint>Cron, five fields. Leave empty to run it by hand.</Hint>
              </div>
              <div>
                <Label>Commit plan to repo</Label>
                <select value={repo} onChange={(e) => setRepo(e.target.value)} style={input}>
                  <option value="">don't commit</option>
                  {repos.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
                <Hint>Writes the generated SQL to <span className="mono">autoetl/{name || "<name>"}.sql</span> and commits as you.</Hint>
              </div>
            </div>
          </Phase>

          {/* ---- phase 3 · approve ---------------------------------------- */}
          <Phase n={3} title="Approve" last>
            {error && <ErrorBlock error={error} />}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                flexWrap: "wrap",
                gap: 14,
                position: "sticky",
                bottom: 0,
              }}
            >
              <div style={{ flex: 1, minWidth: 260 }}>
                <div style={{ fontSize: "var(--fs-base)", color: "var(--text-mid)" }}>
                  {approved.length} cleaning step{approved.length === 1 ? "" : "s"} ·{" "}
                  {model.kind === "star"
                    ? `${model.dims.length} dimension${model.dims.length === 1 ? "" : "s"}`
                    : "no dimensions"}{" "}
                  · loads into <span className="mono">{catalog}</span>
                </div>
                <div style={{ fontSize: "var(--fs-small)", color: "var(--text-dim)", marginTop: 5 }}>
                  Approving saves the plan as a job. Nothing has run yet.
                </div>
              </div>
              <button type="button" onClick={() => approve(false)} disabled={busy} style={ghost}>
                Save without running
              </button>
              <button
                type="button"
                onClick={() => approve(true)}
                disabled={busy}
                style={{
                  background: busy ? "var(--track)" : "var(--accent)",
                  color: busy ? "var(--text-dim)" : "var(--on-accent)",
                  border: "none",
                  borderRadius: 11,
                  fontWeight: 600,
                  fontSize: "var(--fs-base)",
                  padding: "9px 20px",
                  cursor: busy ? "not-allowed" : "pointer",
                }}
              >
                {busy ? "Approving…" : "Approve & run"}
              </button>
            </div>
          </Phase>
        </>
      )}
    </div>
  );
}

// ---- star schema ----------------------------------------------------------

/**
 * FACT in --accent, DIM in --accent-deep (spec §5 "autoetl"). Laid out as
 * boxes with a plain rule between them rather than SVG edges — the join is
 * already spelled out by the FK rows inside the fact box.
 */
function StarDiagram({ model }: { model: Model }) {
  if (model.kind !== "star" || model.dims.length === 0) {
    return (
      <div style={{ maxWidth: 300 }}>
        <Box tone="accent" kind="TABLE" name={model.fact}>
          {[...model.measures, ...model.keeps].map((c) => (
            <Col key={c} name={c} />
          ))}
        </Box>
      </div>
    );
  }
  return (
    <div style={{ display: "flex", alignItems: "stretch", gap: 0 }}>
      <div style={{ width: 268, flexShrink: 0 }}>
        <Box tone="accent" kind="FACT" name={model.fact}>
          {model.measures.map((c) => (
            <Col key={c} name={c} note="measure" />
          ))}
          {model.keeps.map((c) => (
            <Col key={c} name={c} />
          ))}
          {model.dims.map((d) => (
            <Col key={d.table} name={`${d.column}_id`} note="fk" fk />
          ))}
        </Box>
      </div>
      <div style={{ width: 30, display: "flex", alignItems: "center", flexShrink: 0 }}>
        <div style={{ height: 1, width: "100%", background: "var(--border)" }} />
      </div>
      <div
        style={{
          flex: 1,
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))",
          gap: 12,
          alignContent: "start",
        }}
      >
        {model.dims.map((d) => (
          <Box key={d.table} tone="deep" kind="DIM" name={d.table}>
            <Col name={`${d.column}_id`} note="pk" fk />
            <Col name={d.column} />
          </Box>
        ))}
      </div>
    </div>
  );
}

function Box({
  tone,
  kind,
  name,
  children,
}: {
  tone: "accent" | "deep";
  kind: string;
  name: string;
  children: ReactNode;
}) {
  const color = tone === "accent" ? "var(--accent)" : "var(--accent-deep)";
  return (
    <div
      style={{
        border: `1px solid ${color}`,
        borderRadius: 12,
        overflow: "hidden",
        background: tone === "accent" ? "var(--accent-tint-2)" : "var(--surface-alt)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "9px 12px",
          borderBottom: `1px solid ${color}`,
        }}
      >
        <span
          className="mono"
          style={{
            fontSize: "var(--fs-2xs)",
            fontWeight: 700,
            letterSpacing: "0.8px",
            padding: "2px 6px",
            borderRadius: 6,
            background: color,
            color: "var(--on-accent)",
          }}
        >
          {kind}
        </span>
        <span
          className="mono"
          style={{ fontSize: "var(--fs-body)", fontWeight: 500, color, overflowWrap: "anywhere" }}
        >
          {name}
        </span>
      </div>
      <div style={{ padding: "8px 12px 10px", display: "grid", gap: 3 }}>{children}</div>
    </div>
  );
}

function Col({ name, note, fk }: { name: string; note?: string; fk?: boolean }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
      <span
        className="mono"
        style={{
          fontSize: "var(--fs-meta)",
          color: fk ? "var(--accent-deep)" : "var(--text-mid)",
          overflowWrap: "anywhere",
        }}
      >
        {name}
      </span>
      {note && (
        <span style={{ fontSize: "var(--fs-xs)", color: "var(--text-faint)", letterSpacing: "0.4px" }}>
          {note}
        </span>
      )}
    </div>
  );
}

// ---- source pickers -------------------------------------------------------

function FileBrowser({
  dir,
  items,
  error,
  selected,
  onDir,
  onPick,
}: {
  dir: string;
  items: FileItem[] | null;
  error?: string;
  selected: string;
  onDir: (d: string) => void;
  onPick: (p: string) => void;
}) {
  const rel = (n: string) => (dir ? `${dir}/${n}` : n);
  const up = dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "";
  const readable = (n: string) => READABLE.includes(n.split(".").pop()?.toLowerCase() ?? "");

  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden" }}>
      <div
        className="mono"
        style={{
          padding: "8px 12px",
          borderBottom: "1px solid var(--border)",
          background: "var(--surface-alt)",
          fontSize: "var(--fs-small)",
          color: "var(--text-dim)",
        }}
      >
        ~/{dir}
      </div>
      <div style={{ maxHeight: 244, overflowY: "auto" }}>
        {dir && (
          <Row onClick={() => onDir(up)} glyph="▸" label=".." dim />
        )}
        {error && (
          <div style={{ padding: 12, fontSize: "var(--fs-small)", color: "var(--err)" }}>{error}</div>
        )}
        {!error && items === null && <Empty>Loading…</Empty>}
        {items?.length === 0 && <Empty>This folder is empty.</Empty>}
        {(items ?? [])
          .slice()
          .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name))
          .map((it) => {
            const path = rel(it.name);
            const ok = it.dir || readable(it.name);
            return (
              <Row
                key={it.name}
                glyph={it.dir ? "▸" : "▤"}
                label={it.name}
                dim={!ok}
                on={!it.dir && path === selected}
                onClick={ok ? () => (it.dir ? onDir(path) : onPick(path)) : undefined}
              />
            );
          })}
      </div>
      <div
        style={{
          padding: "8px 12px",
          borderTop: "1px solid var(--border)",
          fontSize: "var(--fs-label)",
          color: "var(--text-dim)",
        }}
      >
        CSV, TSV, Parquet, JSON and NDJSON can be profiled. Others are greyed out.
      </div>
    </div>
  );
}

function TablePicker({
  catalog,
  tree,
  error,
  selected,
  onPick,
}: {
  catalog: string;
  tree: TreeResponse | null;
  error?: string;
  selected: string;
  onPick: (t: string) => void;
}) {
  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden" }}>
      <div style={{ maxHeight: 288, overflowY: "auto" }}>
        {!catalog && <Empty>Choose a target catalog first — tables are browsed inside it.</Empty>}
        {catalog && error && (
          <div style={{ padding: 12, fontSize: "var(--fs-small)", color: "var(--err)" }}>{error}</div>
        )}
        {catalog && !error && tree === null && <Empty>Loading tables…</Empty>}
        {catalog &&
          tree?.schemas.map((s) => (
            <div key={s.name}>
              <div
                className="mono"
                style={{
                  padding: "8px 12px",
                  background: "var(--surface-alt)",
                  borderBottom: "1px solid var(--border-soft)",
                  fontSize: "var(--fs-small)",
                  color: "var(--text-dim)",
                }}
              >
                {s.name}
              </div>
              {s.tables.length === 0 && <Empty>empty schema</Empty>}
              {s.tables.map((t) => (
                <Row
                  key={`${s.name}.${t}`}
                  glyph="▤"
                  label={t}
                  on={t === selected}
                  onClick={() => onPick(t)}
                />
              ))}
            </div>
          ))}
        {catalog && tree?.schemas.length === 0 && <Empty>No schemas in this catalog yet.</Empty>}
      </div>
    </div>
  );
}

function Row({
  glyph,
  label,
  dim,
  on,
  onClick,
}: {
  glyph: string;
  label: string;
  dim?: boolean;
  on?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 9,
        width: "100%",
        textAlign: "left",
        padding: "8px 12px",
        border: "none",
        borderBottom: "1px solid var(--border-soft)",
        background: on ? "var(--accent-tint)" : "transparent",
        color: dim ? "var(--text-faint)" : on ? "var(--accent-tint-ink)" : "var(--text)",
        fontSize: "var(--fs-base)",
        cursor: onClick ? "pointer" : "default",
      }}
    >
      <span style={{ color: "var(--text-faint)", fontSize: "var(--fs-label)" }}>{glyph}</span>
      <span className="mono" style={{ fontSize: "var(--fs-body)", overflowWrap: "anywhere" }}>
        {label}
      </span>
      {on && <span style={{ marginLeft: "auto", color: "var(--accent)" }}>✓</span>}
    </button>
  );
}

// ---- small pieces ---------------------------------------------------------

function Phase({
  n,
  title,
  done,
  last,
  children,
}: {
  n: number;
  title: string;
  done?: boolean;
  last?: boolean;
  children: ReactNode;
}) {
  return (
    <section style={{ marginBottom: last ? 0 : 22 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 10 }}>
        <span
          className="mono"
          style={{
            width: 20,
            height: 20,
            borderRadius: "50%",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: "var(--fs-label)",
            fontWeight: 600,
            background: done ? "var(--ok-tint)" : "var(--accent-tint)",
            color: done ? "var(--ok-ink)" : "var(--accent-tint-ink)",
          }}
        >
          {done ? "✓" : n}
        </span>
        <h2 style={{ fontSize: "var(--fs-lg)", fontWeight: 600 }}>{title}</h2>
      </div>
      <div style={card}>{children}</div>
    </section>
  );
}

function Stat({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div
        style={{
          fontSize: "var(--fs-eyebrow)",
          letterSpacing: "0.8px",
          textTransform: "uppercase",
          color: "var(--text-faint)",
          marginBottom: 4,
        }}
      >
        {label}
      </div>
      <div
        className={mono ? "mono" : undefined}
        style={{ fontSize: mono ? "var(--fs-base)" : 20, fontWeight: mono ? 400 : 600 }}
      >
        {value}
      </div>
    </div>
  );
}

function Seg({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        border: `1px solid ${on ? "var(--accent)" : "var(--border)"}`,
        background: on ? "var(--accent)" : "var(--surface)",
        color: on ? "var(--on-accent)" : "var(--text-mid)",
        borderRadius: 11,
        fontSize: "var(--fs-body)",
        fontWeight: on ? 600 : 400,
        padding: "7px 18px",
      }}
    >
      {children}
    </button>
  );
}

function Label({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        fontSize: "var(--fs-label)",
        letterSpacing: "0.6px",
        textTransform: "uppercase",
        color: "var(--text-faint)",
        marginBottom: 7,
      }}
    >
      {children}
    </div>
  );
}

function Hint({ children }: { children: ReactNode }) {
  return <div style={{ fontSize: "var(--fs-label)", color: "var(--text-dim)", marginTop: 6 }}>{children}</div>;
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <div style={{ padding: "12px", fontSize: "var(--fs-small)", color: "var(--text-dim)" }}>{children}</div>
  );
}

/** SUMMARIZE min/max can be a whole paragraph — keep the table readable. */
function Clip({ children }: { children?: string | null }) {
  const text = children === null || children === undefined || children === "" ? "—" : String(children);
  return (
    <span
      title={text}
      style={{
        display: "inline-block",
        maxWidth: 160,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        verticalAlign: "bottom",
      }}
    >
      {text}
    </span>
  );
}

const card: CSSProperties = {
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: 14,
  padding: 20,
};

const input: CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  border: "1px solid var(--border)",
  borderRadius: 12,
  background: "var(--surface)",
  color: "var(--text)",
  fontSize: "var(--fs-base)",
  outline: "none",
};

const ghost: CSSProperties = {
  background: "var(--surface)",
  color: "var(--text-mid)",
  border: "1px solid var(--border)",
  borderRadius: 11,
  fontSize: "var(--fs-body)",
  padding: "9px 16px",
};

const kindPill: CSSProperties = {
  fontSize: "var(--fs-xs)",
  letterSpacing: "0.4px",
  color: "var(--text-faint)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  padding: "1px 6px",
};

const crumbBtn: CSSProperties = {
  border: "none",
  background: "transparent",
  padding: 0,
  font: "inherit",
  fontSize: "var(--fs-small)",
  color: "var(--text-dim)",
};
