// The SPA's only channel to the backend: JSON over /api/*. Flask handles the
// session cookie, auth, and proxies pebblesd — the browser never sees the
// privileged socket (NFR-01).

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    /** The parsed JSON body of the failed response (`{}` when none). */
    public data: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/**
 * A single place that notices the session died. Flask answers 401 to every
 * /api call once the cookie expires, so instead of 23 screens each inventing
 * their own broken state, App registers one handler here and resets to Login
 * (REQ-49). Screens still see the rejection and can stop their own work.
 */
type Unauthorized = () => void;
let onUnauthorized: Unauthorized | null = null;

export function setUnauthorizedHandler(fn: Unauthorized | null): void {
  onUnauthorized = fn;
}

/** The one sentence a screen shows when pebblesd/Flask cannot be reached. */
export const OFFLINE = "Can't reach Pebbles — the control plane may be restarting.";

/** Normalises anything a `.catch` can receive into a sentence worth showing. */
export function errorText(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof TypeError) return OFFLINE; // fetch's network failure
  if (e instanceof Error && e.message) return e.message;
  return String(e);
}

function check(res: Response, data: { error?: string }): void {
  if (res.ok) return;
  if (res.status === 401) onUnauthorized?.();
  throw new ApiError(res.status, data.error ?? res.statusText, data as Record<string, unknown>);
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: "same-origin",
    });
  } catch {
    throw new ApiError(0, OFFLINE);
  }
  const text = await res.text();
  let data: { error?: string } = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    // A proxy or crash page can answer HTML; the status still tells the story.
    data = { error: text.slice(0, 200) || res.statusText };
  }
  check(res, data);
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body ?? {}),
  put: <T>(path: string, body?: unknown) => request<T>("PUT", path, body ?? {}),
  del: <T>(path: string) => request<T>("DELETE", path),
  /** Multipart upload — same error and 401 handling as the JSON calls. */
  upload: async <T>(path: string, body: FormData): Promise<T> => {
    let res: Response;
    try {
      res = await fetch(`/api${path}`, { method: "POST", body, credentials: "same-origin" });
    } catch {
      throw new ApiError(0, OFFLINE);
    }
    const text = await res.text();
    let data: { error?: string } = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { error: text.slice(0, 200) || res.statusText };
    }
    check(res, data);
    return data as T;
  },
};

export interface User {
  username: string;
  uid: number;
  /** Member of the UNIX group `admins`; gates the Admin UI (server enforces 403). */
  admin?: boolean;
}

/** A row of a query result — DuckDB values arrive as JSON scalars. */
export type Row = Record<string, unknown>;

/**
 * The column list of a result, in SELECT order. The wire preserves column
 * order in each row object, so this is `Object.keys(firstRow)` — extended with
 * any key a later row adds, in first-seen order. Never sort these.
 */
export function columnsOf(rows: readonly Row[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of rows) {
    for (const k of Object.keys(r)) {
      if (!seen.has(k)) {
        seen.add(k);
        out.push(k);
      }
    }
  }
  return out;
}

export interface SqlResult {
  ok: boolean;
  rows?: Row[];
  error?: string;
}

export interface SseHandlers {
  status?: (data: Record<string, unknown>) => void;
  /** Progressive row batches (REQ-31): fires as the engine produces rows,
   * before the final `result` (which carries the complete set). */
  rows?: (data: { rows: Row[] }) => void;
  result?: (data: SqlResult & { truncated?: boolean }) => void;
  error?: (message: string) => void;
  /** Fires exactly once, after the stream closes (success or failure). */
  done?: () => void;
}

/**
 * Subscribe to one of the `text/event-stream` endpoints (REQ-31 wire shape:
 * status → result|error → done). Returns a cancel function; calling it stops
 * the stream without firing `done`.
 *
 * Note the deliberate collision: the server's named `error` event and
 * EventSource's own transport error both dispatch as type "error". The former
 * carries `.data`, the latter does not — that is how we tell them apart.
 */
export function sse(path: string, handlers: SseHandlers): () => void {
  const es = new EventSource(`/api${path}`);
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    es.close();
    handlers.done?.();
  };
  es.addEventListener("status", (e) => handlers.status?.(JSON.parse((e as MessageEvent).data)));
  es.addEventListener("rows", (e) => handlers.rows?.(JSON.parse((e as MessageEvent).data)));
  es.addEventListener("result", (e) => handlers.result?.(JSON.parse((e as MessageEvent).data)));
  es.addEventListener("error", (e) => {
    const data = (e as MessageEvent).data as string | undefined;
    if (data) {
      handlers.error?.(JSON.parse(data).error ?? "query failed");
    } else {
      // Transport-level failure (auth, 4xx, dropped connection). EventSource
      // hides the status code, so ask /me whether the session is what died —
      // that call routes through the 401 handler and resets to Login.
      handlers.error?.("The query stream closed unexpectedly.");
      void api.get("/me").catch(() => {});
      finish();
    }
  });
  es.addEventListener("done", finish);
  return () => {
    finished = true;
    es.close();
  };
}
