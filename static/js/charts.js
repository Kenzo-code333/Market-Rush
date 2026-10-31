// =====================================================================
// charts.js — hand-written <canvas> charts, tuned for smoothness.
//
// Why not Chart.js? The server only sends a new price once per second.
// To make the market feel alive at 60 frames/second we need to
// *interpolate* between those updates: the time axis scrolls
// continuously, the live price "head" glides to its new value and the
// y-axis rescales gently. That is ~150 lines of canvas code — simpler
// than bending a general-purpose library into doing it.
// =====================================================================

const lerp = (a, b, k) => a + (b - a) * k;

/** Resize a canvas to its on-screen size × devicePixelRatio (crisp lines). */
function fitCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(canvas.clientWidth * dpr);
  const hgt = Math.round(canvas.clientHeight * dpr);
  if (canvas.width !== w || canvas.height !== hgt) {
    canvas.width = w;
    canvas.height = hgt;
  }
  return { w, h: hgt, dpr };
}

function hexToRgba(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

// ---------------------------------------------------------------------
// LiveChart: one scrolling chart per commodity during the match.
// ---------------------------------------------------------------------
export class LiveChart {
  constructor(canvas, color, windowSeconds = 90, tickSeconds = 1) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.color = color;
    this.window = windowSeconds / tickSeconds; // in ticks
    this.tickMs = tickSeconds * 1000;
    this.points = [];       // points[i] = price at tick i
    this.head = null;       // latest live price (target)
    this.shownHead = null;  // what we currently draw (eases towards head)
    this.tickAt = performance.now();
    this.shownX = null;     // smoothed "now" on the x axis
    this.yMin = null;
    this.yMax = null;
    this.floor = null;      // cornering floor (dashed line)
    this.running = false;   // only scroll while the market is open
  }

  setHistory(values) {
    this.points = values.slice();
    const last = values[values.length - 1];
    this.head = last;
    if (this.shownHead === null) this.shownHead = last;
    this.tickAt = performance.now();
    this.shownX = null;
  }

  addTick(value) {
    this.points.push(value);
    this.head = value;
    this.tickAt = performance.now();
  }

  setHead(value) { this.head = value; }

  draw(now, dt) {
    const { w, h, dpr } = fitCanvas(this.canvas);
    const ctx = this.ctx;
    ctx.clearRect(0, 0, w, h);
    if (!this.points.length || w === 0) return;

    // --- where is "now" on the x axis? (fractional tick index) ---
    const n = this.points.length - 1;
    const progress = this.running ? Math.min(1, (now - this.tickAt) / this.tickMs) : 0;
    const targetX = n + progress;
    if (this.shownX === null || Math.abs(targetX - this.shownX) > 3) this.shownX = targetX;
    this.shownX = lerp(this.shownX, targetX, Math.min(1, dt * 12));
    const k = Math.min(1, dt * 10);
    this.shownHead = lerp(this.shownHead, this.head, k);

    const xMax = this.shownX;
    const xMin = xMax - this.window;
    const padR = 10 * dpr, padT = 8 * dpr, padB = 8 * dpr;
    const plotW = w - padR;
    const X = (x) => ((x - xMin) / this.window) * plotW;

    // --- y range (eased so the chart never "jumps") ---
    const first = Math.max(0, Math.floor(xMin));
    let lo = this.shownHead, hi = this.shownHead;
    for (let i = first; i <= n; i++) {
      lo = Math.min(lo, this.points[i]);
      hi = Math.max(hi, this.points[i]);
    }
    if (this.floor) lo = Math.min(lo, this.floor);
    const minSpan = Math.max(hi * 0.04, 0.05);
    if (hi - lo < minSpan) { const mid = (hi + lo) / 2; lo = mid - minSpan / 2; hi = mid + minSpan / 2; }
    const pad = (hi - lo) * 0.12;
    lo -= pad; hi += pad;
    if (this.yMin === null) { this.yMin = lo; this.yMax = hi; }
    this.yMin = lerp(this.yMin, lo, Math.min(1, dt * 5));
    this.yMax = lerp(this.yMax, hi, Math.min(1, dt * 5));
    const Y = (v) => padT + (1 - (v - this.yMin) / (this.yMax - this.yMin)) * (h - padT - padB);

    // --- grid ---
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(120, 160, 220, 0.08)";
    ctx.beginPath();
    for (let i = 1; i < 4; i++) {
      const y = Math.round((h * i) / 4) + 0.5;
      ctx.moveTo(0, y); ctx.lineTo(w, y);
    }
    // vertical lines every 15 seconds, scrolling with time
    const step = 15;
    for (let x = Math.ceil(xMin / step) * step; x < xMax; x += step) {
      const px = Math.round(X(x)) + 0.5;
      ctx.moveTo(px, 0); ctx.lineTo(px, h);
    }
    ctx.stroke();

    // --- price line path ---
    const path = new Path2D();
    const startI = Math.max(0, first - 1);
    path.moveTo(X(startI), Y(this.points[startI]));
    for (let i = startI + 1; i <= n; i++) path.lineTo(X(i), Y(this.points[i]));
    const headX = X(xMax), headY = Y(this.shownHead);
    path.lineTo(headX, headY);

    // gradient fill under the line
    const fill = new Path2D(path);
    fill.lineTo(headX, h);
    fill.lineTo(X(startI), h);
    fill.closePath();
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, hexToRgba(this.color, 0.28));
    grad.addColorStop(1, hexToRgba(this.color, 0));
    ctx.fillStyle = grad;
    ctx.fill(fill);

    ctx.lineJoin = "round";
    ctx.lineWidth = 2 * dpr;
    ctx.strokeStyle = this.color;
    ctx.shadowColor = this.color;
    ctx.shadowBlur = 8 * dpr;
    ctx.stroke(path);
    ctx.shadowBlur = 0;

    // --- cornering floor ---
    if (this.floor) {
      const fy = Y(this.floor);
      ctx.setLineDash([5 * dpr, 4 * dpr]);
      ctx.strokeStyle = "rgba(255, 216, 77, 0.8)";
      ctx.lineWidth = 1 * dpr;
      ctx.beginPath(); ctx.moveTo(0, fy); ctx.lineTo(w, fy); ctx.stroke();
      ctx.setLineDash([]);
    }

    // --- dashed line at the live price + pulsing head dot ---
    ctx.strokeStyle = hexToRgba(this.color, 0.35);
    ctx.setLineDash([2 * dpr, 4 * dpr]);
    ctx.lineWidth = 1 * dpr;
    ctx.beginPath(); ctx.moveTo(0, headY); ctx.lineTo(w, headY); ctx.stroke();
    ctx.setLineDash([]);

    const pulse = (Math.sin(now / 250) + 1) / 2;
    ctx.fillStyle = hexToRgba(this.color, 0.25 * (1 - pulse) + 0.05);
    ctx.beginPath(); ctx.arc(headX, headY, (5 + pulse * 6) * dpr, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.beginPath(); ctx.arc(headX, headY, 2.6 * dpr, 0, Math.PI * 2); ctx.fill();
  }
}

// ---------------------------------------------------------------------
// RecapChart: the whole match, drawn as an animated replay, with
// markers for big trades and news events. Hover a marker for details.
// ---------------------------------------------------------------------
export class RecapChart {
  /**
   * values   : full price history (one per tick)
   * markers  : [{x (tick), price, color, up (bool), label}]
   * events   : [{x (tick), label, color}]  vertical lines
   */
  constructor(canvas, color, values, markers, events, tooltipEl) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.color = color;
    this.values = values;
    this.markers = markers;
    this.events = events;
    this.tooltip = tooltipEl;
    this.startedAt = performance.now();
    this.duration = 2600; // replay length in ms
    this.hit = [];        // marker screen positions for hover
    // Assign (not addEventListener) so a new chart replaces the old handlers.
    canvas.onmousemove = (e) => this.onHover(e);
    canvas.onmouseleave = () => { this.tooltip.hidden = true; };
  }

  /** Returns true while the replay animation is still running. */
  draw(now) {
    const { w, h, dpr } = fitCanvas(this.canvas);
    const ctx = this.ctx;
    ctx.clearRect(0, 0, w, h);
    const vals = this.values;
    if (vals.length < 2 || w === 0) return false;

    const progress = Math.min(1, (now - this.startedAt) / this.duration);
    const eased = 1 - Math.pow(1 - progress, 2);
    const shownUpTo = eased * (vals.length - 1);

    const padL = 52 * dpr, padR = 12 * dpr, padT = 18 * dpr, padB = 22 * dpr;
    let lo = Math.min(...vals), hi = Math.max(...vals);
    const pad = (hi - lo) * 0.1 || hi * 0.05;
    lo -= pad; hi += pad;
    const X = (x) => padL + (x / (vals.length - 1)) * (w - padL - padR);
    const Y = (v) => padT + (1 - (v - lo) / (hi - lo)) * (h - padT - padB);

    // axes / grid with price labels
    ctx.font = `${10 * dpr}px "JetBrains Mono", monospace`;
    ctx.fillStyle = "rgba(170, 190, 230, 0.55)";
    ctx.strokeStyle = "rgba(120, 160, 220, 0.1)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i <= 4; i++) {
      const v = lo + ((hi - lo) * i) / 4;
      const y = Math.round(Y(v)) + 0.5;
      ctx.moveTo(padL, y); ctx.lineTo(w - padR, y);
      ctx.fillText("$" + v.toFixed(v < 100 ? 2 : 0), 4 * dpr, y + 3 * dpr);
    }
    for (let s = 0; s < vals.length; s += 60) {
      const x = Math.round(X(s)) + 0.5;
      ctx.moveTo(x, padT); ctx.lineTo(x, h - padB);
      ctx.fillText(`${s / 60}:00`, x - 10 * dpr, h - 6 * dpr);
    }
    ctx.stroke();

    // news events as vertical lines
    for (const ev of this.events) {
      if (ev.x > shownUpTo) continue;
      ctx.strokeStyle = ev.color;
      ctx.setLineDash([3 * dpr, 3 * dpr]);
      ctx.beginPath(); ctx.moveTo(X(ev.x), padT); ctx.lineTo(X(ev.x), h - padB); ctx.stroke();
      ctx.setLineDash([]);
    }

    // price line (revealed progressively = the "replay")
    ctx.beginPath();
    ctx.moveTo(X(0), Y(vals[0]));
    const last = Math.floor(shownUpTo);
    for (let i = 1; i <= last; i++) ctx.lineTo(X(i), Y(vals[i]));
    if (last < vals.length - 1) {
      const f = shownUpTo - last;
      ctx.lineTo(X(shownUpTo), Y(lerp(vals[last], vals[last + 1], f)));
    }
    ctx.lineWidth = 2 * dpr;
    ctx.strokeStyle = this.color;
    ctx.shadowColor = this.color;
    ctx.shadowBlur = 6 * dpr;
    ctx.stroke();
    ctx.shadowBlur = 0;

    // big-trade markers (▲ buy/cover, ▼ sell/short), popping in as the line passes
    this.hit = [];
    for (const m of this.markers) {
      if (m.x > shownUpTo) continue;
      const x = X(m.x), y = Y(m.price);
      const s = 6 * dpr;
      ctx.fillStyle = m.color;
      ctx.strokeStyle = "#05070d";
      ctx.lineWidth = 1.5 * dpr;
      ctx.beginPath();
      if (m.up) { ctx.moveTo(x, y - s); ctx.lineTo(x + s, y + s * 0.8); ctx.lineTo(x - s, y + s * 0.8); }
      else { ctx.moveTo(x, y + s); ctx.lineTo(x + s, y - s * 0.8); ctx.lineTo(x - s, y - s * 0.8); }
      ctx.closePath(); ctx.fill(); ctx.stroke();
      this.hit.push({ x: x / dpr, y: y / dpr, label: m.label });
    }
    for (const ev of this.events) {
      if (ev.x <= shownUpTo) this.hit.push({ x: X(ev.x) / dpr, y: padT / dpr, label: ev.label, loose: true });
    }
    return progress < 1;
  }

  onHover(e) {
    const r = this.canvas.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    let best = null, bestD = 14;
    for (const p of this.hit) {
      const d = p.loose ? Math.abs(p.x - mx) + (my < 40 ? 0 : 999) : Math.hypot(p.x - mx, p.y - my);
      if (d < bestD) { bestD = d; best = p; }
    }
    if (!best) { this.tooltip.hidden = true; return; }
    this.tooltip.hidden = false;
    this.tooltip.textContent = best.label;
    this.tooltip.style.left = `${e.clientX + 12}px`;
    this.tooltip.style.top = `${e.clientY + 12}px`;
  }
}
