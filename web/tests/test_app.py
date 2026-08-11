from pebbles_web import create_app
from pebbles_web.pebblesd_client import PebblesdError


class FakeDaemon:
    def __init__(self):
        self.catalogs = []
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
        assert payload["op"] == "sql"
        return {"id": None, "ok": True, "rows": [{"answer": 42}]}

    def list_catalogs(self):
        return list(self.catalogs)

    def list_engines(self):
        return [
            {
                "name": "main",
                "address": "local",
                "state": "available",
                "resources": {"cpus": 4, "memory_bytes": 0},
            },
            {
                "name": "worker-1",
                "address": "http://10.0.0.7:7443",
                "state": "available",
                "resources": {"cpus": 8, "memory_bytes": 0},
            },
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


def test_engines_page_lists_the_fleet():
    assert client().get("/engines").status_code == 302
    page = signed_in().get("/engines")
    assert page.status_code == 200
    body = page.get_data(as_text=True)
    assert "worker-1" in body and "available" in body


def test_catalog_create_shows_up_in_the_list_and_conflicts_cleanly():
    c = signed_in()
    resp = c.post("/catalogs", data={"name": "claims"})
    assert resp.status_code == 302
    page = c.get("/catalogs").get_data(as_text=True)
    assert "claims" in page and "/var/lib/pebbles/lake/claims" in page

    dup = c.post("/catalogs", data={"name": "claims"})
    assert dup.status_code == 409
    assert "already exists" in dup.get_data(as_text=True)
