"""Self-hosted browser-use worker for Outbound's LinkedIn actions.

One Chromium (headful under Xvfb) with a persistent profile on the Fly volume,
signed in with the owner's own LinkedIn cookies (POST /session, fed by
`pnpm linkedin-login` on their Mac). Outbound posts one narrowly worded task
at a time (POST /runs) and polls GET /runs/{id}. Runs execute serially: one
account, one browser. Task text, page content and agent output are never
logged; only run ids and statuses are.
"""

from __future__ import annotations

import asyncio
import hmac
import json
import logging
import os
import shutil
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Literal

os.environ.setdefault("ANONYMIZED_TELEMETRY", "false")
os.environ.setdefault("BROWSER_USE_CLOUD_SYNC", "false")
# browser-use logs every step (page text, the task, the agent's answer).
os.environ.setdefault("BROWSER_USE_SETUP_LOGGING", "false")

from browser_use import Agent, BrowserProfile, BrowserSession  # noqa: E402
from browser_use.llm.openrouter.chat import ChatOpenRouter  # noqa: E402
from pydantic import BaseModel, Field, create_model  # noqa: E402
from starlette.applications import Starlette  # noqa: E402
from starlette.requests import Request  # noqa: E402
from starlette.responses import JSONResponse  # noqa: E402
from starlette.routing import Route  # noqa: E402

logging.getLogger("browser_use").setLevel(logging.CRITICAL)
logging.getLogger("bubus").setLevel(logging.CRITICAL)
log = logging.getLogger("worker")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

DATA = Path(os.environ.get("DATA_DIR", "/data"))
PROFILE = DATA / "profile"
STATE = DATA / "linkedin_state.json"  # Playwright storage_state: cookies in, rotated cookies out
STATUS = DATA / "status.json"
RUNS = DATA / "runs"
TOKEN = os.environ.get("BROWSER_WORKER_TOKEN", "")
MODEL = os.environ.get("BROWSER_MODEL", "anthropic/claude-haiku-5.5")
CHROME = os.environ.get("CHROME_PATH", "/usr/bin/chromium")
SANDBOX = os.environ.get("CHROMIUM_SANDBOX", "true").lower() != "false"
# Looks like the owner's Mac rather than a Linux server.
USER_AGENT = os.environ.get(
    "BROWSER_USER_AGENT",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
)
# The agent may only navigate LinkedIn, whatever a page tells it.
ALLOWED_DOMAINS = ["https://linkedin.com", "https://*.linkedin.com"]
RUN_TIMEOUT_S = int(os.environ.get("RUN_TIMEOUT_S", "300"))
MAX_STEPS = 40

LOCK = asyncio.Lock()  # one browser profile → one thing at a time
QUEUE: asyncio.Queue[str] = asyncio.Queue()


# ── JSON Schema → pydantic, for browser-use's structured final output ─────────


def model_from_schema(schema: dict[str, Any], name: str = "Output") -> type[BaseModel]:
    required = set(schema.get("required", []))
    fields: dict[str, Any] = {}
    for key, prop in (schema.get("properties") or {}).items():
        annotation = _annotation(prop, f"{name}_{key}")
        info = Field(description=prop.get("description")) if key in required else Field(None, description=prop.get("description"))
        fields[key] = (annotation if key in required else annotation | None, info)
    return create_model(name, **fields)


def _annotation(prop: dict[str, Any], name: str) -> Any:
    if prop.get("enum"):
        return Literal[tuple(prop["enum"])]  # type: ignore[valid-type]
    kind = prop.get("type")
    if kind == "string":
        return str
    if kind == "boolean":
        return bool
    if kind == "integer":
        return int
    if kind == "number":
        return float
    if kind == "array":
        return list[_annotation(prop.get("items") or {}, f"{name}_item")]  # type: ignore[misc]
    if kind == "object":
        return model_from_schema(prop, name)
    return Any


# ── Storage ───────────────────────────────────────────────────────────────────


def _write_json(path: Path, value: Any) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(value))
    tmp.replace(path)


def _read_json(path: Path, default: Any = None) -> Any:
    try:
        return json.loads(path.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def load_run(run_id: str) -> dict[str, Any] | None:
    if not all(c.isalnum() or c == "-" for c in run_id):
        return None
    return _read_json(RUNS / f"{run_id}.json")


def save_run(run: dict[str, Any]) -> None:
    _write_json(RUNS / f"{run['id']}.json", run)


def linkedin_session() -> dict[str, Any]:
    cookies = (_read_json(STATE, {}) or {}).get("cookies") or []
    li_at = next((c for c in cookies if c.get("name") == "li_at" and "linkedin.com" in str(c.get("domain", ""))), None)
    expires = li_at.get("expires") if li_at else None
    signed_in = bool(li_at and li_at.get("value") and (expires in (None, -1) or expires > time.time()))
    status = _read_json(STATUS, {}) or {}
    return {
        "signedIn": signed_in,
        "expiresAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(expires)) if isinstance(expires, (int, float)) and expires > 0 else None,
        "verifiedAt": status.get("verifiedAt"),
        "lastCheck": status.get("detail"),
    }


# ── Browser ───────────────────────────────────────────────────────────────────


def new_session() -> BrowserSession:
    # A crashed Chromium leaves locks that make the next launch exit at once.
    for lock in ("SingletonLock", "SingletonSocket", "SingletonCookie"):
        (PROFILE / lock).unlink(missing_ok=True)
    return BrowserSession(
        browser_profile=BrowserProfile(
            executable_path=CHROME,
            headless=False,  # under Xvfb; headless Chrome is easier for LinkedIn to spot
            user_data_dir=str(PROFILE),
            storage_state=str(STATE),
            allowed_domains=ALLOWED_DOMAINS,
            user_agent=USER_AGENT,
            chromium_sandbox=SANDBOX,
            enable_default_extensions=False,
            keep_alive=False,
            window_size={"width": 1280, "height": 900},
        )
    )


def llm() -> ChatOpenRouter:
    return ChatOpenRouter(model=MODEL, api_key=os.environ.get("OPENROUTER_API_KEY"), http_referer="https://threadline.viraat.dev")


async def execute(run: dict[str, Any]) -> None:
    run.update(status="running", startedAt=time.time())
    save_run(run)
    session = new_session()
    try:
        output_model = model_from_schema(run["outputSchema"]) if run.get("outputSchema") else None
        agent = Agent(
            task=run["task"],
            llm=llm(),
            browser_session=session,
            output_model_schema=output_model,
            use_judge=False,
            max_failures=3,
            step_timeout=120,
        )
        history = await asyncio.wait_for(agent.run(max_steps=run["maxSteps"]), timeout=RUN_TIMEOUT_S)
        structured = history.structured_output
        if output_model and structured is None:
            run.update(status="failed", error="Could not produce output matching outputSchema.")
        else:
            run.update(status="completed", output=structured.model_dump() if structured else history.final_result())
        run["steps"] = history.number_of_steps()
    except asyncio.TimeoutError:
        run.update(status="failed", error=f"Timed out after {RUN_TIMEOUT_S}s.")
    except Exception as error:  # the message is ours or the library's, never page text we chose to log
        run.update(status="failed", error=f"{type(error).__name__}: {str(error)[:200]}")
    finally:
        try:
            await session.kill()  # also writes rotated cookies back to STATE
        except Exception:
            pass
    # The task holds the approved message; it isn't needed once the run is done.
    run.update(task=None, finishedAt=time.time())
    save_run(run)
    log.info("run %s %s", run["id"], run["status"])


async def verify_login() -> tuple[bool, str]:
    session = new_session()
    try:
        await session.start()
        await session.navigate_to("https://www.linkedin.com/feed/")
        await asyncio.sleep(4)
        url = await session.get_current_page_url()
    finally:
        try:
            await session.kill()
        except Exception:
            pass
    if any(part in url for part in ("/login", "/authwall", "/checkpoint", "/uas/")):
        return False, "LinkedIn asked to sign in or verify. Sign in again in your browser, then re-run pnpm linkedin-login."
    if "/feed" in url:
        return True, "Signed in."
    return False, "LinkedIn didn't open the feed."


async def consumer() -> None:
    while True:
        run_id = await QUEUE.get()
        run = load_run(run_id)
        if run and run.get("status") == "queued":
            async with LOCK:
                await execute(run)
        QUEUE.task_done()


# ── HTTP ──────────────────────────────────────────────────────────────────────


def authorized(request: Request) -> bool:
    header = request.headers.get("authorization", "")
    return bool(TOKEN) and header.startswith("Bearer ") and hmac.compare_digest(header[7:].encode(), TOKEN.encode())


def guard(handler):
    async def wrapped(request: Request):
        if not authorized(request):
            return JSONResponse({"error": "Unauthorized"}, status_code=401)
        return await handler(request)

    return wrapped


async def healthz(_: Request) -> JSONResponse:
    return JSONResponse({"ok": True})


@guard
async def status(_: Request) -> JSONResponse:
    return JSONResponse({"ok": True, "busy": LOCK.locked(), "queued": QUEUE.qsize(), "model": MODEL, "linkedin": linkedin_session()})


@guard
async def create_run(request: Request) -> JSONResponse:
    body = await request.json()
    task = body.get("task")
    schema = body.get("outputSchema")
    if not isinstance(task, str) or not task.strip() or len(task) > 20_000:
        return JSONResponse({"error": "task must be a non-empty string"}, status_code=422)
    if schema is not None and not isinstance(schema, dict):
        return JSONResponse({"error": "outputSchema must be an object"}, status_code=422)
    max_steps = body.get("maxSteps") or 25
    run = {
        "id": str(uuid.uuid4()),
        "status": "queued",
        "task": task,
        "outputSchema": schema,
        "maxSteps": max(1, min(int(max_steps), MAX_STEPS)),
        "createdAt": time.time(),
        "output": None,
        "error": None,
    }
    save_run(run)
    await QUEUE.put(run["id"])
    log.info("run %s queued", run["id"])
    return JSONResponse({"id": run["id"], "status": "queued"})


@guard
async def get_run(request: Request) -> JSONResponse:
    run = load_run(request.path_params["run_id"])
    if not run:
        return JSONResponse({"error": "Not found"}, status_code=404)
    return JSONResponse({k: run.get(k) for k in ("id", "status", "output", "error", "steps", "createdAt", "startedAt", "finishedAt")})


def to_storage_cookie(cookie: dict[str, Any]) -> dict[str, Any] | None:
    name, value, domain = cookie.get("name"), cookie.get("value"), str(cookie.get("domain") or "")
    if not isinstance(name, str) or not isinstance(value, str) or not domain.lstrip(".").endswith("linkedin.com"):
        return None
    same_site = str(cookie.get("sameSite") or "Lax").capitalize()
    expires = cookie.get("expires")
    return {
        "name": name,
        "value": value,
        # Domain cookies keep the leading dot; host-only ones don't.
        "domain": domain if cookie.get("hostOnly") or domain.startswith(".") else f".{domain}",
        "path": cookie.get("path") or "/",
        "expires": float(expires) if isinstance(expires, (int, float)) else -1,
        "httpOnly": bool(cookie.get("httpOnly")),
        "secure": bool(cookie.get("secure", True)),
        "sameSite": same_site if same_site in ("Lax", "Strict", "None") else "Lax",
    }


@guard
async def put_session(request: Request) -> JSONResponse:
    body = await request.json()
    raw = body.get("cookies") if isinstance(body, dict) else None
    if not isinstance(raw, list) or len(raw) > 300:
        return JSONResponse({"error": "cookies must be a list"}, status_code=422)
    cookies = [c for c in (to_storage_cookie(item) for item in raw if isinstance(item, dict)) if c]
    if not any(c["name"] == "li_at" for c in cookies):
        return JSONResponse({"error": "No li_at cookie: sign in to LinkedIn in that browser first."}, status_code=422)
    async with LOCK:
        # A fresh profile so nothing from an older login lingers.
        shutil.rmtree(PROFILE, ignore_errors=True)
        PROFILE.mkdir(parents=True, exist_ok=True)
        _write_json(STATE, {"cookies": cookies, "origins": []})
        try:
            ok, detail = await verify_login()
        except Exception as error:
            ok, detail = False, f"Couldn't open LinkedIn: {type(error).__name__}"
    _write_json(STATUS, {"verifiedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "detail": detail, "ok": ok})
    log.info("session import: %s", "signed in" if ok else "not signed in")
    return JSONResponse({"signedIn": ok, "detail": detail, "cookies": len(cookies)})


@guard
async def delete_session(_: Request) -> JSONResponse:
    async with LOCK:
        shutil.rmtree(PROFILE, ignore_errors=True)
        STATE.unlink(missing_ok=True)
        STATUS.unlink(missing_ok=True)
    log.info("session cleared")
    return JSONResponse({"ok": True})


async def startup() -> None:
    for path in (DATA, PROFILE, RUNS):
        path.mkdir(parents=True, exist_ok=True)
    # Queued runs never started, so they're safe to run; a run cut off mid-way
    # may or may not have clicked Send, so it is failed with a warning instead.
    for file in sorted(RUNS.glob("*.json"), key=lambda p: p.stat().st_mtime):
        run = _read_json(file)
        if not run:
            continue
        if run.get("status") == "queued":
            await QUEUE.put(run["id"])
        elif run.get("status") == "running":
            run.update(status="failed", task=None, error="The worker restarted mid-run. Check LinkedIn before retrying.")
            save_run(run)
        elif run.get("finishedAt") and run["finishedAt"] < time.time() - 30 * 86400:
            file.unlink(missing_ok=True)
    log.info("worker ready (model %s)", MODEL)


@asynccontextmanager
async def lifespan(_: Starlette):
    await startup()
    task = asyncio.get_running_loop().create_task(consumer())
    yield
    task.cancel()


app = Starlette(
    routes=[
        Route("/healthz", healthz),
        Route("/status", status),
        Route("/runs", create_run, methods=["POST"]),
        Route("/runs/{run_id}", get_run),
        Route("/session", put_session, methods=["PUT", "POST"]),
        Route("/session", delete_session, methods=["DELETE"]),
    ],
    lifespan=lifespan,
)
