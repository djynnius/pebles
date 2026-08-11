"""Client for pebblesd's privileged API over its unix socket.

This hand-written stub will be REPLACED by a client generated from pebblesd's
OpenAPI schema (`cargo run -p xtask -- api-schema`); CI's api-drift job enforces
that the generated client stays current. Do not grow ad-hoc methods here.

Stdlib-only on purpose: the web tier's path to privilege should have no clever
dependencies in it.
"""

from __future__ import annotations

import http.client
import json
import os
import socket

DEFAULT_SOCKET = "/run/pebbles/pebblesd.sock"


class _UnixHTTPConnection(http.client.HTTPConnection):
    def __init__(self, socket_path: str, timeout: float = 10.0):
        super().__init__("localhost", timeout=timeout)
        self._socket_path = socket_path

    def connect(self) -> None:
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(self.timeout)
        sock.connect(self._socket_path)
        self.sock = sock


class PebblesdClient:
    def __init__(self, socket_path: str | None = None):
        self.socket_path = socket_path or os.environ.get("PEBBLES_SOCKET", DEFAULT_SOCKET)

    def _request(  # body may be a dict or a list; both encode as JSON
        self, method: str, path: str, body=None
    ) -> tuple[int, dict]:
        conn = _UnixHTTPConnection(self.socket_path)
        try:
            headers = {}
            payload = None
            if body is not None:
                payload = json.dumps(body)
                headers["Content-Type"] = "application/json"
            conn.request(method, path, body=payload, headers=headers)
            resp = conn.getresponse()
            raw = resp.read()
            return resp.status, json.loads(raw) if raw else {}
        finally:
            conn.close()

    def _get(self, path: str) -> dict:
        status, data = self._request("GET", path)
        if status != 200:
            raise RuntimeError(f"pebblesd GET {path} -> {status}: {data}")
        return data

    def health(self) -> dict:
        return self._get("/healthz")

    def version(self) -> dict:
        return self._get("/version")

    def login(self, username: str, password: str) -> dict | None:
        """Verified identity dict on success, None on bad credentials."""
        status, data = self._request(
            "POST", "/auth/login", {"username": username, "password": password}
        )
        if status == 200:
            return data
        if status == 401:
            return None
        raise RuntimeError(f"pebblesd POST /auth/login -> {status}: {data}")

    def _expect(self, method: str, path: str, body: dict | None = None) -> dict:
        status, data = self._request(method, path, body)
        if status // 100 == 2:
            return data
        raise PebblesdError(status, data.get("error", str(data)))

    def open_session(self, username: str) -> dict:
        return self._expect("POST", "/sessions", {"username": username})

    def exec_in_session(self, session_id: int, payload: dict) -> dict:
        return self._expect("POST", f"/sessions/{session_id}/exec", payload)

    def list_catalogs(self) -> list:
        status, data = self._request("GET", "/catalogs")
        if status != 200:
            raise PebblesdError(status, str(data))
        return data

    def list_engines(self) -> list:
        status, data = self._request("GET", "/engines")
        if status != 200:
            raise PebblesdError(status, str(data))
        return data

    def list_users(self) -> list:
        status, data = self._request("GET", "/users")
        if status != 200:
            raise PebblesdError(status, str(data))
        return data

    def create_user(self, username: str, password: str) -> dict:
        return self._expect("POST", "/users", {"username": username, "password": password})

    def list_groups(self) -> list:
        status, data = self._request("GET", "/groups")
        if status != 200:
            raise PebblesdError(status, str(data))
        return data

    def create_group(self, name: str) -> dict:
        return self._expect("POST", "/groups", {"name": name})

    def add_group_member(self, group: str, username: str) -> dict:
        return self._expect("POST", f"/groups/{group}/members", {"username": username})

    def grant_catalog(self, catalog: str, group: str) -> dict:
        return self._expect("POST", f"/catalogs/{catalog}/grants", {"group": group})

    def list_workflows(self) -> list:
        status, data = self._request("GET", "/workflows")
        if status != 200:
            raise PebblesdError(status, str(data))
        return data

    def save_workflow(self, workflow: dict) -> dict:
        return self._expect("POST", "/workflows", workflow)

    def trigger_workflow(self, name: str) -> dict:
        return self._expect("POST", f"/workflows/{name}/run")

    def workflow_runs(self, name: str) -> list:
        status, data = self._request("GET", f"/workflows/{name}/runs")
        if status != 200:
            raise PebblesdError(status, str(data))
        return data

    def workflow_run_detail(self, name: str, run_id: str) -> list:
        status, data = self._request("GET", f"/workflows/{name}/runs/{run_id}")
        if status != 200:
            raise PebblesdError(status, str(data))
        return data

    def usage(self) -> dict:
        return self._get("/usage")

    def list_tokens(self) -> list:
        status, data = self._request("GET", "/cluster/tokens")
        if status != 200:
            raise PebblesdError(status, str(data))
        return data

    def mint_token(self) -> dict:
        return self._expect("POST", "/cluster/tokens")

    def revoke_token(self, token_id: str) -> dict:
        return self._expect("DELETE", f"/cluster/tokens/{token_id}")

    def list_pending_engines(self) -> list:
        status, data = self._request("GET", "/engines/pending")
        if status != 200:
            raise PebblesdError(status, str(data))
        return data

    def approve_pending_engine(self, name: str) -> dict:
        return self._expect("POST", f"/engines/pending/{name}/approve")

    def reject_pending_engine(self, name: str) -> dict:
        return self._expect("DELETE", f"/engines/pending/{name}")

    def deregister_engine(self, name: str) -> dict:
        return self._expect("DELETE", f"/engines/{name}")

    def cancel_reservation(self, engine: str | None = None) -> dict:
        path = "/sessions/reservation"
        if engine and engine != "main":
            path += f"?engine={engine}"
        return self._expect("DELETE", path)

    def create_catalog(self, name: str, owner: str) -> dict:
        return self._expect("POST", "/catalogs", {"name": name, "owner": owner})


class PebblesdError(RuntimeError):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message
