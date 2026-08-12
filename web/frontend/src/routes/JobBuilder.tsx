import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api, errorText } from "../api";
import { useCatalogs } from "../catalogs";
import { Switch } from "../components/Page";
import { ErrorBlock, Loading } from "../components/State";
import {
  DEFAULT_PREFS,
  JOB_NAME,
  TASK_TYPES,
  loadPrefs,
  refOk,
  savePrefs,
  type JobPrefs,
  type Workflow,
  type WorkflowTask,
} from "../jobs";

/*
 * /jobbuilder — build or edit a workflow (spec §5 "jobbuilder"). The form is the
 * whole product surface for jobs: a name, a cron string (or manual-only), and an
 * ordered list of tasks with dependencies. Saving POSTs the workflow; pebblesd
 * compiles it to a DAG and the owner is forced server-side (REQ-41).
 */

interface EngineRow {
  name: string;
  state: string;
}

const blankTask = (n: number): WorkflowTask => ({
  id: `task_${n}`,
  task_type: "sql",
  payload: "",
  engine: null,
  catalog: null,
  depends_on: [],
  retries: 0,
  repo: null,
  ref: null,
});

/** The payload means different things once a task is pinned to a repo. */
const payloadLabel = (task: WorkflowTask): string => {
  if (task.repo) return "Path in repo";
  return task.task_type === "sql" ? "SQL" : "Payload";
};

const payloadPlaceholder = (task: WorkflowTask): string => {
  if (task.repo) return "pipelines/report.sql";
  if (task.task_type === "sql") return "INSERT INTO gold.claims_monthly SELECT …";
  if (task.task_type === "notebook") return "notebooks/monthly_refresh.json";
  return "the script body to run";
};

export function JobBuilder() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const editing = params.get("edit");
  const { catalogs, error: catalogError } = useCatalogs();

  const [name, setName] = useState(editing ?? "");
  const [schedule, setSchedule] = useState("0 1 * * *");
  const [manual, setManual] = useState(false);
  const [prefs, setPrefs] = useState<JobPrefs>(DEFAULT_PREFS);
  const [tasks, setTasks] = useState<WorkflowTask[]>([blankTask(1)]);
  const [engines, setEngines] = useState<EngineRow[]>([]);
  const [repos, setRepos] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(!editing);

  useEffect(() => {
    api
      .get<EngineRow[]>("/engines")
      .then(setEngines)
      .catch(() => setEngines([]));
    // The repo list is the user's own ~/repos (REQ-37) — no repos is normal, so
    // a failure here is silent and the tasks simply stay inline.
    api
      .get<string[]>("/repos")
      .then(setRepos)
      .catch(() => setRepos([]));
  }, []);

  // Editing loads the saved workflow out of the list — there is no single-job
  // GET, and the list is already the authoritative record.
  useEffect(() => {
    if (!editing) return;
    api
      .get<Workflow[]>("/jobs")
      .then((all) => {
        const found = all.find((w) => w.name === editing);
        if (!found) {
          setError(`No job named “${editing}”.`);
          return;
        }
        setName(found.name);
        setManual(found.schedule === null);
        if (found.schedule) setSchedule(found.schedule);
        setTasks(
          found.tasks.length > 0
            ? found.tasks.map((t) => ({
                ...t,
                depends_on: t.depends_on ?? [],
                repo: t.repo ?? null,
                ref: t.ref ?? null,
              }))
            : [blankTask(1)],
        );
        setPrefs(loadPrefs(found.name));
      })
      .catch((e) => setError(errorText(e)))
      .finally(() => setLoaded(true));
  }, [editing]);

  const patch = (index: number, changes: Partial<WorkflowTask>) =>
    setTasks((cur) => cur.map((t, i) => (i === index ? { ...t, ...changes } : t)));

  const move = (index: number, delta: number) =>
    setTasks((cur) => {
      const to = index + delta;
      if (to < 0 || to >= cur.length) return cur;
      const next = [...cur];
      const [held] = next.splice(index, 1);
      next.splice(to, 0, held);
      return next;
    });

  const remove = (index: number) =>
    setTasks((cur) => {
      const gone = cur[index].id;
      const next = cur.filter((_, i) => i !== index);
      // A removed task cannot stay in anyone's dependency list — pebblesd
      // rejects unknown dependencies outright.
      const cleaned = next.map((t) => ({
        ...t,
        depends_on: (t.depends_on ?? []).filter((d) => d !== gone),
      }));
      return cleaned.length > 0 ? cleaned : [blankTask(1)];
    });

  const nameOk = JOB_NAME.test(name);
  const idsOk =
    tasks.every((t) => t.id.trim().length > 0) &&
    new Set(tasks.map((t) => t.id.trim())).size === tasks.length;

  /** A ref only exists with a repo, and only the server-legal shape is offered. */
  const refBad = (t: WorkflowTask) =>
    Boolean(t.repo) && Boolean(t.ref?.trim()) && !refOk(t.ref!.trim());

  const save = () => {
    if (!nameOk) {
      setError("Names start with a lower-case letter, then letters, digits, dash or underscore.");
      return;
    }
    if (!idsOk) {
      setError("Every task needs a unique, non-empty id.");
      return;
    }
    const badRef = tasks.find(refBad);
    if (badRef) {
      setError(
        `${badRef.id}: a ref is letters, digits, dot, underscore, slash or dash — ` +
          "at most 128 of them, and it cannot start with “-”.",
      );
      return;
    }
    setBusy(true);
    setError("");
    const body = {
      name,
      schedule: manual ? null : schedule.trim() || null,
      tasks: tasks.map((t) => {
        // repo/ref only travel when they mean something: a ref without a repo
        // is meaningless and pebblesd rejects it outright.
        const repo = t.repo || null;
        const ref = repo ? t.ref?.trim() || null : null;
        return {
          id: t.id.trim(),
          task_type: t.task_type,
          payload: t.payload,
          engine: t.engine || null,
          catalog: t.catalog || null,
          depends_on: t.depends_on ?? [],
          retries: Number(t.retries ?? 0) || 0,
          ...(repo ? { repo } : {}),
          ...(ref ? { ref } : {}),
        };
      }),
    };
    api
      .post("/jobs", body)
      .then(() => {
        savePrefs(name, prefs);
        nav("/jobs");
      })
      .catch((e) => setError(errorText(e)))
      .finally(() => setBusy(false));
  };

  return (
    <div style={{ maxWidth: 1080, margin: "0 auto", padding: "34px 40px 60px" }}>
      <div className="mono" style={{ fontSize: 11.5, color: "var(--text-dim)", marginBottom: 8 }}>
        <button type="button" onClick={() => nav("/jobs")} style={crumbBtn}>
          ‹ Jobs
        </button>
      </div>
      <h1 style={{ fontSize: 25, fontWeight: 600, letterSpacing: "-0.5px", marginBottom: 22 }}>
        {editing ? `Edit ${editing}` : "New job"}
      </h1>

      {error && <ErrorBlock error={error} />}
      {catalogError && (
        <ErrorBlock title="Catalogs unavailable — the Catalog selects will be empty" error={catalogError} />
      )}
      {/* An edit that has not landed yet must not render a blank form the user
          might start typing into: the fetch would overwrite it a moment later. */}
      {!loaded ? (
        <Loading label="Loading job…" />
      ) : (
        <>
      {/* ---- schedule card ------------------------------------------------ */}
      <div style={card}>
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 18 }}>
          <Field label="Name" hint="Lower-case letter first, then letters, digits, dash or underscore.">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={Boolean(editing)}
              placeholder="claims-monthly-refresh"
              className="mono"
              style={{
                ...input,
                borderColor: name && !nameOk ? "var(--err)" : "var(--border)",
                color: editing ? "var(--text-dim)" : "var(--text)",
              }}
            />
          </Field>
          <Field
            label="Schedule"
            hint={manual ? "Manual only — this job runs when you press Run now." : "Cron, five fields."}
          >
            <input
              value={manual ? "" : schedule}
              onChange={(e) => setSchedule(e.target.value)}
              disabled={manual}
              placeholder="0 1 1 * *"
              className="mono"
              style={{ ...input, opacity: manual ? 0.5 : 1 }}
            />
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                marginTop: 8,
                fontSize: 12.5,
                color: "var(--text-mid)",
              }}
            >
              <input type="checkbox" checked={manual} onChange={(e) => setManual(e.target.checked)} />
              Manual only
            </label>
          </Field>
        </div>

        <div style={{ marginTop: 18, display: "grid", gap: 10 }}>
          <Switch
            label="Catch up missed runs"
            on={prefs.catchup}
            onToggle={() => setPrefs((p) => ({ ...p, catchup: !p.catchup }))}
          />
          <Switch
            label="Allow overlapping runs"
            on={prefs.overlap}
            onToggle={() => setPrefs((p) => ({ ...p, overlap: !p.overlap }))}
          />
          <p style={{ fontSize: 11, color: "var(--text-dim)" }}>
            These two are remembered in this browser only — the workflow API has no catch-up or
            overlap fields yet, so they do not reach the scheduler.
          </p>
        </div>
      </div>

      {/* ---- tasks -------------------------------------------------------- */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "24px 0 12px" }}>
        <h2 style={{ fontSize: 16, fontWeight: 600 }}>Tasks</h2>
        <span style={{ fontSize: 12, color: "var(--text-dim)" }}>
          Each task runs on an engine as the job owner.
        </span>
        <div style={{ flex: 1 }} />
        <button
          type="button"
          onClick={() => setTasks((cur) => [...cur, blankTask(cur.length + 1)])}
          style={ghost}
        >
          + Add task
        </button>
      </div>

      <div style={{ display: "grid", gap: 14 }}>
        {tasks.map((task, i) => (
          <div key={i} style={card}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
              <span style={{ fontSize: 11, color: "var(--text-faint)", letterSpacing: "0.6px" }}>
                STEP {i + 1}
              </span>
              <div style={{ flex: 1 }} />
              <button type="button" onClick={() => move(i, -1)} disabled={i === 0} style={iconBtn}>
                ↑
              </button>
              <button
                type="button"
                onClick={() => move(i, 1)}
                disabled={i === tasks.length - 1}
                style={iconBtn}
              >
                ↓
              </button>
              <button type="button" onClick={() => remove(i)} style={iconBtn} title="Remove task">
                ✕
              </button>
            </div>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
                gap: 14,
              }}
            >
              <Field label="Task id">
                <input
                  value={task.id}
                  onChange={(e) => patch(i, { id: e.target.value })}
                  className="mono"
                  style={input}
                />
              </Field>
              <Field label="Type">
                <select
                  value={task.task_type}
                  onChange={(e) => patch(i, { task_type: e.target.value })}
                  style={input}
                >
                  {TASK_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Engine">
                <select
                  value={task.engine ?? ""}
                  onChange={(e) => patch(i, { engine: e.target.value || null })}
                  style={input}
                >
                  <option value="">any available</option>
                  {engines.map((e) => (
                    <option key={e.name} value={e.name}>
                      {e.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Catalog">
                <select
                  value={task.catalog ?? ""}
                  onChange={(e) => patch(i, { catalog: e.target.value || null })}
                  style={input}
                >
                  <option value="">no catalog</option>
                  {(catalogs ?? []).map((c) => (
                    <option key={c.name} value={c.name}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Retries">
                <input
                  type="number"
                  min={0}
                  max={10}
                  value={task.retries ?? 0}
                  onChange={(e) => patch(i, { retries: Number(e.target.value) })}
                  className="mono"
                  style={input}
                />
              </Field>
              <Field label="Depends on" hint="Ctrl/⌘-click for several.">
                <select
                  multiple
                  value={task.depends_on ?? []}
                  onChange={(e) =>
                    patch(i, {
                      depends_on: Array.from(e.target.selectedOptions).map((o) => o.value),
                    })
                  }
                  className="mono"
                  style={{ ...input, height: 74, padding: "6px 8px" }}
                >
                  {tasks
                    .filter((_, j) => j !== i)
                    .map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.id}
                      </option>
                    ))}
                </select>
              </Field>
            </div>

            {/* REQ-37: pin the step to a file in a repo instead of pasting code. */}
            <div
              style={{
                marginTop: 14,
                display: "grid",
                gridTemplateColumns: task.repo
                  ? "repeat(auto-fit, minmax(180px, 1fr))"
                  : "minmax(0, 1fr)",
                gap: 14,
              }}
            >
              <Field
                label="Run from repo"
                hint={
                  task.repo
                    ? "The payload below is a path inside this repo."
                    : "Or leave it inline and paste the code below."
                }
              >
                <select
                  value={task.repo ?? ""}
                  onChange={(e) =>
                    patch(i, {
                      repo: e.target.value || null,
                      // dropping the repo drops the ref with it
                      ref: e.target.value ? task.ref ?? null : null,
                    })
                  }
                  style={input}
                >
                  <option value="">(inline)</option>
                  {repos.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </Field>
              {task.repo && (
                <Field label="Ref" hint="Branch, tag or sha. The run log records the resolved sha.">
                  <input
                    value={task.ref ?? ""}
                    onChange={(e) => patch(i, { ref: e.target.value })}
                    placeholder="HEAD"
                    spellCheck={false}
                    className="mono"
                    style={{
                      ...input,
                      borderColor: refBad(task) ? "var(--err)" : "var(--border)",
                    }}
                  />
                </Field>
              )}
            </div>

            <div style={{ marginTop: 14 }}>
              <Field label={payloadLabel(task)}>
                <textarea
                  value={task.payload}
                  onChange={(e) => patch(i, { payload: e.target.value })}
                  rows={task.repo ? 2 : 5}
                  spellCheck={false}
                  placeholder={payloadPlaceholder(task)}
                  className="mono"
                  style={{ ...input, resize: "vertical", lineHeight: 1.6, fontSize: 12.5 }}
                />
              </Field>
            </div>
          </div>
        ))}
      </div>

      <div style={{ display: "flex", gap: 10, marginTop: 22 }}>
        <button
          type="button"
          onClick={busy ? undefined : save}
          style={{
            background: busy ? "var(--track)" : "var(--accent)",
            color: busy ? "var(--text-dim)" : "var(--on-accent)",
            border: "none",
            borderRadius: 11,
            fontWeight: 600,
            fontSize: 13,
            padding: "9px 20px",
          }}
        >
          {busy ? "Saving…" : editing ? "Save job" : "Create job"}
        </button>
        <button type="button" onClick={() => nav("/jobs")} style={ghost}>
          Cancel
        </button>
      </div>
        </>
      )}
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <div
        style={{
          fontSize: 11,
          letterSpacing: "0.6px",
          textTransform: "uppercase",
          color: "var(--text-faint)",
          marginBottom: 6,
        }}
      >
        {label}
      </div>
      {children}
      {hint && <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 6 }}>{hint}</div>}
    </div>
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
  fontSize: 13,
  outline: "none",
};

const ghost: CSSProperties = {
  background: "var(--surface)",
  color: "var(--text-mid)",
  border: "1px solid var(--border)",
  borderRadius: 11,
  fontSize: 12.5,
  padding: "8px 14px",
};

const iconBtn: CSSProperties = {
  width: 26,
  height: 26,
  borderRadius: 9,
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--text-faint)",
  fontSize: 12,
};

const crumbBtn: CSSProperties = {
  border: "none",
  background: "transparent",
  padding: 0,
  font: "inherit",
  fontSize: 11.5,
  color: "var(--text-dim)",
};
