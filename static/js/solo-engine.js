// =====================================================================
// solo-engine.js — the game server, running inside the browser.
//
// This is a straight JavaScript translation of server/market.py and
// server/game.py, used by the SOLO / PREVIEW mode (play against AI
// traders without running Python). Every balance number comes from
// server/config.py and every text from server/content.py: the build
// script (tools/build_preview.py) exports them as window.MR_DATA.
//
// The client (app.js) talks to it through LocalSocket, which behaves
// like a WebSocket, so the rest of the client code is unchanged.
//
// The Python server stays the reference: if you change a rule in
// game.py, mirror it here (the function names match).
// =====================================================================

const DATA = window.MR_DATA;              // { config, content }
const C = DATA.config;                    // == server/config.py
const CONTENT = DATA.content;             // == server/content.py
const IDS = Object.keys(C.COMMODITIES);
const PLAYER_COLORS = ["#3ff0ff", "#ff5fa2", "#ffd84d", "#7cff6b", "#b48cff", "#ff8a3d"];
const TRADE_ACTIONS = new Set(["buy", "sell", "short", "cover"]);

// ---- small helpers (Python's random / f-strings) ---------------------
const uid = () => Math.random().toString(16).slice(2, 10);
const uniform = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const gauss = (mu, sigma) => { // Box–Muller
  const u = 1 - Math.random(), v = Math.random();
  return mu + sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};
const r2 = (x) => Math.round(x * 100) / 100;
const r1 = (x) => Math.round(x * 10) / 10;
const usd = (x) => (x < 0 ? "-$" : "$") + Math.abs(x).toLocaleString("en-US", { maximumFractionDigits: 0 });
const usd2 = (x) => "$" + x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nameOf = (cid) => C.COMMODITIES[cid].name;

class GameError extends Error {} // == Python's ValueError in game.py

// =====================================================================
// market.py
// =====================================================================
class Commodity {
  constructor(cid, spec) {
    this.id = cid;
    this.name = spec.name;
    this.start_price = spec.start_price;
    this.volatility = spec.volatility;
    this.liquidity = spec.liquidity;
    this.price = this.start_price;
    this.anchor = this.start_price;  // "fair value"
    this.corner_by = null;
    this.corner_floor = 0;
  }
  get floor() { return Math.max(this.start_price * C.PRICE_FLOOR_FRACTION, this.corner_floor); }
  clamp(p) { return Math.max(this.floor, p); }
}

class Market {
  constructor() {
    this.c = {};
    this.history = {};
    for (const cid of IDS) {
      this.c[cid] = new Commodity(cid, C.COMMODITIES[cid]);
      this.history[cid] = [r2(this.c[cid].price)];
    }
  }
  prices() { return Object.fromEntries(IDS.map((cid) => [cid, this.c[cid].price])); }
  quote(cid, qty, direction) {
    const c = this.c[cid], p = c.price;
    const impact = Math.min(qty * p / c.liquidity, C.MAX_ORDER_IMPACT);
    const np = direction > 0 ? p * (1 + impact) : c.clamp(p / (1 + impact));
    return [(p + np) / 2, np];
  }
  set_price(cid, p) { this.c[cid].price = this.c[cid].clamp(p); }
  drift(mult) {
    for (const c of Object.values(this.c)) {
      const noise = gauss(0, c.volatility * mult);
      const reversion = C.MEAN_REVERSION * (c.anchor - c.price) / c.price;
      c.price = c.clamp(c.price * (1 + noise + reversion));
    }
  }
  shock(cid, pct, moveAnchor = true) {
    const c = this.c[cid];
    c.price = c.clamp(c.price * (1 + pct));
    if (moveAnchor) c.anchor = Math.max(c.start_price * C.PRICE_FLOOR_FRACTION, c.anchor * (1 + pct * C.EVENT_ANCHOR_SHARE));
  }
  record() { for (const cid of IDS) this.history[cid].push(r2(this.c[cid].price)); }
}

// =====================================================================
// game.py
// =====================================================================
class Player {
  constructor(id, name, token, color, isBot = false) {
    Object.assign(this, { id, name, token, color, isBot, connected: true });
    this.reset_wallet();
  }
  reset_wallet() {
    this.cash = C.STARTING_CASH;
    this.holdings = Object.fromEntries(IDS.map((c) => [c, 0]));
    this.shorts = Object.fromEntries(IDS.map((c) => [c, 0]));
    this.debt = 0;
    this.cards = [];
    this.frozen_until = -1;
    this.shield = false;
    this.audits = [];
    this.insider_tips = [];
    this.milestones = 0;
    this.trade_count = 0;
  }
}

export class SoloRoom {
  constructor(code) {
    this.code = code;
    this.difficulty = "easy";  // practice AI strength: easy | normal | hard (see DIFFICULTY)
    this.players = new Map(); // keeps join order like Python's dict
    this.host_id = null;
    this.outbox = [];
    this.dirty = false;
    this.clock = () => performance.now() / 1000;
    this.reset_match();
  }

  reset_match() {
    this.phase = "lobby";
    this.market = new Market();
    this.start_time = null;
    this.tick_index = 0;
    this.frenzy_announced = false;
    this.news = [];
    this.contracts = [];
    this.big_trades = [];
    this.card_log = [];
    this.next_event = null;
    this.pending_effects = [];
    this.pending_leaks = [];
    this.next_contract_at = C.CONTRACT_FIRST_AT;
    this.results = null;
    for (const p of this.players.values()) p.reset_wallet();
  }

  now_t() { return this.start_time === null ? 0 : this.clock() - this.start_time; }
  remaining() {
    if (this.phase === "playing") return Math.max(0, C.MATCH_SECONDS - this.now_t());
    return ["lobby", "countdown"].includes(this.phase) ? C.MATCH_SECONDS : 0;
  }
  is_frenzy() { return this.phase === "playing" && this.remaining() <= C.CLOSING_FRENZY_SECONDS; }
  send(pid, message) { this.outbox.push([pid, message]); }
  toast(pid, text, level = "info") { this.send(pid, { type: "toast", level, text }); }
  add_news(kind, text, unconfirmed = false, fake = false, author = null, commodities = []) {
    const item = { id: uid(), t: r1(Math.max(0, this.now_t())), kind, text, unconfirmed, fake, author, commodities };
    this.news.push(item);
    this.dirty = true;
    return item;
  }
  net_worth(p) {
    let v = p.cash - p.debt;
    for (const cid of IDS) v += (p.holdings[cid] - p.shorts[cid]) * this.market.c[cid].price;
    return v;
  }
  draw_card() {
    const types = Object.keys(C.CARD_WEIGHTS), weights = Object.values(C.CARD_WEIGHTS);
    let r = Math.random() * weights.reduce((a, b) => a + b, 0);
    for (let i = 0; i < types.length; i++) { r -= weights[i]; if (r <= 0) return { id: uid(), type: types[i] }; }
    return { id: uid(), type: types[types.length - 1] };
  }

  // ---- lobby -----------------------------------------------------------
  join(name, token, isBot = false) {
    if (token) for (const p of this.players.values()) if (p.token === token) { p.connected = true; this.dirty = true; return [p, null]; }
    name = (name || "").trim().replace(/\s+/g, " ").slice(0, 16);
    if (!name) return [null, "Please enter a name."];
    for (const p of this.players.values()) if (p.name.toLowerCase() === name.toLowerCase()) return [null, "That name is already taken in this room."];
    if (["countdown", "playing"].includes(this.phase)) return [null, "A match is in progress."];
    if (this.players.size >= C.MAX_PLAYERS) return [null, "This room is full."];
    const used = new Set([...this.players.values()].map((p) => p.color));
    const color = PLAYER_COLORS.find((c) => !used.has(c)) || PLAYER_COLORS[0];
    const p = new Player(uid(), name, uid() + uid(), color, isBot);
    this.players.set(p.id, p);
    if (!this.host_id) this.host_id = p.id;
    this.dirty = true;
    return [p, null];
  }

  remove_bot() {
    const bots = [...this.players.values()].filter((p) => p.isBot);
    if (!bots.length || this.phase !== "lobby") return;
    this.players.delete(bots[bots.length - 1].id);
    this.dirty = true;
  }

  start(pid) {
    if (pid !== this.host_id) { this.toast(pid, "Only the host can start the match.", "bad"); return false; }
    if (this.phase !== "lobby") return false;
    if (this.players.size < 2) { this.toast(pid, "Add at least one AI trader to start.", "bad"); return false; }
    this.reset_match();
    for (const p of this.players.values()) p.cards = Array.from({ length: C.STARTING_CARDS }, () => this.draw_card());
    this.phase = "countdown";
    this.start_time = this.clock() + C.COUNTDOWN_SECONDS;
    this.schedule_next_event(uniform(C.EVENT_FIRST_MIN, C.EVENT_FIRST_MAX));
    this.send(null, this.history_message());
    this.dirty = true;
    return true;
  }

  open_market() {
    this.phase = "playing";
    this.tick_index = 0;
    this.add_news("system", "🔔 OPENING BELL — the colony market is open!");
    this.send(null, this.history_message());
    this.dirty = true;
  }

  play_again(pid) {
    if (pid !== this.host_id || this.phase !== "ended") return;
    this.reset_match();
    this.dirty = true;
  }

  // ---- clock -------------------------------------------------------------
  tick() {
    if (this.phase !== "playing") return;
    const t = this.now_t();
    this.tick_index += 1;
    const frenzy = this.is_frenzy();
    if (frenzy && !this.frenzy_announced) {
      this.frenzy_announced = true;
      this.add_news("system", "🚨 CLOSING FRENZY — volatility doubled until the bell!");
    }
    this.market.drift(frenzy ? C.FRENZY_VOLATILITY_MULTIPLIER : 1);
    this.process_news(t);
    this.process_contracts(t);
    const rate = C.LOAN_INTEREST_PER_MINUTE * C.TICK_SECONDS / 60;
    for (const p of this.players.values()) if (p.debt > 0) p.debt *= 1 + rate;
    for (const p of this.players.values()) this.check_margin(p);
    this.update_corners();
    this.market.record();
    this.check_milestones();
    this.dirty = true;
    if (t >= C.MATCH_SECONDS) this.finish();
  }

  schedule_next_event(at) {
    const tpl = pick(CONTENT.NEWS_EVENTS);
    const jitter = 1 + uniform(-C.EVENT_STRENGTH_JITTER, C.EVENT_STRENGTH_JITTER);
    const effects = Object.fromEntries(Object.entries(tpl.effects).map(([cid, pct]) => [cid, Math.round(pct * jitter * 1000) / 1000]));
    this.next_event = { at, headline: tpl.headline, effects };
    if (Math.random() < C.RUMOR_LEAK_CHANCE) {
      const main = Object.keys(effects).reduce((a, b) => (Math.abs(effects[a]) >= Math.abs(effects[b]) ? a : b));
      const lead = uniform(C.RUMOR_LEAK_LEAD_MIN, C.RUMOR_LEAK_LEAD_MAX);
      this.pending_leaks.push({ at: at - lead, text: this.rumor_text(main, effects[main] > 0 ? "up" : "down") });
    }
  }
  rumor_text(cid, dir) { return pick(CONTENT.RUMOR_TEMPLATES[dir]).replace("{name}", nameOf(cid)); }

  process_news(t) {
    for (const leak of this.pending_leaks.filter((l) => l.at <= t)) {
      this.pending_leaks.splice(this.pending_leaks.indexOf(leak), 1);
      this.add_news("rumor", leak.text, true, false);
    }
    const ev = this.next_event;
    if (ev && ev.at <= t) {
      this.add_news("event", ev.headline, false, false, null, Object.keys(ev.effects));
      this.pending_effects.push({ at: t + C.EVENT_DELAY_SECONDS, effects: ev.effects });
      this.schedule_next_event(t + uniform(C.EVENT_INTERVAL_MIN, C.EVENT_INTERVAL_MAX));
    }
    for (const pe of this.pending_effects.filter((x) => x.at <= t)) {
      this.pending_effects.splice(this.pending_effects.indexOf(pe), 1);
      for (const [cid, pct] of Object.entries(pe.effects)) this.market.shock(cid, pct);
    }
  }

  process_contracts(t) {
    for (const c of this.contracts) {
      if (c.status === "open" && t >= c.expires_at) {
        c.status = "expired";
        this.add_news("contract", `⌛ Contract expired: ${c.qty} ${nameOf(c.commodity)}`);
      }
    }
    const active = this.contracts.filter((c) => c.status === "open");
    if (t >= this.next_contract_at && active.length < C.CONTRACT_MAX_ACTIVE && C.MATCH_SECONDS - t > 20) {
      this.new_contract(t);
      this.next_contract_at = t + uniform(C.CONTRACT_INTERVAL_MIN, C.CONTRACT_INTERVAL_MAX);
    }
  }

  new_contract(t) {
    const cid = pick(IDS), price = this.market.c[cid].price;
    const value = uniform(C.CONTRACT_VALUE_MIN, C.CONTRACT_VALUE_MAX);
    const qty = Math.max(5, Math.round(value / price / 5) * 5);
    const reward = Math.round(qty * price * C.CONTRACT_REWARD_MULTIPLIER / 50) * 50;
    this.contracts.push({
      id: uid(), commodity: cid, qty, reward, created: r1(t),
      expires_at: r1(Math.min(t + C.CONTRACT_DURATION, C.MATCH_SECONDS)), status: "open", winner: null,
    });
    this.add_news("contract", `📦 New contract: deliver ${qty} ${nameOf(cid)} within ${C.CONTRACT_DURATION}s for ${usd(reward)}`);
  }

  update_corners() {
    for (const cid of IDS) {
      const c = this.market.c[cid];
      const ps = [...this.players.values()];
      const total = ps.reduce((s, p) => s + p.holdings[cid], 0);
      const leader = ps.reduce((a, b) => (b.holdings[cid] > a.holdings[cid] ? b : a), ps[0]);
      const controls = leader && total * c.price >= C.CORNER_MIN_VALUE && leader.holdings[cid] > C.CORNER_SHARE * total;
      if (controls && c.corner_by !== leader.id) {
        c.corner_by = leader.id;
        c.corner_floor = c.price * C.CORNER_FLOOR_RATIO;
        this.add_news("system", `👑 ${leader.name} has cornered ${c.name}! Price floor set at ${usd2(c.corner_floor)}`);
      } else if (!controls && c.corner_by !== null) {
        const old = this.players.get(c.corner_by);
        c.corner_by = null;
        c.corner_floor = 0;
        if (old) this.add_news("system", `${old.name} lost control of ${c.name}.`);
      }
    }
  }

  check_margin(p) {
    const exposure = IDS.reduce((s, cid) => s + p.shorts[cid] * this.market.c[cid].price, 0);
    if (exposure <= 0 || exposure <= C.MARGIN_CALL_RATIO * Math.max(0, this.net_worth(p))) return;
    for (const cid of IDS) {
      const qty = p.shorts[cid];
      if (qty <= 0) continue;
      const [avg, np] = this.market.quote(cid, qty, +1);
      const cost = qty * avg * (1 + C.TRADE_FEE);
      const paid = Math.min(cost, p.cash);
      p.cash -= paid;
      p.debt += cost - paid;
      p.shorts[cid] = 0;
      this.market.set_price(cid, np);
      this.record_trade(p, cid, "cover", qty, avg);
    }
    this.toast(p.id, "📉 MARGIN CALL — your shorts were force-closed. Any shortfall was added to your debt.", "bad");
    this.add_news("system", `📉 Margin call: ${p.name}'s short positions were force-closed!`);
  }

  check_milestones() {
    for (const p of this.players.values()) {
      const profit = this.net_worth(p) - C.STARTING_CASH;
      while (profit >= C.CARD_MILESTONE_STEP * (p.milestones + 1)) {
        p.milestones += 1;
        if (p.cards.length < C.MAX_HAND) {
          const card = this.draw_card();
          p.cards.push(card);
          const info = CONTENT.CARD_INFO[card.type];
          this.toast(p.id, `🎉 Profit milestone! You earned a card: ${info.icon} ${info.name}`, "good");
        }
      }
    }
  }

  finish() {
    this.phase = "ended";
    const results = [...this.players.values()].map((p) => {
      let lv = 0, sv = 0;
      for (const cid of IDS) { lv += p.holdings[cid] * this.market.c[cid].price; sv += p.shorts[cid] * this.market.c[cid].price; }
      const penalty = p.debt * C.UNPAID_LOAN_PENALTY;
      return {
        id: p.id, name: p.name, color: p.color, cash: r2(p.cash), holdings_value: r2(lv), shorts_value: r2(sv),
        debt: r2(p.debt), penalty: r2(penalty), final: r2(p.cash + lv - sv - p.debt - penalty), trades: p.trade_count,
      };
    }).sort((a, b) => b.final - a.final);
    this.results = results;
    this.add_news("system", `🔔 CLOSING BELL — ${results[0].name} wins with ${usd(results[0].final)}!`);
    this.dirty = true;
  }

  // ---- actions -------------------------------------------------------------
  handle(pid, msg) {
    const p = this.players.get(pid);
    if (!p || typeof msg !== "object" || msg === null) return;
    if (msg.type === "start") { this.start(pid); return; }
    if (msg.type === "play_again") { this.play_again(pid); return; }
    if (msg.type === "sync") { this.send(pid, this.history_message()); this.dirty = true; return; }
    if (msg.type === "add_bot") { this.add_bot(); return; }
    if (msg.type === "set_difficulty") {
      if (this.phase === "lobby" && msg.level in DIFFICULTY) { this.difficulty = msg.level; this.dirty = true; }
      return;
    }
    if (msg.type === "remove_bot") { this.remove_bot(); return; }
    if (msg.type !== "action") return;
    if (this.phase !== "playing") { this.toast(pid, "The market is closed.", "bad"); return; }
    const action = msg.action, t = this.now_t();
    if ((TRADE_ACTIONS.has(action) || action === "deliver") && p.frozen_until > t) {
      this.toast(pid, `🧊 You're frozen for ${Math.ceil(p.frozen_until - t)}s more!`, "bad");
      return;
    }
    try {
      if (TRADE_ACTIONS.has(action)) {
        if (!(msg.commodity in C.COMMODITIES)) throw new GameError("Unknown commodity.");
        this[`do_${action}`](p, msg.commodity, this.parse_qty(msg.qty));
      } else if (action === "loan") this.do_loan(p);
      else if (action === "repay") this.do_repay(p);
      else if (action === "deliver") this.do_deliver(p, msg.contract);
      else if (action === "card") this.do_card(p, msg);
      else throw new GameError("Unknown action.");
    } catch (err) {
      if (!(err instanceof GameError)) throw err;
      this.toast(pid, err.message, "bad");
      return;
    }
    this.update_corners();
    this.check_milestones();
    this.dirty = true;
  }

  add_bot() {
    if (this.phase !== "lobby") return;
    const used = new Set([...this.players.values()].map((p) => p.name));
    const name = BOT_NAMES.find((n) => !used.has(n));
    if (!name) return;
    const [p] = this.join(name, null, true);
    if (p) p.style = BOT_STYLES[name];
  }

  parse_qty(raw) {
    if (raw === "max") return "max";
    const q = Number(raw);
    if (!Number.isInteger(q) || q <= 0 || q > 1_000_000) throw new GameError("Invalid quantity.");
    return q;
  }

  max_affordable(cash, cid) {
    let lo = 0, hi = Math.floor(cash / (this.market.c[cid].price * (1 + C.TRADE_FEE)));
    while (lo < hi) {
      const mid = Math.floor((lo + hi + 1) / 2);
      const [avg] = this.market.quote(cid, mid, +1);
      if (mid * avg * (1 + C.TRADE_FEE) <= cash) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  record_trade(p, cid, side, qty, price) {
    p.trade_count += 1;
    const value = qty * price;
    if (value >= C.BIG_TRADE_VALUE) {
      this.big_trades.push({ t: r1(Math.max(0, this.now_t())), tick: this.tick_index, player: p.id, name: p.name,
        color: p.color, commodity: cid, side, qty, price: r2(price), value: r2(value) });
    }
  }
  buy_units(p, cid, qty, side) {
    const [avg, np] = this.market.quote(cid, qty, +1);
    const cost = qty * avg * (1 + C.TRADE_FEE);
    if (cost > p.cash + 1e-6) throw new GameError(`Not enough cash (need ${usd(cost)}).`);
    p.cash -= cost;
    this.market.set_price(cid, np);
    this.record_trade(p, cid, side, qty, avg);
    return [avg, cost];
  }
  sell_units(p, cid, qty, side) {
    const [avg, np] = this.market.quote(cid, qty, -1);
    const proceeds = qty * avg * (1 - C.TRADE_FEE);
    p.cash += proceeds;
    this.market.set_price(cid, np);
    this.record_trade(p, cid, side, qty, avg);
    return [avg, proceeds];
  }
  do_buy(p, cid, qty) {
    if (qty === "max") { qty = this.max_affordable(p.cash, cid); if (qty <= 0) throw new GameError("Not enough cash to buy even one unit."); }
    const [avg, cost] = this.buy_units(p, cid, qty, "buy");
    p.holdings[cid] += qty;
    this.toast(p.id, `Bought ${qty} ${nameOf(cid)} @ ${usd2(avg)} (${usd(cost)})`, "good");
  }
  do_sell(p, cid, qty) {
    const have = p.holdings[cid];
    if (qty === "max") qty = have;
    if (have <= 0) throw new GameError(`You don't hold any ${nameOf(cid)}.`);
    if (qty > have) throw new GameError(`You only hold ${have} ${nameOf(cid)}.`);
    const [avg, proceeds] = this.sell_units(p, cid, qty, "sell");
    p.holdings[cid] -= qty;
    this.toast(p.id, `Sold ${qty} ${nameOf(cid)} @ ${usd2(avg)} (+${usd(proceeds)})`, "good");
  }
  short_capacity_units(p, cid) {
    const exposure = IDS.reduce((s, c) => s + p.shorts[c] * this.market.c[c].price, 0);
    const room = C.SHORT_LIMIT_RATIO * this.net_worth(p) - exposure;
    return Math.max(0, Math.floor(room / this.market.c[cid].price));
  }
  do_short(p, cid, qty) {
    const cap = this.short_capacity_units(p, cid);
    if (qty === "max") qty = cap;
    if (cap <= 0 || qty > cap) throw new GameError(`Short limit reached (max ${cap} more ${nameOf(cid)}).`);
    const [avg] = this.sell_units(p, cid, qty, "short");
    p.shorts[cid] += qty;
    this.toast(p.id, `Shorted ${qty} ${nameOf(cid)} @ ${usd2(avg)}`, "good");
  }
  do_cover(p, cid, qty) {
    const owed = p.shorts[cid];
    if (owed <= 0) throw new GameError(`You have no ${nameOf(cid)} short to cover.`);
    if (qty === "max") { qty = Math.min(owed, this.max_affordable(p.cash, cid)); if (qty <= 0) throw new GameError("Not enough cash to cover."); }
    if (qty > owed) throw new GameError(`You're only short ${owed} ${nameOf(cid)}.`);
    const [avg, cost] = this.buy_units(p, cid, qty, "cover");
    p.shorts[cid] -= qty;
    this.toast(p.id, `Covered ${qty} ${nameOf(cid)} @ ${usd2(avg)} (${usd(cost)})`, "good");
  }
  do_loan(p) {
    if (p.debt + C.LOAN_AMOUNT > C.MAX_DEBT + 1e-6) throw new GameError(`Credit limit reached (max debt ${usd(C.MAX_DEBT)}).`);
    p.debt += C.LOAN_AMOUNT;
    p.cash += C.LOAN_AMOUNT;
    this.toast(p.id, `🏦 Loan approved: +${usd(C.LOAN_AMOUNT)}. Interest ${Math.round(C.LOAN_INTEREST_PER_MINUTE * 100)}%/min.`, "info");
  }
  do_repay(p) {
    if (p.debt <= 0) throw new GameError("You have no debt.");
    const amount = Math.min(p.cash, p.debt);
    if (amount <= 0) throw new GameError("No cash to repay with.");
    p.cash -= amount;
    p.debt -= amount;
    if (p.debt < 0.01) p.debt = 0;
    this.toast(p.id, `Repaid ${usd(amount)}.` + (p.debt === 0 ? " Debt cleared!" : ""), "good");
  }
  do_deliver(p, contractId) {
    const c = this.contracts.find((x) => x.id === contractId);
    if (!c || c.status !== "open") throw new GameError("That contract is no longer available.");
    if (p.holdings[c.commodity] < c.qty) throw new GameError(`You need ${c.qty} ${nameOf(c.commodity)} to deliver.`);
    p.holdings[c.commodity] -= c.qty;
    p.cash += c.reward;
    c.status = "done";
    c.winner = p.name;
    this.add_news("contract", `✅ ${p.name} fulfilled the ${nameOf(c.commodity)} contract for ${usd(c.reward)}`);
    this.toast(p.id, `Contract fulfilled! +${usd(c.reward)}`, "good");
  }
  do_card(p, msg) {
    const card = p.cards.find((c) => c.id === msg.card);
    if (!card) throw new GameError("You don't own that card.");
    const ctype = card.type, info = CONTENT.CARD_INFO[ctype], t = this.now_t();
    let target = null;
    if (info.target === "player") {
      target = this.players.get(msg.target);
      if (!target || target.id === p.id) throw new GameError("Choose a rival to target.");
      if (ctype === "audit" && p.audits.includes(target.id)) throw new GameError(`You already audited ${target.name}.`);
    }
    if ((info.target === "commodity" || info.target === "rumor") && !(msg.commodity in C.COMMODITIES)) throw new GameError("Choose a commodity.");
    if (info.target === "rumor" && !["up", "down"].includes(msg.direction)) throw new GameError("Choose a direction for the rumor.");
    if (ctype === "shield" && p.shield) throw new GameError("Your shield is already up.");
    p.cards.splice(p.cards.indexOf(card), 1);

    if (target && target.shield) {
      target.shield = false;
      this.toast(p.id, `🛡️ ${target.name}'s shield blocked your ${info.name}!`, "bad");
      this.toast(target.id, `🛡️ Your shield blocked a ${info.name} from ${p.name}!`, "good");
      this.log_card(p, ctype, target, true);
      return;
    }
    if (ctype === "insider") {
      const ev = this.next_event;
      let tip;
      if (!ev || ev.at >= C.MATCH_SECONDS) tip = { id: uid(), headline: "No more news expected before the closing bell.", effects: {}, at: null };
      else {
        if (ev.at - t < C.INSIDER_LEAD_SECONDS) ev.at = t + C.INSIDER_LEAD_SECONDS;
        tip = { id: uid(), headline: ev.headline, effects: ev.effects, at: r1(ev.at) };
      }
      p.insider_tips.push(tip);
      this.toast(p.id, "🕵️ Insider tip received — check your news feed.", "good");
    } else if (ctype === "rumor") {
      this.add_news("rumor", this.rumor_text(msg.commodity, msg.direction), true, true, p.name);
      this.toast(p.id, "📢 Your rumor is spreading…", "good");
    } else if (ctype === "freeze") {
      target.frozen_until = Math.max(target.frozen_until, t) + C.FREEZE_SECONDS;
      this.add_news("system", `🧊 ${target.name} has been hit with a Trade Freeze!`);
      this.toast(target.id, `🧊 You've been frozen for ${C.FREEZE_SECONDS}s!`, "bad");
      this.toast(p.id, `🧊 ${target.name} is frozen.`, "good");
    } else if (ctype === "spike") {
      this.market.shock(msg.commodity, C.PRICE_SPIKE, false);
      this.add_news("system", `⚡ Sudden price spike in ${nameOf(msg.commodity)}!`);
    } else if (ctype === "audit") {
      p.audits.push(target.id);
      this.toast(target.id, "🔍 Someone has audited your books!", "bad");
      this.toast(p.id, `🔍 ${target.name}'s books are now visible to you.`, "good");
    } else if (ctype === "shield") {
      p.shield = true;
      this.toast(p.id, "🛡️ Shield up — the next card used on you will be blocked.", "good");
    }
    this.log_card(p, ctype, target, false, msg.commodity);
  }
  log_card(p, ctype, target, blocked = false, commodity = null) {
    this.card_log.push({ t: r1(Math.max(0, this.now_t())), player: p.name, color: p.color, card: CONTENT.CARD_INFO[ctype].name,
      target: target ? target.name : null, commodity: commodity in C.COMMODITIES ? nameOf(commodity) : null, blocked });
  }

  // ---- views -----------------------------------------------------------------
  history_message() { return { type: "history", tick: this.tick_index, history: this.market.history }; }

  state_for(pid) {
    const me = this.players.get(pid), t = this.now_t(), prices = this.market.prices();
    const players = [...this.players.values()].map((p) => ({
      id: p.id, name: p.name, color: p.color, connected: p.connected, net_worth: r2(this.net_worth(p)),
      frozen: this.phase === "playing" && p.frozen_until > t, bot: p.isBot,
    })).sort((a, b) => b.net_worth - a.net_worth);
    const corners = {};
    for (const cid of IDS) {
      const c = this.market.c[cid], o = c.corner_by ? this.players.get(c.corner_by) : null;
      corners[cid] = o ? { player: o.id, name: o.name, color: o.color, floor: r2(c.corner_floor) } : null;
    }
    const state = {
      type: "state", phase: this.phase, code: this.code, host_id: this.host_id, you: pid,
      t: r2(t), remaining: r2(this.remaining()),
      countdown: this.phase === "countdown" ? r2(Math.max(0, -t)) : 0,
      frenzy: this.is_frenzy(), tick: this.tick_index,
      prices: Object.fromEntries(IDS.map((cid) => [cid, r2(prices[cid])])),
      corners, players,
      news: this.news.slice(-C.NEWS_FEED_LENGTH).map(({ id, t, kind, text, unconfirmed, commodities }) => ({ id, t, kind, text, unconfirmed, commodities })),
      contracts: this.contracts.filter((c) => c.status === "open" || t - c.expires_at < 10).map((c) => ({ ...c })),
      min_players: 2, solo: true, difficulty: this.difficulty,
    };
    if (me) {
      state.me = {
        cash: r2(me.cash), holdings: { ...me.holdings }, shorts: { ...me.shorts }, debt: r2(me.debt),
        net_worth: r2(this.net_worth(me)), cards: me.cards.map((c) => ({ ...c })),
        frozen_for: this.phase === "playing" ? r1(Math.max(0, me.frozen_until - t)) : 0,
        shield: me.shield,
        short_capacity: Object.fromEntries(IDS.map((cid) => [cid, this.short_capacity_units(me, cid)])),
        insider: me.insider_tips.map((tip) => ({ ...tip, eta: tip.at === null ? null : r1(tip.at - t) })),
      };
      state.audits = me.audits.map((aid) => this.players.get(aid)).filter(Boolean).map((a) => ({
        id: a.id, name: a.name, color: a.color, cash: r2(a.cash), debt: r2(a.debt), holdings: { ...a.holdings }, shorts: { ...a.shorts } }));
    }
    if (this.phase === "ended") {
      state.results = this.results;
      state.recap = {
        history: this.market.history, trades: this.big_trades,
        rumors: this.news.filter((n) => n.kind === "rumor").map((n) => ({ t: n.t, text: n.text, fake: n.fake, author: n.author })),
        events: this.news.filter((n) => n.kind === "event").map((n) => ({ t: n.t, text: n.text })),
        cards: this.card_log,
      };
    }
    return state;
  }
}

// =====================================================================
// AI traders — each has a personality that shapes how it trades.
// They only use information a human could see (prices, headlines,
// rumors, contracts), plus their own insider tips.
// =====================================================================
const BOT_NAMES = ["Kepler", "Juno", "Rhea", "Atlas", "Lyra"];
const BOT_STYLES = {
  Kepler: "value",     // buys dips below fair value, sells rallies
  Juno: "momentum",    // chases moves and headlines
  Rhea: "news",        // trades headlines, loves contracts
  Atlas: "whale",      // big orders, tries to corner a commodity
  Lyra: "trickster",   // plays cards aggressively, shorts rumors
};

// How strong the AI traders are in practice mode.
//   pace  : multiplies the time between their actions (bigger = slower)
//   size  : multiplies their order sizes
//   news  : chance they react to a headline at all
//   contracts    : multiplies how eagerly they buy goods to fulfil contracts
//   loans        : whether they borrow for leverage
//   deliverDelay : seconds a contract must be open before they deliver (gives humans a window)
//   meanToHumans : whether Freeze / Audit cards may target human players
export const DIFFICULTY = {
  easy:   { label: "Easy",   pace: 2.5, size: 0.35, news: 0.25, contracts: 0.3, loans: false, deliverDelay: 20, meanToHumans: false },
  normal: { label: "Normal", pace: 1.0, size: 1.0,  news: 1.0,  contracts: 1.0, loans: true,  deliverDelay: 0,  meanToHumans: true },
  hard:   { label: "Hard",   pace: 0.7, size: 1.25, news: 1.0,  contracts: 1.3, loans: true,  deliverDelay: 0,  meanToHumans: true },
};

class BotBrain {
  constructor(room, player) {
    this.room = room;
    this.p = player;
    this.style = player.style || "value";
    this.nextActAt = 0;
    this.seenNews = new Set();
    this.lastPrices = {};
    this.focus = pick(IDS); // whale's favourite
  }

  act(t) {
    const room = this.room, p = this.p;
    if (t < this.nextActAt || room.phase !== "playing") return;
    const level = DIFFICULTY[room.difficulty] || DIFFICULTY.normal;
    this.level = level;
    const pace = { value: [2.5, 5], momentum: [1.5, 3.5], news: [2, 4], whale: [3, 6], trickster: [2, 4.5] }[this.style];
    this.nextActAt = t + uniform(...pace) * level.pace;
    const prices = room.market.prices();
    const send = (m) => room.handle(p.id, { type: "action", ...m });

    // 1) React to fresh headlines (and sometimes to rumors)
    for (const n of room.news) {
      if (this.seenNews.has(n.id)) continue;
      this.seenNews.add(n.id);
      if (t - n.t > 6 || Math.random() > level.news) continue;
      // Headlines carry commodity tags (like the ones humans see); rumors only have text
      const hit = n.commodities?.[0] ?? IDS.find((cid) => n.text.includes(nameOf(cid)));
      if (!hit) continue;
      const bullish = /shortage|halted|doubles|orders|emergency|blight|recall|hoarding|slashed|record|raid|boom: 10|strike|dark|overstated|population|grounds|contaminated|leak|buys every/i.test(n.text);
      if (n.kind === "event" || (n.unconfirmed && Math.random() < (this.style === "trickster" ? 0.2 : 0.45))) {
        if (this.style === "value" && n.kind !== "event") continue;
        if (bullish) return send({ action: "buy", commodity: hit, qty: this.size(hit, 0.25) });
        if (p.holdings[hit] > 0) return send({ action: "sell", commodity: hit, qty: "max" });
        if (this.style !== "value") return send({ action: "short", commodity: hit, qty: C.SHORT_BUTTON_QTY });
      }
    }

    // 2) Insider tips: position ahead of the news
    const tip = p.insider_tips.find((x) => x.at && x.at > t && !x.used);
    if (tip) {
      tip.used = true;
      const [cid, pct] = Object.entries(tip.effects).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))[0] || [];
      if (cid) return pct > 0 ? send({ action: "buy", commodity: cid, qty: this.size(cid, 0.4) })
                              : send({ action: "short", commodity: cid, qty: C.SHORT_BUTTON_QTY });
    }

    // 3) Contracts: deliver if possible, otherwise sometimes buy for one
    for (const c of room.contracts.filter((c) => c.status === "open")) {
      if (t - c.created < level.deliverDelay) continue;
      if (p.holdings[c.commodity] >= c.qty) return send({ action: "deliver", contract: c.id });
      const need = c.qty - p.holdings[c.commodity];
      const cost = need * prices[c.commodity] * 1.15;
      if (cost < p.cash && cost < c.reward * 0.85 && Math.random() < (this.style === "news" ? 0.7 : 0.25) * level.contracts) {
        return send({ action: "buy", commodity: c.commodity, qty: need });
      }
    }

    // 4) Cards
    if (p.cards.length && Math.random() < (this.style === "trickster" ? 0.35 : 0.12)) {
      const card = pick(p.cards);
      const rivals = [...room.players.values()].filter((x) => x.id !== p.id && (level.meanToHumans || x.isBot));
      if (!rivals.length && ["freeze", "audit"].includes(card.type)) return;
      const leader = rivals.sort((a, b) => room.net_worth(b) - room.net_worth(a))[0];
      const held = IDS.filter((cid) => p.holdings[cid] > 0);
      const shorted = IDS.filter((cid) => p.shorts[cid] > 0);
      const msg = { action: "card", card: card.id, target: leader?.id };
      if (card.type === "spike") msg.commodity = held.length ? pick(held) : pick(IDS);
      if (card.type === "rumor") {
        if (shorted.length) Object.assign(msg, { commodity: pick(shorted), direction: "down" });
        else Object.assign(msg, { commodity: held.length ? pick(held) : pick(IDS), direction: "up" });
      }
      if (card.type === "audit" && p.audits.includes(leader?.id)) return;
      if (card.type === "shield" && p.shield) return;
      return send(msg);
    }

    // 5) Risk management: cover shorts that went against us, repay loans late
    for (const cid of IDS) if (p.shorts[cid] > 0 && Math.random() < 0.3) return send({ action: "cover", commodity: cid, qty: "max" });
    if (p.debt > 0 && room.remaining() < 40) return send({ action: "repay" });

    // 6) Style-specific trading
    const cid = this.style === "whale" && Math.random() < 0.7 ? this.focus : pick(IDS);
    const c = room.market.c[cid];
    const dev = c.price / this.fairValue(cid) - 1;  // above (>0) or below its recent average
    const last = this.lastPrices[cid] ?? c.price;
    const mom = c.price / last - 1;
    this.lastPrices[cid] = c.price;

    if (this.style === "value" || this.style === "news") {
      if (dev < -0.06) return send({ action: "buy", commodity: cid, qty: this.size(cid, 0.2) });
      if (dev > 0.06 && p.holdings[cid] > 0) return send({ action: "sell", commodity: cid, qty: "max" });
    } else if (this.style === "momentum" || this.style === "trickster") {
      if (mom > 0.02) return send({ action: "buy", commodity: cid, qty: this.size(cid, 0.2) });
      if (mom < -0.02 && p.holdings[cid] > 0) return send({ action: "sell", commodity: cid, qty: "max" });
    } else if (this.style === "whale") {
      if (level.loans && p.debt === 0 && room.now_t() < 120 && Math.random() < 0.3) return send({ action: "loan" });
      if (dev < 0.12) return send({ action: "buy", commodity: cid, qty: this.size(cid, 0.3) });
      if (dev > 0.2 && p.holdings[cid] > 0) return send({ action: "sell", commodity: cid, qty: Math.ceil(p.holdings[cid] / 2) });
    }

    // Take profit near the end
    if (room.remaining() < 25) {
      const held = IDS.filter((x) => p.holdings[x] > 0 && room.market.c[x].price > this.fairValue(x));
      if (held.length) return send({ action: "sell", commodity: pick(held), qty: "max" });
    }
  }

  /** What a human sees as "normal": the average price of the last 30 seconds on the chart. */
  fairValue(cid) {
    const hist = this.room.market.history[cid].slice(-30);
    return hist.reduce((a, b) => a + b, 0) / hist.length;
  }

  /** Spend roughly `share` of cash on this commodity (at least 1 unit). */
  size(cid, share) {
    const price = this.room.market.c[cid].price;
    const mult = this.level?.size ?? 1;
    return Math.max(1, Math.floor((this.p.cash * share * mult * uniform(0.6, 1.2)) / price));
  }
}

// =====================================================================
// LocalSocket — looks like a WebSocket to app.js, but talks to SoloRoom.
// It also plays the role of server/main.py: runs the clock + bots.
// =====================================================================
export class LocalSocket {
  static OPEN = 1;
  constructor(room) {
    this.room = room;
    this.readyState = 0;
    this.pid = null;
    this.brains = new Map();
    this.timer = null;
    setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0);
  }

  send(raw) {
    const msg = JSON.parse(raw);
    const room = this.room;
    if (msg.type === "join") {
      const [p, err] = room.join(msg.name, msg.token);
      if (err) return this.deliver({ type: "error", fatal: true, text: err });
      this.pid = p.id;
      this.deliver({
        type: "welcome", player_id: p.id, token: p.token, code: room.code,
        commodities: IDS.map((id) => ({ id, name: C.COMMODITIES[id].name, icon: C.COMMODITIES[id].icon, color: C.COMMODITIES[id].color, start_price: C.COMMODITIES[id].start_price, liquidity: C.COMMODITIES[id].liquidity })),
        cards: CONTENT.CARD_INFO,
        config: {
          match_seconds: C.MATCH_SECONDS, frenzy_seconds: C.CLOSING_FRENZY_SECONDS, short_qty: C.SHORT_BUTTON_QTY,
          loan_amount: C.LOAN_AMOUNT, max_debt: C.MAX_DEBT, loan_interest: C.LOAN_INTEREST_PER_MINUTE,
          starting_cash: C.STARTING_CASH, chart_window: C.CHART_WINDOW_SECONDS, tick_seconds: C.TICK_SECONDS,
          max_players: C.MAX_PLAYERS, solo: true,
          trade_fee: C.TRADE_FEE, max_order_impact: C.MAX_ORDER_IMPACT,
        },
      });
      this.deliver(room.history_message());
      // A fresh solo room starts with three AI rivals
      if (room.players.size === 1) for (let i = 0; i < 3; i++) room.add_bot();
      room.dirty = true;
      return this.flush();
    }
    const wasLobby = room.phase === "lobby";
    room.handle(this.pid, msg);
    if (wasLobby && room.phase === "countdown") this.runMatch();
    this.flush();
  }

  close() { this.readyState = 3; clearTimeout(this.timer); }

  deliver(obj) {
    // Copy through JSON so the client never shares objects with the engine
    const data = JSON.stringify(obj);
    queueMicrotask(() => this.onmessage?.({ data }));
  }

  flush() {
    const room = this.room;
    const out = room.outbox;
    room.outbox = [];
    for (const [pid, m] of out) if (pid === null || pid === this.pid) this.deliver(m);
    if (room.dirty) { room.dirty = false; this.deliver(room.state_for(this.pid)); }
  }

  // == server/main.py run_match(): countdown, then a tick every second
  runMatch() {
    const room = this.room;
    this.brains = new Map([...room.players.values()].filter((p) => p.isBot).map((p) => [p.id, new BotBrain(room, p)]));
    let n = 0;
    const startMs = room.start_time * 1000;
    const step = () => {
      if (this.readyState === 3) return;
      if (room.phase === "countdown") {
        room.open_market();
        this.flush();
      } else if (room.phase === "playing") {
        room.tick();
        this.flush();
      }
      if (room.phase !== "playing") return;
      n += 1;
      this.timer = setTimeout(step, Math.max(0, startMs + n * C.TICK_SECONDS * 1000 - performance.now()));
    };
    this.timer = setTimeout(step, Math.max(0, startMs - performance.now()));
    // Bots think 4× per second, between ticks, so the market feels alive
    const think = () => {
      if (this.readyState === 3 || room.phase === "ended" || room.phase === "lobby") return;
      if (room.phase === "playing") {
        const t = room.now_t();
        for (const b of this.brains.values()) b.act(t);
        this.flush();
      }
      setTimeout(think, 250);
    };
    setTimeout(think, 250);
  }
}
