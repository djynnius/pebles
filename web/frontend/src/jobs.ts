// Shapes and helpers shared by the Jobs list, the job builder, and the run
// detail. Workflows are pebblesd records (crates/pebblesd/src/jobs.rs) that
// compile to hidden Airflow DAGs — run state comes back read-only from Airflow's
// metadata DB, which is why nothing here ever writes a run.

/** A single step of a workflow. `task_type` is sql|python|r|shell|notebook. */
export interface WorkflowTask {
  id: string;
  task_type: string;
  payload: string;
  engine?: string | null;
  catalog?: string | null;
  mode?: string | null;
  depends_on?: string[];
  retries?: number | null;
  /**
   * REQ-37: a repo name under the user's ~/repos. When set, `payload` is a
   * PATH inside that repo rather than the code itself.
   */
  repo?: string | null;
  /** Branch, tag or sha the path is read at (default HEAD); needs `repo`. */
  ref?: string | null;
}

export interface Workflow {
  name: string;
  /** Owner — every task runs as this user (REQ-41); the server forces it. */
  username: string;
  /** Cron expression, or null for manual-only (REQ-40 subset). */
  schedule: string | null;
  tasks: WorkflowTask[];
}

export interface RunInfo {
  run_id: string;
  state: string;
  start: string;
  end: string;
}

export interface TaskRunInfo {
  task_id: string;
  state: string;
  start: string;
  end: string;
  log: string;
}

export const TASK_TYPES = ["sql", "python", "r", "shell", "notebook"] as const;

/** pebblesd's `valid_name` for workflows, mirrored so the form refuses early. */
export const JOB_NAME = /^[a-z][a-z0-9_-]{0,47}$/;

/**
 * A plausible git rev (REQ-37), mirroring pebblesd's check: no quotes that
 * could escape the generated DAG, no leading '-' that git would read as a flag.
 * The repo name needs no mirror — it comes from a select of the user's repos.
 */
export const GIT_REF = /^[A-Za-z0-9._/-]{1,128}$/;

export function refOk(ref: string): boolean {
  return GIT_REF.test(ref) && !ref.startsWith("-");
}

/** Bar/dot colour for a run or task state (spec §5 "run"). */
export function runColor(state: string): string {
  const s = state.toLowerCase();
  if (s === "success") return "var(--ok)";
  if (s === "failed" || s === "upstream_failed") return "var(--err)";
  if (s === "running" || s === "queued" || s === "scheduled") return "var(--accent)";
  if (s === "skipped" || s === "removed" || s === "" ) return "var(--text-dim)";
  return "var(--accent-ink)";
}

/** True while a run/task is still moving — the 5 s refresh loop keys off this. */
export function isLive(state: string): boolean {
  const s = state.toLowerCase();
  return s === "running" || s === "queued" || s === "scheduled" || s === "up_for_retry";
}

/** Airflow timestamps arrive as Postgres text; show seconds, drop the zone. */
export function stamp(value: string | null | undefined): string {
  if (!value) return "—";
  return value.replace("T", " ").slice(0, 19);
}

/** Elapsed time between two Airflow timestamps, or "" when unknowable. */
export function duration(start: string, end: string): string {
  if (!start || !end) return "";
  const a = Date.parse(start.replace(" ", "T"));
  const b = Date.parse(end.replace(" ", "T"));
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return "";
  const secs = Math.round((b - a) / 1000);
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, "0")}s`;
}

/*
 * Scheduler preferences the Workflow API does not model yet (catch-up and
 * overlap are DAG-level Airflow knobs; the compiler currently hard-codes
 * catchup=False). They live in this browser so the builder can carry the intent
 * without pretending the server stored it — the builder says so on screen.
 */
export interface JobPrefs {
  catchup: boolean;
  overlap: boolean;
}

const PREFS_KEY = "pebbles.jobprefs.v1";

export const DEFAULT_PREFS: JobPrefs = { catchup: false, overlap: false };

export function loadPrefs(name: string): JobPrefs {
  try {
    const all = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}");
    const one = all?.[name];
    if (one && typeof one === "object") {
      return { catchup: Boolean(one.catchup), overlap: Boolean(one.overlap) };
    }
  } catch {
    /* corrupt storage is not worth a crash */
  }
  return { ...DEFAULT_PREFS };
}

export function savePrefs(name: string, prefs: JobPrefs): void {
  try {
    const all = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}");
    all[name] = prefs;
    localStorage.setItem(PREFS_KEY, JSON.stringify(all));
  } catch {
    /* storage full or blocked — the preference is cosmetic, keep going */
  }
}
