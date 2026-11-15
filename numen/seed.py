"""First-run import: turns the original hand-configured CLA bot (.env + cla_prompt.md) into
an agent, a knowledge base and a phone number in the database. Runs only when the
database has no agents.
"""

from __future__ import annotations

import os
import re
from datetime import datetime
from pathlib import Path

from loguru import logger

from . import store
from .models import Agent, Holiday, KnowledgeBase, KnowledgeConfig, PhoneNumber, RoutingConfig, VoiceConfig

ROOT = Path(__file__).resolve().parent.parent
LEGACY_PROMPT = Path(__file__).parent / "seed_data" / "cla_prompt.md"

CLA_GREETING = (
    "Thank you for calling the Texas Tech Career Learning Academy, my name is Ava your virtual "
    "assistant. Please note this call may be recorded. I may have some delay when I respond while "
    "I pull all relevant information to ensure I provide you the most accurate responses. How can I help you?"
)


def _persona_and_holidays() -> tuple[str, list[Holiday]]:
    text = LEGACY_PROMPT.read_text() if LEGACY_PROMPT.exists() else ""
    # The persona is everything before the sections the runtime now generates itself.
    persona = text.split("# Office Hours & Holidays")[0].strip()
    holidays = [
        Holiday(date=datetime.strptime(d, "%B %d, %Y").date(), name=n.strip())
        for d, n in re.findall(r"^- (\w+ \d{1,2}, \d{4}): (.+)$", text, flags=re.MULTILINE)
    ]
    return persona, holidays


def seed_if_empty() -> None:
    if store.list_all(Agent):
        return
    logger.info("Empty database: importing the original CLA agent")
    kb = None
    if os.getenv("KB_SERVICE_URL") or os.getenv("KB_API_KEY"):
        kb = KnowledgeBase(
            name="Career Learning Academy KB",
            description="pgvector RAG service for the Texas Tech Career Learning Academy",
            url=os.getenv("KB_SERVICE_URL") or "https://tosmonline0001.ttu.edu/cla-kb",
            api_key=os.getenv("KB_API_KEY", ""),
            timeout_s=float(os.getenv("KB_TIMEOUT_SECONDS", "8")),
        )
        store.save(kb)

    persona, holidays = _persona_and_holidays()
    agent = Agent(
        name="Ava - Career Learning Academy",
        description="Virtual assistant for the Texas Tech Career Learning Academy",
        greeting=os.getenv("GREETING") or CLA_GREETING,
        prompt=persona or "You are Ava, a virtual assistant for the Texas Tech Career Learning Academy.",
        voice=VoiceConfig(
            voice_id=os.getenv("ELEVENLABS_VOICE_ID") or "kdmDKE6EkgrWrrykO9Qt",
            voice_name="Alexandra",
            model=os.getenv("ELEVENLABS_MODEL", "eleven_flash_v2"),
            speed=float(os.getenv("ELEVENLABS_SPEED", "1.0")),
            stability=float(os.getenv("ELEVENLABS_STABILITY", "0.5")),
            similarity_boost=float(os.getenv("ELEVENLABS_SIMILARITY", "0.8")),
        ),
        knowledge=KnowledgeConfig(knowledge_base_id=kb.id if kb else None),
        routing=RoutingConfig(
            holidays=holidays,
            transfer_number=os.getenv("TRANSFER_NUMBER") or "+18065154465",
            after_hours_action="transfer" if os.getenv("AFTER_HOURS_TRANSFER_NUMBER") else "answer",
            after_hours_number=os.getenv("AFTER_HOURS_TRANSFER_NUMBER") or None,
            after_hours_message=(
                "Thank you for calling the Texas Tech Career Learning Academy. Our office is "
                "currently closed, so I'll transfer your call. Please hold."
            ),
            transfer_message_voicemail=(
                "Our office is closed right now, so I'll transfer you to the support center's "
                "voicemail. Please hold."
            ),
            transfer_failed_message=(
                "I'm sorry, I wasn't able to transfer your call. You can call back during our office "
                "hours, Monday through Friday, 8 AM to 5 PM Central, or ask me something else."
            ),
        ),
    )
    agent.llm.model = os.getenv("OPENAI_MODEL") or "gpt-4.1"
    agent.conversation.ring_seconds = float(os.getenv("RING_SECONDS", "4"))
    store.save(agent)

    if os.getenv("TWILIO_PHONE_NUMBER"):
        store.save(PhoneNumber(number=os.getenv("TWILIO_PHONE_NUMBER"), label="CLA line", agent_id=agent.id))
    logger.info(f"Imported agent '{agent.name}' ({agent.id})")
