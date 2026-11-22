// air-draw.js — AirDrawingEngine: captures the fingertip path while POINT is
// active in DRAW mode, detects a closed dwell loop, classifies the shape, and
// emits it once per cooldown window.
//
// Defect D13 fix: a shape only fires after ALL of —
//   closed loop + minimum enclosed area + 700 ms continuous dwell
//   + a second cooldown after the spawn.

import { polygonArea, clamp } from "../utils/math.js";

const MIN_POINTS = 12;
const MIN_AREA = 0.004; // normalized-coordinate shoelace area
const CLOSE_EPS = 0.09; // endpoint gap as fraction of bbox diagonal
const DWELL_MS = 700;
const COOLDOWN_MS = 2000;
const RESAMPLE_N = 64;
const CORNER_ANGLE = (55 * Math.PI) / 180; // direction change that counts as a corner

export class AirDrawingEngine {
  constructor({ maxSamples = 90, dwellMs = DWELL_MS, cooldownMs = COOLDOWN_MS, onShape = () => {} } = {}) {
    this.maxSamples = maxSamples;
    this.dwellMs = dwellMs;
    this.cooldownMs = cooldownMs;
    this.onShape = onShape;

    this.path = []; // [{x,y,t}] in screen space (0..1)
    this.enabled = true;
    this._closedSince = 0;
    this._lastFire = 0;
    this._lastPoint = null;
    this.progress = 0; // 0..1 dwell progress for the HUD ring
    this.candidate = null; // shape name while dwelling
  }

  reset() {
    this.path.length = 0;
    this._closedSince = 0;
    this._lastPoint = null;
    this.progress = 0;
    this.candidate = null;
  }

  clear() {
    this.reset();
  }

  // point: {x,y} screen-space or null when the gesture ended.
  update(point, nowMs) {
    if (!this.enabled) {
      this.reset();
      return null;
    }
    if (!point) {
      // Gesture ended: keep the path briefly so the dwell can complete if the
      // loop was already closed, otherwise decay it.
      if (this.path.length && nowMs - (this.path[this.path.length - 1].t || 0) > 350) {
        this.reset();
      }
      return null;
    }

    const last = this.path[this.path.length - 1];
    // Decimate: skip points closer than ~0.004 normalized units.
    if (last && Math.hypot(point.x - last.x, point.y - last.y) < 0.004) {
      return this._tick(nowMs);
    }
    this.path.push({ x: point.x, y: point.y, t: nowMs });
    if (this.path.length > this.maxSamples) {
      // Uniform decimation: drop every other interior sample, keep endpoints.
      const next = [this.path[0]];
      for (let i = 2; i < this.path.length - 1; i += 2) next.push(this.path[i]);
      next.push(this.path[this.path.length - 1]);
      this.path = next;
    }
    this._lastPoint = point;
    return this._tick(nowMs);
  }

  _tick(nowMs) {
    const closed = this._isClosedLoop();
    if (!closed) {
      this._closedSince = 0;
      this.progress = 0;
      this.candidate = null;
      return null;
    }
    if (!this._closedSince) this._closedSince = nowMs;
    this.progress = clamp((nowMs - this._closedSince) / this.dwellMs, 0, 1);
    this.candidate = this._classify();
    if (this.progress >= 1 && nowMs - this._lastFire >= this.cooldownMs) {
      const shape = this.candidate || "SHAPE";
      this._lastFire = nowMs;
      this.onShape(shape, this.path.slice(), this._lastPoint);
      this.reset();
      return shape;
    }
    return null;
  }

  _isClosedLoop() {
    const p = this.path;
    if (p.length < MIN_POINTS) return false;
    const area = polygonArea(p);
    if (area < MIN_AREA) return false;
    const first = p[0], last = p[p.length - 1];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const q of p) {
      if (q.x < minX) minX = q.x;
      if (q.y < minY) minY = q.y;
      if (q.x > maxX) maxX = q.x;
      if (q.y > maxY) maxY = q.y;
    }
    const diag = Math.hypot(maxX - minX, maxY - minY) || 1;
    const gap = Math.hypot(last.x - first.x, last.y - first.y);
    // Path must be old enough to have dwelt a little AND endpoints near each other.
    const span = last.t - first.t;
    return gap / diag < CLOSE_EPS && span > 250;
  }

  // Resample to N points by arc length, then analyze direction changes.
  _resample() {
    const p = this.path;
    if (p.length < 3) return p;
    const seg = [];
    let total = 0;
    for (let i = 1; i < p.length; i++) {
      const l = Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y);
      seg.push(l);
      total += l;
    }
    if (total <= 0) return p;
    const step = total / (RESAMPLE_N - 1);
    const out = [p[0]];
    let acc = 0, si = 0;
    for (let k = 1; k < RESAMPLE_N; k++) {
      const target = k * step;
      while (si < seg.length - 1 && acc + seg[si] < target) {
        acc += seg[si];
        si++;
      }
      const segLen = seg[si] || 1e-6;
      const t = clamp((target - acc) / segLen, 0, 1);
      const a = p[si], b = p[Math.min(si + 1, p.length - 1)];
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
    out[out.length - 1] = p[p.length - 1];
    return out;
  }

  _classify() {
    const pts = this._resample();
    if (pts.length < 8) return "SHAPE";

    // Segment angles and turning angles.
    const angles = [];
    for (let i = 1; i < pts.length; i++) {
      angles.push(Math.atan2(pts[i].y - pts[i - 1].y, pts[i].x - pts[i - 1].x));
    }
    const turns = [];
    for (let i = 1; i < angles.length; i++) {
      let d = angles[i] - angles[i - 1];
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      turns.push(d);
    }

    // Count dominant corners: sustained direction changes, not jitter.
    let corners = 0;
    let inCorner = false;
    let cornerSum = 0;
    for (const t of turns) {
      if (Math.abs(t) > CORNER_ANGLE) {
        if (!inCorner) { corners++; inCorner = true; }
        cornerSum += Math.abs(t);
      } else if (Math.abs(t) < CORNER_ANGLE * 0.5) {
        inCorner = false;
      }
    }

    // Bounding box aspect.
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const q of pts) {
      minX = Math.min(minX, q.x); maxX = Math.max(maxX, q.x);
      minY = Math.min(minY, q.y); maxY = Math.max(maxY, q.y);
    }
    const w = maxX - minX, h = maxY - minY;
    const aspect = Math.max(w, h) / Math.max(1e-6, Math.min(w, h));

    // Endpoints vs path extent: a LINE's endpoints span most of the path.
    const first = pts[0], last = pts[pts.length - 1];
    const endDist = Math.hypot(last.x - first.x, last.y - first.y);
    const pathLen = angles.reduce((s, _, i) => {
      const a = pts[i], b = pts[i + 1];
      return s + Math.hypot(b.x - a.x, b.y - a.y);
    }, 0);
    const straightness = pathLen > 0 ? endDist / pathLen : 0;

    const totalTurn = turns.reduce((s, t) => s + Math.abs(t), 0);

    if (corners <= 1) {
      // Smooth closed loop → circle; open straight run → line.
      const closedGap = Math.hypot(last.x - first.x, last.y - first.y) /
        Math.max(Math.hypot(maxX - minX, maxY - minY), 1e-6);
      if (closedGap < CLOSE_EPS && totalTurn > Math.PI * 1.2) return "CIRCLE";
      if (straightness > 0.82 && aspect > 2.2) return "LINE";
      if (straightness > 0.9) return "LINE";
      return "CIRCLE";
    }
    if (corners === 3) return "TRIANGLE";
    if (corners === 4) return aspect > 1.45 ? "RECTANGLE" : "SQUARE";
    if (corners >= 5) return "ZIGZAG";
    return "SHAPE";
  }
}
