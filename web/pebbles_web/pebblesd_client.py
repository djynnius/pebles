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

    def _request(self, method: str, path: str, body: dict | None = None) -> tuple[int, dict]:
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
