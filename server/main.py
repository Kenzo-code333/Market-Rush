"""
Market Rush — web server (FastAPI + WebSockets).

Responsibilities:
  * serve the static client (static/index.html, js, css),
  * create rooms (POST /api/rooms),
  * hold one WebSocket per player and forward their messages to the Room,
  * run one background "ticker" task per running match,
  * deliver everything the Room puts in its outbox.

All game rules live in game.py — this file is only plumbing.
"""

import asyncio
import contextlib
import json
import random
import time
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import config, content
from .game import Room

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"
CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ"  # no I/O to avoid confusion

rooms: dict[str, Room] = {}
# room code -> {player_id: websocket}
sockets: dict[str, dict[str, WebSocket]] = {}
# room code -> running ticker task
tickers: dict[str, asyncio.Task] = {}


# ---------------------------------------------------------------------------
# App + background janitor that deletes abandoned rooms
# ---------------------------------------------------------------------------
async def janitor():
    while True:
        await asyncio.sleep(60)
        now = time.monotonic()
        for code, room in list(rooms.items()):
            if not room.connected_players() and now - room.last_activity > config.ROOM_IDLE_TIMEOUT:
                rooms.pop(code, None)
                sockets.pop(code, None)
                task = tickers.pop(code, None)
                if task:
                    task.cancel()


@contextlib.asynccontextmanager
async def lifespan(_app):
    task = asyncio.create_task(janitor())
    yield
    task.cancel()


app = FastAPI(title="Market Rush", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/")
async def index():
    return FileResponse(STATIC_DIR / "index.html")


@app.post("/api/rooms")
async def create_room():
    for _ in range(100):
        code = "".join(random.choice(CODE_ALPHABET) for _ in range(4))
        if code not in rooms:
            break
    rooms[code] = Room(code)
    sockets[code] = {}
    return {"code": code}


@app.get("/api/rooms/{code}")
async def room_info(code: str):
    room = rooms.get(code.upper())
    if not room:
        return JSONResponse({"exists": False}, status_code=404)
    return {"exists": True, "phase": room.phase, "players": len(room.players)}


# ---------------------------------------------------------------------------
# Sending
# ---------------------------------------------------------------------------
async def _send(ws: WebSocket, message: dict):
    try:
        await ws.send_json(message)
    except Exception:
        pass  # socket already closed — the receive loop will clean up


async def flush(room: Room):
    """Deliver queued messages, then (if needed) a fresh state to everyone."""
    conns = sockets.get(room.code, {})
    outbox, room.outbox = room.outbox, []
    sends = []
    for pid, message in outbox:
        targets = conns.items() if pid is None else [(pid, conns.get(pid))]
        for _pid, ws in targets:
            if ws is not None:
                sends.append(_send(ws, message))
    if room.dirty:
        room.dirty = False
        for pid, ws in conns.items():
            sends.append(_send(ws, room.state_for(pid)))
    if sends:
        await asyncio.gather(*sends)


# ---------------------------------------------------------------------------
# The match clock
# ---------------------------------------------------------------------------
async def run_match(room: Room):
    """Countdown, then tick every TICK_SECONDS until the closing bell."""
    try:
        await asyncio.sleep(max(0.0, room.start_time - time.monotonic()))
        if room.phase != "countdown":
            return
        room.open_market()
        await flush(room)
        n = 0
        while room.phase == "playing":
            n += 1
            # Sleep until the exact scheduled time so ticks don't drift.
            target = room.start_time + n * config.TICK_SECONDS
            await asyncio.sleep(max(0.0, target - time.monotonic()))
            room.tick()
            await flush(room)
    finally:
        tickers.pop(room.code, None)


def ensure_ticker(room: Room):
    if room.phase == "countdown" and room.code not in tickers:
        tickers[room.code] = asyncio.create_task(run_match(room))


# ---------------------------------------------------------------------------
# WebSocket endpoint: one connection per player
# ---------------------------------------------------------------------------
def welcome_message(room: Room, player) -> dict:
    return {
        "type": "welcome",
        "player_id": player.id,
        "token": player.token,
        "code": room.code,
        "commodities": [{"id": cid, **{k: v for k, v in spec.items() if k in ("name", "icon", "color", "start_price")}}
                        for cid, spec in config.COMMODITIES.items()],
        "cards": content.CARD_INFO,
        "config": {
            "match_seconds": config.MATCH_SECONDS,
            "frenzy_seconds": config.CLOSING_FRENZY_SECONDS,
            "short_qty": config.SHORT_BUTTON_QTY,
            "loan_amount": config.LOAN_AMOUNT,
            "max_debt": config.MAX_DEBT,
            "loan_interest": config.LOAN_INTEREST_PER_MINUTE,
            "starting_cash": config.STARTING_CASH,
            "chart_window": config.CHART_WINDOW_SECONDS,
            "tick_seconds": config.TICK_SECONDS,
            "max_players": config.MAX_PLAYERS,
        },
    }


@app.websocket("/ws/{code}")
async def ws_endpoint(ws: WebSocket, code: str):
    await ws.accept()
    code = code.upper()
    room = rooms.get(code)
    if room is None:
        await ws.send_json({"type": "error", "fatal": True, "text": "Room not found. Check the code or create a new room."})
        await ws.close()
        return

    # First message must be {"type": "join", "name": ..., "token": ...}
    try:
        hello = await asyncio.wait_for(ws.receive_json(), timeout=15)
    except Exception:
        await ws.close()
        return
    player, error = room.join(str(hello.get("name", "")), hello.get("token"))
    if error:
        await ws.send_json({"type": "error", "fatal": True, "text": error})
        await ws.close()
        return

    conns = sockets.setdefault(code, {})
    old = conns.get(player.id)
    if old is not None and old is not ws:
        # Same trader opened in another tab: the newest tab wins.
        await _send(old, {"type": "error", "fatal": True, "text": "You connected from another tab."})
        with contextlib.suppress(Exception):
            await old.close()
    conns[player.id] = ws

    await ws.send_json(welcome_message(room, player))
    await ws.send_json(room.history_message())
    room.dirty = True
    await flush(room)

    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except ValueError:
                continue  # ignore garbage instead of dropping the player
            room.handle(player.id, msg)
            ensure_ticker(room)   # a "start" message may have begun the countdown
            await flush(room)
    except (WebSocketDisconnect, RuntimeError, ValueError):
        pass
    finally:
        # Only mark offline if this socket is still the player's current one
        if conns.get(player.id) is ws:
            del conns[player.id]
            room.disconnect(player.id)
            await flush(room)
