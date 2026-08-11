from pebbles_web import create_app


class FakeDaemon:
    def health(self):
        return {"status": "ok", "role": "main"}

    def login(self, username, password):
        if password == "pebbles-demo-1":
            return {"username": username, "uid": 70000}
        return None


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
