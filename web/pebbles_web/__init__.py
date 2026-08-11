"""Pebbles web tier.

Boundary rule (NFR-01): this app never touches a container socket, never runs as
root, never spawns user processes, never reads another user's files. Every
privileged action is an API call to pebblesd over its unix socket, via
`pebblesd_client` — which will be generated from pebblesd's OpenAPI schema.
"""

import json
import os
import re

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

    def _admin_page(template: str, **fetches):
        user = session.get("user")
        if user is None:
            return None, redirect(url_for("login_form"))
        data = {}
        for key, fetch in fetches.items():
            try:
                data[key] = fetch()
            except (OSError, RuntimeError, ValueError):
                data[key] = []
        return (template, {"user": user, **data}), None

    @app.get("/users")
    def users_page():  # pyright: ignore[reportUnusedFunction]
        page, redir = _admin_page("users.html", users=client.list_users)
        return redir or render_template(page[0], **page[1])

    @app.post("/users")
    def users_create():  # pyright: ignore[reportUnusedFunction]
        if session.get("user") is None:
            return redirect(url_for("login_form"))
        try:
            client.create_user(
                request.form.get("username", "").strip(), request.form.get("password", "")
            )
        except PebblesdError as exc:
            page, _ = _admin_page("users.html", users=client.list_users)
            return render_template(page[0], **page[1], error=exc.message), exc.status
        return redirect(url_for("users_page"))

    @app.get("/groups")
    def groups_page():  # pyright: ignore[reportUnusedFunction]
        page, redir = _admin_page(
            "groups.html",
            groups=client.list_groups,
            users=client.list_users,
            catalogs=client.list_catalogs,
        )
        return redir or render_template(page[0], **page[1])

    @app.post("/groups")
    def groups_create():  # pyright: ignore[reportUnusedFunction]
        if session.get("user") is None:
            return redirect(url_for("login_form"))
        try:
            action = request.form.get("action", "create")
            if action == "create":
                client.create_group(request.form.get("name", "").strip())
            elif action == "add-member":
                client.add_group_member(
                    request.form.get("group", ""), request.form.get("username", "")
                )
            elif action == "grant-catalog":
                client.grant_catalog(
                    request.form.get("catalog", ""), request.form.get("group", "")
                )
        except PebblesdError as exc:
            page, _ = _admin_page(
                "groups.html",
                groups=client.list_groups,
                users=client.list_users,
                catalogs=client.list_catalogs,
            )
            return render_template(page[0], **page[1], error=exc.message), exc.status
        return redirect(url_for("groups_page"))

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

    NOTEBOOK_NAME = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")

    def _session_op(username: str, payload: dict) -> dict:
        sid = _engine_session_id(username)
        try:
            return client.exec_in_session(sid, payload)
        except PebblesdError as exc:
            if exc.status != 404:
                raise
            session.pop("engine_session", None)
            return client.exec_in_session(_engine_session_id(username), payload)

    def _load_notebook(username: str, name: str) -> dict | None:
        got = _session_op(
            username, {"op": "read", "path": f"notebooks/{name}.json"}
        )
        if not got.get("ok"):
            return None
        try:
            nb = json.loads(got.get("content", ""))
        except json.JSONDecodeError:
            return None
        nb.setdefault("catalog", None)
        nb.setdefault("cells", [])
        return nb

    @app.get("/notebooks")
    def notebooks_page():  # pyright: ignore[reportUnusedFunction]
        user = session.get("user")
        if user is None:
            return redirect(url_for("login_form"))
        notebooks = []
        try:
            listing = _session_op(user["username"], {"op": "list", "path": "notebooks"})
            if listing.get("ok"):
                notebooks = [
                    e[: -len(".json")] for e in listing.get("entries", []) if e.endswith(".json")
                ]
        except (OSError, RuntimeError, ValueError):
            pass
        return render_template("notebooks.html", user=user, notebooks=notebooks)

    @app.post("/notebooks")
    def notebooks_create():  # pyright: ignore[reportUnusedFunction]
        user = session.get("user")
        if user is None:
            return redirect(url_for("login_form"))
        name = request.form.get("name", "").strip()
        if not NOTEBOOK_NAME.match(name):
            return render_template(
                "notebooks.html", user=user, notebooks=[], error="Invalid notebook name."
            ), 422
        empty = {"catalog": None, "cells": [{"type": "sql", "source": ""}]}
        _session_op(
            user["username"],
            {"op": "write", "path": f"notebooks/{name}.json", "content": json.dumps(empty)},
        )
        return redirect(url_for("notebook_page", name=name))

    @app.get("/notebooks/<name>")
    def notebook_page(name):  # pyright: ignore[reportUnusedFunction]
        user = session.get("user")
        if user is None:
            return redirect(url_for("login_form"))
        if not NOTEBOOK_NAME.match(name):
            return redirect(url_for("notebooks_page"))
        nb = _load_notebook(user["username"], name)
        if nb is None:
            return redirect(url_for("notebooks_page"))
        try:
            catalogs = client.list_catalogs()
        except (OSError, RuntimeError, ValueError):
            catalogs = []
        return render_template(
            "notebook.html", user=user, name=name, notebook=nb, catalogs=catalogs
        )

    @app.post("/notebooks/<name>/save")
    def notebook_save(name):  # pyright: ignore[reportUnusedFunction]
        user = session.get("user")
        if user is None:
            return jsonify({"error": "not signed in"}), 401
        if not NOTEBOOK_NAME.match(name):
            return jsonify({"error": "bad name"}), 422
        nb = request.get_json(silent=True) or {}
        payload = {
            "catalog": nb.get("catalog") or None,
            "cells": [
                {"type": c.get("type", "sql"), "source": str(c.get("source", ""))}
                for c in nb.get("cells", [])
                if c.get("type", "sql") in ("sql", "python", "r")
            ],
        }
        _session_op(
            user["username"],
            {"op": "write", "path": f"notebooks/{name}.json", "content": json.dumps(payload)},
        )
        return jsonify({"saved": True})

    @app.get("/notebooks/<name>/cells/<int:index>/stream")
    def notebook_cell_stream(name, index):  # pyright: ignore[reportUnusedFunction]
        user = session.get("user")
        if user is None:
            return jsonify({"error": "not signed in"}), 401
        if not NOTEBOOK_NAME.match(name):
            return jsonify({"error": "bad name"}), 422

        def sse(event: str, data: dict) -> str:
            return f"event: {event}\ndata: {json.dumps(data)}\n\n"

        # Resolve everything inside the request context; stream after (REQ-31).
        result = None
        error = None
        try:
            nb = _load_notebook(user["username"], name)
            if nb is None or index >= len(nb["cells"]):
                error = "no such cell"
            else:
                cell = nb["cells"][index]
                if cell["type"] in ("python", "r"):
                    result = _session_op(
                        user["username"], {"op": cell["type"], "code": cell["source"]}
                    )
                else:
                    result = _run_sql(user["username"], cell["source"], nb.get("catalog"))
        except (OSError, RuntimeError, ValueError) as exc:
            error = str(exc)

        def stream():
            yield sse("status", {"state": "running"})
            if error is not None:
                yield sse("error", {"error": error})
            elif result and result.get("ok"):
                yield sse("result", result)
            else:
                yield sse("error", {"error": (result or {}).get("error", "cell failed")})
            yield sse("done", {})

        return Response(
            stream(),
            mimetype="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    def _load_dashboard(username: str, name: str) -> dict | None:
        got = _session_op(username, {"op": "read", "path": f"dashboards/{name}.json"})
        if not got.get("ok"):
            return None
        try:
            dash = json.loads(got.get("content", ""))
        except json.JSONDecodeError:
            return None
        dash.setdefault("catalog", None)
        dash.setdefault("tiles", [])
        return dash

    @app.get("/dashboards")
    def dashboards_page():  # pyright: ignore[reportUnusedFunction]
        user = session.get("user")
        if user is None:
            return redirect(url_for("login_form"))
        dashboards = []
        try:
            listing = _session_op(user["username"], {"op": "list", "path": "dashboards"})
            if listing.get("ok"):
                dashboards = [
                    e[: -len(".json")] for e in listing.get("entries", []) if e.endswith(".json")
                ]
        except (OSError, RuntimeError, ValueError):
            pass
        return render_template("dashboards.html", user=user, dashboards=dashboards)

    @app.post("/dashboards")
    def dashboards_create():  # pyright: ignore[reportUnusedFunction]
        user = session.get("user")
        if user is None:
            return redirect(url_for("login_form"))
        name = request.form.get("name", "").strip()
        if not NOTEBOOK_NAME.match(name):
            return render_template(
                "dashboards.html", user=user, dashboards=[], error="Invalid dashboard name."
            ), 422
        empty = {"catalog": None, "tiles": []}
        _session_op(
            user["username"],
            {"op": "write", "path": f"dashboards/{name}.json", "content": json.dumps(empty)},
        )
        return redirect(url_for("dashboard_page", name=name))

    @app.get("/dashboards/<name>")
    def dashboard_page(name):  # pyright: ignore[reportUnusedFunction]
        user = session.get("user")
        if user is None:
            return redirect(url_for("login_form"))
        if not NOTEBOOK_NAME.match(name):
            return redirect(url_for("dashboards_page"))
        dash = _load_dashboard(user["username"], name)
        if dash is None:
            return redirect(url_for("dashboards_page"))
        try:
            catalogs = client.list_catalogs()
        except (OSError, RuntimeError, ValueError):
            catalogs = []
        return render_template(
            "dashboard.html", user=user, name=name, dashboard=dash, catalogs=catalogs
        )

    @app.post("/dashboards/<name>/save")
    def dashboard_save(name):  # pyright: ignore[reportUnusedFunction]
        user = session.get("user")
        if user is None:
            return jsonify({"error": "not signed in"}), 401
        if not NOTEBOOK_NAME.match(name):
            return jsonify({"error": "bad name"}), 422
        dash = request.get_json(silent=True) or {}
        payload = {
            "catalog": dash.get("catalog") or None,
            "tiles": [
                {
                    "title": str(t.get("title", ""))[:80],
                    "sql": str(t.get("sql", "")),
                    "kind": t.get("kind", "table"),
                }
                for t in dash.get("tiles", [])
                if t.get("kind", "table") in ("table", "stat", "bars")
            ],
        }
        _session_op(
            user["username"],
            {"op": "write", "path": f"dashboards/{name}.json", "content": json.dumps(payload)},
        )
        return jsonify({"saved": True})

    @app.get("/dashboards/<name>/tiles/<int:index>/stream")
    def dashboard_tile_stream(name, index):  # pyright: ignore[reportUnusedFunction]
        user = session.get("user")
        if user is None:
            return jsonify({"error": "not signed in"}), 401
        if not NOTEBOOK_NAME.match(name):
            return jsonify({"error": "bad name"}), 422

        def sse(event: str, data: dict) -> str:
            return f"event: {event}\ndata: {json.dumps(data)}\n\n"

        result = None
        error = None
        try:
            dash = _load_dashboard(user["username"], name)
            if dash is None or index >= len(dash["tiles"]):
                error = "no such tile"
            else:
                result = _run_sql(
                    user["username"], dash["tiles"][index]["sql"], dash.get("catalog")
                )
        except (OSError, RuntimeError, ValueError) as exc:
            error = str(exc)

        def stream():
            yield sse("status", {"state": "running"})
            if error is not None:
                yield sse("error", {"error": error})
            elif result and result.get("ok"):
                yield sse("result", result)
            else:
                yield sse("error", {"error": (result or {}).get("error", "tile failed")})
            yield sse("done", {})

        return Response(
            stream(),
            mimetype="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    @app.post("/engines/cancel-reservation")
    def cancel_reservation():  # pyright: ignore[reportUnusedFunction]
        if session.get("user") is None:
            return redirect(url_for("login_form"))
        try:
            client.cancel_reservation(request.form.get("engine") or None)
        except PebblesdError:
            pass  # the reservation may have fulfilled meanwhile; the list shows truth
        return redirect(url_for("engines_page"))

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
