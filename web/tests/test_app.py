from pebbles_web import create_app
from pebbles_web.pebblesd_client import PebblesdError


class FakeDaemon:
    def __init__(self):
        self.catalogs = []
        self.files = {}
        self.next_session = 1

    def health(self):
        return {"status": "ok", "role": "main"}

    def login(self, username, password):
        if password == "pebbles-demo-1":
            return {"username": username, "uid": 70000}
        return None

    def close_session(self, session_id):
        self.closed = getattr(self, "closed", []) + [session_id]
        return {"closed": session_id}

    def open_session(self, username, reuse=True):
        self.reuse_flags = getattr(self, "reuse_flags", []) + [reuse]
        sid = self.next_session
        self.next_session += 1
        return {"id": sid, "username": username, "uid": 70000, "pid": 4242}

    def exec_in_session(self, session_id, payload):
        op = payload["op"]
        if op == "ping":
            return {"id": None, "ok": True, "uid": 70000}
        if op == "sql":
            sql = payload["sql"]
            if sql.startswith("SUMMARIZE"):
                return {
                    "id": None,
                    "ok": True,
                    "rows": [
                        {
                            "column_name": "Claim ID",
                            "column_type": "BIGINT",
                            "min": "1",
                            "max": "999",
                            "approx_unique": 1000,
                            "null_percentage": 0.0,
                        },
                        {
                            "column_name": "state",
                            "column_type": "VARCHAR",
                            "min": "AK",
                            "max": "WY",
                            "approx_unique": 51,
                            "null_percentage": 0.0,
                        },
                        {
                            "column_name": "filed_date",
                            "column_type": "VARCHAR",
                            "min": "2024-01-01",
                            "max": "2025-12-31",
                            "approx_unique": 700,
                            "null_percentage": 2.5,
                        },
                        {
                            "column_name": "amount",
                            "column_type": "DOUBLE",
                            "min": "1.5",
                            "max": "9000.0",
                            "approx_unique": 950,
                            "null_percentage": 0.0,
                        },
                        {
                            "column_name": "legacy_code",
                            "column_type": "VARCHAR",
                            "min": "A",
                            "max": "Z",
                            "approx_unique": 3,
                            "null_percentage": 88.0,
                        },
                    ],
                }
            if "information_schema.schemata" in sql:
                return {
                    "id": None,
                    "ok": True,
                    "rows": [{"schema_name": "bronze"}, {"schema_name": "main"}],
                }
            if "information_schema.tables" in sql:
                return {
                    "id": None,
                    "ok": True,
                    "rows": [{"table_schema": "bronze", "table_name": "claims"}],
                }
            if "information_schema.columns" in sql:
                return {
                    "id": None,
                    "ok": True,
                    "rows": [
                        {"column_name": "id", "data_type": "BIGINT", "is_nullable": "NO"}
                    ],
                }
            if "ducklake_snapshots" in sql:
                return {
                    "id": None,
                    "ok": True,
                    "rows": [{"snapshot_id": 1}, {"snapshot_id": 0}],
                }
            if "count(*) AS n" in sql:
                return {"id": None, "ok": True, "rows": [{"n": 1234}]}
            return {"id": None, "ok": True, "rows": [{"answer": 42}]}
        if op in ("python", "r"):
            return {"id": None, "ok": True, "stdout": "42\n", "stderr": "", "error": None}
        if op == "write":
            self.files[payload["path"]] = payload["content"]
            return {"id": None, "ok": True}
        if op == "read":
            content = self.files.get(payload["path"])
            if content is None:
                return {"id": None, "ok": False, "error": "No such file"}
            return {"id": None, "ok": True, "content": content}
        if op == "shell":
            return {"id": None, "ok": True, "stdout": "", "stderr": "", "exit_code": 0}
        if op == "git":
            sub = payload["args"][0]
            if sub == "status":
                return {
                    "id": None,
                    "ok": True,
                    "stdout": "# branch.head main\n# branch.ab +1 -0\n"
                    "1 M. N... 100644 100644 100644 abc def analysis.sql\n"
                    "? notes.md\n",
                    "stderr": "",
                }
            if sub == "log":
                return {"id": None, "ok": True, "stdout": "abc123 first commit\n", "stderr": ""}
            return {"id": None, "ok": True, "stdout": "", "stderr": ""}
        if op == "browse":
            base = payload["path"].rstrip("/.")
            items = []
            for p in sorted(self.files):
                if "/" in p[len(base) :].lstrip("/") if base else "/" in p:
                    continue
                if base and not p.startswith(base + "/"):
                    continue
                name = p[len(base) :].lstrip("/") if base else p
                if "/" in name:
                    continue
                items.append({"name": name, "dir": False, "size": len(self.files[p]), "mtime": 0})
            return {"id": None, "ok": True, "items": items}
        if op in ("mkdir", "delete", "rename", "upload"):
            if op == "upload":
                import base64

                self.files[payload["path"]] = base64.b64decode(payload["b64"]).decode()
            if op == "delete":
                self.files.pop(payload.get("path", ""), None)
            return {"id": None, "ok": True}
        if op == "list":
            entries = sorted(
                p.split("/", 1)[1]
                for p in self.files
                if p.startswith(payload["path"] + "/")
            )
            return {"id": None, "ok": True, "entries": entries}
        raise AssertionError(f"unexpected op {op}")

    def exec_stream(self, session_id, payload):
        assert payload["op"] == "sql_stream"
        if "boom" in payload["sql"]:
            yield {"id": None, "ok": False, "done": True, "error": "kaboom"}
            return
        # two progressive batches, then the terminal line — the REQ-31 shape
        yield {"id": None, "rows": [{"answer": 42}]}
        yield {"id": None, "rows": [{"answer": 43}]}
        yield {"id": None, "ok": True, "done": True, "truncated": False}

    def list_catalogs(self):
        return list(self.catalogs)

    def list_users(self):
        return [{"username": "maya", "uid": 70000, "gid": 70000, "home": "/home/maya"}]

    def create_user(self, username, password):
        return {"username": username, "uid": 70002, "gid": 70002, "home": f"/home/{username}"}

    def list_groups(self):
        return [
            {"name": "analysts", "gid": 70050, "members": ["tomas"]},
            {"name": "admins", "gid": 70051, "members": list(getattr(self, "admins", ["maya"]))},
        ]

    def create_group(self, name):
        return {"name": name, "gid": 70051, "members": []}

    def add_group_member(self, group, username):
        return {"name": group, "gid": 70050, "members": ["tomas", username]}

    def grant_catalog(self, catalog, group):
        return {"catalog": catalog, "group": group}

    def list_catalog_grants(self, catalog):
        return [{"group": "analysts"}]

    def remove_group_member(self, group, username):
        return {"name": group, "gid": 70050, "members": ["tomas"]}

    def list_engines(self):
        return [
            {
                "name": "main",
                "address": "local",
                "state": "available",
                "sessions": 0,
                "access": "everyone",
                "resources": {"cpus": 4, "memory_bytes": 0},
            },
            {
                "name": "worker-1",
                "address": "http://10.0.0.7:7443",
                "state": "draining (reserved for tomas)",
                "sessions": 2,
                "access": "group:analysts",
                "resources": {"cpus": 8, "memory_bytes": 0},
            },
        ]

    def cancel_reservation(self, engine=None):
        return {"cancelled": True}

    def nkoyo_config(self):
        return {
            "endpoints": ["http://127.0.0.1:11434"],
            "planner_model": "llama3.2",
            "coder_model": "llama3.2",
            "embed_model": "nomic-embed-text",
            "max_steps": 16,
        }

    def nkoyo_config_save(self, cfg):
        return cfg

    def nkoyo_rescan(self):
        return [{"endpoint": "http://127.0.0.1:11434", "models": ["llama3.2:latest"]}]

    def nkoyo_chat(self, username, messages, approved=None):
        if not self.nkoyo_config()["endpoints"]:
            raise PebblesdError(503, "no Ollama endpoints configured")
        return {
            "content": f"hello {username}, you said: {messages[-1]['content']}",
            "model": "llama3.2",
            "tools_used": ["list_catalogs"] + list(approved or []),
        }

    def usage(self):
        return {
            "hostname": "pebbles-main",
            "cpus": 8,
            "load_1": 0.4,
            "load_5": 0.3,
            "load_15": 0.2,
            "mem_total_bytes": 16 * 1024**3,
            "mem_available_bytes": 12 * 1024**3,
            "disks": [{"mount": "/", "total_bytes": 100 * 1024**3, "free_bytes": 60 * 1024**3}],
        }

    def list_tokens(self):
        return [{"id": "ab12", "expires_at": 1790000000, "used": False}]

    def mint_token(self):
        return {"id": "cd34", "token": "s3cr3t-token", "expires_at": 1790000000}

    def revoke_token(self, token_id):
        return {"revoked": token_id}

    def list_pending_engines(self):
        return [
            {
                "name": "worker-9",
                "address": "http://10.0.0.9:7443",
                "cpus": 4,
                "first_seen": 1780000000,
                "approved": False,
            }
        ]

    def approve_pending_engine(self, name):
        return {"approved": name}

    def reject_pending_engine(self, name):
        return {"rejected": name}

    def deregister_engine(self, name):
        return {"deregistered": name}

    def list_workflows(self):
        return list(getattr(self, "workflows", []))

    def save_workflow(self, workflow):
        self.workflows = getattr(self, "workflows", [])
        for existing in self.workflows:
            if existing["name"] == workflow["name"]:
                if existing["username"] != workflow["username"]:
                    raise PebblesdError(409, "a job named that already belongs to another user")
                self.workflows.remove(existing)
                break
        self.workflows.append(workflow)
        return workflow

    def trigger_workflow(self, name):
        return {"triggered": name}

    def workflow_runs(self, name):
        return [{"run_id": "manual__1", "state": "success", "start": "t0", "end": "t1"}]

    def workflow_run_detail(self, name, run_id):
        return [
            {
                "task_id": "load",
                "state": "success",
                "start": "t0",
                "end": "t1",
                "log": "pebbles: session 1 opened as maya (uid 70000)",
            }
        ]

    def create_catalog(self, name, owner):
        if any(c["name"] == name for c in self.catalogs):
            raise PebblesdError(409, f"catalog {name!r} already exists")
        info = {
            "name": name,
            "owner": owner,
            "database": f"ducklake_{name}",
            "data_path": f"/var/lib/pebbles/lake/{name}",
            "sql": f"CREATE CATALOG {name};",
        }
        self.catalogs.append(info)
        return info


class DownDaemon:
    def health(self):
        raise ConnectionError("no socket")


def client(daemon=None):
    app = create_app(pebblesd=daemon or FakeDaemon())
    app.testing = True
    return app.test_client()


def api_signed_in(daemon=None):
    c = client(daemon)
    c.post("/api/login", json={"username": "maya", "password": "pebbles-demo-1"})
    return c


# ---- health & SPA serving ----------------------------------------------------


def test_healthz_aggregates_pebblesd_over_the_socket():
    resp = client().get("/healthz")
    assert resp.status_code == 200
    body = resp.get_json()
    assert body["status"] == "ok"
    assert body["role"] == "main"
    assert body["pebblesd"] == {"status": "ok", "role": "main"}


def test_healthz_degrades_to_503_when_pebblesd_is_unreachable():
    resp = client(DownDaemon()).get("/healthz")
    assert resp.status_code == 503
    body = resp.get_json()
    assert body["status"] == "degraded"
    assert "no socket" in body["pebblesd"]["error"]


def test_spa_owns_root_and_every_deep_link():
    c = client()
    # 200 when the React bundle is built, 503 with guidance otherwise — never 404,
    # and never a redirect: the SPA handles auth client-side.
    for path in ("/", "/catalog", "/sql", "/jobs", "/settings", "/nkoyo"):
        assert c.get(path).status_code in (200, 503), path


def test_legacy_app_prefix_redirects_home():
    c = client()
    resp = c.get("/app/catalog")
    assert resp.status_code == 301
    assert resp.headers["Location"].endswith("/catalog")


def test_unknown_api_path_is_a_json_404_not_the_spa():
    resp = api_signed_in().get("/api/definitely-not-a-thing")
    assert resp.status_code == 404
    assert resp.get_json()["error"] == "no such endpoint"


# ---- auth ---------------------------------------------------------------------


def test_json_api_auth_and_data():
    c = client()
    assert c.get("/api/me").status_code == 401
    assert c.get("/api/usage").status_code == 401

    bad = c.post("/api/login", json={"username": "maya", "password": "nope"})
    assert bad.status_code == 401

    ok = c.post("/api/login", json={"username": "maya", "password": "pebbles-demo-1"})
    assert ok.status_code == 200
    assert ok.get_json()["username"] == "maya"

    me = c.get("/api/me")
    assert me.status_code == 200 and me.get_json()["uid"] == 70000

    usage = c.get("/api/usage").get_json()
    assert usage["cpus"] == 8
    engines = c.get("/api/engines").get_json()
    assert any(e["name"] == "worker-1" for e in engines)
    users = c.get("/api/users").get_json()
    assert any(u["username"] == "maya" for u in users)
    groups = c.get("/api/groups").get_json()
    assert any(g["name"] == "analysts" for g in groups)

    assert c.post("/api/logout").status_code == 200
    assert c.get("/api/me").status_code == 401


def test_web_sessions_reuse_and_are_released_on_logout():
    # UAT: every login forked a fresh kernel until admission locked everyone
    # out. The web tier must request reuse, and logout must free the session.
    d = FakeDaemon()
    c = api_signed_in(d)
    assert c.post("/api/sql", json={"sql": "SELECT 1"}).status_code == 200
    assert d.reuse_flags and all(d.reuse_flags)
    assert c.post("/api/logout").status_code == 200
    assert d.closed == [1]


def test_api_endpoints_require_auth():
    c = client()
    for path in ("/api/catalogs", "/api/files", "/api/notebooks", "/api/jobs", "/api/tokens"):
        assert c.get(path).status_code == 401, path


# ---- catalogs -------------------------------------------------------------------


def test_api_catalog_create_tree_and_table_detail():
    c = api_signed_in()
    created = c.post("/api/catalogs", json={"name": "claims"})
    assert created.status_code == 200
    assert created.get_json()["owner"] == "maya"  # owner is the signed-in user
    assert any(cat["name"] == "claims" for cat in c.get("/api/catalogs").get_json())

    # conflicts surface with their real status, not a blanket 500
    dup = c.post("/api/catalogs", json={"name": "claims"})
    assert dup.status_code == 409 and "already exists" in dup.get_json()["error"]

    tree = c.get("/api/catalogs/claims/tree")
    assert tree.status_code == 200
    schemas = {s["name"]: s["tables"] for s in tree.get_json()["schemas"]}
    assert schemas["bronze"] == ["claims"] and "main" in schemas

    detail = c.get("/api/catalogs/claims/tables/bronze/claims").get_json()
    assert detail["columns"][0]["column_name"] == "id"
    assert detail["row_count"] == 1234
    assert detail["snapshots"][0]["snapshot_id"] == 1
    assert detail["sample"] == [{"answer": 42}]

    # identifier validation refuses anything that isn't a bare identifier
    assert c.get("/api/catalogs/claims/tables/bad-schema/t").status_code == 422
    assert c.get("/api/catalogs/bad-name!/tree").status_code == 422

    grants = c.get("/api/catalogs/claims/grants").get_json()
    assert grants == [{"group": "analysts"}]
    assert c.post(
        "/api/catalogs/claims/grants", json={"group": "analysts"}
    ).status_code == 200


# ---- SQL ------------------------------------------------------------------------


def test_api_sql_exec_and_stream():
    c = api_signed_in()
    got = c.post("/api/sql", json={"sql": "SELECT 42 AS answer"}).get_json()
    assert got["ok"] and got["rows"] == [{"answer": 42}]
    assert c.post("/api/sql", json={"sql": " "}).status_code == 422

    stream = c.get("/api/sql/stream?q=SELECT+42+AS+answer")
    assert stream.mimetype == "text/event-stream"
    body = stream.get_data(as_text=True)
    # progressive: row batches arrive as their own events BEFORE the final
    # result (REQ-31 — real streaming, not block-then-emit)
    assert body.index("event: rows") < body.index("event: result")
    assert '"answer": 42' in body and '"answer": 43' in body
    assert "event: result" in body and "event: done" in body

    err = c.get("/api/sql/stream?q=SELECT+boom").get_data(as_text=True)
    assert "event: error" in err and "kaboom" in err and "event: done" in err

    assert client().get("/api/sql/stream?q=SELECT+1").status_code == 401


# ---- files ----------------------------------------------------------------------


def test_api_files_crud_download_and_traversal_guard():
    import io

    c = api_signed_in()
    up = c.post(
        "/api/files/upload",
        data={"dir": "", "file": (io.BytesIO(b"hello api"), "notes.txt")},
        content_type="multipart/form-data",
    )
    assert up.get_json()["uploaded"] == ["notes.txt"]

    listing = c.get("/api/files").get_json()
    assert any(i["name"] == "notes.txt" for i in listing["items"])

    dl = c.get("/api/files/download?path=notes.txt")
    assert dl.status_code == 200 and b"hello api" in dl.data

    assert c.post("/api/files/mkdir", json={"dir": "", "name": "data"}).status_code == 200
    assert c.post(
        "/api/files/rename", json={"path": "notes.txt", "to": "notes2.txt"}
    ).status_code == 200
    assert c.post("/api/files/delete", json={"path": "notes2.txt"}).status_code == 200

    # traversal never escapes the home: leading ".." collapses against it, so
    # "../../etc" is the (empty) home-relative "etc", not the host's /etc
    contained = c.get("/api/files?path=../../etc")
    assert contained.status_code in (200, 502) and "/etc" not in contained.get_data(
        as_text=True
    )
    assert c.get("/api/files/download?path=../etc/passwd").status_code == 404


# ---- notebooks & dashboards ------------------------------------------------------


def test_api_notebooks_crud_and_cell_stream():
    c = api_signed_in()
    assert c.get("/api/notebooks").get_json() == []
    made = c.post("/api/notebooks", json={"name": "eda"})
    assert made.status_code == 200 and made.get_json()["name"] == "eda"
    assert c.post("/api/notebooks", json={"name": "../evil"}).status_code == 422

    saved = c.put(
        "/api/notebooks/eda",
        json={
            "catalog": "claims",
            "cells": [
                {"type": "sql", "source": "SELECT 42 AS answer;"},
                {"type": "python", "source": "x = 41\nx + 1"},
                {"type": "sparkle", "source": "dropped"},
            ],
        },
    )
    assert saved.status_code == 200

    nb = c.get("/api/notebooks/eda").get_json()
    assert nb["catalog"] == "claims" and len(nb["cells"]) == 2  # bad kind dropped

    sql_stream = c.get("/api/notebooks/eda/cells/0/stream").get_data(as_text=True)
    assert "event: result" in sql_stream and '"answer": 42' in sql_stream
    py_stream = c.get("/api/notebooks/eda/cells/1/stream").get_data(as_text=True)
    assert '"stdout": "42' in py_stream
    gone = c.get("/api/notebooks/eda/cells/9/stream").get_data(as_text=True)
    assert "no such cell" in gone

    assert c.get("/api/notebooks").get_json() == ["eda"]
    assert c.delete("/api/notebooks/eda").status_code == 200
    assert c.get("/api/notebooks/missing").status_code == 404


def test_api_dashboards_crud_and_tile_stream():
    c = api_signed_in()
    assert c.post("/api/dashboards", json={"name": "kpis"}).status_code == 200
    saved = c.put(
        "/api/dashboards/kpis",
        json={
            "catalog": "claims",
            "tiles": [{"title": "Total", "kind": "stat", "sql": "SELECT 42 AS answer;"}],
        },
    )
    assert saved.status_code == 200
    dash = c.get("/api/dashboards/kpis").get_json()
    assert dash["tiles"][0]["kind"] == "stat"

    tile = c.get("/api/dashboards/kpis/tiles/0/stream").get_data(as_text=True)
    assert "event: result" in tile and '"answer": 42' in tile
    gone = c.get("/api/dashboards/kpis/tiles/5/stream").get_data(as_text=True)
    assert "no such tile" in gone


# ---- jobs -------------------------------------------------------------------------


def test_api_jobs_save_run_and_history():
    c = api_signed_in()
    assert c.get("/api/jobs").get_json() == []
    saved = c.post(
        "/api/jobs",
        json={
            "name": "nightly",
            "schedule": "0 2 * * *",
            "tasks": [{"id": "load", "task_type": "sql", "payload": "SELECT 1;"}],
        },
    )
    assert saved.get_json()["username"] == "maya"  # owner forced to signed-in user
    assert c.post("/api/jobs/nightly/run").status_code == 200
    assert c.get("/api/jobs/nightly/runs").get_json()[0]["state"] == "success"
    detail = c.get("/api/jobs/nightly/runs/manual__1").get_json()
    assert "uid 70000" in detail[0]["log"]


# ---- nkoyo ------------------------------------------------------------------------


def test_api_nkoyo_chat_history_and_config():
    c = api_signed_in()
    assert c.get("/api/nkoyo/chat").get_json() == []
    reply = c.post(
        "/api/nkoyo/send", json={"prompt": "profile claims", "approved": ["write_file"]}
    ).get_json()
    assert "you said: profile claims" in reply["content"]
    assert "write_file" in reply["tools_used"]

    history = c.get("/api/nkoyo/chat").get_json()
    assert history[0]["role"] == "user" and history[1]["role"] == "assistant"
    assert c.post("/api/nkoyo/send", json={"prompt": ""}).status_code == 422
    assert c.post("/api/nkoyo/clear").status_code == 200
    assert c.get("/api/nkoyo/chat").get_json() == []

    cfg = c.get("/api/nkoyo/config").get_json()
    assert cfg["planner_model"] == "llama3.2"
    assert c.post(
        "/api/nkoyo/config",
        json={"endpoints": ["http://127.0.0.1:11434"], "max_steps": 12},
    ).status_code == 200
    rescan = c.post("/api/nkoyo/rescan").get_json()
    assert rescan[0]["models"] == ["llama3.2:latest"]


# ---- repos ------------------------------------------------------------------------


def test_api_repos_clone_status_and_git_actions():
    c = api_signed_in()
    assert c.get("/api/repos").get_json() == []
    cloned = c.post("/api/repos/clone", json={"url": "https://x.y/proj.git"})
    assert cloned.get_json()["name"] == "proj"

    status = c.get("/api/repos/proj/status").get_json()
    assert status["branch"] == "main" and status["ahead"] == 1

    assert c.post(
        "/api/repos/proj/git", json={"action": "stage", "path": "notes.md"}
    ).status_code == 200
    assert c.post("/api/repos/proj/git", json={"action": "rebase"}).status_code == 422
    log = c.post("/api/repos/proj/git", json={"action": "log"}).get_json()
    assert "first commit" in log["stdout"]


# ---- cluster & admin ---------------------------------------------------------------


def test_api_cluster_and_admin_endpoints():
    c = api_signed_in()
    assert c.post("/api/users", json={"username": "ade", "password": "p3"}).status_code == 200
    assert c.post("/api/groups", json={"name": "science"}).status_code == 200
    assert c.post(
        "/api/groups/analysts/members", json={"username": "maya"}
    ).status_code == 200
    assert c.delete("/api/groups/analysts/members/maya").status_code == 200

    assert c.get("/api/tokens").get_json()[0]["id"] == "ab12"
    minted = c.post("/api/tokens").get_json()
    assert minted["token"] == "s3cr3t-token"  # shown exactly once, in this response
    assert c.delete("/api/tokens/ab12").status_code == 200

    pending = c.get("/api/engines/pending").get_json()
    assert pending[0]["name"] == "worker-9"
    assert c.post("/api/engines/pending/worker-9/approve").status_code == 200
    assert c.delete("/api/engines/pending/worker-9").status_code == 200
    assert c.delete("/api/engines/worker-1").status_code == 200
    assert c.post(
        "/api/engines/cancel-reservation", json={"engine": "worker-1"}
    ).status_code == 200


def test_autoetl_propose_rules():
    from pebbles_web.autoetl import build_tasks, propose

    columns = [
        {"column_name": "Claim ID", "column_type": "BIGINT", "approx_unique": 1000,
         "null_percentage": 0.0, "min": "1", "max": "999"},
        {"column_name": "state", "column_type": "VARCHAR", "approx_unique": 51,
         "null_percentage": 0.0, "min": "AK", "max": "WY"},
        {"column_name": "filed_date", "column_type": "VARCHAR", "approx_unique": 700,
         "null_percentage": 2.5, "min": "2024-01-01", "max": "2025-12-31"},
        {"column_name": "amount", "column_type": "DOUBLE", "approx_unique": 950,
         "null_percentage": 0.0, "min": "1.5", "max": "9000.0"},
        {"column_name": "legacy_code", "column_type": "VARCHAR", "approx_unique": 3,
         "null_percentage": 88.0, "min": "A", "max": "Z"},
    ]
    p = propose(columns, 10_000, {"kind": "file", "path": "claims 2025.csv"})
    steps = {s["id"]: s for s in p["cleaning"]}

    # rename "Claim ID" → claim_id, high confidence, ticked
    assert steps["rename_claim_id"]["ticked"] and steps["rename_claim_id"]["to"] == "claim_id"
    # ISO date strings cast confidently
    assert steps["cast_filed_date"]["to_type"] == "DATE" and steps["cast_filed_date"]["ticked"]
    # mostly-null column proposed for dropping, but UNTICKED (low confidence)
    assert steps["drop_col_legacy_code"]["confidence"] < 0.8
    assert not steps["drop_col_legacy_code"]["ticked"]
    # small null fraction → optional row filter, unticked
    assert not steps["drop_nulls_filed_date"]["ticked"]
    # dedupe always offered, never pre-ticked
    assert not steps["dedupe"]["ticked"]

    model = p["model"]
    assert p["name"] == "claims_2025"
    assert model["kind"] == "star"
    assert {"column": "state", "table": "dim_state"} in model["dims"]
    assert "amount" in model["measures"] and "claim_id" in model["measures"]

    # approve only the ticked steps → deterministic SQL plan
    approved = [s for s in p["cleaning"] if s["ticked"]]
    tasks = build_tasks("claims_2025", {"kind": "file", "path": "claims 2025.csv"},
                        approved, model, "claims")
    ids = [t["id"] for t in tasks]
    assert ids[0] == "stage" and "dim_state" in ids and ids[-1] == "fact"
    stage_sql = tasks[0]["payload"]
    assert "read_csv_auto('claims 2025.csv')" in stage_sql
    assert 'TRY_CAST("filed_date" AS DATE)' in stage_sql
    assert '"Claim ID" AS "claim_id"' in stage_sql
    assert "DISTINCT" not in stage_sql  # dedupe wasn't approved
    fact = next(t for t in tasks if t["id"] == "fact")
    assert fact["depends_on"] == ["dim_state"]
    assert 'LEFT JOIN "dim_state"' in fact["payload"]
    assert all(t["catalog"] == "claims" for t in tasks)


def test_autoetl_rejects_unsafe_sources():
    from pebbles_web.autoetl import source_expr

    # leading ".." collapses against the home (same containment policy as the
    # files API) — the path never escapes, it just resolves inside the home
    assert source_expr({"kind": "file", "path": "../etc/passwd.csv"}) == (
        "read_csv_auto('etc/passwd.csv')"
    )
    assert source_expr({"kind": "file", "path": "x'); DROP TABLE t; --.csv"}) is None
    assert source_expr({"kind": "file", "path": "notes.exe"}) is None
    assert source_expr({"kind": "table", "name": "claims; DROP"}) is None
    assert source_expr({"kind": "table", "name": "claims_t"}) == "claims_t"
    assert source_expr({"kind": "file", "path": "data/claims.parquet"}) == (
        "read_parquet('data/claims.parquet')"
    )


def test_api_autoetl_profile_and_approve():
    c = api_signed_in()
    prof = c.post(
        "/api/autoetl/profile",
        json={"source": {"kind": "file", "path": "claims.csv"}, "catalog": "claims"},
    )
    assert prof.status_code == 200
    body = prof.get_json()
    assert body["row_count"] == 1234  # count(*) AS n via the fake
    assert any(col["column_name"] == "state" for col in body["columns"])
    proposal = body["proposal"]
    assert proposal["model"]["kind"] == "star"

    bad = c.post(
        "/api/autoetl/profile",
        json={"source": {"kind": "file", "path": "x'); attack--.csv"}},
    )
    assert bad.status_code == 422

    approved = [s for s in proposal["cleaning"] if s["ticked"]]
    ok = c.post(
        "/api/autoetl/approve",
        json={
            "name": proposal["name"],
            "catalog": "claims",
            "source": {"kind": "file", "path": "claims.csv"},
            "steps": approved,
            "model": proposal["model"],
            "run": True,
        },
    )
    assert ok.status_code == 200
    out = ok.get_json()
    assert out["workflow"]["username"] == "maya"  # loads run as the approver
    assert out["run"] == {"triggered": proposal["name"]}
    task_ids = [t["id"] for t in out["workflow"]["tasks"]]
    assert task_ids[0] == "stage" and task_ids[-1] == "fact"

    # nothing loads on a bad plan
    assert c.post(
        "/api/autoetl/approve",
        json={"name": "x!", "catalog": "claims", "source": {}, "steps": [], "model": {}},
    ).status_code == 422


def test_api_settings_git_identity_and_keys():
    c = api_signed_in()
    assert c.get("/api/settings/git").get_json() == {"pubkey": ""}
    assert c.post(
        "/api/settings/git", json={"action": "identity", "name": "Maya", "email": "m@x.y"}
    ).status_code == 200
    assert c.post("/api/settings/git", json={"action": "keygen"}).status_code == 200
    assert c.post("/api/settings/git", json={"action": "nope"}).status_code == 422


# ---- authorization (UAT: every user was effectively an admin) ---------------


def signed_in_as(username, daemon=None):
    c = client(daemon)
    c.post("/api/login", json={"username": username, "password": "pebbles-demo-1"})
    return c


def test_me_reports_admin_membership():
    d = FakeDaemon()
    assert signed_in_as("maya", d).get("/api/me").get_json()["admin"] is True
    assert signed_in_as("tomas", d).get("/api/me").get_json()["admin"] is False


def test_non_admins_are_refused_every_admin_action():
    c = signed_in_as("tomas")
    refused = [
        ("post", "/api/users", {"username": "evil", "password": "evil-pass-1"}),
        ("post", "/api/groups", {"name": "evil"}),
        ("post", "/api/groups/admins/members", {"username": "tomas"}),
        ("delete", "/api/groups/analysts/members/tomas", None),
        ("get", "/api/tokens", None),
        ("post", "/api/tokens", None),
        ("delete", "/api/tokens/ab12", None),
        ("get", "/api/engines/pending", None),
        ("post", "/api/engines/pending/worker-9/approve", None),
        ("delete", "/api/engines/pending/worker-9", None),
        ("delete", "/api/engines/worker-1", None),
        ("post", "/api/nkoyo/config", {"endpoints": ["http://attacker:11434"]}),
        ("post", "/api/nkoyo/rescan", None),
    ]
    for method, path, body in refused:
        resp = getattr(c, method)(path, json=body) if body else getattr(c, method)(path)
        assert resp.status_code == 403, (method, path, resp.status_code)
    # ordinary reads stay open to everyone
    assert c.get("/api/users").status_code == 200
    assert c.get("/api/groups").status_code == 200


def test_the_last_admin_cannot_be_removed():
    c = signed_in_as("maya")
    assert c.delete("/api/groups/admins/members/maya").status_code == 409


def test_jobs_are_scoped_to_their_owner():
    d = FakeDaemon()
    maya, tomas = signed_in_as("maya", d), signed_in_as("tomas", d)
    job = {"name": "nightly", "schedule": None,
           "tasks": [{"id": "t", "task_type": "sql", "payload": "SELECT 1"}]}
    assert tomas.post("/api/jobs", json=job).status_code == 200
    d.admins = []  # maya is an ordinary user for this test
    # another user can't see, run, inspect, or overwrite tomas's job
    assert maya.get("/api/jobs").get_json() == []
    assert maya.post("/api/jobs/nightly/run").status_code == 404
    assert maya.get("/api/jobs/nightly/runs").status_code == 404
    assert maya.post("/api/jobs", json=job).status_code == 409
    # the owner keeps full control
    assert tomas.post("/api/jobs/nightly/run").status_code == 200
    # admins see everything
    d.admins = ["maya"]
    assert [w["name"] for w in maya.get("/api/jobs").get_json()] == ["nightly"]


def test_only_owner_or_admin_grants_a_catalog():
    d = FakeDaemon()
    maya, tomas = signed_in_as("maya", d), signed_in_as("tomas", d)
    assert maya.post("/api/catalogs", json={"name": "claims"}).status_code == 200
    assert tomas.post("/api/catalogs/claims/grants", json={"group": "analysts"}).status_code == 403
    assert maya.post("/api/catalogs/claims/grants", json={"group": "analysts"}).status_code == 200
