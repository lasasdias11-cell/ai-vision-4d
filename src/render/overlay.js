// overlay.js — Overlay: canvas-2D debug layer + VideoMapper.
// VideoMapper is the SINGLE place the mirror flip (x → 1−x) and the
// object-fit:cover crop compensation happen. Everything downstream
// (gestures, cursor, scene, HUD) consumes display-normalized coords.

const HAND_LINKS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];
export const HAND_CONNECTIONS = HAND_LINKS;

// Maps raw video-frame landmark coords → display-normalized canvas coords
// (0..1 across the FULL canvas), compensating for object-fit:cover crop and
// the CSS mirror. The only "1 - x" flip in the codebase lives in toNorm().
export class VideoMapper {
  constructor() {
    this.m = { drawW: 1, drawH: 1, offsetX: 0, offsetY: 0, cw: 1, ch: 1 };
  }

  // vw/vh: video frame pixels; cw/ch: canvas CSS pixels.
  compute(vw, vh, cw, ch) {
    const videoAspect = vw / Math.max(1, vh);
    const viewAspect = cw / Math.max(1, ch);
    let drawW, drawH, offsetX, offsetY;
    if (videoAspect > viewAspect) {
      drawH = ch; drawW = ch * videoAspect;
      offsetX = (cw - drawW) / 2; offsetY = 0;
    } else {
      drawW = cw; drawH = cw / videoAspect;
      offsetX = 0; offsetY = (ch - drawH) / 2;
    }
    this.m = { drawW, drawH, offsetX, offsetY, cw, ch };
    return this.m;
  }

  // Raw landmark {x,y} (0..1 video frame) → normalized canvas coords.
  toNorm(p, m = this.m) {
    if (!p) return p;
    return {
      x: (m.offsetX + (1 - p.x) * m.drawW) / m.cw,
      y: (m.offsetY + p.y * m.drawH) / m.ch,
    };
  }

  // Raw landmark → canvas CSS pixels (for the guide/demo path).
  toScreen(p, m = this.m) {
    const n = this.toNorm(p, m);
    return { x: n.x * m.cw, y: n.y * m.ch };
  }

  // Convert a whole landmark array.
  mapHand(hand) {
    return hand.map((p) => this.toNorm(p));
  }
  mapHands(hands) {
    return hands.map((h) => this.mapHand(h));
  }
  mapFace(face) {
    return face.map((f) => f.map((p) => this.toNorm(p)));
  }
}

/** Draw a 21-point skeleton from DISPLAY-normalized coords (0..1 canvas). */
export function drawSkeleton(ctx, landmarks, view = {}) {
  if (!landmarks || landmarks.length < 21) return;
  const w = view.width || ctx.canvas.width;
  const h = view.height || ctx.canvas.height;
  const pad = view.pad ?? 0;
  const iw = w - pad * 2;
  const ih = h - pad * 2;
  const map = (p) => ({ x: pad + p.x * iw, y: pad + p.y * ih });
  const color = view.color || "rgba(105,216,255,.86)";
  const tipColor = view.tipColor || "#fff";
  ctx.save();
  if (view.glow !== false) { ctx.shadowBlur = 8; ctx.shadowColor = color; }
  ctx.strokeStyle = color;
  ctx.lineWidth = view.lineWidth || 2;
  ctx.lineCap = "round";
  for (const [a, b] of HAND_LINKS) {
    const pa = map(landmarks[a]), pb = map(landmarks[b]);
    ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
  }
  ctx.shadowBlur = 0;
  for (let i = 0; i < landmarks.length; i++) {
    const p = map(landmarks[i]);
    ctx.fillStyle = i === 8 ? tipColor : "rgba(210,242,255,.85)";
    ctx.beginPath(); ctx.arc(p.x, p.y, i === 8 ? 3.5 : 1.8, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

export class Overlay {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.trailsOn = true;
    this.cursorOn = true;
    this.mapper = new VideoMapper();
    this._dpr = 1;
    this._w = 1; this._h = 1; // CSS-pixel canvas size (cached rect)
  }

  // FIX-5/F6: size from the element's own rect (not innerWidth) so overlay
  // and video always agree regardless of layout.
  resize() {
    const rect = this.canvas.getBoundingClientRect();
    this._w = Math.max(1, rect.width);
    this._h = Math.max(1, rect.height);
    this._dpr = Math.min(window.devicePixelRatio || 1, 1.6);
    this.canvas.width = Math.max(1, Math.floor(this._w * this._dpr));
    this.canvas.height = Math.max(1, Math.floor(this._h * this._dpr));
    this.ctx.setTransform(this._dpr, 0, 0, this._dpr, 0, 0);
  }

  // Recompute the cover-crop mapping from live video dims + canvas size.
  updateMapping(video) {
    if (video && video.videoWidth && video.videoHeight) {
      this.mapper.compute(video.videoWidth, video.videoHeight, this._w, this._h);
    } else {
      this.mapper.compute(this._w, this._h, this._w, this._h);
    }
  }

  get w() { return this._w; }
  get h() { return this._h; }

  _X(x) { return x * this._w; }
  _Y(y) { return y * this._h; }

  line(a, b, color = "rgba(105,216,255,.85)", width = 2) {
    const c = this.ctx;
    c.strokeStyle = color; c.lineWidth = width;
    c.beginPath();
    c.moveTo(this._X(a.x), this._Y(a.y));
    c.lineTo(this._X(b.x), this._Y(b.y));
    c.stroke();
  }

  point(p, color = "#fff", r = 3) {
    const c = this.ctx;
    c.fillStyle = color; c.shadowBlur = 10; c.shadowColor = color;
    c.beginPath(); c.arc(this._X(p.x), this._Y(p.y), r, 0, Math.PI * 2); c.fill();
    c.shadowBlur = 0;
  }

  drawHands(hands, reducedMotion = false) {
    hands.forEach((hand, hi) => {
      drawSkeleton(this.ctx, hand, {
        width: this._w, height: this._h,
        color: hi ? "rgba(142,140,255,.78)" : "rgba(105,216,255,.9)",
        glow: !reducedMotion,
      });
    });
  }

  drawTrails(trails) {
    if (!this.trailsOn) return;
    trails.forEach((trail, fi) => {
      if (trail.length < 2) return;
      for (let i = 1; i < trail.length; i++) {
        const a = trail[i - 1], b = trail[i], alpha = i / trail.length;
        this.line(a, b,
          `rgba(${fi === 0 ? 255 : 105},${fi === 0 ? 220 : 216},255,${(alpha * 0.35).toFixed(3)})`,
          1.2 + alpha * 1.5);
      }
    });
  }

  drawFace(face) {
    if (!face?.length) return;
    const pts = face[0];
    const c = this.ctx;
    c.strokeStyle = "rgba(190,175,255,.18)"; c.lineWidth = 1;
    c.beginPath();
    for (let i = 0; i < pts.length; i += 7) {
      const p = pts[i];
      const x = this._X(p.x), y = this._Y(p.y);
      i ? c.lineTo(x, y) : c.moveTo(x, y);
    }
    c.stroke();
  }

  drawAir(path) {
    if (!path || path.length < 2) return;
    const c = this.ctx;
    c.strokeStyle = "rgba(255,255,255,.72)"; c.lineWidth = 2;
    c.shadowBlur = 10; c.shadowColor = "#fff";
    c.beginPath();
    path.forEach((p, i) => { const x = this._X(p.x), y = this._Y(p.y); i ? c.lineTo(x, y) : c.moveTo(x, y); });
    c.stroke(); c.shadowBlur = 0;
  }

  drawAirProgress(point, progress, candidate) {
    if (!point || !progress) return;
    const c = this.ctx;
    const x = this._X(point.x), y = this._Y(point.y);
    const r = 22;
    c.lineWidth = 3;
    c.strokeStyle = "rgba(255,255,255,.18)";
    c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.stroke();
    c.strokeStyle = "#fff"; c.shadowBlur = 8; c.shadowColor = "#fff";
    c.beginPath(); c.arc(x, y, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * progress); c.stroke();
    c.shadowBlur = 0;
    if (candidate && progress > 0.4) {
      c.fillStyle = "rgba(255,255,255,.85)";
      c.font = "600 10px ui-monospace,monospace"; c.textAlign = "center";
      c.fillText(candidate, x, y - r - 8);
    }
  }

  drawSpawnPulses(pulses) {
    if (!pulses?.length) return;
    const c = this.ctx;
    const now = performance.now();
    for (const p of pulses) {
      const age = (now - p.t) / 300;
      if (age < 0 || age >= 1) continue;
      const x = this._X(p.x), y = this._Y(p.y);
      c.strokeStyle = `rgba(105,216,255,${(1 - age).toFixed(3)})`;
      c.lineWidth = 2.5 * (1 - age) + 0.5;
      c.shadowBlur = 12; c.shadowColor = "#69d8ff";
      c.beginPath(); c.arc(x, y, 10 + age * 42, 0, Math.PI * 2); c.stroke();
      c.shadowBlur = 0;
    }
    for (let i = pulses.length - 1; i >= 0; i--) {
      if (now - pulses[i].t > 400) pulses.splice(i, 1);
    }
  }

  drawCursor(point) {
    if (!this.cursorOn || !point) return;
    const c = this.ctx;
    const x = this._X(point.x), y = this._Y(point.y);
    c.strokeStyle = "rgba(255,255,255,.65)"; c.lineWidth = 1.4;
    c.beginPath(); c.arc(x, y, 9, 0, Math.PI * 2); c.stroke();
    c.beginPath();
    c.moveTo(x - 14, y); c.lineTo(x - 5, y);
    c.moveTo(x + 5, y); c.lineTo(x + 14, y);
    c.moveTo(x, y - 14); c.lineTo(x, y - 5);
    c.moveTo(x, y + 5); c.lineTo(x, y + 14);
    c.stroke();
  }

  clear() { this.ctx.clearRect(0, 0, this._w, this._h); }

  // All coords passed here are DISPLAY-normalized (post-VideoMapper).
  render(state = {}) {
    const c = this.ctx;
    c.clearRect(0, 0, this._w, this._h);
    const reduced = state.reducedMotion;
    if (state.trails !== false && this.trailsOn) this.drawTrails(state.trails || []);
    if (state.airPath) this.drawAir(state.airPath);
    if (state.airProgress) this.drawAirProgress(state.airPoint, state.airProgress, state.airCandidate);
    if (state.hands) this.drawHands(state.hands, reduced);
    if (state.face) this.drawFace(state.face);
    if (state.spawnPulses) this.drawSpawnPulses(state.spawnPulses);
    if (state.cursorPoint) this.drawCursor(state.cursorPoint);
  }
}
