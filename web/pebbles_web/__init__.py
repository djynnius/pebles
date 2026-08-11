"""Pebbles web tier.

Boundary rule (NFR-01): this app never touches a container socket, never runs as
root, never spawns user processes, never reads another user's files. Every
privileged action is an API call to pebblesd over its unix socket, via
`pebblesd_client` — which will be generated from pebblesd's OpenAPI schema.
"""

import os

from flask import Flask, jsonify, redirect, render_template, request, session, url_for

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

    @app.get("/login")
    def login_form():  # pyright: ignore[reportUnusedFunction]
        return render_template("login.html")

    @app.post("/login")
    def login():  # pyright: ignore[reportUnusedFunction]
        identity = client.login(
            request.form.get("username", ""), request.form.get("password", "")
        )
        if identity is None:
            return render_template("login.html", error="Invalid username or password."), 401
        session["user"] = identity
        return redirect(url_for("index"))

    @app.get("/logout")
    def logout():  # pyright: ignore[reportUnusedFunction]
        session.clear()
        return redirect(url_for("login_form"))

    @app.get("/")
    def index():  # pyright: ignore[reportUnusedFunction]
        user = session.get("user")
        if user is None:
            return redirect(url_for("login_form"))
        return render_template("index.html", user=user)

    return app
