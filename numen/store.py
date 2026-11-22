"""Persistence on PostgreSQL (DATABASE_URL, default postgresql+psycopg://localhost/numen).

- agents, knowledge_bases, phone_numbers: one JSONB document per item (the pydantic model).
- settings: a single JSONB document.
- calls: one row per call with filterable columns plus the full call record (JSONB).
Tables are created on first use.
"""

from __future__ import annotations

import os
from typing import TypeVar

from pydantic import BaseModel
from sqlalchemy import (
    Column, DateTime, Float, ForeignKey, Integer, LargeBinary, MetaData, String, Table, Text, create_engine,
    delete as sa_delete, func, insert, select, text,
)
from sqlalchemy.dialects.postgresql import JSONB, insert as pg_insert

from .models import Agent, KnowledgeBase, PhoneNumber, Settings, utcnow

DATABASE_URL = os.getenv("DATABASE_URL", "postgresql+psycopg://localhost/numen")
# Every live call saves its log every few seconds from a worker thread, alongside the admin
# API: size the pool so those never queue behind each other (Postgres allows 100).
engine = create_engine(DATABASE_URL, pool_pre_ping=True, pool_size=10, max_overflow=20)
meta = MetaData()


def _doc_table(name: str) -> Table:
    return Table(
        name, meta,
        Column("id", String, primary_key=True),
        Column("data", JSONB, nullable=False),
        Column("created_at", DateTime(timezone=True), server_default=func.now()),
        Column("updated_at", DateTime(timezone=True), server_default=func.now(), onupdate=func.now()),
    )


agents = _doc_table("agents")
knowledge_bases = _doc_table("knowledge_bases")
phone_numbers = _doc_table("phone_numbers")
settings_t = Table("settings", meta, Column("id", Integer, primary_key=True), Column("data", JSONB, nullable=False))
calls = Table(
    "calls", meta,
    Column("call_sid", String, primary_key=True),
    Column("agent_id", String, index=True),
    Column("agent_name", String),
    Column("from_number", String),
    Column("to_number", String),
    Column("started_at", DateTime(timezone=True), index=True),
    Column("ended_at", DateTime(timezone=True)),
    Column("duration_s", Float),
    Column("end_reason", String),
    Column("summary", JSONB),
    Column("record", JSONB),
)
# Documents uploaded to a "documents" knowledge base, and their searchable passages.
kb_documents = Table(
    "kb_documents", meta,
    Column("id", String, primary_key=True),
    Column("kb_id", String, index=True, nullable=False),
    Column("name", String, nullable=False),
    Column("kind", String, nullable=False),  # pdf | docx | txt | md | html | text
    Column("size_bytes", Integer),
    Column("chars", Integer),
    Column("chunks", Integer, server_default="0"),
    Column("status", String, nullable=False),  # processing | ready | failed
    Column("error", String),
    Column("text", Text),
    Column("created_by", String),
    Column("created_at", DateTime(timezone=True), server_default=func.now()),
    Column("updated_at", DateTime(timezone=True), server_default=func.now(), onupdate=func.now()),
)
kb_chunks = Table(
    "kb_chunks", meta,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("kb_id", String, index=True, nullable=False),
    Column("doc_id", String, ForeignKey("kb_documents.id", ondelete="CASCADE"), index=True, nullable=False),
    Column("ord", Integer, nullable=False),
    Column("text", Text, nullable=False),
    Column("embedding", LargeBinary, nullable=False),  # float32, normalised
)
_TABLES = {Agent: agents, KnowledgeBase: knowledge_bases, PhoneNumber: phone_numbers}
meta.create_all(engine)

T = TypeVar("T", bound=BaseModel)


# ---------------------------------------------------------------------------- documents


def list_all(model: type[T]) -> list[T]:
    t = _TABLES[model]
    with engine.connect() as c:
        rows = c.execute(select(t.c.data).order_by(t.c.created_at)).all()
    return [model.model_validate(r.data) for r in rows]


def get(model: type[T], id: str) -> T | None:
    t = _TABLES[model]
    with engine.connect() as c:
        row = c.execute(select(t.c.data).where(t.c.id == id)).first()
    return model.model_validate(row.data) if row else None


def save(item: BaseModel) -> None:
    if hasattr(item, "updated_at"):
        item.updated_at = utcnow()
    t = _TABLES[type(item)]
    data = item.model_dump(mode="json")
    stmt = pg_insert(t).values(id=item.id, data=data)
    stmt = stmt.on_conflict_do_update(index_elements=[t.c.id], set_={"data": data, "updated_at": func.now()})
    with engine.begin() as c:
        c.execute(stmt)


def delete(model: type[BaseModel], id: str) -> bool:
    t = _TABLES[model]
    with engine.begin() as c:
        return c.execute(sa_delete(t).where(t.c.id == id)).rowcount > 0


def number_for(e164: str | None) -> PhoneNumber | None:
    if not e164:
        return None
    with engine.connect() as c:
        row = c.execute(select(phone_numbers.c.data).where(phone_numbers.c.data["number"].astext == e164)).first()
    return PhoneNumber.model_validate(row.data) if row else None


# ---------------------------------------------------------------------------- settings

_ENV = {
    "twilio_account_sid": "TWILIO_ACCOUNT_SID",
    "twilio_auth_token": "TWILIO_AUTH_TOKEN",
    "elevenlabs_api_key": "ELEVENLABS_API_KEY",
    "openai_api_key": "OPENAI_API_KEY",
    "public_base_url": "PUBLIC_BASE_URL",
    "app_base_url": "APP_BASE_URL",
}


def get_stored_settings() -> Settings:
    with engine.connect() as c:
        row = c.execute(select(settings_t.c.data).where(settings_t.c.id == 1)).first()
    return Settings.model_validate(row.data) if row else Settings()


def get_settings() -> Settings:
    """Stored settings; a field left empty falls back to the matching .env variable."""
    s = get_stored_settings()
    for field, var in _ENV.items():
        if not getattr(s, field):
            setattr(s, field, os.getenv(var, ""))
    return s


def settings_source(field: str) -> str:
    """'workspace' if set in the app, 'env' if only in .env, '' if unset."""
    if getattr(get_stored_settings(), field):
        return "workspace"
    return "env" if field in _ENV and os.getenv(_ENV[field]) else ""


def save_settings(s: Settings) -> None:
    data = s.model_dump(mode="json")
    stmt = pg_insert(settings_t).values(id=1, data=data)
    stmt = stmt.on_conflict_do_update(index_elements=[settings_t.c.id], set_={"data": data})
    with engine.begin() as c:
        c.execute(stmt)


# ---------------------------------------------------------------------------- calls


def save_call(record: dict) -> None:
    call, agent = record["call"], record.get("agent") or {}
    values = dict(
        call_sid=call["call_sid"], agent_id=agent.get("id"), agent_name=agent.get("name"),
        from_number=call.get("from"), to_number=call.get("to"), started_at=call.get("started_at"),
        ended_at=call.get("ended_at"), duration_s=call.get("duration_s"), end_reason=call.get("end_reason"),
        summary=record.get("summary") or {}, record=record,
    )
    stmt = pg_insert(calls).values(**values)
    stmt = stmt.on_conflict_do_update(index_elements=[calls.c.call_sid], set_={k: v for k, v in values.items() if k != "call_sid"})
    with engine.begin() as c:
        c.execute(stmt)


def note_transfer_outcome(call_sid: str, status: str, duration_s: float | None, answered: bool) -> bool:
    """Record how a transfer's <Dial> ended (Twilio reports it after the agent has left the
    call). An unanswered transfer replaces the end reason. False if the call isn't logged."""
    with engine.begin() as c:
        row = c.execute(select(calls.c.record).where(calls.c.call_sid == call_sid)).first()
        if row is None:
            return False
        record = dict(row.record)
        record["transfer_outcome"] = {"at": utcnow(), "dial_status": status, "answered": answered,
                                      "dial_duration_s": duration_s}
        values = {"record": record}
        if not answered:
            reason = f"transfer not answered ({status})"
            record["call"] = {**record.get("call", {}), "end_reason": reason}
            values["end_reason"] = reason
        c.execute(calls.update().where(calls.c.call_sid == call_sid).values(**values))
    return True


def _call_row(r) -> dict:
    d = dict(r._mapping)
    d.pop("record", None)
    for k in ("started_at", "ended_at"):
        if d.get(k):
            d[k] = d[k].isoformat()
    return d


def list_calls(agent_id: str | None = None, limit: int = 200, q: str | None = None) -> list[dict]:
    cols = [c for c in calls.c if c.name != "record"]
    stmt = select(*cols).order_by(calls.c.started_at.desc()).limit(limit)
    if agent_id:
        stmt = stmt.where(calls.c.agent_id == agent_id)
    if q:
        like = f"%{q}%"
        stmt = stmt.where(calls.c.from_number.ilike(like) | calls.c.call_sid.ilike(like) | calls.c.to_number.ilike(like))
    with engine.connect() as c:
        return [_call_row(r) for r in c.execute(stmt).all()]


def get_call(call_sid: str) -> dict | None:
    with engine.connect() as c:
        row = c.execute(select(calls.c.record).where(calls.c.call_sid == call_sid)).first()
    return row.record if row else None


def call_stats(days: int = 30) -> dict:
    """Aggregates for the dashboard over the last `days` days."""
    with engine.connect() as c:
        row = c.execute(text(
            """
            SELECT count(*) AS calls,
                   coalesce(avg(duration_s), 0) AS avg_duration_s,
                   coalesce(sum((summary->>'kb_lookups')::int), 0) AS kb_lookups,
                   coalesce(sum((summary->>'kb_hits')::int), 0) AS kb_hits,
                   coalesce(sum((summary->>'transfers')::int), 0) AS transfers,
                   avg(nullif(summary->>'kb_avg_latency_ms', '')::float) AS kb_avg_latency_ms
            FROM calls WHERE started_at > now() - make_interval(days => :days)
            """), {"days": days}).first()
        daily = c.execute(text(
            """
            SELECT to_char(date_trunc('day', started_at), 'YYYY-MM-DD') AS day, count(*) AS calls
            FROM calls WHERE started_at > now() - make_interval(days => :days)
            GROUP BY 1 ORDER BY 1
            """), {"days": days}).all()
    return {**dict(row._mapping), "daily": [dict(r._mapping) for r in daily]}


# ---------------------------------------------------------------------------- analytics

_FILTER = "started_at >= :since AND started_at < :until AND (CAST(:agent AS text) IS NULL OR agent_id = :agent)"


def _kpis(c, since, until, agent) -> dict:
    p = {"since": since, "until": until, "agent": agent}
    row = c.execute(text(f"""
        SELECT count(*) AS calls,
               count(DISTINCT from_number) AS unique_callers,
               coalesce(avg(duration_s), 0) AS avg_duration_s,
               coalesce(sum(duration_s), 0) AS talk_time_s,
               coalesce(sum((summary->>'kb_lookups')::int), 0) AS kb_lookups,
               coalesce(sum((summary->>'kb_hits')::int), 0) AS kb_hits,
               coalesce(sum((summary->>'kb_misses')::int), 0) AS kb_misses,
               coalesce(sum((summary->>'kb_failures')::int), 0) AS kb_failures,
               count(*) FILTER (WHERE end_reason LIKE 'transferred%%') AS transferred_calls,
               count(*) FILTER (WHERE end_reason IN ('caller hung up', 'agent ended the call')) AS completed_calls,
               coalesce(sum((summary->>'errors')::int), 0) AS errors
        FROM calls WHERE {_FILTER}"""), p).first()
    lat = c.execute(text(f"""
        SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY (l->>'latency_ms')::float) AS p50,
               percentile_cont(0.95) WITHIN GROUP (ORDER BY (l->>'latency_ms')::float) AS p95
        FROM calls, jsonb_array_elements(record->'kb_lookups') l
        WHERE {_FILTER} AND l->>'latency_ms' IS NOT NULL"""), p).first()
    return {**dict(row._mapping), "kb_latency_p50_ms": lat.p50, "kb_latency_p95_ms": lat.p95}


def analytics(days: int, agent_id: str | None, tz: str) -> dict:
    """Everything the Home dashboard shows, for the last `days` days (and the period before)."""
    from datetime import datetime, timedelta, timezone

    until = datetime.now(timezone.utc)
    since = until - timedelta(days=days)
    p = {"since": since, "until": until, "agent": agent_id, "tz": tz}
    with engine.connect() as c:
        current = _kpis(c, since, until, agent_id)
        previous = _kpis(c, since - timedelta(days=days), since, agent_id)
        daily = c.execute(text(f"""
            SELECT to_char(date_trunc('day', started_at AT TIME ZONE :tz), 'YYYY-MM-DD') AS day,
                   count(*) AS calls,
                   coalesce(avg(duration_s), 0) AS avg_duration_s,
                   coalesce(sum((summary->>'kb_lookups')::int), 0) AS kb_lookups,
                   coalesce(sum((summary->>'kb_hits')::int), 0) AS kb_hits,
                   count(*) FILTER (WHERE end_reason LIKE 'transferred%%') AS transfers
            FROM calls WHERE {_FILTER} GROUP BY 1 ORDER BY 1"""), p).all()
        latency_daily = c.execute(text(f"""
            SELECT to_char(date_trunc('day', started_at AT TIME ZONE :tz), 'YYYY-MM-DD') AS day,
                   percentile_cont(0.5) WITHIN GROUP (ORDER BY (l->>'latency_ms')::float) AS p50,
                   percentile_cont(0.95) WITHIN GROUP (ORDER BY (l->>'latency_ms')::float) AS p95
            FROM calls, jsonb_array_elements(record->'kb_lookups') l
            WHERE {_FILTER} AND l->>'latency_ms' IS NOT NULL GROUP BY 1 ORDER BY 1"""), p).all()
        hourly = c.execute(text(f"""
            SELECT extract(hour FROM started_at AT TIME ZONE :tz)::int AS hour, count(*) AS calls
            FROM calls WHERE {_FILTER} GROUP BY 1 ORDER BY 1"""), p).all()
        outcomes = c.execute(text(f"""
            SELECT CASE
                     WHEN end_reason IN ('caller hung up', 'agent ended the call') THEN 'completed'
                     WHEN end_reason LIKE 'transferred (called outside%%' THEN 'after_hours_transfer'
                     WHEN end_reason LIKE 'transferred%%' THEN 'transferred'
                     WHEN end_reason = 'no agent assigned' THEN 'no_agent'
                     WHEN end_reason IS NULL THEN 'in_progress'
                     ELSE 'other' END AS outcome,
                   count(*) AS calls
            FROM calls WHERE {_FILTER} GROUP BY 1 ORDER BY 2 DESC"""), p).all()
        kb_results = c.execute(text(f"""
            SELECT l->>'result' AS result, count(*) AS lookups
            FROM calls, jsonb_array_elements(record->'kb_lookups') l
            WHERE {_FILTER} GROUP BY 1 ORDER BY 2 DESC"""), p).all()
        questions = c.execute(text(f"""
            SELECT lower(trim(both ' ?.!' FROM l->>'question')) AS key,
                   max(trim(l->>'question')) AS question,
                   count(*) AS asked,
                   count(*) FILTER (WHERE (l->>'found')::boolean) AS answered,
                   max(started_at) AS last_asked
            FROM calls, jsonb_array_elements(record->'kb_lookups') l
            WHERE {_FILTER} GROUP BY 1 ORDER BY 2 DESC, 4 DESC LIMIT 200"""), p).all()
        agents = c.execute(text(f"""
            SELECT agent_id, max(agent_name) AS agent_name, count(*) AS calls,
                   coalesce(avg(duration_s), 0) AS avg_duration_s,
                   coalesce(sum((summary->>'kb_lookups')::int), 0) AS kb_lookups,
                   coalesce(sum((summary->>'kb_hits')::int), 0) AS kb_hits,
                   count(*) FILTER (WHERE end_reason LIKE 'transferred%%') AS transfers,
                   max(started_at) AS last_call
            FROM calls WHERE {_FILTER} GROUP BY agent_id ORDER BY 3 DESC"""), p).all()
        recent = list_calls(agent_id=agent_id, limit=8)

    def rows(rs):
        out = []
        for r in rs:
            d = dict(r._mapping)
            for k, v in d.items():
                if hasattr(v, "isoformat"):
                    d[k] = v.isoformat()
            out.append(d)
        return out

    qs = rows(questions)
    return {
        "range": {"days": days, "since": since.isoformat(), "until": until.isoformat(), "tz": tz},
        "kpis": current,
        "previous": previous,
        "daily": rows(daily),
        "latency_daily": rows(latency_daily),
        "hourly": rows(hourly),
        "outcomes": rows(outcomes),
        "kb_results": rows(kb_results),
        "top_questions": qs[:10],
        "unanswered_questions": sorted(
            ({**q, "unanswered": q["asked"] - q["answered"]} for q in qs if q["answered"] < q["asked"]),
            key=lambda q: (-q["unanswered"], q["last_asked"] or ""),
        )[:10],
        "agents": rows(agents),
        "recent_calls": recent,
    }
