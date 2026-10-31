"""
Market Rush — the price engine.

A `Market` holds one `Commodity` per tradable good. It knows how to:
  * quote the price impact of an order (without executing it),
  * apply random drift each tick,
  * apply news shocks,
  * record a price history for the charts and the recap screen.

It knows NOTHING about players or money — that lives in game.py.
"""

import random

from . import config


class Commodity:
    """One tradable good and its current price."""

    def __init__(self, cid: str, spec: dict):
        self.id = cid
        self.name = spec["name"]
        self.start_price = spec["start_price"]
        self.volatility = spec["volatility"]
        self.liquidity = spec["liquidity"]

        self.price = self.start_price
        # "Fair value": random drift slowly pulls the price back towards it.
        # News events move it; player trades do not.
        self.anchor = self.start_price

        # Cornering (see game.py): who controls it and the floor they set.
        self.corner_by = None       # player id or None
        self.corner_floor = 0.0

    @property
    def floor(self) -> float:
        """Lowest price allowed right now (global floor or cornering floor)."""
        return max(self.start_price * config.PRICE_FLOOR_FRACTION, self.corner_floor)

    def clamp(self, price: float) -> float:
        """Make sure a price never goes below the floor."""
        return max(self.floor, price)


class Market:
    def __init__(self, rng: random.Random):
        self.rng = rng
        self.commodities = {cid: Commodity(cid, spec) for cid, spec in config.COMMODITIES.items()}
        # history[cid][i] = price at the end of tick i (index 0 = opening price)
        self.history = {cid: [round(c.price, 2)] for cid, c in self.commodities.items()}

    def __getitem__(self, cid: str) -> Commodity:
        return self.commodities[cid]

    def prices(self) -> dict:
        return {cid: c.price for cid, c in self.commodities.items()}

    # -- orders -------------------------------------------------------------
    def quote(self, cid: str, qty: int, direction: int):
        """
        Work out what happens if someone trades `qty` units.

        direction = +1 for buying (price goes up), -1 for selling (price goes down).

        Formula (simple + tunable):
            impact    = min(order_value / liquidity, MAX_ORDER_IMPACT)
            buying:   new_price = price × (1 + impact)
            selling:  new_price = price ÷ (1 + impact)
        The order fills at the AVERAGE of the old and new price, so one big
        order costs about the same as many small ones.

        Returns (average_fill_price, new_price). Does not change anything.
        """
        c = self.commodities[cid]
        p = c.price
        impact = min(qty * p / c.liquidity, config.MAX_ORDER_IMPACT)
        if direction > 0:
            new_price = p * (1 + impact)
        else:
            new_price = c.clamp(p / (1 + impact))
        return (p + new_price) / 2, new_price

    def set_price(self, cid: str, price: float):
        c = self.commodities[cid]
        c.price = c.clamp(price)

    # -- per-tick movement ----------------------------------------------------
    def drift(self, volatility_multiplier: float = 1.0):
        """Small random walk + gentle pull back to fair value."""
        for c in self.commodities.values():
            noise = self.rng.gauss(0, c.volatility * volatility_multiplier)
            reversion = config.MEAN_REVERSION * (c.anchor - c.price) / c.price
            c.price = c.clamp(c.price * (1 + noise + reversion))

    def shock(self, cid: str, pct: float, move_anchor: bool = True):
        """Move a price by `pct` (0.2 == +20%). News also moves fair value."""
        c = self.commodities[cid]
        c.price = c.clamp(c.price * (1 + pct))
        if move_anchor:
            c.anchor = max(c.start_price * config.PRICE_FLOOR_FRACTION,
                           c.anchor * (1 + pct * config.EVENT_ANCHOR_SHARE))

    def record(self):
        """Append the current prices to the history (once per tick)."""
        for cid, c in self.commodities.items():
            self.history[cid].append(round(c.price, 2))
