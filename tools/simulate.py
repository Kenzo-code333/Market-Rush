"""
Simulate a full Market Rush match with bot players over real WebSockets.

Usage (with the server already running):
    python tools/simulate.py                 # 4 bots, localhost:8000
    python tools/simulate.py --bots 6 --url http://localhost:8000

Each bot trades randomly, takes loans, plays cards and delivers contracts.
One bot disconnects mid-match and rejoins with its token to check the
wallet survives. The script exits with code 1 if anything looks wrong.

Tip: start the server with a short match for quick runs:
    MR_MATCH_SECONDS=40 python run.py
"""

import argparse
import asyncio
import json
import random
import sys
import urllib.request

import websockets

ERRORS = []


class Bot:
    def __init__(self, name, ws_url):
        self.name = name
        self.ws_url = ws_url
        self.state = None
        self.welcome = None
        self.toasts = []
        self.ws = None
        self.token = None

    async def connect(self):
        self.ws = await websockets.connect(self.ws_url)
        await self.ws.send(json.dumps({"type": "join", "name": self.name, "token": self.token}))
        self.reader = asyncio.create_task(self.read())

    async def read(self):
        try:
            async for raw in self.ws:
                msg = json.loads(raw)
                if msg["type"] == "welcome":
                    self.welcome = msg
                    self.token = msg["token"]
                elif msg["type"] == "state":
                    self.state = msg
                elif msg["type"] == "toast":
                    self.toasts.append(msg)
                elif msg["type"] == "error":
                    ERRORS.append(f"{self.name}: server error {msg['text']}")
        except websockets.ConnectionClosed:
            pass

    async def send(self, obj):
        try:
            await self.ws.send(json.dumps(obj))
        except websockets.ConnectionClosed:
            pass

    async def act_randomly(self):
        s = self.state
        if not s or s["phase"] != "playing" or "me" not in s:
            return
        me = s["me"]
        cids = list(s["prices"])
        cid = random.choice(cids)
        roll = random.random()
        if roll < 0.35:
            await self.send({"type": "action", "action": "buy", "commodity": cid, "qty": random.choice([1, 10, 25, "max"])})
        elif roll < 0.6:
            held = [c for c in cids if me["holdings"][c] > 0]
            if held:
                await self.send({"type": "action", "action": "sell", "commodity": random.choice(held), "qty": random.choice([1, 10, "max"])})
        elif roll < 0.68:
            await self.send({"type": "action", "action": "short", "commodity": cid, "qty": 10})
        elif roll < 0.74:
            shorted = [c for c in cids if me["shorts"][c] > 0]
            if shorted:
                await self.send({"type": "action", "action": "cover", "commodity": random.choice(shorted), "qty": "max"})
        elif roll < 0.78:
            await self.send({"type": "action", "action": random.choice(["loan", "repay"])})
        elif roll < 0.86 and me["cards"]:
            card = random.choice(me["cards"])
            rivals = [p["id"] for p in s["players"] if p["id"] != s["you"]]
            await self.send({"type": "action", "action": "card", "card": card["id"],
                             "target": random.choice(rivals) if rivals else None,
                             "commodity": cid, "direction": random.choice(["up", "down"])})
        else:
            for c in s["contracts"]:
                if c["status"] == "open":
                    if me["holdings"][c["commodity"]] >= c["qty"]:
                        await self.send({"type": "action", "action": "deliver", "contract": c["id"]})
                    else:  # try to buy what's needed
                        need = c["qty"] - me["holdings"][c["commodity"]]
                        await self.send({"type": "action", "action": "buy", "commodity": c["commodity"], "qty": need})
        # Garbage input should never crash anything
        if random.random() < 0.02:
            await self.send({"type": "action", "action": "buy", "commodity": "unobtainium", "qty": -5})
            await self.ws.send("not json at all")


def check_state(bot):
    s = bot.state
    if not s or "me" not in s:
        return
    me = s["me"]
    if me["cash"] < -0.01:
        ERRORS.append(f"{bot.name}: negative cash {me['cash']}")
    for cid, q in me["holdings"].items():
        if q < 0:
            ERRORS.append(f"{bot.name}: negative holdings {cid}={q}")
    for cid, p in s["prices"].items():
        if p <= 0:
            ERRORS.append(f"price of {cid} is {p}")


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://localhost:8000")
    ap.add_argument("--bots", type=int, default=4)
    ap.add_argument("--rounds", type=int, default=1, help="matches to play in the same room")
    args = ap.parse_args()

    req = urllib.request.Request(args.url + "/api/rooms", method="POST")
    code = json.loads(urllib.request.urlopen(req).read())["code"]
    ws_url = args.url.replace("http", "ws") + f"/ws/{code}"
    print(f"Room {code} — open {args.url}/?room={code} in a browser to watch.")

    bots = [Bot(n, ws_url) for n in ["Ada", "Boris", "Cleo", "Dax", "Eve", "Finn"][: args.bots]]
    for b in bots:
        await b.connect()
    await asyncio.sleep(0.5)

    host = bots[0]
    for rnd in range(args.rounds):
        await host.send({"type": "start"})
        await asyncio.sleep(0.5)
        assert host.state["phase"] in ("countdown", "playing"), host.state["phase"]
        match_seconds = host.welcome["config"]["match_seconds"]
        print(f"Round {rnd + 1}: match started ({match_seconds}s)")

        dropped = False
        while host.state["phase"] != "ended":
            for b in bots:
                if b.ws.state.name == "OPEN" and random.random() < 0.6:
                    await b.act_randomly()
                check_state(b)
            # Disconnect + rejoin test, halfway through
            s = host.state
            if not dropped and s["phase"] == "playing" and s["t"] > match_seconds / 2:
                dropped = True
                victim = bots[-1]
                before = victim.state["me"]
                await victim.ws.close()
                await asyncio.sleep(1.5)
                offline = [p for p in host.state["players"] if p["name"] == victim.name][0]
                if offline["connected"]:
                    ERRORS.append("dropped player still shown as connected")
                await victim.connect()
                await asyncio.sleep(0.5)
                after = victim.state["me"]
                if after["holdings"] != before["holdings"]:
                    ERRORS.append("holdings changed across reconnect")
                print(f"  {victim.name} disconnected and rejoined — wallet kept "
                      f"(cash {before['cash']:.0f} -> {after['cash']:.0f})")
            await asyncio.sleep(0.15)

        await asyncio.sleep(0.5)
        s = host.state
        results = s["results"]
        print("  Final standings:")
        for i, r in enumerate(results, 1):
            print(f"   {i}. {r['name']:<6} ${r['final']:>10,.2f}  (trades: {r['trades']}, debt {r['debt']:.0f})")
        recap = s["recap"]
        n_hist = len(next(iter(recap["history"].values())))
        print(f"  Recap: {n_hist} price points, {len(recap['trades'])} big trades, "
              f"{len(recap['rumors'])} rumors ({sum(r['fake'] for r in recap['rumors'])} fake), "
              f"{len(recap['events'])} events, {len(recap['cards'])} cards played")
        if n_hist < match_seconds:
            ERRORS.append(f"history too short: {n_hist}")
        if len(results) != len(bots):
            ERRORS.append("results missing players")
        bad = [t["text"] for b in bots for t in b.toasts if t["level"] == "bad"]
        print(f"  {len(bad)} rejected actions (expected: bots try invalid things), e.g. {bad[:3]}")

        if rnd + 1 < args.rounds:
            await host.send({"type": "play_again"})
            await asyncio.sleep(0.5)
            if host.state["phase"] != "lobby":
                ERRORS.append("play again did not return to lobby")
            if host.state["me"]["cash"] != host.welcome["config"]["starting_cash"]:
                ERRORS.append("wallet not reset after play again")

    for b in bots:
        await b.ws.close()
    if ERRORS:
        print("\nPROBLEMS FOUND:")
        for e in sorted(set(ERRORS)):
            print("  -", e)
        sys.exit(1)
    print("\nAll checks passed ✅")


if __name__ == "__main__":
    asyncio.run(main())
