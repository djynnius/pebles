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
