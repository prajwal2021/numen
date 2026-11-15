"""Text test of an agent ("Test agent" in the UI): the agent's real system prompt, model,
tools and knowledge base, with typed messages instead of audio. Knowledge-base lookups are
real; transfers are simulated (nothing is dialed). Sessions live in memory.
"""

from __future__ import annotations

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
}


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
    settings = store.get_settings()
    if not settings.openai_api_key:
        raise ValueError("OpenAI API key is not set (Settings > Integrations).")
    kb = store.get(KnowledgeBase, agent.knowledge.knowledge_base_id) if agent.knowledge.knowledge_base_id else None
    tools = ([TOOLS["search_knowledge_base"]] if kb else []) + (
        [TOOLS["transfer_to_live_agent"]] if agent.routing.transfer_enabled else [])
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
        if not run_llm_again:
            break
    return {"events": events}
