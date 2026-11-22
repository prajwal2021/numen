"""The live-call tool handlers (numen/bot.py), run against fakes of the call log and LLM."""

import asyncio

from pipecat.frames.frames import EndWorkerFrame, MixerEnableFrame, TTSSpeakFrame

from numen import bot, kb_client, routing
from numen.models import Agent, KnowledgeBase


class FakeLog:
    """Same method signatures as numen.calllog.CallLog."""

    def __init__(self):
        self.events, self.end_reason = [], None

    def event(self, kind, **data):
        self.events.append((kind, data))

    def kb_lookup(self, **data):
        self.event("kb_lookup", **data)

    def error(self, message, **data):
        self.event("error", message=message, **data)


class FakeLLM:
    def __init__(self):
        self.frames = []

    async def push_frame(self, frame):
        self.frames.append(frame)


class FakeWorker(FakeLLM):
    async def queue_frames(self, frames):
        self.frames.extend(frames)


class Params:
    def __init__(self, session):
        self.app_resources, self.llm, self.results = session, FakeLLM(), []

    async def result_callback(self, result, properties=None):
        self.results.append((result, properties))


def session(**agent_kw):
    s = bot.CallSession(Agent(name="A", **agent_kw), KnowledgeBase(name="K", url="http://kb"), "CA1", FakeLog())
    s.worker = FakeWorker()
    return s


def test_safety_help_speaks_the_fixed_message(monkeypatch):
    monkeypatch.setattr(bot.audit, "record", lambda *a, **k: None)
    for kind in ("crisis", "emergency"):
        s = session()
        p = Params(s)
        asyncio.run(bot.get_safety_help(p, kind))
        expected = s.agent.safety.crisis_message if kind == "crisis" else s.agent.safety.emergency_message
        assert [f.text for f in p.llm.frames if isinstance(f, TTSSpeakFrame)] == [expected]
        assert ("safety_help", {"category": kind}) in s.log.events
        assert p.results[0][1].run_llm is False


def test_end_call_says_goodbye_then_ends(monkeypatch):
    async def go():
        s = session()

        async def instant_say(text, source):
            s.log.event("bot_said", source=source, text=text)
        s.say_and_wait = instant_say
        hung = []

        async def hang_up(sid):
            hung.append(sid)
            return True, None
        monkeypatch.setattr(routing, "hang_up", hang_up)
        p = Params(s)
        await bot.end_call(p)
        await asyncio.sleep(0.05)
        assert s.ending and s.log.end_reason == "agent ended the call"
        assert ("bot_said", {"source": "goodbye", "text": s.agent.conversation.goodbye_message}) in s.log.events
        assert hung == ["CA1"]
        assert any(isinstance(f, EndWorkerFrame) for f in s.worker.frames)
        # A second end_call does nothing.
        await s.hang_up("again")
        assert s.log.end_reason == "agent ended the call"
    asyncio.run(go())


def test_lookup_types_while_searching_and_stops_before_the_answer(monkeypatch):
    async def lookup(kb, q, fallback=None):
        return kb_client.Lookup(question=q, fallback="no", found=True, answer="The answer.", result="answer")
    monkeypatch.setattr(kb_client, "lookup", lookup)
    s = session()
    s.typing = True
    p = Params(s)
    asyncio.run(bot.search_knowledge_base(p, "q?"))
    kinds = [type(f).__name__ + (f":{f.enable}" if isinstance(f, MixerEnableFrame) else "") for f in p.llm.frames]
    assert kinds == ["MixerEnableFrame:True", "MixerEnableFrame:False", "TTSSpeakFrame"]
    assert p.llm.frames[-1].text.startswith("The answer.")
