"""Text test of an agent ("Test agent" in the UI): the agent's real system prompt, model,
tools and knowledge base, with typed messages instead of audio. Knowledge-base lookups are
real; transfers are simulated (nothing is dialed). Sessions live in memory.
"""

from __future__ import annotations

import asyncio
import json
import time
import uuid

from openai import AsyncOpenAI

from . import kb_client, routing, store
from .models import Agent, KnowledgeBase
from .prompt import system_prompt

_sessions: dict[str, dict] = {}
_MAX_SESSIONS = 200

TOOLS = {
    "search_knowledge_base": {
        "type": "function",
        "function": {
            "name": "search_knowledge_base",
            "description": "Answer the caller's question from the knowledge base.",
            "parameters": {
                "type": "object",
                "properties": {"question": {"type": "string", "description": "The caller's question, in their own words."}},
                "required": ["question"],
            },
        },
    },
    "transfer_to_live_agent": {
        "type": "function",
        "function": {
            "name": "transfer_to_live_agent",
            "description": "Transfer the caller to a live agent. Use when the caller asks for a person or a "
                           "live agent, or says yes to an offer to transfer them.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    "get_safety_help": {
        "type": "function",
        "function": {
            "name": "get_safety_help",
            "description": "Tell a caller in danger who to call. Use straight away, without a knowledge-base "
                           "search, when the caller describes an emergency happening now (kind \"emergency\": "
                           "someone hurt or in danger, a medical emergency, violence, a fire) or talks about "
                           "suicide, wanting to die, or hurting themselves, or is in severe emotional crisis "
                           "(kind \"crisis\").",
            "parameters": {
                "type": "object",
                "properties": {"kind": {"type": "string", "enum": ["emergency", "crisis"],
                                        "description": "\"emergency\" or \"crisis\"."}},
                "required": ["kind"],
            },
        },
    },
    "end_call": {
        "type": "function",
        "function": {
            "name": "end_call",
            "description": "End the phone call. Call this when the caller is finished: they thank you without "
                           "asking anything else (\"thank you\", \"thanks\", \"no thank you\", \"that's all\", "
                           "\"that's it\"), say goodbye, or say they have no more questions. Don't call it if the "
                           "caller asks something else in the same breath.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
}


def tools_for(agent: Agent, has_kb: bool) -> list[dict]:
    """The same tools the live call gets (numen/bot.py run_bot)."""
    return (([TOOLS["search_knowledge_base"]] if has_kb else [])
            + ([TOOLS["transfer_to_live_agent"]] if agent.routing.transfer_enabled else [])
            + ([TOOLS["get_safety_help"]] if agent.safety.enabled else [])
            + ([TOOLS["end_call"]] if agent.conversation.end_call_enabled else []))


def start(agent: Agent) -> dict:
    if len(_sessions) >= _MAX_SESSIONS:
        _sessions.pop(next(iter(_sessions)))
    sid = uuid.uuid4().hex
    prompt = system_prompt(agent)
    _sessions[sid] = {"agent_id": agent.id, "messages": [
        {"role": "system", "content": prompt},
        {"role": "assistant", "content": agent.greeting},
    ]}
    return {"session_id": sid, "events": [{"type": "bot", "source": "greeting", "text": agent.greeting}]}


async def send(agent: Agent, session_id: str, text: str) -> dict:
    s = _sessions.get(session_id)
    if s is None or s["agent_id"] != agent.id:
        raise KeyError("test session expired; start a new one")
    # DB reads in a thread: this runs on the event loop that carries live calls' audio.
    settings = await asyncio.to_thread(store.get_settings)
    if not settings.openai_api_key:
        raise ValueError("OpenAI API key is not set (Settings > Integrations).")
    kb_id = agent.knowledge.knowledge_base_id
    kb = await asyncio.to_thread(store.get, KnowledgeBase, kb_id) if kb_id else None
    if s.get("ended"):
        raise KeyError("the call has ended; start a new test")
    tools = tools_for(agent, kb is not None)
    msgs = s["messages"]
    msgs.append({"role": "user", "content": text})
    client = AsyncOpenAI(api_key=settings.openai_api_key)
    events: list[dict] = []

    for _ in range(3):  # at most a couple of tool rounds per turn
        t0 = time.monotonic()
        resp = await client.chat.completions.create(model=agent.llm.model, messages=msgs, **({"tools": tools} if tools else {}))
        llm_ms = round((time.monotonic() - t0) * 1000)
        m = resp.choices[0].message
        if not m.tool_calls:
            msgs.append({"role": "assistant", "content": m.content or ""})
            events.append({"type": "bot", "source": "llm", "text": m.content or "", "latency_ms": llm_ms})
            break
        msgs.append(m.model_dump(exclude_none=True))
        if m.content:  # spoken on a real call too, before the tools run
            events.append({"type": "bot", "source": "llm", "text": m.content, "latency_ms": llm_ms})
        run_llm_again = False
        for call in m.tool_calls:
            args = json.loads(call.function.arguments or "{}")
            events.append({"type": "tool_call", "name": call.function.name, "arguments": args, "latency_ms": llm_ms})
            if call.function.name == "search_knowledge_base":
                k = agent.knowledge
                if k.lookup_filler:
                    events.append({"type": "bot", "source": "lookup_filler", "text": k.lookup_filler})
                r = await kb_client.lookup(kb, args.get("question", text))
                events.append({"type": "kb_lookup", **r.log_fields()})
                if k.answer_mode == "verbatim":
                    spoken = f"{r.text} {k.follow_up}".strip() if r.found else r.text
                    events.append({"type": "bot", "source": "kb_answer" if r.found else "kb_fallback", "text": spoken})
                    msgs.append({"role": "tool", "tool_call_id": call.id,
                                 "content": json.dumps({"found": r.found, "spoken_to_caller": spoken})})
                else:
                    msgs.append({"role": "tool", "tool_call_id": call.id,
                                 "content": json.dumps({"found": r.found, "text": r.text})})
                    run_llm_again = True
            elif call.function.name == "transfer_to_live_agent":
                number, message = routing.transfer_target(agent.routing)
                events.append({"type": "bot", "source": "transfer_message", "text": message})
                events.append({"type": "transfer", "number": number,
                               "office_open": routing.office_is_open(agent.routing), "simulated": True})
                msgs.append({"role": "tool", "tool_call_id": call.id, "content": json.dumps({"status": "transferring"})})
            elif call.function.name == "get_safety_help":
                kind = "emergency" if args.get("kind") == "emergency" else "crisis"
                message = agent.safety.emergency_message if kind == "emergency" else agent.safety.crisis_message
                events.append({"type": "bot", "source": f"safety_{kind}", "text": message})
                msgs.append({"role": "tool", "tool_call_id": call.id, "content": json.dumps(
                    {"status": "safety message spoken to caller", "spoken_to_caller": message})})
            elif call.function.name == "end_call":
                goodbye = agent.conversation.goodbye_message
                if goodbye:
                    events.append({"type": "bot", "source": "goodbye", "text": goodbye})
                events.append({"type": "end_call", "simulated": True})
                msgs.append({"role": "tool", "tool_call_id": call.id, "content": json.dumps({"status": "ending call"})})
                s["ended"] = True
            else:
                msgs.append({"role": "tool", "tool_call_id": call.id,
                             "content": json.dumps({"error": f"unknown tool {call.function.name}"})})
        if not run_llm_again:
            break
    return {"events": events}
