"""The Pebbles task bridge (REQ-41).

Every generated DAG's tasks call `run_pebbles_task`, which executes the work
through pebblesd's privileged socket: open a session AS THE WORKFLOW OWNER on the
chosen engine, run the payload (sql / python / r / shell / notebook), close. The
Airflow worker itself never touches user files or runs user code — identity and
permissions are exactly those of an interactive session.

Stdlib-only on purpose (this file lives on Airflow's import path, but imports
nothing from Airflow and nothing from the user stack).
"""

from __future__ import annotations

import http.client
import json
import os
import socket

SOCKET_PATH = os.environ.get("PEBBLES_SOCKET", "/run/pebbles/pebblesd.sock")


class _UnixHTTPConnection(http.client.HTTPConnection):
    def __init__(self, socket_path: str, timeout: float = 600.0):
        super().__init__("pebblesd", timeout=timeout)
        self._socket_path = socket_path

    def connect(self) -> None:
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(self.timeout)
        sock.connect(self._socket_path)
        self.sock = sock


def _call(method: str, path: str, body: dict | None = None) -> tuple[int, dict]:
    conn = _UnixHTTPConnection(SOCKET_PATH)
    try:
        payload = json.dumps(body) if body is not None else None
        headers = {"Content-Type": "application/json"} if payload else {}
        conn.request(method, path, body=payload, headers=headers)
        resp = conn.getresponse()
        raw = resp.read()
        return resp.status, json.loads(raw) if raw else {}
    finally:
        conn.close()


#: A full engine (409 admission refusal) is transient: interactive sessions
#: idle out and other tasks finish. Wait it out instead of failing the run.
ADMISSION_RETRIES = int(os.environ.get("PEBBLES_JOB_ADMISSION_RETRIES", "20"))
ADMISSION_WAIT_SECS = float(os.environ.get("PEBBLES_JOB_ADMISSION_WAIT", "30"))


def _open_with_backoff(body: dict) -> tuple[int, dict]:
    import time

    status, sess = _call("POST", "/sessions", body)
    attempt = 0
    while status == 409 and "admitting this session" in str(sess.get("error", "")):
        attempt += 1
        if attempt > ADMISSION_RETRIES:
            break
        print(
            f"pebbles: engine full ({sess.get('error')}); "
            f"waiting {ADMISSION_WAIT_SECS:.0f}s (attempt {attempt}/{ADMISSION_RETRIES})"
        )
        time.sleep(ADMISSION_WAIT_SECS)
        status, sess = _call("POST", "/sessions", body)
    return status, sess


def _exec(session_id: int, payload: dict) -> dict:
    status, data = _call("POST", f"/sessions/{session_id}/exec", payload)
    if status != 200:
        raise RuntimeError(f"exec failed ({status}): {data.get('error', data)}")
    if not data.get("ok"):
        raise RuntimeError(f"task step failed: {data.get('error', 'unknown error')}")
    # Surface output into the Airflow task log (REQ-42).
    for key in ("stdout", "stderr"):
        if data.get(key):
            print(data[key], end="" if str(data[key]).endswith("\n") else "\n")
    if data.get("rows") is not None:
        print(json.dumps(data["rows"])[:65536])
    return data


def _git(session_id: int, repo: str, args: list) -> dict:
    """A git call in the session that may legitimately fail (returns the raw
    envelope instead of raising, unlike _exec)."""
    status, data = _call(
        "POST",
        f"/sessions/{session_id}/exec",
        {"op": "git", "args": args, "cwd": f"repos/{repo}"},
    )
    if status != 200:
        raise RuntimeError(f"exec failed ({status}): {data.get('error', data)}")
    return data


def _resolve_repo_content(session_id: int, repo: str, ref: str | None, path: str) -> str:
    """REQ-37: pin `ref` (default HEAD) to a commit sha and read `path` at that
    sha via `git show` — reproducible, and the user's working tree is never
    touched. A ref that isn't local yet gets one `git fetch` attempt (offline
    repos still work when the ref resolves locally)."""
    want = ref or "HEAD"
    resolved = _git(session_id, repo, ["rev-parse", "--verify", f"{want}^{{commit}}"])
    if not resolved.get("ok"):
        print(f"pebbles: ref {want!r} not local, fetching")
        _git(session_id, repo, ["fetch", "--all", "--tags"])
        resolved = _git(session_id, repo, ["rev-parse", "--verify", f"{want}^{{commit}}"])
    if not resolved.get("ok"):
        raise RuntimeError(f"cannot resolve ref {want!r} in repo {repo!r}")
    sha = resolved.get("stdout", "").strip()
    print(f"pebbles: repo {repo} ref {want} = {sha}")  # reproducibility record (REQ-42)
    shown = _git(session_id, repo, ["show", f"{sha}:{path}"])
    if not shown.get("ok"):
        raise RuntimeError(
            f"cannot read {path!r} at {sha[:12]} in repo {repo!r}: "
            f"{shown.get('stderr') or shown.get('error', '')}"
        )
    return shown.get("stdout", "")


def _run_notebook(session_id: int, content: str, catalog: str | None) -> None:
    notebook = json.loads(content or "{}")
    nb_catalog = notebook.get("catalog") or catalog
    for i, cell in enumerate(notebook.get("cells", [])):
        if cell.get("type") == "md":
            continue  # markdown documents; it never runs
        print(f"pebbles: cell {i} ({cell.get('type', 'sql')})")
        if cell.get("type") in ("python", "r"):
            _exec(session_id, {"op": cell["type"], "code": cell.get("source", "")})
        else:
            op = {"op": "sql", "sql": cell.get("source", "")}
            if nb_catalog:
                op["catalog"] = nb_catalog
            _exec(session_id, op)


def run_pebbles_task(
    username: str,
    task_type: str,
    payload: str,
    engine: str | None = None,
    catalog: str | None = None,
    mode: str = "shared",
    repo: str | None = None,
    ref: str | None = None,
) -> None:
    body: dict = {"username": username, "mode": mode}
    if engine and engine != "main":
        body["engine"] = engine
    status, sess = _open_with_backoff(body)
    if status == 202:
        raise RuntimeError(
            "engine is draining (dedicated reservation pending); task will retry"
        )
    if status != 200:
        raise RuntimeError(f"cannot open session ({status}): {sess.get('error', sess)}")
    session_id = sess["id"]
    print(f"pebbles: session {session_id} opened as {username} (uid {sess.get('uid')})")

    try:
        # REQ-37: with a repo, `payload` is a path INSIDE the repo and the
        # content comes from the pinned ref, not the working tree.
        content = (
            _resolve_repo_content(session_id, repo, ref, payload) if repo else payload
        )
        if task_type == "sql":
            op: dict = {"op": "sql", "sql": content}
            if catalog:
                op["catalog"] = catalog
            _exec(session_id, op)
        elif task_type in ("python", "r"):
            _exec(session_id, {"op": task_type, "code": content})
        elif task_type == "shell":
            _exec(session_id, {"op": "shell", "command": content})
        elif task_type == "notebook":
            if not repo:
                # Run every cell of ~/notebooks/<payload>.json, in order (REQ-39).
                got = _exec(
                    session_id, {"op": "read", "path": f"notebooks/{payload}.json"}
                )
                content = got.get("content", "{}")
            _run_notebook(session_id, content, catalog)
        else:
            raise RuntimeError(f"unknown task type {task_type!r}")
    finally:
        _call("DELETE", f"/sessions/{session_id}")
        print(f"pebbles: session {session_id} closed")
