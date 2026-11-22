// scene.js — SceneManager: Three.js scene, renderer (with WebGL fallback,
// D3), camera, lights, adaptive pixel ratio, grab/drag routing, two-hand
// transform routing (D14), and per-frame update orchestration.

import * as THREE from "three";
import { ObjectManager } from "./objects.js";
import { PhysicsEngine } from "./physics.js";
import { ParticleEngine } from "./particles.js";
import { FourDEngine } from "./fourd.js";
import { clamp } from "../utils/math.js";

const FOV_BASE = 55;
const FOV_MIN = 35;
const FOV_MAX = 75;
const GRAB_LERP = 0.35;

export class SceneManager {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{onGraphicsError:(err:Error)=>void}} hooks
   */
  constructor(canvas, { onGraphicsError = () => {}, onToast = () => {} } = {}) {
    this.canvas = canvas;
    this.onToast = onToast;
    this.failed = false;
    this.failure = null;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(FOV_BASE, 1, 0.1, 100);
    this.camera.position.set(0, 0, 7);

    // D3: WebGL failure must surface a real error, never a blank screen.
    try {
      this.renderer = new THREE.WebGLRenderer({
        canvas,
        alpha: true,
        antialias: true,
        powerPreference: "high-performance",
      });
    } catch (e) {
      this.failed = true;
      this.failure = e;
      onGraphicsError(e);
      this.renderer = null;
    }

    if (this.renderer) {
      this._pixelRatioCap = Math.min(window.devicePixelRatio || 1, 1.5);
      this.renderer.setPixelRatio(this._pixelRatioCap);
      this.renderer.setSize(
        canvas.clientWidth || window.innerWidth,
        canvas.clientHeight || window.innerHeight,
        false,
      );
      this.renderer.outputColorSpace = THREE.SRGBColorSpace;
      this.renderer.setClearColor(0x000000, 0);
    }

    // Adaptive quality: drop pixel ratio to 1.0 if sustained FPS < 20 for 5 s.
    this._fpsWindow = [];
    this._lowFpsSince = 0;
    this._adaptiveDropped = false;

    this.root = new THREE.Group();
    this.scene.add(this.root);

    const amb = new THREE.AmbientLight(0x9bb8ff, 1.25);
    const p1 = new THREE.PointLight(0x69d8ff, 28, 18);
    const p2 = new THREE.PointLight(0x8e8cff, 22, 14);
    p1.position.set(3, 3, 4);
    p2.position.set(-4, -2, 2);
    this.scene.add(amb, p1, p2);

    this.objects = new ObjectManager(this.root);
    this.physics = new PhysicsEngine();
    this.particles = new ParticleEngine(this.root);
    this.fourD = new FourDEngine();
    this.root.add(this.fourD.group);

    this.paused = false;
    this.grabTarget = null; // ObjectManager object Group or "4D"
    this._grabPrev = new THREE.Vector3();
    this._tmpV = new THREE.Vector3();

    // Per-object deletion + spawn feedback state.
    this.lastDeleteAt = 0;
    this._fistMs = 0;
    this.spawnPulses = []; // {x,y,t} normalized screen coords
  }

  // C3: frustum-derived spawn plane half-extents, recomputed on resize so
  // spawn/delete mapping tracks the actual camera instead of magic numbers.
  _updateFrustum() {
    const dist = 9;
    const halfH = Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2) * dist;
    const halfW = halfH * (this.camera.aspect || 1);
    this._spawnHalfW = halfW;
    this._spawnHalfH = halfH;
  }

  // Screen-space point → world position on the spawn plane (z ≈ -2).
  screenToWorld(point) {
    const hw = this._spawnHalfW ?? 3.5;
    const hh = this._spawnHalfH ?? 2.1;
    return new THREE.Vector3(
      (point.x - 0.5) * 2 * hw,
      (0.5 - point.y) * 2 * hh,
      -2,
    );
  }

  resize() {
    if (!this.renderer) return;
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this._updateFrustum();
  }

  // screenPoint: {x,y} normalized 0..1 (already mirrored). depth ~9 world units.
  spawnAtScreen(shape, screenPoint, cursorWorld = null) {
    let pos;
    if (cursorWorld) {
      pos = cursorWorld.clone();
    } else if (screenPoint) {
      pos = this.screenToWorld(screenPoint);
    } else {
      pos = new THREE.Vector3(0, 0, -2.5);
    }
    if (screenPoint) {
      this.spawnPulses.push({ x: screenPoint.x, y: screenPoint.y, t: performance.now() });
      if (this.spawnPulses.length > 12) this.spawnPulses.shift();
    }
    return this.objects.spawn(shape, pos);
  }

  // ---- per-object deletion (B1/B2/B3) ------------------------------------

  // Dispose + remove a single object; clears selection and grab state.
  // Never touches the 4D cube (it is not in objects.objects).
  deleteObject(obj) {
    if (!obj || !this.objects.objects.includes(obj)) return false;
    if (this.grabTarget === obj) {
      obj.userData.grabbed = false;
      this.grabTarget = null;
    }
    const kind = obj.userData?.kind || "object";
    this.objects.remove(obj);
    this.onToast(`DELETED ${String(kind).toUpperCase()}`);
    return true;
  }

  // Nearest spawned object within `radius` world units of a screen point.
  nearestObjectAtScreen(point, radius = 1.5) {
    if (!point) return null;
    const w = this.screenToWorld(point);
    let best = null;
    let bd = radius;
    for (const obj of this.objects.objects) {
      const d = obj.position.distanceTo(w);
      if (d < bd) { bd = d; best = obj; }
    }
    return best;
  }

  // Dock hold-to-delete / programmatic delete under the fingertit.
  deleteNearestAtScreen(point) {
    const obj = this.nearestObjectAtScreen(point, 1.5);
    return obj ? this.deleteObject(obj) : false;
  }

  // B3: desktop click fallback — raycast already resolved to a pickRoot by
  // CursorEngine.pickAtClient; only spawned objects are eligible.
  deletePicked(root) {
    if (!root || !this.objects.objects.includes(root)) return false;
    return this.deleteObject(root);
  }

  clearObjects() {
    this.objects.clear();
    this.grabTarget = null;
  }

  _pickGrabTarget(cursorWorld) {
    // Nearest object within 1.5 world units of the fingertip plane point.
    let best = null;
    let bestD = Infinity;
    for (const obj of this.objects.objects) {
      const d = obj.position.distanceTo(cursorWorld);
      if (d < bestD) { bestD = d; best = obj; }
    }
    if (best && bestD < 1.5) return best;
    // Otherwise the 4D cube if the fingertip is near it.
    const fd = this.fourD.group.position.distanceTo(cursorWorld);
    if (fd < 2.0) return "4D";
    return null;
  }

  _applyTwoHand(gesture, dt) {
    const th = gesture.twoHand;
    if (!th?.active) {
      this.fourD.twoHandBound = false;
      return;
    }
    // D14: route to the grabbed target if there is one, else the 4D cube —
    // never both.
    if (this.grabTarget && this.grabTarget !== "4D") {
      const obj = this.grabTarget;
      const target = Math.min(2.2, Math.max(0.3, th.scale));
      const s = obj.scale.x + (target - obj.scale.x) * 0.12;
      obj.scale.setScalar(s);
      obj.rotation.y += th.rotation * dt * 1.6;
      obj.position.x += th.pan.x * dt * 10;
      obj.position.y -= th.pan.y * dt * 10;
    } else if (this.grabTarget === "4D" || this._twoHandMode === "4D") {
      this.fourD.twoHandBound = true;
    } else if (!this.grabTarget) {
      // No grabbed object: two-hand scale drives camera FOV (zoom).
      const targetFov = clamp(FOV_BASE / Math.max(0.5, th.scale), FOV_MIN, FOV_MAX);
      if (Math.abs(this.camera.fov - targetFov) > 0.05) {
        this.camera.fov += (targetFov - this.camera.fov) * 0.15;
        this.camera.updateProjectionMatrix();
      }
    }
  }

  setTwoHandMode(mode) {
    // "4D" routes un-grabbed two-hand transforms to the tesseract;
    // "camera" routes them to FOV zoom.
    this._twoHandMode = mode;
  }

  update(dt, gesture = null, cursor = null, reducedMotion = false, fps = 60) {
    if (this.failed || this.paused) {
      if (!this.paused) this._trackFps(fps);
      return;
    }
    this._trackFps(fps);

    this.fourD.update(dt, gesture, reducedMotion);
    this.particles.update(dt, gesture, reducedMotion);
    this.objects.update(dt, reducedMotion);
    this.physics.step(this.objects.objects, dt);

    const point = gesture?.point;
    const pinch = gesture?.pinch && gesture?.hand;

    // ---- grab / drag -----------------------------------------------------
    if (pinch && cursor?.world) {
      if (!this.grabTarget) {
        // Prefer the cursor's raycast hover; fall back to proximity pick.
        const hoverRoot = cursor.hover?.userData?.pickRoot;
        const target = hoverRoot && this.objects.objects.includes(hoverRoot)
          ? hoverRoot
          : this._pickGrabTarget(cursor.world);
        if (target) {
          this.grabTarget = target;
          if (target === "4D") this.fourD.grabbed = true;
          else {
            target.userData.grabbed = true;
            this.objects.select(target);
          }
          this._grabPrev.copy(
            target === "4D" ? this.fourD.group.position : target.position,
          );
        }
      }

      if (this.grabTarget === "4D") {
        const p = this.fourD.group.position;
        p.x += (cursor.world.x - p.x) * GRAB_LERP;
        p.y += (cursor.world.y - p.y) * GRAB_LERP;
        p.z += (cursor.world.z - p.z) * GRAB_LERP * 0.4;
      } else if (this.grabTarget) {
        const obj = this.grabTarget;
        const p = obj.position;
        p.x += (cursor.world.x - p.x) * GRAB_LERP;
        p.y += (cursor.world.y - p.y) * GRAB_LERP;
        p.z += (cursor.world.z - p.z) * GRAB_LERP * 0.4;
        // Measure throw velocity for release (world units / second).
        obj.userData.throwVel.set(
          (p.x - this._grabPrev.x) / Math.max(dt, 0.008),
          (p.y - this._grabPrev.y) / Math.max(dt, 0.008),
          (p.z - this._grabPrev.z) / Math.max(dt, 0.008),
        );
        this._grabPrev.copy(p);
      }
    } else if (this.grabTarget) {
      // Release: hand the measured fingertip velocity to physics, scaled by
      // 0.01 per spec, clamped to a sane toss.
      if (this.grabTarget === "4D") {
        this.fourD.grabbed = false;
      } else {
        const ud = this.grabTarget.userData;
        ud.grabbed = false;
        ud.velocity.copy(ud.throwVel).multiplyScalar(0.01);
        ud.velocity.y += 0.4; // small pop so drops feel released, not glued
        ud.angularVelocity.set(
          ud.throwVel.z * 0.4,
          ud.throwVel.x * 0.4,
          (Math.random() - 0.5) * 2,
        );
      }
      this.grabTarget = null;
    }

    // POINT hover-select (only when not pinching).
    if (!pinch && gesture?.name === "POINT" && cursor?.hover) {
      const root = cursor.hover.userData?.pickRoot;
      if (root && this.objects.objects.includes(root)) this.objects.select(root);
    }

    // ---- FIST-to-delete (B1) ------------------------------------------------
    // FIST held >= 350 ms with fingertip OR palm center within 1.5 units of an
    // object deletes it. 400 ms cooldown prevents machine-gun deletion.
    if (gesture?.name === "FIST" && gesture.hand && cursor && !this.paused) {
      this._fistMs += dt * 1000;
      const nowMs = performance.now();
      if (this._fistMs >= 350 && nowMs - this.lastDeleteAt >= 400) {
        const tipW = cursor.world;
        const palmW = cursor.worldOnPlane({ x: gesture.hand[9].x, y: gesture.hand[9].y });
        let best = null;
        let bd = 1.5;
        for (const obj of this.objects.objects) {
          const dTip = tipW ? obj.position.distanceTo(tipW) : Infinity;
          const dPalm = palmW ? obj.position.distanceTo(palmW) : Infinity;
          const d = Math.min(dTip, dPalm);
          if (d < bd) { bd = d; best = obj; }
        }
        if (best && this.deleteObject(best)) {
          this.lastDeleteAt = nowMs;
          this._fistMs = 0;
        }
      }
    } else {
      this._fistMs = 0;
    }

    // ---- two-hand transforms ----------------------------------------------
    this._applyTwoHand(gesture, dt);

    // ---- swipe zoom --------------------------------------------------------
    if (gesture?.name === "SWIPE UP" || gesture?.name === "SWIPE DOWN") {
      const dir = gesture.name === "SWIPE UP" ? -1 : 1;
      const target = clamp(this.camera.fov + dir * 4, FOV_MIN, FOV_MAX);
      this.camera.fov += (target - this.camera.fov) * 0.3;
      this.camera.updateProjectionMatrix();
    }

    // ---- mode-driven object spawning handled by app; here we only render --
    if (this.renderer) this.renderer.render(this.scene, this.camera);
  }

  _trackFps(fps) {
    this._fpsWindow.push(fps);
    if (this._fpsWindow.length > 120) this._fpsWindow.shift();
    if (this._fpsWindow.length >= 120) {
      const avg = this._fpsWindow.reduce((a, b) => a + b, 0) / this._fpsWindow.length;
      if (avg < 20 && !this._lowFpsSince) this._lowFpsSince = performance.now();
      if (this._lowFpsSince && performance.now() - this._lowFpsSince > 5000 && !this._adaptiveDropped) {
        this._adaptiveDropped = true;
        this.renderer?.setPixelRatio(1.0);
      }
      if (avg >= 24 && this._adaptiveDropped) {
        // Recover once sustained fps is healthy again.
        this._adaptiveDropped = false;
        this._lowFpsSince = 0;
        this.renderer?.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
      }
    }
  }

  render() {
    if (this.renderer && !this.paused) {
      this.renderer.render(this.scene, this.camera);
    }
  }

  get pixelRatio() {
    return this.renderer?.getPixelRatio() ?? 1;
  }

  dispose() {
    this.objects.clear();
    this.particles.dispose();
    this.fourD.dispose();
    this.renderer?.dispose();
  }
}
