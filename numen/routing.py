"""Per-agent call routing: office hours, holidays, and moving a live call to a phone number."""

from __future__ import annotations

import asyncio
from datetime import datetime
from xml.sax.saxutils import escape
from zoneinfo import ZoneInfo

from loguru import logger
from twilio.rest import Client as TwilioClient

from .models import WEEKDAYS, RoutingConfig
from .store import get_settings


def now_in(cfg: RoutingConfig) -> datetime:
    return datetime.now(ZoneInfo(cfg.timezone))


def holiday_name(cfg: RoutingConfig, now: datetime | None = None) -> str | None:
    now = now or now_in(cfg)
    h = next((h for h in cfg.holidays if h.date == now.date()), None)
    return (h.name or "Holiday") if h else None


def office_is_open(cfg: RoutingConfig, now: datetime | None = None) -> bool:
    """Always open when office hours are disabled."""
    if not cfg.office_hours_enabled:
        return True
    now = now or now_in(cfg)
    if holiday_name(cfg, now):
        return False
    day = cfg.week[WEEKDAYS[now.weekday()]]
    hhmm = now.strftime("%H:%M")
    return day.open and day.start <= hhmm < day.end


def after_hours_transfer(cfg: RoutingConfig) -> bool:
    """Should a call arriving now go straight to the after-hours number?"""
    return (
        cfg.office_hours_enabled
        and cfg.after_hours_action == "transfer"
        and bool(cfg.after_hours_number)
        and not office_is_open(cfg)
    )


def transfer_target(cfg: RoutingConfig) -> tuple[str | None, str]:
    """(number, message to say first) for an in-call live-agent transfer right now."""
    if office_is_open(cfg):
        return cfg.transfer_number, cfg.transfer_message
    if cfg.after_hours_number:
        return cfg.after_hours_number, cfg.transfer_message_after_hours
    return cfg.transfer_number, cfg.transfer_message_voicemail


def describe_hours(cfg: RoutingConfig) -> str:
    """Office hours in words, for the system prompt."""
    names = {"mon": "Monday", "tue": "Tuesday", "wed": "Wednesday", "thu": "Thursday",
             "fri": "Friday", "sat": "Saturday", "sun": "Sunday"}

    def t(hhmm: str) -> str:
        return datetime.strptime(hhmm, "%H:%M").strftime("%-I:%M %p")

    lines = []
    for d in WEEKDAYS:
        day = cfg.week[d]
        lines.append(f"- {names[d]}: {t(day.start)} to {t(day.end)}" if day.open else f"- {names[d]}: closed")
    return "\n".join(lines)


def _twilio() -> TwilioClient:
    # Reads settings from the database: call it in a thread, never on the event loop that
    # carries every live call's audio.
    s = get_settings()
    return TwilioClient(s.twilio_account_sid, s.twilio_auth_token)


async def transfer_call(call_sid: str, number: str) -> tuple[bool, str | None]:
    """Move the live Twilio call off the bot's media stream and dial `number`."""
    twiml = f"<Response><Dial>{escape(number)}</Dial></Response>"
    try:
        await asyncio.to_thread(lambda: _twilio().calls(call_sid).update(twiml=twiml))
        logger.info(f"Transferred call {call_sid} to {number}")
        return True, None
    except Exception as e:
        logger.exception(f"Transfer of call {call_sid} failed")
        return False, f"{type(e).__name__}: {e}"


async def hang_up(call_sid: str) -> tuple[bool, str | None]:
    """End the live Twilio call."""
    try:
        await asyncio.to_thread(lambda: _twilio().calls(call_sid).update(status="completed"))
        logger.info(f"Hung up call {call_sid}")
        return True, None
    except Exception as e:
        logger.warning(f"Hang-up of call {call_sid} failed: {e}")
        return False, f"{type(e).__name__}: {e}"
