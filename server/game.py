"""
Market Rush — game rules.

A `Room` is one lobby + match. It is PURE GAME LOGIC: it never touches the
network. Instead it:
  * receives actions via `handle(player_id, message)`,
  * advances time via `tick()` (called once per second by main.py),
  * puts outgoing messages in `self.outbox` and sets `self.dirty = True`
    when everyone's screen needs a refresh.
main.py then delivers the outbox over WebSockets.

This separation makes the rules easy to unit-test (see tests/test_game.py).
"""

import math
import random
import secrets
import time

from . import config, content
from .market import Market

PLAYER_COLORS = ["#3ff0ff", "#ff5fa2", "#ffd84d", "#7cff6b", "#b48cff", "#ff8a3d"]
COMMODITY_IDS = list(config.COMMODITIES.keys())
TRADE_ACTIONS = {"buy", "sell", "short", "cover"}


def _uid() -> str:
    return secrets.token_hex(4)


def _money(x: float) -> str:
    return f"${x:,.0f}"


class Player:
    """A trader. Wallet data is reset at the start of each match."""

    def __init__(self, pid: str, name: str, token: str, color: str):
        self.id = pid
        self.name = name
        self.token = token            # secret used to reconnect after a refresh
        self.color = color
        self.connected = True
        self.reset_wallet()

    def reset_wallet(self):
        self.cash = float(config.STARTING_CASH)
        self.holdings = {cid: 0 for cid in COMMODITY_IDS}
        self.shorts = {cid: 0 for cid in COMMODITY_IDS}
        self.debt = 0.0
        self.cards = []               # list of {"id": ..., "type": ...}
        self.frozen_until = -1.0      # match time when the freeze ends
        self.shield = False
        self.audits = []              # ids of players whose books we can see
        self.insider_tips = []        # private previews of news
        self.milestones = 0           # profit milestones already rewarded
        self.trade_count = 0


class Room:
    def __init__(self, code: str, seed=None, clock=time.monotonic):
        self.code = code
        self.rng = random.Random(seed)
        self.clock = clock                     # injectable for tests
        self.players: dict[str, Player] = {}   # keeps join order
        self.host_id = None
        self.outbox = []                       # list of (player_id or None, message)
        self.dirty = False
        self.last_activity = clock()
        self._reset_match()

    # =====================================================================
    # Setup / helpers
    # =====================================================================
    def _reset_match(self):
        self.phase = "lobby"          # lobby -> countdown -> playing -> ended -> lobby
        self.market = Market(self.rng)
        self.start_time = None        # clock() value when trading opens
        self.tick_index = 0
        self.frenzy_announced = False
        self.news = []
        self.contracts = []
        self.big_trades = []
        self.card_log = []
        self.next_event = None        # {"at", "headline", "effects"}
        self.pending_effects = []     # [{"at", "effects"}]
        self.pending_leaks = []       # [{"at", "text", "commodity"}]
        self.next_contract_at = config.CONTRACT_FIRST_AT
        self.results = None
        for p in self.players.values():
            p.reset_wallet()

    def now_t(self) -> float:
        """Seconds since the opening bell (negative during the countdown)."""
        if self.start_time is None:
            return 0.0
        return self.clock() - self.start_time

    def remaining(self) -> float:
        if self.phase == "playing":
            return max(0.0, config.MATCH_SECONDS - self.now_t())
        return float(config.MATCH_SECONDS) if self.phase in ("lobby", "countdown") else 0.0

    def is_frenzy(self) -> bool:
        return self.phase == "playing" and self.remaining() <= config.CLOSING_FRENZY_SECONDS

    def connected_players(self):
        return [p for p in self.players.values() if p.connected]

    def send(self, pid, message: dict):
        """Queue a message for one player (pid) or everyone (pid=None)."""
        self.outbox.append((pid, message))

    def toast(self, pid, text: str, level: str = "info"):
        self.send(pid, {"type": "toast", "level": level, "text": text})

    def add_news(self, kind: str, text: str, unconfirmed=False, fake=False, author=None):
        """kind: 'event' | 'rumor' | 'system' | 'contract'."""
        item = {
            "id": _uid(), "t": round(max(0.0, self.now_t()), 1), "kind": kind, "text": text,
            "unconfirmed": unconfirmed,
            "fake": fake, "author": author,  # secret until the recap!
        }
        self.news.append(item)
        self.dirty = True
        return item

    def net_worth(self, p: Player) -> float:
        prices = self.market.prices()
        long_value = sum(p.holdings[c] * prices[c] for c in COMMODITY_IDS)
        short_value = sum(p.shorts[c] * prices[c] for c in COMMODITY_IDS)
        return p.cash + long_value - short_value - p.debt

    def draw_card(self) -> dict:
        types = list(config.CARD_WEIGHTS.keys())
        weights = list(config.CARD_WEIGHTS.values())
        return {"id": _uid(), "type": self.rng.choices(types, weights)[0]}

    # =====================================================================
    # Lobby: joining, leaving, starting
    # =====================================================================
    def join(self, name: str, token: str = None):
        """Returns (player, error_message). Handles rejoining too."""
        self.last_activity = self.clock()
        # 1) Reconnect with the secret token (same browser tab after refresh)
        if token:
            for p in self.players.values():
                if p.token == token:
                    p.connected = True
                    self._ensure_host()
                    self.dirty = True
                    return p, None

        name = " ".join((name or "").split())[:16]
        if not name:
            return None, "Please enter a name."

        # 2) Reconnect by name (e.g. tab was closed) if that trader is offline
        for p in self.players.values():
            if p.name.lower() == name.lower():
                if p.connected:
                    return None, "That name is already taken in this room."
                p.connected = True
                self._ensure_host()
                self.dirty = True
                return p, None

        # 3) Brand-new player — only allowed in the lobby
        if self.phase in ("countdown", "playing"):
            return None, "A match is in progress. Wait for it to finish, then join."
        if len(self.players) >= config.MAX_PLAYERS:
            return None, "This room is full."
        used = {p.color for p in self.players.values()}
        color = next((c for c in PLAYER_COLORS if c not in used), PLAYER_COLORS[0])
        p = Player(_uid(), name, secrets.token_urlsafe(16), color)
        self.players[p.id] = p
        self._ensure_host()
        self.dirty = True
        return p, None

    def _ensure_host(self):
        host = self.players.get(self.host_id)
        if host is None or not host.connected:
            online = self.connected_players()
            if online:
                self.host_id = online[0].id

    def disconnect(self, pid: str):
        p = self.players.get(pid)
        if not p:
            return
        p.connected = False
        self.last_activity = self.clock()
        if self.phase == "lobby":
            # Nobody's wallet is at stake yet, so simply drop them.
            del self.players[pid]
        self._ensure_host()
        self.dirty = True

    def start(self, pid: str) -> bool:
        """Host presses START. Returns True if the countdown began."""
        if pid != self.host_id:
            self.toast(pid, "Only the host can start the match.", "bad")
            return False
        if self.phase != "lobby":
            return False
        online = self.connected_players()
        if len(online) < config.MIN_PLAYERS:
            self.toast(pid, f"Need at least {config.MIN_PLAYERS} traders to start.", "bad")
            return False
        # Drop anyone who left the lobby
        self.players = {p.id: p for p in online}
        self._reset_match()
        for p in self.players.values():
            p.cards = [self.draw_card() for _ in range(config.STARTING_CARDS)]
        self.phase = "countdown"
        self.start_time = self.clock() + config.COUNTDOWN_SECONDS
        self._schedule_next_event(self.rng.uniform(config.EVENT_FIRST_MIN, config.EVENT_FIRST_MAX))
        self.send(None, self.history_message())  # fresh charts for the new match
        self.dirty = True
        return True

    def open_market(self):
        """Called by main.py when the countdown finishes."""
        self.phase = "playing"
        self.tick_index = 0
        self.add_news("system", "🔔 OPENING BELL — the colony market is open!")
        self.send(None, self.history_message())
        self.dirty = True

    def play_again(self, pid: str):
        if pid != self.host_id:
            self.toast(pid, "Only the host can restart.", "bad")
            return
        if self.phase != "ended":
            return
        # Remove traders who never came back
        self.players = {p.id: p for p in self.players.values() if p.connected}
        self._reset_match()
        self._ensure_host()
        self.dirty = True

    # =====================================================================
    # The clock: called once per TICK_SECONDS while playing
    # =====================================================================
    def tick(self):
        if self.phase != "playing":
            return
        t = self.now_t()
        self.tick_index += 1

        # Closing frenzy announcement
        frenzy = self.is_frenzy()
        if frenzy and not self.frenzy_announced:
            self.frenzy_announced = True
            self.add_news("system", "🚨 CLOSING FRENZY — volatility doubled until the bell!")

        # 1) Random drift
        mult = config.FRENZY_VOLATILITY_MULTIPLIER if frenzy else 1.0
        self.market.drift(mult)

        # 2) News, rumors, contracts, loans
        self._process_news(t)
        self._process_contracts(t)
        rate = config.LOAN_INTEREST_PER_MINUTE * config.TICK_SECONDS / 60
        for p in self.players.values():
            if p.debt > 0:
                p.debt *= 1 + rate

        # 3) Cornering, history, card milestones
        self._update_corners()
        self.market.record()
        self._check_milestones()
        self.dirty = True

        if t >= config.MATCH_SECONDS:
            self._finish()

    # ---- news ------------------------------------------------------------
    def _schedule_next_event(self, at: float):
        template = self.rng.choice(content.NEWS_EVENTS)
        jitter = 1 + self.rng.uniform(-config.EVENT_STRENGTH_JITTER, config.EVENT_STRENGTH_JITTER)
        effects = {cid: round(pct * jitter, 3) for cid, pct in template["effects"].items()}
        self.next_event = {"at": at, "headline": template["headline"], "effects": effects}
        # Sometimes the truth leaks early as an unconfirmed rumor
        if self.rng.random() < config.RUMOR_LEAK_CHANCE:
            main_cid = max(effects, key=lambda c: abs(effects[c]))
            direction = "up" if effects[main_cid] > 0 else "down"
            lead = self.rng.uniform(config.RUMOR_LEAK_LEAD_MIN, config.RUMOR_LEAK_LEAD_MAX)
            self.pending_leaks.append({"at": at - lead, "text": self._rumor_text(main_cid, direction)})

    def _rumor_text(self, cid: str, direction: str) -> str:
        name = config.COMMODITIES[cid]["name"]
        return self.rng.choice(content.RUMOR_TEMPLATES[direction]).format(name=name)

    def _process_news(self, t: float):
        # Leaked (true) rumors
        for leak in [l for l in self.pending_leaks if l["at"] <= t]:
            self.pending_leaks.remove(leak)
            self.add_news("rumor", leak["text"], unconfirmed=True, fake=False)
        # Headline time
        ev = self.next_event
        if ev and ev["at"] <= t:
            self.add_news("event", ev["headline"])
            self.pending_effects.append({"at": t + config.EVENT_DELAY_SECONDS, "effects": ev["effects"]})
            self._schedule_next_event(t + self.rng.uniform(config.EVENT_INTERVAL_MIN, config.EVENT_INTERVAL_MAX))
        # Prices react a couple of seconds after the headline
        for pe in [x for x in self.pending_effects if x["at"] <= t]:
            self.pending_effects.remove(pe)
            for cid, pct in pe["effects"].items():
                self.market.shock(cid, pct)

    # ---- contracts ---------------------------------------------------------
    def _process_contracts(self, t: float):
        for c in self.contracts:
            if c["status"] == "open" and t >= c["expires_at"]:
                c["status"] = "expired"
                self.add_news("contract", f"⌛ Contract expired: {c['qty']} {config.COMMODITIES[c['commodity']]['name']}")
        active = [c for c in self.contracts if c["status"] == "open"]
        if (t >= self.next_contract_at and len(active) < config.CONTRACT_MAX_ACTIVE
                and config.MATCH_SECONDS - t > 20):
            self._new_contract(t)
            self.next_contract_at = t + self.rng.uniform(config.CONTRACT_INTERVAL_MIN, config.CONTRACT_INTERVAL_MAX)

    def _new_contract(self, t: float):
        cid = self.rng.choice(COMMODITY_IDS)
        price = self.market[cid].price
        value = self.rng.uniform(config.CONTRACT_VALUE_MIN, config.CONTRACT_VALUE_MAX)
        qty = max(5, int(round(value / price / 5)) * 5)
        reward = int(round(qty * price * config.CONTRACT_REWARD_MULTIPLIER / 50)) * 50
        contract = {
            "id": _uid(), "commodity": cid, "qty": qty, "reward": reward,
            "created": round(t, 1), "expires_at": round(min(t + config.CONTRACT_DURATION, config.MATCH_SECONDS), 1),
            "status": "open", "winner": None,
        }
        self.contracts.append(contract)
        name = config.COMMODITIES[cid]["name"]
        self.add_news("contract", f"📦 New contract: deliver {qty} {name} within {config.CONTRACT_DURATION}s for {_money(reward)}")

    # ---- cornering ---------------------------------------------------------
    def _update_corners(self):
        """A player holding > CORNER_SHARE of all player-held units sets a floor."""
        for cid in COMMODITY_IDS:
            c = self.market[cid]
            total = sum(p.holdings[cid] for p in self.players.values())
            leader = max(self.players.values(), key=lambda p: p.holdings[cid], default=None)
            controls = (leader is not None and total * c.price >= config.CORNER_MIN_VALUE
                        and leader.holdings[cid] > config.CORNER_SHARE * total)
            if controls and c.corner_by != leader.id:
                c.corner_by = leader.id
                c.corner_floor = c.price * config.CORNER_FLOOR_RATIO
                self.add_news("system", f"👑 {leader.name} has cornered {c.name}! Price floor set at ${c.corner_floor:,.2f}")
            elif not controls and c.corner_by is not None:
                old = self.players.get(c.corner_by)
                c.corner_by = None
                c.corner_floor = 0.0
                if old:
                    self.add_news("system", f"{old.name} lost control of {c.name}.")

    def _check_milestones(self):
        for p in self.players.values():
            profit = self.net_worth(p) - config.STARTING_CASH
            while profit >= config.CARD_MILESTONE_STEP * (p.milestones + 1):
                p.milestones += 1
                if len(p.cards) < config.MAX_HAND:
                    card = self.draw_card()
                    p.cards.append(card)
                    info = content.CARD_INFO[card["type"]]
                    self.toast(p.id, f"🎉 Profit milestone! You earned a card: {info['icon']} {info['name']}", "good")

    # ---- closing bell ------------------------------------------------------
    def _finish(self):
        self.phase = "ended"
        prices = self.market.prices()
        results = []
        for p in self.players.values():
            long_value = sum(p.holdings[c] * prices[c] for c in COMMODITY_IDS)
            short_value = sum(p.shorts[c] * prices[c] for c in COMMODITY_IDS)
            penalty = p.debt * config.UNPAID_LOAN_PENALTY
            final = p.cash + long_value - short_value - p.debt - penalty
            results.append({
                "id": p.id, "name": p.name, "color": p.color,
                "cash": round(p.cash, 2), "holdings_value": round(long_value, 2),
                "shorts_value": round(short_value, 2), "debt": round(p.debt, 2),
                "penalty": round(penalty, 2), "final": round(final, 2),
                "trades": p.trade_count,
            })
        results.sort(key=lambda r: r["final"], reverse=True)
        self.results = results
        self.add_news("system", f"🔔 CLOSING BELL — {results[0]['name']} wins with {_money(results[0]['final'])}!" if results else "🔔 CLOSING BELL")
        self.dirty = True

    # =====================================================================
    # Player actions
    # =====================================================================
    def handle(self, pid: str, msg: dict):
        """Entry point for every message a client sends."""
        p = self.players.get(pid)
        if p is None or not isinstance(msg, dict):
            return
        self.last_activity = self.clock()
        kind = msg.get("type")
        if kind == "start":
            self.start(pid)
            return
        if kind == "play_again":
            self.play_again(pid)
            return
        if kind == "sync":
            self.send(pid, self.history_message())
            self.dirty = True
            return
        if kind != "action":
            return

        if self.phase != "playing":
            self.toast(pid, "The market is closed.", "bad")
            return
        action = msg.get("action")
        t = self.now_t()

        if action in TRADE_ACTIONS or action == "deliver":
            if p.frozen_until > t:
                self.toast(pid, f"🧊 You're frozen for {math.ceil(p.frozen_until - t)}s more!", "bad")
                return

        try:
            if action in TRADE_ACTIONS:
                cid = msg.get("commodity")
                if cid not in config.COMMODITIES:
                    raise ValueError("Unknown commodity.")
                qty = self._parse_qty(msg.get("qty"))
                getattr(self, f"_do_{action}")(p, cid, qty)
            elif action == "loan":
                self._do_loan(p)
            elif action == "repay":
                self._do_repay(p)
            elif action == "deliver":
                self._do_deliver(p, msg.get("contract"))
            elif action == "card":
                self._do_card(p, msg)
            else:
                raise ValueError("Unknown action.")
        except ValueError as err:
            self.toast(pid, str(err), "bad")
            return
        self._update_corners()
        self._check_milestones()
        self.dirty = True

    @staticmethod
    def _parse_qty(raw):
        if raw == "max":
            return "max"
        try:
            qty = int(raw)
        except (TypeError, ValueError):
            raise ValueError("Invalid quantity.")
        if qty <= 0 or qty > 1_000_000:
            raise ValueError("Invalid quantity.")
        return qty

    # ---- trading -----------------------------------------------------------
    def _max_affordable(self, cash: float, cid: str) -> int:
        """Largest qty whose cost (with price impact + fee) fits in `cash`."""
        price = self.market[cid].price
        hi = int(cash / (price * (1 + config.TRADE_FEE)))
        lo = 0
        while lo < hi:  # binary search
            mid = (lo + hi + 1) // 2
            avg, _ = self.market.quote(cid, mid, +1)
            if mid * avg * (1 + config.TRADE_FEE) <= cash:
                lo = mid
            else:
                hi = mid - 1
        return lo

    def _record_trade(self, p: Player, cid: str, side: str, qty: int, price: float):
        p.trade_count += 1
        value = qty * price
        if value >= config.BIG_TRADE_VALUE:
            self.big_trades.append({
                "t": round(max(0.0, self.now_t()), 1), "tick": self.tick_index,
                "player": p.id, "name": p.name, "color": p.color,
                "commodity": cid, "side": side, "qty": qty,
                "price": round(price, 2), "value": round(value, 2),
            })

    def _buy_units(self, p: Player, cid: str, qty: int, side: str):
        """Shared by BUY and COVER: pay cash, push the price up."""
        avg, new_price = self.market.quote(cid, qty, +1)
        cost = qty * avg * (1 + config.TRADE_FEE)
        if cost > p.cash + 1e-6:
            raise ValueError(f"Not enough cash (need {_money(cost)}).")
        p.cash -= cost
        self.market.set_price(cid, new_price)
        self._record_trade(p, cid, side, qty, avg)
        return avg, cost

    def _sell_units(self, p: Player, cid: str, qty: int, side: str):
        """Shared by SELL and SHORT: receive cash, push the price down."""
        avg, new_price = self.market.quote(cid, qty, -1)
        proceeds = qty * avg * (1 - config.TRADE_FEE)
        p.cash += proceeds
        self.market.set_price(cid, new_price)
        self._record_trade(p, cid, side, qty, avg)
        return avg, proceeds

    def _do_buy(self, p, cid, qty):
        if qty == "max":
            qty = self._max_affordable(p.cash, cid)
            if qty <= 0:
                raise ValueError("Not enough cash to buy even one unit.")
        avg, cost = self._buy_units(p, cid, qty, "buy")
        p.holdings[cid] += qty
        self.toast(p.id, f"Bought {qty} {self.market[cid].name} @ ${avg:,.2f} ({_money(cost)})", "good")

    def _do_sell(self, p, cid, qty):
        have = p.holdings[cid]
        if qty == "max":
            qty = have
        if have <= 0:
            raise ValueError(f"You don't hold any {self.market[cid].name}.")
        if qty > have:
            raise ValueError(f"You only hold {have} {self.market[cid].name}.")
        avg, proceeds = self._sell_units(p, cid, qty, "sell")
        p.holdings[cid] -= qty
        self.toast(p.id, f"Sold {qty} {self.market[cid].name} @ ${avg:,.2f} (+{_money(proceeds)})", "good")

    def _short_capacity_units(self, p, cid) -> int:
        """How many more units of `cid` this player may short right now."""
        prices = self.market.prices()
        exposure = sum(p.shorts[c] * prices[c] for c in COMMODITY_IDS)
        room = config.SHORT_LIMIT_RATIO * self.net_worth(p) - exposure
        return max(0, int(room / prices[cid]))

    def _do_short(self, p, cid, qty):
        cap = self._short_capacity_units(p, cid)
        if qty == "max":
            qty = cap
        if cap <= 0 or qty > cap:
            raise ValueError(f"Short limit reached (max {cap} more {self.market[cid].name}).")
        avg, proceeds = self._sell_units(p, cid, qty, "short")
        p.shorts[cid] += qty
        self.toast(p.id, f"Shorted {qty} {self.market[cid].name} @ ${avg:,.2f}", "good")

    def _do_cover(self, p, cid, qty):
        owed = p.shorts[cid]
        if owed <= 0:
            raise ValueError(f"You have no {self.market[cid].name} short to cover.")
        if qty == "max":
            qty = min(owed, self._max_affordable(p.cash, cid))
            if qty <= 0:
                raise ValueError("Not enough cash to cover.")
        if qty > owed:
            raise ValueError(f"You're only short {owed} {self.market[cid].name}.")
        avg, cost = self._buy_units(p, cid, qty, "cover")
        p.shorts[cid] -= qty
        self.toast(p.id, f"Covered {qty} {self.market[cid].name} @ ${avg:,.2f} ({_money(cost)})", "good")

    # ---- loans ---------------------------------------------------------------
    def _do_loan(self, p):
        if p.debt + config.LOAN_AMOUNT > config.MAX_DEBT + 1e-6:
            raise ValueError(f"Credit limit reached (max debt {_money(config.MAX_DEBT)}).")
        p.debt += config.LOAN_AMOUNT
        p.cash += config.LOAN_AMOUNT
        self.toast(p.id, f"🏦 Loan approved: +{_money(config.LOAN_AMOUNT)}. Interest {config.LOAN_INTEREST_PER_MINUTE:.0%}/min.", "info")

    def _do_repay(self, p):
        if p.debt <= 0:
            raise ValueError("You have no debt.")
        amount = min(p.cash, p.debt)
        if amount <= 0:
            raise ValueError("No cash to repay with.")
        p.cash -= amount
        p.debt -= amount
        if p.debt < 0.01:
            p.debt = 0.0
        self.toast(p.id, f"Repaid {_money(amount)}." + (" Debt cleared!" if p.debt == 0 else ""), "good")

    # ---- contracts -----------------------------------------------------------
    def _do_deliver(self, p, contract_id):
        c = next((c for c in self.contracts if c["id"] == contract_id), None)
        if c is None or c["status"] != "open":
            raise ValueError("That contract is no longer available.")
        if p.holdings[c["commodity"]] < c["qty"]:
            raise ValueError(f"You need {c['qty']} {config.COMMODITIES[c['commodity']]['name']} to deliver.")
        # Delivered goods leave the market (no price impact).
        p.holdings[c["commodity"]] -= c["qty"]
        p.cash += c["reward"]
        c["status"] = "done"
        c["winner"] = p.name
        self.add_news("contract", f"✅ {p.name} fulfilled the {config.COMMODITIES[c['commodity']]['name']} contract for {_money(c['reward'])}")
        self.toast(p.id, f"Contract fulfilled! +{_money(c['reward'])}", "good")

    # ---- cards -----------------------------------------------------------------
    def _do_card(self, p, msg):
        card = next((c for c in p.cards if c["id"] == msg.get("card")), None)
        if card is None:
            raise ValueError("You don't own that card.")
        ctype = card["type"]
        info = content.CARD_INFO[ctype]
        t = self.now_t()
        target = None

        # --- validate the choices BEFORE consuming the card ---
        if info["target"] == "player":
            target = self.players.get(msg.get("target"))
            if target is None or target.id == p.id:
                raise ValueError("Choose a rival to target.")
            if ctype == "audit" and target.id in p.audits:
                raise ValueError(f"You already audited {target.name}.")
        if info["target"] in ("commodity", "rumor") and msg.get("commodity") not in config.COMMODITIES:
            raise ValueError("Choose a commodity.")
        if info["target"] == "rumor" and msg.get("direction") not in ("up", "down"):
            raise ValueError("Choose a direction for the rumor.")
        if ctype == "shield" and p.shield:
            raise ValueError("Your shield is already up.")

        p.cards.remove(card)

        # --- shields block targeted cards ---
        if target is not None and target.shield:
            target.shield = False
            self.toast(p.id, f"🛡️ {target.name}'s shield blocked your {info['name']}!", "bad")
            self.toast(target.id, f"🛡️ Your shield blocked a {info['name']} from {p.name}!", "good")
            self._log_card(p, ctype, target, blocked=True)
            return

        if ctype == "insider":
            ev = self.next_event
            if ev is None or ev["at"] >= config.MATCH_SECONDS:
                tip = {"id": _uid(), "headline": "No more news expected before the closing bell.", "effects": {}, "at": None}
            else:
                # Guarantee at least INSIDER_LEAD_SECONDS of warning
                if ev["at"] - t < config.INSIDER_LEAD_SECONDS:
                    ev["at"] = t + config.INSIDER_LEAD_SECONDS
                tip = {"id": _uid(), "headline": ev["headline"], "effects": ev["effects"], "at": round(ev["at"], 1)}
            p.insider_tips.append(tip)
            self.toast(p.id, "🕵️ Insider tip received — check your news feed.", "good")

        elif ctype == "rumor":
            text = self._rumor_text(msg["commodity"], msg["direction"])
            self.add_news("rumor", text, unconfirmed=True, fake=True, author=p.name)
            self.toast(p.id, "📢 Your rumor is spreading…", "good")

        elif ctype == "freeze":
            target.frozen_until = max(target.frozen_until, t) + config.FREEZE_SECONDS
            self.add_news("system", f"🧊 {target.name} has been hit with a Trade Freeze!")
            self.toast(target.id, f"🧊 You've been frozen for {config.FREEZE_SECONDS}s!", "bad")
            self.toast(p.id, f"🧊 {target.name} is frozen.", "good")

        elif ctype == "spike":
            cid = msg["commodity"]
            self.market.shock(cid, config.PRICE_SPIKE, move_anchor=False)
            self.add_news("system", f"⚡ Sudden price spike in {self.market[cid].name}!")

        elif ctype == "audit":
            p.audits.append(target.id)
            self.toast(target.id, "🔍 Someone has audited your books!", "bad")
            self.toast(p.id, f"🔍 {target.name}'s books are now visible to you.", "good")

        elif ctype == "shield":
            p.shield = True
            self.toast(p.id, "🛡️ Shield up — the next card used on you will be blocked.", "good")

        self._log_card(p, ctype, target, commodity=msg.get("commodity"))

    def _log_card(self, p, ctype, target, blocked=False, commodity=None):
        self.card_log.append({
            "t": round(max(0.0, self.now_t()), 1), "player": p.name, "color": p.color,
            "card": content.CARD_INFO[ctype]["name"],
            "target": target.name if target else None,
            "commodity": config.COMMODITIES[commodity]["name"] if commodity in config.COMMODITIES else None,
            "blocked": blocked,
        })

    # =====================================================================
    # What clients see
    # =====================================================================
    def history_message(self) -> dict:
        return {"type": "history", "tick": self.tick_index, "history": self.market.history}

    def _public_news(self):
        """Hide whether rumors are fake / who wrote them — until the recap."""
        out = []
        for n in self.news[-config.NEWS_FEED_LENGTH:]:
            item = {k: n[k] for k in ("id", "t", "kind", "text", "unconfirmed")}
            out.append(item)
        return out

    def state_for(self, pid: str) -> dict:
        """The full personalised snapshot sent to one player."""
        me = self.players.get(pid)
        t = self.now_t()
        prices = self.market.prices()

        players = []
        for p in self.players.values():
            players.append({
                "id": p.id, "name": p.name, "color": p.color, "connected": p.connected,
                "net_worth": round(self.net_worth(p), 2),
                "frozen": self.phase == "playing" and p.frozen_until > t,
            })
        players.sort(key=lambda x: x["net_worth"], reverse=True)

        corners = {}
        for cid in COMMODITY_IDS:
            c = self.market[cid]
            owner = self.players.get(c.corner_by) if c.corner_by else None
            corners[cid] = {"player": owner.id, "name": owner.name, "color": owner.color,
                            "floor": round(c.corner_floor, 2)} if owner else None

        state = {
            "type": "state",
            "phase": self.phase,
            "code": self.code,
            "host_id": self.host_id,
            "you": pid,
            "t": round(t, 2),
            "remaining": round(self.remaining(), 2),
            "countdown": round(max(0.0, -t), 2) if self.phase == "countdown" else 0,
            "frenzy": self.is_frenzy(),
            "tick": self.tick_index,
            "prices": {cid: round(v, 2) for cid, v in prices.items()},
            "corners": corners,
            "players": players,
            "news": self._public_news(),
            "contracts": [dict(c) for c in self.contracts if c["status"] == "open" or t - c["expires_at"] < 10],
            "min_players": config.MIN_PLAYERS,
        }

        if me:
            state["me"] = {
                "cash": round(me.cash, 2),
                "holdings": dict(me.holdings),
                "shorts": dict(me.shorts),
                "debt": round(me.debt, 2),
                "net_worth": round(self.net_worth(me), 2),
                "cards": list(me.cards),
                "frozen_for": round(max(0.0, me.frozen_until - t), 1) if self.phase == "playing" else 0,
                "shield": me.shield,
                "short_capacity": {cid: self._short_capacity_units(me, cid) for cid in COMMODITY_IDS},
                "insider": [dict(tip, eta=None if tip["at"] is None else round(tip["at"] - t, 1))
                            for tip in me.insider_tips],
            }
            state["audits"] = []
            for aid in me.audits:
                a = self.players.get(aid)
                if a:
                    state["audits"].append({"id": a.id, "name": a.name, "color": a.color,
                                            "cash": round(a.cash, 2), "debt": round(a.debt, 2),
                                            "holdings": dict(a.holdings), "shorts": dict(a.shorts)})

        if self.phase == "ended":
            state["results"] = self.results
            state["recap"] = {
                "history": self.market.history,
                "trades": self.big_trades,
                "rumors": [{"t": n["t"], "text": n["text"], "fake": n["fake"], "author": n["author"]}
                           for n in self.news if n["kind"] == "rumor"],
                "events": [{"t": n["t"], "text": n["text"]} for n in self.news if n["kind"] == "event"],
                "cards": self.card_log,
            }
        return state
