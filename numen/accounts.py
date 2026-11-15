"""User accounts: users, sessions, password hashing, and single-use password tokens.

- Passwords: scrypt (stdlib), per-user salt, constant-time verification.
- Sessions: random 32-byte token in an httpOnly cookie; only its SHA-256 is stored.
- Password tokens (reset / invite): random token in a link; only its SHA-256 is stored;
  single use; reset links last 1 hour, invite links 72 hours.
- Lockout: 5 failed sign-ins lock the account for 15 minutes.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from typing import Literal

from pydantic import BaseModel, EmailStr, field_validator
from sqlalchemy import Boolean, Column, DateTime, Integer, String, Table, delete, func, select, update

from .store import engine, meta

Role = Literal["admin", "user"]
SESSION_DAYS = 7
RESET_HOURS = 1
INVITE_HOURS = 72
MAX_FAILED = 5
LOCK_MINUTES = 15
MIN_PASSWORD = 10

users = Table(
    "users", meta,
    Column("id", String, primary_key=True),
    Column("email", String, nullable=False, unique=True),
    Column("name", String, nullable=False, default=""),
    Column("password_hash", String),
    Column("role", String, nullable=False, default="user"),
    Column("status", String, nullable=False, default="active"),  # active | invited | disabled
    Column("must_change_password", Boolean, nullable=False, default=False),
    Column("failed_attempts", Integer, nullable=False, default=0),
    Column("locked_until", DateTime(timezone=True)),
    Column("last_login_at", DateTime(timezone=True)),
    Column("password_changed_at", DateTime(timezone=True)),
    Column("created_at", DateTime(timezone=True), server_default=func.now()),
    Column("created_by", String),
)
sessions = Table(
    "sessions", meta,
    Column("id", String, primary_key=True),  # sha256 of the cookie token
    Column("user_id", String, nullable=False, index=True),
    Column("created_at", DateTime(timezone=True), server_default=func.now()),
    Column("last_seen_at", DateTime(timezone=True), server_default=func.now()),
    Column("expires_at", DateTime(timezone=True), nullable=False),
    Column("ip", String),
    Column("user_agent", String),
)
password_tokens = Table(
    "password_tokens", meta,
    Column("id", String, primary_key=True),  # sha256 of the token in the link
    Column("user_id", String, nullable=False, index=True),
    Column("purpose", String, nullable=False),  # reset | invite
    Column("created_at", DateTime(timezone=True), server_default=func.now()),
    Column("expires_at", DateTime(timezone=True), nullable=False),
    Column("used_at", DateTime(timezone=True)),
)
meta.create_all(engine, tables=[users, sessions, password_tokens])


def now() -> datetime:
    return datetime.now(timezone.utc)


def _sha(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


# ---------------------------------------------------------------------------- passwords


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=2**14, r=8, p=1, dklen=64)
    return f"scrypt$16384$8$1${base64.b64encode(salt).decode()}${base64.b64encode(digest).decode()}"


def verify_password(password: str, stored: str | None) -> bool:
    if not stored or not stored.startswith("scrypt$"):
        # Burn similar time so missing accounts aren't detectable by timing.
        hashlib.scrypt(b"x", salt=b"0" * 16, n=2**14, r=8, p=1, dklen=64)
        return False
    _, n, r, p, salt, digest = stored.split("$")
    test = hashlib.scrypt(password.encode(), salt=base64.b64decode(salt), n=int(n), r=int(r), p=int(p), dklen=64)
    return hmac.compare_digest(test, base64.b64decode(digest))


def password_problem(password: str, email: str = "", name: str = "") -> str | None:
    """Why a new password is unacceptable, or None."""
    if len(password) < MIN_PASSWORD:
        return f"Use at least {MIN_PASSWORD} characters."
    if len(password) > 200:
        return "Use at most 200 characters."
    if password.isdigit() or password.isalpha():
        return "Mix letters with numbers or symbols."
    lowered = password.lower()
    for part in [email.split("@")[0].lower(), name.lower()]:
        if len(part) >= 4 and part in lowered:
            return "Don't include your name or email."
    if lowered in {"password123", "password1234", "qwerty12345", "1234567890a", "letmein12345"}:
        return "That password is too common."
    return None


# ---------------------------------------------------------------------------- users


class User(BaseModel):
    id: str
    email: str
    name: str
    role: Role
    status: str
    must_change_password: bool = False
    last_login_at: datetime | None = None
    created_at: datetime | None = None
    created_by: str | None = None
    locked: bool = False

    @classmethod
    def from_row(cls, r) -> "User":
        m = dict(r._mapping)
        return cls(
            id=m["id"], email=m["email"], name=m["name"], role=m["role"], status=m["status"],
            must_change_password=m["must_change_password"], last_login_at=m["last_login_at"],
            created_at=m["created_at"], created_by=m["created_by"],
            locked=bool(m["locked_until"] and m["locked_until"] > now()),
        )


class NewUser(BaseModel):
    email: EmailStr
    name: str
    role: Role = "user"

    @field_validator("name")
    @classmethod
    def _name(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("Name is required")
        return v[:100]


def count_users() -> int:
    with engine.connect() as c:
        return c.execute(select(func.count()).select_from(users)).scalar_one()


def count_active_admins(exclude: str | None = None) -> int:
    q = select(func.count()).select_from(users).where(users.c.role == "admin", users.c.status == "active")
    if exclude:
        q = q.where(users.c.id != exclude)
    with engine.connect() as c:
        return c.execute(q).scalar_one()


def list_users() -> list[User]:
    with engine.connect() as c:
        return [User.from_row(r) for r in c.execute(select(users).order_by(users.c.created_at))]


def get_user(user_id: str) -> User | None:
    with engine.connect() as c:
        r = c.execute(select(users).where(users.c.id == user_id)).first()
    return User.from_row(r) if r else None


def _row_by_email(email: str):
    with engine.connect() as c:
        return c.execute(select(users).where(users.c.email == email.strip().lower())).first()


def get_by_email(email: str) -> User | None:
    r = _row_by_email(email)
    return User.from_row(r) if r else None


def create_user(data: NewUser, *, password: str | None = None, status: str = "active",
                must_change: bool = False, created_by: str | None = None) -> User:
    if _row_by_email(str(data.email)):
        raise ValueError("A user with that email already exists.")
    uid = f"usr_{uuid.uuid4().hex[:12]}"
    with engine.begin() as c:
        c.execute(users.insert().values(
            id=uid, email=str(data.email).lower(), name=data.name, role=data.role, status=status,
            password_hash=hash_password(password) if password else None, must_change_password=must_change,
            password_changed_at=now() if password else None, created_by=created_by,
        ))
    return get_user(uid)


def update_user(user_id: str, **values) -> User | None:
    with engine.begin() as c:
        c.execute(update(users).where(users.c.id == user_id).values(**values))
    return get_user(user_id)


def set_password(user_id: str, password: str, *, must_change: bool = False) -> None:
    update_user(user_id, password_hash=hash_password(password), must_change_password=must_change,
                password_changed_at=now(), failed_attempts=0, locked_until=None)


def delete_user(user_id: str) -> None:
    with engine.begin() as c:
        c.execute(delete(sessions).where(sessions.c.user_id == user_id))
        c.execute(delete(password_tokens).where(password_tokens.c.user_id == user_id))
        c.execute(delete(users).where(users.c.id == user_id))


def verify_user_password(user_id: str, password: str) -> bool:
    with engine.connect() as c:
        row = c.execute(select(users.c.password_hash).where(users.c.id == user_id)).first()
    return bool(row) and verify_password(password, row.password_hash)


def check_login(email: str, password: str) -> tuple[User | None, str | None]:
    """(user, None) on success, else (user-or-None, reason). Applies lockout."""
    r = _row_by_email(email)
    if r is None:
        verify_password(password, None)
        return None, "invalid"
    m = r._mapping
    if m["locked_until"] and m["locked_until"] > now():
        return User.from_row(r), "locked"
    if not verify_password(password, m["password_hash"]):
        failed = m["failed_attempts"] + 1
        lock = now() + timedelta(minutes=LOCK_MINUTES) if failed >= MAX_FAILED else None
        update_user(m["id"], failed_attempts=0 if lock else failed, locked_until=lock)
        return User.from_row(r), "locked_now" if lock else "invalid"
    if m["status"] == "disabled":
        return User.from_row(r), "disabled"
    if m["status"] == "invited":
        return User.from_row(r), "invited"
    update_user(m["id"], failed_attempts=0, locked_until=None, last_login_at=now())
    return get_user(m["id"]), None


# ---------------------------------------------------------------------------- sessions


class Session(BaseModel):
    id: str
    user_id: str
    created_at: datetime
    last_seen_at: datetime
    expires_at: datetime
    ip: str | None
    user_agent: str | None


def create_session(user_id: str, ip: str | None, user_agent: str | None) -> str:
    token = secrets.token_urlsafe(32)
    with engine.begin() as c:
        c.execute(sessions.insert().values(id=_sha(token), user_id=user_id, ip=ip, user_agent=(user_agent or "")[:300],
                                           expires_at=now() + timedelta(days=SESSION_DAYS)))
    return token


def session_user(token: str | None) -> tuple[User, str] | None:
    """(user, session id) for a valid cookie token, refreshing last-seen."""
    if not token:
        return None
    sid = _sha(token)
    with engine.connect() as c:
        s = c.execute(select(sessions).where(sessions.c.id == sid)).first()
    if not s or s.expires_at <= now():
        return None
    user = get_user(s.user_id)
    if not user or user.status != "active":
        return None
    if (now() - s.last_seen_at).total_seconds() > 60:
        with engine.begin() as c:
            c.execute(update(sessions).where(sessions.c.id == sid).values(last_seen_at=now()))
    return user, sid


def list_sessions(user_id: str) -> list[Session]:
    with engine.connect() as c:
        rows = c.execute(select(sessions).where(sessions.c.user_id == user_id, sessions.c.expires_at > now())
                         .order_by(sessions.c.last_seen_at.desc())).all()
    return [Session(**dict(r._mapping)) for r in rows]


def revoke_session(session_id: str, user_id: str | None = None) -> None:
    q = delete(sessions).where(sessions.c.id == session_id)
    if user_id:
        q = q.where(sessions.c.user_id == user_id)
    with engine.begin() as c:
        c.execute(q)


def revoke_sessions(user_id: str, except_id: str | None = None) -> int:
    q = delete(sessions).where(sessions.c.user_id == user_id)
    if except_id:
        q = q.where(sessions.c.id != except_id)
    with engine.begin() as c:
        return c.execute(q).rowcount


# ---------------------------------------------------------------------------- password tokens


def create_password_token(user_id: str, purpose: Literal["reset", "invite"]) -> str:
    """Invalidates earlier unused tokens of the same purpose, returns the new raw token."""
    token = secrets.token_urlsafe(32)
    hours = INVITE_HOURS if purpose == "invite" else RESET_HOURS
    with engine.begin() as c:
        c.execute(update(password_tokens).where(
            password_tokens.c.user_id == user_id, password_tokens.c.purpose == purpose,
            password_tokens.c.used_at.is_(None)).values(used_at=now()))
        c.execute(password_tokens.insert().values(id=_sha(token), user_id=user_id, purpose=purpose,
                                                  expires_at=now() + timedelta(hours=hours)))
    return token


def check_password_token(token: str) -> tuple[User, str] | None:
    """(user, purpose) if the token is valid and unused."""
    with engine.connect() as c:
        t = c.execute(select(password_tokens).where(password_tokens.c.id == _sha(token))).first()
    if not t or t.used_at or t.expires_at <= now():
        return None
    user = get_user(t.user_id)
    if not user or user.status == "disabled":
        return None
    return user, t.purpose


def use_password_token(token: str) -> None:
    with engine.begin() as c:
        c.execute(update(password_tokens).where(password_tokens.c.id == _sha(token)).values(used_at=now()))


def cleanup() -> None:
    with engine.begin() as c:
        c.execute(delete(sessions).where(sessions.c.expires_at <= now()))
        c.execute(delete(password_tokens).where(password_tokens.c.expires_at <= now() - timedelta(days=7)))

