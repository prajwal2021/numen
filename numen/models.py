"""Configuration models: everything an agent, knowledge base, or phone number can be set to.

These are the single source of truth for what the runtime supports. The admin UI edits
them, the store persists them as JSON, and the call pipeline reads them per call.
"""

from __future__ import annotations

import re
import uuid
from datetime import date, datetime, timezone
from typing import Literal

from pydantic import BaseModel, Field, ValidationInfo, field_validator

E164 = re.compile(r"^\+[1-9]\d{6,14}$")
HHMM = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")
WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _phone(v: str | None) -> str | None:
    if v is None or v == "":
        return None
    v = re.sub(r"[\s().-]", "", v)
    if not E164.match(v):
        raise ValueError("must be an E.164 phone number, e.g. +18065550100")
    return v


# ---------------------------------------------------------------------------- agents


class LLMConfig(BaseModel):
    provider: Literal["openai"] = "openai"
    model: str = "gpt-4.1"


class VoiceConfig(BaseModel):
    provider: Literal["elevenlabs"] = "elevenlabs"
    voice_id: str = "kdmDKE6EkgrWrrykO9Qt"
    voice_name: str = "Alexandra"
    model: str = "eleven_flash_v2"
    speed: float = Field(1.0, ge=0.7, le=1.2)
    stability: float = Field(0.5, ge=0.0, le=1.0)
    similarity_boost: float = Field(0.8, ge=0.0, le=1.0)


class KnowledgeConfig(BaseModel):
    knowledge_base_id: str | None = None
    # verbatim: the KB answer is spoken word for word and the LLM may not state facts.
    # rephrase: the LLM says the KB answer in its own words (facts must stay as returned).
    answer_mode: Literal["verbatim", "rephrase"] = "verbatim"
    # Send every question to the KB, even off-topic ones (the KB decides what's in scope).
    route_all_questions: bool = True
    lookup_filler: str = "Let me check on that."
    follow_up: str = "Would you like additional information on this topic?"
    # A faint keyboard-typing sound under the line while a lookup runs.
    typing_sound: bool = True


class DaySchedule(BaseModel):
    open: bool = True
    start: str = "08:00"
    end: str = "17:00"

    @field_validator("start", "end")
    @classmethod
    def _hhmm(cls, v: str) -> str:
        if not HHMM.match(v):
            raise ValueError("time must be HH:MM (24-hour)")
        return v


class Holiday(BaseModel):
    date: date
    name: str = ""


def _default_week() -> dict[str, DaySchedule]:
    return {d: DaySchedule(open=d not in ("sat", "sun")) for d in WEEKDAYS}


class RoutingConfig(BaseModel):
    office_hours_enabled: bool = True
    timezone: str = "America/Chicago"
    week: dict[str, DaySchedule] = Field(default_factory=_default_week)
    holidays: list[Holiday] = Field(default_factory=list)

    transfer_enabled: bool = True
    transfer_number: str | None = None
    transfer_message: str = "Sure, I'll transfer you to a live agent now. Please hold."

    # What happens when a call arrives outside office hours.
    after_hours_action: Literal["answer", "transfer"] = "answer"
    after_hours_number: str | None = None
    after_hours_message: str = (
        "Thank you for calling. Our office is currently closed, so I'll transfer your call. "
        "Please hold."
    )
    # Said before an in-call transfer outside office hours.
    transfer_message_after_hours: str = (
        "Our office is closed right now, so I'll transfer you to our after-hours line. Please hold."
    )
    transfer_message_voicemail: str = (
        "Our office is closed right now, so I'll transfer you to voicemail. Please hold."
    )
    transfer_failed_message: str = (
        "I'm sorry, I wasn't able to transfer your call. Please call back during office hours, "
        "or ask me something else."
    )
    # Said after the transfer line was busy or didn't answer; the call then ends.
    transfer_unavailable_message: str = (
        "I'm sorry, no one was available to take your call. Please call back later. Goodbye."
    )

    @field_validator("transfer_number", "after_hours_number", mode="before")
    @classmethod
    def _phones(cls, v: str | None) -> str | None:
        return _phone(v)

    @field_validator("week")
    @classmethod
    def _all_days(cls, v: dict[str, DaySchedule]) -> dict[str, DaySchedule]:
        week = _default_week()
        week.update({k: d for k, d in v.items() if k in WEEKDAYS})
        return week


class ConversationConfig(BaseModel):
    ring_seconds: float = Field(4, ge=0, le=10)
    mute_during_greeting: bool = True
    min_words_to_interrupt: int = Field(3, ge=1, le=10)
    # How loud and clear speech must be to count as the caller talking. Background voices
    # (a TV, people nearby) are quieter than the caller's; "strong" ignores more of them but
    # needs callers to speak up, "off" reacts to any speech the line picks up.
    background_voice_filter: Literal["off", "standard", "strong"] = "standard"
    # The language callers speak. "auto" detects it per phrase, which can mishear English on a
    # phone line as another language; pick it only with a multilingual voice model.
    caller_language: Literal["en", "es", "auto"] = "en"
    # Names and terms the speech-to-text should listen for (program names, acronyms).
    keyterms: list[str] = Field(default_factory=list, max_length=50)
    # The agent hangs up when the caller is done ("thank you", "that's all", "bye").
    end_call_enabled: bool = True
    goodbye_message: str = "You're welcome. Thank you for calling, and have a great day. Goodbye."


class SafetyConfig(BaseModel):
    """What the agent says when a caller is in danger or crisis. Spoken word for word (never
    LLM-written), so the numbers are always exactly these."""

    enabled: bool = True
    # Someone is hurt, in danger, or needs urgent medical help right now.
    emergency_message: str = (
        "This sounds like an emergency. If you or someone else is in danger or needs urgent "
        "medical help, please hang up and call 9 1 1 right now."
    )
    # Thoughts of suicide or self-harm, or severe emotional distress.
    crisis_message: str = (
        "I'm really sorry you're going through this, and I'm glad you said something. You don't "
        "have to face it alone. You can call or text 9 8 8, the Suicide and Crisis Lifeline, any "
        "time, day or night, to talk with someone right now. If you are in immediate danger, "
        "please call 9 1 1."
    )


class Agent(BaseModel):
    id: str = Field(default_factory=lambda: new_id("agt"))
    name: str
    description: str = ""
    greeting: str = "Thank you for calling. How can I help you today?"
    prompt: str = "You are a friendly and helpful virtual assistant."
    llm: LLMConfig = Field(default_factory=LLMConfig)
    voice: VoiceConfig = Field(default_factory=VoiceConfig)
    knowledge: KnowledgeConfig = Field(default_factory=KnowledgeConfig)
    routing: RoutingConfig = Field(default_factory=RoutingConfig)
    conversation: ConversationConfig = Field(default_factory=ConversationConfig)
    safety: SafetyConfig = Field(default_factory=SafetyConfig)
    created_at: str = Field(default_factory=utcnow)
    updated_at: str = Field(default_factory=utcnow)


# ---------------------------------------------------------------------------- knowledge bases


class KnowledgeBase(BaseModel):
    """Where an agent's answers come from.

    - "documents": files and text uploaded in Numen, searched and answered here (numen/kb_docs.py).
    - "rag_service": an external service: POST {url}/answer {"question"} -> {"found", "text"}.
    """

    id: str = Field(default_factory=lambda: new_id("kb"))
    name: str
    description: str = ""
    type: Literal["documents", "rag_service"] = "rag_service"
    url: str = ""
    api_key: str = ""
    timeout_s: float = Field(8, ge=1, le=30)
    fallback_message: str = (
        "I'm sorry, I don't have an answer for that. I can transfer you to our support center, "
        "or you can ask me something else."
    )
    created_at: str = Field(default_factory=utcnow)
    updated_at: str = Field(default_factory=utcnow)

    @field_validator("name")
    @classmethod
    def _name(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("is required")
        return v.strip()

    @field_validator("url")
    @classmethod
    def _url(cls, v: str, info: ValidationInfo) -> str:
        v = v.strip().rstrip("/")
        if info.data.get("type") == "documents" and not v:
            return ""
        if not re.match(r"^https?://", v):
            raise ValueError("must start with http:// or https://")
        return v


# ---------------------------------------------------------------------------- phone numbers


class PhoneNumber(BaseModel):
    id: str = Field(default_factory=lambda: new_id("pn"))
    number: str
    label: str = ""
    provider: Literal["twilio"] = "twilio"
    agent_id: str | None = None
    created_at: str = Field(default_factory=utcnow)

    @field_validator("number", mode="before")
    @classmethod
    def _num(cls, v: str) -> str:
        return _phone(v)


# ---------------------------------------------------------------------------- workspace settings


class Settings(BaseModel):
    workspace_name: str = "Numen"
    public_base_url: str = ""  # e.g. https://abc.ngrok-free.dev - where Twilio reaches us
    twilio_account_sid: str = ""
    twilio_auth_token: str = ""
    elevenlabs_api_key: str = ""
    openai_api_key: str = ""
    # The web app's address, used in password-reset and invite links.
    app_base_url: str = "http://localhost:3000"
    # Outgoing email (password resets, invites)
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_security: Literal["starttls", "ssl", "none"] = "starttls"
    smtp_username: str = ""
    smtp_password: str = ""
    smtp_from: str = ""


SECRET_FIELDS = {
    "settings": ("twilio_auth_token", "elevenlabs_api_key", "openai_api_key", "smtp_password"),
    "knowledge_base": ("api_key",),
}
