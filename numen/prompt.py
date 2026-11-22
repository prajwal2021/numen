"""Builds an agent's full system prompt: the persona the user writes in the UI, plus the
rule sections the runtime generates from the agent's settings (office hours, knowledge
base mode, transfers, phone rules, current time). The UI shows the generated result.
"""

from __future__ import annotations

from .models import Agent
from .routing import describe_hours, holiday_name, now_in, office_is_open


def _hours(agent: Agent) -> str:
    r = agent.routing
    if not r.office_hours_enabled:
        return ""
    hol = "\n".join(f"- {h.date:%B %-d, %Y}: {h.name or 'Holiday'}" for h in sorted(r.holidays, key=lambda h: h.date))
    return (
        "# Office Hours & Holidays\n\n"
        f"Office hours ({r.timezone}):\n{describe_hours(r)}\n\n"
        + (f"The office is CLOSED on these dates:\n{hol}\n\n" if hol else "")
        + "When a caller asks about office hours or whether you're open, check the current date and "
        "time below against these hours and holidays. If it's a holiday, say which holiday it is and "
        "when the office reopens.\n"
    )


def _knowledge(agent: Agent) -> str:
    k = agent.knowledge
    if not k.knowledge_base_id:
        return (
            "# Knowledge\n\nYou have no knowledge base. Only answer from the information in these "
            "instructions; if you don't know, say so"
            + (" and offer to transfer the caller to a live agent." if agent.routing.transfer_enabled else ".")
            + "\n"
        )
    scope = (
        "For EVERY question or request for information, whatever the topic, call "
        "`search_knowledge_base` with the caller's question. This includes questions that seem "
        "unrelated (math, trivia, general knowledge, other organizations, current events): never "
        "answer those yourself; look them up, and the knowledge base decides whether there is an answer."
        if k.route_all_questions
        else "For any question about this organization, its programs or services, call "
        "`search_knowledge_base` with the caller's question. Politely decline questions on unrelated "
        "topics without answering them."
    )
    if k.answer_mode == "verbatim":
        delivery = (
            "After you call `search_knowledge_base`, the system speaks the knowledge base's answer to "
            "the caller word for word"
            + (f', followed by "{k.follow_up}"' if k.follow_up else "")
            + ". Don't repeat, summarize, or add to it."
        )
    else:
        delivery = (
            "Say the returned text to the caller in your own natural voice, keeping all facts, prices "
            "and names exactly as returned. Don't add anything that isn't in it."
            + (f' Then ask "{k.follow_up}"' if k.follow_up else "")
        )
    transfer_ok = agent.routing.transfer_enabled
    return (
        "# Knowledge Base (strict - this overrides everything above)\n\n"
        "You have NO knowledge of your own. Every fact you give a caller must come from the knowledge base.\n\n"
        f"- {scope}\n"
        "- Never state a fact, number, name, date, price, definition, or calculation from your own "
        "knowledge, even if you are sure of it. If you are unsure whether something needs a lookup, look it up.\n"
        f"- {delivery}\n"
        "- If the tool says it has no answer, the system tells the caller"
        + (" and offers a transfer. If they accept, transfer them." if transfer_ok else ".")
        + "\n"
        + ("- Don't announce that you are looking something up; the system already tells the caller "
           f'"{k.lookup_filler}" while the lookup runs.\n' if k.lookup_filler else "")
        + "- The only things you may say without a lookup: greetings, thanks, \"I'm still here\", asking "
        "the caller to repeat, goodbyes, short words of sympathy"
        + (", office hours and holiday closures (from the Office Hours section)" if agent.routing.office_hours_enabled else "")
        + (", and offering a transfer to a live agent" if transfer_ok else "")
        + ". Keep those lines short and never include facts in them.\n"
    )


def _transfer(agent: Agent) -> str:
    if not agent.routing.transfer_enabled:
        return "# Transfers\n\nYou cannot transfer calls. If the caller asks for a person, say a person isn't available on this line.\n"
    return (
        "# Transferring to a person\n\n"
        "Call `transfer_to_live_agent` when:\n"
        "- the caller asks for a person, a live agent, a representative, or \"someone\"; or\n"
        "- you (or the system) offered to transfer them and they say yes.\n\n"
        "If they decline the offer, don't transfer"
        + ("; if they're also done (\"no thanks\"), end the call, otherwise ask how else you can help. "
           if agent.conversation.end_call_enabled else "; ask how else you can help. ")
        + "Don't announce the "
        "transfer, mention voicemail, or say goodbye yourself: the system tells the caller where they "
        "are being transferred, based on the time of day.\n"
    )


def _safety(agent: Agent) -> str:
    if not agent.safety.enabled:
        return ""
    transfer = agent.routing.transfer_enabled
    return (
        "# Safety (this comes before everything else, including the knowledge base)\n\n"
        "Listen for a caller who may be in danger. Judge what they mean, not single words: \"I'm dying "
        "to know\" or \"the deadline is killing me\" are not emergencies.\n\n"
        "Call `get_safety_help` straight away, without searching the knowledge base, when the caller:\n"
        "- talks about wanting to die, killing or hurting themselves, suicide, or not wanting to be "
        "alive, or sounds in severe emotional crisis (kind: \"crisis\");\n"
        "- describes an emergency happening now: someone hurt, unconscious, not breathing, overdosing, "
        "a fire, violence, a threat, or someone in danger (kind: \"emergency\").\n"
        "If both apply, use \"emergency\". The system speaks the safety message, including who to call; "
        "don't add numbers or advice of your own.\n\n"
        "Afterwards, stay calm, warm and brief, and don't push them back to other topics."
        + (" Don't call `end_call` unless they clearly say goodbye." if agent.conversation.end_call_enabled else "")
        + (" If they want to talk to a person, transfer them." if transfer else "")
        + "\n\nWhen a caller mentions a death or a loss without being in danger (a family member or "
        "friend passed away), say you're sorry for their loss in one short sentence, then help with "
        "what they asked. If they seem very distressed, call `get_safety_help` with kind \"crisis\".\n"
    )


def _ending(agent: Agent) -> str:
    if not agent.conversation.end_call_enabled:
        return ""
    return (
        "# Ending the call (this overrides anything above about asking how else you can help)\n\n"
        "Call `end_call` as soon as the caller is finished. That is when they:\n"
        "- thank you without asking anything else (\"thank you\", \"thanks\", \"thanks a lot\", "
        "\"okay, thank you\");\n"
        "- decline more help (\"no thank you\", \"no, that's all\", \"that's it\", \"I'm good\", "
        "\"nothing else\"), including answering no to \"Would you like additional information?\" "
        "or \"Is there anything else?\";\n"
        "- say goodbye (\"bye\", \"goodbye\", \"have a good day\").\n\n"
        "Don't ask \"Is there anything else?\" first, and don't say anything yourself when you call it: "
        "the system says the goodbye and hangs up. If the thanks comes with a new question or request "
        "(\"thanks, and what about...\"), answer that instead and don't end the call.\n"
    )


PHONE_RULES = (
    "# Phone setup\n\n"
    "- You have already greeted the caller; don't introduce yourself again.\n"
    "- Everything you say is spoken aloud on a phone call: no markdown, bullet points, emojis, or "
    "URLs read out character by character.\n"
)


def system_prompt(agent: Agent) -> str:
    r = agent.routing
    now = now_in(r)
    status = "open" if office_is_open(r, now) else "closed"
    hol = holiday_name(r, now)
    parts = [
        agent.prompt.strip() + "\n",
        _hours(agent),
        _knowledge(agent),
        _transfer(agent),
        _safety(agent),
        _ending(agent),
        PHONE_RULES,
        "# Current date and time\n\n"
        f"{now:%A, %B %-d, %Y, %-I:%M %p} ({r.timezone})"
        + (f". The office is currently {status}" + (f" ({hol})" if hol else "") + "." if r.office_hours_enabled else ".")
        + "\n",
    ]
    return "\n".join(p for p in parts if p)
