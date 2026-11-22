"""REST API used by the web app (all routes under /api).

Every route needs a signed-in user. Routes marked ADMIN need the admin role: settings and
API keys, deleting agents or knowledge bases, and adding, connecting or removing phone numbers.
Auth, account, users and audit-log routes are in api_users.py.
"""

from __future__ import annotations

from typing import Any
from zoneinfo import available_timezones

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response as RawResponse
from pydantic import BaseModel, ValidationError

from . import audit, auth, capacity, integrations, kb_client, routing, store, testchat
from .models import Agent, KnowledgeBase, PhoneNumber, Settings, new_id, utcnow
from .prompt import system_prompt

router = APIRouter(prefix="/api", dependencies=[Depends(auth.current_user)])
ADMIN = [Depends(auth.require_admin)]
SECRETS = ("twilio_auth_token", "elevenlabs_api_key", "openai_api_key", "smtp_password")


def _note(request: Request, target: str | None = None, **meta) -> None:
    """Extra detail for the audit entry the request middleware writes for this request."""
    request.state.audit = {"target": target, "meta": meta}


def _mask(secret: str) -> dict:
    return {"set": bool(secret), "hint": f"...{secret[-4:]}" if len(secret) > 8 else ("set" if secret else "")}


def _404(what: str):
    raise HTTPException(404, f"{what} not found")


def _validate(model: type[BaseModel], data: dict) -> Any:
    try:
        return model.model_validate(data)
    except ValidationError as e:
        raise HTTPException(422, [{"field": ".".join(str(p) for p in err["loc"]), "message": err["msg"]}
                                  for err in e.errors()])


# ---------------------------------------------------------------------------- meta + dashboard


@router.get("/meta")
def meta():
    return {
        "llm_models": integrations.LLM_MODELS,
        "tts_models": integrations.TTS_MODELS,
        "timezones": sorted(t for t in available_timezones() if "/" in t and not t.startswith("Etc/")),
        "webhook_url": integrations.webhook_url(),
    }


@router.get("/capacity")
async def get_capacity():
    """Live load: calls running, callers on hold, limits, and counters since the server started."""
    return capacity.limiter.snapshot()


@router.put("/capacity/drain", dependencies=ADMIN)
async def set_drain(body: dict, request: Request):
    """Stop (or resume) answering new calls, so a deploy can wait for live calls to finish."""
    on = bool(body.get("draining"))
    capacity.limiter.set_draining(on)
    _note(request, "capacity", draining=on)
    return capacity.limiter.snapshot()


@router.get("/analytics")
def analytics(days: int = 30, agent_id: str | None = None, tz: str = "America/Chicago"):
    if tz not in available_timezones():
        tz = "UTC"
    return store.analytics(max(1, min(days, 365)), agent_id or None, tz)


@router.get("/dashboard")
def dashboard(days: int = 30):
    agents = store.list_all(Agent)
    return {
        "stats": store.call_stats(days),
        "counts": {
            "agents": len(agents),
            "knowledge_bases": len(store.list_all(KnowledgeBase)),
            "phone_numbers": len(store.list_all(PhoneNumber)),
        },
        "recent_calls": store.list_calls(limit=8),
    }


# ---------------------------------------------------------------------------- agents


def _agent_out(a: Agent) -> dict:
    numbers = [n.model_dump() for n in store.list_all(PhoneNumber) if n.agent_id == a.id]
    kb = store.get(KnowledgeBase, a.knowledge.knowledge_base_id) if a.knowledge.knowledge_base_id else None
    return {**a.model_dump(mode="json"), "phone_numbers": numbers, "knowledge_base_name": kb.name if kb else None,
            "office_open_now": routing.office_is_open(a.routing)}


def _check_refs(a: Agent) -> None:
    if a.knowledge.knowledge_base_id and not store.get(KnowledgeBase, a.knowledge.knowledge_base_id):
        raise HTTPException(422, [{"field": "knowledge.knowledge_base_id", "message": "knowledge base not found"}])


@router.get("/agents")
def list_agents():
    return [_agent_out(a) for a in store.list_all(Agent)]


class NewAgent(BaseModel):
    name: str
    description: str = ""
    copy_from: str | None = None


@router.post("/agents", status_code=201)
def create_agent(body: NewAgent):
    if body.copy_from:
        src = store.get(Agent, body.copy_from) or _404("agent to copy")
        a = src.model_copy(update={"id": new_id("agt"), "name": body.name, "description": body.description,
                                   "created_at": utcnow()})
    else:
        a = _validate(Agent, {"name": body.name, "description": body.description})
    store.save(a)
    return _agent_out(a)


@router.get("/agents/{agent_id}")
def get_agent(agent_id: str):
    return _agent_out(store.get(Agent, agent_id) or _404("agent"))


@router.put("/agents/{agent_id}")
def update_agent(agent_id: str, body: dict, request: Request):
    old = store.get(Agent, agent_id) or _404("agent")
    body = {k: v for k, v in body.items() if k not in ("phone_numbers", "knowledge_base_name", "office_open_now")}
    a = _validate(Agent, {**body, "id": old.id, "created_at": old.created_at})
    _check_refs(a)
    store.save(a)
    before, after = old.model_dump(mode="json"), a.model_dump(mode="json")
    changed = {}
    for section in ("name", "description", "greeting", "prompt", "llm", "voice", "knowledge", "routing", "conversation", "safety"):
        if before[section] != after[section]:
            if isinstance(after[section], dict):
                changed[section] = {k: {"from": before[section].get(k), "to": v} for k, v in after[section].items()
                                    if before[section].get(k) != v}
            else:
                changed[section] = "changed" if section in ("prompt", "greeting") else {"from": before[section], "to": after[section]}
    _note(request, target=f"{a.name} ({a.id})", changes=changed)
    return _agent_out(a)


@router.delete("/agents/{agent_id}", dependencies=ADMIN)
def delete_agent(agent_id: str, request: Request):
    agent = store.get(Agent, agent_id) or _404("agent")
    _note(request, target=f"{agent.name} ({agent.id})")
    for n in store.list_all(PhoneNumber):
        if n.agent_id == agent_id:
            n.agent_id = None
            store.save(n)
    store.delete(Agent, agent_id)
    return {"ok": True}


@router.post("/agents/{agent_id}/prompt-preview")
def prompt_preview(agent_id: str, body: dict | None = None):
    """The full system prompt the runtime would use, for saved or unsaved settings."""
    old = store.get(Agent, agent_id) or _404("agent")
    a = _validate(Agent, {**body, "id": old.id}) if body else old
    return {"prompt": system_prompt(a)}


@router.post("/agents/{agent_id}/test/start")
def test_start(agent_id: str):
    return testchat.start(store.get(Agent, agent_id) or _404("agent"))


class TestMessage(BaseModel):
    session_id: str
    text: str


@router.post("/agents/{agent_id}/test/message")
async def test_message(agent_id: str, body: TestMessage):
    agent = store.get(Agent, agent_id) or _404("agent")
    try:
        return await testchat.send(agent, body.session_id, body.text)
    except KeyError as e:
        raise HTTPException(410, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))


# ---------------------------------------------------------------------------- knowledge bases


def _kb_out(kb: KnowledgeBase) -> dict:
    d = kb.model_dump(mode="json")
    d["api_key"] = ""
    d["api_key_status"] = _mask(kb.api_key)
    d["used_by"] = [{"id": a.id, "name": a.name} for a in store.list_all(Agent)
                    if a.knowledge.knowledge_base_id == kb.id]
    return d


@router.get("/knowledge-bases")
def list_kbs():
    return [_kb_out(k) for k in store.list_all(KnowledgeBase)]


@router.post("/knowledge-bases", status_code=201)
def create_kb(body: dict):
    kb = _validate(KnowledgeBase, {k: v for k, v in body.items() if k not in ("id", "created_at")})
    store.save(kb)
    return _kb_out(kb)


@router.get("/knowledge-bases/{kb_id}")
def get_kb(kb_id: str):
    return _kb_out(store.get(KnowledgeBase, kb_id) or _404("knowledge base"))


@router.put("/knowledge-bases/{kb_id}")
def update_kb(kb_id: str, body: dict):
    old = store.get(KnowledgeBase, kb_id) or _404("knowledge base")
    data = {k: v for k, v in body.items() if k not in ("api_key_status", "used_by")}
    if not data.get("api_key"):  # blank means "keep the current key"
        data["api_key"] = old.api_key
    if data.pop("clear_api_key", False):
        data["api_key"] = ""
    kb = _validate(KnowledgeBase, {**data, "id": old.id, "created_at": old.created_at})
    store.save(kb)
    return _kb_out(kb)


@router.delete("/knowledge-bases/{kb_id}", dependencies=ADMIN)
def delete_kb(kb_id: str):
    kb = store.get(KnowledgeBase, kb_id) or _404("knowledge base")
    users = _kb_out(kb)["used_by"]
    if users:
        raise HTTPException(409, f"Used by {', '.join(u['name'] for u in users)}. Detach it from those agents first.")
    store.delete(KnowledgeBase, kb_id)
    return {"ok": True}


@router.post("/knowledge-bases/{kb_id}/health")
async def kb_health(kb_id: str):
    return await kb_client.health(store.get(KnowledgeBase, kb_id) or _404("knowledge base"))


class KBQuery(BaseModel):
    question: str


@router.post("/knowledge-bases/{kb_id}/query")
async def kb_query(kb_id: str, body: KBQuery):
    kb = store.get(KnowledgeBase, kb_id) or _404("knowledge base")
    r = await kb_client.lookup(kb, body.question)
    return {**r.log_fields(), "spoken": r.text}


# ---------------------------------------------------------------------------- phone numbers


@router.get("/phone-numbers")
async def list_numbers():
    nums = store.list_all(PhoneNumber)
    agents = {a.id: a.name for a in store.list_all(Agent)}
    hook = integrations.webhook_url()
    try:
        twilio = {n["number"]: n for n in await integrations.twilio_numbers()}
        twilio_error = None
    except Exception as e:
        twilio, twilio_error = None, str(e)[:200]
    out = []
    for n in nums:
        t = twilio.get(n.number) if twilio is not None else None
        if twilio is None:
            status = "unknown"
        elif t is None:
            status = "not_in_account"
        elif hook and t["voice_url"] == hook:
            status = "connected"
        else:
            status = "elsewhere"
        out.append({**n.model_dump(), "agent_name": agents.get(n.agent_id), "status": status,
                    "voice_url": t["voice_url"] if t else None})
    return {"numbers": out, "webhook_url": hook, "twilio_error": twilio_error}


@router.get("/twilio/numbers", dependencies=ADMIN)
async def twilio_numbers():
    try:
        existing = {n.number for n in store.list_all(PhoneNumber)}
        return [{**n, "imported": n["number"] in existing} for n in await integrations.twilio_numbers()]
    except Exception as e:
        raise HTTPException(400, str(e)[:300])


@router.post("/phone-numbers", status_code=201, dependencies=ADMIN)
def create_number(body: dict):
    n = _validate(PhoneNumber, {k: v for k, v in body.items() if k in ("number", "label", "agent_id")})
    if store.number_for(n.number):
        raise HTTPException(409, f"{n.number} is already added")
    if n.agent_id and not store.get(Agent, n.agent_id):
        raise HTTPException(422, "agent not found")
    store.save(n)
    return n.model_dump()


@router.put("/phone-numbers/{pn_id}")
def update_number(pn_id: str, body: dict):
    old = store.get(PhoneNumber, pn_id) or _404("phone number")
    n = _validate(PhoneNumber, {**old.model_dump(), **{k: v for k, v in body.items() if k in ("label", "agent_id")}})
    if n.agent_id and not store.get(Agent, n.agent_id):
        raise HTTPException(422, "agent not found")
    store.save(n)
    return n.model_dump()


@router.delete("/phone-numbers/{pn_id}", dependencies=ADMIN)
def delete_number(pn_id: str):
    store.get(PhoneNumber, pn_id) or _404("phone number")
    store.delete(PhoneNumber, pn_id)
    return {"ok": True}


@router.post("/phone-numbers/{pn_id}/connect", dependencies=ADMIN)
async def connect_number(pn_id: str):
    n = store.get(PhoneNumber, pn_id) or _404("phone number")
    try:
        return await integrations.connect_number(n.number)
    except Exception as e:
        raise HTTPException(400, str(e)[:300])


# ---------------------------------------------------------------------------- conversations


@router.get("/calls")
def list_calls(agent_id: str | None = None, q: str | None = None, limit: int = 200):
    return store.list_calls(agent_id=agent_id, q=q, limit=min(limit, 1000))


@router.get("/calls/{call_sid}")
def get_call(call_sid: str):
    return store.get_call(call_sid) or _404("call")


# ---------------------------------------------------------------------------- voices


@router.get("/voices")
async def voices():
    try:
        return await integrations.voices()
    except Exception as e:
        raise HTTPException(400, str(e)[:300])


class PreviewBody(BaseModel):
    voice_id: str
    text: str = "Hi! Thanks for calling. How can I help you today?"
    model: str = "eleven_flash_v2"
    speed: float = 1.0
    stability: float = 0.5
    similarity_boost: float = 0.8


@router.post("/voices/preview")
async def voice_preview(body: PreviewBody):
    try:
        audio = await integrations.voice_preview(**body.model_dump())
    except Exception as e:
        raise HTTPException(400, str(e)[:300])
    return RawResponse(audio, media_type="audio/mpeg")


# ---------------------------------------------------------------------------- settings


def _settings_out() -> dict:
    s = store.get_settings()
    out = s.model_dump()
    for f in SECRETS:
        out[f] = ""
        out[f + "_status"] = {**_mask(getattr(s, f)), "source": store.settings_source(f)}
    out["twilio_account_sid_source"] = store.settings_source("twilio_account_sid")
    out["public_base_url_source"] = store.settings_source("public_base_url")
    out["webhook_url"] = integrations.webhook_url()
    out["email_configured"] = bool(s.smtp_host and s.smtp_from)
    return out


@router.get("/settings", dependencies=ADMIN)
def get_settings():
    return _settings_out()


@router.put("/settings", dependencies=ADMIN)
def update_settings(body: dict, request: Request):
    stored = store.get_stored_settings().model_dump()
    cur = dict(stored)
    for k, v in body.items():
        if k not in Settings.model_fields:
            continue
        if k in SECRETS and not v:
            continue  # blank = keep current
        cur[k] = v.strip().rstrip("/") if k in ("public_base_url", "app_base_url") and isinstance(v, str) else v
    store.save_settings(_validate(Settings, cur))
    # Which fields changed, never their values for secrets.
    _note(request, changed_fields=[k for k in cur if cur[k] != stored.get(k)],
          values={k: cur[k] for k in cur if cur[k] != stored.get(k) and k not in SECRETS})
    return _settings_out()


@router.post("/settings/check/{provider}", dependencies=ADMIN)
async def check_provider(provider: str):
    checks = {"twilio": integrations.twilio_check, "elevenlabs": integrations.elevenlabs_check,
              "openai": integrations.openai_check}
    if provider not in checks:
        _404("provider")
    return await checks[provider]()


@router.get("/settings/detect-public-url", dependencies=ADMIN)
async def detect_public_url():
    return {"url": await integrations.detect_ngrok()}
