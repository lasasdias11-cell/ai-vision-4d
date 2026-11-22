// particles.js — ParticleEngine: ambient THREE.Points field that reacts to
// hand state (pinch gathers, open palm expands). Rebuild-safe: old
// BufferGeometry and PointsMaterial are disposed before rebuilding (D10).

import * as THREE from "three";

const DEFAULT_COUNT = 1000;

export class ParticleEngine {
  constructor(parentGroup) {
    this.group = parentGroup;
    this.points = null;
    this.count = DEFAULT_COUNT;
    this._basePositions = null;
    this._rebuildTimer = 0;
    this.rotationEnabled = true;
  }

  // Debounced rebuild entry point — UI sliders call this on every input;
  // the actual rebuild waits `ms` of quiet (D10).
  setCount(count, { debounceMs = 150 } = {}) {
    const n = Math.max(100, Math.min(4000, Math.round(count)));
    this.count = n;
    clearTimeout(this._rebuildTimer);
    this._rebuildTimer = setTimeout(() => this.rebuild(n), debounceMs);
  }

  rebuild(n = this.count) {
    // Dispose previous GPU resources BEFORE allocating new ones (D10).
    if (this.points) {
      this.group.remove(this.points);
      this.points.geometry.dispose();
      this.points.material.dispose();
      this.points = null;
    }

    const positions = new Float32Array(n * 3);
    this._basePositions = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const r = 5 * Math.pow(Math.random(), 0.5);
      const a = Math.random() * Math.PI * 2;
      const y = (Math.random() - 0.5) * 5;
      const z = (Math.random() - 0.5) * 6;
      const x = Math.cos(a) * r;
      positions[i * 3] = x;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = z;
      this._basePositions[i * 3] = x;
      this._basePositions[i * 3 + 1] = y;
      this._basePositions[i * 3 + 2] = z;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({
      color: 0x69d8ff,
      size: 0.022,
      transparent: true,
      opacity: 0.48,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.points = new THREE.Points(geo, mat);
    this.group.add(this.points);
    this._energy = 0;
  }

  // gesture: {pinch, name, twoHand} — pinch pulls particles inward,
  // open palm pushes them outward.
  update(dt, gesture = null, reducedMotion = false) {
    if (!this.points || !this._basePositions) return;

    if (this.rotationEnabled && !reducedMotion) {
      this.points.rotation.y += dt * 0.018;
    }

    // _energy lerps toward a target: pinch gathers (negative = contract
    // toward center), open palm expands (positive = push outward).
    const target = gesture?.pinch ? -0.38 : gesture?.name === "OPEN PALM" ? 0.3 : 0;
    this._energy = (this._energy ?? 0) + (target - (this._energy ?? 0)) * Math.min(1, dt * 5);
    if (Math.abs(this._energy) < 0.001 && target === 0) return;

    const pos = this.points.geometry.attributes.position;
    const base = this._basePositions;
    const arr = pos.array;
    const s = 1 + this._energy;
    for (let i = 0; i < this.count; i++) {
      arr[i * 3] = base[i * 3] * s;
      arr[i * 3 + 1] = base[i * 3 + 1] * s;
      arr[i * 3 + 2] = base[i * 3 + 2] * s;
    }
    pos.needsUpdate = true;
  }

  dispose() {
    clearTimeout(this._rebuildTimer);
    if (this.points) {
      this.group.remove(this.points);
      this.points.geometry.dispose();
      this.points.material.dispose();
      this.points = null;
    }
    this._basePositions = null;
  }
}
