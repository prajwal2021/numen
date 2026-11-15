"""Outgoing email over SMTP (configured in Settings > Email). Used for password resets and invites."""

from __future__ import annotations

import asyncio
import smtplib
import ssl
from email.message import EmailMessage
from html import escape

from loguru import logger

from .store import get_settings


def configured() -> bool:
    s = get_settings()
    return bool(s.smtp_host and s.smtp_from)


def _send(to: str, subject: str, text: str, html: str) -> None:
    s = get_settings()
    msg = EmailMessage()
    msg["From"], msg["To"], msg["Subject"] = s.smtp_from, to, subject
    msg.set_content(text)
    msg.add_alternative(html, subtype="html")
    ctx = ssl.create_default_context()
    if s.smtp_security == "ssl":
        server = smtplib.SMTP_SSL(s.smtp_host, s.smtp_port, context=ctx, timeout=20)
    else:
        server = smtplib.SMTP(s.smtp_host, s.smtp_port, timeout=20)
    with server:
        if s.smtp_security == "starttls":
            server.starttls(context=ctx)
        if s.smtp_username:
            server.login(s.smtp_username, s.smtp_password)
        server.send_message(msg)


async def send(to: str, subject: str, text: str, html: str) -> tuple[bool, str | None]:
    if not configured():
        return False, "Email isn't set up (Settings > Email)."
    try:
        await asyncio.to_thread(_send, to, subject, text, html)
        return True, None
    except Exception as e:
        logger.warning(f"Email to {to} failed: {type(e).__name__}: {e}")
        return False, f"{type(e).__name__}: {e}"


def _layout(title: str, body: str, button: str, link: str, footer: str) -> str:
    return f"""<!doctype html><html><body style="margin:0;background:#f6f6f6;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#171717">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:40px 16px">
<table width="480" cellpadding="0" cellspacing="0" style="background:#fff;border:1px solid #e5e5e5;border-radius:12px">
<tr><td style="padding:32px">
<div style="font-weight:600;font-size:15px;margin-bottom:24px">Numen</div>
<h1 style="font-size:20px;margin:0 0 12px">{escape(title)}</h1>
<p style="font-size:14px;line-height:22px;color:#404040;margin:0 0 24px">{body}</p>
<a href="{escape(link)}" style="display:inline-block;background:#171717;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px;font-size:14px;font-weight:500">{escape(button)}</a>
<p style="font-size:12px;line-height:18px;color:#737373;margin:24px 0 0">{escape(footer)}<br>Or paste this link: {escape(link)}</p>
</td></tr></table></td></tr></table></body></html>"""


async def send_reset(to: str, name: str, link: str) -> tuple[bool, str | None]:
    text = (f"Hi {name},\n\nWe received a request to reset your Numen password. Open this link to choose a new one "
            f"(valid for 1 hour):\n\n{link}\n\nIf you didn't ask for this, you can ignore this email.")
    html = _layout("Reset your password", f"Hi {escape(name)}, we received a request to reset your Numen password.",
                   "Choose a new password", link, "This link expires in 1 hour. If you didn't ask for it, ignore this email.")
    return await send(to, "Reset your Numen password", text, html)


async def send_invite(to: str, name: str, inviter: str, link: str) -> tuple[bool, str | None]:
    text = (f"Hi {name},\n\n{inviter} invited you to Numen. Open this link to set your password and sign in "
            f"(valid for 72 hours):\n\n{link}")
    html = _layout("You're invited to Numen", f"Hi {escape(name)}, {escape(inviter)} invited you to Numen, where your team builds and runs voice agents.",
                   "Accept invite", link, "This link expires in 72 hours.")
    return await send(to, "You're invited to Numen", text, html)


async def send_test(to: str) -> tuple[bool, str | None]:
    return await send(to, "Numen test email", "Email from Numen is working.",
                      "<p style='font-family:sans-serif'>Email from Numen is working.</p>")
