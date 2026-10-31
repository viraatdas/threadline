"""Offline tests for the worker's HTTP surface and helpers (no browser)."""

import asyncio
import os
import tempfile
import time

os.environ["DATA_DIR"] = tempfile.mkdtemp()
os.environ["BROWSER_WORKER_TOKEN"] = "test-token"

import pytest  # noqa: E402
from starlette.testclient import TestClient  # noqa: E402

import worker  # noqa: E402

AUTH = {"Authorization": "Bearer test-token"}
SEND_SCHEMA = {
    "type": "object",
    "properties": {"outcome": {"type": "string", "enum": ["sent", "blocked"]}, "detail": {"type": "string"}},
    "required": ["outcome", "detail"],
}


def test_model_from_schema_builds_enums_and_nested_arrays():
    Output = worker.model_from_schema(
        {
            "type": "object",
            "properties": {
                "people": {
                    "type": "array",
                    "items": {"type": "object", "properties": {"name": {"type": "string"}, "ok": {"type": "boolean"}}, "required": ["name"]},
                }
            },
            "required": ["people"],
        }
    )
    value = Output.model_validate({"people": [{"name": "Ada"}, {"name": "Bo", "ok": True}]})
    assert value.model_dump() == {"people": [{"name": "Ada", "ok": None}, {"name": "Bo", "ok": True}]}
    Send = worker.model_from_schema(SEND_SCHEMA)
    with pytest.raises(Exception):
        Send.model_validate({"outcome": "maybe", "detail": ""})


class FakeBrowser:
    """Stands in for BrowserSession in the sign-in view; signing in = li_at on kill."""

    def __init__(self, allowed_domains=None):
        self.allowed_domains = allowed_domains
        self.sent: list[tuple[str, dict]] = []
        outer = self

        class Input:
            async def dispatchMouseEvent(self, params, session_id):
                outer.sent.append(("mouse", params))

            async def dispatchKeyEvent(self, params, session_id):
                outer.sent.append(("key", params))

        self.cdp = type("Cdp", (), {"session_id": "s1", "cdp_client": type("C", (), {"send": type("S", (), {"Input": Input()})()})()})()

    async def start(self):
        pass

    async def navigate_to(self, url):
        self.url = url

    async def get_most_recently_opened_target_id(self):
        return "t1"

    async def get_or_create_cdp_session(self, target_id=None, focus=True):
        return self.cdp

    async def take_screenshot(self, format="png", quality=None):
        return b"\xff\xd8jpeg"

    async def get_current_page_url(self):
        return "https://www.linkedin.com/login"

    async def kill(self):
        worker._write_json(worker.STATE, {"cookies": [{"name": "li_at", "value": "v", "domain": ".www.linkedin.com", "expires": time.time() + 86400}]})


def test_parse_inputs_accepts_only_known_events():
    ok = worker.parse_inputs({"events": [{"type": "down", "x": 10, "y": 20}, {"type": "text", "text": "hi"}, {"type": "key", "key": "Enter"}, {"type": "scroll", "x": 1, "y": 1, "dy": -120}]})
    assert ok == [{"type": "down", "x": 10.0, "y": 20.0}, {"type": "text", "text": "hi"}, {"type": "key", "key": "Enter"}, {"type": "scroll", "x": 1.0, "y": 1.0, "dy": -120.0}]
    for bad in (
        {"events": []},
        {"events": [{"type": "key", "key": "F12"}]},
        {"events": [{"type": "down", "x": -1, "y": 0}]},
        {"events": [{"type": "down", "x": "1", "y": 0}]},
        {"events": [{"type": "text", "text": "x" * 1001}]},
        {"events": [{"type": "eval", "code": "1"}]},
        {"events": [{"type": "text", "text": "a"}] * 201},
        [],
    ):
        assert worker.parse_inputs(bad) is None


def test_http_surface(monkeypatch):
    executed = []

    async def fake_execute(run):
        executed.append(run["id"])
        run.update(status="completed", output={"outcome": "sent", "detail": "ok"}, task=None, finishedAt=time.time())
        worker.save_run(run)

    async def fake_verify():
        return True, "Signed in."

    async def home(max_age=0):
        return True, "home"

    browsers: list[FakeBrowser] = []

    def fake_browser(allowed_domains=None):
        browsers.append(FakeBrowser(allowed_domains))
        return browsers[-1]

    monkeypatch.setattr(worker, "execute", fake_execute)
    monkeypatch.setattr(worker, "verify_login", fake_verify)
    monkeypatch.setattr(worker, "home_route", home)
    monkeypatch.setattr(worker, "new_session", fake_browser)

    with TestClient(worker.app) as client:
        assert client.get("/healthz").json() == {"ok": True}
        assert client.get("/status", headers=AUTH).json()["home"] == {"online": True, "detail": "home"}
        assert client.get("/status").status_code == 401
        assert client.post("/runs", json={"task": "x"}, headers={"Authorization": "Bearer wrong"}).status_code == 401

        assert client.get("/status", headers=AUTH).json()["linkedin"]["signedIn"] is False
        assert client.get("/login/screen", headers=AUTH).status_code == 422
        assert client.post("/login", headers=AUTH).json() == {"ok": True}
        browser = browsers[-1]
        assert "https://accounts.google.com" in browser.allowed_domains and browser.url == "https://www.linkedin.com/login"
        screen = client.get("/login/screen", headers=AUTH)
        assert screen.headers["content-type"] == "image/jpeg" and screen.headers["x-page-host"] == "linkedin.com"
        typed = client.post(
            "/login/input",
            json={"events": [{"type": "down", "x": 5, "y": 6}, {"type": "up", "x": 5, "y": 6}, {"type": "text", "text": "ab"}, {"type": "key", "key": "Enter"}]},
            headers=AUTH,
        )
        assert typed.json() == {"ok": True}
        assert [p["type"] for _, p in browser.sent] == [
            "mouseMoved", "mousePressed", "mouseReleased",
            "keyDown", "char", "keyUp", "keyDown", "char", "keyUp",
            "rawKeyDown", "char", "keyUp",
        ]
        assert "".join(p["text"] for _, p in browser.sent if p["type"] == "char") == "ab\r"
        assert client.post("/login/input", json={"events": [{"type": "key", "key": "F12"}]}, headers=AUTH).status_code == 422

        # A run queued while the owner is signing in waits for the view to close.
        created = client.post("/runs", json={"task": "send it", "outputSchema": SEND_SCHEMA, "maxSteps": 500}, headers=AUTH).json()
        assert created["status"] == "queued"
        time.sleep(0.1)
        assert executed == []
        finished = client.post("/login/finish", headers=AUTH).json()
        assert finished == {"signedIn": True, "detail": "Signed in."}
        assert client.get("/status", headers=AUTH).json()["linkedin"]["signedIn"] is True
        assert client.post("/login/finish", headers=AUTH).status_code == 422
        for _ in range(50):
            run = client.get(f"/runs/{created['id']}", headers=AUTH).json()
            if run["status"] == "completed":
                break
            time.sleep(0.02)
        assert run["output"] == {"outcome": "sent", "detail": "ok"}
        assert executed == [created["id"]]
        assert worker.load_run(created["id"])["task"] is None
        assert worker.load_run(created["id"])["maxSteps"] == worker.MAX_STEPS
        assert client.get("/runs/../../etc/passwd", headers=AUTH).status_code == 404

        assert client.delete("/session", headers=AUTH).json() == {"ok": True}
        assert client.get("/status", headers=AUTH).json()["linkedin"]["signedIn"] is False


def test_restart_fails_interrupted_runs_and_requeues_waiting_ones():
    worker.RUNS.mkdir(parents=True, exist_ok=True)
    worker.save_run({"id": "aaaa-1", "status": "running", "task": "t", "maxSteps": 5})
    worker.save_run({"id": "aaaa-2", "status": "queued", "task": "t", "maxSteps": 5})
    worker.QUEUE = asyncio.Queue()
    asyncio.run(worker.startup())
    assert worker.load_run("aaaa-1")["status"] == "failed"
    assert worker.load_run("aaaa-1")["task"] is None
    assert worker.QUEUE.qsize() == 1


def test_runs_wait_for_the_home_connection(monkeypatch):
    online = {"value": False}
    executed = []

    async def home(max_age=0):
        return online["value"], "home" if online["value"] else "offline"

    async def fake_execute(run):
        executed.append(run["id"])
        run.update(status="completed", output={}, task=None)
        worker.save_run(run)

    def no_browser(allowed_domains=None):
        raise AssertionError("must not open LinkedIn off the home route")

    monkeypatch.setattr(worker, "home_route", home)
    monkeypatch.setattr(worker, "execute", fake_execute)
    monkeypatch.setattr(worker, "new_session", no_browser)
    monkeypatch.setattr(worker, "HOME_RETRY_S", 0.01)

    with TestClient(worker.app) as client:
        refused = client.post("/login", headers=AUTH)
        assert refused.status_code == 422 and refused.json()["error"] == "offline"

        created = client.post("/runs", json={"task": "send it"}, headers=AUTH).json()
        time.sleep(0.1)
        assert client.get(f"/runs/{created['id']}", headers=AUTH).json()["status"] == "queued"
        assert executed == []
        online["value"] = True
        for _ in range(50):
            if executed:
                break
            time.sleep(0.02)
        assert executed == [created["id"]]


def test_a_run_waiting_a_day_for_home_fails_without_running(monkeypatch):
    async def offline(max_age=0):
        return False, "offline"

    monkeypatch.setattr(worker, "home_route", offline)
    run = {"id": "bbbb-1", "status": "queued", "task": "t", "createdAt": time.time() - worker.QUEUE_TTL_S - 1}
    worker.RUNS.mkdir(parents=True, exist_ok=True)
    assert asyncio.run(worker.wait_for_home(run)) is False
    saved = worker.load_run("bbbb-1")
    assert saved["status"] == "failed" and saved["task"] is None


def test_home_route_refuses_when_traffic_exits_from_the_server(monkeypatch):
    async def up():
        return True

    async def down():
        return False

    def ips(proxied, v4="203.0.113.7", v6="2001:db8::7"):
        async def public_ip(*flags):
            return proxied if "--proxy" in flags else v6 if "-6" in flags else v4

        return public_ip

    monkeypatch.setattr(worker, "PROXY", "socks5://127.0.0.1:1055")
    monkeypatch.setattr(worker, "_exit_node_online", up)
    # The proxy fell back to Fly's own IPv4 while the direct check used IPv6.
    monkeypatch.setattr(worker, "_public_ip", ips("203.0.113.7"))
    assert asyncio.run(worker.home_route())[0] is False
    monkeypatch.setattr(worker, "_public_ip", ips(None))
    assert asyncio.run(worker.home_route())[0] is False
    monkeypatch.setattr(worker, "_public_ip", ips("198.51.100.2"))
    assert asyncio.run(worker.home_route())[0] is True
    monkeypatch.setattr(worker, "_exit_node_online", down)
    assert asyncio.run(worker.home_route())[0] is False
    monkeypatch.setattr(worker, "PROXY", "")
    assert asyncio.run(worker.home_route())[0] is False
