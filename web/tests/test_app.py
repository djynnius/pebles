from pebbles_web import create_app


def client():
    app = create_app()
    app.testing = True
    return app.test_client()


def test_healthz_reports_ok():
    resp = client().get("/healthz")
    assert resp.status_code == 200
    assert resp.get_json() == {"status": "ok", "service": "pebbles-web"}


def test_index_serves_the_wordmark_shell():
    resp = client().get("/")
    assert resp.status_code == 200
    body = resp.get_data(as_text=True)
    assert "les" in body and "data-pb-theme" in body
