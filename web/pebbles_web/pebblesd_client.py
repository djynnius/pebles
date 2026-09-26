"""Client for pebblesd's privileged API over its unix socket.

Hand-written and stdlib-only on purpose: the web tier's path to privilege
should have no clever dependencies in it. Method names and shapes mirror
pebblesd's routes one-to-one (crates/pebblesd/src/api.rs); when a route
changes there, change it here in the same commit.
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

    def open_session(self, username: str, reuse: bool = True) -> dict:
        """The user's interactive session. `reuse` (the default for the web
        tier) returns their live session instead of forking a new kernel per
        login/cookie — pebblesd serializes this so parallel first requests
        converge on one session."""
        return self._expect("POST", "/sessions", {"username": username, "reuse": reuse})

    def close_session(self, session_id: int) -> dict:
        return self._expect("DELETE", f"/sessions/{session_id}")

    def exec_in_session(self, session_id: int, payload: dict) -> dict:
        return self._expect("POST", f"/sessions/{session_id}/exec", payload)

    def exec_stream(self, session_id: int, payload: dict):
        """Progressive exec (op sql_stream, REQ-31): yields each NDJSON line
        from pebblesd as a dict — row batches, then the terminal done-line.
        The connection stays open for the duration of the query."""
        conn = _UnixHTTPConnection(self.socket_path, timeout=600.0)
        try:
            body = json.dumps(payload)
            conn.request(
                "POST",
                f"/sessions/{session_id}/exec",
                body=body,
                headers={"Content-Type": "application/json"},
            )
            resp = conn.getresponse()
            if resp.status != 200:
                raw = resp.read()
                data = json.loads(raw) if raw else {}
                raise PebblesdError(resp.status, data.get("error", str(data)))
            # http.client de-chunks transparently; readline gives us NDJSON.
            while True:
                line = resp.readline()
                if not line:
                    break
                line = line.strip()
                if not line:
                    continue
                msg = json.loads(line)
                yield msg
                if msg.get("done"):
                    break
        finally:
            conn.close()

    def list_catalogs(self, user: str | None = None) -> list:
        """With `user`, each catalog carries `accessible` for that user."""
        path = f"/catalogs?user={user}" if user else "/catalogs"
        status, data = self._request("GET", path)
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

    def delete_user(self, username: str, remove_home: bool = False) -> dict:
        q = "?remove_home=true" if remove_home else ""
        return self._expect("DELETE", f"/users/{username}{q}")

    def set_password(self, username: str, password: str) -> dict:
        return self._expect("POST", f"/users/{username}/password", {"password": password})

    def set_disabled(self, username: str, disabled: bool) -> dict:
        return self._expect("POST", f"/users/{username}/disabled", {"disabled": disabled})

    def delete_group(self, name: str) -> dict:
        return self._expect("DELETE", f"/groups/{name}")

    def set_engine_access(self, name: str, access: str) -> dict:
        return self._expect("POST", f"/engines/{name}/access", {"access": access})

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

    def remove_group_member(self, group: str, username: str) -> dict:
        return self._expect("DELETE", f"/groups/{group}/members/{username}")

    def grant_catalog(self, catalog: str, group: str) -> dict:
        return self._expect("POST", f"/catalogs/{catalog}/grants", {"group": group})

    def list_catalog_grants(self, catalog: str) -> list:
        status, data = self._request("GET", f"/catalogs/{catalog}/grants")
        if status != 200:
            raise PebblesdError(status, str(data))
        return data

    def list_workflows(self) -> list:
        status, data = self._request("GET", "/workflows")
        if status != 200:
            raise PebblesdError(status, str(data))
        return data

    def save_workflow(self, workflow: dict) -> dict:
        return self._expect("POST", "/workflows", workflow)

    def trigger_workflow(self, name: str) -> dict:
        """Queues a run (202-style {"queued": name}); poll trigger_status."""
        return self._expect("POST", f"/workflows/{name}/run")

    def trigger_status(self, name: str):
        """{state: queued|triggered|failed, error, at} of the last Run now."""
        return self._get(f"/workflows/{name}/trigger")

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

    def nkoyo_config(self) -> dict:
        return self._get("/nkoyo/config")

    def nkoyo_config_save(self, cfg: dict) -> dict:
        return self._expect("POST", "/nkoyo/config", cfg)

    def nkoyo_rescan(self) -> list:
        status, data = self._request("POST", "/nkoyo/rescan")
        if status != 200:
            raise PebblesdError(status, str(data))
        return data

    def nkoyo_chat(self, username: str, messages: list, approved: list | None = None) -> dict:
        return self._expect(
            "POST",
            "/nkoyo/chat",
            {"username": username, "messages": messages, "approved": approved or []},
        )

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
