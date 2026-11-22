// tracking.js — landmark smoothing, velocity estimation, and trail helpers.
// Pure functions; the GestureEngine owns the per-hand state that uses them.

import { clamp } from "../utils/math.js";

// Exponential smoothing of one landmark. alpha is the *new-data* weight:
// higher alpha = snappier, lower = smoother. Config default 0.78 is fairly
// responsive while still filtering single-frame jitter.
export function smoothPoint(prev, next, alpha) {
  const a = clamp(alpha, 0.05, 1);
  if (!prev) {
    return {
      x: next.x, y: next.y, z: next.z || 0,
      visibility: next.visibility ?? 1,
    };
  }
  return {
    x: prev.x + (next.x - prev.x) * a,
    y: prev.y + (next.y - prev.y) * a,
    z: (prev.z || 0) + ((next.z || 0) - (prev.z || 0)) * a,
    visibility: next.visibility ?? prev.visibility ?? 1,
  };
}

export function smoothHand(prevHand, nextHand, alpha) {
  const out = new Array(nextHand.length);
  for (let i = 0; i < nextHand.length; i++) {
    out[i] = smoothPoint(prevHand?.[i], nextHand[i], alpha);
  }
  return out;
}

// Velocity (normalized units / second) of a point over a small history ring.
export function pointVelocity(history, nowMs) {
  if (history.length < 2) return { x: 0, y: 0 };
  const newest = history[history.length - 1];
  // Walk back ~90 ms to get a stable derivative.
  let oldest = history[0];
  for (let i = history.length - 1; i >= 0; i--) {
    if (nowMs - history[i].t <= 90) { oldest = history[i]; break; }
    oldest = history[i];
  }
  const dt = Math.max(0.016, (newest.t - oldest.t) / 1000);
  return {
    x: (newest.x - oldest.x) / dt,
    y: (newest.y - oldest.y) / dt,
  };
}

export function pushRing(arr, item, cap) {
  arr.push(item);
  if (arr.length > cap) arr.splice(0, arr.length - cap);
}

// Two-signal finger extension test (defect D2 fix):
//   extended = dist(tip, wrist) > dist(pip, wrist) * 1.12
//              AND angle3(mcp, pip, tip) > 2.6
// A bent finger fails BOTH signals; a straight finger passes both.
// `p` is the 21-landmark hand array; indices follow MediaPipe convention.
export function fingerExtended(p, tip, pip, mcp, wrist = 0) {
  const tipWrist = Math.hypot(p[tip].x - p[wrist].x, p[tip].y - p[wrist].y);
  const pipWrist = Math.hypot(p[pip].x - p[wrist].x, p[pip].y - p[wrist].y);
  if (!(tipWrist > pipWrist * 1.12)) return false;
  return angleBetween(p[mcp], p[pip], p[tip]) > 2.6;
}

function angleBetween(a, b, c) {
  const abx = a.x - b.x, aby = a.y - b.y, abz = (a.z || 0) - (b.z || 0);
  const bcx = c.x - b.x, bcy = c.y - b.y, bcz = (c.z || 0) - (b.z || 0);
  const dot = abx * bcx + aby * bcy + abz * bcz;
  const den = Math.hypot(abx, aby, abz) * Math.hypot(bcx, bcy, bcz);
  return den > 1e-9 ? Math.acos(clamp(dot / den, -1, 1)) : Math.PI;
}

// Thumb extension: thumb tip (4) farther from wrist than thumb IP joint's
// pip-equivalent (3), with a straight MCP->IP->TIP angle.
export function thumbExtended(p, wrist = 0) {
  const tipWrist = Math.hypot(p[4].x - p[wrist].x, p[4].y - p[wrist].y);
  const ipWrist = Math.hypot(p[3].x - p[wrist].x, p[3].y - p[wrist].y);
  if (!(tipWrist > ipWrist * 1.05)) return false;
  return angleBetween(p[2], p[3], p[4]) > 2.4;
}

// Mean visibility across the 21 landmarks — used to gate low-quality frames.
export function handQuality(p) {
  let sum = 0, n = 0;
  for (const pt of p) {
    if (pt.visibility == null) continue;
    sum += pt.visibility;
    n++;
  }
  return n ? sum / n : 1;
}
