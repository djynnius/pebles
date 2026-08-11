"""Pebbles web tier.

Boundary rule (NFR-01): this app never touches a container socket, never runs as
root, never spawns user processes, never reads another user's files. Every
privileged action is an API call to pebblesd over its unix socket, via
`pebblesd_client` — which will be generated from pebblesd's OpenAPI schema.
"""

from flask import Flask, jsonify, render_template


def create_app() -> Flask:
    app = Flask(__name__)

    @app.get("/healthz")
    def healthz():  # pyright: ignore[reportUnusedFunction]
        return jsonify({"status": "ok", "service": "pebbles-web"})

    @app.get("/")
    def index():  # pyright: ignore[reportUnusedFunction]
        return render_template("index.html")

    return app
