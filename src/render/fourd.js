// fourd.js — FourDEngine: 16-vertex tesseract (4D hypercube) projected into
// 3D and rendered as ONE THREE.LineSegments with a single BufferGeometry.
// V3 created 32 separate Line objects and leaked GC every frame — fixed here.
//
// update() performs zero allocations: scratch arrays are preallocated once.

import * as THREE from "three";

const DIM = 4;
const VERT_COUNT = 16;
const EDGE_COUNT = 32;

export class FourDEngine {
  constructor() {
    this.group = new THREE.Group();
    this.enabled = true;
    this.speed = 0.65;
    this.grabbed = false;      // pinch-grabbed (position follow)
    this.twoHandBound = false; // two-hand transforms routed here (D14)

    // Rotation angles for the six planes: XY, XZ, YZ, XW, YW, ZW.
    this.rot = { xy: 0, xz: 0.4, yz: 0, xw: 0.9, yw: 0, zw: 0 };

    this._buildGeometry();
    this.group.position.set(0, 0, -2.5);
    this.group.scale.setScalar(0.95);
  }

  _buildGeometry() {
    // 16 vertices of the tesseract: all (±1,±1,±1,±1).
    this.verts = new Float32Array(VERT_COUNT * DIM);
    for (let i = 0; i < VERT_COUNT; i++) {
      for (let k = 0; k < DIM; k++) {
        this.verts[i * DIM + k] = (i & (1 << k)) ? 1 : -1;
      }
    }

    // 32 edges: vertex pairs differing in exactly one coordinate.
    this.edges = [];
    for (let i = 0; i < VERT_COUNT; i++) {
      for (let j = i + 1; j < VERT_COUNT; j++) {
        let diff = 0;
        for (let k = 0; k < DIM; k++) {
          if (this.verts[i * DIM + k] !== this.verts[j * DIM + k]) diff++;
        }
        if (diff === 1) this.edges.push(i, j);
      }
    }
    // edges stored flat: [a0,b0,a1,b1,...]

    const pos = new Float32Array(EDGE_COUNT * 2 * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setDrawRange(0, EDGE_COUNT * 2);

    const mat = new THREE.LineBasicMaterial({
      color: 0x69d8ff,
      transparent: true,
      opacity: 0.85,
    });
    this.lines = new THREE.LineSegments(geo, mat);
    this.group.add(this.lines);

    // Scratch buffers — allocated once, reused every frame.
    this._q = new Float32Array(DIM);
    this._posAttr = geo.attributes.position;
  }

  _rotate(v, a, b, t) {
    const x = v[a], y = v[b];
    const c = Math.cos(t), s = Math.sin(t);
    v[a] = x * c - y * s;
    v[b] = x * s + y * c;
  }

  // Project one vertex: rotate in 6 planes, then perspective-divide by w.
  // Writes {x,y,z} into out. No allocation.
  _project(vi, out) {
    const q = this._q;
    const base = vi * DIM;
    q[0] = this.verts[base];
    q[1] = this.verts[base + 1];
    q[2] = this.verts[base + 2];
    q[3] = this.verts[base + 3];

    this._rotate(q, 0, 1, this.rot.xy);
    this._rotate(q, 0, 2, this.rot.xz);
    this._rotate(q, 1, 2, this.rot.yz);
    this._rotate(q, 0, 3, this.rot.xw);
    this._rotate(q, 1, 3, this.rot.yw);
    this._rotate(q, 2, 3, this.rot.zw);

    const w = 3.2 - q[3];
    const p = 1.7 / Math.max(0.45, w);
    out.x = q[0] * p;
    out.y = q[1] * p;
    out.z = q[2] * p;
  }

  update(dt, gesture = null, reducedMotion = false) {
    if (!this.enabled) return;
    dt = Math.min(dt, 0.05);

    if (!this.grabbed && !reducedMotion) {
      this.rot.xy += dt * this.speed * 0.22;
      this.rot.yz += dt * this.speed * 0.14;
      this.rot.xw += dt * this.speed * 0.1;
    }

    // Two-hand XW/YW rotation + uniform scale, only when the app routed
    // two-hand transforms to the cube (D14 — never both cube and object).
    if (this.twoHandBound && gesture?.twoHand?.active) {
      this.rot.xw += (gesture.twoHand.rotation || 0) * dt * 0.7;
      this.rot.yw += (gesture.twoHand.rotation || 0) * dt * 0.35;
      const target = Math.min(1.8, Math.max(0.65, (gesture.twoHand.scale || 1) * 1.4));
      const s = this.group.scale.x + (target - this.group.scale.x) * 0.12;
      this.group.scale.setScalar(s);
      // Pan: both wrists translate → move the cube.
      const pan = gesture.twoHand.pan;
      if (pan) {
        this.group.position.x += pan.x * dt * 8;
        this.group.position.y -= pan.y * dt * 8;
      }
    }

    // Write all 32 edges into the single position buffer.
    const arr = this._posAttr.array;
    const A = this._scratchA || (this._scratchA = { x: 0, y: 0, z: 0 });
    const B = this._scratchB || (this._scratchB = { x: 0, y: 0, z: 0 });
    let o = 0;
    for (let e = 0; e < EDGE_COUNT; e++) {
      this._project(this.edges[e * 2], A);
      this._project(this.edges[e * 2 + 1], B);
      arr[o++] = A.x; arr[o++] = A.y; arr[o++] = A.z;
      arr[o++] = B.x; arr[o++] = B.y; arr[o++] = B.z;
    }
    this._posAttr.needsUpdate = true;

    if (!reducedMotion) this.group.rotation.y += dt * 0.08;
  }

  get edgeCount() {
    return EDGE_COUNT;
  }

  get position() {
    return this.group.position;
  }

  reset() {
    this.rot = { xy: 0, xz: 0.4, yz: 0, xw: 0.9, yw: 0, zw: 0 };
    this.group.rotation.set(0, 0, 0);
    this.group.position.set(0, 0, -2.5);
    this.group.scale.setScalar(0.95);
    this.grabbed = false;
    this.twoHandBound = false;
  }

  setSpeed(v) {
    this.speed = Math.min(1.5, Math.max(0, v));
  }

  dispose() {
    this.lines.geometry.dispose();
    this.lines.material.dispose();
    this.group.remove(this.lines);
  }
}
