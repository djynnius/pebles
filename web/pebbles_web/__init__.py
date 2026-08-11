"""Pebbles web tier.

Boundary rule (NFR-01): this app never touches a container socket, never runs as
root, never spawns user processes, never reads another user's files. Every
privileged action is an API call to pebblesd over its unix socket, via
`pebblesd_client` — which will be generated from pebblesd's OpenAPI schema.
"""

import json
import os

from flask import (
    Flask,
    Response,
    jsonify,
    redirect,
    render_template,
    request,
    session,
    url_for,
)

from pebbles_web.pebblesd_client import PebblesdClient, PebblesdError


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

    def _engine_session_id(username: str) -> int:
        """The signed-in user's engine session, opened lazily. The id lives in the
        cookie session; a reaped/lost engine session is reopened transparently."""
        sid = session.get("engine_session")
        if sid is None:
            sid = client.open_session(username)["id"]
            session["engine_session"] = sid
        return sid

    def _run_sql(username: str, sql: str, catalog: str | None) -> dict:
        payload: dict = {"op": "sql", "sql": sql}
        if catalog:
            payload["catalog"] = catalog
        sid = _engine_session_id(username)
        try:
            return client.exec_in_session(sid, payload)
        except PebblesdError as exc:
            if exc.status != 404:
                raise
            # Session idled out or the daemon restarted: open a fresh one, retry once.
            session.pop("engine_session", None)
            return client.exec_in_session(_engine_session_id(username), payload)

    @app.get("/sql")
    def sql_editor():  # pyright: ignore[reportUnusedFunction]
        user = session.get("user")
        if user is None:
            return redirect(url_for("login_form"))
        try:
            catalogs = client.list_catalogs()
        except (OSError, RuntimeError, ValueError):
            catalogs = []
        return render_template("sql.html", user=user, catalogs=catalogs)

    @app.get("/sql/stream")
    def sql_stream():  # pyright: ignore[reportUnusedFunction]
        user = session.get("user")
        if user is None:
            return jsonify({"error": "not signed in"}), 401
        sql = request.args.get("q", "").strip()
        catalog = request.args.get("catalog") or None
        if not sql:
            return jsonify({"error": "empty query"}), 422

        def sse(event: str, data: dict) -> str:
            return f"event: {event}\ndata: {json.dumps(data)}\n\n"

        # The engine session must be resolved here — the generator below runs after
        # the request context (and its cookie session) is gone.
        try:
            result = None
            error = None
            result = _run_sql(user["username"], sql, catalog)
        except (OSError, RuntimeError, ValueError) as exc:
            error = str(exc)

        def stream():
            yield sse("status", {"state": "running"})
            if error is not None:
                yield sse("error", {"error": error})
            elif result and result.get("ok"):
                yield sse("result", result)
            else:
                yield sse("error", {"error": (result or {}).get("error", "query failed")})
            yield sse("done", {})

        return Response(
            stream(),
            mimetype="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    @app.get("/engines")
    def engines_page():  # pyright: ignore[reportUnusedFunction]
        user = session.get("user")
        if user is None:
            return redirect(url_for("login_form"))
        try:
            engines = client.list_engines()
        except (OSError, RuntimeError, ValueError):
            engines = []
        return render_template("engines.html", user=user, engines=engines)

    @app.get("/catalogs")
    def catalogs_page():  # pyright: ignore[reportUnusedFunction]
        user = session.get("user")
        if user is None:
            return redirect(url_for("login_form"))
        try:
            catalogs = client.list_catalogs()
        except (OSError, RuntimeError, ValueError):
            catalogs = []
        return render_template("catalogs.html", user=user, catalogs=catalogs)

    @app.post("/catalogs")
    def create_catalog():  # pyright: ignore[reportUnusedFunction]
        user = session.get("user")
        if user is None:
            return redirect(url_for("login_form"))
        name = request.form.get("name", "").strip()
        try:
            client.create_catalog(name, user["username"])
        except PebblesdError as exc:
            catalogs = client.list_catalogs()
            return (
                render_template(
                    "catalogs.html", user=user, catalogs=catalogs, error=exc.message
                ),
                exc.status if exc.status in (409, 422) else 500,
            )
        return redirect(url_for("catalogs_page"))

    return app
