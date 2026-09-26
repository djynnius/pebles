import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api, errorText } from "../api";
import { AccentButton, Page } from "../components/Page";
import { InlineConfirm } from "../components/Form";
import { Table, Td } from "../components/Table";
import { Empty, EmptyAction, ErrorBlock, Loading } from "../components/State";
import { duration, isLive, runColor, stamp, type RunInfo, type Workflow } from "../jobs";

/** GET /api/jobs/<name>/trigger — the background trigger's outcome (null if never run). */
type TriggerStatus = { state: "queued" | "triggered" | "failed"; error: string | null; at: number };

const TRIGGER_POLL_MS = 3000;
const TRIGGER_POLL_MAX_MS = 6 * 60 * 1000;
const RUNS_REFRESH_MS = 5000;

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
  // Jobs whose run request is accepted but Airflow hasn't confirmed yet, and
  // per-job trigger failures ("Couldn't start the run: …").
  const [queued, setQueued] = useState<Record<string, boolean>>({});
  const [trigErr, setTrigErr] = useState<Record<string, string>>({});
  // Delete: the job awaiting confirmation, whether the DELETE is in flight,
  // and the server's refusal (403/404/…) shown inside the confirm panel.
  const [confirming, setConfirming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  // `?open=<job>` (global search, Home Recents) expands that job's row.
  const [params] = useSearchParams();
  const openParam = params.get("open");
  const polls = useRef<Map<string, number>>(new Map());
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    const timers = polls.current;
    return () => {
      alive.current = false;
      timers.forEach((t) => window.clearTimeout(t));
      timers.clear();
    };
  }, []);

  const loadRuns = useCallback((name: string, quiet = false) => {
    if (!quiet) setRuns((cur) => ({ ...cur, [name]: "loading" }));
    api
      .get<RunInfo[]>(`/jobs/${encodeURIComponent(name)}/runs`)
      .then((r) => alive.current && setRuns((cur) => ({ ...cur, [name]: r })))
      .catch((e) => alive.current && setRuns((cur) => ({ ...cur, [name]: errorText(e) })));
  }, []);

  // The run request returns before Airflow has the run; poll the trigger
  // outcome every 3 s (for up to ~6 min) and only then show the run.
  const watchTrigger = useCallback(
    (name: string) => {
      if (polls.current.has(name)) return;
      const started = Date.now();
      setQueued((cur) => ({ ...cur, [name]: true }));
      const settle = (err?: string) => {
        polls.current.delete(name);
        if (!alive.current) return;
        setQueued((cur) => ({ ...cur, [name]: false }));
        if (err !== undefined) setTrigErr((cur) => ({ ...cur, [name]: err }));
      };
      const tick = () => {
        api
          .get<TriggerStatus | null>(`/jobs/${encodeURIComponent(name)}/trigger`)
          .then((t) => {
            if (!alive.current) return;
            if (t?.state === "triggered") {
              settle();
              setOpen(name);
              loadRuns(name);
            } else if (t?.state === "failed") {
              settle(t.error || "the scheduler rejected the trigger");
            } else if (Date.now() - started > TRIGGER_POLL_MAX_MS) {
              settle("the scheduler still hasn't picked it up after 6 minutes. Check back later.");
            } else {
              polls.current.set(name, window.setTimeout(tick, TRIGGER_POLL_MS));
            }
          })
          .catch((e) => settle(errorText(e)));
      };
      polls.current.set(name, window.setTimeout(tick, TRIGGER_POLL_MS));
    },
    [loadRuns],
  );

  useEffect(() => {
    api
      .get<Workflow[]>("/jobs")
      .then((list) => {
        if (!alive.current) return;
        setJobs(list);
        // The status dot is the newest run's state, so every job's history is
        // read once up front (there are few jobs). Quiet: no "loading" flash.
        for (const j of list) loadRuns(j.name, true);
        // A run may have been requested elsewhere (Auto ETL's "Approve & run");
        // pick up any trigger that is still queued.
        for (const j of list) {
          api
            .get<TriggerStatus | null>(`/jobs/${encodeURIComponent(j.name)}/trigger`)
            .then((t) => {
              if (alive.current && t?.state === "queued") watchTrigger(j.name);
            })
            .catch(() => undefined);
        }
      })
      // Leave `jobs` null so a failed read renders the error, not "no jobs yet".
      .catch((e) => setError(errorText(e)));
  }, [watchTrigger, loadRuns]);

  useEffect(() => {
    if (openParam && jobs?.some((j) => j.name === openParam)) setOpen(openParam);
  }, [openParam, jobs]);

  // Keep a job's history fresh while its newest run is still moving.
  useEffect(() => {
    const timers: number[] = [];
    for (const [name, h] of Object.entries(runs)) {
      if (Array.isArray(h) && h[0] && isLive(h[0].state)) {
        timers.push(window.setTimeout(() => loadRuns(name, true), RUNS_REFRESH_MS));
      }
    }
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [runs, loadRuns]);

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
    setTrigErr((cur) => ({ ...cur, [name]: "" }));
    api
      .post(`/jobs/${encodeURIComponent(name)}/run`)
      .then(() => watchTrigger(name))
      .catch((e) => setError(errorText(e)))
      .finally(() => setBusy(""));
  };

  const askDelete = (name: string) => {
    setConfirming(name);
    setDeleteError("");
  };

  const confirmDelete = () => {
    if (!confirming) return;
    const name = confirming;
    setDeleting(true);
    setDeleteError("");
    api
      .del(`/jobs/${encodeURIComponent(name)}`)
      .then(() => api.get<Workflow[]>("/jobs"))
      .then((list) => {
        if (!alive.current) return;
        setJobs(list);
        setConfirming(null);
        if (open === name) setOpen(null);
        setRuns((cur) => {
          const next = { ...cur };
          delete next[name];
          return next;
        });
      })
      .catch((e) => alive.current && setDeleteError(errorText(e)))
      .finally(() => alive.current && setDeleting(false));
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

      {error && <ErrorBlock error={error} />}
      {!error && jobs === null && <Loading />}
      {confirming && (
        <div style={{ marginBottom: 14 }}>
          <InlineConfirm
            message={`Delete job ${confirming}? Its schedule and run history are removed.`}
            confirmLabel="Delete"
            busyLabel="Deleting…"
            busy={deleting}
            error={deleteError}
            onConfirm={confirmDelete}
            onCancel={() => setConfirming(null)}
          />
        </div>
      )}

      {shown.length > 0 ? (
        <Table head={["", "Job", "Schedule", "Owner", "Tasks", ""]}>
          {shown.map((job) => {
            const expanded = open === job.name;
            const history = runs[job.name];
            // The dot is the *newest run's* state (histories are read on load).
            // It used to be hard-coded green, which told a user with a failing
            // job that everything was fine. Dim = never run / not yet known.
            const latest = Array.isArray(history) ? history[0] : undefined;
            const dotTitle = latest
              ? `Last run: ${latest.state || "unknown"}`
              : Array.isArray(history)
                ? "Never run"
                : typeof history === "string" && history !== "loading"
                  ? `Run history unavailable: ${history}`
                  : "Reading run history…";
            return [
              <tr key={job.name}>
                <Td>
                  <span
                    title={dotTitle}
                    aria-label={dotTitle}
                    role="img"
                    style={{
                      display: "inline-block",
                      width: 8,
                      height: 8,
                      borderRadius: "50%",
                      background: latest ? runColor(latest.state) : "var(--text-dim)",
                    }}
                  />
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
                      disabled={busy === job.name || !!queued[job.name]}
                      title={`Run ${job.name} now`}
                      style={rowBtn}
                    >
                      {busy === job.name ? "Starting…" : queued[job.name] ? "Queued…" : "▶ Run now"}
                    </button>
                    <button
                      type="button"
                      onClick={() => nav(`/jobbuilder?edit=${encodeURIComponent(job.name)}`)}
                      style={rowBtn}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => askDelete(job.name)}
                      disabled={deleting && confirming === job.name}
                      title={`Delete ${job.name}`}
                      style={rowBtn}
                    >
                      Delete
                    </button>
                  </div>
                </Td>
              </tr>,
              trigErr[job.name] ? (
                <tr key={`${job.name}-trigger`}>
                  <td colSpan={6} style={{ padding: "8px 16px" }}>
                    <ErrorBlock
                      title="Couldn't start the run"
                      error={trigErr[job.name]}
                      style={{ marginBottom: 0 }}
                    />
                  </td>
                </tr>
              ) : null,
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
        jobs !== null &&
        (filter.trim() ? (
          <Empty
            inline
            title="No job matches that filter"
            body={
              <>
                Nothing named like “{filter.trim()}”.{" "}
                <button
                  type="button"
                  onClick={() => setFilter("")}
                  style={{
                    border: "none",
                    background: "transparent",
                    padding: 0,
                    font: "inherit",
                    color: "var(--accent-ink)",
                  }}
                >
                  Clear the filter
                </button>
                .
              </>
            }
          />
        ) : (
          <Empty
            glyph="⇄"
            title="No jobs yet"
            body="A job is an ordered list of steps — SQL, Python, R, shell or a notebook — that runs on your engines as you. Build one and it compiles to a scheduled workflow."
            action={<EmptyAction onClick={() => nav("/jobbuilder")}>Build your first job</EmptyAction>}
          />
        ))
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
