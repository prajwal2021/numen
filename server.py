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
from urllib.parse import quote
from xml.sax.saxutils import escape, quoteattr

from dotenv import load_dotenv

load_dotenv(override=True)

import uvicorn  # noqa: E402
from fastapi import FastAPI, Request, WebSocket  # noqa: E402
from fastapi.exceptions import RequestValidationError  # noqa: E402
from fastapi.responses import JSONResponse, Response  # noqa: E402
from loguru import logger  # noqa: E402
from pipecat.runner.types import WebSocketRunnerArguments  # noqa: E402

from numen import accounts, api, api_users, audit, bot, kb_docs, routing, store  # noqa: E402
from numen.capacity import Decision, limiter  # noqa: E402
from numen.auth import client_ip  # noqa: E402
from numen.calllog import LOG_DIR  # noqa: E402
from numen.models import Agent, RoutingConfig  # noqa: E402
from numen.seed import seed_if_empty  # noqa: E402

PORT = int(os.getenv("PORT", "7860"))

# Server-wide log, rotated daily and kept 30 days. Per-call logs: logs/calls/ and the DB.
logger.add(LOG_DIR / "server.log", level="INFO", rotation="00:00", retention="30 days", enqueue=True)


# Event-loop lag: every live call's audio runs on this one loop, so lag is stutter. Sampled
# every 100 ms; /health reports the worst in the last minute.
_lag = {"max_ms": 0.0, "window_max_ms": 0.0, "window_start": 0.0}


async def _watch_loop_lag():
    while True:
        t = time.monotonic()
        await asyncio.sleep(0.1)
        lag = (time.monotonic() - t - 0.1) * 1000
        now = time.monotonic()
        if now - _lag["window_start"] > 60:
            _lag["max_ms"], _lag["window_max_ms"], _lag["window_start"] = _lag["window_max_ms"], 0.0, now
        _lag["window_max_ms"] = max(_lag["window_max_ms"], lag)
        if lag > 250:
            logger.warning(f"Event loop lagged {lag:.0f} ms (live calls: {limiter.live})")


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
    for doc_id in await asyncio.to_thread(kb_docs.pending_ids):
        logger.info(f"Re-indexing knowledge-base document {doc_id} (interrupted by a restart)")
        kb_docs.start_indexing(doc_id)
    cleanup = asyncio.create_task(_daily_cleanup())
    lag_watch = asyncio.create_task(_watch_loop_lag())
    logger.info("Ready for calls")
    yield
    cleanup.cancel()
    lag_watch.cancel()


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
    ("POST", "/api/knowledge-bases/{kb_id}/documents"): "Uploaded knowledge base documents",
    ("POST", "/api/knowledge-bases/{kb_id}/documents/text"): "Added text to a knowledge base",
    ("POST", "/api/knowledge-bases/{kb_id}/documents/{doc_id}/retry"): "Re-indexed a knowledge base document",
    ("DELETE", "/api/knowledge-bases/{kb_id}/documents/{doc_id}"): "Deleted a knowledge base document",
    ("POST", "/api/phone-numbers"): "Added phone number",
    ("PUT", "/api/phone-numbers/{pn_id}"): "Updated phone number",
    ("DELETE", "/api/phone-numbers/{pn_id}"): "Removed phone number",
    ("POST", "/api/phone-numbers/{pn_id}/connect"): "Connected phone number to Twilio",
    ("PUT", "/api/settings"): "Updated settings",
    ("PUT", "/api/capacity/drain"): "Changed call draining (deploy mode)",
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


async def _public_host(request: Request) -> str:
    """Host Twilio should open the media stream to (e.g. abc123.ngrok-free.dev)."""
    settings = await asyncio.to_thread(store.get_settings)  # a DB read: keep it off the event loop
    host = settings.public_base_url or request.headers.get("x-forwarded-host") or request.url.hostname
    return host.removeprefix("https://").removeprefix("http://").rstrip("/")


def _twiml(body: str) -> Response:
    return Response(f'<?xml version="1.0" encoding="UTF-8"?><Response>{body}</Response>',
                    media_type="application/xml")


@app.get("/health")
async def health():
    """Liveness plus load, for the load balancer / uptime monitor (counts only, no call data)."""
    snap = limiter.snapshot()
    return {"status": "ok", "active_calls": snap["active_calls"], "max_calls": snap["max_calls"],
            "queued_callers": snap["queued_callers"], "draining": snap["draining"],
            "loop_lag_ms_max_1m": round(max(_lag["max_ms"], _lag["window_max_ms"]))}


# Where a caller goes when the line is full and they can't wait: a human line if configured.
OVERFLOW_NUMBER = os.getenv("OVERFLOW_TRANSFER_NUMBER", "")
HOLD_MUSIC_URL = os.getenv("HOLD_MUSIC_URL", "")  # short clip (<= ~8 s), played between the hold messages

_TURN_AWAY = {
    "full": "We're sorry, all of our lines are busy right now. Please call back in a few minutes. Goodbye.",
    "timeout": "We're sorry, we couldn't connect you in time. Please call back in a few minutes. Goodbye.",
    "caller_limit": "We're sorry, you already have calls in progress with us. Goodbye.",
    "draining": "We're sorry, our service is restarting. Please call back in a minute. Goodbye.",
    "expired": "We're sorry, we lost your place in line. Please call back. Goodbye.",
}


def _turn_away(reason: str) -> Response:
    if OVERFLOW_NUMBER and reason in ("full", "timeout"):
        return _twiml(f"<Say>All of our assistants are busy. Connecting you to a team member.</Say>"
                      f"<Dial>{escape(OVERFLOW_NUMBER)}</Dial>")
    return _twiml(f"<Say>{escape(_TURN_AWAY.get(reason, _TURN_AWAY['full']))}</Say><Hangup/>")


async def _hold(request: Request, d: Decision) -> Response:
    """Keep a queued caller on the line: a message, a pause, then come back to /incoming/hold."""
    url = f"https://{await _public_host(request)}/incoming/hold?ticket={quote(d.ticket)}"
    lead = ""
    if d.polls == 0:
        n = d.position
        lead = (f"<Say>All of our assistants are helping other callers. Please stay on the line. "
                f"You are number {n} in line.</Say>")
    elif d.polls % 4 == 0:
        lead = f"<Say>Thank you for holding. You are number {d.position} in line.</Say>"
    wait = (f"<Play>{escape(HOLD_MUSIC_URL)}</Play>" if HOLD_MUSIC_URL
            else f'<Pause length="{limiter.limits.hold_poll_s}"/>')
    return _twiml(f'{lead}{wait}<Redirect method="POST">{escape(url)}</Redirect>')


async def _admit_twiml(request: Request, agent: Agent, frm: str | None, to: str | None) -> Response:
    """The TwiML that connects an admitted call to the agent (after its ring time)."""
    if agent.conversation.ring_seconds > 0:
        await asyncio.sleep(min(agent.conversation.ring_seconds, 10))
    stream_url = f"wss://{await _public_host(request)}/ws"
    params = "".join(
        f"<Parameter name={quoteattr(k)} value={quoteattr(str(v or ''))} />"
        for k, v in {"agent_id": agent.id, "from": frm, "to": to}.items()
    )
    return _twiml(f"<Connect><Stream url={quoteattr(stream_url)}>{params}</Stream></Connect>")


@app.post("/incoming")
async def incoming_call(request: Request):
    """Twilio voice webhook for every connected number."""
    form = await request.form()
    to, frm, sid = form.get("To"), form.get("From"), form.get("CallSid")
    # Database lookups are blocking; keep them off the event loop that carries every live call's audio.
    number = await asyncio.to_thread(store.number_for, to)
    agent = await asyncio.to_thread(store.get, Agent, number.agent_id) if number and number.agent_id else None
    logger.info(f"Incoming call {sid} from {frm} to {to} -> agent {agent.name if agent else 'NONE'}")
    if agent is None:
        return _twiml("<Say>We're sorry, this number is not in service yet. Goodbye.</Say><Hangup/>")

    d = limiter.admit(sid, frm or "", meta=(agent.id, frm, to))
    logger.info(f"Call {sid}: {d.status} {d.reason} (active {limiter.live}/{limiter.limits.max_calls}, "
                f"queued {limiter.queued})")
    if d.status == "rejected":
        await asyncio.to_thread(audit.record, "system", f"Turned away a call ({d.reason})", target=sid,
                                caller=frm, dialed=to)
        return _turn_away(d.reason)
    if d.status == "queued":
        return await _hold(request, d)
    return await _admit_twiml(request, agent, frm, to)


@app.post("/incoming/hold")
async def incoming_hold(request: Request, ticket: str = ""):
    """The hold loop: every few seconds a queued caller's call comes back here."""
    d = limiter.poll(ticket)
    if d.status == "queued":
        return await _hold(request, d)
    if d.status == "rejected":
        return _turn_away(d.reason)
    agent_id, frm, to = d.meta
    agent = await asyncio.to_thread(store.get, Agent, agent_id)
    if agent is None:
        limiter.release(d.call_sid)
        return _turn_away("expired")
    return await _admit_twiml(request, agent, frm, to)


# Seconds to wait before noting a transfer's outcome on the call record: the agent's own final
# save of the record lands as the stream closes, and must not overwrite the note.
TRANSFER_NOTE_DELAY_S = 15
_background: set[asyncio.Task] = set()


async def _note_transfer(call_sid: str, status: str, duration_s: float | None, answered: bool) -> None:
    await asyncio.sleep(TRANSFER_NOTE_DELAY_S)
    try:
        await asyncio.to_thread(store.note_transfer_outcome, call_sid, status, duration_s, answered)
    except Exception:
        logger.exception(f"Saving the transfer outcome of {call_sid} failed")


@app.post("/transfer/done")
async def transfer_done(request: Request, agent_id: str = ""):
    """Twilio comes back here when a transfer's <Dial> ends. Answered: the call is over.
    Busy, no answer or failed: tell the caller instead of hanging up on them in silence."""
    form = await request.form()
    sid, status = form.get("CallSid") or "", form.get("DialCallStatus") or "unknown"
    try:
        duration = float(form.get("DialCallDuration") or 0) or None
    except ValueError:
        duration = None
    answered = routing.dial_answered(status)
    logger.info(f"Transfer of {sid} ended: {status} ({duration or 0:.0f}s)")
    task = asyncio.create_task(_note_transfer(sid, status, duration, answered))
    _background.add(task)
    task.add_done_callback(_background.discard)
    if answered:
        return _twiml("<Hangup/>")
    await asyncio.to_thread(audit.record, "system", f"Transfer not answered ({status})", target=sid)
    agent = await asyncio.to_thread(store.get, Agent, agent_id) if agent_id else None
    message = (agent.routing if agent else RoutingConfig()).transfer_unavailable_message
    return _twiml(f"<Say>{escape(message)}</Say><Hangup/>")


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
