"""Twilio's callback after a transfer's <Dial> ends (server.py /transfer/done)."""

import pytest

server = pytest.importorskip("server")
from fastapi.testclient import TestClient  # noqa: E402

from numen.models import Agent, RoutingConfig  # noqa: E402


@pytest.fixture
def client(monkeypatch):
    noted, audited = [], []

    async def note(*a):
        noted.append(a)

    agent = Agent(name="T", routing=RoutingConfig(transfer_unavailable_message="Nobody home & sorry. Goodbye."))
    monkeypatch.setattr(server, "_note_transfer", note)
    monkeypatch.setattr(server.audit, "record", lambda *a, **k: audited.append(a))
    monkeypatch.setattr(server.store, "get", lambda cls, id: agent if id == agent.id else None)
    c = TestClient(server.app)
    c.noted, c.audited, c.agent = noted, audited, agent
    return c


def test_busy_line_gets_the_agents_message(client):
    r = client.post(f"/transfer/done?agent_id={client.agent.id}", data={"CallSid": "CA1", "DialCallStatus": "busy"})
    assert r.status_code == 200
    assert "<Say>Nobody home &amp; sorry. Goodbye.</Say><Hangup/>" in r.text
    assert client.noted == [("CA1", "busy", None, False)]
    assert client.audited and "busy" in client.audited[0][1]


def test_unknown_agent_falls_back_to_the_default_message(client):
    r = client.post("/transfer/done?agent_id=nope", data={"CallSid": "CA2", "DialCallStatus": "no-answer"})
    assert RoutingConfig().transfer_unavailable_message.split(",")[0] in r.text and "<Hangup/>" in r.text


def test_answered_transfer_just_ends(client):
    r = client.post("/transfer/done", data={"CallSid": "CA3", "DialCallStatus": "completed", "DialCallDuration": "42"})
    assert "<Say>" not in r.text and "<Hangup/>" in r.text
    assert client.noted == [("CA3", "completed", 42.0, True)]
    assert not client.audited
