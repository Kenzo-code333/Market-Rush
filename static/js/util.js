// =====================================================================
// util.js — small helpers shared by every screen.
// (Think of this like a Python "utils.py" module.)
// =====================================================================

/**
 * h("div", {class: "x", onclick: fn}, child1, "text", ...) -> HTMLElement
 * A tiny helper to build DOM elements without writing HTML strings.
 */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else if (key === "style" && typeof value === "object") {
      for (const [prop, v] of Object.entries(value)) {
        if (v === null || v === undefined) continue;
        // CSS variables like "--accent" need setProperty()
        if (prop.startsWith("--")) el.style.setProperty(prop, v);
        else el.style[prop] = v;
      }
    }
    else if (key === "dataset") Object.assign(el.dataset, value);
    else el.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export const $ = (sel) => document.querySelector(sel);

// ---- number formatting ---------------------------------------------------
export function money(x, decimals = 0) {
  const sign = x < 0 ? "-" : "";
  return sign + "$" + Math.abs(x).toLocaleString("en-US", {
    minimumFractionDigits: decimals, maximumFractionDigits: decimals,
  });
}
export function price(x) {
  return "$" + x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
export function pct(x) {
  return (x >= 0 ? "+" : "") + (x * 100).toFixed(1) + "%";
}
export function clock(seconds) {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Set text only if it changed (avoids needless re-layout = smoother). */
export function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

/** Restart a CSS animation class on an element (e.g. a green flash). */
export function flash(el, cls) {
  el.classList.remove("flash-up", "flash-down", "flash");
  void el.offsetWidth; // force reflow so the animation restarts
  el.classList.add(cls);
}

// ---- smooth number tweening ------------------------------------------------
// Numbers like net worth glide to their new value instead of jumping.
const tweens = new Map(); // element -> {from, to, start, duration, format}

export function tweenNumber(el, to, format, duration = 450) {
  const current = el._value ?? to;
  if (current === to && el._value !== undefined) return;
  tweens.set(el, { from: current, to, start: performance.now(), duration, format });
  if (el._value === undefined) { el._value = to; setText(el, format(to)); }
}

/** Called every animation frame by the main loop. */
export function stepTweens(now) {
  for (const [el, tw] of tweens) {
    const k = Math.min(1, (now - tw.start) / tw.duration);
    const eased = 1 - Math.pow(1 - k, 3); // ease-out cubic
    el._value = tw.from + (tw.to - tw.from) * eased;
    setText(el, tw.format(el._value));
    if (k >= 1) tweens.delete(el);
  }
}

// ---- toasts (little pop-up messages) ------------------------------------------
export function toast(text, level = "info") {
  const box = $("#toasts");
  const el = h("div", { class: `toast ${level}` }, text);
  box.append(el);
  while (box.children.length > 5) box.firstChild.remove();
  setTimeout(() => el.classList.add("out"), 3200);
  setTimeout(() => el.remove(), 3700);
}

// ---- modal dialog -------------------------------------------------------------
/** Show a modal with a title and a list of {label, sub, color, onClick} choices. */
export function choose(title, subtitle, options) {
  const modal = $("#modal");
  const close = () => { modal.hidden = true; modal.replaceChildren(); };
  const box = h("div", { class: "modal-box" },
    h("h3", {}, title),
    subtitle ? h("p", { class: "muted" }, subtitle) : null,
    h("div", { class: "modal-options" },
      options.map((o) => h("button", {
        class: "btn option", style: o.color ? { borderColor: o.color, color: o.color } : null,
        disabled: o.disabled,
        onclick: () => { close(); o.onClick(); },
      }, o.label, o.sub ? h("small", {}, o.sub) : null))),
    h("button", { class: "btn ghost", onclick: close }, "Cancel"));
  modal.replaceChildren(box);
  modal.hidden = false;
  modal.onclick = (e) => { if (e.target === modal) close(); };
}
