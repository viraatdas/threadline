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


def test_cookie_conversion_keeps_only_linkedin():
    assert worker.to_storage_cookie({"name": "x", "value": "1", "domain": "evil.com"}) is None
    assert worker.to_storage_cookie({"name": "x", "value": "1", "domain": "evillinkedin.com"}) is None
    # Cookie-Editor's export shape.
    exported = worker.to_storage_cookie(
        {"name": "li_at", "value": "v", "domain": ".www.linkedin.com", "expirationDate": 1824773233.9, "sameSite": "no_restriction", "secure": True, "session": False, "storeId": None}
    )
    assert exported is not None and exported["expires"] == 1824773233.9 and exported["sameSite"] == "None"
    assert worker.to_storage_cookie({"name": "g", "value": "1", "domain": "www.linkedin.com", "hostOnly": True, "sameSite": None})["sameSite"] == "Lax"
    cookie = worker.to_storage_cookie({"name": "li_at", "value": "v", "domain": "linkedin.com", "expires": 2_000_000_000, "httpOnly": True, "sameSite": "none"})
    assert cookie == {
        "name": "li_at",
        "value": "v",
        "domain": ".linkedin.com",
        "path": "/",
        "expires": 2_000_000_000.0,
        "httpOnly": True,
        "secure": True,
        "sameSite": "None",
    }


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

    monkeypatch.setattr(worker, "execute", fake_execute)
    monkeypatch.setattr(worker, "verify_login", fake_verify)
    monkeypatch.setattr(worker, "home_route", home)

    with TestClient(worker.app) as client:
        assert client.get("/healthz").json() == {"ok": True}
        assert client.get("/status", headers=AUTH).json()["home"] == {"online": True, "detail": "home"}
        assert client.get("/status").status_code == 401
        assert client.post("/runs", json={"task": "x"}, headers={"Authorization": "Bearer wrong"}).status_code == 401

        assert client.get("/status", headers=AUTH).json()["linkedin"]["signedIn"] is False
        rejected = client.put("/session", json={"cookies": [{"name": "JSESSIONID", "value": "a", "domain": "www.linkedin.com"}]}, headers=AUTH)
        assert rejected.status_code == 422
        imported = client.put(
            "/session",
            json={"cookies": [{"name": "li_at", "value": "v", "domain": "linkedin.com", "expires": time.time() + 86400}]},
            headers=AUTH,
        )
        assert imported.json()["signedIn"] is True
        assert client.get("/status", headers=AUTH).json()["linkedin"]["signedIn"] is True

        created = client.post("/runs", json={"task": "send it", "outputSchema": SEND_SCHEMA, "maxSteps": 500}, headers=AUTH).json()
        assert created["status"] == "queued"
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

    async def fake_verify():
        raise AssertionError("must not open LinkedIn off the home route")

    monkeypatch.setattr(worker, "home_route", home)
    monkeypatch.setattr(worker, "execute", fake_execute)
    monkeypatch.setattr(worker, "verify_login", fake_verify)
    monkeypatch.setattr(worker, "HOME_RETRY_S", 0.01)

    with TestClient(worker.app) as client:
        cookie = [{"name": "li_at", "value": "v", "domain": ".linkedin.com"}]
        refused = client.put("/session", json={"cookies": cookie}, headers=AUTH)
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
    async def same_ip(proxy=""):
        return "203.0.113.7"

    async def via_home(proxy=""):
        return "198.51.100.2" if proxy else "203.0.113.7"

    monkeypatch.setattr(worker, "PROXY", "socks5://127.0.0.1:1055")
    monkeypatch.setattr(worker, "_public_ip", same_ip)
    assert asyncio.run(worker.home_route())[0] is False
    monkeypatch.setattr(worker, "_public_ip", via_home)
    assert asyncio.run(worker.home_route())[0] is True
    monkeypatch.setattr(worker, "PROXY", "")
    assert asyncio.run(worker.home_route())[0] is False
