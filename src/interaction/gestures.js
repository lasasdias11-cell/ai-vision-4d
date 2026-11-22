// gestures.js — GestureEngine: classification with confidence, hysteresis,
// and per-gesture cooldowns. Also derives pinch-hold/drag/release, two-hand
// scale/rotate/pan, and swipe detection.
//
// Defect fixes embodied here:
//  D2 — two-signal finger extension (see core/tracking.js fingerExtended)
//  D5 — gestureThreshold gates BOTH raw classification confidence AND the
//       hysteresis commit, so the slider is no longer decorative.

import { clamp, dist } from "../utils/math.js";
import {
  smoothHand,
  pointVelocity,
  pushRing,
  fingerExtended,
  thumbExtended,
  handQuality,
} from "../core/tracking.js";

// MediaPipe hand landmark indices.
const WRIST = 0;
const THUMB_TIP = 4;
const INDEX_MCP = 5, INDEX_PIP = 6, INDEX_TIP = 8;
const MIDDLE_MCP = 9, MIDDLE_PIP = 10, MIDDLE_TIP = 12;
const RING_MCP = 13, RING_PIP = 14, RING_TIP = 16;
const PINKY_MCP = 17, PINKY_PIP = 18, PINKY_TIP = 20;

const BASE_CONFIDENCE = {
  PINCH: 0.96,
  POINT: 0.94,
  PEACE: 0.92,
  "OPEN PALM": 0.96,
  FIST: 0.9,
  "THUMBS UP": 0.88,
  "SWIPE LEFT": 0.9,
  "SWIPE RIGHT": 0.9,
  "SWIPE UP": 0.9,
  "SWIPE DOWN": 0.9,
  HAND: 0.5,
};

const COOLDOWN_MS = {
  "OPEN PALM": 350,
  FIST: 350,
  PEACE: 450,
  "THUMBS UP": 450,
  "SWIPE LEFT": 600,
  "SWIPE RIGHT": 600,
  "SWIPE UP": 600,
  "SWIPE DOWN": 600,
};

const PINCH_RATIO = 0.4;
const PINCH_HOLD_MS = 120;
const SWIPE_WINDOW_MS = 400;
const SWIPE_MIN_DIST = 0.18; // fraction of frame
const SWIPE_AXIS_RATIO = 1.5;

export class GestureEngine {
  constructor(cfg = {}) {
    this.smoothing = cfg.smoothing ?? 0.78;
    this.threshold = cfg.gestureThreshold ?? 0.55;
    this.grabEnabled = cfg.grabEnabled ?? true;
    this.twoHandEnabled = cfg.twoHandEnabled ?? true;
    this.minStableFrames = cfg.minStableFrames ?? 2;
    this.cooldownMs = cfg.gestureCooldownMs ?? 300;

    this.smoothedHands = [];
    this.trails = [[], [], [], [], []]; // per fingertip trail rings
    this.tipHistory = []; // {x,y,t} of primary index/pinch point
    this.palmHistory = []; // {x,y,t} of palm center for swipes

    this.state = this._emptyState();
    this._prevState = this._emptyState();

    // hysteresis
    this._candidate = { name: "NONE", frames: 0, conf: 0 };
    this._lastFired = {}; // name -> timestamp
    this._lastName = "NONE";
    this._lastNameAt = 0;

    // pinch timing
    this._pinchStart = 0;
    this._wasPinch = false;

    // two-hand baseline (captured when a second hand appears)
    this._twoHandBase = null;
  }

  _emptyState() {
    return {
      name: "NONE",
      confidence: 0,
      stable: false,
      hand: null,
      hand2: null,
      point: null, // {x,y} screen-space, pinch midpoint when pinching
      pinch: false,
      pinchHeld: false,
      pinchJustStarted: false,
      pinchJustReleased: false,
      pinchStart: 0,
      velocity: { x: 0, y: 0 }, // normalized units / second
      fingersExtended: 0,
      ext: { thumb: false, index: false, middle: false, ring: false, pinky: false },
      quality: 0,
      scale: 1,
      rotation: 0,
      twoHand: { active: false, scale: 1, rotation: 0, pan: { x: 0, y: 0 } },
    };
  }

  // ---- classification -------------------------------------------------

  // Returns {name, confidence, pinch, ext, fingersExtended, pinchRatio}.
  // D5: raw confidence is gated by this.threshold — below it the result is
  // downgraded to "HAND" so hysteresis never commits a weak reading.
  classify(p) {
    const ext = {
      index: fingerExtended(p, INDEX_TIP, INDEX_PIP, INDEX_MCP, WRIST),
      middle: fingerExtended(p, MIDDLE_TIP, MIDDLE_PIP, MIDDLE_MCP, WRIST),
      ring: fingerExtended(p, RING_TIP, RING_PIP, RING_MCP, WRIST),
      pinky: fingerExtended(p, PINKY_TIP, PINKY_PIP, PINKY_MCP, WRIST),
      thumb: thumbExtended(p, WRIST),
    };
    const fingers = [ext.index, ext.middle, ext.ring, ext.pinky];
    const count = fingers.filter(Boolean).length;

    const palmSpan = Math.max(dist(p[WRIST], p[MIDDLE_MCP]), 1e-4);
    const pinchDist = dist(p[THUMB_TIP], p[INDEX_TIP]);
    const pinchRatio = pinchDist / palmSpan;
    const pinch = pinchRatio < PINCH_RATIO;
    const pinchConf = clamp(1 - pinchRatio / PINCH_RATIO, 0, 1);

    let name = "HAND";
    let confidence = 0.5;

    if (pinch && pinchConf >= this.threshold) {
      name = "PINCH";
      confidence = BASE_CONFIDENCE.PINCH * pinchConf;
    } else if (ext.index && !ext.middle && !ext.ring && !ext.pinky) {
      name = "POINT";
      confidence = BASE_CONFIDENCE.POINT;
    } else if (ext.index && ext.middle && !ext.ring && !ext.pinky) {
      name = "PEACE";
      confidence = BASE_CONFIDENCE.PEACE;
    } else if (count === 4) {
      // OPEN PALM: all four fingers extended (thumb state ignored — monocular
      // thumb reads are unreliable; documented in README limits).
      name = "OPEN PALM";
      confidence = BASE_CONFIDENCE["OPEN PALM"];
    } else if (count === 0 && ext.thumb) {
      name = "THUMBS UP";
      confidence = BASE_CONFIDENCE["THUMBS UP"];
    } else if (count === 0) {
      name = "FIST";
      confidence = BASE_CONFIDENCE.FIST;
    }

    // D5: threshold gates the commit path, so scale raw confidence down for
    // borderline poses instead of letting hysteresis promote them.
    if (name !== "HAND" && confidence < this.threshold) {
      name = "HAND";
      confidence = 0.5;
    }

    return { name, confidence, pinch, ext, fingersExtended: count, pinchRatio };
  }

  // ---- per-frame update ------------------------------------------------

  update(hands, nowMs) {
    const prev = this._prevState;
    this._prevState = this.state;

    const sm = hands.slice(0, 2).map((h, i) => smoothHand(this.smoothedHands[i], h, this.smoothing));
    this.smoothedHands = sm;

    if (!sm.length) {
      this.state = this._emptyState();
      this.state.prevName = prev.name;
      this._candidate = { name: "NONE", frames: 0, conf: 0 };
      this._wasPinch = false;
      this._pinchStart = 0;
      this._twoHandBase = null;
      // decay trails when no hand is visible
      for (const t of this.trails) if (t.length) t.splice(0, Math.ceil(t.length / 2));
      return this.state;
    }

    const h = sm[0];
    const raw = this.classify(h);
    const h2 = sm[1] || null;
    const quality = handQuality(h);

    // Primary interaction point: pinch midpoint when pinching, else index tip.
    const indexTip = h[INDEX_TIP];
    const point = raw.pinch
      ? {
          x: (h[THUMB_TIP].x + indexTip.x) / 2,
          y: (h[THUMB_TIP].y + indexTip.y) / 2,
        }
      : { x: indexTip.x, y: indexTip.y };

    pushRing(this.tipHistory, { x: point.x, y: point.y, t: nowMs }, 24);
    const vel = pointVelocity(this.tipHistory, nowMs);

    // Fingertip trails for the overlay (5 tips: thumb, index, middle, ring, pinky).
    const trailTips = [THUMB_TIP, INDEX_TIP, MIDDLE_TIP, RING_TIP, PINKY_TIP];
    for (let i = 0; i < 5; i++) {
      const p = h[trailTips[i]];
      pushRing(this.trails[i], { x: p.x, y: p.y, t: nowMs }, 14);
    }

    // Palm center for swipe detection.
    const palm = {
      x: (h[WRIST].x + h[MIDDLE_MCP].x) / 2,
      y: (h[WRIST].y + h[MIDDLE_MCP].y) / 2,
    };
    pushRing(this.palmHistory, { x: palm.x, y: palm.y, t: nowMs }, 30);

    // ---- pinch lifecycle ------------------------------------------------
    let pinchJustStarted = false;
    let pinchJustReleased = false;
    if (raw.pinch && this.grabEnabled) {
      if (!this._wasPinch) {
        this._pinchStart = nowMs;
        pinchJustStarted = true;
      }
    } else if (this._wasPinch) {
      pinchJustReleased = true;
      this._pinchStart = 0;
    }
    this._wasPinch = raw.pinch && this.grabEnabled;
    const pinchHeld = this._wasPinch && nowMs - this._pinchStart > PINCH_HOLD_MS;

    // ---- swipe detection -------------------------------------------------
    const swipe = this._detectSwipe(nowMs, raw);

    // ---- hysteresis commit ----------------------------------------------
    const name = this._commitName(swipe ? swipe.name : raw.name, swipe ? swipe.confidence : raw.confidence, nowMs);

    // ---- two-hand transform ----------------------------------------------
    const twoHand = this._updateTwoHand(h, h2, raw, nowMs);

    const state = {
      name,
      confidence: swipe ? swipe.confidence : raw.confidence,
      stable: name !== "NONE" && name !== "HAND",
      hand: h,
      hand2: h2,
      point,
      pinch: this._wasPinch,
      pinchHeld,
      pinchJustStarted,
      pinchJustReleased,
      pinchStart: this._pinchStart,
      velocity: vel,
      fingersExtended: raw.fingersExtended,
      ext: raw.ext,
      quality,
      scale: twoHand.active ? twoHand.scale : 1,
      rotation: twoHand.active ? twoHand.rotation : 0,
      twoHand,
      prevName: prev.name,
    };
    this.state = state;
    return state;
  }

  _commitName(rawName, rawConf, nowMs) {
    // Cooldown gates NEW commits only — a held gesture keeps reporting its
    // name until the raw classification changes.
    if (rawName === this._candidate.name) {
      this._candidate.frames++;
      this._candidate.conf = Math.max(this._candidate.conf, rawConf);
    } else {
      this._candidate = { name: rawName, frames: 1, conf: rawConf };
    }

    const c = this._candidate;
    const stable =
      c.frames >= this.minStableFrames &&
      c.conf >= this.threshold &&
      rawName !== "NONE" &&
      rawName !== "HAND";

    if (stable) {
      if (rawName === this._lastName) return rawName; // held
      const cd = COOLDOWN_MS[rawName] ?? this.cooldownMs;
      const cooled = nowMs - (this._lastFired[rawName] || -1e9) >= cd;
      if (cooled) {
        this._lastName = rawName;
        this._lastNameAt = nowMs;
        this._lastFired[rawName] = nowMs;
        return rawName;
      }
    }

    // Not yet committed: hold the previous gesture briefly to prevent flicker,
    // otherwise report the raw fallback (HAND / NONE).
    if (this._lastName !== "NONE" && nowMs - this._lastNameAt < 150) {
      return this._lastName;
    }
    return rawName === "HAND" || rawName === "NONE" ? rawName : "HAND";
  }

  _detectSwipe(nowMs, raw) {
    const hist = this.palmHistory;
    if (hist.length < 3) return null;
    if (raw.fingersExtended < 3) return null; // need extended palm

    const newest = hist[hist.length - 1];
    let oldest = hist[0];
    for (const s of hist) {
      if (nowMs - s.t <= SWIPE_WINDOW_MS) { oldest = s; break; }
    }
    const dt = (newest.t - oldest.t) / 1000;
    if (dt < 0.08) return null;

    const dx = newest.x - oldest.x;
    const dy = newest.y - oldest.y;
    const adx = Math.abs(dx), ady = Math.abs(dy);
    if (adx < SWIPE_MIN_DIST && ady < SWIPE_MIN_DIST) return null;

    let name = null;
    if (adx > ady * SWIPE_AXIS_RATIO && adx >= SWIPE_MIN_DIST) {
      name = dx > 0 ? "SWIPE RIGHT" : "SWIPE LEFT";
    } else if (ady >= adx * SWIPE_AXIS_RATIO && ady >= SWIPE_MIN_DIST) {
      name = dy > 0 ? "SWIPE DOWN" : "SWIPE UP"; // screen y grows downward
    }
    if (!name) return null;
    return { name, confidence: BASE_CONFIDENCE[name] };
  }

  _updateTwoHand(h, h2, raw, nowMs) {
    const out = { active: false, scale: 1, rotation: 0, pan: { x: 0, y: 0 } };
    if (!this.twoHandEnabled || !h2) {
      this._twoHandBase = null;
      return out;
    }

    const wristDist = dist(h[WRIST], h2[WRIST]);
    const angle = (hand) =>
      Math.atan2(hand[MIDDLE_MCP].y - hand[WRIST].y, hand[MIDDLE_MCP].x - hand[WRIST].x);
    const rot = angle(h) - angle(h2);
    const center = { x: (h[WRIST].x + h2[WRIST].x) / 2, y: (h[WRIST].y + h2[WRIST].y) / 2 };

    if (!this._twoHandBase) {
      this._twoHandBase = {
        dist: Math.max(wristDist, 1e-4),
        rot,
        center,
        t: nowMs,
      };
      return { ...out, active: true };
    }

    const b = this._twoHandBase;
    out.active = true;
    out.scale = clamp(wristDist / b.dist, 0.4, 2.5);
    out.rotation = rot - b.rot;
    out.pan = { x: center.x - b.center.x, y: center.y - b.center.y };
    // Slowly re-baseline so gestures don't accumulate drift forever.
    if (nowMs - b.t > 4000) {
      this._twoHandBase = { dist: Math.max(wristDist, 1e-4), rot, center, t: nowMs };
    }
    return out;
  }
}
