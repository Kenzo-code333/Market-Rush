// =====================================================================
// app.js — entry point. Handles:
//   * the home screen (create / join a room),
//   * the WebSocket connection (with automatic reconnect),
//   * the lobby screen,
//   * switching between screens based on the server's "phase",
//   * the single animation loop that drives every smooth animation.
//
// Message flow:   browser --(action JSON)--> server
//                 server  --(state JSON)---> browser  (we just display it)
// =====================================================================

import { h, $, toast, stepTweens } from "./util.js";
import { GameView } from "./game.js";
import { RecapView } from "./recap.js";
import { SoloRoom, LocalSocket } from "./solo-engine.js";

const app = {
  code: null,        // room code, e.g. "KXPT"
  ws: null,
  welcome: null,     // static info from the server (commodities, cards, config)
  playerId: null,
  game: null,        // GameView
  recap: null,       // RecapView
  phase: null,
  fatal: false,      // true => don't auto-reconnect
  retries: 0,
  solo: false,       // true => practice vs AI, engine runs in this tab
  soloRoom: null,
};

// The standalone preview (tools/build_preview.py) has no Python server:
// only the practice mode is available there.
const STANDALONE = !!window.MR_STANDALONE;

// Browser storage can be blocked (private mode, sandboxed previews):
// never let that break the game.
const store = {
  get: (area, k) => { try { return window[area].getItem(k); } catch { return null; } },
  set: (area, k, v) => { try { window[area].setItem(k, v); } catch { /* ignore */ } },
  del: (area, k) => { try { window[area].removeItem(k); } catch { /* ignore */ } },
};

// sessionStorage is per browser TAB, so each tab can be a different player,
// and refreshing a tab reconnects you as the same trader.
const tokenKey = (code) => `marketrush:token:${code}`;

// ---------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------
function show(screen) {
  for (const s of document.querySelectorAll(".screen")) s.hidden = s.id !== `screen-${screen}`;
}

function homeError(text) {
  show("home");
  $("#home-error").textContent = text || "";
}

function setupHome() {
  const params = new URLSearchParams(location.search);
  const code = STANDALONE ? "" : (params.get("room") || "").toUpperCase();
  $("#name-input").value = store.get("localStorage", "marketrush:name") || "";
  document.body.classList.toggle("standalone", STANDALONE);

  if (code) {
    $("#home-create").hidden = true;
    $("#home-join").hidden = false;
    $("#join-code").textContent = code;
    app.code = code;
    // Already joined this room in this tab? Reconnect silently.
    if (store.get("sessionStorage", tokenKey(code))) { connect(); return; }
  }
  show("home");
  $("#name-input").focus();
}

function getName() {
  const name = $("#name-input").value.trim();
  if (!name) { homeError("Enter your trader name first."); $("#name-input").focus(); return null; }
  store.set("localStorage", "marketrush:name", name);
  return name;
}

/** Practice vs AI traders: the whole game engine runs in this tab. */
function startPractice() {
  const name = getName();
  if (!name) return;
  app.solo = true;
  app.soloRoom = new SoloRoom("SOLO");
  app.code = "SOLO";
  app.pendingName = name;
  connect();
}

async function createRoom() {
  const name = getName();
  if (!name) return;
  const res = await fetch("/api/rooms", { method: "POST" });
  const { code } = await res.json();
  enterRoom(code, name);
}

function enterRoom(code, name) {
  app.solo = false;
  app.code = code.toUpperCase();
  history.replaceState(null, "", `/?room=${app.code}`);
  app.pendingName = name;
  connect();
}

// ---------------------------------------------------------------------
// WebSocket connection
// ---------------------------------------------------------------------
function connect() {
  app.fatal = false;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = app.solo ? new LocalSocket(app.soloRoom) : new WebSocket(`${proto}://${location.host}/ws/${app.code}`);
  app.ws = ws;
  $("#conn-status").hidden = true;

  ws.onopen = () => {
    ws.send(JSON.stringify({
      type: "join",
      name: app.pendingName || $("#name-input").value.trim(),
      token: app.solo ? null : store.get("sessionStorage", tokenKey(app.code)),
    }));
  };
  ws.onmessage = (e) => onMessage(JSON.parse(e.data));
  ws.onclose = () => {
    if (app.ws !== ws || app.fatal) return;
    // Lost connection: retry with backoff, keeping our token so we
    // get our wallet back.
    $("#conn-status").hidden = false;
    const delay = Math.min(5000, 500 * 2 ** app.retries++);
    setTimeout(connect, delay);
  };
}

export function send(obj) {
  if (app.ws && app.ws.readyState === 1 /* OPEN */) app.ws.send(JSON.stringify(obj));
}

function onMessage(msg) {
  switch (msg.type) {
    case "welcome":
      app.retries = 0;
      app.playerId = msg.player_id;
      app.welcome = msg;
      if (!app.solo) store.set("sessionStorage", tokenKey(msg.code), msg.token);
      app.game = new GameView(msg, send);
      app.recap = null;
      app.phase = null;
      break;
    case "history":
      app.game?.setHistory(msg);
      break;
    case "state":
      onState(msg);
      break;
    case "toast":
      toast(msg.text, msg.level);
      break;
    case "error":
      if (msg.fatal) {
        app.fatal = true;
        store.del("sessionStorage", tokenKey(app.code));
        app.ws?.close();
        homeError(msg.text);
      } else toast(msg.text, "bad");
      break;
  }
}

function onState(state) {
  const phaseChanged = state.phase !== app.phase;
  app.phase = state.phase;

  if (state.phase === "lobby") {
    renderLobby(state);
    if (phaseChanged) { show("lobby"); app.recap = null; app.game = new GameView(app.welcome, send); }
    return;
  }
  if (state.phase === "countdown" || state.phase === "playing") {
    if (phaseChanged) show("game");
    app.game.update(state);
    return;
  }
  if (state.phase === "ended") {
    app.game.update(state);
    if (!app.recap) {
      app.recap = new RecapView(app.welcome, state, send);
      show("recap");
    } else {
      app.recap.render(state); // e.g. host changed => update buttons
    }
  }
}

// ---------------------------------------------------------------------
// Lobby
// ---------------------------------------------------------------------
function renderLobby(state) {
  const solo = !!state.solo;
  $("#lobby-code").textContent = solo ? "PRACTICE" : state.code;
  $("#lobby-share").hidden = solo;
  $("#lobby-bots").hidden = !solo;
  if (!solo) $("#share-link").value = `${location.origin}/?room=${state.code}`;
  const max = app.welcome.config.max_players;
  const bots = state.players.filter((p) => p.bot).length;
  $("#btn-add-bot").disabled = state.players.length >= max;
  $("#btn-remove-bot").disabled = bots === 0;
  $("#lobby-players").replaceChildren(
    ...state.players.map((p) => h("li", { style: { "--pc": p.color }, class: p.id === state.you ? "me" : "" },
      h("span", { class: "dot" }), p.name,
      p.bot ? h("span", { class: "ai" }, "AI") : null,
      p.id === state.host_id && !solo ? h("span", { class: "host" }, "HOST") : null,
      p.id === state.you ? h("span", { class: "you" }, "YOU") : null)),
    ...Array.from({ length: Math.max(0, max - state.players.length) }, () => h("li", { class: "slot" }, "waiting for trader…")));

  const isHost = state.host_id === state.you;
  const enough = state.players.filter((p) => p.connected).length >= state.min_players;
  const btn = $("#btn-start");
  btn.hidden = !isHost;
  btn.disabled = !enough;
  $("#lobby-hint").textContent = isHost
    ? (solo ? "AI traders read the news, chase contracts and play cards. Good luck."
      : enough ? "Everyone in? Ring the opening bell!" : `Waiting for at least ${state.min_players} traders… share the link!`)
    : "Waiting for the host to start the match…";
}

// ---------------------------------------------------------------------
// One animation loop for everything (charts, timers, tweens)
// ---------------------------------------------------------------------
let lastFrame = performance.now();
function loop(now) {
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  stepTweens(now);
  if (app.phase === "countdown" || app.phase === "playing") app.game?.frame(now, dt);
  if (app.phase === "ended") app.recap?.frame(now);
  requestAnimationFrame(loop);
}

// ---------------------------------------------------------------------
// Wire up buttons and go
// ---------------------------------------------------------------------
$("#btn-create").onclick = createRoom;
$("#btn-practice").onclick = startPractice;
$("#btn-add-bot").onclick = () => send({ type: "add_bot" });
$("#btn-remove-bot").onclick = () => send({ type: "remove_bot" });
$("#btn-join").onclick = () => {
  const code = $("#code-input").value.trim().toUpperCase();
  const name = getName();
  if (!name) return;
  if (code.length !== 4) return homeError("Room codes have 4 letters.");
  enterRoom(code, name);
};
$("#btn-join-link").onclick = () => { const name = getName(); if (name) enterRoom(app.code, name); };
$("#name-input").onkeydown = (e) => {
  if (e.key !== "Enter") return;
  if (!$("#home-join").hidden) $("#btn-join-link").click();
  else if (STANDALONE) $("#btn-practice").click();
  else $("#btn-create").click();
};
$("#code-input").onkeydown = (e) => { if (e.key === "Enter") $("#btn-join").click(); };
$("#btn-start").onclick = () => send({ type: "start" });
$("#btn-copy").onclick = async () => {
  try { await navigator.clipboard.writeText($("#share-link").value); toast("Link copied!", "good"); }
  catch { $("#share-link").select(); }
};
$("#btn-leave").onclick = () => {
  if (app.solo) { // no server to leave: just go back to the home screen
    app.ws?.close();
    app.ws = null; app.phase = null; app.recap = null;
    show("home");
    return;
  }
  store.del("sessionStorage", tokenKey(app.code));
  location.href = "/";
};

setupHome();
requestAnimationFrame(loop);
