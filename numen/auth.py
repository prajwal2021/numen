"""Request authentication and authorization.

- Every /api route except /api/auth/* needs a signed-in, active user (session cookie).
- Admin-only routes use `require_admin`.
- Users flagged must_change_password can only reach /api/auth/* and /api/account/*.
- Changing requests (POST/PUT/PATCH/DELETE) must come from this app's own origin.
"""

from __future__ import annotations

import ipaddress
from urllib.parse import urlparse

from fastapi import HTTPException, Request, Response

from . import accounts
from .accounts import User

COOKIE = "numen_session"
_ALLOWED_DURING_PASSWORD_CHANGE = ("/api/auth/", "/api/account", "/api/audit/events")


def client_ip(request: Request) -> str | None:
    """The caller's IP. X-Forwarded-For is trusted only from loopback (the local Next.js proxy, ngrok agent)."""
    peer = request.client.host if request.client else None
    try:
        local = peer is not None and ipaddress.ip_address(peer).is_loopback
    except ValueError:
        local = False
    fwd = request.headers.get("x-forwarded-for")
    if local and fwd:
        return fwd.split(",")[0].strip()
    return peer


def _check_origin(request: Request) -> None:
    if request.method in ("GET", "HEAD", "OPTIONS"):
        return
    origin = request.headers.get("origin")
    if not origin:
        return  # non-browser clients (curl, scripts) don't send Origin
    host = request.headers.get("x-forwarded-host") or request.headers.get("host") or ""
    if urlparse(origin).netloc != host:
        raise HTTPException(403, "cross-site request blocked")


def current_user(request: Request) -> User:
    _check_origin(request)
    found = accounts.session_user(request.cookies.get(COOKIE))
    if not found:
        raise HTTPException(401, "Sign in required")
    user, sid = found
    request.state.user = user
    request.state.session_id = sid
    if user.must_change_password and not request.url.path.startswith(_ALLOWED_DURING_PASSWORD_CHANGE):
        raise HTTPException(403, "password_change_required")
    return user


def require_admin(request: Request) -> User:
    user = current_user(request)
    if user.role != "admin":
        raise HTTPException(403, "Admins only")
    return user


def optional_user(request: Request) -> User | None:
    found = accounts.session_user(request.cookies.get(COOKIE))
    if found:
        request.state.user, request.state.session_id = found
        return found[0]
    return None


def start_session(request: Request, response: Response, user: User) -> None:
    token = accounts.create_session(user.id, client_ip(request), request.headers.get("user-agent"))
    secure = request.headers.get("x-forwarded-proto", request.url.scheme) == "https"
    response.set_cookie(COOKIE, token, max_age=accounts.SESSION_DAYS * 86400, httponly=True,
                        samesite="lax", secure=secure, path="/")


def end_session(request: Request, response: Response) -> None:
    found = accounts.session_user(request.cookies.get(COOKIE))
    if found:
        accounts.revoke_session(found[1])
    response.delete_cookie(COOKIE, path="/")
