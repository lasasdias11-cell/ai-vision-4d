// gesture-guide.js — GestureGuide modal: 7 animated cards, each rendering a
// synthetic 21-point hand pose through the SAME drawSkeleton() helper used
// for live hands, lerped between neutral and gesture keyframes.
// A single shared rAF runs ONLY while the guide is open.

import { drawSkeleton } from "../render/overlay.js";
import { clamp, lerp } from "../utils/math.js";

// ---------------------------------------------------------------------------
// Pose synthesis. MediaPipe landmark order:
//   0 wrist · 1-4 thumb · 5-8 index · 9-12 middle · 13-16 ring · 17-20 pinky
// All coordinates normalized 0..1, y grows downward (screen space).
// ---------------------------------------------------------------------------

const WRIST = [0.5, 0.8];

// Finger metacarpal bases along the palm arc.
const FINGER_BASE = {
  index:  { mcp: [0.435, 0.6],  len: 0.24 },
  middle: { mcp: [0.5, 0.585],  len: 0.27 },
  ring:   { mcp: [0.565, 0.6],  len: 0.25 },
  pinky:  { mcp: [0.615, 0.625], len: 0.19 },
};

function fingerPoints(base, state) {
  // state: 0 = folded, 1 = extended, 0.5 = relaxed
  const [mx, my] = base.mcp;
  const ext = state; // curl amount
  const curl = (1 - ext);
  // Extended: joints stack upward. Folded: they curl back toward the palm.
  const pip = [mx + curl * 0.035, my + curl * 0.1 - ext * 0.1];
  const dip = [mx + curl * 0.05, my + curl * 0.16 - ext * 0.18];
  const tip = [mx + curl * 0.055, my + curl * 0.2 - ext * 0.25];
  return { mcp: [mx, my], pip, dip, tip };
}

function thumbPoints(state) {
  const curl = 1 - state;
  const cmc = [0.4, 0.68];
  const mcp = [0.365 - curl * 0.02, 0.63 - curl * 0.05];
  const ip = [0.335 - curl * 0.03, 0.585 - curl * 0.09];
  const tip = [0.31 - curl * 0.04, 0.545 - curl * 0.13];
  return { cmc, mcp, ip, tip };
}

// fingers: {index, middle, ring, pinky} each 0..1 ; thumb: 0..1
function buildPose({ thumb = 0.4, index = 0.4, middle = 0.4, ring = 0.4, pinky = 0.4, wrist = WRIST }) {
  const pts = new Array(21);
  pts[0] = { x: wrist[0], y: wrist[1] };

  const th = thumbPoints(thumb);
  pts[1] = { x: th.cmc[0], y: th.cmc[1] };
  pts[2] = { x: th.mcp[0], y: th.mcp[1] };
  pts[3] = { x: th.ip[0], y: th.ip[1] };
  pts[4] = { x: th.tip[0], y: th.tip[1] };

  const fingers = { index, middle, ring, pinky };
  const bases = [
    ["index", 5], ["middle", 9], ["ring", 13], ["pinky", 17],
  ];
  for (const [name, baseIdx] of bases) {
    const f = fingerPoints(FINGER_BASE[name], fingers[name]);
    pts[baseIdx] = { x: f.mcp[0], y: f.mcp[1] };
    pts[baseIdx + 1] = { x: f.pip[0], y: f.pip[1] };
    pts[baseIdx + 2] = { x: f.dip[0], y: f.dip[1] };
    pts[baseIdx + 3] = { x: f.tip[0], y: f.tip[1] };
  }
  return pts;
}

const RELAXED = { thumb: 0.35, index: 0.45, middle: 0.45, ring: 0.4, pinky: 0.35 };

// poseName → {primary:{...finger states}, secondary:{...}|null, action, key}
export const POSES = {
  POINT: {
    gesture: "POINT",
    primary: { thumb: 0.15, index: 1, middle: 0, ring: 0, pinky: 0 },
    secondary: null,
    action: "Select / hover object",
  },
  PINCH: {
    gesture: "PINCH",
    // Thumb tip meets index tip — approximated by extending both toward each
    // other at the pinch point.
    primary: { thumb: 0.9, index: 0.85, middle: 0, ring: 0, pinky: 0 },
    secondary: null,
    action: "Grab & move objects",
    pinchOverride: true,
  },
  PEACE: {
    gesture: "PEACE",
    primary: { thumb: 0.2, index: 1, middle: 1, ring: 0, pinky: 0 },
    secondary: null,
    action: "Cycle interaction mode",
  },
  "OPEN PALM": {
    gesture: "OPEN PALM",
    primary: { thumb: 0.8, index: 1, middle: 1, ring: 1, pinky: 1 },
    secondary: null,
    action: "Deselect / clear drawing",
  },
  FIST: {
    gesture: "FIST",
    primary: { thumb: 0.5, index: 0, middle: 0, ring: 0, pinky: 0 },
    secondary: null,
    action: "Cancel grab / close panels",
  },
  "TWO HANDS": {
    gesture: "TWO HANDS",
    primary: { thumb: 0.7, index: 1, middle: 1, ring: 1, pinky: 1 },
    secondary: { thumb: 0.4, index: 0.5, middle: 0.5, ring: 0.5, pinky: 0.4 },
    action: "Scale / rotate / pan",
  },
  "AIR DRAW": {
    gesture: "AIR DRAW",
    primary: { thumb: 0.15, index: 1, middle: 0, ring: 0, pinky: 0 },
    secondary: null,
    action: "Draw shapes in the air",
    drawShape: true,
  },
};

const CARD_ORDER = ["POINT", "PINCH", "PEACE", "OPEN PALM", "FIST", "TWO HANDS", "AIR DRAW"];

// Public API required by spec §6: returns 21 {x,y} points for a named pose's
// gesture keyframe.
export function poseToLandmarks(poseName) {
  const pose = POSES[poseName] || POSES.POINT;
  const pts = buildPose(pose.primary);
  // PINCH: bring thumb tip (4) and index tip (8) together.
  if (pose.pinchOverride) {
    const mx = (pts[4].x + pts[8].x) / 2;
    const my = (pts[4].y + pts[8].y) / 2;
    pts[4] = { x: mx - 0.015, y: my };
    pts[8] = { x: mx + 0.015, y: my };
    pts[3] = { x: mx - 0.03, y: my + 0.02 };
    pts[7] = { x: mx + 0.03, y: my + 0.02 };
  }
  return pts;
}

function lerpPose(a, b, t) {
  return a.map((p, i) => ({ x: lerp(p.x, b[i].x, t), y: lerp(p.y, b[i].y, t) }));
}

export class GestureGuide {
  /**
   * @param {HTMLElement} root  #gestureGuide modal element
   * @param {{toast?:(s:string)=>void}} hooks
   */
  constructor(root, hooks = {}) {
    this.root = root;
    this.hooks = hooks;
    this.open = false;
    this._raf = 0;
    this._cards = [];
    this._live = { gesture: "NONE", confidence: 0, mode: "SELECT", twoHandActive: false };
    this._buildCards();
    this._bindClose();
  }

  _buildCards() {
    const grid = this.root.querySelector("#guideGrid");
    if (!grid) return;
    grid.innerHTML = "";
    for (const name of CARD_ORDER) {
      const pose = POSES[name];
      const card = document.createElement("div");
      card.className = "guide-card";
      card.innerHTML = `
        <canvas class="guide-canvas" width="96" height="96"></canvas>
        <div class="guide-name">${name}</div>
        <div class="guide-action">${pose.action}</div>
        <div class="confbar"><i></i></div>
      `;
      const canvas = card.querySelector("canvas");
      const ctx = canvas.getContext("2d");
      const neutral = buildPose(RELAXED);
      const target = poseToLandmarks(name);
      const targetSecondary = pose.secondary ? buildPose(pose.secondary) : null;
      const neutralSecondary = pose.secondary ? buildPose(RELAXED) : null;
      this._cards.push({
        name,
        pose,
        canvas,
        ctx,
        neutral,
        target,
        neutralSecondary,
        targetSecondary,
        bar: card.querySelector(".confbar i"),
      });
      grid.appendChild(card);
    }
  }

  _bindClose() {
    const close = this.root.querySelector("[data-guide-close]");
    if (close) close.addEventListener("click", () => this.hide());
  }

  show() {
    if (this.open) return;
    this.open = true;
    this.root.hidden = false;
    this._tick(performance.now());
  }

  hide() {
    if (!this.open) return;
    this.open = false;
    this.root.hidden = true;
    cancelAnimationFrame(this._raf);
    this._raf = 0;
  }

  toggle() {
    this.open ? this.hide() : this.show();
  }

  setLive({ gesture = "NONE", confidence = 0, mode = "SELECT", twoHandActive = false } = {}) {
    this._live = { gesture, confidence, mode, twoHandActive };
  }

  _isLive(card) {
    const l = this._live;
    if (card.name === "TWO HANDS") return l.twoHandActive;
    if (card.name === "AIR DRAW") return l.mode === "DRAW" && (l.gesture === "POINT" || l.gesture === "PINCH");
    return l.gesture === card.pose.gesture;
  }

  _tick(now) {
    if (!this.open) return;
    // Ping-pong 0→1→0 over ~1.8 s with a soft ease.
    const phase = (now / 1800) % 2;
    const t = phase < 1 ? phase : 2 - phase;
    const e = t * t * (3 - 2 * t); // smoothstep

    for (const card of this._cards) {
      const ctx = card.ctx;
      ctx.clearRect(0, 0, 96, 96);
      const pts = lerpPose(card.neutral, card.target, e);

      if (card.pose.drawShape) {
        // AIR DRAW: point pose + a circle being drawn.
        drawSkeleton(ctx, pts, { width: 96, height: 96, pad: 14, color: "rgba(105,216,255,.9)", lineWidth: 1.6 });
        ctx.strokeStyle = "rgba(255,255,255,.8)";
        ctx.lineWidth = 1.6;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        const cx = 62, cy = 62, r = 16;
        const sweep = e * Math.PI * 2;
        ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + sweep);
        ctx.stroke();
        ctx.setLineDash([]);
      } else if (card.targetSecondary) {
        // TWO HANDS: primary on the left, secondary mirrored on the right.
        const left = pts.map((p) => ({ x: p.x * 0.46, y: p.y }));
        const rightNeutral = lerpPose(card.neutralSecondary, card.targetSecondary, e);
        const right = rightNeutral.map((p) => ({ x: 0.52 + p.x * 0.44, y: p.y }));
        drawSkeleton(ctx, left, { width: 96, height: 96, color: "rgba(105,216,255,.85)", lineWidth: 1.5 });
        drawSkeleton(ctx, right, { width: 96, height: 96, color: "rgba(142,140,255,.85)", lineWidth: 1.5 });
      } else {
        drawSkeleton(ctx, pts, { width: 96, height: 96, pad: 12, color: "rgba(105,216,255,.9)", lineWidth: 1.8 });
      }

      // Confidence bar mirrors the live gesture when it matches this card.
      const live = this._isLive(card) ? clamp(this._live.confidence, 0, 1) : 0;
      card.bar.style.width = `${Math.round(live * 100)}%`;
      card.bar.parentElement.classList.toggle("live", live > 0);
    }

    this._raf = requestAnimationFrame((t) => this._tick(t));
  }
}
