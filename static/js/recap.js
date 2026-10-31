// =====================================================================
// recap.js — the end-of-match screen: winner, final standings, an
// animated replay of each price chart with big-trade markers, and the
// truth about every rumor.
// =====================================================================

import { h, $, money, clock } from "./util.js";
import { RecapChart } from "./charts.js";

export class RecapView {
  constructor(welcome, state, send) {
    this.w = welcome;
    this.send = send;
    this.chart = null;
    this.render(state);
  }

  render(state) {
    const results = state.results || [];
    const recap = state.recap;
    const winner = results[0];
    const tickS = this.w.config.tick_seconds;
    const start = this.w.config.starting_cash;

    // ---- winner banner + standings ----
    $("#recap-winner").replaceChildren(
      h("div", { class: "trophy" }, "🏆"),
      h("div", {}, h("small", {}, "CLOSING BELL · WINNER"),
        h("h2", { style: { color: winner?.color } }, winner ? winner.name : "—"),
        h("div", { class: "big" }, winner ? money(winner.final) : "")));

    $("#recap-standings").replaceChildren(
      h("div", { class: "st-row st-head" },
        h("span", {}, "#"), h("span", {}, "Trader"), h("span", {}, "Cash"), h("span", {}, "Goods"),
        h("span", {}, "Shorts"), h("span", {}, "Loans"), h("span", {}, "Final"), h("span", {}, "P/L")),
      ...results.map((r, i) => h("div", { class: `st-row ${r.id === state.you ? "me" : ""}`, style: { "--pc": r.color, animationDelay: `${i * 90}ms` } },
        h("span", {}, i + 1), h("b", { class: "st-name" }, r.name),
        h("span", {}, money(r.cash)), h("span", {}, money(r.holdings_value)),
        h("span", { class: r.shorts_value ? "down" : "" }, r.shorts_value ? "-" + money(r.shorts_value) : "—"),
        h("span", { class: r.debt ? "down" : "" }, r.debt ? `-${money(r.debt + r.penalty)}` : "—"),
        h("b", {}, money(r.final)),
        h("span", { class: r.final >= start ? "up" : "down" }, (r.final >= start ? "+" : "") + money(r.final - start)))));

    // ---- commodity tabs + chart replay ----
    const tabs = $("#recap-tabs");
    tabs.replaceChildren(...this.w.commodities.map((c, i) => h("button", {
      class: `tab ${i === 0 ? "active" : ""}`, style: { "--accent": c.color },
      onclick: (e) => {
        tabs.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
        e.currentTarget.classList.add("active");
        this.showChart(c, recap);
      },
    }, c.name)));
    const players = Object.fromEntries(results.map((r) => [r.id, r]));
    $("#recap-legend").replaceChildren(
      h("span", {}, "▲ buy / cover   ▼ sell / short   ┊ news event"),
      ...results.map((r) => h("span", { class: "legend-item", style: { color: r.color } }, "● " + r.name)));
    this.players = players;
    this.tickS = tickS;
    this.showChart(this.w.commodities[0], recap);

    // ---- rumors: real or fake? ----
    $("#recap-rumors").replaceChildren(...(recap.rumors.length ? recap.rumors.map((r) => h("div", { class: `rumor ${r.fake ? "fake" : "real"}` },
      h("span", { class: "rumor-tag" }, r.fake ? "FAKE" : "TRUE"),
      h("span", { class: "news-time" }, clock(r.t)),
      h("span", {}, r.text),
      r.fake ? h("small", {}, ` — planted by ${r.author}`) : h("small", {}, " — leaked ahead of real news"))) : [h("p", { class: "muted" }, "No rumors this match.")]));

    // ---- card plays ----
    $("#recap-cards").replaceChildren(...(recap.cards.length ? recap.cards.map((c) => h("div", { class: "card-log" },
      h("span", { class: "news-time" }, clock(c.t)),
      h("b", { style: { color: c.color } }, c.player), ` played ${c.card}`,
      c.target ? ` on ${c.target}` : "", c.commodity ? ` (${c.commodity})` : "",
      c.blocked ? h("span", { class: "down" }, " — BLOCKED by shield") : "")) : [h("p", { class: "muted" }, "No cards played.")]));

    // ---- buttons ----
    const isHost = state.host_id === state.you;
    const again = $("#btn-again");
    again.hidden = !isHost;
    again.onclick = () => this.send({ type: "play_again" });
    $("#recap-wait").hidden = isHost;
  }

  showChart(commodity, recap) {
    const canvas = $("#recap-canvas");
    const markers = recap.trades.filter((t) => t.commodity === commodity.id).map((t) => ({
      x: t.t / this.tickS, price: t.price, color: t.color, up: t.side === "buy" || t.side === "cover",
      label: `${clock(t.t)} ${t.name} ${t.side.toUpperCase()} ${t.qty} @ $${t.price.toFixed(2)} (${money(t.value)})`,
    }));
    const events = recap.events.map((e) => ({ x: e.t / this.tickS, label: `${clock(e.t)} 📰 ${e.text}`, color: "rgba(255, 197, 71, 0.35)" }));
    this.chart = new RecapChart(canvas, commodity.color, recap.history[commodity.id], markers, events, $("#tooltip"));
  }

  frame(now) {
    // Keep redrawing (cheap) so resizes and the replay animation stay smooth.
    this.chart?.draw(now);
  }
}
