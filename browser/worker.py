"""Self-hosted browser-use worker for Outbound's LinkedIn actions.

One Chromium (headful under Xvfb) with a persistent profile on the Fly volume,
which the owner signs in to LinkedIn themselves through the sign-in view
(/login: screenshots out, their clicks and keys in). Outbound posts
one narrowly worded task at a time (POST /runs) and polls GET /runs/{id}. Runs
execute serially: one account, one browser. The browser's only way out is
Tailscale's SOCKS5 proxy through the owner's exit node, so LinkedIn sees their
home IP; while that's offline, runs wait. Task text, page content and agent
output are never logged; only run ids and statuses are.
"""

from __future__ import annotations

import asyncio
import hmac
import json
import logging
import os
import re
import shutil
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlparse

os.environ.setdefault("ANONYMIZED_TELEMETRY", "false")
os.environ.setdefault("BROWSER_USE_CLOUD_SYNC", "false")
# browser-use logs every step (page text, the task, the agent's answer).
os.environ.setdefault("BROWSER_USE_SETUP_LOGGING", "false")

from browser_use import Agent, BrowserProfile, BrowserSession  # noqa: E402
from browser_use.browser.profile import ProxySettings  # noqa: E402
from browser_use.llm.openrouter.chat import ChatOpenRouter  # noqa: E402
from pydantic import BaseModel, Field, create_model  # noqa: E402
from starlette.applications import Starlette  # noqa: E402
from starlette.requests import Request  # noqa: E402
from starlette.responses import JSONResponse, Response  # noqa: E402
from starlette.routing import Route  # noqa: E402

# Agent, CDP and event-bus logs carry page text and model output; only our own
# id/status lines go out at INFO.
for _name in ("browser_use", "bubus", "cdp_use"):
    logging.getLogger(_name).setLevel(logging.CRITICAL)
logging.basicConfig(level=logging.WARNING, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("worker")
log.setLevel(logging.INFO)

DATA = Path(os.environ.get("DATA_DIR", "/data"))
PROFILE = DATA / "profile"
STATE = DATA / "linkedin_state.json"  # Playwright storage_state: cookies in, rotated cookies out
STATUS = DATA / "status.json"
RUNS = DATA / "runs"
TOKEN = os.environ.get("BROWSER_WORKER_TOKEN", "")
MODEL = os.environ.get("BROWSER_MODEL", "anthropic/claude-haiku-5.5")
CHROME = os.environ.get("CHROME_PATH", "/usr/bin/chromium")
SANDBOX = os.environ.get("CHROMIUM_SANDBOX", "true").lower() != "false"
# Chromium's own user agent by default: a Mac UA on a Linux browser is exactly
# the kind of mismatch bot checks look for.
USER_AGENT = os.environ.get("BROWSER_USER_AGENT", "")
# LinkedIn revoked a session the first time it saw Fly's datacenter IP, so the
# browser only ever goes out through the owner's Tailscale exit node (set by
# start.sh). Without it, nothing runs.
PROXY = os.environ.get("BROWSER_PROXY", "")
HOME_RETRY_S = 60
QUEUE_TTL_S = 24 * 3600
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


def new_session(allowed_domains: list[str] = ALLOWED_DOMAINS) -> BrowserSession:
    # A crashed Chromium leaves locks that make the next launch exit at once.
    for lock in ("SingletonLock", "SingletonSocket", "SingletonCookie"):
        (PROFILE / lock).unlink(missing_ok=True)
    return BrowserSession(
        browser_profile=BrowserProfile(
            executable_path=CHROME,
            headless=False,  # under Xvfb; headless Chrome is easier for LinkedIn to spot
            user_data_dir=str(PROFILE),
            storage_state=str(STATE),
            allowed_domains=allowed_domains,
            **({"user_agent": USER_AGENT} if USER_AGENT else {}),
            proxy=ProxySettings(server=PROXY) if PROXY else None,
            # WebRTC would otherwise reveal the server's own IP around the proxy.
            args=["--force-webrtc-ip-handling-policy=disable_non_proxied_udp"],
            chromium_sandbox=SANDBOX,
            enable_default_extensions=False,
            keep_alive=False,
            window_size={"width": 1280, "height": 900},
        )
    )


# Some lists only load more as they're scrolled, which the agent skips (it read
# 10, then 13, LinkedIn conversations however the task was worded, since it only
# sees about a screenful). A run may name one of these fixed recipes: the worker
# opens the page, scrolls the list, and reads the rows itself. If the read
# doesn't look right (LinkedIn changed its markup), the agent reads the
# scrolled page instead. Callers pick a recipe by name; they can't supply script.
SCROLL_MESSAGING_JS = r"""
(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const scrollable = (el) => el.scrollHeight > el.clientHeight + 40 && /auto|scroll/.test(getComputedStyle(el).overflowY);
  const findList = () => {
    const known = document.querySelector(".msg-conversations-container__conversations-list");
    if (known) return known;
    const link = document.querySelector('a[href*="/messaging/thread/"]');
    return link ? link.closest("ul") : null;
  };
  let list = null;
  for (let i = 0; i < 30 && !list; i++) {
    list = findList();
    if (!list) await sleep(500);
  }
  if (!list) return { loaded: -1, output: null, classes: [] };
  let box = list;
  while (box && !scrollable(box)) box = box.parentElement;

  // LinkedIn empties rows that are far from view, so rows are read as the
  // list scrolls past them, a screen at a time.
  const text = (root, selector) => (root.querySelector(selector)?.textContent || "").replace(/\s+/g, " ").trim();
  const rows = new Map();
  const readVisible = () => {
    for (const item of list.children) {
      const name = text(item, ".msg-conversation-listitem__participant-names, .msg-conversation-card__participant-names");
      if (!name) continue;
      const when = text(item, ".msg-conversation-listitem__time-stamp, .msg-conversation-card__time-stamp");
      const preview = text(item, ".msg-conversation-card__message-snippet, .msg-conversation-card__message-snippet-body");
      const key = `${name}\u0000${when}`;
      if (!rows.get(key)?.preview) rows.set(key, { name, when, preview });
    }
  };
  const step = Math.max(200, Math.floor((box?.clientHeight || 600) * 0.8));
  let height = 0;
  let still = 0;
  for (let i = 0; box && i < 60 && rows.size < 40 && still < 4; i++) {
    readVisible();
    const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 5;
    if (atBottom) {
      still = box.scrollHeight === height ? still + 1 : 0;
      height = box.scrollHeight;
    }
    box.scrollTop = atBottom ? box.scrollHeight : box.scrollTop + step;
    await sleep(atBottom ? 1500 : 600);
  }
  readVisible();
  if (box) box.scrollTop = 0;

  const named = [...rows.values()];
  const conversations = named
    .filter((row) => row.preview)
    .map((row) => ({
      name: row.name.slice(0, 200),
      // LinkedIn prefixes the owner's own last message with "You:".
      lastMessageFromThem: !/^you:/i.test(row.preview),
      preview: row.preview.replace(/^you:\s*/i, "").slice(0, 2000),
      when: row.when.slice(0, 60),
    }));
  // A missing preview would read as "they wrote last" and look like a reply.
  const trusted = named.length > 0 && conversations.length >= Math.ceil(named.length * 0.8);
  // When the read fails, the class names in one row (never its text) show
  // what LinkedIn's markup changed to.
  const sample = [...list.children].find((item) => item.querySelector("[class]"));
  const classes = trusted || !sample ? [] : [...new Set([...sample.querySelectorAll("[class]")].flatMap((el) => [...el.classList]))].slice(0, 120);
  return { loaded: list.children.length, output: trusted ? { conversations } : null, classes };
})()
"""
PREPARE = {"linkedin_messaging": ("https://www.linkedin.com/messaging/", SCROLL_MESSAGING_JS)}


async def prepare_page(session: BrowserSession, url: str, script: str) -> tuple[int, dict[str, Any] | None, list[str]]:
    await session.start()
    await session.navigate_to(url)
    target = await session.get_most_recently_opened_target_id()
    cdp = await session.get_or_create_cdp_session(target, focus=True)
    result = await asyncio.wait_for(
        cdp.cdp_client.send.Runtime.evaluate(
            params={"expression": script, "awaitPromise": True, "returnByValue": True}, session_id=cdp.session_id
        ),
        90,
    )
    value = (result.get("result") or {}).get("value") or {}
    loaded = value.get("loaded")
    output = value.get("output")
    classes = [c for c in value.get("classes") or [] if isinstance(c, str)][:120]
    return (loaded if isinstance(loaded, int) else -1), (output if isinstance(output, dict) else None), classes


def llm() -> ChatOpenRouter:
    return ChatOpenRouter(model=MODEL, api_key=os.environ.get("OPENROUTER_API_KEY"), http_referer="https://threadline.viraat.dev")


async def execute(run: dict[str, Any]) -> None:
    run.update(status="running", startedAt=time.time())
    save_run(run)
    session = new_session()
    try:
        output_model = model_from_schema(run["outputSchema"]) if run.get("outputSchema") else None
        recipe = PREPARE.get(run.get("prepare") or "")
        read = None
        if recipe:
            loaded, read, classes = await prepare_page(session, *recipe)
            run["prepared"] = {"loaded": loaded, "read": read is not None, "classes": classes}
            log.info("run %s prepared %s (%s items, %s)", run["id"], run["prepare"], loaded, "read" if read else "agent reads")
        if read is not None:
            run.update(status="completed", output=read, steps=0)
        else:
            agent = Agent(
                task=run["task"],
                llm=llm(),
                browser_session=session,
                output_model_schema=output_model,
                use_judge=False,
                max_failures=3,
                step_timeout=120,
                # Otherwise a URL in the task is opened first, reloading a prepared page.
                directly_open_url=not recipe,
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
        return False, "LinkedIn asked to sign in or verify. Sign in again from Settings."
    if "/feed" in url:
        return True, "Signed in."
    return False, "LinkedIn didn't open the feed."


async def _output(*args: str) -> str | None:
    try:
        proc = await asyncio.create_subprocess_exec(*args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
        out, _ = await proc.communicate()
    except OSError:
        return None
    return out.decode(errors="replace") if proc.returncode == 0 else None


async def _public_ip(*curl_flags: str) -> str | None:
    out = await _output("curl", "-fsS", "--max-time", "10", *curl_flags, "https://www.cloudflare.com/cdn-cgi/trace")
    match = re.search(r"^ip=([0-9a-fA-F.:]+)$", out or "", re.M)
    return match.group(1) if match else None


async def _exit_node_online() -> bool:
    try:
        status = json.loads(await _output("tailscale", "status", "--json") or "{}")
    except json.JSONDecodeError:
        return False
    return bool((status.get("ExitNodeStatus") or {}).get("Online"))


_home_cache: tuple[float, bool, str] = (0.0, False, "")


async def home_route(max_age: float = 0) -> tuple[bool, str]:
    """Whether the browser's traffic leaves through the owner's home, never Fly's own IP."""
    global _home_cache
    if max_age and time.time() - _home_cache[0] < max_age:
        return _home_cache[1], _home_cache[2]
    if not PROXY:
        result = (False, "No home connection is set up (Tailscale exit node).")
    else:
        # Tailscale must report the exit node up, and the proxy's public IP must
        # be neither of Fly's own (it egresses over both IPv4 and IPv6).
        online, home, direct4, direct6 = await asyncio.gather(
            _exit_node_online(),
            _public_ip("--proxy", PROXY.replace("socks5://", "socks5h://")),
            _public_ip("-4"),
            _public_ip("-6"),
        )
        if not online or not home:
            result = (False, "Your home connection (the Tailscale exit node) is offline. LinkedIn actions wait until it's back.")
        elif home in (direct4, direct6):
            result = (False, "Traffic isn't going through your home connection, so LinkedIn actions are paused.")
        else:
            result = (True, "LinkedIn traffic goes through your home connection.")
    _home_cache = (time.time(), *result)
    return result


async def wait_for_home(run: dict[str, Any]) -> bool:
    while not (await home_route())[0]:
        if time.time() - run.get("createdAt", 0) > QUEUE_TTL_S:
            run.update(status="failed", task=None, finishedAt=time.time(), error="Your home connection was offline for a day, so this never ran.")
            save_run(run)
            log.info("run %s failed (home offline)", run["id"])
            return False
        await asyncio.sleep(HOME_RETRY_S)
    return True


async def consumer() -> None:
    while True:
        run_id = await QUEUE.get()
        run = load_run(run_id)
        if run and run.get("status") == "queued" and await wait_for_home(run):
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
    online, detail = await home_route(max_age=30)
    return JSONResponse(
        {
            "ok": True,
            "busy": LOCK.locked(),
            "queued": QUEUE.qsize(),
            "model": MODEL,
            "linkedin": linkedin_session(),
            "home": {"online": online, "detail": detail},
        }
    )


@guard
async def create_run(request: Request) -> JSONResponse:
    body = await request.json()
    task = body.get("task")
    schema = body.get("outputSchema")
    if not isinstance(task, str) or not task.strip() or len(task) > 20_000:
        return JSONResponse({"error": "task must be a non-empty string"}, status_code=422)
    if schema is not None and not isinstance(schema, dict):
        return JSONResponse({"error": "outputSchema must be an object"}, status_code=422)
    prepare = body.get("prepare")
    if prepare is not None and prepare not in PREPARE:
        return JSONResponse({"error": f"prepare must be one of {sorted(PREPARE)}"}, status_code=422)
    max_steps = body.get("maxSteps") or 25
    run = {
        "id": str(uuid.uuid4()),
        "status": "queued",
        "task": task,
        "outputSchema": schema,
        "prepare": prepare,
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


# ── Sign-in view ──────────────────────────────────────────────────────────────
# LinkedIn revokes sessions copied in from another browser, so the owner signs
# in here instead: Settings shows screenshots of this browser and relays their
# clicks and keys. Nothing typed is logged or kept. While open, the view holds
# LOCK so no run shares the profile; it closes itself after 10 minutes without
# a click or key (screen polls don't count, so a forgotten tab can't hold it).

LOGIN_IDLE_S = 600
# Only the owner drives the view (no agent), so it may also reach Google for
# accounts that sign in to LinkedIn with Google.
LOGIN_DOMAINS = [*ALLOWED_DOMAINS, "https://accounts.google.com"]
KEYS = {  # key → (code, windowsVirtualKeyCode, char text)
    "Enter": ("Enter", 13, "\r"),
    "Backspace": ("Backspace", 8, None),
    "Tab": ("Tab", 9, None),
    "Escape": ("Escape", 27, None),
    "Delete": ("Delete", 46, None),
    "ArrowLeft": ("ArrowLeft", 37, None),
    "ArrowUp": ("ArrowUp", 38, None),
    "ArrowRight": ("ArrowRight", 39, None),
    "ArrowDown": ("ArrowDown", 40, None),
}


def parse_inputs(body: Any) -> list[dict[str, Any]] | None:
    """The owner's clicks and keys from Settings, or None if anything is off."""
    events = body.get("events") if isinstance(body, dict) else None
    if not isinstance(events, list) or not 0 < len(events) <= 200:
        return None
    parsed: list[dict[str, Any]] = []
    for event in events:
        kind = event.get("type") if isinstance(event, dict) else None
        if kind in ("down", "up", "move", "scroll"):
            x, y = event.get("x"), event.get("y")
            if not all(isinstance(v, (int, float)) and 0 <= v <= 4000 for v in (x, y)):
                return None
            item: dict[str, Any] = {"type": kind, "x": float(x), "y": float(y)}
            if kind == "scroll":
                dy = event.get("dy")
                if not isinstance(dy, (int, float)) or abs(dy) > 5000:
                    return None
                item["dy"] = float(dy)
            parsed.append(item)
        elif kind == "text" and isinstance(event.get("text"), str) and 0 < len(event["text"]) <= 1000:
            parsed.append({"type": "text", "text": event["text"]})
        elif kind == "key" and event.get("key") in KEYS:
            parsed.append({"type": "key", "key": event["key"]})
        else:
            return None
    return parsed


class LoginView:
    def __init__(self) -> None:
        self.session: BrowserSession | None = None
        self.holding = False
        self.touched = 0.0
        self.expiry: asyncio.Task | None = None

    @property
    def open(self) -> bool:
        return self.session is not None

    def touch(self) -> None:
        self.touched = time.monotonic()

    async def start(self) -> None:
        await LOCK.acquire()
        self.holding = True
        try:
            # A fresh profile so nothing from an older login lingers.
            shutil.rmtree(PROFILE, ignore_errors=True)
            PROFILE.mkdir(parents=True, exist_ok=True)
            _write_json(STATE, {"cookies": [], "origins": []})
            STATUS.unlink(missing_ok=True)
            self.session = new_session(LOGIN_DOMAINS)
            await self.session.start()
            await self.session.navigate_to("https://www.linkedin.com/login")
        except Exception:
            await self.close()
            raise
        self.touch()
        self.expiry = asyncio.get_running_loop().create_task(self._expire())

    async def close(self) -> None:
        session, self.session = self.session, None
        if self.expiry and self.expiry is not asyncio.current_task():
            self.expiry.cancel()
        self.expiry = None
        if session:
            try:
                await session.kill()  # writes the new session's cookies to STATE
            except Exception:
                pass
        if self.holding:
            self.holding = False
            LOCK.release()

    async def _expire(self) -> None:
        while self.open:
            await asyncio.sleep(15)
            if time.monotonic() - self.touched > LOGIN_IDLE_S:
                log.info("sign-in view closed after %ss idle", LOGIN_IDLE_S)
                await self.close()

    async def _focus(self):
        # The newest tab, so a sign-in popup (Google) is what the owner sees.
        assert self.session
        target = await self.session.get_most_recently_opened_target_id()
        return await self.session.get_or_create_cdp_session(target, focus=True)

    async def screen(self) -> tuple[bytes, str]:
        assert self.session
        await self._focus()
        image = await self.session.take_screenshot(format="jpeg", quality=60)
        host = urlparse(await self.session.get_current_page_url()).hostname or ""
        return image, host.removeprefix("www.")

    async def input(self, events: list[dict[str, Any]]) -> None:
        self.touch()
        cdp = await self._focus()

        async def mouse(**params: Any) -> None:
            # A JS dialog can stall input events; don't hang the request on it.
            await asyncio.wait_for(cdp.cdp_client.send.Input.dispatchMouseEvent(params=params, session_id=cdp.session_id), 5)

        async def key(**params: Any) -> None:
            await asyncio.wait_for(cdp.cdp_client.send.Input.dispatchKeyEvent(params=params, session_id=cdp.session_id), 5)

        for event in events:
            kind = event["type"]
            if kind == "down":
                await mouse(type="mouseMoved", x=event["x"], y=event["y"])
                await mouse(type="mousePressed", x=event["x"], y=event["y"], button="left", clickCount=1)
            elif kind == "up":
                await mouse(type="mouseReleased", x=event["x"], y=event["y"], button="left", clickCount=1)
            elif kind == "move":
                await mouse(type="mouseMoved", x=event["x"], y=event["y"])
            elif kind == "scroll":
                await mouse(type="mouseWheel", x=event["x"], y=event["y"], deltaX=0, deltaY=event["dy"])
            elif kind == "text":
                for char in event["text"]:
                    await key(type="keyDown", key=char)
                    await key(type="char", text=char)
                    await key(type="keyUp", key=char)
            else:
                code, vk, text = KEYS[event["key"]]
                await key(type="rawKeyDown", key=event["key"], code=code, windowsVirtualKeyCode=vk)
                if text:
                    await key(type="char", text=text)
                await key(type="keyUp", key=event["key"], code=code, windowsVirtualKeyCode=vk)


VIEW = LoginView()
def no_view() -> JSONResponse:
    return JSONResponse({"error": "The sign-in view isn't open. Open it again from Settings."}, status_code=422)


@guard
async def open_login(_: Request) -> JSONResponse:
    if VIEW.open:
        VIEW.touch()
        return JSONResponse({"ok": True})
    online, detail = await home_route()
    if not online:
        return JSONResponse({"error": detail}, status_code=422)
    if LOCK.locked():
        return JSONResponse({"error": "The browser is busy with a LinkedIn action. Try again in a minute."}, status_code=422)
    try:
        await VIEW.start()
    except Exception as error:
        return JSONResponse({"error": f"Couldn't open the browser: {type(error).__name__}"}, status_code=422)
    log.info("sign-in view opened")
    return JSONResponse({"ok": True})


@guard
async def login_screen(_: Request) -> Response:
    if not VIEW.open:
        return no_view()
    try:
        image, host = await VIEW.screen()
    except Exception:  # mid-navigation; the next poll gets it
        return JSONResponse({"error": "The page is loading."}, status_code=503)
    return Response(image, media_type="image/jpeg", headers={"cache-control": "no-store", "x-page-host": host})


@guard
async def login_input(request: Request) -> JSONResponse:
    events = parse_inputs(await request.json())
    if events is None:
        return JSONResponse({"error": "Unrecognized input."}, status_code=422)
    if not VIEW.open:
        return no_view()
    try:
        await VIEW.input(events)
    except Exception as error:
        return JSONResponse({"error": f"Input failed: {type(error).__name__}"}, status_code=422)
    return JSONResponse({"ok": True})


@guard
async def finish_login(_: Request) -> JSONResponse:
    if not VIEW.open:
        return no_view()
    await VIEW.close()
    if linkedin_session()["signedIn"]:
        async with LOCK:
            try:
                ok, detail = await verify_login()
            except Exception as error:
                ok, detail = False, f"Couldn't open LinkedIn: {type(error).__name__}"
    else:
        ok, detail = False, "LinkedIn isn't signed in yet. Open the sign-in view again and finish signing in."
    _write_json(STATUS, {"verifiedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "detail": detail, "ok": ok})
    log.info("sign-in view finished: %s", "signed in" if ok else "not signed in")
    return JSONResponse({"signedIn": ok, "detail": detail})


@guard
async def cancel_login(_: Request) -> JSONResponse:
    await VIEW.close()
    return JSONResponse({"ok": True})


@guard
async def delete_session(_: Request) -> JSONResponse:
    await VIEW.close()
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
        Route("/session", delete_session, methods=["DELETE"]),
        Route("/login", open_login, methods=["POST"]),
        Route("/login", cancel_login, methods=["DELETE"]),
        Route("/login/screen", login_screen),
        Route("/login/input", login_input, methods=["POST"]),
        Route("/login/finish", finish_login, methods=["POST"]),
    ],
    lifespan=lifespan,
)
