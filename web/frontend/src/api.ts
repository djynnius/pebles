// The SPA's only channel to the backend: JSON over /api/*. Flask handles the
// session cookie, auth, and proxies pebblesd — the browser never sees the
// privileged socket (NFR-01).

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    throw new ApiError(res.status, data.error ?? res.statusText);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body ?? {}),
  put: <T>(path: string, body?: unknown) => request<T>("PUT", path, body ?? {}),
  del: <T>(path: string) => request<T>("DELETE", path),
};

export interface User {
  username: string;
  uid: number;
}

/** A row of a query result — DuckDB values arrive as JSON scalars. */
export type Row = Record<string, unknown>;

export interface SqlResult {
  ok: boolean;
  rows?: Row[];
  error?: string;
}

export interface SseHandlers {
  status?: (data: Record<string, unknown>) => void;
  result?: (data: SqlResult) => void;
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
  es.addEventListener("result", (e) => handlers.result?.(JSON.parse((e as MessageEvent).data)));
  es.addEventListener("error", (e) => {
    const data = (e as MessageEvent).data as string | undefined;
    if (data) {
      handlers.error?.(JSON.parse(data).error ?? "query failed");
    } else {
      // transport-level failure (auth, 4xx, dropped connection)
      handlers.error?.("The query stream closed unexpectedly.");
      finish();
    }
  });
  es.addEventListener("done", finish);
  return () => {
    finished = true;
    es.close();
  };
}
