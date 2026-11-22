// math.js — small pure helpers shared by every module.

export const TAU = Math.PI * 2;

export function clamp(v, a = 0, b = 1) {
  const n = Number(v);
  if (!Number.isFinite(n)) return a;
  return n < a ? a : n > b ? b : n;
}

export function lerp(a, b, t) {
  return a + (b - a) * clamp(t, 0, 1);
}

// Frame-rate independent exponential damping factor.
export function damp(rate, dt) {
  return 1 - Math.exp(-rate * Math.max(dt, 0));
}

export function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, (a.z || 0) - (b.z || 0));
}

export function dist2(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

// Angle at vertex b formed by points a-b-c, in radians [0, PI].
export function angle3(a, b, c) {
  const abx = a.x - b.x, aby = a.y - b.y, abz = (a.z || 0) - (b.z || 0);
  const bcx = c.x - b.x, bcy = c.y - b.y, bcz = (c.z || 0) - (b.z || 0);
  const dot = abx * bcx + aby * bcy + abz * bcz;
  const den = Math.hypot(abx, aby, abz) * Math.hypot(bcx, bcy, bcz);
  return den > 1e-9 ? Math.acos(clamp(dot / den, -1, 1)) : Math.PI;
}

export function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function safeFixed(v, digits = 2, fallback = 0) {
  return safeNum(v, fallback).toFixed(digits);
}

export function hsl(h, s, l, a = 1) {
  return `hsla(${((h % 360) + 360) % 360},${clamp(s, 0, 100)}%,${clamp(l, 0, 100)}%,${clamp(a, 0, 1)})`;
}

export function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Shoelace area of a 2D point list {x,y} in normalized coords.
export function polygonArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}
