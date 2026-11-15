"""Auth, account, user-management and audit-log API (under /api)."""

from __future__ import annotations

import time
from datetime import datetime, timedelta, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import Response as RawResponse
from pydantic import BaseModel, EmailStr, Field, ValidationError

from . import accounts, audit, mailer, store
from .accounts import NewUser, User
from .auth import client_ip, current_user, end_session, optional_user, require_admin, start_session

public = APIRouter(prefix="/api")
account = APIRouter(prefix="/api", dependencies=[Depends(current_user)])
admin = APIRouter(prefix="/api", dependencies=[Depends(require_admin)])

# Forgot-password requests per email per hour (in memory; enough to stop mail flooding).
_forgot_hits: dict[str, list[float]] = {}


def _ctx(request: Request) -> dict:
    return {"ip": client_ip(request), "user_agent": request.headers.get("user-agent")}


def _user_out(u: User) -> dict:
    return u.model_dump(mode="json")


def _app_link(path: str) -> str:
    return f"{store.get_settings().app_base_url.rstrip('/')}{path}"


def _check_password(pw: str, email: str, name: str) -> None:
    problem = accounts.password_problem(pw, email, name)
    if problem:
        raise HTTPException(422, [{"field": "password", "message": problem}])


# ---------------------------------------------------------------------------- auth (public)


@public.get("/auth/me")
def me(request: Request):
    user = optional_user(request)
    s = store.get_settings()
    return {
        "authenticated": bool(user),
        "user": _user_out(user) if user else None,
        "needs_setup": accounts.count_users() == 0,
        "workspace": s.workspace_name,
        "email_configured": mailer.configured(),
    }


class SetupBody(BaseModel):
    name: str
    email: EmailStr
    password: str


@public.post("/auth/setup")
def setup(body: SetupBody, request: Request, response: Response):
    """Create the first admin. Only works while there are no users."""
    if accounts.count_users() > 0:
        raise HTTPException(409, "Setup is already done. Sign in instead.")
    _check_password(body.password, str(body.email), body.name)
    user = accounts.create_user(NewUser(email=body.email, name=body.name, role="admin"), password=body.password)
    accounts.update_user(user.id, last_login_at=accounts.now())
    start_session(request, response, user)
    audit.record("auth", "Created the first admin account", user=user, **_ctx(request))
    return {"user": _user_out(user)}


class LoginBody(BaseModel):
    email: str
    password: str


_LOGIN_ERRORS = {
    "invalid": (401, "Incorrect email or password."),
    "locked": (423, f"Too many failed attempts. Try again in {accounts.LOCK_MINUTES} minutes or reset your password."),
    "locked_now": (423, f"Too many failed attempts. Try again in {accounts.LOCK_MINUTES} minutes or reset your password."),
    "disabled": (403, "This account is disabled. Contact your admin."),
    "invited": (403, "Finish setting up your account from the invite email first."),
}


@public.post("/auth/login")
def login(body: LoginBody, request: Request, response: Response):
    user, reason = accounts.check_login(body.email, body.password)
    if reason:
        time.sleep(0.4)
        audit.record("auth", f"Sign-in failed ({reason.replace('_', ' ')})", user=user, target=body.email.strip().lower()[:200],
                     **_ctx(request))
        status, msg = _LOGIN_ERRORS[reason]
        raise HTTPException(status, msg)
    start_session(request, response, user)
    audit.record("auth", "Signed in", user=user, **_ctx(request))
    return {"user": _user_out(user)}


@public.post("/auth/logout")
def logout(request: Request, response: Response):
    user = optional_user(request)
    end_session(request, response)
    if user:
        audit.record("auth", "Signed out", user=user, **_ctx(request))
    return {"ok": True}


class ForgotBody(BaseModel):
    email: str


@public.post("/auth/forgot")
async def forgot(body: ForgotBody, request: Request):
    """Always answers the same way, so it can't be used to find out which emails have accounts."""
    email = body.email.strip().lower()
    now = time.time()
    hits = [t for t in _forgot_hits.get(email, []) if now - t < 3600]
    _forgot_hits[email] = hits + [now]
    user = accounts.get_by_email(email)
    if user and user.status == "active" and len(hits) < 3:
        token = accounts.create_password_token(user.id, "reset")
        sent, err = await mailer.send_reset(user.email, user.name, _app_link(f"/reset-password?token={token}"))
        audit.record("auth", "Requested a password reset", user=user, emailed=sent, error=err, **_ctx(request))
    elif user:
        audit.record("auth", "Password reset not sent (account not active or rate limited)", user=user, **_ctx(request))
    return {"ok": True}


@public.get("/auth/token/{token}")
def token_info(token: str):
    found = accounts.check_password_token(token)
    if not found:
        return {"valid": False}
    user, purpose = found
    return {"valid": True, "purpose": purpose, "email": user.email, "name": user.name}


class ResetBody(BaseModel):
    token: str
    password: str


@public.post("/auth/reset")
def reset(body: ResetBody, request: Request, response: Response):
    found = accounts.check_password_token(body.token)
    if not found:
        raise HTTPException(400, "This link is invalid or has expired. Request a new one.")
    user, purpose = found
    _check_password(body.password, user.email, user.name)
    accounts.set_password(user.id, body.password)
    accounts.use_password_token(body.token)
    if purpose == "invite":
        accounts.update_user(user.id, status="active")
    revoked = accounts.revoke_sessions(user.id)
    user = accounts.get_user(user.id)
    accounts.update_user(user.id, last_login_at=accounts.now())
    start_session(request, response, user)
    audit.record("auth", "Accepted invite and set password" if purpose == "invite" else "Reset password",
                 user=user, sessions_signed_out=revoked, **_ctx(request))
    return {"user": _user_out(user)}


# ---------------------------------------------------------------------------- account (signed in)


class ProfileBody(BaseModel):
    name: str = Field(min_length=1, max_length=100)


@account.put("/account")
def update_profile(body: ProfileBody, request: Request):
    user = request.state.user
    updated = accounts.update_user(user.id, name=body.name.strip())
    audit.record("user", "Updated own profile", user=user, **_ctx(request))
    return {"user": _user_out(updated)}


class PasswordBody(BaseModel):
    current_password: str
    new_password: str


@account.post("/account/password")
def change_password(body: PasswordBody, request: Request):
    user: User = request.state.user
    if not accounts.verify_user_password(user.id, body.current_password):
        audit.record("auth", "Password change failed (wrong current password)", user=user, **_ctx(request))
        raise HTTPException(422, [{"field": "current_password", "message": "Current password is incorrect."}])
    if body.current_password == body.new_password:
        raise HTTPException(422, [{"field": "new_password", "message": "Choose a different password."}])
    problem = accounts.password_problem(body.new_password, user.email, user.name)
    if problem:
        raise HTTPException(422, [{"field": "new_password", "message": problem}])
    accounts.set_password(user.id, body.new_password)
    signed_out = accounts.revoke_sessions(user.id, except_id=request.state.session_id)
    audit.record("auth", "Changed password", user=user, other_sessions_signed_out=signed_out, **_ctx(request))
    return {"user": _user_out(accounts.get_user(user.id)), "other_sessions_signed_out": signed_out}


@account.get("/account/sessions")
def my_sessions(request: Request):
    cur = request.state.session_id
    return [{**s.model_dump(mode="json"), "id": s.id[:12], "current": s.id == cur}
            for s in accounts.list_sessions(request.state.user.id)]


@account.delete("/account/sessions/{short_id}")
def revoke_my_session(short_id: str, request: Request):
    user = request.state.user
    for s in accounts.list_sessions(user.id):
        if s.id.startswith(short_id) and len(short_id) >= 8:
            accounts.revoke_session(s.id, user.id)
            audit.record("auth", "Signed out a session", user=user, target=short_id, **_ctx(request))
            return {"ok": True}
    raise HTTPException(404, "session not found")


@account.post("/account/sessions/revoke-others")
def revoke_other_sessions(request: Request):
    user = request.state.user
    n = accounts.revoke_sessions(user.id, except_id=request.state.session_id)
    audit.record("auth", "Signed out all other sessions", user=user, count=n, **_ctx(request))
    return {"signed_out": n}


# ---------------------------------------------------------------------------- audit events from the browser

class ClientEvent(BaseModel):
    type: Literal["click", "page_view"]
    action: str = Field(max_length=200)
    target: str | None = Field(default=None, max_length=300)
    path: str | None = Field(default=None, max_length=300)
    at: datetime | None = None
    meta: dict | None = None


class ClientEvents(BaseModel):
    events: list[ClientEvent] = Field(max_length=100)


@account.post("/audit/events")
def client_events(body: ClientEvents, request: Request):
    user: User = request.state.user
    ip, ua = client_ip(request), request.headers.get("user-agent")
    now = datetime.now(timezone.utc)
    rows = []
    for e in body.events:
        at = e.at if e.at and abs((now - e.at).total_seconds()) < 3600 else now
        rows.append(dict(type=e.type, action=e.action, user_id=user.id, user_email=user.email, target=e.target,
                         path=e.path, ip=ip, user_agent=(ua or "")[:300], at=at,
                         session_id=request.state.session_id[:12], meta=e.meta))
    audit.record_many(rows)
    return {"ok": True, "recorded": len(rows)}


# ---------------------------------------------------------------------------- users (admin)


@admin.get("/users")
def list_users():
    return [_user_out(u) for u in accounts.list_users()]


class CreateUserBody(BaseModel):
    name: str
    email: EmailStr
    role: Literal["admin", "user"] = "user"
    mode: Literal["invite", "password"] = "invite"
    password: str | None = None


@admin.post("/users", status_code=201)
async def create_user(body: CreateUserBody, request: Request):
    actor: User = request.state.user
    try:
        data = NewUser(email=body.email, name=body.name, role=body.role)
    except ValidationError as e:
        raise HTTPException(422, [{"field": ".".join(map(str, x["loc"])), "message": x["msg"]} for x in e.errors()])
    link, emailed, err = None, False, None
    try:
        if body.mode == "password":
            if not body.password:
                raise HTTPException(422, [{"field": "password", "message": "Set a temporary password."}])
            _check_password(body.password, str(body.email), body.name)
            user = accounts.create_user(data, password=body.password, must_change=True, created_by=actor.id)
        else:
            user = accounts.create_user(data, status="invited", created_by=actor.id)
            token = accounts.create_password_token(user.id, "invite")
            link = _app_link(f"/reset-password?token={token}")
            emailed, err = await mailer.send_invite(user.email, user.name, actor.name, link)
    except ValueError as e:
        raise HTTPException(409, str(e))
    audit.record("user", f"Created {body.role} {user.email}" + (" (invited)" if body.mode == "invite" else " (temporary password)"),
                 user=actor, target=user.id, emailed=emailed, email_error=err, **_ctx(request))
    return {"user": _user_out(user), "invite_link": link, "emailed": emailed, "email_error": err}


class UpdateUserBody(BaseModel):
    name: str | None = None
    role: Literal["admin", "user"] | None = None
    status: Literal["active", "disabled"] | None = None


@admin.put("/users/{user_id}")
def update_user(user_id: str, body: UpdateUserBody, request: Request):
    actor: User = request.state.user
    target = accounts.get_user(user_id) or _404()
    changes = {k: v for k, v in body.model_dump().items() if v is not None and getattr(target, k) != v}
    if not changes:
        return {"user": _user_out(target)}
    if user_id == actor.id and ("role" in changes or "status" in changes):
        raise HTTPException(400, "You can't change your own role or disable yourself.")
    if target.role == "admin" and target.status == "active" and (changes.get("role") == "user" or changes.get("status") == "disabled"):
        if accounts.count_active_admins(exclude=user_id) == 0:
            raise HTTPException(400, "There must be at least one active admin.")
    if changes.get("status") == "active" and target.status == "invited":
        raise HTTPException(400, "This user hasn't accepted their invite yet. Resend it instead.")
    user = accounts.update_user(user_id, **changes)
    if changes.get("status") == "disabled":
        accounts.revoke_sessions(user_id)
    audit.record("user", f"Updated user {target.email}", user=actor, target=user_id,
                 changes={k: {"from": getattr(target, k), "to": v} for k, v in changes.items()}, **_ctx(request))
    return {"user": _user_out(user)}


@admin.delete("/users/{user_id}")
def delete_user(user_id: str, request: Request):
    actor: User = request.state.user
    target = accounts.get_user(user_id) or _404()
    if user_id == actor.id:
        raise HTTPException(400, "You can't delete your own account.")
    if target.role == "admin" and target.status == "active" and accounts.count_active_admins(exclude=user_id) == 0:
        raise HTTPException(400, "There must be at least one active admin.")
    accounts.delete_user(user_id)
    audit.record("user", f"Deleted user {target.email}", user=actor, target=user_id, role=target.role, **_ctx(request))
    return {"ok": True}


@admin.post("/users/{user_id}/password-link")
async def password_link(user_id: str, request: Request):
    """A reset link (or a fresh invite link for invited users), emailed if email is set up."""
    actor: User = request.state.user
    target = accounts.get_user(user_id) or _404()
    if target.status == "disabled":
        raise HTTPException(400, "Enable this user first.")
    purpose = "invite" if target.status == "invited" else "reset"
    token = accounts.create_password_token(user_id, purpose)
    link = _app_link(f"/reset-password?token={token}")
    if purpose == "invite":
        emailed, err = await mailer.send_invite(target.email, target.name, actor.name, link)
    else:
        emailed, err = await mailer.send_reset(target.email, target.name, link)
    audit.record("user", f"Created a {'new invite' if purpose == 'invite' else 'password reset'} link for {target.email}",
                 user=actor, target=user_id, emailed=emailed, email_error=err, **_ctx(request))
    return {"link": link, "purpose": purpose, "emailed": emailed, "email_error": err,
            "expires_in_hours": accounts.INVITE_HOURS if purpose == "invite" else accounts.RESET_HOURS}


@admin.post("/users/{user_id}/sign-out")
def sign_out_user(user_id: str, request: Request):
    actor: User = request.state.user
    target = accounts.get_user(user_id) or _404()
    n = accounts.revoke_sessions(user_id, except_id=request.state.session_id if user_id == actor.id else None)
    audit.record("user", f"Signed out {target.email} everywhere", user=actor, target=user_id, sessions=n, **_ctx(request))
    return {"signed_out": n}


@admin.post("/users/{user_id}/unlock")
def unlock_user(user_id: str, request: Request):
    actor: User = request.state.user
    target = accounts.get_user(user_id) or _404()
    accounts.update_user(user_id, failed_attempts=0, locked_until=None)
    audit.record("user", f"Unlocked {target.email}", user=actor, target=user_id, **_ctx(request))
    return {"user": _user_out(accounts.get_user(user_id))}


def _404():
    raise HTTPException(404, "user not found")


# ---------------------------------------------------------------------------- audit logs (admin)


def _range(days: int | None, since: datetime | None, until: datetime | None):
    if days and not since:
        since = datetime.now(timezone.utc) - timedelta(days=days)
    return since, until


@admin.get("/audit")
def audit_search(type: str | None = None, user_id: str | None = None, q: str | None = None, days: int | None = 7,
                 since: datetime | None = None, until: datetime | None = None, before_id: int | None = None,
                 limit: int = 100):
    since, until = _range(days, since, until)
    return audit.search(type=type, user_id=user_id, q=q, since=since, until=until, before_id=before_id,
                        limit=max(1, min(limit, 500)))


@admin.get("/audit/export")
def audit_export(request: Request, type: str | None = None, user_id: str | None = None, q: str | None = None,
                 days: int | None = 7, since: datetime | None = None, until: datetime | None = None):
    since, until = _range(days, since, until)
    audit.record("api", "Exported audit logs", user=request.state.user, filters={"type": type, "q": q, "days": days},
                 **_ctx(request))
    data = audit.export_csv(type, user_id, q, since, until)
    name = f"numen-audit-{datetime.now(timezone.utc):%Y%m%d-%H%M}.csv"
    return RawResponse(data, media_type="text/csv", headers={"Content-Disposition": f'attachment; filename="{name}"'})


class TestEmailBody(BaseModel):
    to: EmailStr


@admin.post("/settings/test-email")
async def test_email(body: TestEmailBody, request: Request):
    ok, err = await mailer.send_test(str(body.to))
    audit.record("api", f"Sent a test email to {body.to}", user=request.state.user, ok=ok, error=err, **_ctx(request))
    return {"ok": ok, "detail": "Sent. Check the inbox." if ok else err}
