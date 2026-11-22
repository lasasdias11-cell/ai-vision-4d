// objects.js — ObjectManager: spawn-by-shape, selection, duplicate, delete,
// recolor, and scene-level wireframe (D11: new objects inherit the flag).

import * as THREE from "three";

export const SHAPES = Object.freeze([
  "cube", "sphere", "triangle", "pyramid", "cone", "cylinder",
  "torus", "icosahedron", "wireframe-cube", "particle-sphere", "crystal",
]);

const SPHERE_POINT_COUNT = 320;

function makeGeometry(shape) {
  switch (shape) {
    case "sphere": return new THREE.SphereGeometry(0.55, 24, 16);
    case "triangle": return new THREE.CylinderGeometry(0.6, 0.6, 0.12, 3);
    case "pyramid": return new THREE.ConeGeometry(0.6, 1.1, 4);
    case "cone": return new THREE.ConeGeometry(0.55, 1.0, 24);
    case "cylinder": return new THREE.CylinderGeometry(0.45, 0.45, 1.1, 24);
    case "torus": return new THREE.TorusGeometry(0.55, 0.15, 12, 36);
    case "icosahedron": return new THREE.IcosahedronGeometry(0.65, 1);
    case "wireframe-cube": return new THREE.BoxGeometry(1, 1, 1);
    case "crystal": return new THREE.OctahedronGeometry(0.7, 0);
    case "cube":
    default: return new THREE.BoxGeometry(1, 1, 1);
  }
}

function makeMaterial(shape, color, wireframe) {
  if (shape === "wireframe-cube") {
    return new THREE.MeshBasicMaterial({
      color, wireframe: true, transparent: true, opacity: 0.9,
    });
  }
  return new THREE.MeshStandardMaterial({
    color,
    metalness: 0.45,
    roughness: 0.3,
    wireframe: !!wireframe,
    emissive: 0x07101c,
    emissiveIntensity: 0.7,
  });
}

function makeParticleSphereMaterial(color) {
  return new THREE.PointsMaterial({
    color, size: 0.035, transparent: true, opacity: 0.9,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
}

function particleSphereGeometry() {
  // Fibonacci-sphere point distribution — even coverage, cheap to build.
  const pos = new Float32Array(SPHERE_POINT_COUNT * 3);
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < SPHERE_POINT_COUNT; i++) {
    const y = 1 - (i / (SPHERE_POINT_COUNT - 1)) * 2;
    const rad = Math.sqrt(1 - y * y);
    const th = golden * i;
    pos[i * 3] = Math.cos(th) * rad * 0.6;
    pos[i * 3 + 1] = y * 0.6;
    pos[i * 3 + 2] = Math.sin(th) * rad * 0.6;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  return g;
}

const _color = new THREE.Color();

export class ObjectManager {
  constructor(parentGroup) {
    this.group = parentGroup; // THREE.Group added to the scene
    this.objects = [];
    this.selected = null;
    this.wireframe = false; // scene-level flag read by spawn() (D11)
    this._pickables = [];
  }

  get pickables() {
    return this._pickables;
  }

  _rebuildPickables() {
    this._pickables.length = 0;
    for (const obj of this.objects) {
      obj.traverse((c) => {
        if (c.isMesh || c.isPoints) this._pickables.push(c);
      });
    }
  }

  spawn(shape = "cube", position = null) {
    const safe = SHAPES.includes(shape) ? shape : "cube";
    const color = _color.setHSL(Math.random(), 0.7, 0.6).getHex();

    const obj = new THREE.Group();
    let radius = 0.6;

    if (safe === "particle-sphere") {
      const pts = new THREE.Points(particleSphereGeometry(), makeParticleSphereMaterial(color));
      pts.userData.pickRoot = obj;
      obj.add(pts);
      obj.userData.materials = [pts.material];
      radius = 0.62;
    } else {
      const geo = makeGeometry(safe);
      const mat = makeMaterial(safe, color, this.wireframe);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.userData.pickRoot = obj;
      obj.add(mesh);
      obj.userData.materials = [mat];
      obj.userData.geometry = geo;
      radius = geo.boundingSphere?.radius ?? 0.6;
      if (!geo.boundingSphere) geo.computeBoundingSphere();
      radius = geo.boundingSphere?.radius ?? 0.6;
    }

    if (position) obj.position.copy(position);
    else obj.position.set(0, 0, -2.5);

    obj.userData = {
      ...obj.userData,
      kind: safe,
      shape: safe,
      color,
      velocity: new THREE.Vector3(),
      angularVelocity: new THREE.Vector3(
        (Math.random() - 0.5) * 0.6,
        (Math.random() - 0.5) * 0.6,
        (Math.random() - 0.5) * 0.6,
      ),
      throwVel: new THREE.Vector3(),
      radius,
      grabbed: false,
      spawnScale: 0,
    };

    this.group.add(obj);
    this.objects.push(obj);
    this._rebuildPickables();
    this.select(obj);
    return obj;
  }

  select(obj) {
    if (this.selected === obj) return;
    if (this.selected) this._setHighlight(this.selected, false);
    this.selected = obj;
    if (obj) this._setHighlight(obj, true);
  }

  _setHighlight(obj, on) {
    for (const m of obj.userData.materials || []) {
      if (m.emissiveIntensity != null) {
        m.emissiveIntensity = on ? 1.8 : 0.7;
      } else if (m.color) {
        // Points/wireframe materials: store base color once, tint on select.
        if (on && m.userData.baseColor == null) m.userData.baseColor = m.color.getHex();
        if (m.userData.baseColor != null) {
          m.color.setHex(on ? 0xbfe9ff : m.userData.baseColor);
        }
      }
    }
  }

  duplicate(obj) {
    if (!obj) return null;
    const clone = obj.clone(true);
    clone.position.add(new THREE.Vector3(
      (Math.random() - 0.5) * 0.6,
      0.4,
      (Math.random() - 0.5) * 0.6,
    ));
    clone.userData.velocity = new THREE.Vector3();
    clone.userData.angularVelocity = new THREE.Vector3(
      (Math.random() - 0.5) * 0.6,
      (Math.random() - 0.5) * 0.6,
      (Math.random() - 0.5) * 0.6,
    );
    clone.userData.grabbed = false;
    clone.userData.spawnScale = 0;
    // clone() shares geometry/material — give the clone its own material so
    // selection highlighting doesn't bleed across objects.
    clone.traverse((c) => {
      if (c.isMesh) {
        c.material = c.material.clone();
        if (c.userData.pickRoot) c.userData.pickRoot = clone;
      }
      if (c.isPoints) {
        c.material = c.material.clone();
        if (c.userData.pickRoot) c.userData.pickRoot = clone;
      }
    });
    clone.userData.materials = [];
    clone.traverse((c) => {
      if ((c.isMesh || c.isPoints) && c.material) clone.userData.materials.push(c.material);
    });
    this.group.add(clone);
    this.objects.push(clone);
    this._rebuildPickables();
    this.select(clone);
    return clone;
  }

  recolor(obj, hue = Math.random()) {
    if (!obj) return;
    const color = _color.setHSL(((hue % 1) + 1) % 1, 0.7, 0.6).getHex();
    obj.userData.color = color;
    for (const m of obj.userData.materials || []) {
      if (m.color) {
        if (m.userData.baseColor != null) m.userData.baseColor = color;
        else m.color.setHex(color);
        if (this.selected === obj) m.color.setHex(0xbfe9ff);
      }
    }
  }

  remove(obj) {
    if (!obj) return;
    const i = this.objects.indexOf(obj);
    if (i >= 0) this.objects.splice(i, 1);
    if (this.selected === obj) this.select(null);
    obj.traverse((c) => {
      if (c.isMesh || c.isPoints) {
        c.geometry?.dispose();
        const mats = Array.isArray(c.material) ? c.material : [c.material];
        mats.forEach((m) => m?.dispose());
      }
    });
    this.group.remove(obj);
    this._rebuildPickables();
  }

  clear() {
    for (const obj of [...this.objects]) this.remove(obj);
    this.objects.length = 0;
    this.selected = null;
    this._pickables.length = 0;
  }

  // Apply scene-level wireframe to existing objects and remember it for
  // future spawn() calls (D11).
  setWireframe(on) {
    this.wireframe = !!on;
    for (const obj of this.objects) {
      for (const m of obj.userData.materials || []) {
        if ("wireframe" in m) m.wireframe = this.wireframe && obj.userData.shape !== "wireframe-cube";
      }
    }
  }

  // Spawn animation scale-in (reduced-motion aware via opts.spawnScale).
  update(dt, reducedMotion = false) {
    for (const obj of this.objects) {
      const ud = obj.userData;
      if (ud.spawnScale < 1) {
        ud.spawnScale = Math.min(1, ud.spawnScale + dt * (reducedMotion ? 8 : 3.2));
        const e = 1 - Math.pow(1 - ud.spawnScale, 3); // ease-out cubic
        obj.scale.setScalar(0.01 + e * 0.99);
      }
    }
  }
}
