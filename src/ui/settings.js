// settings.js — SettingsPanel: binds every control in the settings aside to
// live engine state and persists each change (D12). Camera-affecting changes
// require APPLY (D7) which calls camera.restart() without touching the loop.

import { $, on } from "../utils/dom.js";
import { safeFixed } from "../utils/math.js";

export class SettingsPanel {
  /**
   * @param {object} ctx
   *   {settings, storage, camera, vision, gestures, overlay, airDraw,
   *    getScene, getFourD, toast, closePanel}
   */
  constructor(ctx) {
    this.ctx = ctx;
    this.panel = $("settingsPanel");
    this.btn = $("settingsBtn");
    this._wireAll();
  }

  get open() {
    return this.panel.classList.contains("open");
  }

  toggle(force) {
    const open = force ?? !this.open;
    this.panel.classList.toggle("open", open);
    this.btn.classList.toggle("open", open);
    return open;
  }

  close() {
    this.toggle(false);
  }

  _persist() {
    this.ctx.storage.saveSettings(this.ctx.settings);
  }

  _setToggle(id, value) {
    const el = $(id);
    el.classList.toggle("on", !!value);
  }

  _bindRange(id, valueId, key, transform = (v) => v, after = () => {}) {
    const el = $(id);
    const label = $(valueId);
    const apply = (v) => {
      const n = transform(Number(v));
      this.ctx.settings[key] = n;
      if (label) label.textContent = safeFixed(n, key === "smoothing" || key === "gestureThreshold" || key === "fourDSpeed" ? 2 : 0);
      after(n);
      this._persist();
    };
    el.value = this.ctx.settings[key];
    apply(this.ctx.settings[key]);
    on(el, "input", (e) => apply(e.target.value));
  }

  _bindToggle(id, key, applyFn) {
    const el = $(id);
    this._setToggle(id, this.ctx.settings[key]);
    on(el, "click", () => {
      const v = !this.ctx.settings[key];
      this.ctx.settings[key] = v;
      this._setToggle(id, v);
      if (applyFn) applyFn(v);
      this._persist();
    });
  }

  _wireAll() {
    const { settings, camera, vision, gestures, overlay, airDraw } = this.ctx;

    // ---- camera & performance -------------------------------------------
    on($("startBtn"), "click", () => this.ctx.startCamera());
    on($("stopBtn"), "click", () => this.ctx.stopCamera());
    on($("reconnectBtn"), "click", () => this.ctx.reconnectCamera());
    on($("fullscreenBtn"), "click", () => this.ctx.toggleFullscreen());

    const camSel = $("cameraSelect");
    camSel.value = settings.deviceId || "";
    on(camSel, "change", (e) => {
      settings.deviceId = e.target.value;
      camera.deviceId = e.target.value;
      this._persist();
    });

    $("resolutionSelect").value = settings.resolution;
    on($("resolutionSelect"), "change", (e) => {
      settings.resolution = e.target.value;
      this._persist();
    });

    this._bindRange("fpsRange", "fpsVal", "captureFps", (v) => v, (v) => {
      camera.fps = v;
    });
    this._bindRange("inferRange", "inferVal", "inferenceRate", (v) => v, (v) => {
      vision.inferenceRate = v;
    });
    on($("applyCameraBtn"), "click", () => this.ctx.applyCameraSettings());

    // ---- vision ------------------------------------------------------------
    this._bindToggle("handToggle", "handEnabled", (v) => { vision.handEnabled = v; });
    this._bindToggle("faceToggle", "faceEnabled", (v) => { vision.faceEnabled = v; });
    this._bindToggle("trailToggle", "trails", (v) => { overlay.trailsOn = v; });
    this._bindRange("smooth", "smoothVal", "smoothing", (v) => v, (v) => {
      gestures.smoothing = v;
    });
    // D5: threshold is read by GestureEngine.classify/_commitName.
    this._bindRange("gestureThreshold", "gestureVal", "gestureThreshold", (v) => v, (v) => {
      gestures.threshold = v;
    });

    // ---- interaction ---------------------------------------------------------
    this._bindToggle("grabToggle", "grabEnabled", (v) => { gestures.grabEnabled = v; });
    this._bindToggle("twoHandToggle", "twoHandEnabled", (v) => { gestures.twoHandEnabled = v; });
    on($("spawnBtn"), "click", () => this.ctx.spawnRandom());
    on($("clearBtn"), "click", () => this.ctx.clearObjects());

    // ---- 4D -------------------------------------------------------------------
    this._bindToggle("fourDToggle", "fourDEnabled", (v) => {
      const fd = this.ctx.getFourD?.();
      if (fd) fd.enabled = v;
    });
    this._bindRange("fourDSpeed", "fourDVal", "fourDSpeed", (v) => v, (v) => {
      this.ctx.getFourD?.()?.setSpeed(v);
    });
    on($("reset4D"), "click", () => this.ctx.getFourD?.().reset());
    on($("center4D"), "click", () => {
      const fd = this.ctx.getFourD?.();
      if (fd) {
        fd.group.position.set(0, 0, -2.5);
        fd.group.scale.setScalar(0.95);
        fd.twoHandBound = false;
      }
    });

    // ---- graphics ---------------------------------------------------------------
    // D10: rebuild is debounced inside ParticleEngine.setCount.
    this._bindRange("particleCount", "particleVal", "particleCount", (v) => Math.round(v), (v) => {
      const scene = this.ctx.getScene?.();
      if (scene) scene.particles.setCount(v, { debounceMs: 150 });
    });
    on($("wireBtn"), "click", () => {
      settings.wireframe = !settings.wireframe;
      this.ctx.getScene?.()?.objects.setWireframe(settings.wireframe);
      $("wireBtn").textContent = settings.wireframe ? "WIREFRAME: ON" : "WIREFRAME";
      this._persist();
    });
    on($("pauseBtn"), "click", () => {
      settings.paused = !settings.paused;
      const scene = this.ctx.getScene?.();
      if (scene) scene.paused = settings.paused;
      $("pauseBtn").textContent = settings.paused ? "RESUME" : "PAUSE";
      this._persist();
    });
    // D6: reduced motion is a real <html> class + engine flags.
    this._bindToggle("motionToggle", "reducedMotion", (v) => {
      document.documentElement.classList.toggle("reduced-motion", v);
      const scene = this.ctx.getScene?.();
      if (scene) scene.particles.rotationEnabled = !v;
    });

    // Initialize derived UI from restored settings.
    document.documentElement.classList.toggle("reduced-motion", !!settings.reducedMotion);
    $("wireBtn").textContent = settings.wireframe ? "WIREFRAME: ON" : "WIREFRAME";
    $("pauseBtn").textContent = settings.paused ? "RESUME" : "PAUSE";
    if (airDraw) airDraw.enabled = settings.airDrawEnabled !== false;
  }
}
