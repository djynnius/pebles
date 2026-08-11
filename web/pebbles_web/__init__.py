"""Pebbles web tier.

Boundary rule (NFR-01): this app never touches a container socket, never runs as
root, never spawns user processes, never reads another user's files. Every
privileged action is an API call to pebblesd over its unix socket, via
`pebblesd_client` — which will be generated from pebblesd's OpenAPI schema.
"""

from flask import Flask, jsonify, render_template

from pebbles_web.pebblesd_client import PebblesdClient


def create_app(pebblesd: PebblesdClient | None = None) -> Flask:
    app = Flask(__name__)
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

    @app.get("/")
    def index():  # pyright: ignore[reportUnusedFunction]
        return render_template("index.html")

    return app
