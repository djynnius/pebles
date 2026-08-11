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


def run_pebbles_task(
    username: str,
    task_type: str,
    payload: str,
    engine: str | None = None,
    catalog: str | None = None,
    mode: str = "shared",
) -> None:
    body: dict = {"username": username, "mode": mode}
    if engine and engine != "main":
        body["engine"] = engine
    status, sess = _call("POST", "/sessions", body)
    if status == 202:
        raise RuntimeError(
            "engine is draining (dedicated reservation pending); task will retry"
        )
    if status != 200:
        raise RuntimeError(f"cannot open session ({status}): {sess.get('error', sess)}")
    session_id = sess["id"]
    print(f"pebbles: session {session_id} opened as {username} (uid {sess.get('uid')})")

    try:
        if task_type == "sql":
            op: dict = {"op": "sql", "sql": payload}
            if catalog:
                op["catalog"] = catalog
            _exec(session_id, op)
        elif task_type in ("python", "r"):
            _exec(session_id, {"op": task_type, "code": payload})
        elif task_type == "shell":
            _exec(session_id, {"op": "shell", "command": payload})
        elif task_type == "notebook":
            # Run every cell of ~/notebooks/<payload>.json, in order (REQ-39).
            got = _exec(session_id, {"op": "read", "path": f"notebooks/{payload}.json"})
            notebook = json.loads(got.get("content", "{}"))
            nb_catalog = notebook.get("catalog") or catalog
            for i, cell in enumerate(notebook.get("cells", [])):
                print(f"pebbles: cell {i} ({cell.get('type', 'sql')})")
                if cell.get("type") in ("python", "r"):
                    _exec(session_id, {"op": cell["type"], "code": cell.get("source", "")})
                else:
                    op = {"op": "sql", "sql": cell.get("source", "")}
                    if nb_catalog:
                        op["catalog"] = nb_catalog
                    _exec(session_id, op)
        else:
            raise RuntimeError(f"unknown task type {task_type!r}")
    finally:
        _call("DELETE", f"/sessions/{session_id}")
        print(f"pebbles: session {session_id} closed")
