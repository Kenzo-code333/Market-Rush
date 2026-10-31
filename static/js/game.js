// =====================================================================
// game.js — the trading terminal screen.
//
// Smoothness strategy:
//   * The DOM is built ONCE in the constructor. Each server update only
//     changes text, classes and attributes — nothing is rebuilt, so
//     buttons never flicker and hover states survive.
//   * Charts and timers are interpolated every animation frame (60fps)
//     between the server's 1-second ticks.
//   * Numbers tween, rows slide when the leaderboard reorders (FLIP),
//     news items slide in.
// =====================================================================

import { h, $, money, price, pct, clock, setText, flash, tweenNumber, choose } from "./util.js";
import { LiveChart } from "./charts.js";

/** Animate elements to their new order (First-Last-Invert-Play technique). */
function flipReorder(container, els) {
  const same = els.length === container.children.length && els.every((el, i) => container.children[i] === el);
  if (same) return;
  const before = new Map();
  for (const el of els) if (el.isConnected) before.set(el, el.getBoundingClientRect());
  for (const el of els) container.append(el); // append() moves existing nodes
  for (const el of els) {
    const old = before.get(el);
    if (!old) continue;
    const now = el.getBoundingClientRect();
    const dx = old.left - now.left, dy = old.top - now.top;
    if (!dx && !dy) continue;
    el.style.transition = "none";
    el.style.transform = `translate(${dx}px, ${dy}px)`;
    requestAnimationFrame(() => {
      el.style.transition = "transform 0.5s cubic-bezier(.2,.8,.2,1)";
      el.style.transform = "";
    });
  }
}

export class GameView {
  /**
   * welcome : the server's welcome message (commodities, cards, config)
   * send    : function(obj) that sends a message to the server
   */
  constructor(welcome, send) {
    this.w = welcome;
    this.cfg = welcome.config;
    this.send = send;
    this.state = null;
    this.stateAt = performance.now();
    this.lastPrices = {};
    this.seenNews = new Set();
    this.cardIds = "";
    this.rows = {};        // leaderboard rows by player id
    this.contractEls = {}; // contract cards by id
    this.build();
  }

  // -------------------------------------------------------------------
  // Build the static layout once
  // -------------------------------------------------------------------
  build() {
    const comms = this.w.commodities;

    // ---- center: one chart card per commodity + a contracts card ----
    this.charts = {};
    this.chartCards = {};
    const chartsEl = $("#charts");
    chartsEl.replaceChildren();
    for (const c of comms) {
      const canvas = h("canvas", { class: "chart-canvas" });
      const card = {
        price: h("span", { class: "c-price" }, price(c.start_price)),
        change: h("span", { class: "c-change" }, "+0.0%"),
        corner: h("div", { class: "c-corner", hidden: true }),
      };
      card.el = h("div", { class: "chart-card", style: { "--accent": c.color } },
        h("div", { class: "chart-head" },
          h("span", { class: "c-icon" }, c.icon),
          h("span", { class: "c-name" }, c.name),
          h("span", { class: "spacer" }),
          card.price, card.change),
        card.corner,
        canvas);
      chartsEl.append(card.el);
      this.chartCards[c.id] = card;
      this.charts[c.id] = new LiveChart(canvas, c.color, this.cfg.chart_window, this.cfg.tick_seconds);
    }
    this.contractsList = h("div", { class: "contracts-list" },
      h("p", { class: "muted empty" }, "No contracts yet. They appear during the match."));
    chartsEl.append(h("div", { class: "chart-card contracts-card" },
      h("div", { class: "chart-head" }, h("span", { class: "c-icon" }, "📦"), h("span", { class: "c-name" }, "Contracts")),
      this.contractsList));

    // ---- bottom: trading desk ----
    this.desk = {};
    const deskEl = $("#desk");
    deskEl.replaceChildren();
    for (const c of comms) {
      const act = (action, qty, label, cls) => h("button", {
        class: `btn trade ${cls}`,
        onclick: () => this.send({ type: "action", action, commodity: c.id, qty }),
      }, label);
      const d = {
        price: h("span", { class: "d-price" }, price(c.start_price)),
        held: h("span", { class: "d-held" }, "0"),
        buy: [act("buy", 1, "×1", "buy"), act("buy", 10, "×10", "buy"), act("buy", "max", "MAX", "buy")],
        sell: [act("sell", 1, "×1", "sell"), act("sell", 10, "×10", "sell"), act("sell", "max", "MAX", "sell")],
        short: act("short", this.cfg.short_qty, `SHORT ×${this.cfg.short_qty}`, "short"),
        cover: act("cover", "max", "COVER", "cover"),
      };
      d.el = h("div", { class: "desk-col", style: { "--accent": c.color } },
        h("div", { class: "desk-head" }, h("b", {}, c.name), d.price),
        h("div", { class: "desk-held" }, "Held ", d.held),
        h("div", { class: "btn-row" }, h("label", {}, "BUY"), ...d.buy),
        h("div", { class: "btn-row" }, h("label", {}, "SELL"), ...d.sell),
        h("div", { class: "btn-row" }, d.short, d.cover));
      deskEl.append(d.el);
      this.desk[c.id] = d;
    }

    // ---- left: portfolio ----
    this.holdRows = {};
    const holdEl = $("#holdings");
    holdEl.replaceChildren();
    for (const c of comms) {
      const row = {
        qty: h("span", { class: "h-qty" }, "0"),
        val: h("span", { class: "h-val" }, "$0"),
      };
      row.el = h("div", { class: "h-row" },
        h("span", { class: "h-dot", style: { background: c.color } }), h("span", { class: "h-name" }, c.name), row.qty, row.val);
      holdEl.append(row.el);
      this.holdRows[c.id] = row;
    }
    $("#btn-loan").textContent = `Take loan +${money(this.cfg.loan_amount)}`;
    $("#btn-loan").onclick = () => this.send({ type: "action", action: "loan" });
    $("#btn-repay").onclick = () => this.send({ type: "action", action: "repay" });
    $("#loan-note").textContent = `${(this.cfg.loan_interest * 100).toFixed(0)}%/min interest · unpaid debt is penalised at the bell`;

    $("#leaderboard").replaceChildren();
    $("#news").replaceChildren();
    $("#insider").replaceChildren();
    $("#cards").replaceChildren();
    this.rows = {};
  }

  // -------------------------------------------------------------------
  // Messages from the server
  // -------------------------------------------------------------------
  setHistory(msg) {
    for (const [cid, values] of Object.entries(msg.history)) this.charts[cid]?.setHistory(values);
  }

  update(state) {
    const prev = this.state;
    this.state = state;
    this.stateAt = performance.now();
    const me = state.me;

    // --- charts: new tick => new point, otherwise move the live head ---
    for (const c of this.w.commodities) {
      const chart = this.charts[c.id];
      chart.running = state.phase === "playing";
      const p = state.prices[c.id];
      if (state.phase === "playing" && state.tick === chart.points.length) chart.addTick(p);
      else if (state.phase === "playing" && state.tick > chart.points.length) { this.send({ type: "sync" }); }
      else chart.setHead(p);
      chart.floor = state.corners[c.id]?.floor ?? null;
    }

    this.renderPrices(state);
    this.renderLeaderboard(state);
    if (me) this.renderPortfolio(state, me);
    this.renderNews(state);
    this.renderContracts(state);
    if (me) this.renderCards(state, me);

    document.body.classList.toggle("frenzy", !!state.frenzy);
    $("#room-tag").textContent = `ROOM ${state.code}`;
    if (prev?.frenzy === false && state.frenzy) flash($("#timer"), "flash");
  }

  renderPrices(state) {
    const me = state.me;
    const frozen = me && me.frozen_for > 0;
    for (const c of this.w.commodities) {
      const p = state.prices[c.id];
      const card = this.chartCards[c.id];
      const d = this.desk[c.id];
      const old = this.lastPrices[c.id];
      if (old !== undefined && Math.abs(p - old) > 1e-9) {
        const dir = p > old ? "flash-up" : "flash-down";
        flash(card.price, dir);
        flash(d.price, dir);
      }
      this.lastPrices[c.id] = p;
      setText(card.price, price(p));
      setText(d.price, price(p));
      const change = p / c.start_price - 1;
      setText(card.change, pct(change));
      card.change.className = "c-change " + (change >= 0 ? "up" : "down");

      const corner = state.corners[c.id];
      card.corner.hidden = !corner;
      if (corner) {
        setText(card.corner, `👑 ${corner.name} controls · floor ${price(corner.floor)}`);
        card.corner.style.color = corner.color;
      }

      // Desk buttons: enable only what is currently possible
      const playing = state.phase === "playing";
      const held = me ? me.holdings[c.id] : 0;
      const short = me ? me.shorts[c.id] : 0;
      setText(d.held, short ? `${held} · short ${short}` : `${held}`);
      d.buy.forEach((b) => (b.disabled = !playing || frozen));
      d.sell.forEach((b, i) => (b.disabled = !playing || frozen || held < (i === 1 ? 10 : 1)));
      d.short.disabled = !playing || frozen || !me || me.short_capacity[c.id] < this.cfg.short_qty;
      d.cover.disabled = !playing || frozen || short <= 0;
    }
  }

  renderLeaderboard(state) {
    const lb = $("#leaderboard");
    const els = [];
    const ids = new Set();
    state.players.forEach((p, i) => {
      ids.add(p.id);
      let row = this.rows[p.id];
      if (!row) {
        row = {
          rank: h("span", { class: "lb-rank" }),
          name: h("span", { class: "lb-name" }, p.name),
          nw: h("span", { class: "lb-nw" }),
          badge: h("span", { class: "lb-badge" }),
        };
        row.el = h("div", { class: "lb-row", style: { "--pc": p.color } }, row.rank, row.name, row.badge, row.nw);
        this.rows[p.id] = row;
      }
      setText(row.rank, `#${i + 1}`);
      tweenNumber(row.nw, p.net_worth, (v) => money(v));
      row.el.classList.toggle("me", p.id === state.you);
      row.el.classList.toggle("offline", !p.connected);
      row.el.classList.toggle("leader", i === 0);
      setText(row.badge, p.frozen ? "🧊" : !p.connected ? "offline" : "");
      els.push(row.el);
    });
    for (const id of Object.keys(this.rows)) {
      if (!ids.has(id)) { this.rows[id].el.remove(); delete this.rows[id]; }
    }
    flipReorder(lb, els);
  }

  renderPortfolio(state, me) {
    const start = this.cfg.starting_cash;
    tweenNumber($("#nw"), me.net_worth, (v) => money(v));
    const change = me.net_worth / start - 1;
    const ch = $("#nw-change");
    setText(ch, `${pct(change)} since open`);
    ch.className = change >= 0 ? "up" : "down";
    tweenNumber($("#cash"), me.cash, (v) => money(v));
    tweenNumber($("#debt"), me.debt, (v) => money(v));
    $("#debt-row").classList.toggle("warn", me.debt > 0);

    for (const c of this.w.commodities) {
      const row = this.holdRows[c.id];
      const held = me.holdings[c.id], short = me.shorts[c.id];
      const value = (held - short) * state.prices[c.id];
      setText(row.qty, short ? `${held} / -${short}` : `${held}`);
      setText(row.val, money(value));
      row.el.classList.toggle("empty", !held && !short);
      row.el.classList.toggle("is-short", short > 0);
    }

    const playing = state.phase === "playing";
    $("#btn-loan").disabled = !playing || me.debt + this.cfg.loan_amount > this.cfg.max_debt + 1e-6;
    $("#btn-repay").disabled = !playing || me.debt <= 0 || me.cash <= 0;

    // Status badges
    const badges = $("#status-badges");
    const key = `${me.shield}|${me.frozen_for > 0}`;
    if (badges.dataset.key !== key) { // only touch the DOM when it changes
      badges.dataset.key = key;
      badges.replaceChildren(...[
        me.shield ? h("span", { class: "badge shield" }, "🛡️ Shield active") : null,
        me.frozen_for > 0 ? h("span", { class: "badge frozen" }, "🧊 Frozen") : null,
      ].filter(Boolean));
    }
    document.body.classList.toggle("is-frozen", me.frozen_for > 0);

    // Audited rivals
    const audits = $("#audits");
    if (!state.audits?.length) { audits.replaceChildren(); return; }
    audits.replaceChildren(h("h4", {}, "🔍 Audited books"),
      ...state.audits.map((a) => h("div", { class: "audit", style: { "--pc": a.color } },
        h("div", { class: "audit-name" }, a.name, h("small", {}, `cash ${money(a.cash)}${a.debt ? " · debt " + money(a.debt) : ""}`)),
        h("div", { class: "audit-grid" }, this.w.commodities.map((c) =>
          h("span", { class: a.holdings[c.id] || a.shorts[c.id] ? "" : "dim" },
            `${c.icon} ${a.holdings[c.id]}${a.shorts[c.id] ? ` (-${a.shorts[c.id]})` : ""}`))))));
  }

  renderNews(state) {
    // Insider tips (private, pinned at top)
    const insider = $("#insider");
    const tips = state.me?.insider || [];
    if (insider.childElementCount !== tips.length) {
      insider.replaceChildren(...tips.slice().reverse().map((tip) => {
        const effects = Object.entries(tip.effects).map(([cid, v]) => {
          const name = this.w.commodities.find((c) => c.id === cid).name;
          return h("span", { class: v > 0 ? "up" : "down" }, `${name} ${pct(v)}`);
        });
        const el = h("div", { class: "news-item insider", dataset: { at: tip.at ?? "" } },
          h("div", { class: "news-tag" }, h("span", {}, "🕵️ INSIDER · ONLY YOU"), h("span", { class: "eta" })),
          h("div", { class: "news-text" }, tip.headline),
          effects.length ? h("div", { class: "news-effects" }, effects) : null);
        return el;
      }));
    }

    const feed = $("#news");
    for (const n of state.news) {
      if (this.seenNews.has(n.id)) continue;
      this.seenNews.add(n.id);
      const tag = { event: "BREAKING", rumor: "UNCONFIRMED", system: "MARKET", contract: "CONTRACT" }[n.kind];
      const el = h("div", { class: `news-item ${n.kind} enter` },
        h("div", { class: "news-tag" }, tag, h("span", { class: "news-time" }, clock(n.t))),
        h("div", { class: "news-text" }, n.text));
      feed.prepend(el);
      requestAnimationFrame(() => requestAnimationFrame(() => el.classList.remove("enter")));
      if (n.kind === "event") flash(el, "flash");
    }
    while (feed.childElementCount > 60) feed.lastChild.remove();
  }

  renderContracts(state) {
    const list = this.contractsList;
    const me = state.me;
    const ids = new Set(state.contracts.map((c) => c.id));
    for (const [id, el] of Object.entries(this.contractEls)) {
      if (!ids.has(id)) { el.root.remove(); delete this.contractEls[id]; }
    }
    for (const c of state.contracts) {
      let el = this.contractEls[c.id];
      const com = this.w.commodities.find((x) => x.id === c.commodity);
      if (!el) {
        el = {
          btn: h("button", { class: "btn deliver", onclick: () => this.send({ type: "action", action: "deliver", contract: c.id }) }, "DELIVER"),
          bar: h("div", { class: "ct-bar-fill" }),
          status: h("div", { class: "ct-status" }),
          data: c,
        };
        el.root = h("div", { class: "contract", style: { "--accent": com.color } },
          h("div", { class: "ct-main" },
            h("div", {}, h("b", {}, `${c.qty} ${com.name}`), h("div", { class: "ct-reward" }, money(c.reward))),
            el.btn),
          h("div", { class: "ct-bar" }, el.bar), el.status);
        this.contractEls[c.id] = el;
        list.prepend(el.root);
      }
      el.data = c;
      const have = me ? me.holdings[c.commodity] : 0;
      el.btn.disabled = c.status !== "open" || have < c.qty || state.phase !== "playing" || (me && me.frozen_for > 0);
      el.btn.title = `You hold ${have}/${c.qty}`;
      el.root.classList.toggle("closed", c.status !== "open");
      setText(el.status, c.status === "done" ? `✅ Won by ${c.winner}` : c.status === "expired" ? "⌛ Expired" : `You hold ${have}/${c.qty}`);
    }
    list.querySelector(".empty")?.toggleAttribute("hidden", state.contracts.length > 0);
  }

  renderCards(state, me) {
    const key = me.cards.map((c) => c.id).join(",") + "|" + state.phase;
    if (key === this.cardIds) return; // unchanged — don't touch the DOM
    this.cardIds = key;
    const box = $("#cards");
    const playing = state.phase === "playing";
    if (!me.cards.length) {
      box.replaceChildren(h("p", { class: "muted" }, "No cards. Earn more at profit milestones."));
      return;
    }
    box.replaceChildren(...me.cards.map((card) => {
      const info = this.w.cards[card.type];
      return h("button", {
        class: `card card-${card.type}`, disabled: !playing,
        title: info.desc,
        onclick: () => this.playCard(card, info),
      }, h("span", { class: "card-icon" }, info.icon), h("b", {}, info.name), h("small", {}, info.desc));
    }));
  }

  playCard(card, info) {
    const state = this.state;
    const sendCard = (extra) => this.send({ type: "action", action: "card", card: card.id, ...extra });
    if (info.target === null) return sendCard({});
    if (info.target === "player") {
      const rivals = state.players.filter((p) => p.id !== state.you);
      return choose(`${info.icon} ${info.name}`, "Choose a rival:", rivals.map((p) => ({
        label: p.name, sub: money(p.net_worth), color: p.color, onClick: () => sendCard({ target: p.id }),
      })));
    }
    const pickCommodity = (title, then) => choose(`${info.icon} ${info.name}`, title,
      this.w.commodities.map((c) => ({ label: c.name, sub: price(state.prices[c.id]), color: c.color, onClick: () => then(c) })));
    if (info.target === "commodity") return pickCommodity("Which commodity?", (c) => sendCard({ commodity: c.id }));
    if (info.target === "rumor") {
      return pickCommodity("Rumor about which commodity?", (c) => choose(`${info.icon} ${info.name}`, `Make ${c.name} sound…`, [
        { label: "📈 Bullish", sub: "price going up", color: "#2bff88", onClick: () => sendCard({ commodity: c.id, direction: "up" }) },
        { label: "📉 Bearish", sub: "price going down", color: "#ff4d6d", onClick: () => sendCard({ commodity: c.id, direction: "down" }) },
      ]));
    }
  }

  // -------------------------------------------------------------------
  // Called every animation frame (~60 times per second)
  // -------------------------------------------------------------------
  frame(now, dt) {
    const s = this.state;
    if (!s) return;
    for (const chart of Object.values(this.charts)) chart.draw(now, dt);

    const elapsed = (now - this.stateAt) / 1000;
    const live = s.phase === "playing";
    // Smooth match timer: interpolate between server updates
    const remaining = live ? Math.max(0, s.remaining - elapsed) : s.remaining;
    setText($("#timer-text"), clock(remaining));
    $("#timer-fill").style.transform = `scaleX(${remaining / this.cfg.match_seconds})`;
    $("#timer").classList.toggle("urgent", live && remaining <= this.cfg.frenzy_seconds);

    // Opening countdown overlay
    const cd = $("#countdown-overlay");
    if (s.phase === "countdown") {
      const left = Math.max(0, s.countdown - elapsed);
      cd.hidden = false;
      setText(cd, left > 0.05 ? String(Math.ceil(left)) : "🔔");
    } else cd.hidden = true;

    // Frozen overlay
    const fz = $("#frozen-overlay");
    const frozenFor = s.me ? Math.max(0, s.me.frozen_for - elapsed) : 0;
    fz.hidden = !(live && frozenFor > 0);
    if (!fz.hidden) setText(fz.querySelector("b"), `${frozenFor.toFixed(1)}s`);

    // Contract countdown bars
    const t = s.t + (live ? elapsed : 0);
    for (const el of Object.values(this.contractEls)) {
      const c = el.data;
      const total = c.expires_at - c.created;
      const left = c.status === "open" ? Math.max(0, c.expires_at - t) : 0;
      el.bar.style.transform = `scaleX(${total > 0 ? left / total : 0})`;
      el.bar.classList.toggle("low", left < 10);
    }

    // Insider ETAs
    for (const el of $("#insider").children) {
      const at = el.dataset.at;
      const eta = el.querySelector(".eta");
      if (!at) { setText(eta, ""); continue; }
      const left = Number(at) - t;
      setText(eta, left > 0 ? `hits in ${Math.ceil(left)}s` : "happened");
    }
  }
}
