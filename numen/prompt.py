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
        "the caller to repeat, goodbyes"
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
        "If they decline the offer, don't transfer; ask how else you can help. Don't announce the "
        "transfer, mention voicemail, or say goodbye yourself: the system tells the caller where they "
        "are being transferred, based on the time of day.\n"
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
        PHONE_RULES,
        "# Current date and time\n\n"
        f"{now:%A, %B %-d, %Y, %-I:%M %p} ({r.timezone})"
        + (f". The office is currently {status}" + (f" ({hol})" if hol else "") + "." if r.office_hours_enabled else ".")
        + "\n",
    ]
    return "\n".join(p for p in parts if p)
