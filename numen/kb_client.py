"""Client for knowledge bases of type "rag_service".

Contract: POST {url}/answer {"question": "..."} -> {"found": bool, "text": str}, with a bearer
key. One request per question, no retries on 4xx, back off for Retry-After (default 60 s)
on 429. The key is never logged; question and answer text are recorded in the call log.
"""

from __future__ import annotations

import time
from dataclasses import asdict, dataclass, field

import httpx
from loguru import logger

from .models import KnowledgeBase

MAX_QUESTION_CHARS = 500


@dataclass
class Lookup:
    question: str
    fallback: str
    found: bool = False
    answer: str | None = None
    # answer | no_answer | rate_limited | unauthorized | http_error | timeout | error | no_kb
    result: str = "error"
    http_status: int | None = None
    latency_ms: int | None = None
    error: str | None = None
    knowledge_base_id: str | None = None
    knowledge_base_name: str | None = None

    @property
    def text(self) -> str:
        """What the caller hears: the answer, or the fallback."""
        return self.answer if self.found and self.answer else self.fallback

    @property
    def used_fallback(self) -> bool:
        return not self.found

    def log_fields(self) -> dict:
        d = asdict(self)
        d.pop("fallback")
        d["used_fallback"] = self.used_fallback
        return d


@dataclass
class _State:
    client: httpx.AsyncClient
    backoff_until: float = 0.0
    signature: tuple = field(default_factory=tuple)


_states: dict[str, _State] = {}


def _state(kb: KnowledgeBase) -> _State:
    sig = (kb.url, kb.api_key, kb.timeout_s)
    st = _states.get(kb.id)
    if st is None or st.signature != sig:
        client = httpx.AsyncClient(
            base_url=kb.url,
            headers={"Authorization": f"Bearer {kb.api_key}"} if kb.api_key else {},
            timeout=kb.timeout_s,
            # Questions arrive further apart than httpx's 5 s default keep-alive.
            limits=httpx.Limits(keepalive_expiry=30),
        )
        st = _states[kb.id] = _State(client=client, signature=sig)
    return st


def config_snapshot(kb: KnowledgeBase | None) -> dict:
    if kb is None:
        return {"knowledge_base": None}
    st = _states.get(kb.id)
    return {
        "knowledge_base_id": kb.id,
        "name": kb.name,
        "type": kb.type,
        "service_url": kb.url,
        "endpoint": "POST /answer",
        "api_key": f"set ({len(kb.api_key)} chars, ...{kb.api_key[-4:]})" if kb.api_key else "not set",
        "timeout_s": kb.timeout_s,
        "max_question_chars": MAX_QUESTION_CHARS,
        "keepalive_expiry_s": 30,
        "retry_policy": "none; 429 -> back off for Retry-After (default 60 s)",
        "fallback_message": kb.fallback_message,
        "backoff_active": bool(st and time.monotonic() < st.backoff_until),
    }


async def warm(kb: KnowledgeBase | None) -> None:
    """Open the connection at call start, so the first question doesn't pay for it."""
    if kb is None:
        return
    try:
        await _state(kb).client.get("/health")
    except Exception:
        pass


async def health(kb: KnowledgeBase) -> dict:
    start = time.monotonic()
    try:
        r = await _state(kb).client.get("/health")
        ok = r.status_code == 200
        return {"ok": ok, "http_status": r.status_code, "latency_ms": round((time.monotonic() - start) * 1000),
                "body": r.text[:200]}
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}", "latency_ms": round((time.monotonic() - start) * 1000)}


async def lookup(kb: KnowledgeBase | None, question: str, fallback: str | None = None) -> Lookup:
    """Ask the knowledge base. Never raises: failures come back as found=False."""
    q = question[:MAX_QUESTION_CHARS]
    if kb is None:
        return Lookup(question=q, fallback=fallback or "I'm sorry, I don't have an answer for that.",
                      result="no_kb", error="no knowledge base attached")
    res = Lookup(question=q, fallback=kb.fallback_message, knowledge_base_id=kb.id, knowledge_base_name=kb.name)
    st = _state(kb)
    if time.monotonic() < st.backoff_until:
        res.result, res.error = "rate_limited", "backing off after 429"
        logger.warning(f"KB {kb.name}: rate-limited, using fallback")
        return res
    start = time.monotonic()
    try:
        r = await st.client.post("/answer", json={"question": q})
        res.http_status = r.status_code
        if r.status_code == 429:
            ra = r.headers.get("Retry-After", "60")
            st.backoff_until = time.monotonic() + (float(ra) if ra.isdigit() else 60)
            res.result = "rate_limited"
        elif r.status_code == 401:
            res.result, res.error = "unauthorized", "the service rejected the API key"
        elif r.status_code != 200:
            res.result = "http_error"
        else:
            body = r.json()
            if body.get("found") and body.get("text"):
                res.found, res.answer, res.result = True, body["text"], "answer"
            else:
                res.result = "no_answer"
    except httpx.TimeoutException as e:
        res.result, res.error = "timeout", type(e).__name__
    except Exception as e:  # never let a lookup crash the call
        res.result, res.error = "error", f"{type(e).__name__}: {e}"
    res.latency_ms = round((time.monotonic() - start) * 1000)
    logger.info(f"KB {kb.name}: {res.result} in {res.latency_ms} ms")
    return res
