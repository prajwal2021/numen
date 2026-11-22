"""Per-call logging.

Every call is saved to the `calls` table in Postgres (summary columns + the full record as
JSONB, read by the Conversations pages) and also writes two files under
LOG_DIR/calls/<YYYY-MM-DD>/ (Central time):

  <HHMMSS>_<CallSid>.json  structured record: call details, the configuration snapshot
                           used (RAG/KB, LLM, voice, routing), a timeline of everything
                           said and done, every knowledge-base lookup (question, answer,
                           found, latency, status), transfers, errors, and a summary.
  <HHMMSS>_<CallSid>.log   the full debug log for that call only (every Pipecat line).

The JSON is rewritten shortly after each event (batched, at most every FLUSH_SECONDS, off the
event loop), so a crash or kill still leaves a usable record, and N live calls don't each
block the loop on a file write and a database upsert for every event.
Question and answer text is logged on purpose (the operator chose this over the KB
service guide's "don't log questions or answers").
"""

import asyncio
import json
import os
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from loguru import logger

from . import audit, store

FLUSH_SECONDS = 0.5
CENTRAL = ZoneInfo("America/Chicago")
LOG_DIR = Path(os.getenv("LOG_DIR", Path(__file__).resolve().parent.parent / "logs"))


def _now() -> datetime:
    return datetime.now(CENTRAL)


class CallLog:
    def __init__(self, call_sid: str, stream_sid: str | None, from_number: str | None, to_number: str | None):
        self.call_sid = call_sid
        self._db_lock = threading.Lock()
        self._flush_scheduled = False
        self._seq = 0  # snapshot counter; a late-running older snapshot never overwrites a newer one
        self._written_seq = 0
        self._t0 = time.monotonic()
        started = _now()
        folder = LOG_DIR / "calls" / started.strftime("%Y-%m-%d")
        folder.mkdir(parents=True, exist_ok=True)
        stem = f"{started:%H%M%S}_{call_sid}"
        self.json_path = folder / f"{stem}.json"
        self.debug_path = folder / f"{stem}.log"
        self._sink_id = logger.add(
            self.debug_path,
            level="DEBUG",
            filter=lambda r: r["extra"].get("call_sid") == call_sid,
            enqueue=True,
        )
        self.record: dict[str, Any] = {
            "call": {
                "call_sid": call_sid,
                "stream_sid": stream_sid,
                "from": from_number,
                "to": to_number,
                "started_at": started.isoformat(),
                "ended_at": None,
                "duration_s": None,
                "end_reason": None,
                "debug_log": str(self.debug_path),
            },
            "agent": None,
            "config": {},
            "timeline": [],
            "kb_lookups": [],
            "transfers": [],
            "errors": [],
            "summary": {},
        }
        self.end_reason: str | None = None
        self._write()

    # ---- recording ----------------------------------------------------------------

    def _stamp(self) -> dict[str, Any]:
        return {"t": round(time.monotonic() - self._t0, 2), "at": _now().isoformat(timespec="milliseconds")}

    def set_agent(self, agent_id: str | None, agent_name: str | None) -> None:
        self.record["agent"] = {"id": agent_id, "name": agent_name}
        self._write()

    def set_config(self, config: dict[str, Any]) -> None:
        self.record["config"] = config
        self._write()

    def event(self, kind: str, **data: Any) -> None:
        entry = {**self._stamp(), "type": kind, **data}
        self.record["timeline"].append(entry)
        logger.info(f"[call] {kind}: {json.dumps(data, ensure_ascii=False, default=str)[:500]}")
        self._write()

    def kb_lookup(self, **data: Any) -> None:
        entry = {"n": len(self.record["kb_lookups"]) + 1, **self._stamp(), **data}
        self.record["kb_lookups"].append(entry)
        self.event("kb_lookup", **{k: v for k, v in entry.items() if k not in ("t", "at")})

    def transfer(self, **data: Any) -> None:
        self.record["transfers"].append({**self._stamp(), **data})
        self.event("transfer", **data)

    def error(self, message: str, **data: Any) -> None:
        self.record["errors"].append({**self._stamp(), "message": message, **data})
        self.event("error", message=message, **data)
        audit.record("error", f"Call error: {message}", target=self.call_sid, **data)

    # ---- finishing ----------------------------------------------------------------

    def finish(self, reason: str | None = None) -> None:
        if self.record["call"]["ended_at"]:
            return
        call = self.record["call"]
        call["ended_at"] = _now().isoformat()
        call["duration_s"] = round(time.monotonic() - self._t0, 1)
        call["end_reason"] = self.end_reason or reason or "unknown"
        lookups = self.record["kb_lookups"]
        latencies = [x["latency_ms"] for x in lookups if x.get("latency_ms") is not None]
        timeline = self.record["timeline"]
        self.record["summary"] = {
            "caller_turns": sum(1 for e in timeline if e["type"] == "caller_said"),
            "bot_turns": sum(1 for e in timeline if e["type"] == "bot_said"),
            "kb_lookups": len(lookups),
            "kb_hits": sum(1 for x in lookups if x.get("found")),
            "kb_misses": sum(1 for x in lookups if x.get("result") == "no_answer"),
            "kb_failures": sum(1 for x in lookups if x.get("result") not in ("answer", "no_answer")),
            "kb_avg_latency_ms": round(sum(latencies) / len(latencies)) if latencies else None,
            "kb_max_latency_ms": max(latencies) if latencies else None,
            "transfers": len(self.record["transfers"]),
            "safety_alerts": sum(1 for e in timeline if e["type"] == "safety_help"),
            "errors": len(self.record["errors"]),
        }
        logger.info(f"[call] ended ({call['end_reason']}) after {call['duration_s']}s: {self.record['summary']}")
        self._write(now=True)
        agent = self.record.get("agent") or {}
        audit.record("call", f"Call {call['end_reason']}", target=self.call_sid, agent=agent.get("name"),
                     caller=call.get("from"), dialed=call.get("to"), duration_s=call["duration_s"],
                     **{k: v for k, v in self.record["summary"].items() if k in ("kb_lookups", "kb_hits", "transfers", "errors")})
        logger.remove(self._sink_id)

    def _write(self, now: bool = False) -> None:
        """Save the record. On the event loop this is batched and persisted in a thread; `now`
        (and any call outside a loop) saves immediately, in the caller's thread."""
        if not now:
            try:
                loop = asyncio.get_running_loop()
            except RuntimeError:
                loop = None
            if loop is not None:
                if not self._flush_scheduled:
                    self._flush_scheduled = True
                    loop.call_later(FLUSH_SECONDS, self._snapshot_and_persist, loop)
                return
        self._persist(*self._snapshot())

    def _snapshot(self) -> tuple[int, str]:
        # Serialised on the thread that mutates the record, so it can't change mid-dump.
        self._seq += 1
        return self._seq, json.dumps(self.record, indent=2, ensure_ascii=False, default=str)

    def _snapshot_and_persist(self, loop: asyncio.AbstractEventLoop) -> None:
        self._flush_scheduled = False
        seq, data = self._snapshot()
        loop.run_in_executor(None, self._persist, seq, data)

    def _persist(self, seq: int, data: str) -> None:
        with self._db_lock:
            if seq < self._written_seq:
                return
            self._written_seq = seq
            try:
                tmp = self.json_path.with_suffix(".json.tmp")
                tmp.write_text(data)
                tmp.replace(self.json_path)
                store.save_call(json.loads(data))
            except Exception:
                logger.exception("Saving call record failed")
