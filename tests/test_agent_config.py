"""Agent settings -> what the call gets: tools, prompt rules, defaults for older saved agents."""

from numen import testchat
from numen.models import Agent
from numen.prompt import system_prompt


def test_older_saved_agents_get_the_new_defaults():
    a = Agent.model_validate({"name": "Old", "conversation": {"ring_seconds": 2}, "knowledge": {"answer_mode": "verbatim"}})
    assert a.conversation.end_call_enabled is True
    assert a.conversation.goodbye_message
    assert a.conversation.background_voice_filter == "standard"
    assert a.knowledge.typing_sound is True


def test_end_call_tool_and_prompt_follow_the_setting():
    a = Agent(name="A")
    # No transfer number yet: no transfer tool, and the prompt doesn't offer one.
    assert "transfer_to_live_agent" not in [t["function"]["name"] for t in testchat.tools_for(a, has_kb=True)]
    assert "offer to transfer" not in system_prompt(a)
    a.routing.transfer_number = "+18065550100"
    names = [t["function"]["name"] for t in testchat.tools_for(a, has_kb=True)]
    assert names == ["search_knowledge_base", "transfer_to_live_agent", "get_safety_help", "end_call"]
    p = system_prompt(a)
    assert "# Ending the call" in p and '"thank you"' in p

    a.conversation.end_call_enabled = False
    assert "end_call" not in [t["function"]["name"] for t in testchat.tools_for(a, has_kb=False)]
    assert "end_call" not in system_prompt(a)


def test_live_call_tools_match_the_test_chat():
    from numen import bot

    a = Agent(name="A")
    live = {f.__name__ for f in (bot.search_knowledge_base, bot.transfer_to_live_agent, bot.get_safety_help,
                                 bot.end_call)}
    assert live == set(testchat.TOOLS)


def test_safety_tool_and_prompt_follow_the_setting():
    a = Agent(name="A")
    assert "get_safety_help" in [t["function"]["name"] for t in testchat.tools_for(a, has_kb=True)]
    p = system_prompt(a)
    assert "# Safety" in p and "9 1 1" not in p  # numbers live only in the spoken message
    assert "9 1 1" in a.safety.emergency_message and "9 8 8" in a.safety.crisis_message
    a.safety.enabled = False
    assert "get_safety_help" not in [t["function"]["name"] for t in testchat.tools_for(a, has_kb=True)]
    assert "# Safety" not in system_prompt(a)


def test_listening_defaults():
    a = Agent.model_validate({"name": "Old", "conversation": {}})
    assert a.conversation.caller_language == "en" and a.conversation.keyterms == []


def test_lookup_promise_detection():
    from numen.bot import promises_lookup

    filler = "Let me check on that."
    for t in ("Let me check on that.", "Okay, let me look that up.", "One moment while I check.", "I'll find out for you."):
        assert promises_lookup(t, filler), t
    for t in ("The first course is free.", "Let me know if you have other questions.", "I can transfer you.", ""):
        assert not promises_lookup(t, filler), t
