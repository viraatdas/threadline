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

    monkeypatch.setattr(worker, "execute", fake_execute)
    monkeypatch.setattr(worker, "verify_login", fake_verify)

    with TestClient(worker.app) as client:
        assert client.get("/healthz").json() == {"ok": True}
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
