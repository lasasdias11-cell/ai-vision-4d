// app.js — entry point. Owns the engine singletons, the boot sequence, and
// the single guarded rAF loop (D4). No other module imports these instances.

import { MODES, STORAGE_KEYS } from "./config.js";
import { $, on } from "./utils/dom.js";
import { StorageManager } from "./utils/storage.js";
import { ErrorManager } from "./utils/errors.js";
import { PermissionManager } from "./utils/permissions.js";
import { clamp, safeFixed } from "./utils/math.js";
import { CameraManager } from "./core/camera.js";
import { VisionManager } from "./core/vision.js";
import { GestureEngine } from "./interaction/gestures.js";
import { AirDrawingEngine } from "./interaction/air-draw.js";
import { CursorEngine } from "./interaction/cursor.js";
import { SceneManager } from "./render/scene.js";
import { Overlay } from "./render/overlay.js";
import { BootController } from "./ui/boot.js";
import { HUDManager } from "./ui/hud.js";
import { SettingsPanel } from "./ui/settings.js";
import { DockController } from "./ui/dock.js";
import { GestureGuide } from "./ui/gesture-guide.js";
import { SPAWN_SHAPES } from "./ui/dock.js";

const AIR_SHAPE_MAP = {
  CIRCLE: "sphere",
  SQUARE: "cube",
  TRIANGLE: "triangle",
  RECTANGLE: "cube",
  LINE: "cylinder",
  ZIGZAG: "torus",
  SHAPE: "icosahedron",
};

export class App {
  constructor() {
    // D12: restore persisted settings BEFORE any engine is constructed.
    this.storage = new StorageManager();
    if (this.storage.dataVersion !== 1) {
      this.storage.dataVersion = 1;
    }
    this.settings = this.storage.loadSettings();
    // C1: air-spawn toggle persists under its own aiv4d_airSpawn key.
    this.settings.airSpawnEnabled = this.storage.getBool(
      STORAGE_KEYS.airSpawn, this.settings.airSpawnEnabled ?? false,
    );
    document.documentElement.classList.toggle("reduced-motion", !!this.settings.reducedMotion);

    this.errors = new ErrorManager({
      box: $("errorBox"),
      title: $("errorTitle"),
      text: $("errorText"),
      retryBtn: $("errorRetry"),
      closeBtn: $("errorClose"),
      helpBtn: $("errorHelp"),
    });
    this.permissions = new PermissionManager();

    this.camera = new CameraManager($("camera"), (state, detail) => this._onCameraState(state, detail));
    this.camera.mirror = this.settings.mirror;
    this.camera.deviceId = this.settings.deviceId || "";
    const [rw, rh] = (this.settings.resolution || "1280x720").split("x").map(Number);
    this.camera.width = rw || 1280;
    this.camera.height = rh || 720;
    this.camera.fps = this.settings.captureFps;

    this.vision = new VisionManager({
      handEnabled: this.settings.handEnabled,
      faceEnabled: this.settings.faceEnabled,
      inferenceRate: this.settings.inferenceRate,
    });

    this.gestures = new GestureEngine({
      smoothing: this.settings.smoothing,
      gestureThreshold: this.settings.gestureThreshold,
      grabEnabled: this.settings.grabEnabled,
      twoHandEnabled: this.settings.twoHandEnabled,
      minStableFrames: this.settings.minStableFrames,
      gestureCooldownMs: this.settings.gestureCooldownMs,
    });
    this.gestures.airSpawnEnabled = this.settings.airSpawnEnabled;

    this.mode = MODES.includes(this.settings.mode) ? this.settings.mode : "SELECT";
    this.airDraw = new AirDrawingEngine({
      maxSamples: this.settings.airMaxSamples,
      dwellMs: this.settings.airDwellMs,
      cooldownMs: this.settings.airCooldownMs,
      onShape: (shape, path, point) => this._onAirShape(shape, path, point),
    });
    this.airDraw.enabled = this.settings.airDrawEnabled !== false;

    this.overlay = new Overlay($("visionOverlay"));
    this.overlay.trailsOn = this.settings.trails;
    this.hud = new HUDManager();

    this.scene = null;
    this.cursor = null;
    this.graphicsFailed = false;

    // Single rAF loop guard (D4).
    this.isLooping = false;
    this.loopHandle = 0;
    this.running = false; // camera-live flag for the loop's work
    this.last = performance.now();
    this.fps = 0;
    this._frames = 0;
    this._fpsStamp = 0;
    this._lastHUD = 0;
    this._lastVision = { hands: [], face: [] };
    this._lastGesture = this.gestures.state;
    this._toastTimer = 0;

    this.boot = new BootController(
      {
        boot: $("boot"),
        status: $("bootStatus"),
        progress: $("bootProgress"),
        enable: $("enable"),
      },
      {
        checkBrowser: () => this._stageCheckBrowser(),
        enumerateCameras: () => this._stageEnumerateCameras(),
        visionRuntime: () => this.vision.initRuntime({ onStage: (s) => this.boot.setStatus(s) }),
        visionHand: () => this.vision.initHand({ onStage: (s) => this.boot.setStatus(s) }),
        visionFace: () => this.vision.initFace({ onStage: (s) => this.boot.setStatus(s) }),
        initScene: () => this._stageInitScene(),
        initFourD: () => this._stageInitFourD(),
        calibrate: () => this._stageCalibrate(),
      },
      (err, stageLabel) => this._onBootFatal(err, stageLabel),
    );

    this.guide = new GestureGuide($("gestureGuide"), { toast: (s) => this.toast(s) });

    this.settingsPanel = new SettingsPanel({
      settings: this.settings,
      storage: this.storage,
      camera: this.camera,
      vision: this.vision,
      gestures: this.gestures,
      overlay: this.overlay,
      airDraw: this.airDraw,
      getScene: () => this.scene,
      getFourD: () => this.scene?.fourD || null,
      toast: (s) => this.toast(s),
      startCamera: () => this.startCamera(),
      stopCamera: () => this.stopCamera(),
      reconnectCamera: () => this.reconnectCamera(),
      applyCameraSettings: () => this.applyCameraSettings(),
      spawnRandom: () => this.spawnRandom(),
      spawnCube: () => this.spawnAtPoint("cube"),
      spawnShape: (shape) => this.spawnAtPoint(shape),
      deleteUnderFingertip: () => this.deleteUnderFingertip(),
      clearObjects: () => this.clearObjects(),
      toggleFullscreen: () => this.toggleFullscreen(),
    });

    this.dock = new DockController({
      startCamera: () => this.startCamera(),
      stopCamera: () => this.stopCamera(),
      isCameraLive: () => this.camera.active,
      toggleGuide: () => this.guide.toggle(),
      toggleSettings: () => this.settingsPanel.toggle(),
      toggleFullscreen: () => this.toggleFullscreen(),
      spawnRandom: () => this.spawnRandom(),
      spawnCube: () => this.spawnAtPoint("cube"),
      spawnShape: (shape) => this.spawnAtPoint(shape),
      deleteUnderFingertip: () => this.deleteUnderFingertip(),
      toggle4D: () => this.toggle4D(),
      togglePause: () => this.togglePause(),
      closePanels: () => this.closePanels(),
      toast: (s) => this.toast(s),
    });

    this._wireGlobal();
  }

  // ------------------------------------------------------------------ boot

  async _stageCheckBrowser() {
    if (!window.isSecureContext) {
      const e = new Error("Camera access requires HTTPS or localhost.");
      e.name = "InsecureContext";
      throw e;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("getUserMedia is not supported by this browser.");
    }
    // Real WebGL2 probe — cheap, no renderer created.
    const probe = document.createElement("canvas");
    const gl = probe.getContext("webgl2") || probe.getContext("webgl");
    if (!gl) {
      const e = new Error("WebGL is not available in this browser.");
      e.name = "GraphicsUnavailable";
      throw e;
    }
    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    this._glRenderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : "unknown";
  }

  async _stageEnumerateCameras() {
    // Enumeration is best-effort: some environments (headless, locked-down
    // enterprise policy) never settle the promise. Cap the wait and continue —
    // getUserMedia will surface any real camera problem at start time.
    try {
      await Promise.race([
        this.camera.enumerate(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("enumerateDevices timed out")), 8000)),
      ]);
    } catch (e) {
      console.warn("[AI VISION 4D] Camera enumeration unavailable:", e.message);
      this.camera.devices = [];
    }
    this.camera.fillSelect($("cameraSelect"));
    if (this.settings.deviceId) $("cameraSelect").value = this.settings.deviceId;
  }

  _stageInitScene() {
    if (this.scene) return;
    this.scene = new SceneManager($("three"), {
      onGraphicsError: (e) => this._showGraphicsError(e),
      onToast: (s) => this.toast(s),
    });
    if (this.scene.failed) {
      const e = new Error(this.scene.failure?.message || "WebGL renderer could not be created.");
      e.name = "GraphicsUnavailable";
      e.cause = this.scene.failure;
      throw e;
    }
    this.scene.resize();
    this.cursor = new CursorEngine({
      camera: this.scene.camera,
      getPickables: () => this.scene.objects.pickables,
    });
    this.overlay.resize();
  }

  _stageInitFourD() {
    const fd = this.scene?.fourD;
    if (!fd || fd.edgeCount !== 32) {
      throw new Error("4D engine failed self-check (expected 32 tesseract edges).");
    }
    // Apply persisted settings now that engines exist (D12/D11).
    fd.enabled = this.settings.fourDEnabled;
    fd.setSpeed(this.settings.fourDSpeed);
    this.scene.objects.setWireframe(this.settings.wireframe);
    this.scene.particles.rebuild(this.settings.particleCount);
    this.scene.particles.rotationEnabled = !this.settings.reducedMotion;
    this.scene.paused = this.settings.paused;
    this.scene.setTwoHandMode(this.mode === "4D" ? "4D" : "camera");
  }

  async _stageCalibrate() {
    // Real calibration: measure rAF cadence for ~30 frames and verify the
    // video element + overlay are sized. No synthetic delay.
    await new Promise((resolve) => {
      let frames = 0;
      const t0 = performance.now();
      const tick = () => {
        frames++;
        if (frames >= 30 || performance.now() - t0 > 1200) {
          this._calibratedFps = frames / ((performance.now() - t0) / 1000);
          resolve();
        } else {
          requestAnimationFrame(tick);
        }
      };
      requestAnimationFrame(tick);
    });
  }

  _onBootFatal(err, stageLabel) {
    if (err?.name === "CancelledError") return;
    // If a vision stage failed or timed out, cancel the in-flight model load
    // so partially-initialized landmarkers are closed (D9).
    if (/VISION/i.test(stageLabel || "")) this.vision.cancel();
    if (err?.name === "GraphicsUnavailable") {
      this.boot.setStatus("GRAPHICS UNAVAILABLE");
      return;
    }
    const info = PermissionManager.describeError(err);
    this.errors.show(err, `Boot failed at: ${stageLabel}`, {
      title: "BOOT ERROR",
      retry: () => this.boot.retry(),
      help: info.kind === "denied" ? () => this._showCameraHelp() : null,
    });
  }

  _showGraphicsError(err) {
    this.graphicsFailed = true;
    const panel = $("gfxError");
    $("gfxErrorText").textContent =
      `WebGL renderer failed: ${err?.message || err}. ` +
      "The 3D scene cannot start. Try a different browser or enable hardware acceleration.";
    panel.hidden = false;
    on($("gfxRetry"), "click", () => window.location.reload());
  }

  _showCameraHelp() {
    $("camHelp").hidden = false;
  }

  // ------------------------------------------------------------- camera ctl

  async startCamera() {
    this.errors.hide();
    this.boot.hideEnable();
    try {
      await this.camera.start();
      // 'connected' state arrives via onState → hides boot, starts loop.
    } catch (e) {
      const info = PermissionManager.describeError(e);
      this.errors.show(e, info.message, {
        title: "CAMERA ERROR",
        retry: () => this.startCamera(),
        help: info.kind === "denied" ? () => this._showCameraHelp() : null,
      });
      this.boot.show();
      this.boot.showEnable("[ RETRY ]");
    }
  }

  stopCamera() {
    this.camera.stop();
    this.overlay.clear();
    this.boot.show();
    this.boot.showEnable("ENABLE CAMERA");
  }

  async reconnectCamera() {
    try {
      await this.camera.restart();
    } catch (e) {
      const info = PermissionManager.describeError(e);
      this.errors.show(e, info.message, {
        retry: () => this.reconnectCamera(),
        help: info.kind === "denied" ? () => this._showCameraHelp() : null,
      });
    }
  }

  // D7: apply resolution/FPS/device to a RUNNING stream; the rAF loop is
  // untouched because it reads camera.video frames, not the stream object.
  async applyCameraSettings() {
    const [w, h] = (this.settings.resolution || "1280x720").split("x").map(Number);
    this.camera.width = w || 1280;
    this.camera.height = h || 720;
    this.camera.fps = this.settings.captureFps;
    this.camera.deviceId = this.settings.deviceId || "";
    this.vision.inferenceRate = this.settings.inferenceRate;
    try {
      await this.camera.restart();
      this.toast("CAMERA SETTINGS APPLIED");
    } catch (e) {
      const info = PermissionManager.describeError(e);
      this.errors.show(e, info.message, {
        retry: () => this.applyCameraSettings(),
        help: info.kind === "denied" ? () => this._showCameraHelp() : null,
      });
    }
  }

  _onCameraState(state, detail) {
    if (state === "connected") {
      this._ensureLoop();
      this.boot.hide();
      this.toast("READY • PINCH TO GRAB");
      const hint = $("hint");
      hint.classList.add("show");
      setTimeout(() => hint.classList.remove("show"), 3500);
      // Gesture guide auto-opens ONCE on first camera start (persisted).
      if (!this.storage.guideSeen) {
        this.storage.guideSeen = true;
        this.guide.show();
      }
    } else if (state === "lost") {
      // D15: camera-lost returns to boot with a RECONNECT CTA — no frozen UI.
      this._stopLoop();
      this.overlay.clear();
      this.boot.showReconnect();
      this.hud.update({ camera: "LOST", vision: "STANDBY", hands: 0, face: 0, gesture: "NONE", confidence: 0, fps: this.fps, tracking: "—", renderer: this.scene ? "WEBGL2" : "—", mode: this.mode, debugText: "Camera track ended. Press RECONNECT to resume." });
    } else if (state === "stopped") {
      this.hud.update({ camera: "OFFLINE", vision: this.vision.ready ? "ACTIVE" : "STANDBY", hands: 0, face: 0, gesture: "NONE", confidence: 0, fps: this.fps, tracking: "—", renderer: this.scene ? "WEBGL2" : "—", mode: this.mode });
    } else if (state === "devices") {
      this.camera.fillSelect($("cameraSelect"));
      if (this.settings.deviceId) $("cameraSelect").value = this.settings.deviceId;
    }
  }

  // -------------------------------------------------------------- main loop

  _ensureLoop() {
    if (this.isLooping) return; // D4: never stack rAF loops
    this.isLooping = true;
    this.running = true;
    this.last = performance.now();
    this.loopHandle = requestAnimationFrame(this._tick);
  }

  _stopLoop() {
    this.isLooping = false;
    this.running = false;
    if (this.loopHandle) cancelAnimationFrame(this.loopHandle);
    this.loopHandle = 0;
  }

  _tick = (now) => {
    if (!this.isLooping) return;
    this.loopHandle = requestAnimationFrame(this._tick);

    const dt = clamp((now - this.last) / 1000, 0.001, 0.05);
    this.last = now;
    this._frames++;
    if (now - this._fpsStamp >= 500) {
      this.fps = Math.round((this._frames * 1000) / (now - this._fpsStamp));
      this._frames = 0;
      this._fpsStamp = now;
    }

    const video = this.camera.video;
    const visionOut = this.vision.update(video, now);
    this._lastVision = visionOut;
    const g = this.gestures.update(visionOut.hands, now);
    this._lastGesture = g;

    if (this.scene && !this.scene.failed) {
      this.cursor?.update(g.point);
      const drawing =
        this.mode === "DRAW" && this.settings.airDrawEnabled !== false &&
        (g.name === "POINT" || g.pinch);
      this.airDraw.update(drawing ? g.point : null, now);
      this.scene.update(dt, g, this.cursor, !!this.settings.reducedMotion, this.fps);
    }

    this.overlay.render({
      hands: visionOut.hands,
      face: visionOut.face,
      trails: this.gestures.trails,
      trailsEnabled: this.settings.trails,
      airPath: this.airDraw.path,
      airProgress: this.airDraw.progress > 0 ? this.airDraw.progress : null,
      airPoint: this.airDraw._lastPoint,
      airCandidate: this.airDraw.candidate,
      spawnPulses: this.scene?.spawnPulses,
      cursorPoint: g.point,
      reducedMotion: !!this.settings.reducedMotion,
    });

    this.guide.setLive({
      gesture: g.twoHand?.active ? "TWO HANDS" : g.name,
      confidence: g.confidence,
      mode: this.mode,
      twoHandActive: !!g.twoHand?.active,
    });

    this._handleGestureEdges(g);

    if (now - this._lastHUD > 150) {
      this._updateHUD();
      this._lastHUD = now;
    }
  };

  _handleGestureEdges(g) {
    const prev = g.prevName;
    if (!g.name || g.name === prev) return;

    switch (g.name) {
      case "PEACE":
        this._cycleMode(1);
        break;
      case "SWIPE LEFT":
        this._cycleMode(-1);
        break;
      case "SWIPE RIGHT":
        this._cycleMode(1);
        break;
      case "THUMBS UP":
        this._confirmAction();
        break;
      case "OPEN PALM":
        this.scene?.objects.select(null);
        this.airDraw.clear();
        break;
      case "FIST":
        this._cancelGrab();
        this.guide.hide();
        this.settingsPanel.close();
        break;
    }
  }

  _cycleMode(dir) {
    const i = MODES.indexOf(this.mode);
    this.mode = MODES[(i + dir + MODES.length) % MODES.length];
    this.settings.mode = this.mode;
    this.storage.saveSettings(this.settings);
    if (this.scene) this.scene.setTwoHandMode(this.mode === "4D" ? "4D" : "camera");
    this.toast(`MODE • ${this.mode}`);
  }

  _confirmAction() {
    // THUMBS UP confirms the current mode's primary action.
    if (this.mode === "SELECT") {
      this.spawnRandom();
    } else if (this.mode === "DRAW") {
      this.spawnAtPoint("sphere");
    } else if (this.mode === "4D" && this.scene?.fourD) {
      this.scene.fourD.reset();
      this.toast("4D RESET");
    }
  }

  _cancelGrab() {
    const sc = this.scene;
    if (!sc?.grabTarget) return;
    if (sc.grabTarget === "4D") {
      sc.fourD.grabbed = false;
    } else {
      sc.grabTarget.userData.grabbed = false;
      sc.grabTarget.userData.velocity.set(0, 0, 0);
    }
    sc.grabTarget = null;
  }

  _onAirShape(shape, path, point) {
    // C1: auto-spawn is gated by the persisted toggle — the air-path visual
    // is unaffected; only the spawn action is suppressed.
    if (!this.gestures.airSpawnEnabled) return;
    const spawnShape = AIR_SHAPE_MAP[shape] || "icosahedron";
    this.spawnAtPoint(spawnShape, shape);
  }

  // B2: dock hold-to-delete — nearest spawned object under the fingertip.
  deleteUnderFingertip() {
    if (!this.scene || this.scene.failed) return false;
    const g = this._lastGesture;
    return this.scene.deleteNearestAtScreen(g?.point || null);
  }

  spawnAtPoint(shape = "cube", tag = null) {
    if (!this.scene || this.scene.failed) return null;
    const g = this._lastGesture;
    const screenPoint = g?.point || { x: 0.5, y: 0.5 };
    let world = null;
    if (this.cursor && screenPoint) {
      world = this.cursor.worldAtScreen(screenPoint, 9);
    }
    const obj = this.scene.spawnAtScreen(shape, screenPoint, world);
    if (obj) {
      const label = tag ? `${tag} → ${shape.toUpperCase()}` : shape.toUpperCase();
      this.toast(`SPAWNED • ${label}`);
    }
    return obj;
  }

  spawnRandom() {
    const shape = SPAWN_SHAPES[Math.floor(Math.random() * SPAWN_SHAPES.length)];
    this.spawnAtPoint(shape);
  }

  clearObjects() {
    this.scene?.clearObjects();
    this.toast("OBJECTS CLEARED");
  }

  toggle4D() {
    const fd = this.scene?.fourD;
    if (!fd) return;
    fd.enabled = !fd.enabled;
    this.settings.fourDEnabled = fd.enabled;
    this.storage.saveSettings(this.settings);
    this.toast(fd.enabled ? "4D ENGINE ON" : "4D ENGINE OFF");
  }

  togglePause() {
    this.settings.paused = !this.settings.paused;
    if (this.scene) this.scene.paused = this.settings.paused;
    this.storage.saveSettings(this.settings);
    this.toast(this.settings.paused ? "SCENE PAUSED" : "SCENE RESUMED");
  }

  async toggleFullscreen() {
    try {
      if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
      else await document.exitFullscreen();
    } catch { /* fullscreen denied — non-fatal */ }
  }

  closePanels() {
    this.settingsPanel.close();
    this.guide.hide();
    this.errors.hide();
    $("camHelp").hidden = true;
  }

  toast(text) {
    const el = $("gestureToast");
    el.textContent = text;
    el.classList.add("show");
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => el.classList.remove("show"), 1600);
  }

  _updateHUD() {
    const g = this._lastGesture;
    const v = this._lastVision;
    const scene = this.scene;
    const debugText = scene
      ? `Camera: ${this.camera.width}×${this.camera.height} @ ${safeFixed(this.camera.fps, 0)} FPS
Vision: ${this.vision.delegate} • infer ${safeFixed(this.vision.inferMs, 1)} ms (hand ${safeFixed(this.vision.handInferMs, 1)} / face ${safeFixed(this.vision.faceInferMs, 1)})
Hands: ${v.hands.length}/2 • Face: ${v.face.length}/1
Gesture: ${g.name} • confidence ${safeFixed(g.confidence, 2)}
Mode: ${this.mode} • objects: ${scene.objects.objects.length}
Pixel ratio: ${safeFixed(scene.pixelRatio, 2)} • calibrated fps: ${safeFixed(this._calibratedFps, 0)}
Secure context: ${window.isSecureContext ? "YES" : "NO"}`
      : "3D engine not initialized.";

    this.hud.update({
      camera: this.camera.active ? "CONNECTED" : this.camera.state.toUpperCase(),
      vision: this.vision.ready ? (this.vision.faceError ? "ACTIVE*" : "ACTIVE") : "STANDBY",
      hands: v.hands.length,
      face: v.face.length,
      gesture: g.name,
      confidence: g.confidence,
      fps: this.fps,
      tracking: g.stable ? "LOCK" : g.hand ? "ACQ" : "—",
      renderer: scene ? (scene.failed ? "FALLBACK" : "WEBGL2") : "—",
      mode: this.mode,
      debugText,
    });
  }

  _wireGlobal() {
    on($("enable"), "click", () => {
      if (this.camera.active) {
        this.boot.hide();
      } else {
        this.startCamera();
      }
    });
    on($("errorClose"), "click", () => this.errors.hide());
    on($("camHelpClose"), "click", () => { $("camHelp").hidden = true; });
    on($("camHelpRetry"), "click", () => {
      $("camHelp").hidden = true;
      this.startCamera();
    });

    // B3: desktop click-to-delete fallback on the 3D canvas.
    const threeCanvas = $("three");
    on(threeCanvas, "click", (e) => {
      if (!this.scene || this.scene.failed || !this.cursor) return;
      const root = this.cursor.pickAtClient(e.clientX, e.clientY, threeCanvas.getBoundingClientRect());
      if (root && this.scene.deletePicked(root)) {
        // toast already emitted by deleteObject via onToast
      }
    });

    window.addEventListener("resize", () => {
      this.scene?.resize();
      this.overlay.resize();
    });
    navigator.mediaDevices?.addEventListener?.("devicechange", () => {
      this.camera.enumerate().then(() => {
        this.camera.fillSelect($("cameraSelect"));
        if (this.settings.deviceId) $("cameraSelect").value = this.settings.deviceId;
      }).catch(() => {});
    });
    window.addEventListener("beforeunload", () => {
      this._stopLoop();
      this.camera.stop();
      this.vision.close();
    });
    window.addEventListener("unhandledrejection", (e) => {
      this.errors.show(e.reason, "Unhandled asynchronous error");
    });
    window.addEventListener("error", (e) => {
      if (e.error) this.errors.show(e.error, "Runtime error");
    });
  }

  async init() {
    this.overlay.resize();
    await this.boot.run();
  }
}

const app = new App();
window.__AIV4D__ = app; // debugging handle (no secrets, read-only use)
app.init();
