"""Calls to the outside services the admin UI needs: Twilio (numbers, webhooks), ElevenLabs
(voices, previews), OpenAI (key check), and ngrok (detect the public URL).
"""

from __future__ import annotations

import asyncio

import httpx
from twilio.rest import Client as TwilioClient

from .store import get_settings

ELEVEN = "https://api.elevenlabs.io"
TTS_MODELS = [
    {"id": "eleven_flash_v2", "name": "Flash v2", "description": "Fastest, English only. Best for phone calls."},
    {"id": "eleven_flash_v2_5", "name": "Flash v2.5", "description": "Fastest, 32 languages."},
    {"id": "eleven_turbo_v2_5", "name": "Turbo v2.5", "description": "Higher quality, slightly slower."},
    {"id": "eleven_multilingual_v2", "name": "Multilingual v2", "description": "Most natural, highest latency."},
]
LLM_MODELS = [
    {"id": "gpt-4.1", "name": "GPT-4.1", "description": "Reliable tool use. Recommended."},
    {"id": "gpt-4.1-mini", "name": "GPT-4.1 mini", "description": "Faster and cheaper."},
    {"id": "gpt-4o", "name": "GPT-4o", "description": "Fast, general purpose."},
    {"id": "gpt-4o-mini", "name": "GPT-4o mini", "description": "Fastest and cheapest."},
]


class IntegrationError(Exception):
    pass


def webhook_url(base: str | None = None) -> str | None:
    base = (base or get_settings().public_base_url or "").rstrip("/")
    return f"{base}/incoming" if base else None


# ---------------------------------------------------------------------------- Twilio


def _twilio() -> TwilioClient:
    s = get_settings()
    if not (s.twilio_account_sid and s.twilio_auth_token):
        raise IntegrationError("Twilio credentials are not set (Settings > Integrations).")
    return TwilioClient(s.twilio_account_sid, s.twilio_auth_token)


async def twilio_numbers() -> list[dict]:
    def run():
        return [
            {"sid": n.sid, "number": n.phone_number, "friendly_name": n.friendly_name,
             "voice_url": n.voice_url, "capabilities": dict(n.capabilities or {})}
            for n in _twilio().incoming_phone_numbers.list(limit=200)
        ]
    return await asyncio.to_thread(run)


async def twilio_number(number: str) -> dict | None:
    def run():
        found = _twilio().incoming_phone_numbers.list(phone_number=number, limit=1)
        n = found[0] if found else None
        return {"sid": n.sid, "number": n.phone_number, "friendly_name": n.friendly_name,
                "voice_url": n.voice_url} if n else None
    return await asyncio.to_thread(run)


async def connect_number(number: str) -> dict:
    """Point the number's voice webhook at this server."""
    url = await asyncio.to_thread(webhook_url)
    if not url:
        raise IntegrationError("Set the Public URL first (Settings > General), e.g. your ngrok URL.")

    def run():
        found = _twilio().incoming_phone_numbers.list(phone_number=number, limit=1)
        if not found:
            raise IntegrationError(f"{number} isn't in this Twilio account.")
        n = found[0].update(voice_url=url, voice_method="POST")
        return {"number": n.phone_number, "voice_url": n.voice_url}
    return await asyncio.to_thread(run)


async def twilio_check() -> dict:
    def run():
        s = get_settings()
        acct = _twilio().api.v2010.accounts(s.twilio_account_sid).fetch()
        return {"ok": True, "detail": f"{acct.friendly_name} ({acct.type}, {acct.status})"}
    try:
        return await asyncio.to_thread(run)
    except Exception as e:
        return {"ok": False, "detail": str(e)[:300]}


# ---------------------------------------------------------------------------- ElevenLabs


def _eleven_headers() -> dict:
    key = get_settings().elevenlabs_api_key
    if not key:
        raise IntegrationError("ElevenLabs API key is not set (Settings > Integrations).")
    return {"xi-api-key": key}


async def voices() -> list[dict]:
    async with httpx.AsyncClient(timeout=20) as c:
        r = await c.get(f"{ELEVEN}/v1/voices", headers=_eleven_headers())
        r.raise_for_status()
    out = []
    for v in r.json().get("voices", []):
        labels = v.get("labels") or {}
        out.append({
            "voice_id": v["voice_id"], "name": v["name"], "category": v.get("category"),
            "description": labels.get("description") or labels.get("descriptive") or "",
            "accent": labels.get("accent"), "gender": labels.get("gender"), "age": labels.get("age"),
            "use_case": labels.get("use_case"), "preview_url": v.get("preview_url"),
        })
    return out


async def voice_preview(voice_id: str, text: str, model: str, speed: float, stability: float,
                        similarity_boost: float) -> bytes:
    body = {"text": text[:400], "model_id": model,
            "voice_settings": {"speed": speed, "stability": stability, "similarity_boost": similarity_boost}}
    async with httpx.AsyncClient(timeout=30) as c:
        r = await c.post(f"{ELEVEN}/v1/text-to-speech/{voice_id}?output_format=mp3_44100_128",
                         headers=_eleven_headers(), json=body)
    if r.status_code != 200:
        raise IntegrationError(f"ElevenLabs returned HTTP {r.status_code}: {r.text[:200]}")
    return r.content


async def elevenlabs_check() -> dict:
    try:
        async with httpx.AsyncClient(timeout=15) as c:
            r = await c.get(f"{ELEVEN}/v1/user/subscription", headers=_eleven_headers())
        if r.status_code != 200:
            return {"ok": False, "detail": f"HTTP {r.status_code}"}
        d = r.json()
        return {"ok": True, "detail": f"{d.get('tier', '?')} plan, {d.get('character_count', 0):,} / "
                                      f"{d.get('character_limit', 0):,} characters used"}
    except Exception as e:
        return {"ok": False, "detail": str(e)[:300]}


# ---------------------------------------------------------------------------- OpenAI, ngrok


async def openai_check() -> dict:
    key = (await asyncio.to_thread(get_settings)).openai_api_key
    if not key:
        return {"ok": False, "detail": "OpenAI API key is not set."}
    try:
        async with httpx.AsyncClient(timeout=15) as c:
            r = await c.get("https://api.openai.com/v1/models", headers={"Authorization": f"Bearer {key}"})
        return {"ok": r.status_code == 200, "detail": "Key accepted" if r.status_code == 200 else f"HTTP {r.status_code}"}
    except Exception as e:
        return {"ok": False, "detail": str(e)[:300]}


async def detect_ngrok() -> str | None:
    try:
        async with httpx.AsyncClient(timeout=3) as c:
            r = await c.get("http://127.0.0.1:4040/api/tunnels")
        tunnels = r.json().get("tunnels", [])
        https = [t["public_url"] for t in tunnels if t.get("public_url", "").startswith("https://")]
        return https[0] if https else None
    except Exception:
        return None
