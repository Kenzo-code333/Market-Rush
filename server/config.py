"""
Market Rush — GAME BALANCE CONFIG
=================================

Every tunable number in the game lives in this file. Change a value,
restart the server, and the new balance takes effect.

Times are in SECONDS, money is in DOLLARS, percentages are written as
fractions (0.20 == 20%).
"""

import os

# ---------------------------------------------------------------------------
# Match flow
# ---------------------------------------------------------------------------
# Length of a match. Can be overridden with the MR_MATCH_SECONDS environment
# variable (handy for quick tests: MR_MATCH_SECONDS=60 python run.py).
MATCH_SECONDS = int(os.environ.get("MR_MATCH_SECONDS", 300))
COUNTDOWN_SECONDS = 3            # "Opening bell" countdown after host presses start
CLOSING_FRENZY_SECONDS = 30      # last N seconds = closing frenzy
FRENZY_VOLATILITY_MULTIPLIER = 2.0
TICK_SECONDS = 1.0               # how often the server moves prices / checks timers

MIN_PLAYERS = int(os.environ.get("MR_MIN_PLAYERS", 2))  # players needed to start
MAX_PLAYERS = 6

# ---------------------------------------------------------------------------
# Wallet
# ---------------------------------------------------------------------------
STARTING_CASH = 10_000
TRADE_FEE = 0.005                # 0.5% fee on every buy/sell/short/cover

# ---------------------------------------------------------------------------
# Commodities
#   start_price : opening price
#   volatility  : std-dev of the random drift per tick (0.01 == ±1%)
#   liquidity   : how many dollars of trading it takes to move the price 100%.
#                 Lower liquidity => player orders move the price more.
# ---------------------------------------------------------------------------
COMMODITIES = {
    "oxygen": {"name": "Oxygen",      "icon": "O₂", "start_price": 40.0,  "volatility": 0.008, "liquidity": 40_000, "color": "#4fd1ff"},
    "water":  {"name": "Water Ice",   "icon": "H₂O", "start_price": 25.0,  "volatility": 0.006, "liquidity": 45_000, "color": "#8be9fd"},
    "metals": {"name": "Rare Metals", "icon": "Rm", "start_price": 220.0, "volatility": 0.018, "liquidity": 30_000, "color": "#c792ea"},
    "fuel":   {"name": "Fuel",        "icon": "Fu", "start_price": 80.0,  "volatility": 0.014, "liquidity": 35_000, "color": "#ffb86c"},
    "food":   {"name": "Food",        "icon": "Fd", "start_price": 15.0,  "volatility": 0.010, "liquidity": 40_000, "color": "#50fa7b"},
}

# Price model
PRICE_FLOOR_FRACTION = 0.10      # a price can never drop below 10% of its starting price
MAX_ORDER_IMPACT = 0.25          # one single order can move the price by at most 25%
MEAN_REVERSION = 0.01            # each tick, price is pulled 1% of the way back to its "fair value"
EVENT_ANCHOR_SHARE = 0.5         # share of a news shock that permanently moves the fair value

# ---------------------------------------------------------------------------
# News events
# ---------------------------------------------------------------------------
EVENT_FIRST_MIN = 15             # first event happens between these times
EVENT_FIRST_MAX = 25
EVENT_INTERVAL_MIN = 20          # then one every 20–40 seconds
EVENT_INTERVAL_MAX = 40
EVENT_DELAY_SECONDS = 2          # headline appears, prices react this long after
EVENT_STRENGTH_JITTER = 0.25     # each event's effect is randomly scaled ±25%
RUMOR_LEAK_CHANCE = 0.35         # chance a REAL event is pre-leaked as an "unconfirmed" rumor
RUMOR_LEAK_LEAD_MIN = 5          # ...this many seconds before the real headline
RUMOR_LEAK_LEAD_MAX = 10

# ---------------------------------------------------------------------------
# Short selling
# ---------------------------------------------------------------------------
SHORT_BUTTON_QTY = 10            # units per click on the "Short" button
SHORT_LIMIT_RATIO = 1.0          # total short exposure can't exceed 100% of your net worth

# ---------------------------------------------------------------------------
# Loans
# ---------------------------------------------------------------------------
LOAN_AMOUNT = 5_000              # cash per "Take loan" click
MAX_DEBT = 10_000                # can't borrow if debt would exceed this
LOAN_INTEREST_PER_MINUTE = 0.05  # 5% per minute, compounded every tick
UNPAID_LOAN_PENALTY = 0.10       # unpaid debt at the closing bell costs an extra 10%

# ---------------------------------------------------------------------------
# Cornering
# ---------------------------------------------------------------------------
CORNER_SHARE = 0.5               # hold MORE than 50% of all player-held units...
CORNER_MIN_VALUE = 3_000         # ...(and all player-held units together must be worth at least $3,000)
CORNER_FLOOR_RATIO = 0.90        # ...to set a price floor at 90% of the price when you took control

# ---------------------------------------------------------------------------
# Secret cards
# ---------------------------------------------------------------------------
STARTING_CARDS = 3
MAX_HAND = 6
CARD_MILESTONE_STEP = 2_500      # earn a card each time net worth passes start + N×2,500
INSIDER_LEAD_SECONDS = 15        # Insider Tip shows the next event at least this early
FREEZE_SECONDS = 10              # Trade Freeze duration
PRICE_SPIKE = 0.20               # Price Spike pushes a commodity up 20%
CARD_WEIGHTS = {                 # relative chance of drawing each card
    "insider": 1.0,
    "rumor": 1.0,
    "freeze": 1.0,
    "spike": 1.0,
    "audit": 1.0,
    "shield": 1.0,
}

# ---------------------------------------------------------------------------
# Contracts
# ---------------------------------------------------------------------------
CONTRACT_FIRST_AT = 20           # first contract appears at t=20s
CONTRACT_INTERVAL_MIN = 30       # then a new one every 30–50 seconds
CONTRACT_INTERVAL_MAX = 50
CONTRACT_DURATION = 60           # seconds to fulfil it
CONTRACT_MAX_ACTIVE = 2
CONTRACT_VALUE_MIN = 1_500       # market value of the goods requested (at creation)
CONTRACT_VALUE_MAX = 4_000
CONTRACT_REWARD_MULTIPLIER = 1.5 # reward = market value × 1.5

# ---------------------------------------------------------------------------
# Recap / misc
# ---------------------------------------------------------------------------
BIG_TRADE_VALUE = 1_500          # trades at least this big get a marker on the recap chart
NEWS_FEED_LENGTH = 40            # how many news items clients receive
CHART_WINDOW_SECONDS = 90        # live charts show the last N seconds
ROOM_IDLE_TIMEOUT = 600          # empty rooms are deleted after 10 minutes
