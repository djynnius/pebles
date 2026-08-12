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

    def open_session(self, username):
        sid = self.next_session
        self.next_session += 1
        return {"id": sid, "username": username, "uid": 70000, "pid": 4242}

    def exec_in_session(self, session_id, payload):
        op = payload["op"]
        if op == "sql":
            sql = payload["sql"]
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

    def list_catalogs(self):
        return list(self.catalogs)

    def list_users(self):
        return [{"username": "maya", "uid": 70000, "gid": 70000, "home": "/home/maya"}]

    def create_user(self, username, password):
        return {"username": username, "uid": 70002, "gid": 70002, "home": f"/home/{username}"}

    def list_groups(self):
        return [{"name": "analysts", "gid": 70050, "members": ["tomas"]}]

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
    assert "event: result" in body and '"answer": 42' in body and "event: done" in body

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


def test_api_settings_git_identity_and_keys():
    c = api_signed_in()
    assert c.get("/api/settings/git").get_json() == {"pubkey": ""}
    assert c.post(
        "/api/settings/git", json={"action": "identity", "name": "Maya", "email": "m@x.y"}
    ).status_code == 200
    assert c.post("/api/settings/git", json={"action": "keygen"}).status_code == 200
    assert c.post("/api/settings/git", json={"action": "nope"}).status_code == 422
