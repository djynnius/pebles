import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { AccentButton, Page } from "../components/Page";
import { StatusDot, Table, Td } from "../components/Table";
import { duration, runColor, stamp, type RunInfo, type Workflow } from "../jobs";

/*
 * /jobs — the workflow list (spec §5 "jobs"). Jobs are pebblesd workflows that
 * compile to hidden Airflow DAGs; users never see Airflow (REQ-38). Clicking a
 * name expands the row and fetches that job's run history in place, so the list
 * stays the index and the run detail stays one click away.
 */

export function Jobs() {
  const nav = useNavigate();
  const [jobs, setJobs] = useState<Workflow[] | null>(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [runs, setRuns] = useState<Record<string, RunInfo[] | "loading" | string>>({});
  const [busy, setBusy] = useState("");

  useEffect(() => {
    api
      .get<Workflow[]>("/jobs")
      .then(setJobs)
      .catch((e) => {
        setError(String(e.message ?? e));
        setJobs([]);
      });
  }, []);

  const loadRuns = useCallback((name: string) => {
    setRuns((cur) => ({ ...cur, [name]: "loading" }));
    api
      .get<RunInfo[]>(`/jobs/${encodeURIComponent(name)}/runs`)
      .then((r) => setRuns((cur) => ({ ...cur, [name]: r })))
      .catch((e) => setRuns((cur) => ({ ...cur, [name]: String(e.message ?? e) })));
  }, []);

  const toggle = (name: string) => {
    if (open === name) {
      setOpen(null);
      return;
    }
    setOpen(name);
    if (!runs[name] || typeof runs[name] === "string") loadRuns(name);
  };

  const runNow = (name: string) => {
    setBusy(name);
    setError("");
    api
      .post(`/jobs/${encodeURIComponent(name)}/run`)
      .then(() => {
        setOpen(name);
        loadRuns(name);
      })
      .catch((e) => setError(String(e.message ?? e)))
      .finally(() => setBusy(""));
  };

  const shown = (jobs ?? []).filter((j) =>
    filter.trim() ? j.name.toLowerCase().includes(filter.trim().toLowerCase()) : true,
  );

  return (
    <Page
      title="Jobs"
      eyebrow="Data engineering"
      actions={<AccentButton onClick={() => nav("/jobbuilder")}>New job</AccentButton>}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            height: 32,
            minWidth: 260,
            padding: "0 12px",
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 11,
            color: "var(--text-faint)",
          }}
        >
          <span>⌕</span>
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter jobs…"
            aria-label="Filter jobs"
            style={{
              border: "none",
              background: "transparent",
              outline: "none",
              color: "var(--text)",
              fontSize: 12.5,
              width: 180,
            }}
          />
        </div>
        <span style={{ fontSize: 12, color: "var(--text-dim)" }}>
          Workflows run on your engines as their owner — no Airflow UI, ever.
        </span>
      </div>

      {error && <p style={{ color: "var(--err)", fontSize: 12.5, marginBottom: 12 }}>{error}</p>}

      {shown.length > 0 ? (
        <Table head={["", "Job", "Schedule", "Owner", "Tasks", ""]}>
          {shown.map((job) => {
            const expanded = open === job.name;
            const history = runs[job.name];
            return [
              <tr key={job.name}>
                <Td>
                  <StatusDot tone="ok" />
                </Td>
                <Td>
                  <button
                    type="button"
                    onClick={() => toggle(job.name)}
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
                    <span style={{ color: "var(--text-faint)", width: 10 }}>
                      {expanded ? "▾" : "▸"}
                    </span>
                    {job.name}
                  </button>
                </Td>
                <Td mono>
                  {job.schedule ? (
                    job.schedule
                  ) : (
                    <span style={{ color: "var(--text-dim)" }}>manual</span>
                  )}
                </Td>
                <Td>{job.username}</Td>
                <Td>{job.tasks.length}</Td>
                <Td>
                  <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                    <button
                      type="button"
                      onClick={() => runNow(job.name)}
                      disabled={busy === job.name}
                      title={`Run ${job.name} now`}
                      style={rowBtn}
                    >
                      {busy === job.name ? "Starting…" : "▶ Run now"}
                    </button>
                    <button
                      type="button"
                      onClick={() => nav(`/jobbuilder?edit=${encodeURIComponent(job.name)}`)}
                      style={rowBtn}
                    >
                      Edit
                    </button>
                  </div>
                </Td>
              </tr>,
              expanded ? (
                <tr key={`${job.name}-runs`}>
                  <td colSpan={6} style={{ padding: 0, background: "var(--surface-alt)" }}>
                    <RunHistory
                      name={job.name}
                      history={history}
                      onOpen={(runId) =>
                        nav(`/jobs/${encodeURIComponent(job.name)}/runs/${encodeURIComponent(runId)}`)
                      }
                    />
                  </td>
                </tr>
              ) : null,
            ];
          })}
        </Table>
      ) : (
        <p style={{ color: "var(--text-dim)", fontSize: 13 }}>
          {jobs
            ? filter.trim()
              ? "No job matches that filter."
              : "No jobs yet — build one and it compiles to a scheduled workflow."
            : "Loading…"}
        </p>
      )}
    </Page>
  );
}

function RunHistory({
  name,
  history,
  onOpen,
}: {
  name: string;
  history: RunInfo[] | "loading" | string | undefined;
  onOpen: (runId: string) => void;
}) {
  if (history === undefined || history === "loading") {
    return <div style={emptyRow}>Loading runs…</div>;
  }
  if (typeof history === "string") {
    return <div style={{ ...emptyRow, color: "var(--err)" }}>{history}</div>;
  }
  if (history.length === 0) {
    return <div style={emptyRow}>No runs yet for {name} — trigger one with ▶ Run now.</div>;
  }
  return (
    <div style={{ padding: "6px 0" }}>
      {history.map((r) => (
        <button
          key={r.run_id}
          type="button"
          onClick={() => onOpen(r.run_id)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            width: "100%",
            textAlign: "left",
            border: "none",
            background: "transparent",
            padding: "8px 16px 8px 52px",
            fontSize: 12.5,
            color: "var(--text-mid)",
          }}
        >
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: runColor(r.state),
              flexShrink: 0,
            }}
          />
          <span className="mono" style={{ color: "var(--text)", minWidth: 260 }}>
            {r.run_id}
          </span>
          <span className="mono" style={{ fontSize: 11.5, color: "var(--text-dim)" }}>
            {stamp(r.start)} → {stamp(r.end)}
          </span>
          <span style={{ fontSize: 11.5, color: "var(--text-dim)" }}>
            {duration(r.start, r.end)}
          </span>
          <span style={{ marginLeft: "auto", fontSize: 11.5, color: runColor(r.state) }}>
            {r.state || "unknown"}
          </span>
        </button>
      ))}
    </div>
  );
}

const rowBtn: CSSProperties = {
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--text-mid)",
  borderRadius: 11,
  fontSize: 11.5,
  padding: "5px 10px",
};

const emptyRow: CSSProperties = {
  padding: "12px 16px 12px 52px",
  fontSize: 12.5,
  color: "var(--text-dim)",
};
