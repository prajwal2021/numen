"""Numen voice-agent server: Twilio webhook + media stream + admin API.

Call flow:
  1. A call to a Twilio number POSTs to /incoming.
  2. We look up the agent assigned to the dialed number and wait its ring time (the call
     is unanswered until we reply, so the caller hears ringing).
  3. TwiML <Connect><Stream> opens a media-stream websocket to /ws, carrying the agent id.
  4. /ws runs that agent's pipeline (numen/bot.py).

The admin web app (web/, Next.js) talks to /api. Run: uv run server.py  (PORT, default 7860)
"""

import asyncio
import os
import re
import time
import uuid
from contextlib import asynccontextmanager
from xml.sax.saxutils import quoteattr

from dotenv import load_dotenv

load_dotenv(override=True)

import uvicorn  # noqa: E402
from fastapi import FastAPI, Request, WebSocket  # noqa: E402
from fastapi.exceptions import RequestValidationError  # noqa: E402
from fastapi.responses import JSONResponse, Response  # noqa: E402
from loguru import logger  # noqa: E402
from pipecat.runner.types import WebSocketRunnerArguments  # noqa: E402

from numen import accounts, api, api_users, audit, bot, store  # noqa: E402
from numen.auth import client_ip  # noqa: E402
from numen.calllog import LOG_DIR  # noqa: E402
from numen.models import Agent  # noqa: E402
from numen.seed import seed_if_empty  # noqa: E402

PORT = int(os.getenv("PORT", "7860"))

# Server-wide log, rotated daily and kept 30 days. Per-call logs: logs/calls/ and the DB.
logger.add(LOG_DIR / "server.log", level="INFO", rotation="00:00", retention="30 days", enqueue=True)


async def _daily_cleanup():
    while True:
        try:
            removed = await asyncio.to_thread(audit.cleanup)
            await asyncio.to_thread(accounts.cleanup)
            if removed:
                audit.record("system", f"Removed {removed} audit entries older than {audit.RETENTION_DAYS} days")
        except Exception:
            logger.exception("Daily cleanup failed")
        await asyncio.sleep(24 * 3600)


@asynccontextmanager
async def lifespan(app: FastAPI):
    seed_if_empty()
    logger.info("Pre-loading speech models...")
    await asyncio.to_thread(bot.prewarm)
    await bot.prepare_spare_vad()
    audit.record("system", "Server started", port=PORT)
    cleanup = asyncio.create_task(_daily_cleanup())
    logger.info("Ready for calls")
    yield
    cleanup.cancel()


app = FastAPI(title="Numen voice agents", lifespan=lifespan)


@app.exception_handler(RequestValidationError)
async def validation_error(request: Request, exc: RequestValidationError):
    """Same shape as the API's own 422s: [{field, message}], with readable messages."""
    out = []
    for e in exc.errors():
        loc = [str(p) for p in e.get("loc", []) if p not in ("body", "query", "path")]
        msg = e.get("msg", "Invalid value").removeprefix("Value error, ")
        if "valid email" in msg:
            msg = "Enter a valid email address."
        out.append({"field": ".".join(loc) or "body", "message": msg})
    return JSONResponse(status_code=422, content={"detail": out})
app.include_router(api_users.public)
app.include_router(api_users.account)
app.include_router(api_users.admin)
app.include_router(api.router)

# Readable names for API changes in the audit log: (method, route template) -> action.
_ACTIONS = {
    ("POST", "/api/agents"): "Created agent",
    ("PUT", "/api/agents/{agent_id}"): "Updated agent",
    ("DELETE", "/api/agents/{agent_id}"): "Deleted agent",
    ("POST", "/api/agents/{agent_id}/test/start"): "Started a test chat",
    ("POST", "/api/agents/{agent_id}/test/message"): "Sent a test chat message",
    ("POST", "/api/knowledge-bases"): "Created knowledge base",
    ("PUT", "/api/knowledge-bases/{kb_id}"): "Updated knowledge base",
    ("DELETE", "/api/knowledge-bases/{kb_id}"): "Deleted knowledge base",
    ("POST", "/api/knowledge-bases/{kb_id}/health"): "Tested knowledge base connection",
    ("POST", "/api/knowledge-bases/{kb_id}/query"): "Ran a knowledge base test query",
    ("POST", "/api/phone-numbers"): "Added phone number",
    ("PUT", "/api/phone-numbers/{pn_id}"): "Updated phone number",
    ("DELETE", "/api/phone-numbers/{pn_id}"): "Removed phone number",
    ("POST", "/api/phone-numbers/{pn_id}/connect"): "Connected phone number to Twilio",
    ("PUT", "/api/settings"): "Updated settings",
    ("POST", "/api/settings/check/{provider}"): "Tested a provider connection",
    ("POST", "/api/voices/preview"): "Previewed a voice",
}
# Logged in detail by their own endpoints, or too noisy to log per request.
_SKIP = re.compile(r"^/api/(auth/|account|users|audit|settings/test-email|agents/[^/]+/prompt-preview)")


@app.middleware("http")
async def audit_requests(request: Request, call_next):
    start = time.monotonic()
    response = await call_next(request)
    path, method = request.url.path, request.method
    if path.startswith("/api/") and not _SKIP.match(path) and (method != "GET" or response.status_code >= 500):
        route = request.scope.get("route")
        template = getattr(route, "path", path)
        params = request.scope.get("path_params") or {}
        note = getattr(request.state, "audit", None) or {}
        status = response.status_code
        action = _ACTIONS.get((method, template), f"{method} {template}")
        if status >= 400:
            action = f"{action} (failed: HTTP {status})"
        await asyncio.to_thread(
            audit.record, "error" if status >= 500 else "api", action,
            user=getattr(request.state, "user", None), target=note.get("target") or next(iter(params.values()), None),
            method=method, path=path, status=status, duration_ms=round((time.monotonic() - start) * 1000),
            ip=client_ip(request), user_agent=request.headers.get("user-agent"),
            session_id=getattr(request.state, "session_id", None), **(note.get("meta") or {}),
        )
    return response


def _public_host(request: Request) -> str:
    """Host Twilio should open the media stream to (e.g. abc123.ngrok-free.dev)."""
    host = store.get_settings().public_base_url or request.headers.get("x-forwarded-host") or request.url.hostname
    return host.removeprefix("https://").removeprefix("http://").rstrip("/")


def _twiml(body: str) -> Response:
    return Response(f'<?xml version="1.0" encoding="UTF-8"?><Response>{body}</Response>',
                    media_type="application/xml")


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.post("/incoming")
async def incoming_call(request: Request):
    """Twilio voice webhook for every connected number."""
    form = await request.form()
    to, frm, sid = form.get("To"), form.get("From"), form.get("CallSid")
    number = store.number_for(to)
    agent = store.get(Agent, number.agent_id) if number and number.agent_id else None
    logger.info(f"Incoming call {sid} from {frm} to {to} -> agent {agent.name if agent else 'NONE'}")
    if agent is None:
        return _twiml("<Say>We're sorry, this number is not in service yet. Goodbye.</Say><Hangup/>")

    if agent.conversation.ring_seconds > 0:
        await asyncio.sleep(min(agent.conversation.ring_seconds, 10))

    stream_url = f"wss://{_public_host(request)}/ws"
    params = "".join(
        f"<Parameter name={quoteattr(k)} value={quoteattr(str(v or ''))} />"
        for k, v in {"agent_id": agent.id, "from": frm, "to": to}.items()
    )
    return _twiml(f"<Connect><Stream url={quoteattr(stream_url)}>{params}</Stream></Connect>")


@app.websocket("/ws")
async def media_stream(websocket: WebSocket):
    """Twilio media stream: run one agent session for the call."""
    await websocket.accept()
    runner_args = WebSocketRunnerArguments(websocket=websocket, session_id=str(uuid.uuid4()))
    try:
        await bot.bot(runner_args)
    except Exception:
        logger.exception("Bot session failed")


@app.get("/")
async def root():
    return {"service": "numen", "admin": "run the web app in web/ (npm run dev) and open http://localhost:3000"}


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=PORT)
