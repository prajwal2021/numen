"""Office hours, holidays and where a transfer goes (numen/routing.py)."""

from datetime import date, datetime
from zoneinfo import ZoneInfo

from numen import routing
from numen.models import Holiday, RoutingConfig

TZ = ZoneInfo("America/Chicago")


def at(y, m, d, hh, mm=0):
    return datetime(y, m, d, hh, mm, tzinfo=TZ)


def cfg(**kw):
    return RoutingConfig(transfer_number="+18065550100", **kw)


def test_weekday_hours():
    c = cfg()
    assert routing.office_is_open(c, at(2026, 11, 23, 8, 0))       # Monday 8:00
    assert routing.office_is_open(c, at(2026, 11, 23, 16, 59))
    assert not routing.office_is_open(c, at(2026, 11, 23, 17, 0))  # closes at 17:00
    assert not routing.office_is_open(c, at(2026, 11, 23, 7, 59))
    assert not routing.office_is_open(c, at(2026, 11, 22, 12, 0))  # Sunday


def test_holiday_closes_and_is_named():
    c = cfg(holidays=[Holiday(date=date(2026, 11, 26), name="Thanksgiving")])
    t = at(2026, 11, 26, 10)
    assert not routing.office_is_open(c, t)
    assert routing.holiday_name(c, t) == "Thanksgiving"


def test_hours_disabled_means_always_open():
    assert routing.office_is_open(cfg(office_hours_enabled=False), at(2026, 11, 22, 3))


def test_transfer_target_open_vs_closed(monkeypatch):
    c = cfg(after_hours_number="+18065550199")
    monkeypatch.setattr(routing, "now_in", lambda _: at(2026, 11, 23, 10))
    assert routing.transfer_target(c) == ("+18065550100", c.transfer_message)
    monkeypatch.setattr(routing, "now_in", lambda _: at(2026, 11, 23, 20))
    assert routing.transfer_target(c) == ("+18065550199", c.transfer_message_after_hours)
    c.after_hours_number = None
    assert routing.transfer_target(c) == ("+18065550100", c.transfer_message_voicemail)


def test_after_hours_transfer_only_when_configured(monkeypatch):
    monkeypatch.setattr(routing, "now_in", lambda _: at(2026, 11, 23, 20))
    assert not routing.after_hours_transfer(cfg(after_hours_action="answer", after_hours_number="+18065550199"))
    assert not routing.after_hours_transfer(cfg(after_hours_action="transfer"))  # no number
    assert routing.after_hours_transfer(cfg(after_hours_action="transfer", after_hours_number="+18065550199"))
    monkeypatch.setattr(routing, "now_in", lambda _: at(2026, 11, 23, 10))
    assert not routing.after_hours_transfer(cfg(after_hours_action="transfer", after_hours_number="+18065550199"))
