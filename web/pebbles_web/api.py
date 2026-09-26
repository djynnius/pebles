"""JSON API for the React SPA (served under /app).

Every route here is a thin proxy: check the cookie session, make one or a few
pebblesd calls (NFR-01 — privilege lives behind the unix socket), shape JSON.
Catalog *browse* is deliberately exec-driven: schema/table/column/snapshot
queries run as the signed-in user through their engine session, so visibility
is enforced by the same UNIX grants as every other query — there is no second
permission system to drift.
"""

import base64
import functools
import json
import os
import re
import time

from flask import Response, jsonify, request, session

from pebbles_web import autoetl, dashboards, notebooks
from pebbles_web.pebblesd_client import PebblesdClient, PebblesdError

#: home-relative document names (notebooks, dashboards, repos)
DOC_NAME = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
#: the Pebbles group whose members administer the install (pebblesd admins.rs)
ADMIN_GROUP = "admins"
#: Home's recently-opened list
RECENTS_MAX = 12
RECENT_KINDS = ("notebook", "dashboard", "query", "table", "job")
#: global search result cap
SEARCH_MAX = 25
#: how stale the "account still exists and is enabled" check may be
ACCOUNT_RECHECK_SECS = 10.0
#: Pebbles user/group names (pebbles-identity validate_username)
IDENT_GROUP = re.compile(r"^[a-z][a-z0-9_-]{0,31}$")
#: unquoted SQL identifiers (catalog/schema/table); pebblesd enforces the same
#: shape for catalog names at creation time
IDENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")

GIT_ACTIONS = {
    "stage": lambda p, m: ["add", "--", p],
    "unstage": lambda p, m: ["restore", "--staged", "--", p],
    "commit": lambda p, m: ["commit", "-m", m or "(no message)"],
    "push": lambda p, m: ["push"],
    "pull": lambda p, m: ["pull", "--ff-only"],
    "diff": lambda p, m: ["diff"],
    "diff-staged": lambda p, m: ["diff", "--cached"],
    "log": lambda p, m: ["log", "--oneline", "-15"],
}


#: Ollama cloud-offloaded model tags (e.g. "glm-5.2:cloud", "gpt-oss:120b-cloud")
CLOUD_MODEL = re.compile(r"(:cloud$|-cloud$|:cloud\b)")
#: home files Pebbles provisions itself (the catalog TCP credential, M2.5b)
MANAGED_FILES = {".pgpass"}


def _managed_path(path: str) -> bool:
    clean = os.path.normpath("/" + (path or "").strip()).lstrip("/")
    return clean in MANAGED_FILES


def _safe_rel(path: str) -> str | None:
    """Normalize a home-relative path, refusing traversal outside the home."""
    clean = os.path.normpath("/" + path.strip()).lstrip("/")
    if clean == ".":
        clean = ""
    if clean.startswith("..") or "/../" in f"/{clean}/":
        return None
    return clean


def _parse_status(porcelain: str) -> dict:
    info: dict = {"branch": "", "ahead": 0, "behind": 0, "files": []}
    for line in porcelain.splitlines():
        if line.startswith("# branch.head "):
            info["branch"] = line.split(" ", 2)[2]
        elif line.startswith("# branch.ab "):
            parts = line.split()
            info["ahead"] = int(parts[2].lstrip("+"))
            info["behind"] = abs(int(parts[3]))
        elif line.startswith(("1 ", "2 ")):
            fields = line.split(" ")
            xy = fields[1]
            path = line.split("\t")[0].split(" ")[-1]
            info["files"].append(
                {"path": path, "staged": xy[0] != ".", "unstaged": xy[1] != "."}
            )
        elif line.startswith("? "):
            info["files"].append(
                {"path": line[2:], "staged": False, "unstaged": True, "untracked": True}
            )
    return info


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


def _sse_response(result: dict | None, error: str | None) -> Response:
    """One-shot SSE envelope (REQ-31 wire shape; progressive delivery is a
    later pebblesd change — the client contract stays identical)."""

    def stream():
        yield _sse("status", {"state": "running"})
        if error is not None:
            yield _sse("error", {"error": error})
        elif result and result.get("ok"):
            yield _sse("result", result)
        else:
            yield _sse("error", {"error": (result or {}).get("error", "query failed")})
        yield _sse("done", {})

    return Response(
        stream(),
        mimetype="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


def register_api(app, client: PebblesdClient) -> None:
    """Attach every /api/* route to `app`. Called once from create_app."""

    # username -> (checked_at, ok): a deleted or disabled account's live cookie
    # must stop working within seconds, not at its next login.
    account_cache: dict[str, tuple[float, bool]] = {}

    def _account_ok(username: str) -> bool:
        now = time.monotonic()
        hit = account_cache.get(username)
        if hit and now - hit[0] < ACCOUNT_RECHECK_SECS:
            return hit[1]
        ok = any(
            u.get("username") == username and not u.get("disabled")
            for u in client.list_users()
        )
        account_cache[username] = (now, ok)
        return ok

    def _forget_account(username: str) -> None:
        account_cache.pop(username, None)

    def authed(f):
        """Cookie-session gate + uniform error mapping for JSON handlers."""

        @functools.wraps(f)
        def wrapper(*args, **kwargs):
            user = session.get("user")
            if user is None:
                return jsonify({"error": "unauthenticated"}), 401
            try:
                if not _account_ok(user["username"]):
                    session.clear()
                    return jsonify({"error": "unauthenticated"}), 401
            except (OSError, RuntimeError, ValueError):
                pass  # pebblesd briefly unreachable: the handler reports it
            try:
                return f(user, *args, **kwargs)
            except PebblesdError as exc:
                return jsonify({"error": exc.message}), exc.status
            except (OSError, RuntimeError, ValueError) as exc:
                return jsonify({"error": str(exc)}), 503

        return wrapper

    def _is_admin(username: str) -> bool:
        """Admin = member of the Pebbles group `admins` (pebblesd guarantees it
        exists and is never empty). Checked per request — no cached role, so
        removing someone from the group takes effect immediately."""
        return any(
            g.get("name") == ADMIN_GROUP and username in g.get("members", [])
            for g in client.list_groups()
        )

    def admin_only(f):
        """Stack UNDER @authed: receives the signed-in user first."""

        @functools.wraps(f)
        def wrapper(user, *args, **kwargs):
            if not _is_admin(user["username"]):
                return jsonify({"error": "admins only"}), 403
            return f(user, *args, **kwargs)

        return wrapper

    def _admins() -> list:
        return next(
            (g.get("members", []) for g in client.list_groups() if g.get("name") == ADMIN_GROUP),
            [],
        )

    def _guard_account_change(user: dict, target: str):
        """Deleting/disabling: never yourself, never the last admin."""
        if target == user["username"]:
            return jsonify({"error": "you can't do that to your own account"}), 409
        if _admins() == [target]:
            return jsonify({"error": "that's the last admin — make someone else an admin first"}), 409
        return None

    def _catalog_denied(user: dict, name: str):
        """403 with a useful message when the user can't open this catalog —
        instead of browse queries failing silently into an empty tree."""
        entry = next(
            (c for c in client.list_catalogs(user["username"]) if c.get("name") == name), None
        )
        if entry is None:
            return jsonify({"error": f"no catalog {name!r}"}), 404
        if entry.get("accessible") is False:
            return jsonify({
                "error": f"You don't have access to {name}. Ask its owner "
                f"({entry.get('owner')}) or an admin to grant one of your groups.",
                "access": False,
                "owner": entry.get("owner"),
            }), 403
        return None

    def _job(name: str) -> dict | None:
        return next((w for w in client.list_workflows() if w.get("name") == name), None)

    def _job_visible(user: dict, name: str):
        """(workflow, None) when the caller owns it or is an admin; else
        (None, error-response). Jobs run AS their owner, so letting others
        trigger them would be running code as someone else."""
        wf = _job(name)
        if wf is None:
            return None, (jsonify({"error": f"no job {name!r}"}), 404)
        if wf.get("username") != user["username"] and not _is_admin(user["username"]):
            return None, (jsonify({"error": f"no job {name!r}"}), 404)
        return wf, None

    def _engine_session_id(username: str) -> int:
        sid = session.get("engine_session")
        if sid is None:
            sid = client.open_session(username)["id"]
            session["engine_session"] = sid
        return sid

    def _session_op(username: str, payload: dict) -> dict:
        sid = _engine_session_id(username)
        try:
            return client.exec_in_session(sid, payload)
        except PebblesdError as exc:
            if exc.status != 404:
                raise
            # Session idled out or the daemon restarted: open a fresh one, retry once.
            session.pop("engine_session", None)
            return client.exec_in_session(_engine_session_id(username), payload)

    def _run_sql(username: str, sql: str, catalog: str | None) -> dict:
        payload: dict = {"op": "sql", "sql": sql}
        if catalog:
            payload["catalog"] = catalog
        return _session_op(username, payload)

    def _rows(username: str, sql: str, catalog: str) -> list:
        """Rows of a browse query, or [] — browse views degrade, never 500."""
        try:
            got = _run_sql(username, sql, catalog)
        except (OSError, RuntimeError, ValueError):
            return []
        return got.get("rows") or [] if got.get("ok") else []

    def _git(username: str, args: list, cwd: str | None = None) -> dict:
        payload: dict = {"op": "git", "args": args}
        if cwd:
            payload["cwd"] = cwd
        return _session_op(username, payload)

    def _load_doc(username: str, kind: str, name: str) -> dict | None:
        got = _session_op(username, {"op": "read", "path": f"{kind}/{name}.json"})
        if not got.get("ok"):
            return None
        try:
            doc = json.loads(got.get("content", ""))
        except json.JSONDecodeError:
            return None
        doc.setdefault("catalog", None)
        return doc

    def _list_docs(username: str, kind: str) -> list:
        listing = _session_op(username, {"op": "list", "path": kind})
        if not listing.get("ok"):
            return []
        return [e[: -len(".json")] for e in listing.get("entries", []) if e.endswith(".json")]

    # ---- auth ------------------------------------------------------------

    def _whoami(user: dict) -> dict:
        """The signed-in identity as the SPA sees it — /me and /login alike,
        so the admin nav is right from the first render after sign-in."""
        try:
            admin = _is_admin(user["username"])
        except (OSError, RuntimeError, ValueError):
            admin = False
        return {**user, "admin": admin}

    @app.get("/api/me")
    def api_me():  # pyright: ignore[reportUnusedFunction]
        user = session.get("user")
        if user is None:
            return jsonify({"error": "unauthenticated"}), 401
        return jsonify(_whoami(user))

    @app.post("/api/login")
    def api_login():  # pyright: ignore[reportUnusedFunction]
        body = request.get_json(silent=True) or {}
        identity = client.login(body.get("username", ""), body.get("password", ""))
        if identity is None:
            return jsonify({"error": "Invalid username or password."}), 401
        session["user"] = identity
        return jsonify(_whoami(identity))

    @app.post("/api/logout")
    def api_logout():  # pyright: ignore[reportUnusedFunction]
        # Release the engine session with the login: an idle kernel otherwise
        # holds its memory reservation until the 30-minute reaper runs.
        sid = session.get("engine_session")
        if sid is not None:
            try:
                client.close_session(sid)
            except (OSError, RuntimeError, ValueError):
                pass  # already reaped / daemon restarting — nothing to release
        session.clear()
        return jsonify({"ok": True})

    # ---- fleet / admin ----------------------------------------------------

    @app.get("/api/usage")
    @authed
    def api_usage(user):  # pyright: ignore[reportUnusedFunction]
        return jsonify(client.usage())

    @app.get("/api/engines")
    @authed
    def api_engines(user):  # pyright: ignore[reportUnusedFunction]
        return jsonify(client.list_engines())

    @app.post("/api/engines/cancel-reservation")
    @authed
    def api_cancel_reservation(user):  # pyright: ignore[reportUnusedFunction]
        body = request.get_json(silent=True) or {}
        return jsonify(client.cancel_reservation(body.get("engine") or None))

    @app.get("/api/users")
    @authed
    def api_users(user):  # pyright: ignore[reportUnusedFunction]
        return jsonify(client.list_users())

    @app.post("/api/users")
    @authed
    @admin_only
    def api_users_create(user):  # pyright: ignore[reportUnusedFunction]
        body = request.get_json(silent=True) or {}
        return jsonify(
            client.create_user(body.get("username", "").strip(), body.get("password", ""))
        )

    @app.delete("/api/users/<username>")
    @authed
    @admin_only
    def api_users_delete(user, username):  # pyright: ignore[reportUnusedFunction]
        refused = _guard_account_change(user, username)
        if refused:
            return refused
        remove_home = request.args.get("remove_home") == "true"
        result = client.delete_user(username, remove_home)
        _forget_account(username)
        return jsonify(result)

    @app.post("/api/users/<username>/password")
    @authed
    @admin_only
    def api_users_reset_password(user, username):  # pyright: ignore[reportUnusedFunction]
        body = request.get_json(silent=True) or {}
        return jsonify(client.set_password(username, body.get("password", "")))

    @app.post("/api/users/<username>/disabled")
    @authed
    @admin_only
    def api_users_set_disabled(user, username):  # pyright: ignore[reportUnusedFunction]
        body = request.get_json(silent=True) or {}
        disabled = bool(body.get("disabled"))
        if disabled:
            refused = _guard_account_change(user, username)
            if refused:
                return refused
        result = client.set_disabled(username, disabled)
        _forget_account(username)
        return jsonify(result)

    @app.post("/api/me/password")
    @authed
    def api_me_password(user):  # pyright: ignore[reportUnusedFunction]
        """Self-service change: proving the current password is mandatory, so
        a borrowed, still-open browser session can't lock its owner out."""
        body = request.get_json(silent=True) or {}
        current, new = body.get("current", ""), body.get("new", "")
        if client.login(user["username"], current) is None:
            return jsonify({"error": "your current password is incorrect"}), 403
        if current == new:
            return jsonify({"error": "choose a password you haven't been using"}), 422
        return jsonify(client.set_password(user["username"], new))

    @app.get("/api/groups")
    @authed
    def api_groups(user):  # pyright: ignore[reportUnusedFunction]
        return jsonify(client.list_groups())

    @app.post("/api/groups")
    @authed
    @admin_only
    def api_groups_create(user):  # pyright: ignore[reportUnusedFunction]
        body = request.get_json(silent=True) or {}
        return jsonify(client.create_group(body.get("name", "").strip()))

    @app.delete("/api/groups/<group>")
    @authed
    @admin_only
    def api_groups_delete(user, group):  # pyright: ignore[reportUnusedFunction]
        return jsonify(client.delete_group(group))

    @app.post("/api/groups/<group>/members")
    @authed
    @admin_only
    def api_group_add_member(user, group):  # pyright: ignore[reportUnusedFunction]
        body = request.get_json(silent=True) or {}
        return jsonify(client.add_group_member(group, body.get("username", "")))

    @app.delete("/api/groups/<group>/members/<username>")
    @authed
    @admin_only
    def api_group_remove_member(user, group, username):  # pyright: ignore[reportUnusedFunction]
        if group == ADMIN_GROUP:
            admins = next(
                (g.get("members", []) for g in client.list_groups() if g.get("name") == group),
                [],
            )
            if admins == [username]:
                return jsonify({"error": "can't remove the last admin"}), 409
        return jsonify(client.remove_group_member(group, username))

    # ---- cluster (tokens, pending engines) --------------------------------

    @app.get("/api/tokens")
    @authed
    @admin_only
    def api_tokens(user):  # pyright: ignore[reportUnusedFunction]
        return jsonify(client.list_tokens())

    @app.post("/api/tokens")
    @authed
    @admin_only
    def api_tokens_mint(user):  # pyright: ignore[reportUnusedFunction]
        # The plaintext token appears exactly once, in this response (REQ-05).
        return jsonify(client.mint_token())

    @app.delete("/api/tokens/<token_id>")
    @authed
    @admin_only
    def api_tokens_revoke(user, token_id):  # pyright: ignore[reportUnusedFunction]
        return jsonify(client.revoke_token(token_id))

    @app.get("/api/engines/pending")
    @authed
    @admin_only
    def api_engines_pending(user):  # pyright: ignore[reportUnusedFunction]
        return jsonify(client.list_pending_engines())

    @app.post("/api/engines/pending/<name>/approve")
    @authed
    @admin_only
    def api_engine_approve(user, name):  # pyright: ignore[reportUnusedFunction]
        return jsonify(client.approve_pending_engine(name))

    @app.delete("/api/engines/pending/<name>")
    @authed
    @admin_only
    def api_engine_reject(user, name):  # pyright: ignore[reportUnusedFunction]
        return jsonify(client.reject_pending_engine(name))

    @app.post("/api/engines/<name>/access")
    @authed
    @admin_only
    def api_engine_access(user, name):  # pyright: ignore[reportUnusedFunction]
        """"everyone" or "group:<name>" (REQ-07)."""
        body = request.get_json(silent=True) or {}
        access = (body.get("access") or "").strip()
        if access != "everyone" and not (
            access.startswith("group:") and IDENT_GROUP.match(access[len("group:"):])
        ):
            return jsonify({"error": 'access must be "everyone" or "group:<name>"'}), 422
        return jsonify(client.set_engine_access(name, access))

    @app.delete("/api/engines/<name>")
    @authed
    @admin_only
    def api_engine_deregister(user, name):  # pyright: ignore[reportUnusedFunction]
        return jsonify(client.deregister_engine(name))

    # ---- catalogs ----------------------------------------------------------

    @app.get("/api/catalogs")
    @authed
    def api_catalogs(user):  # pyright: ignore[reportUnusedFunction]
        return jsonify(client.list_catalogs(user["username"]))

    @app.post("/api/catalogs")
    @authed
    def api_catalogs_create(user):  # pyright: ignore[reportUnusedFunction]
        body = request.get_json(silent=True) or {}
        return jsonify(client.create_catalog(body.get("name", "").strip(), user["username"]))

    @app.get("/api/catalogs/<name>/grants")
    @authed
    def api_catalog_grants(user, name):  # pyright: ignore[reportUnusedFunction]
        return jsonify(client.list_catalog_grants(name))

    @app.post("/api/catalogs/<name>/grants")
    @authed
    def api_catalog_grant(user, name):  # pyright: ignore[reportUnusedFunction]
        owner = next(
            (c.get("owner") for c in client.list_catalogs() if c.get("name") == name), None
        )
        if owner is None:
            return jsonify({"error": f"no catalog {name!r}"}), 404
        if owner != user["username"] and not _is_admin(user["username"]):
            return jsonify({"error": "only the catalog's owner or an admin can grant it"}), 403
        body = request.get_json(silent=True) or {}
        return jsonify(client.grant_catalog(name, body.get("group", "")))

    @app.get("/api/catalogs/<name>/tree")
    @authed
    def api_catalog_tree(user, name):  # pyright: ignore[reportUnusedFunction]
        """schemas → tables, as the signed-in user sees them."""
        if not IDENT.match(name):
            return jsonify({"error": "bad catalog name"}), 422
        denied = _catalog_denied(user, name)
        if denied:
            return denied
        username = user["username"]
        schemas: dict[str, list] = {}
        for row in _rows(
            username,
            "SELECT schema_name FROM information_schema.schemata "
            f"WHERE catalog_name = '{name}' ORDER BY schema_name",
            name,
        ):
            schema = row.get("schema_name")
            if schema and schema not in ("information_schema", "pg_catalog"):
                schemas.setdefault(schema, [])
        for row in _rows(
            username,
            "SELECT table_schema, table_name FROM information_schema.tables "
            f"WHERE table_catalog = '{name}' ORDER BY table_schema, table_name",
            name,
        ):
            schema, table = row.get("table_schema"), row.get("table_name")
            if schema in ("information_schema", "pg_catalog") or not table:
                continue
            schemas.setdefault(schema, []).append(table)
        return jsonify(
            {"schemas": [{"name": s, "tables": t} for s, t in schemas.items()]}
        )

    @app.get("/api/catalogs/<name>/tables/<schema>/<table>")
    @authed
    def api_catalog_table(user, name, schema, table):  # pyright: ignore[reportUnusedFunction]
        """Everything the Catalog detail view shows, in one call."""
        if not all(IDENT.match(part) for part in (name, schema, table)):
            return jsonify({"error": "bad identifier"}), 422
        denied = _catalog_denied(user, name)
        if denied:
            return denied
        username = user["username"]
        qualified = f'"{name}"."{schema}"."{table}"'
        columns = _rows(
            username,
            "SELECT column_name, data_type, is_nullable FROM information_schema.columns "
            f"WHERE table_catalog = '{name}' AND table_schema = '{schema}' "
            f"AND table_name = '{table}' ORDER BY ordinal_position",
            name,
        )
        count = _rows(username, f"SELECT count(*) AS n FROM {qualified}", name)
        sample = _rows(username, f"SELECT * FROM {qualified} LIMIT 25", name)
        snapshots = _rows(
            username,
            f"SELECT * FROM ducklake_snapshots('{name}') ORDER BY snapshot_id DESC",
            name,
        )
        return jsonify(
            {
                "columns": columns,
                "row_count": (count[0].get("n") if count else None),
                "sample": sample,
                "snapshots": snapshots,
            }
        )

    # ---- SQL ---------------------------------------------------------------

    @app.post("/api/sql")
    @authed
    def api_sql(user):  # pyright: ignore[reportUnusedFunction]
        body = request.get_json(silent=True) or {}
        sql = (body.get("sql") or "").strip()
        if not sql:
            return jsonify({"error": "empty query"}), 422
        return jsonify(_run_sql(user["username"], sql, body.get("catalog") or None))

    @app.get("/api/sql/stream")
    def api_sql_stream():  # pyright: ignore[reportUnusedFunction]
        user = session.get("user")
        if user is None:
            return jsonify({"error": "unauthenticated"}), 401
        sql = request.args.get("q", "").strip()
        if not sql:
            return jsonify({"error": "empty query"}), 422
        catalog = request.args.get("catalog") or None
        # Progressive streaming (REQ-31): rows relay batch-by-batch as the
        # kernel produces them. Everything session-bound resolves HERE — the
        # generator outlives the request context (and its cookie session), so
        # a ping revives a reaped session and pins the id first.
        username = user["username"]
        try:
            _session_op(username, {"op": "ping"})
            sid = _engine_session_id(username)
        except (OSError, RuntimeError, ValueError) as exc:
            return _sse_response(None, str(exc))
        payload: dict = {"op": "sql_stream", "sql": sql}
        if catalog:
            payload["catalog"] = catalog

        def stream():
            yield _sse("status", {"state": "running"})
            rows: list = []
            try:
                for msg in client.exec_stream(sid, payload):
                    if msg.get("rows") and not msg.get("done"):
                        rows.extend(msg["rows"])
                        yield _sse("rows", {"rows": msg["rows"]})
                    if msg.get("done"):
                        if msg.get("ok"):
                            yield _sse(
                                "result",
                                {
                                    "ok": True,
                                    "rows": rows,
                                    "truncated": bool(msg.get("truncated")),
                                },
                            )
                        else:
                            yield _sse(
                                "error", {"error": msg.get("error", "query failed")}
                            )
            except (OSError, RuntimeError, ValueError) as exc:
                yield _sse("error", {"error": str(exc)})
            yield _sse("done", {})

        return Response(
            stream(),
            mimetype="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    # ---- files -------------------------------------------------------------

    @app.get("/api/files")
    @authed
    def api_files(user):  # pyright: ignore[reportUnusedFunction]
        rel = _safe_rel(request.args.get("path", ""))
        if rel is None:
            return jsonify({"error": "bad path"}), 422
        got = _session_op(user["username"], {"op": "browse", "path": rel or "."})
        if not got.get("ok"):
            return jsonify({"error": got.get("error", "browse failed")}), 502
        return jsonify({"path": rel, "items": got.get("items", [])})

    @app.post("/api/files/mkdir")
    @authed
    def api_files_mkdir(user):  # pyright: ignore[reportUnusedFunction]
        body = request.get_json(silent=True) or {}
        target = _safe_rel(f"{body.get('dir', '')}/{body.get('name', '')}")
        if not target:
            return jsonify({"error": "bad path"}), 422
        return jsonify(_session_op(user["username"], {"op": "mkdir", "path": target}))

    @app.post("/api/files/delete")
    @authed
    def api_files_delete(user):  # pyright: ignore[reportUnusedFunction]
        body = request.get_json(silent=True) or {}
        if _managed_path(body.get("path", "")):
            return jsonify({"error": "that file is managed by Pebbles and can't be changed here"}), 409
        target = _safe_rel(body.get("path", ""))
        if not target:
            return jsonify({"error": "bad path"}), 422
        return jsonify(_session_op(user["username"], {"op": "delete", "path": target}))

    @app.post("/api/files/rename")
    @authed
    def api_files_rename(user):  # pyright: ignore[reportUnusedFunction]
        body = request.get_json(silent=True) or {}
        if _managed_path(body.get("path", "")):
            return jsonify({"error": "that file is managed by Pebbles and can't be changed here"}), 409
        src = _safe_rel(body.get("path", ""))
        dst = _safe_rel(body.get("to", ""))
        if not src or not dst:
            return jsonify({"error": "bad path"}), 422
        return jsonify(_session_op(user["username"], {"op": "rename", "from": src, "to": dst}))

    @app.post("/api/files/upload")
    @authed
    def api_files_upload(user):  # pyright: ignore[reportUnusedFunction]
        base = _safe_rel(request.form.get("dir", "")) or ""
        uploaded = []
        for f in request.files.getlist("file"):
            name = (f.filename or "").strip().strip("/")
            if not name or "/" in name or name in ("..", "."):
                continue
            target = f"{base}/{name}" if base else name
            b64 = base64.b64encode(f.read()).decode("ascii")
            got = _session_op(user["username"], {"op": "upload", "path": target, "b64": b64})
            if got.get("ok"):
                uploaded.append(target)
        return jsonify({"uploaded": uploaded})

    @app.get("/api/files/download")
    def api_files_download():  # pyright: ignore[reportUnusedFunction]
        user = session.get("user")
        if user is None:
            return jsonify({"error": "unauthenticated"}), 401
        rel = _safe_rel(request.args.get("path", ""))
        if not rel:
            return jsonify({"error": "bad path"}), 422
        # Byte-exact (read_b64): the text `read` op can't carry binary files.
        got = _session_op(user["username"], {"op": "read_b64", "path": rel})
        if not got.get("ok"):
            return jsonify({"error": got.get("error", "not found")}), 404
        return Response(
            base64.b64decode(got.get("b64", "")),
            mimetype="application/octet-stream",
            headers={
                "Content-Disposition": f'attachment; filename="{os.path.basename(rel)}"'
            },
        )

    # ---- notebooks & dashboards (JSON documents in the user's home) ---------

    def _doc_routes(kind: str, defaults: dict, sanitize):
        """Notebooks and dashboards share one CRUD shape; only the payload
        sanitizer differs. `kind` is 'notebooks' or 'dashboards'."""

        @app.get(f"/api/{kind}", endpoint=f"api_{kind}_list")
        @authed
        def _list(user):
            return jsonify(_list_docs(user["username"], kind))

        @app.post(f"/api/{kind}", endpoint=f"api_{kind}_create")
        @authed
        def _create(user):
            body = request.get_json(silent=True) or {}
            name = (body.get("name") or "").strip()
            if not DOC_NAME.match(name):
                return jsonify({"error": "invalid name"}), 422
            _session_op(
                user["username"],
                {
                    "op": "write",
                    "path": f"{kind}/{name}.json",
                    "content": json.dumps(defaults),
                },
            )
            return jsonify({"name": name, **defaults})

        @app.get(f"/api/{kind}/<name>", endpoint=f"api_{kind}_get")
        @authed
        def _get(user, name):
            if not DOC_NAME.match(name):
                return jsonify({"error": "invalid name"}), 422
            doc = _load_doc(user["username"], kind, name)
            if doc is None:
                return jsonify({"error": "not found"}), 404
            for key, value in defaults.items():
                doc.setdefault(key, value)
            return jsonify(doc)

        @app.put(f"/api/{kind}/<name>", endpoint=f"api_{kind}_save")
        @authed
        def _save(user, name):
            if not DOC_NAME.match(name):
                return jsonify({"error": "invalid name"}), 422
            payload = sanitize(request.get_json(silent=True) or {})
            _session_op(
                user["username"],
                {
                    "op": "write",
                    "path": f"{kind}/{name}.json",
                    "content": json.dumps(payload),
                },
            )
            return jsonify({"saved": True})

        @app.delete(f"/api/{kind}/<name>", endpoint=f"api_{kind}_delete")
        @authed
        def _delete(user, name):
            if not DOC_NAME.match(name):
                return jsonify({"error": "invalid name"}), 422
            return jsonify(
                _session_op(user["username"], {"op": "delete", "path": f"{kind}/{name}.json"})
            )

    _sanitize_notebook = notebooks.sanitize

    _sanitize_dashboard = dashboards.sanitize

    _doc_routes(
        "notebooks",
        {"catalog": None, "cells": [{"type": "sql", "source": ""}]},
        _sanitize_notebook,
    )
    _doc_routes(
        "dashboards", {"catalog": None, "filters": [], "tiles": []}, _sanitize_dashboard
    )

    @app.get("/api/notebooks/<name>/cells/<int:index>/stream")
    def api_notebook_cell_stream(name, index):  # pyright: ignore[reportUnusedFunction]
        user = session.get("user")
        if user is None:
            return jsonify({"error": "unauthenticated"}), 401
        if not DOC_NAME.match(name):
            return jsonify({"error": "invalid name"}), 422
        result, error = None, None
        try:
            nb = _load_doc(user["username"], "notebooks", name)
            cells = (nb or {}).get("cells", [])
            if nb is None or index >= len(cells):
                error = "no such cell"
            else:
                cell = cells[index]
                if cell.get("type") == "md":
                    result = {"ok": True}  # markdown renders client-side; nothing runs
                elif cell.get("type") in ("python", "r"):
                    result = _session_op(
                        user["username"], {"op": cell["type"], "code": cell.get("source", "")}
                    )
                else:
                    result = _run_sql(
                        user["username"], cell.get("source", ""), nb.get("catalog")
                    )
        except (OSError, RuntimeError, ValueError) as exc:
            error = str(exc)
        return _sse_response(result, error)

    @app.get("/api/notebooks/<name>/ipynb")
    @authed
    def api_notebook_export(user, name):  # pyright: ignore[reportUnusedFunction]
        if not DOC_NAME.match(name):
            return jsonify({"error": "invalid name"}), 422
        nb = _load_doc(user["username"], "notebooks", name)
        if nb is None:
            return jsonify({"error": "not found"}), 404
        return Response(
            json.dumps(notebooks.to_ipynb(nb), indent=1),
            mimetype="application/x-ipynb+json",
            headers={"Content-Disposition": f'attachment; filename="{name}.ipynb"'},
        )

    @app.post("/api/notebooks/import")
    @authed
    def api_notebook_import(user):  # pyright: ignore[reportUnusedFunction]
        """Multipart: `file` (.ipynb) + optional `name`; refuses to overwrite."""
        upload = request.files.get("file")
        if upload is None:
            return jsonify({"error": "attach a .ipynb file"}), 422
        base = (upload.filename or "notebook").rsplit("/", 1)[-1].rsplit(".", 1)[0]
        name = (request.form.get("name") or "").strip() or re.sub(
            r"[^a-z0-9_-]+", "-", base.lower()
        ).strip("-_")
        if not DOC_NAME.match(name):
            return jsonify({"error": "invalid notebook name"}), 422
        try:
            nb = notebooks.from_ipynb(json.loads(upload.read().decode("utf-8")))
        except (ValueError, UnicodeDecodeError) as exc:
            return jsonify({"error": f"couldn't read that notebook: {exc}"}), 422
        if name in _list_docs(user["username"], "notebooks"):
            return jsonify({"error": f"a notebook named {name!r} already exists"}), 409
        _session_op(
            user["username"],
            {"op": "write", "path": f"notebooks/{name}.json",
             "content": json.dumps(notebooks.sanitize(nb))},
        )
        return jsonify({"name": name, "cells": len(nb["cells"])})

    @app.get("/api/dashboards/<name>/tiles/<int:index>/stream")
    def api_dashboard_tile_stream(name, index):  # pyright: ignore[reportUnusedFunction]
        user = session.get("user")
        if user is None:
            return jsonify({"error": "unauthenticated"}), 401
        if not DOC_NAME.match(name):
            return jsonify({"error": "invalid name"}), 422
        result, error = None, None
        try:
            dash = _load_doc(user["username"], "dashboards", name)
            tiles = (dash or {}).get("tiles", [])
            if dash is None or index >= len(tiles):
                error = "no such tile"
            else:
                # f.<name>=value query params choose filter values (else defaults)
                chosen = {
                    k[2:]: v for k, v in request.args.items() if k.startswith("f.")
                }
                sql = dashboards.apply_filters(
                    tiles[index].get("sql", ""), dash.get("filters", []), chosen
                )
                result = _run_sql(user["username"], sql, dash.get("catalog"))
        except (OSError, RuntimeError, ValueError) as exc:
            error = str(exc)
        return _sse_response(result, error)

    # ---- jobs ---------------------------------------------------------------

    @app.get("/api/jobs")
    @authed
    def api_jobs(user):  # pyright: ignore[reportUnusedFunction]
        flows = client.list_workflows()
        if _is_admin(user["username"]):
            return jsonify(flows)
        return jsonify([w for w in flows if w.get("username") == user["username"]])

    @app.post("/api/jobs")
    @authed
    def api_jobs_save(user):  # pyright: ignore[reportUnusedFunction]
        wf = request.get_json(silent=True) or {}
        wf["username"] = user["username"]  # tasks run as the signed-in owner (REQ-41)
        return jsonify(client.save_workflow(wf))

    @app.post("/api/jobs/<name>/run")
    @authed
    def api_jobs_run(user, name):  # pyright: ignore[reportUnusedFunction]
        _, err = _job_visible(user, name)
        return err or jsonify(client.trigger_workflow(name))

    @app.delete("/api/jobs/<name>")
    @authed
    def api_jobs_delete(user, name):  # pyright: ignore[reportUnusedFunction]
        _, err = _job_visible(user, name)
        return err or jsonify(client.delete_workflow(name))

    @app.get("/api/jobs/<name>/trigger")
    @authed
    def api_jobs_trigger_status(user, name):  # pyright: ignore[reportUnusedFunction]
        _, err = _job_visible(user, name)
        return err or jsonify(client.trigger_status(name))

    @app.get("/api/jobs/<name>/runs")
    @authed
    def api_jobs_runs(user, name):  # pyright: ignore[reportUnusedFunction]
        _, err = _job_visible(user, name)
        return err or jsonify(client.workflow_runs(name))

    @app.get("/api/jobs/<name>/runs/<run_id>")
    @authed
    def api_jobs_run_detail(user, name, run_id):  # pyright: ignore[reportUnusedFunction]
        _, err = _job_visible(user, name)
        return err or jsonify(client.workflow_run_detail(name, run_id))

    # ---- repos (git-as-user) -------------------------------------------------

    @app.get("/api/repos")
    @authed
    def api_repos(user):  # pyright: ignore[reportUnusedFunction]
        listing = _session_op(user["username"], {"op": "list", "path": "repos"})
        return jsonify(listing.get("entries", []) if listing.get("ok") else [])

    @app.post("/api/repos/clone")
    @authed
    def api_repos_clone(user):  # pyright: ignore[reportUnusedFunction]
        body = request.get_json(silent=True) or {}
        url = (body.get("url") or "").strip()
        name = (body.get("name") or "").strip() or url.rstrip("/").rsplit("/", 1)[-1]
        name = name.removesuffix(".git")
        if not DOC_NAME.match(name) or not url:
            return jsonify({"error": "invalid URL or name"}), 422
        got = _git(user["username"], ["clone", url, f"repos/{name}"])
        if not got.get("ok"):
            return jsonify({"error": got.get("stderr") or got.get("error")}), 502
        return jsonify({"name": name})

    @app.get("/api/repos/<name>/status")
    @authed
    def api_repo_status(user, name):  # pyright: ignore[reportUnusedFunction]
        if not DOC_NAME.match(name):
            return jsonify({"error": "invalid name"}), 422
        got = _git(
            user["username"], ["status", "--porcelain=v2", "--branch"], cwd=f"repos/{name}"
        )
        if not got.get("ok"):
            return jsonify({"error": got.get("stderr") or got.get("error")}), 502
        return jsonify(_parse_status(got.get("stdout", "")))

    @app.post("/api/repos/<name>/git")
    @authed
    def api_repo_git(user, name):  # pyright: ignore[reportUnusedFunction]
        if not DOC_NAME.match(name):
            return jsonify({"error": "invalid name"}), 422
        body = request.get_json(silent=True) or {}
        action = GIT_ACTIONS.get(body.get("action", ""))
        if action is None:
            return jsonify({"error": "unknown action"}), 422
        got = _git(
            user["username"],
            action(str(body.get("path", "")), str(body.get("message", ""))),
            cwd=f"repos/{name}",
        )
        return jsonify(got), 200 if got.get("ok") else 502

    # ---- nkoyo -----------------------------------------------------------------

    @app.get("/api/nkoyo/chat")
    @authed
    def api_nkoyo_history(user):  # pyright: ignore[reportUnusedFunction]
        return jsonify(session.get("nkoyo_chat", []))

    @app.post("/api/nkoyo/send")
    @authed
    def api_nkoyo_send(user):  # pyright: ignore[reportUnusedFunction]
        body = request.get_json(silent=True) or {}
        prompt = (body.get("prompt") or "").strip()
        approved = [t for t in body.get("approved", []) if isinstance(t, str)]
        if not prompt:
            return jsonify({"error": "empty prompt"}), 422
        chat = session.get("nkoyo_chat", [])
        chat.append({"role": "user", "content": prompt})
        try:
            reply = client.nkoyo_chat(user["username"], chat[-20:], approved)
        except PebblesdError:
            chat.pop()
            session["nkoyo_chat"] = chat
            raise
        chat.append({"role": "assistant", "content": reply.get("content", "")})
        session["nkoyo_chat"] = chat[-20:]
        return jsonify(reply)

    @app.post("/api/nkoyo/clear")
    @authed
    def api_nkoyo_clear(user):  # pyright: ignore[reportUnusedFunction]
        session.pop("nkoyo_chat", None)
        return jsonify({"ok": True})

    @app.get("/api/nkoyo/config")
    @authed
    def api_nkoyo_config(user):  # pyright: ignore[reportUnusedFunction]
        cfg = client.nkoyo_config()
        # Ollama ":cloud" models run on ollama.com, not on this cluster — the
        # UI must not claim "no data leaves your hosts" while one is in use.
        cfg["cloud_models"] = sorted({
            m for m in (cfg.get("planner_model"), cfg.get("coder_model"), cfg.get("embed_model"))
            if isinstance(m, str) and CLOUD_MODEL.search(m)
        })
        return jsonify(cfg)

    @app.post("/api/nkoyo/config")
    @authed
    @admin_only
    def api_nkoyo_config_save(user):  # pyright: ignore[reportUnusedFunction]
        body = request.get_json(silent=True) or {}
        cfg = {
            "endpoints": [e.strip() for e in body.get("endpoints", []) if e.strip()],
            "planner_model": body.get("planner_model", "llama3.2"),
            "coder_model": body.get("coder_model", "llama3.2"),
            "embed_model": body.get("embed_model", "nomic-embed-text"),
            "max_steps": int(body.get("max_steps", 16) or 16),
        }
        return jsonify(client.nkoyo_config_save(cfg))

    @app.post("/api/nkoyo/rescan")
    @authed
    @admin_only
    def api_nkoyo_rescan(user):  # pyright: ignore[reportUnusedFunction]
        return jsonify(client.nkoyo_rescan())

    # ---- Auto ETL (REQ-46) --------------------------------------------------

    @app.post("/api/autoetl/profile")
    @authed
    def api_autoetl_profile(user):  # pyright: ignore[reportUnusedFunction]
        """Profile a raw source (read-only) and propose a plan. Nothing loads."""
        body = request.get_json(silent=True) or {}
        source = body.get("source") or {}
        catalog = body.get("catalog") or None
        frm = autoetl.source_expr(source)
        if frm is None:
            return jsonify({"error": "unsupported or unsafe source"}), 422
        username = user["username"]
        prof = _run_sql(username, f"SUMMARIZE SELECT * FROM {frm}", catalog)
        if not prof.get("ok"):
            return jsonify({"error": prof.get("error", "profiling failed")}), 502
        columns = prof.get("rows") or []
        counted = _run_sql(username, f"SELECT count(*) AS n FROM {frm}", catalog)
        row_count = (counted.get("rows") or [{}])[0].get("n") if counted.get("ok") else None
        proposal = autoetl.propose(columns, int(row_count or 0), source)
        return jsonify(
            {
                "source": source,
                "row_count": row_count,
                "columns": columns,
                "proposal": proposal,
            }
        )

    @app.post("/api/autoetl/approve")
    @authed
    def api_autoetl_approve(user):  # pyright: ignore[reportUnusedFunction]
        """The user approved: compose the workflow, save it, optionally run
        and/or commit the plan to a repo. This is the ONLY path that loads."""
        body = request.get_json(silent=True) or {}
        name = (body.get("name") or "").strip()
        catalog = (body.get("catalog") or "").strip()
        if not DOC_NAME.match(name) or not IDENT.match(catalog):
            return jsonify({"error": "invalid name or catalog"}), 422
        steps = [s for s in body.get("steps", []) if isinstance(s, dict)]
        tasks = autoetl.build_tasks(
            name, body.get("source") or {}, steps, body.get("model") or {}, catalog
        )
        if tasks is None:
            return jsonify({"error": "invalid source, model, or identifiers"}), 422
        workflow = {
            "name": name,
            "username": user["username"],  # loads run as the approver (REQ-41/45)
            "schedule": body.get("schedule") or None,
            "tasks": tasks,
        }
        saved = client.save_workflow(workflow)
        result: dict = {"workflow": saved}
        if body.get("run"):
            result["run"] = client.trigger_workflow(name)
        repo = (body.get("repo") or "").strip()
        if repo and DOC_NAME.match(repo):
            sql_text = "\n\n".join(
                f"-- task: {t['id']}\n{t['payload']}" for t in tasks
            )
            path = f"repos/{repo}/autoetl/{name}.sql"
            _session_op(user["username"], {"op": "mkdir", "path": f"repos/{repo}/autoetl"})
            wrote = _session_op(
                user["username"], {"op": "write", "path": path, "content": sql_text}
            )
            if wrote.get("ok"):
                _git(user["username"], ["add", "--", f"autoetl/{name}.sql"], cwd=f"repos/{repo}")
                committed = _git(
                    user["username"],
                    ["commit", "-m", f"Auto ETL: {name}"],
                    cwd=f"repos/{repo}",
                )
                result["committed"] = bool(committed.get("ok"))
        return jsonify(result)

    # ---- recents & search ------------------------------------------------------

    RECENTS_PATH = ".pebbles/recents.json"

    def _read_recents(username: str) -> list:
        got = _session_op(username, {"op": "read", "path": RECENTS_PATH})
        if not got.get("ok"):
            return []
        try:
            items = json.loads(got.get("content") or "[]")
        except json.JSONDecodeError:
            return []
        return [i for i in items if isinstance(i, dict)][:RECENTS_MAX]

    @app.get("/api/recents")
    @authed
    def api_recents(user):  # pyright: ignore[reportUnusedFunction]
        return jsonify(_read_recents(user["username"]))

    @app.post("/api/recents")
    @authed
    def api_recents_touch(user):  # pyright: ignore[reportUnusedFunction]
        """Record an opened item (most recent first, deduplicated). Lives in
        the user's own home — the web tier never writes homes directly."""
        body = request.get_json(silent=True) or {}
        kind, name = str(body.get("kind", "")), str(body.get("name", ""))[:200]
        if kind not in RECENT_KINDS or not name:
            return jsonify({"error": "kind and name required"}), 422
        entry = {"kind": kind, "name": name, "at": int(time.time())}
        if body.get("catalog"):
            entry["catalog"] = str(body["catalog"])[:64]
        items = [
            i for i in _read_recents(user["username"])
            if not (i.get("kind") == kind and i.get("name") == name)
        ]
        items = [entry, *items][:RECENTS_MAX]
        _session_op(user["username"], {"op": "mkdir", "path": ".pebbles"})
        _session_op(
            user["username"],
            {"op": "write", "path": RECENTS_PATH, "content": json.dumps(items)},
        )
        return jsonify(items)

    @app.get("/api/search")
    @authed
    def api_search(user):  # pyright: ignore[reportUnusedFunction]
        """Names only, across what THIS user can open: notebooks, dashboards,
        their jobs, and tables in accessible catalogs (never inaccessible ones,
        so search can't leak what you can't see)."""
        q = (request.args.get("q") or "").strip().lower()
        if len(q) < 2:
            return jsonify([])
        username = user["username"]
        hits: list = []

        def add(kind, name, **extra):
            if q in name.lower():
                hits.append({"kind": kind, "name": name, **extra})

        for n in _list_docs(username, "notebooks"):
            add("notebook", n)
        for n in _list_docs(username, "dashboards"):
            add("dashboard", n)
        admin = _is_admin(username)
        for w in client.list_workflows():
            if admin or w.get("username") == username:
                add("job", w.get("name", ""))
        for cat in client.list_catalogs(username):
            if cat.get("accessible") is False:
                continue
            name = cat.get("name", "")
            add("catalog", name)
            if not IDENT.match(name):
                continue
            for row in _rows(
                username,
                "SELECT table_schema, table_name FROM information_schema.tables "
                f"WHERE table_catalog = '{name}' "
                "AND table_schema NOT IN ('information_schema', 'pg_catalog')",
                name,
            ):
                table = row.get("table_name") or ""
                if q in table.lower():
                    hits.append({"kind": "table", "name": table, "catalog": name,
                                 "schema": row.get("table_schema")})
            if len(hits) >= SEARCH_MAX:
                break
        # prefix matches first, then alphabetical
        hits.sort(key=lambda h: (not h["name"].lower().startswith(q), h["name"].lower()))
        return jsonify(hits[:SEARCH_MAX])

    # ---- settings (git identity & keys) -----------------------------------------

    @app.get("/api/settings/git")
    @authed
    def api_git_settings(user):  # pyright: ignore[reportUnusedFunction]
        pubkey = ""
        got = _session_op(user["username"], {"op": "read", "path": ".ssh/id_ed25519.pub"})
        if got.get("ok"):
            pubkey = got.get("content", "")
        return jsonify({"pubkey": pubkey})

    @app.post("/api/settings/git")
    @authed
    def api_git_settings_save(user):  # pyright: ignore[reportUnusedFunction]
        body = request.get_json(silent=True) or {}
        action = body.get("action", "")
        username = user["username"]
        if action == "identity":
            _git(username, ["config", "--global", "user.name", body.get("name", "")])
            _git(username, ["config", "--global", "user.email", body.get("email", "")])
        elif action == "keygen":
            # Only ever generates when absent — never overwrites a key.
            _session_op(
                username,
                {
                    "op": "shell",
                    "command": "[ -f ~/.ssh/id_ed25519 ] || "
                    "(mkdir -p ~/.ssh && chmod 700 ~/.ssh && "
                    "ssh-keygen -t ed25519 -N '' -q -f ~/.ssh/id_ed25519)",
                },
            )
        elif action == "pat":
            host = (body.get("host") or "github.com").strip() or "github.com"
            token = (body.get("token") or "").strip()
            if token:
                # PAT lives in the user's home at 0600 (REQ-34); pebbles holds nothing.
                _session_op(
                    username,
                    {
                        "op": "shell",
                        "command": f"printf 'https://%s@{host}\\n' '{token}' > ~/.git-credentials "
                        "&& chmod 600 ~/.git-credentials",
                    },
                )
                _git(username, ["config", "--global", "credential.helper", "store"])
        else:
            return jsonify({"error": "unknown action"}), 422
        return jsonify({"ok": True})
