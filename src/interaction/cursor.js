// cursor.js — fingertip cursor state and hover/select target picking.
// Uses a THREE.Raycaster through the pointer's NDC position against the
// pickable object meshes owned by ObjectManager.

import * as THREE from "three";

const _ndc = new THREE.Vector2();
const _ray = new THREE.Raycaster();
const _hit = [];

export class CursorEngine {
  constructor({ camera, getPickables }) {
    this.camera = camera; // THREE.PerspectiveCamera
    this.getPickables = getPickables; // () => Mesh[]
    this.hover = null; // currently hovered object
    this.screen = { x: 0.5, y: 0.5 }; // normalized 0..1
    this.world = new THREE.Vector3(); // point on the z=-2 drag plane
    this.dragPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 2); // z = -2
    this._planeHit = new THREE.Vector3();
  }

  // point: {x,y} normalized screen coords (already mirrored by vision).
  update(point) {
    if (!point) {
      this.screen = { x: 0.5, y: 0.5 };
      return null;
    }
    this.screen.x = point.x;
    this.screen.y = point.y;

    _ndc.set(point.x * 2 - 1, -(point.y * 2 - 1));
    _ray.setFromCamera(_ndc, this.camera);

    const pickables = this.getPickables();
    if (pickables.length) {
      _ray.intersectObjects(pickables, false, _hit);
      this.hover = _hit.length ? _hit[0].object : null;
    } else {
      _hit.length = 0;
      this.hover = null;
    }

    // World position on the interaction plane (z = -2) for drag targets.
    if (_ray.ray.intersectPlane(this.dragPlane, this._planeHit)) {
      this.world.copy(this._planeHit);
    }
    return this.hover;
  }

  // World-space position for spawning an object at a screen point.
  worldAtScreen(point, distance = 9) {
    _ndc.set(point.x * 2 - 1, -(point.y * 2 - 1));
    _ray.setFromCamera(_ndc, this.camera);
    return _ray.ray.at(distance, new THREE.Vector3());
  }
}
