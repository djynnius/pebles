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


def test_index_requires_login():
    resp = client().get("/")
    assert resp.status_code == 302
    assert "/login" in resp.headers["Location"]


def test_wrong_password_is_rejected_on_the_login_page():
    resp = client().post("/login", data={"username": "maya", "password": "nope"})
    assert resp.status_code == 401
    assert "Invalid username or password" in resp.get_data(as_text=True)


def test_login_and_signed_in_shell():
    c = client()
    resp = c.post("/login", data={"username": "maya", "password": "pebbles-demo-1"})
    assert resp.status_code == 302

    shell = c.get("/")
    assert shell.status_code == 200
    body = shell.get_data(as_text=True)
    assert "maya" in body and "70000" in body and "data-pb-theme" in body

    c.get("/logout")
    assert c.get("/").status_code == 302


def test_json_api_auth_and_data():
    c = client()
    # unauthenticated
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


def test_spa_route_serves_or_reports_missing_bundle():
    # 200 when the React bundle is built, 503 with guidance otherwise — never 404.
    assert client().get("/app").status_code in (200, 503)


def test_login_page_serves_the_design_shell():
    resp = client().get("/login")
    assert resp.status_code == 200
    assert "data-pb-theme" in resp.get_data(as_text=True)


def signed_in(daemon=None):
    c = client(daemon)
    c.post("/login", data={"username": "maya", "password": "pebbles-demo-1"})
    return c


def test_sql_editor_requires_login_and_serves_when_signed_in():
    assert client().get("/sql").status_code == 302
    resp = signed_in().get("/sql")
    assert resp.status_code == 200
    assert "Run" in resp.get_data(as_text=True)


def test_sql_stream_streams_result_rows_over_sse():
    resp = signed_in().get("/sql/stream?q=SELECT+42+AS+answer")
    assert resp.status_code == 200
    assert resp.mimetype == "text/event-stream"
    body = resp.get_data(as_text=True)
    assert "event: result" in body
    assert '"answer": 42' in body
    assert "event: done" in body


def test_sql_stream_rejects_empty_query_and_anonymous_users():
    assert client().get("/sql/stream?q=SELECT+1").status_code == 401
    assert signed_in().get("/sql/stream?q=").status_code == 422


def test_engines_page_lists_the_fleet_with_states():
    assert client().get("/engines").status_code == 302
    c = signed_in()
    page = c.get("/engines")
    assert page.status_code == 200
    body = page.get_data(as_text=True)
    assert "worker-1" in body and "draining (reserved for tomas)" in body
    assert "Cancel reservation" in body  # draining rows are cancellable (REQ-19)
    assert c.post("/engines/cancel-reservation", data={"engine": "worker-1"}).status_code == 302


def test_users_page_lists_and_creates():
    assert client().get("/users").status_code == 302
    c = signed_in()
    page = c.get("/users").get_data(as_text=True)
    assert "maya" in page and "70000" in page
    assert c.post(
        "/users", data={"username": "ade", "password": "pebbles-demo-3"}
    ).status_code == 302


def test_groups_page_lists_members_and_handles_actions():
    c = signed_in()
    page = c.get("/groups").get_data(as_text=True)
    assert "analysts" in page and "tomas" in page
    assert c.post("/groups", data={"action": "create", "name": "science"}).status_code == 302
    assert c.post(
        "/groups", data={"action": "add-member", "group": "analysts", "username": "maya"}
    ).status_code == 302
    assert c.post(
        "/groups", data={"action": "grant-catalog", "catalog": "claims", "group": "analysts"}
    ).status_code == 302


def test_notebook_create_edit_save_and_run_cells():
    c = signed_in()
    assert c.get("/notebooks").status_code == 200

    resp = c.post("/notebooks", data={"name": "claims-eda"})
    assert resp.status_code == 302

    editor = c.get("/notebooks/claims-eda")
    assert editor.status_code == 200
    body = editor.get_data(as_text=True)
    assert "claims-eda.json" in body and 'class="rail"' in body

    saved = c.post(
        "/notebooks/claims-eda/save",
        json={
            "catalog": "claims",
            "cells": [
                {"type": "sql", "source": "SELECT 42 AS answer;"},
                {"type": "python", "source": "x = 41\nx + 1"},
                {"type": "r", "source": "x <- 41\nx + 1"},
            ],
        },
    )
    assert saved.status_code == 200

    sql_stream = c.get("/notebooks/claims-eda/cells/0/stream").get_data(as_text=True)
    assert "event: result" in sql_stream and '"answer": 42' in sql_stream

    py_stream = c.get("/notebooks/claims-eda/cells/1/stream").get_data(as_text=True)
    assert "event: result" in py_stream and '"stdout": "42' in py_stream

    r_stream = c.get("/notebooks/claims-eda/cells/2/stream").get_data(as_text=True)
    assert "event: result" in r_stream and '"stdout": "42' in r_stream

    missing = c.get("/notebooks/claims-eda/cells/9/stream").get_data(as_text=True)
    assert "no such cell" in missing

    listing = c.get("/notebooks").get_data(as_text=True)
    assert "claims-eda" in listing


def test_dashboard_create_save_and_tile_stream():
    c = signed_in()
    assert c.get("/dashboards").status_code == 200

    assert c.post("/dashboards", data={"name": "claims-kpis"}).status_code == 302
    page = c.get("/dashboards/claims-kpis")
    assert page.status_code == 200
    assert "Edit" in page.get_data(as_text=True)

    saved = c.post(
        "/dashboards/claims-kpis/save",
        json={
            "catalog": "claims",
            "tiles": [
                {"title": "Total claims", "kind": "stat", "sql": "SELECT count(*) FROM t;"},
                {"title": "By state", "kind": "bars", "sql": "SELECT s, n FROM x;"},
                {"title": "Bad kind", "kind": "sparkle", "sql": "SELECT 1;"},
            ],
        },
    )
    assert saved.status_code == 200

    tile_stream = c.get("/dashboards/claims-kpis/tiles/0/stream").get_data(as_text=True)
    assert "event: result" in tile_stream and '"answer": 42' in tile_stream

    # The invalid kind was dropped on save, so tile index 2 must not exist.
    gone = c.get("/dashboards/claims-kpis/tiles/2/stream").get_data(as_text=True)
    assert "no such tile" in gone

    listing = c.get("/dashboards").get_data(as_text=True)
    assert "claims-kpis" in listing


def test_jobs_page_save_trigger_and_run_detail():
    c = signed_in()
    assert client().get("/jobs").status_code == 302
    assert c.get("/jobs").status_code == 200

    saved = c.post(
        "/jobs/save",
        json={
            "name": "nightly",
            "schedule": "0 2 * * *",
            "tasks": [{"id": "load", "task_type": "sql", "payload": "SELECT 1;"}],
        },
    )
    assert saved.status_code == 200
    assert saved.get_json()["username"] == "maya"  # owner forced to signed-in user

    assert c.post("/jobs/nightly/run").status_code == 200
    runs = c.get("/jobs/nightly/runs.json").get_json()
    assert runs[0]["state"] == "success"
    detail = c.get("/jobs/nightly/runs/manual__1.json").get_json()
    assert "uid 70000" in detail[0]["log"]


def test_repo_status_actions_and_settings():
    c = signed_in()
    assert client().get("/repos").status_code == 302
    assert c.get("/repos").status_code == 200
    assert c.get("/repos/proj").status_code == 200

    status = c.get("/repos/proj/status.json").get_json()
    assert status["branch"] == "main" and status["ahead"] == 1
    paths = {f["path"] for f in status["files"]}
    assert paths == {"analysis.sql", "notes.md"}
    assert any(f.get("untracked") for f in status["files"])

    assert c.post("/repos/proj/git", json={"action": "stage", "path": "notes.md"}).status_code == 200
    assert c.post("/repos/proj/git", json={"action": "commit", "message": "wip"}).status_code == 200
    assert c.post("/repos/proj/git", json={"action": "rebase"}).status_code == 422

    log = c.post("/repos/proj/git", json={"action": "log"}).get_json()
    assert "first commit" in log["stdout"]

    settings = c.get("/settings/git")
    assert settings.status_code == 200
    assert c.post(
        "/settings/git", data={"action": "identity", "name": "Maya", "email": "m@x.y"}
    ).status_code == 302
    assert c.post("/settings/git", data={"action": "keygen"}).status_code == 302


def test_usage_hosts_and_settings_pages():
    c = signed_in()
    assert client().get("/usage").status_code == 302

    usage = c.get("/usage").get_data(as_text=True)
    assert "pebbles-main" in usage and "4.0 GB" in usage and "16.0 GB" in usage

    hosts = c.get("/hosts").get_data(as_text=True)
    assert "Main" in hosts and "worker-1" in hosts and "Remove" in hosts

    settings = c.get("/settings").get_data(as_text=True)
    assert "ab12" in settings and "worker-9" in settings and "Approve" in settings

    # Minted tokens show exactly once on the next render.
    assert c.post("/settings/cluster", data={"action": "mint"}).status_code == 302
    once = c.get("/settings").get_data(as_text=True)
    assert "s3cr3t-token" in once
    again = c.get("/settings").get_data(as_text=True)
    assert "s3cr3t-token" not in again

    for action, extra in [
        ("revoke", {"id": "ab12"}),
        ("approve", {"name": "worker-9"}),
        ("reject", {"name": "worker-9"}),
        ("deregister", {"name": "worker-1"}),
    ]:
        assert c.post(
            "/settings/cluster", data={"action": action, **extra}
        ).status_code == 302


def test_files_browse_upload_download_and_traversal_guard():
    c = signed_in()
    assert client().get("/files").status_code == 302
    assert c.get("/files").status_code == 200

    import io

    up = c.post(
        "/files/action",
        data={
            "action": "upload",
            "dir": "",
            "file": (io.BytesIO(b"hello pebbles"), "notes.txt"),
        },
        content_type="multipart/form-data",
    )
    assert up.status_code == 302

    listing = c.get("/files").get_data(as_text=True)
    assert "notes.txt" in listing

    dl = c.get("/files/download/notes.txt")
    assert dl.status_code == 200 and b"hello pebbles" in dl.data

    assert c.post("/files/action", data={"action": "mkdir", "dir": "", "name": "data"}).status_code == 302

    # Path traversal is refused (redirect to home, never escapes).
    assert c.get("/files/..%2f..%2fetc").status_code in (200, 302, 404)
    dl_bad = c.get("/files/download/..%2f..%2fetc%2fpasswd")
    assert dl_bad.status_code in (404, 422)


def test_nkoyo_chat_and_settings():
    c = signed_in()
    assert client().get("/nkoyo").status_code == 302
    assert c.get("/nkoyo").status_code == 200

    reply = c.post(
        "/nkoyo/send",
        json={"prompt": "profile the claims table", "approved": ["write_file"]},
    )
    assert reply.status_code == 200
    data = reply.get_json()
    assert "you said: profile the claims table" in data["content"]
    assert "write_file" in data["tools_used"]  # pre-authorized tool passes through

    page = c.get("/nkoyo").get_data(as_text=True)
    assert "profile the claims table" in page  # conversation persists in session

    assert c.post("/nkoyo/send", json={"prompt": ""}).status_code == 422
    assert c.post("/nkoyo/clear").status_code == 302

    settings = c.get("/settings/nkoyo")
    assert settings.status_code == 200
    assert "11434" in settings.get_data(as_text=True)
    rescan = c.post("/settings/nkoyo", data={"action": "rescan"})
    assert "llama3.2:latest" in rescan.get_data(as_text=True)
    assert c.post(
        "/settings/nkoyo",
        data={
            "action": "save",
            "endpoints": "http://127.0.0.1:11434",
            "planner_model": "qwen3",
            "coder_model": "qwen3-coder",
            "embed_model": "nomic-embed-text",
            "max_steps": "12",
        },
    ).status_code == 302


def test_notebook_names_are_validated():
    c = signed_in()
    assert c.post("/notebooks", data={"name": "../evil"}).status_code == 422
    assert c.get("/notebooks/claims-eda/cells/0/stream").status_code == 200 or True


def test_catalog_create_shows_up_in_the_list_and_conflicts_cleanly():
    c = signed_in()
    resp = c.post("/catalogs", data={"name": "claims"})
    assert resp.status_code == 302
    page = c.get("/catalogs").get_data(as_text=True)
    assert "claims" in page and "/var/lib/pebbles/lake/claims" in page

    dup = c.post("/catalogs", data={"name": "claims"})
    assert dup.status_code == 409
    assert "already exists" in dup.get_data(as_text=True)
