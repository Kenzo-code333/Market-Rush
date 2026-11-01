# Market Rush — project guide

Browser-based online multiplayer trading game. 2–6 traders share one live
space-colony market for a 5-minute match; every trade moves the price for
everyone; richest trader at the closing bell wins.

## Stack

| Part      | Tech |
|-----------|------|
| Server    | Python 3.10+ · FastAPI · WebSockets (via `uvicorn[standard]`) |
| Client    | Plain HTML / CSS / JavaScript (ES modules, no build step) |
| Charts    | Hand-written `<canvas>` charts in `static/js/charts.js` (see "Decisions") |
| Tests     | `pytest` for rules, `tools/simulate.py` for full bot matches over WebSockets |

## Run it

```bash
pip install -r requirements.txt
python run.py
```

Open http://localhost:8000. To play several traders on one computer, open
the room link in several tabs. Each tab is a separate player, because identity is
kept in `sessionStorage`, which is per tab.

### Practice vs AI and the standalone preview

The home screen has a **🤖 Practice vs AI traders** button: you play alone against 1–5 AI
traders (add or remove them in the lobby). In this mode the game engine runs **in the
browser tab** (`static/js/solo-engine.js`), so it also works with no server at all:

```bash
python tools/build_preview.py      # -> dist/market-rush-preview.html (one self-contained file)
```

That single file is the shareable, playable preview. It contains the CSS, all JS and the
numbers from `config.py`/`content.py`. It offers only the practice mode, because
multiplayer needs the Python server.

Useful environment variables (all optional):

| Variable            | Effect |
|---------------------|--------|
| `PORT=9000`         | serve on another port |
| `MR_MATCH_SECONDS=60` | shorter matches for testing |
| `MR_MIN_PLAYERS=1`  | allow starting a match alone |

## Tests

```bash
python -m pytest -q                       # unit tests for the game rules (fast, no network)
MR_MATCH_SECONDS=40 python run.py         # in one terminal…
python tools/simulate.py --bots 6 --rounds 2   # …bots play full matches in another
```

`simulate.py` checks for things like negative cash, broken reconnects, missing
results and play-again resets. It exits with code 1 if anything is wrong.

## Architecture

```
run.py                 # single entry point: starts uvicorn on 0.0.0.0:8000
server/
  config.py            # ALL balance numbers (cash, impact, events, cards, timers…)
  content.py           # flavour text: news events, rumor templates, card descriptions
  market.py            # price engine: Commodity, Market (impact, drift, shocks, history)
  game.py              # rules: Player, Room (lobby, actions, cards, contracts, ticks, results)
  main.py              # FastAPI app: HTTP routes, WebSocket endpoint, per-room ticker task
static/
  index.html           # all screens: home, lobby, game terminal, recap
  style.css            # dark sci-fi terminal theme + animations
  js/app.js            # entry: connection/reconnect, screen switching, lobby, animation loop
  js/game.js           # GameView: the trading terminal (built once, updated in place)
  js/recap.js          # RecapView: winner, standings, chart replay, rumor truth, card log
  js/charts.js         # LiveChart (60fps interpolated) + RecapChart (animated replay)
  js/util.js           # DOM helper h(), formatting, number tweens, toasts, modal
  js/solo-engine.js    # practice mode: JS port of market.py + game.py, AI traders, LocalSocket
  js/coach.js          # beginner tips shown once each, when the situation first comes up
server/export_data.py  # config.py + content.py as JS (served at /solo-data.js, embedded by the build)
tools/build_preview.py # bundles everything into dist/market-rush-preview.html
tests/test_game.py     # pytest unit tests for the rules
tools/simulate.py      # bot players over real WebSockets
```

### Authoritative server

* The **server owns everything**: prices, wallets, cards and timers. The client sends
  *intents* such as `{"type":"action","action":"buy","commodity":"fuel","qty":10}` and
  only displays the state it receives.
* `game.Room` is **pure logic** with no network code. It receives actions through `handle()`,
  advances time with `tick()`, and writes outgoing messages to `room.outbox`, setting
  `room.dirty = True` when the screens need refreshing. `main.flush()` sends them out.
  This keeps the rules easy to unit-test with a fake clock.
* Every action is validated server-side: enough cash, enough holdings, card owned,
  valid target, not frozen, market open, short limit, credit limit, contract still open…
  Invalid actions are rejected with a red toast to that player only.
* All rooms run on one asyncio event loop, and room methods never `await`, so there are no
  race conditions and no locks are needed.

### Message protocol (JSON over WebSocket `/ws/{ROOM}`)

Client → server: `join {name, token}`, `start`, `play_again`, `sync`,
`action {action: buy|sell|short|cover|loan|repay|deliver|card, …}`.

Server → client: `welcome` (your id + token, commodities, card info, config),
`history` (full price history for the charts), `state` (personalised snapshot,
sent after every tick and every action), `toast`, `error`.

Secrets stay on the server until the recap: other players' holdings (unless audited),
whether a rumor is fake and who planted it, and insider tips.

### Timing

* `main.run_match` sleeps through the countdown, then calls `room.tick()` every
  `TICK_SECONDS`, scheduled against absolute times so the ticks don't drift.
* Trades are processed **immediately** when they arrive, and everyone gets a new state right away.

### Smoothness (client)

* Each screen's DOM is built **once**. Updates only change text, classes and attributes,
  with no `innerHTML` rebuilds, so buttons never flicker and hover states survive.
* One `requestAnimationFrame` loop drives everything. Charts interpolate between the
  1-second server ticks: the time axis scrolls continuously, the live price head eases
  to its new value, and the y-axis rescales gently.
* Net worths tween, leaderboard chips slide when ranks change (FLIP technique),
  news slides in, prices flash green or red.
* Animations stick to `transform`/`opacity`. `backdrop-filter` was removed from the panels
  because it cost about 15% of frame time.

### Reconnecting

* On join the server returns a secret **token**, which the tab keeps in `sessionStorage`. A refresh
  or a dropped connection reconnects automatically with that token, with backoff, and the
  wallet is untouched.
* If the tab was closed, joining again **with the same name** reclaims the offline trader.
* Mid-match, the leaderboard shows offline players as "offline". Their wallet stays in the game.

## Helping new players

Measured with headless matches (newcomer play styles vs AI traders), then addressed:

* **Coach** (`coach.js`): a tip box in the portfolio panel explains each mechanic the first time
  it matters: the goal, breaking news, contracts, rumors, cards, cornering, freezes, debt, frenzy.
  Each tip shows once per browser. "Hide tips" turns them off and "Show tips" replays them.
* **Cost preview**: hovering or focusing a BUY, SELL, SHORT or COVER button shows the estimated total,
  the price move, and a plain-language explanation. It warns when an order moves the price ≥ 8%.
  It uses the same formula as `market.quote`, with `liquidity`, `trade_fee` and `max_order_impact`
  sent in the welcome message.
* **Headline tags**: news events carry `commodities` (the goods affected, without direction), shown
  as colored chips. Before this, headlines like "mining boom" never named the commodity.
* **Contract BUY button**: one click buys exactly the units missing for a contract, then DELIVER.
  Contracts are the biggest money source (about $27k paid out per match), and newcomers used to miss them.
* **Practice difficulty** (`DIFFICULTY` in `solo-engine.js`): Easy is the default. Easy AIs trade 2.5× slower,
  with orders about ⅓ the size. They react to only 25% of headlines, don't borrow, wait 20 s before delivering a contract,
  and never target humans with Freeze or Audit. Normal and Hard are progressively sharper.
* **Fair AIs**: the AIs used to compare prices against the engine's *hidden* fair value. They now use
  the 30-second average of the visible chart, like a human would.

Results (40 matches each, rank out of 4, newcomer vs 3 AIs). The "contracts" style is a newcomer who uses the contract BUY button:

| Newcomer style   | Easy        | Normal      | Hard        |
|------------------|-------------|-------------|-------------|
| uses contracts   | 1.00 (40 wins) | 1.40 (28) | 2.08 (12) |
| reads headlines  | 1.70 (15)   | 3.25 (2)    | 3.52 (0)    |
| buys and holds   | 3.20 (2)    | 3.80 (0)    | 3.83 (0)    |

## Game rules (as implemented)

All numbers below are defaults from `server/config.py`.

* **Match**: 3-second countdown, then 300 s of trading. The last 30 s are the **closing frenzy**:
  random volatility × 2, a red pulsing UI.
* **Start**: $10,000 cash and 3 random cards each. 2–6 players.
* **Commodities**: Oxygen ($40), Water Ice ($25), Rare Metals ($220), Fuel ($80), Food ($15),
  each with its own volatility and liquidity.
* **Price impact**: `impact = min(qty × price / liquidity, 25%)`. Buying multiplies the price by
  `(1 + impact)` and selling divides it by `(1 + impact)`. The order fills at the **average** of the
  old and new price, plus a 0.5% fee, so splitting an order doesn't game the formula.
* **Drift**: each tick the price moves by a random ±volatility, plus a 3% pull back toward its
  "fair value". News moves the fair value (by half the shock). Player trades don't.
* **Floor**: a price can never fall below 10% of its starting price.
* **News**: an event every 20–40 s, with the first one at 15–25 s. The headline appears first and prices
  move 2 s later. 35% of real events leak 5–10 s early as an UNCONFIRMED rumor.
* **Short selling**: sell units you don't own. You receive the cash, and the position is
  marked against you at the current price. Total short exposure ≤ 100% of net worth.
  "Cover" buys the units back. Open shorts are closed automatically at the final price.
  **Margin call**: if your short exposure later grows past 150% of your net worth (checked each tick), all your
  shorts are force-closed at market. Any cost beyond your cash is added to your debt.
* **Loans**: $5,000 per click, max debt $10,000, 5% interest per minute (compounded each tick).
  "Repay" pays as much as your cash allows. Debt still unpaid at the bell is subtracted, plus a 10% penalty.
* **Cornering**: hold more than 50% of all player-held units of a commodity, with those units
  worth at least $3,000 in total, and you control it. That sets a price floor at 90% of the
  price when you took control. The floor lasts while you keep control. The chart shows a gold dashed line
  and "👑 Name controls".
* **Cards** (max hand 6; +1 card each time net worth passes $12,500, $15,000, $17,500…):
  * 🕵️ **Insider Tip**: privately see the next news event and its exact effects. If it was
    due in less than 15 s, it is delayed to 15 s.
  * 📢 **Fake Rumor**: pick a commodity and a direction. A plausible headline appears in everyone's feed
    tagged UNCONFIRMED. It looks exactly like a leaked real rumor.
  * 🧊 **Trade Freeze**: the target can't trade or deliver for 10 s. They can still play cards.
  * ⚡ **Price Spike**: a commodity jumps +20% instantly. Fair value doesn't move, so it fades.
  * 🔍 **Audit**: see the target's cash, debt, holdings and shorts for the rest of the match.
  * 🛡️ **Shield**: activate it, and the next targeted card used on you is blocked.
* **Contracts**: the first appears at 20 s, then one every 30–50 s, with at most 2 open at once. Each asks for goods
  worth $1,500–4,000 at creation, rewards 1.5× that value, and lasts 60 s. The first trader to deliver wins.
  Delivered goods leave your holdings and the market. Delivery has no price impact.
* **Closing bell**: final = cash + holdings × final price − shorts × final price − debt − 10% debt penalty.
* **Recap**: winner, a standings breakdown, an animated replay of each commodity chart with markers for
  every trade ≥ $1,500 (▲ buy/cover, ▼ sell/short, in the player's color, hover for details), news
  events as dashed lines, every rumor revealed as TRUE or FAKE (with its author), and a log of
  every card played. The host can start a new round with the same room.

## Decisions taken where the brief was ambiguous

* **Charting**: custom canvas instead of Chart.js or uPlot. Interpolating between 1-second ticks
  at 60fps is the core of the "smooth" feel, and that is simpler to write directly in about 150 lines. It also
  means there are no CDN or dependency downloads, so the game works offline on a LAN.
* **Shield** is played (activated) explicitly, rather than triggering automatically from your hand.
* **"Rumors" in the feed**: both leaks of real events and player-planted fakes are tagged
  UNCONFIRMED and use the same templates, so a rumor alone tells you nothing.
* **Unpaid loans**: debt always counts against net worth. To make "must be repaid" matter, unpaid
  debt at the bell also costs a 10% penalty.
* **Cornering threshold** is measured in dollar value (`CORNER_MIN_VALUE`) rather than units, so
  the rule is fair across cheap and expensive commodities.
* **Contract rewards** scale with market value (1.5×), not fixed amounts like the "$8,000" example,
  so they stay balanced as prices move.
* **Late joiners**: new players can join only in the lobby (or on the recap screen, ready for
  the next round). During a match, only reconnections are accepted.
* **Lobby leavers** are dropped immediately because they have no wallet yet. Mid-match leavers keep their wallet.
* **Host** is the room creator. If the host disconnects, the next connected player becomes host.
* **Trade freeze** blocks buy, sell, short, cover and contract delivery, but not cards or loans.
* Empty rooms are deleted after 10 minutes of inactivity.
* **Practice mode engine** is a JavaScript translation of `market.py` + `game.py`, using the same
  method names. It reads all numbers from `config.py` (through `export_data.py`), so balance
  tweaks apply to both modes. **Rule changes** in `game.py`, however, must be mirrored by hand in
  `solo-engine.js`. The Python server stays the reference for multiplayer.
* **AI traders** have personalities: Kepler buys below fair value, Juno chases momentum, Rhea trades
  headlines and contracts, Atlas makes big orders and borrows, and Lyra plays cards and rumors. They only see what a
  human sees (prices, headlines, rumors, contracts), plus their own insider tips.
* **Margin call** (not in the brief): added after bot testing showed uncapped shorts could reach
  −$800k when prices were pumped. It keeps "losses grow if it rises" without allowing absurd blow-ups.
* **Mean reversion** was raised from 1% to 3% per tick for the same reason: sustained buying pressure
  inflated prices 5–10×. Now a pump fades within about 20–30 s, but news still moves fair value durably.
