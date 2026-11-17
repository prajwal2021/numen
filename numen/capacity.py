"""Call admission control: how many calls run at once, who waits, who is turned away.

One server process runs every live call on one asyncio event loop, and each call also holds
ElevenLabs STT/TTS websockets and OpenAI requests, all of which have plan limits. Past a safe
number of calls, audio stutters for *everyone*. So a call is only let onto the media stream
when it has a slot; otherwise it waits in a FIFO queue (Twilio keeps it on a hold loop) or
is turned away politely.

Lifecycle of a slot (all state changes are synchronous, with no awaits, so the event loop
makes them atomic and no locks are needed):

    /incoming   admit()   -> Admitted (slot reserved)  | Queued (ticket)  | Rejected
    /incoming/hold poll() -> Queued | Admitted (a slot was handed to this ticket) | Rejected
    /ws         connect() -> the reservation becomes a live slot
    /ws ends    release() -> slot freed, the head of the queue is promoted

A reservation that is never claimed (caller hung up while ringing, Twilio failed to open the
stream) expires after RESERVATION_TTL_S, and a queued caller who stops polling (hung up) is
dropped after ABANDON_AFTER_S, so a slot can't leak.

Limits are per process. Running several backend replicas needs this state in a shared store
(see README, "Capacity and scaling").
"""

from __future__ import annotations

import os
import time
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Any


def _int(name: str, default: int) -> int:
    try:
        return max(0, int(os.getenv(name, default)))
    except ValueError:
        return default


@dataclass(frozen=True)
class Limits:
    max_calls: int = field(default_factory=lambda: max(1, _int("MAX_CONCURRENT_CALLS", 10)))
    max_queue: int = field(default_factory=lambda: _int("MAX_QUEUE_SIZE", 20))
    max_wait_s: int = field(default_factory=lambda: _int("MAX_QUEUE_WAIT_SECONDS", 120))
    per_caller: int = field(default_factory=lambda: _int("MAX_CALLS_PER_CALLER", 2))  # 0 = no limit
    max_call_s: int = field(default_factory=lambda: _int("MAX_CALL_SECONDS", 1800))  # 0 = no limit
    # How long a reserved slot waits for its media stream to open.
    reservation_ttl_s: int = 30
    # A queued caller is polled every HOLD_POLL_S; this long without a poll = they hung up.
    abandon_after_s: int = 25
    hold_poll_s: int = 8


@dataclass
class Decision:
    status: str  # admitted | queued | rejected
    reason: str = ""  # rejected: draining | full | caller_limit | timeout | expired
    ticket: str = ""
    position: int = 0  # queued: 1 = next
    waited_s: float = 0
    polls: int = 0
    call_sid: str = ""
    meta: Any = None  # whatever admit() was given; handed back when a queued call is admitted


@dataclass
class _Slot:
    caller: str
    live: bool = False
    expires: float = 0.0  # reservations only


@dataclass
class _Waiter:
    call_sid: str
    caller: str
    enqueued: float
    last_seen: float
    granted: bool = False
    polls: int = 0
    meta: Any = None


class CallLimiter:
    def __init__(self, limits: Limits | None = None, clock=time.monotonic):
        self.limits = limits or Limits()
        self._now = clock
        self._slots: dict[str, _Slot] = {}  # call_sid -> slot (reserved or live)
        self._waiting: OrderedDict[str, _Waiter] = OrderedDict()  # ticket -> waiter, FIFO
        self.draining = False
        self.stats = {"admitted": 0, "queued": 0, "rejected_full": 0, "rejected_caller_limit": 0,
                      "rejected_draining": 0, "queue_timeouts": 0, "abandoned": 0, "peak_active": 0,
                      "wait_s_total": 0.0, "waits": 0}

    # ---- views -------------------------------------------------------------------

    @property
    def active(self) -> int:
        """Live calls plus slots reserved for calls about to connect."""
        return len(self._slots)

    @property
    def live(self) -> int:
        return sum(1 for s in self._slots.values() if s.live)

    @property
    def queued(self) -> int:
        return sum(1 for w in self._waiting.values() if not w.granted)

    def snapshot(self) -> dict:
        self._sweep()
        n = self.stats["waits"]
        return {
            "active_calls": self.live, "reserved_slots": self.active - self.live,
            "max_calls": self.limits.max_calls, "queued_callers": self.queued,
            "max_queue": self.limits.max_queue, "max_queue_wait_s": self.limits.max_wait_s,
            "max_call_s": self.limits.max_call_s, "per_caller_limit": self.limits.per_caller,
            "draining": self.draining, "avg_queue_wait_s": round(self.stats["wait_s_total"] / n, 1) if n else 0,
            "stats": {k: (round(v, 1) if isinstance(v, float) else v) for k, v in self.stats.items()},
        }

    # ---- entry points ------------------------------------------------------------

    def admit(self, call_sid: str, caller: str = "", meta: Any = None) -> Decision:
        """A new call arrived at /incoming."""
        self._sweep()
        if self.draining:
            self.stats["rejected_draining"] += 1
            return Decision("rejected", "draining")
        if call_sid in self._slots:  # Twilio retried the webhook
            return Decision("admitted")
        if self.limits.per_caller and caller and self._caller_count(caller) >= self.limits.per_caller:
            self.stats["rejected_caller_limit"] += 1
            return Decision("rejected", "caller_limit")
        # FIFO: never jump ahead of people already waiting.
        if len(self._slots) < self.limits.max_calls and not self._waiting:
            self._reserve(call_sid, caller)
            return Decision("admitted")
        if self.queued < self.limits.max_queue:
            ticket = os.urandom(8).hex()
            now = self._now()
            self._waiting[ticket] = _Waiter(call_sid, caller, enqueued=now, last_seen=now, meta=meta)
            self.stats["queued"] += 1
            return Decision("queued", ticket=ticket, position=self._position(ticket))
        self.stats["rejected_full"] += 1
        return Decision("rejected", "full")

    def poll(self, ticket: str) -> Decision:
        """A queued caller's hold loop came round again."""
        self._sweep()
        w = self._waiting.get(ticket)
        if w is None:
            return Decision("rejected", "expired")
        now = self._now()
        w.last_seen, w.polls = now, w.polls + 1
        waited = now - w.enqueued
        if w.granted:
            del self._waiting[ticket]
            self._slots[w.call_sid].expires = now + self.limits.reservation_ttl_s
            self._record_wait(waited)
            return Decision("admitted", waited_s=waited, call_sid=w.call_sid, meta=w.meta)
        if self.draining:
            del self._waiting[ticket]
            self.stats["rejected_draining"] += 1
            return Decision("rejected", "draining")
        if waited >= self.limits.max_wait_s:
            del self._waiting[ticket]
            self.stats["queue_timeouts"] += 1
            return Decision("rejected", "timeout", waited_s=waited)
        return Decision("queued", ticket=ticket, position=self._position(ticket), waited_s=waited, polls=w.polls)

    def connect(self, call_sid: str, caller: str = "") -> bool:
        """The media stream opened. True if this call may run."""
        self._sweep()
        slot = self._slots.get(call_sid)
        if slot is None:
            # No reservation (expired, or the webhook was bypassed): take a free slot or refuse.
            if self.draining or len(self._slots) >= self.limits.max_calls:
                return False
            slot = self._reserve(call_sid, caller)
        slot.live = True
        self.stats["peak_active"] = max(self.stats["peak_active"], self.live)
        return True

    def release(self, call_sid: str) -> None:
        """The call ended (or never connected)."""
        self._slots.pop(call_sid, None)
        self._sweep()

    def set_draining(self, on: bool) -> None:
        """Stop admitting new calls (for a deploy); live calls carry on."""
        self.draining = on

    # ---- internals ---------------------------------------------------------------

    def _reserve(self, call_sid: str, caller: str) -> _Slot:
        slot = self._slots[call_sid] = _Slot(caller, expires=self._now() + self.limits.reservation_ttl_s)
        self.stats["admitted"] += 1
        return slot

    def _caller_count(self, caller: str) -> int:
        return (sum(1 for s in self._slots.values() if s.caller == caller)
                + sum(1 for w in self._waiting.values() if w.caller == caller and not w.granted))

    def _position(self, ticket: str) -> int:
        n = 0
        for t, w in self._waiting.items():
            if w.granted:
                continue
            n += 1
            if t == ticket:
                return n
        return 0

    def _record_wait(self, waited: float) -> None:
        self.stats["wait_s_total"] += waited
        self.stats["waits"] += 1

    def _sweep(self) -> None:
        """Expire stale reservations and abandoned waiters, then hand free slots to the queue."""
        now = self._now()
        for sid in [s for s, sl in self._slots.items() if not sl.live and sl.expires <= now]:
            del self._slots[sid]
        for t in [t for t, w in self._waiting.items()
                  if not w.granted and now - w.last_seen > self.limits.abandon_after_s]:
            del self._waiting[t]
            self.stats["abandoned"] += 1
        # A granted waiter whose reservation expired (never came back to claim it) is gone too.
        for t in [t for t, w in self._waiting.items() if w.granted and w.call_sid not in self._slots]:
            del self._waiting[t]
            self.stats["abandoned"] += 1
        for w in self._waiting.values():
            if len(self._slots) >= self.limits.max_calls:
                break
            if not w.granted:
                w.granted = True
                self._reserve(w.call_sid, w.caller).expires = now + self.limits.reservation_ttl_s


limiter = CallLimiter()
