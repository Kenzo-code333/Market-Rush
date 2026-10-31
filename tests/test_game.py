"""
Unit tests for the game rules (no network). Run with:  python -m pytest -q
"""

import pytest

from server import config
from server.game import Room


class FakeClock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


def make_room(n_players=3):
    clock = FakeClock()
    room = Room("TEST", seed=42, clock=clock)
    players = [room.join(f"P{i}")[0] for i in range(n_players)]
    assert room.start(players[0].id)
    clock.now = room.start_time
    room.open_market()
    return room, clock, players


def act(room, p, action, **kw):
    room.outbox.clear()
    room.handle(p.id, {"type": "action", "action": action, **kw})
    return [m for pid, m in room.outbox if m.get("type") == "toast" and pid == p.id]


def test_lobby_join_rules():
    room = Room("T", seed=1, clock=FakeClock())
    a, _ = room.join("Alice")
    assert room.host_id == a.id
    assert room.join("alice")[1]  # duplicate name refused
    assert room.join("")[1]
    # Only host can start, and needs MIN_PLAYERS
    b, _ = room.join("Bob")
    assert not room.start(b.id)
    assert room.start(a.id)
    assert all(len(p.cards) == config.STARTING_CARDS for p in room.players.values())
    # New players can't join mid match, but disconnected ones can come back
    assert room.join("Carol")[1]
    room.disconnect(b.id)
    again, err = room.join("Bob")
    assert err is None and again is b
    assert room.join("", token=a.token)[0] is a


def test_buy_moves_price_and_validates_cash():
    room, clock, (a, b, c) = make_room()
    p0 = room.market["food"].price
    act(room, a, "buy", commodity="food", qty=10)
    assert a.holdings["food"] == 10
    assert room.market["food"].price > p0
    assert a.cash < config.STARTING_CASH
    # Can't sell what you don't have
    toasts = act(room, b, "sell", commodity="food", qty=1)
    assert toasts and toasts[0]["level"] == "bad"
    # Max buy spends nearly all cash but never goes negative
    act(room, a, "buy", commodity="metals", qty="max")
    assert a.cash >= 0
    assert a.holdings["metals"] > 0
    # Not enough cash
    toasts = act(room, a, "buy", commodity="metals", qty=1000)
    assert toasts[0]["level"] == "bad"


def test_round_trip_does_not_create_money():
    room, clock, (a, b, c) = make_room()
    start = a.cash
    act(room, a, "buy", commodity="oxygen", qty=100)
    act(room, a, "sell", commodity="oxygen", qty="max")
    assert a.cash < start


def test_short_and_cover():
    room, clock, (a, b, c) = make_room()
    p0 = room.market["fuel"].price
    act(room, a, "short", commodity="fuel", qty=10)
    assert a.shorts["fuel"] == 10
    assert room.market["fuel"].price < p0
    assert a.cash > config.STARTING_CASH
    act(room, a, "cover", commodity="fuel", qty="max")
    assert a.shorts["fuel"] == 0
    # Short limit
    toasts = act(room, b, "short", commodity="metals", qty=10_000)
    assert toasts[0]["level"] == "bad"


def test_loans_interest_and_penalty():
    room, clock, (a, b, c) = make_room()
    act(room, a, "loan")
    act(room, a, "loan")
    toasts = act(room, a, "loan")
    assert toasts[0]["level"] == "bad"  # credit limit
    assert a.debt == 10_000
    clock.now += 1
    room.tick()
    assert a.debt > 10_000
    act(room, a, "repay")
    assert a.debt == 0


def test_cornering_sets_floor():
    room, clock, (a, b, c) = make_room()
    act(room, a, "buy", commodity="water", qty=150)
    cm = room.market["water"]
    assert cm.corner_by == a.id
    assert cm.floor >= cm.price * 0.8
    act(room, b, "buy", commodity="water", qty="max")  # b now holds more
    assert cm.corner_by == b.id


def test_cards_freeze_shield_audit_spike_rumor_insider():
    room, clock, (a, b, c) = make_room()
    a.cards = [{"id": "f1", "type": "freeze"}, {"id": "s1", "type": "spike"},
               {"id": "r1", "type": "rumor"}, {"id": "i1", "type": "insider"},
               {"id": "a1", "type": "audit"}, {"id": "f2", "type": "freeze"}]
    b.cards = [{"id": "sh", "type": "shield"}]
    # Freeze locks trading
    act(room, a, "card", card="f1", target=b.id)
    toasts = act(room, b, "buy", commodity="food", qty=1)
    assert toasts[0]["level"] == "bad" and b.holdings["food"] == 0
    clock.now += config.FREEZE_SECONDS + 0.1
    act(room, b, "buy", commodity="food", qty=1)
    assert b.holdings["food"] == 1
    # Shield blocks the next card
    act(room, b, "card", card="sh")
    assert b.shield
    act(room, a, "card", card="f2", target=b.id)
    assert not b.shield and b.frozen_until < room.now_t()
    # Spike
    p0 = room.market["metals"].price
    act(room, a, "card", card="s1", commodity="metals")
    assert room.market["metals"].price == pytest.approx(p0 * 1.2)
    # Rumor is public, secretly fake
    act(room, a, "card", card="r1", commodity="food", direction="up")
    assert room.news[-1]["fake"] and room.news[-1]["unconfirmed"]
    assert "fake" not in room.state_for(b.id)["news"][-1]
    # Insider tip guarantees the lead time
    act(room, a, "card", card="i1")
    tip = a.insider_tips[0]
    assert tip["at"] - room.now_t() >= config.INSIDER_LEAD_SECONDS - 0.01
    # Audit
    act(room, a, "card", card="a1", target=c.id)
    assert room.state_for(a.id)["audits"][0]["id"] == c.id
    # Card no longer owned
    toasts = act(room, a, "card", card="a1", target=c.id)
    assert toasts[0]["level"] == "bad"
    assert a.cards == []


def test_contract_delivery():
    room, clock, (a, b, c) = make_room()
    room._new_contract(room.now_t())
    con = room.contracts[0]
    toasts = act(room, a, "deliver", contract=con["id"])
    assert toasts[0]["level"] == "bad"
    a.holdings[con["commodity"]] = con["qty"] + 3
    cash = a.cash
    act(room, a, "deliver", contract=con["id"])
    assert a.holdings[con["commodity"]] == 3
    assert a.cash == cash + con["reward"]
    assert con["status"] == "done"


def test_full_match_runs_to_end():
    room, clock, (a, b, c) = make_room()
    act(room, a, "short", commodity="food", qty=10)
    act(room, b, "loan")
    for _ in range(config.MATCH_SECONDS):
        clock.now += 1
        room.tick()
    assert room.phase == "ended"
    assert len(room.market.history["food"]) == config.MATCH_SECONDS + 1
    assert any(n["kind"] == "event" for n in room.news)
    assert any(n["kind"] == "contract" for n in room.news)
    res = room.state_for(a.id)["results"]
    assert len(res) == 3
    bob = next(r for r in res if r["name"] == "P1")
    assert bob["penalty"] > 0
    # Play again returns everyone to the lobby with fresh wallets
    room.play_again(a.id)
    assert room.phase == "lobby" and a.cash == config.STARTING_CASH and a.shorts["food"] == 0


def test_margin_call_force_closes_runaway_shorts():
    room, clock, (a, b, c) = make_room()
    act(room, a, "short", commodity="metals", qty=20)
    assert a.shorts["metals"] == 20
    room.market.shock("metals", 4.0)   # price ×5: short exposure explodes
    clock.now += 1
    room.tick()
    assert a.shorts["metals"] == 0
    assert a.cash >= 0                 # shortfall went to debt, not negative cash
    assert a.debt > 0
