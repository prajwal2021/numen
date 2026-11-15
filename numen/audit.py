"""Audit log: who did what, when, from where. Shown in the admin Audit logs panel.

Types:
  click      a click in the web app (element label, page)        - sent by the browser
  page_view  a page opened in the web app                        - sent by the browser
  api        a change made through the API (POST/PUT/DELETE)     - request middleware
  auth       sign-in, sign-out, failures, password resets         - auth endpoints
  user       user management (create, role, disable, delete)      - admin endpoints
  call       a phone call finished                                - call pipeline
  system     server start, cleanup                                 - server
  error      a failed request (5xx) or an error during a call     - middleware / pipeline
Never contains passwords, keys, or what users type into fields.
"""

from __future__ import annotations

import csv
import io
import json
from datetime import datetime, timedelta, timezone

from loguru import logger
from sqlalchemy import BigInteger, Column, DateTime, Integer, String, Table, delete, func, insert, or_, select
from sqlalchemy.dialects.postgresql import JSONB

from .store import engine, meta

RETENTION_DAYS = 90
TYPES = ["click", "page_view", "api", "auth", "user", "call", "system", "error"]

audit_logs = Table(
    "audit_logs", meta,
    Column("id", BigInteger, primary_key=True, autoincrement=True),
    Column("at", DateTime(timezone=True), server_default=func.now(), index=True),
    Column("type", String, nullable=False, index=True),
    Column("action", String, nullable=False),
    Column("user_id", String, index=True),
    Column("user_email", String),
    Column("target", String),
    Column("method", String),
    Column("path", String),
    Column("status", Integer),
    Column("duration_ms", Integer),
    Column("ip", String),
    Column("user_agent", String),
    Column("session_id", String),
    Column("meta", JSONB),
)
meta.create_all(engine, tables=[audit_logs])


def _clip(v, n=500):
    return v[:n] if isinstance(v, str) else v


def record(type: str, action: str, *, user=None, target: str | None = None, method: str | None = None,
           path: str | None = None, status: int | None = None, duration_ms: int | None = None,
           ip: str | None = None, user_agent: str | None = None, session_id: str | None = None,
           at: datetime | None = None, **meta_fields) -> None:
    """Write one entry. Never raises (auditing must not break the app)."""
    try:
        row = dict(
            type=type, action=_clip(action, 200), user_id=getattr(user, "id", None),
            user_email=getattr(user, "email", None), target=_clip(target, 300), method=method,
            path=_clip(path, 300), status=status, duration_ms=duration_ms, ip=ip,
            user_agent=_clip(user_agent, 300), session_id=(session_id or "")[:12] or None,
            meta=json.loads(json.dumps(meta_fields, default=str)) if meta_fields else None,
        )
        if at:
            row["at"] = at
        with engine.begin() as c:
            c.execute(insert(audit_logs).values(**row))
    except Exception:
        logger.exception("Writing audit log failed")


def record_many(rows: list[dict]) -> None:
    if not rows:
        return
    try:
        with engine.begin() as c:
            c.execute(insert(audit_logs), rows)
    except Exception:
        logger.exception("Writing audit log batch failed")


def _query(type: str | None, user_id: str | None, q: str | None, since: datetime | None, until: datetime | None):
    stmt = select(audit_logs)
    if type:
        stmt = stmt.where(audit_logs.c.type.in_(type.split(",")))
    if user_id:
        stmt = stmt.where(audit_logs.c.user_id == user_id)
    if since:
        stmt = stmt.where(audit_logs.c.at >= since)
    if until:
        stmt = stmt.where(audit_logs.c.at < until)
    if q:
        like = f"%{q}%"
        stmt = stmt.where(or_(audit_logs.c.action.ilike(like), audit_logs.c.target.ilike(like),
                              audit_logs.c.path.ilike(like), audit_logs.c.user_email.ilike(like),
                              audit_logs.c.ip.ilike(like)))
    return stmt


def _row(r) -> dict:
    d = dict(r._mapping)
    d["at"] = d["at"].isoformat() if d["at"] else None
    return d


def search(type: str | None = None, user_id: str | None = None, q: str | None = None,
           since: datetime | None = None, until: datetime | None = None,
           before_id: int | None = None, limit: int = 100) -> dict:
    stmt = _query(type, user_id, q, since, until)
    if before_id:
        stmt = stmt.where(audit_logs.c.id < before_id)
    base = _query(None, user_id, q, since, until).subquery()
    with engine.connect() as c:
        rows = c.execute(stmt.order_by(audit_logs.c.id.desc()).limit(limit + 1)).all()
        counts = c.execute(select(base.c.type, func.count()).group_by(base.c.type)).all()
    items = [_row(r) for r in rows[:limit]]
    return {"items": items, "has_more": len(rows) > limit, "next_before_id": items[-1]["id"] if items else None,
            "counts": {t: n for t, n in counts}}


def export_csv(type: str | None, user_id: str | None, q: str | None, since: datetime | None, until: datetime | None) -> str:
    out = io.StringIO()
    w = csv.writer(out)
    cols = ["id", "at", "type", "action", "user_email", "target", "method", "path", "status", "duration_ms", "ip", "meta"]
    w.writerow(cols)
    with engine.connect() as c:
        for r in c.execute(_query(type, user_id, q, since, until).order_by(audit_logs.c.id.desc()).limit(50_000)):
            d = _row(r)
            w.writerow([json.dumps(d[k]) if k == "meta" and d[k] is not None else d[k] for k in cols])
    return out.getvalue()


def cleanup() -> int:
    with engine.begin() as c:
        return c.execute(delete(audit_logs).where(audit_logs.c.at < datetime.now(timezone.utc) - timedelta(days=RETENTION_DAYS))).rowcount
