import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, errorText } from "../api";
import { recordRecent } from "../recents";
import { ErrorBlock, Loading } from "../components/State";
import { duration, isLive, runColor, stamp, type RunInfo, type TaskRunInfo } from "../jobs";

/*
 * /jobs/:name/runs/:runId — one run (spec §5 "run"). A 20-bar history strip
 * across the top doubles as navigation between runs; below it the task timeline
 * with expandable logs. Run state is Airflow's, read-only (REQ-42) — so while
 * anything is still moving the page re-reads every 5 s rather than pretending to
 * stream.
 */

const BARS = 20;
const REFRESH_MS = 5000;

export function JobRun() {
  const nav = useNavigate();
  const { name = "", runId = "" } = useParams();
  const [runs, setRuns] = useState<RunInfo[] | null>(null);
  const [tasks, setTasks] = useState<TaskRunInfo[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [stripError, setStripError] = useState("");
  const recorded = useRef("");

  const load = useCallback(() => {
    api
      .get<RunInfo[]>(`/jobs/${encodeURIComponent(name)}/runs`)
      .then((r) => {
        setRuns(r);
        setStripError("");
      })
      // Swallowing this drew "No run history yet." over a fetch that failed.
      .catch((e) => setStripError(errorText(e)));
    api
      .get<TaskRunInfo[]>(
        `/jobs/${encodeURIComponent(name)}/runs/${encodeURIComponent(runId)}`,
      )
      .then((t) => {
        setTasks(t);
        // Polling re-enters here; record only the first successful load.
        if (recorded.current !== `${name}/${runId}`) {
          recorded.current = `${name}/${runId}`;
          recordRecent("job", name);
        }
        setError("");
      })
      .catch((e) => {
        setTasks([]);
        setError(errorText(e));
      });
  }, [name, runId]);

  useEffect(load, [load]);

  // Poll only while something is live; the interval is torn down as soon as the
  // run settles, so a finished page costs nothing.
  const live = (tasks ?? []).some((t) => isLive(t.state));
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => loadRef.current(), REFRESH_MS);
    return () => clearInterval(id);
  }, [live]);

  // pebblesd returns newest-first; the strip reads left-to-right in time.
  const strip = [...(runs ?? [])].reverse().slice(-BARS);
  const current = (runs ?? []).find((r) => r.run_id === runId);

  return (
    <div style={{ maxWidth: 1080, margin: "0 auto", padding: "34px 40px 60px" }}>
      <div className="mono" style={{ fontSize: 11.5, color: "var(--text-dim)", marginBottom: 8 }}>
        <button type="button" onClick={() => nav("/jobs")} style={crumbBtn}>
          ‹ Jobs
        </button>
      </div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <h1 style={{ fontSize: 25, fontWeight: 600, letterSpacing: "-0.5px" }}>{name}</h1>
        <span className="mono" style={{ fontSize: 12, color: "var(--text-dim)" }}>
          {runId}
        </span>
        {current && (
          <span style={{ fontSize: 12, fontWeight: 600, color: runColor(current.state) }}>
            {current.state}
          </span>
        )}
        {live && (
          <span style={{ fontSize: 11.5, color: "var(--text-dim)" }}>refreshing every 5 s…</span>
        )}
      </div>
      {current && (
        <div className="mono" style={{ fontSize: 11.5, color: "var(--text-dim)", marginTop: 4 }}>
          {stamp(current.start)} → {stamp(current.end)}{" "}
          {duration(current.start, current.end) && `· ${duration(current.start, current.end)}`}
        </div>
      )}

      {/* ---- run history strip -------------------------------------------- */}
      <div style={{ ...card, padding: 18, marginTop: 20 }}>
        <div
          style={{
            fontSize: 11,
            letterSpacing: "0.6px",
            textTransform: "uppercase",
            color: "var(--text-faint)",
            marginBottom: 12,
          }}
        >
          Run history
        </div>
        {strip.length > 0 ? (
          <div style={{ display: "flex", alignItems: "flex-end", gap: 5, height: 64 }}>
            {strip.map((r) => {
              const selected = r.run_id === runId;
              return (
                <button
                  key={r.run_id}
                  type="button"
                  title={`${r.run_id} · ${r.state}`}
                  onClick={() =>
                    nav(`/jobs/${encodeURIComponent(name)}/runs/${encodeURIComponent(r.run_id)}`)
                  }
                  style={{
                    flex: 1,
                    minWidth: 8,
                    height: selected ? 56 : 40,
                    border: selected ? "2px solid var(--text)" : "none",
                    borderRadius: 4,
                    padding: 0,
                    background: runColor(r.state),
                  }}
                />
              );
            })}
          </div>
        ) : stripError ? (
          <div style={{ fontSize: 12.5, color: "var(--err)" }}>
            Couldn't read the run history — {stripError}
          </div>
        ) : runs === null ? (
          <Loading label="Loading run history…" />
        ) : (
          <div style={{ fontSize: 12.5, color: "var(--text-dim)" }}>
            No run history yet — this job has never been triggered.
          </div>
        )}
        <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 10 }}>
          Oldest ← → latest · click a bar to open that run
        </div>
      </div>

      {/* ---- task timeline ------------------------------------------------ */}
      <h2 style={{ fontSize: 16, fontWeight: 600, margin: "24px 0 12px" }}>Tasks</h2>
      {error && <ErrorBlock title="Couldn't read this run" error={error} />}
      {tasks === null && !error && <Loading />}
      {tasks !== null && tasks.length === 0 && !error && (
        <p style={{ color: "var(--text-dim)", fontSize: 13 }}>
          This run has no task instances yet — Airflow creates them as the DAG starts.
        </p>
      )}

      <div style={{ ...card, overflow: "hidden" }}>
        {(tasks ?? []).map((t) => {
          const expanded = open === t.task_id;
          return (
            <div key={t.task_id} style={{ borderBottom: "1px solid var(--border-soft)" }}>
              <button
                type="button"
                onClick={() => setOpen(expanded ? null : t.task_id)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  width: "100%",
                  textAlign: "left",
                  border: "none",
                  background: "transparent",
                  padding: "12px 18px",
                  fontSize: 13,
                  color: "var(--text)",
                }}
              >
                <span style={{ color: "var(--text-faint)", width: 10 }}>
                  {expanded ? "▾" : "▸"}
                </span>
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    background: runColor(t.state),
                    flexShrink: 0,
                  }}
                />
                <span className="mono" style={{ minWidth: 200 }}>
                  {t.task_id}
                </span>
                <span className="mono" style={{ fontSize: 11.5, color: "var(--text-dim)" }}>
                  {stamp(t.start)} → {stamp(t.end)}
                </span>
                <span style={{ fontSize: 11.5, color: "var(--text-dim)" }}>
                  {duration(t.start, t.end)}
                </span>
                <span style={{ marginLeft: "auto", fontSize: 11.5, color: runColor(t.state) }}>
                  {t.state || "unknown"}
                </span>
              </button>
              {expanded && <Log text={t.log} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** The task log on the deep surface, with OOM called out in red (spec §5). */
function Log({ text }: { text: string }) {
  return (
    <pre
      className="mono"
      style={{
        margin: "0 18px 16px",
        padding: "14px 16px",
        background: "var(--deep-soft)",
        color: "var(--deep-text-2)",
        borderRadius: 12,
        fontSize: 11.5,
        lineHeight: 1.8,
        maxHeight: 340,
        overflow: "auto",
        whiteSpace: "pre-wrap",
        overflowWrap: "break-word",
      }}
    >
      {text?.trim() ? highlightOom(text) : "No log captured for this attempt."}
    </pre>
  );
}

function highlightOom(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  const re = /OOM/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(
      <span key={key++} style={{ color: "var(--err)", fontWeight: 700 }}>
        OOM
      </span>,
    );
    last = m.index + 3;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const card: CSSProperties = {
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: 14,
};

const crumbBtn: CSSProperties = {
  border: "none",
  background: "transparent",
  padding: 0,
  font: "inherit",
  fontSize: 11.5,
  color: "var(--text-dim)",
};
