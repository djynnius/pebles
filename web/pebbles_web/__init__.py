"""Pebbles web tier.

Boundary rule (NFR-01): this app never touches a container socket, never runs as
root, never spawns user processes, never reads another user's files. Every
privileged action is an API call to pebblesd over its unix socket, via the
hand-written `pebblesd_client` (stdlib-only by design).

The UI is the React SPA (built from web/frontend into static/app); Flask serves
its index for every non-API GET and exposes the JSON surface under /api
(`pebbles_web.api`). The former server-rendered Jinja UI is gone.
"""

import os

from flask import Flask, jsonify, redirect, request
from werkzeug.exceptions import NotFound

from pebbles_web.api import register_api
from pebbles_web.pebblesd_client import PebblesdClient


def _secret_key() -> bytes:
    """pebblesd provisions a stable secret in the config volume so session cookies
    survive worker restarts; a dev run without one gets an ephemeral key."""
    path = os.environ.get("PEBBLES_WEB_SECRET_FILE")
    if path:
        with open(path, "rb") as f:
            return f.read()
    return os.urandom(32)


def create_app(pebblesd: PebblesdClient | None = None) -> Flask:
    app = Flask(__name__)
    app.secret_key = _secret_key()
    client = pebblesd or PebblesdClient()

    # The SPA's JSON API — every /api/* route (pebbles_web/api.py).
    register_api(app, client)

    @app.get("/healthz")
    def healthz():  # pyright: ignore[reportUnusedFunction]
        payload: dict = {"service": "pebbles-web", "status": "ok"}
        try:
            daemon = client.health()
        # Socket/protocol failures mean degraded, not dead: the web tier itself is up.
        except (OSError, RuntimeError, ValueError) as exc:
            payload["status"] = "degraded"
            payload["pebblesd"] = {"error": str(exc)}
            return jsonify(payload), 503
        payload["pebblesd"] = daemon
        payload["role"] = daemon.get("role")
        return jsonify(payload)

    # /app was the SPA's address while the Jinja UI held /; keep old links alive.
    @app.get("/app")
    @app.get("/app/")
    @app.get("/app/<path:sub>")
    def spa_legacy(sub=""):  # pyright: ignore[reportUnusedFunction]
        return redirect(f"/{sub}", code=301)

    # The SPA owns every other path: client-side routing gets the index for any
    # GET that isn't /api, /healthz, or a real static asset.
    @app.get("/")
    @app.get("/<path:_any>")
    def spa(_any=""):  # pyright: ignore[reportUnusedFunction]
        if request.path.startswith("/api/"):
            # An undefined API path must read as an API error, not as HTML.
            return jsonify({"error": "no such endpoint"}), 404
        try:
            return app.send_static_file("app/index.html")
        except NotFound:
            return (
                "React bundle not built — run `npm --prefix web/frontend run build`.",
                503,
            )

    return app
