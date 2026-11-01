"""
Export the balance numbers (config.py) and texts (content.py) as JavaScript.

The in-browser solo engine (static/js/solo-engine.js) reads them from
`window.MR_DATA`, so config.py stays the single place to tweak the game,
whether you play on the Python server or in the standalone preview.
"""

import json

from . import config, content


def game_data() -> dict:
    cfg = {name: getattr(config, name) for name in dir(config) if name.isupper()}
    txt = {name: getattr(content, name) for name in dir(content) if name.isupper()}
    return {"config": cfg, "content": txt}


def game_data_js() -> str:
    return "window.MR_DATA = " + json.dumps(game_data(), ensure_ascii=False) + ";\n"
