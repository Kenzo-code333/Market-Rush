"""
Build a single-file, server-free preview of Market Rush.

    python tools/build_preview.py            # -> dist/market-rush-preview.html

The output is one HTML file containing the CSS, all JS modules and the
balance data from server/config.py + server/content.py. It runs the
"Practice vs AI" mode: the game engine (static/js/solo-engine.js) runs in
the browser, so no Python server is needed. Multiplayer still needs
`python run.py`.

The file is written as a page *fragment* (no <html>/<head>/<body>), the
format claude.ai Artifacts expect; browsers open it fine as-is too.
"""

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from server.export_data import game_data_js  # noqa: E402

STATIC = ROOT / "static"
# Dependency order: each module only uses names defined above it.
MODULES = ["util.js", "charts.js", "coach.js", "game.js", "recap.js", "solo-engine.js", "app.js"]


def bundle_js() -> str:
    """Concatenate the ES modules into one script (imports/exports removed)."""
    parts = []
    for name in MODULES:
        src = (STATIC / "js" / name).read_text(encoding="utf-8")
        src = re.sub(r"^import .*? from .*?;\s*$", "", src, flags=re.M)
        src = re.sub(r"^export (?=(async )?function|class|const|let)", "", src, flags=re.M)
        parts.append(f"// ---------------- {name} ----------------\n{src}")
    # One function scope keeps everything private, like modules do.
    return "(() => {\n\"use strict\";\n" + "\n".join(parts) + "\n})();\n"


def build() -> Path:
    html = (STATIC / "index.html").read_text(encoding="utf-8")
    css = (STATIC / "style.css").read_text(encoding="utf-8")
    body = re.search(r"<body>(.*)</body>", html, flags=re.S).group(1)
    # Drop the server-only script tags; the bundle replaces them.
    body = re.sub(r'\s*<script[^>]*src="[^"]*"[^>]*></script>', "", body)
    fonts = re.search(r'<link href="https://fonts.googleapis.com[^"]*" rel="stylesheet">', html).group(0)

    page = f"""<title>Market Rush</title>
<meta name="description" content="Space-colony commodities trading game — practice vs AI traders">
{fonts}
<style>
{css}
</style>
{body.strip()}
<script>
{game_data_js()}window.MR_STANDALONE = true;
{bundle_js()}</script>
"""
    out = ROOT / "dist" / "market-rush-preview.html"
    out.parent.mkdir(exist_ok=True)
    out.write_text(page, encoding="utf-8")
    return out


if __name__ == "__main__":
    path = build()
    print(f"Built {path.relative_to(ROOT)} ({path.stat().st_size / 1024:.0f} KB)")
