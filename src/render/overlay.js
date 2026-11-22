// overlay.js — Overlay: canvas-2D debug layer (hand skeleton, trails, face
// mesh, air-draw path + dwell ring, fingertip cursor).
//
// Exports drawSkeleton() so the GestureGuide modal renders its synthetic
// poses with the EXACT same skeleton style as live hands (spec §6).

const HAND_LINKS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

export const HAND_CONNECTIONS = HAND_LINKS;

/**
 * Draw a 21-point hand skeleton.
 * @param {CanvasRenderingContext2D} ctx
 * @param {Array<{x:number,y:number}>} landmarks  normalized 0..1 OR pixel coords
 *   when `view.rawPixels` is true
 * @param {{width:number,height:number,pad?:number,color?:string,glow?:boolean}} view
 */
export function drawSkeleton(ctx, landmarks, view = {}) {
  if (!landmarks || landmarks.length < 21) return;
  const w = view.width || ctx.canvas.width;
  const h = view.height || ctx.canvas.height;
  const pad = view.pad ?? 0;
  const iw = w - pad * 2;
  const ih = h - pad * 2;
  const map = (p) => ({
    x: pad + p.x * iw,
    y: pad + p.y * ih,
  });
  const color = view.color || "rgba(105,216,255,.86)";
  const tipColor = view.tipColor || "#fff";

  ctx.save();
  if (view.glow !== false) {
    ctx.shadowBlur = 8;
    ctx.shadowColor = color;
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = view.lineWidth || 2;
  ctx.lineCap = "round";
  for (const [a, b] of HAND_LINKS) {
    const pa = map(landmarks[a]);
    const pb = map(landmarks[b]);
    ctx.beginPath();
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(pb.x, pb.y);
    ctx.stroke();
  }
  ctx.shadowBlur = 0;
  for (let i = 0; i < landmarks.length; i++) {
    const p = map(landmarks[i]);
    ctx.fillStyle = i === 8 ? tipColor : "rgba(210,242,255,.85)";
    ctx.beginPath();
    ctx.arc(p.x, p.y, i === 8 ? 3.5 : 1.8, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

export class Overlay {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.trailsOn = true;
    this.cursorOn = true;
    this._dpr = 1;
  }

  resize() {
    this._dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    this.canvas.width = Math.max(1, Math.floor(window.innerWidth * this._dpr));
    this.canvas.height = Math.max(1, Math.floor(window.innerHeight * this._dpr));
    this.canvas.style.width = "100%";
    this.canvas.style.height = "100%";
    this.ctx.setTransform(this._dpr, 0, 0, this._dpr, 0, 0);
  }

  get w() { return window.innerWidth; }
  get h() { return window.innerHeight; }

  _X(x) { return x * this.w; }
  _Y(y) { return y * this.h; }

  line(a, b, color = "rgba(105,216,255,.85)", width = 2) {
    const c = this.ctx;
    c.strokeStyle = color;
    c.lineWidth = width;
    c.beginPath();
    c.moveTo(this._X(a.x), this._Y(a.y));
    c.lineTo(this._X(b.x), this._Y(b.y));
    c.stroke();
  }

  point(p, color = "#fff", r = 3) {
    const c = this.ctx;
    c.fillStyle = color;
    c.shadowBlur = 10;
    c.shadowColor = color;
    c.beginPath();
    c.arc(this._X(p.x), this._Y(p.y), r, 0, Math.PI * 2);
    c.fill();
    c.shadowBlur = 0;
  }

  drawHands(hands, reducedMotion = false) {
    const c = this.ctx;
    hands.forEach((hand, hi) => {
      drawSkeleton(c, hand, {
        width: this.w,
        height: this.h,
        color: hi ? "rgba(142,140,255,.78)" : "rgba(105,216,255,.9)",
        glow: !reducedMotion,
      });
    });
  }

  drawTrails(trails) {
    if (!this.trailsOn) return;
    const c = this.ctx;
    trails.forEach((trail, fi) => {
      if (trail.length < 2) return;
      for (let i = 1; i < trail.length; i++) {
        const a = trail[i - 1], b = trail[i];
        const alpha = i / trail.length;
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
    c.strokeStyle = "rgba(190,175,255,.18)";
    c.lineWidth = 1;
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
    c.strokeStyle = "rgba(255,255,255,.72)";
    c.lineWidth = 2;
    c.shadowBlur = 10;
    c.shadowColor = "#fff";
    c.beginPath();
    path.forEach((p, i) => {
      const x = this._X(p.x), y = this._Y(p.y);
      i ? c.lineTo(x, y) : c.moveTo(x, y);
    });
    c.stroke();
    c.shadowBlur = 0;
  }

  // Dwell progress ring drawn at the current fingertip while a closed air
  // loop is being held (D13 visibility requirement).
  drawAirProgress(point, progress, candidate) {
    if (!point || !progress) return;
    const c = this.ctx;
    const x = this._X(point.x), y = this._Y(point.y);
    const r = 22;
    c.lineWidth = 3;
    c.strokeStyle = "rgba(255,255,255,.18)";
    c.beginPath();
    c.arc(x, y, r, 0, Math.PI * 2);
    c.stroke();
    c.strokeStyle = "#fff";
    c.shadowBlur = 8;
    c.shadowColor = "#fff";
    c.beginPath();
    c.arc(x, y, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * progress);
    c.stroke();
    c.shadowBlur = 0;
    if (candidate && progress > 0.4) {
      c.fillStyle = "rgba(255,255,255,.85)";
      c.font = "600 10px ui-monospace,monospace";
      c.textAlign = "center";
      c.fillText(candidate, x, y - r - 8);
    }
  }

  drawCursor(point) {
    if (!this.cursorOn || !point) return;
    const c = this.ctx;
    const x = this._X(point.x), y = this._Y(point.y);
    c.strokeStyle = "rgba(255,255,255,.65)";
    c.lineWidth = 1.4;
    c.beginPath();
    c.arc(x, y, 9, 0, Math.PI * 2);
    c.stroke();
    c.beginPath();
    c.moveTo(x - 14, y); c.lineTo(x - 5, y);
    c.moveTo(x + 5, y); c.lineTo(x + 14, y);
    c.moveTo(x, y - 14); c.lineTo(x, y - 5);
    c.moveTo(x, y + 5); c.lineTo(x, y + 14);
    c.stroke();
  }

  clear() {
    this.ctx.clearRect(0, 0, this.w, this.h);
  }

  render(state = {}) {
    const c = this.ctx;
    c.clearRect(0, 0, this.w, this.h);
    const reduced = state.reducedMotion;
    if (state.trails !== false && this.trailsOn) this.drawTrails(state.trails || []);
    if (state.airPath) this.drawAir(state.airPath);
    if (state.airProgress) this.drawAirProgress(state.airPoint, state.airProgress, state.airCandidate);
    if (state.hands) this.drawHands(state.hands, reduced);
    if (state.face) this.drawFace(state.face);
    if (state.cursorPoint) this.drawCursor(state.cursorPoint);
  }
}
