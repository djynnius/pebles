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

DEFAULT_SOCKET = "/var/lib/pebbles/pebblesd.sock"


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

    def _get(self, path: str) -> dict:
        conn = _UnixHTTPConnection(self.socket_path)
        try:
            conn.request("GET", path)
            resp = conn.getresponse()
            body = resp.read()
            if resp.status != 200:
                raise RuntimeError(f"pebblesd GET {path} -> {resp.status}: {body[:200]!r}")
            return json.loads(body)
        finally:
            conn.close()

    def health(self) -> dict:
        return self._get("/healthz")

    def version(self) -> dict:
        return self._get("/version")
