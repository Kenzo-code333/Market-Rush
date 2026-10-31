"""
Market Rush — flavour text: news events, rumor templates and card descriptions.

Adding a news event is as simple as appending a dict to NEWS_EVENTS.
`effects` maps a commodity id (see config.COMMODITIES) to a percentage change:
+0.40 means "+40%", -0.25 means "-25%".
"""

from . import config

NEWS_EVENTS = [
    {"headline": "Solar storm on Mars: fuel demand doubles", "effects": {"fuel": +0.40}},
    {"headline": "Hydroponics blight sweeps Ganymede farms", "effects": {"food": +0.45}},
    {"headline": "Bumper harvest in the Titan greenhouses", "effects": {"food": -0.30}},
    {"headline": "Comet capture delivers 2 million tonnes of ice", "effects": {"water": -0.35}},
    {"headline": "Europa drilling rig collapses — ice exports halted", "effects": {"water": +0.45}},
    {"headline": "Oxygen scrubber recall on all Ares-class habitats", "effects": {"oxygen": +0.40}},
    {"headline": "New algae reactors flood colony with cheap oxygen", "effects": {"oxygen": -0.30}},
    {"headline": "Asteroid 16 Psyche mining boom begins", "effects": {"metals": -0.35}},
    {"headline": "Quantum chip fab on Phobos orders record metal haul", "effects": {"metals": +0.45}},
    {"headline": "Fusion breakthrough: ships burn half the fuel", "effects": {"fuel": -0.35}},
    {"headline": "Pirates raid fuel convoy near the Belt", "effects": {"fuel": +0.30, "metals": +0.10}},
    {"headline": "Colony population boom: 10,000 settlers arrive", "effects": {"food": +0.25, "oxygen": +0.20, "water": +0.15}},
    {"headline": "Dust storm grounds all surface haulers", "effects": {"water": +0.20, "metals": +0.15, "food": +0.10}},
    {"headline": "Terraforming milestone: atmosphere thickens", "effects": {"oxygen": -0.25, "water": -0.10}},
    {"headline": "Interplanetary trade treaty slashes tariffs", "effects": {"metals": -0.15, "food": -0.15, "fuel": -0.15}},
    {"headline": "Reactor leak on Deimos — emergency evacuation", "effects": {"fuel": +0.25, "oxygen": +0.25}},
    {"headline": "Earth embargo on colony goods announced", "effects": {"metals": -0.25, "water": -0.15}},
    {"headline": "Megacorp Helion buys every metal contract in sight", "effects": {"metals": +0.35}},
    {"headline": "Ice-mining strike enters its third week", "effects": {"water": +0.30}},
    {"headline": "Synthetic protein vats go online", "effects": {"food": -0.30}},
    {"headline": "Life-support audit finds oxygen reserves overstated", "effects": {"oxygen": +0.35}},
    {"headline": "Solar sail freighters make fuel obsolete for cargo", "effects": {"fuel": -0.25}},
]

# Rumor templates. Used for player "Fake Rumor" cards AND for leaks of real
# events — so a headline tagged UNCONFIRMED might be true... or might not.
RUMOR_TEMPLATES = {
    "up": [
        "Dockworkers whisper of a {name} shortage on Ceres",
        "Insiders say a megacorp is quietly hoarding {name}",
        "Leaked memo hints {name} quotas will be slashed",
        "Unverified: {name} reserves contaminated at Habitat 7",
        "Sources claim the {name} supply ship went dark",
    ],
    "down": [
        "Unverified: massive {name} shipment inbound from Europa",
        "Rumor: new tech makes {name} stockpiles worthless",
        "Traders hear {name} demand is collapsing in the outer rings",
        "Whispers of a {name} glut at Olympus Dock",
        "Sources say the colony council will dump {name} reserves",
    ],
}

# Card descriptions shown to players. "target" tells the client which
# extra choice to ask for when the card is played:
#   None        -> no choice, play immediately
#   "player"    -> pick a rival
#   "commodity" -> pick a commodity
#   "rumor"     -> pick a commodity + direction (up/down)
CARD_INFO = {
    "insider": {
        "name": "Insider Tip", "icon": "🕵️", "target": None,
        "desc": f"Privately see the next news event at least {config.INSIDER_LEAD_SECONDS}s before it hits.",
    },
    "rumor": {
        "name": "Fake Rumor", "icon": "📢", "target": "rumor",
        "desc": "Post a false headline in everyone's feed, tagged UNCONFIRMED.",
    },
    "freeze": {
        "name": "Trade Freeze", "icon": "🧊", "target": "player",
        "desc": f"Lock a rival out of trading for {config.FREEZE_SECONDS} seconds.",
    },
    "spike": {
        "name": "Price Spike", "icon": "⚡", "target": "commodity",
        "desc": f"Instantly push one commodity up {int(config.PRICE_SPIKE * 100)}%.",
    },
    "audit": {
        "name": "Audit", "icon": "🔍", "target": "player",
        "desc": "Reveal a rival's holdings for the rest of the match.",
    },
    "shield": {
        "name": "Shield", "icon": "🛡️", "target": None,
        "desc": "Activate to block the next card a rival uses on you.",
    },
}
