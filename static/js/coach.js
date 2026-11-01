// =====================================================================
// coach.js — friendly tips for new traders.
//
// Each tip has a condition (a function of the current game state).
// The first time a condition becomes true, the tip appears in the
// "Coach" box on the left. Every tip is shown only once per browser
// (remembered in localStorage), and the player can turn tips off.
// =====================================================================

import { h, $ } from "./util.js";

const SEEN_KEY = "marketrush:coach-seen";
const OFF_KEY = "marketrush:coach-off";

// localStorage can be unavailable (private mode, sandboxed previews)
const load = (k, fallback) => { try { return JSON.parse(localStorage.getItem(k)) ?? fallback; } catch { return fallback; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } };

/**
 * The tips, in priority order. `when(s, me, view)` gets the state from the
 * server, the player's own wallet, and the GameView (for remembered facts).
 */
const TIPS = [
  {
    id: "goal",
    when: (s) => s.phase === "playing",
    text: "Your goal: the highest net worth when the bell rings. Buy goods while they're cheap, sell them when they're expensive. Hover any button to see what it costs.",
  },
  {
    id: "news",
    when: (s) => s.news.some((n) => n.kind === "event"),
    text: "Breaking news! Prices react about 2 seconds after a headline. The colored tags show which goods are affected. Read the headline to guess whether they go up or down.",
  },
  {
    id: "contract",
    when: (s) => s.contracts.some((c) => c.status === "open"),
    text: "A contract appeared (center right). It's the easiest money in the game: press BUY on the contract to get the goods, then DELIVER. The reward is worth more than the goods cost.",
  },
  {
    id: "deliver",
    when: (s, me) => s.contracts.some((c) => c.status === "open" && me.holdings[c.commodity] >= c.qty),
    text: "You hold enough goods for a contract. Press DELIVER before a rival does!",
  },
  {
    id: "rumor",
    when: (s) => s.news.some((n) => n.kind === "rumor"),
    text: "UNCONFIRMED rumors might be true or might be fake, because rivals can plant them with a card. Be careful betting big on a rumor.",
  },
  {
    id: "all-in",
    when: (s, me) => me.cash < 1500 && Object.values(me.holdings).some((q) => q > 0),
    text: "You're nearly all-in. Big orders push the price against you, so buying or selling in smaller chunks usually gets a better price.",
  },
  {
    id: "cards",
    when: (s, me) => s.t > 25 && me.cards.length > 0,
    text: "You have secret cards (bottom right). Hover one to read it, click to play it. Try Insider Tip to see the next headline before everyone else.",
  },
  {
    id: "corner",
    when: (s) => Object.values(s.corners).some((c) => c && c.player !== s.you),
    text: "A trader controls more than half of a commodity. Its price can't fall below the gold dashed line while they keep control.",
  },
  {
    id: "frozen",
    when: (s, me) => me.frozen_for > 0,
    text: "A rival froze you with a card. You can't trade for a few seconds, but you can still play cards. A Shield card blocks the next attack.",
  },
  {
    id: "debt",
    when: (s, me) => me.debt > 0 && s.remaining < 75,
    text: "Repay your loan before the bell. Unpaid debt costs an extra 10% at the end.",
  },
  {
    id: "frenzy",
    when: (s) => s.frenzy,
    text: "Closing frenzy: prices swing twice as hard in the last 30 seconds. Everything you hold counts at the final price.",
  },
];

export class Coach {
  constructor() {
    this.seen = new Set(load(SEEN_KEY, []));
    this.off = load(OFF_KEY, false);
    this.queue = [];
    this.current = null;

    this.text = h("p", { class: "coach-text" });
    this.box = h("div", { class: "coach", hidden: true },
      h("div", { class: "coach-head" }, h("span", {}, "💡 Coach"),
        h("button", { class: "coach-off", onclick: () => this.setOff(true), title: "Stop showing tips" }, "Hide tips")),
      this.text,
      h("button", { class: "btn coach-ok", onclick: () => this.next() }, "Got it"));
    this.toggle = h("button", { class: "coach-on", hidden: true, onclick: () => this.setOff(false) }, "💡 Show tips");
    const slot = $("#coach");
    slot.replaceChildren(this.box, this.toggle);
    this.toggle.hidden = !this.off;
  }

  setOff(off) {
    this.off = off;
    save(OFF_KEY, off);
    if (off) { this.box.hidden = true; this.current = null; this.queue = []; }
    else { this.seen.clear(); save(SEEN_KEY, []); } // turning tips back on replays them
    this.toggle.hidden = !off;
  }

  /** Check every tip against the latest state. */
  update(state) {
    if (this.off || !state.me || state.phase !== "playing") return;
    this.state = state;
    for (const tip of TIPS) {
      if (this.seen.has(tip.id) || this.queue.includes(tip) || this.current === tip) continue;
      let ok = false;
      try { ok = tip.when(state, state.me); } catch { ok = false; }
      if (ok) this.queue.push(tip);
    }
    if (!this.current) this.next();
  }

  next() {
    if (this.current) {
      this.seen.add(this.current.id);
      save(SEEN_KEY, [...this.seen]);
    }
    // Skip queued tips that no longer apply (e.g. the contract is already gone)
    const stillTrue = (tip) => { try { return tip.when(this.state, this.state.me); } catch { return false; } };
    do { this.current = this.queue.shift() || null; } while (this.current && !stillTrue(this.current));
    this.box.hidden = !this.current;
    if (this.current) {
      this.text.textContent = this.current.text;
      // restart the entrance animation
      this.box.classList.remove("pop");
      void this.box.offsetWidth;
      this.box.classList.add("pop");
    }
  }
}
