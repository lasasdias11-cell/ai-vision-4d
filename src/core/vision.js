// vision.js — VisionManager: MediaPipe Hand + Face Landmarker lifecycle,
// staggered inference scheduling, monotonic timestamps, error accounting,
// and a per-model circuit breaker.
//
// Output contract: landmarks are RAW video-frame coordinates (NOT mirrored).
// The single mirror flip + cover-crop mapping happens downstream in
// VideoMapper (render/overlay.js) — one flip, one place.

import { CDN } from "../config.js";
import { clamp } from "../utils/math.js";

const HAND_MS_MIN = 1000 / 60;
const HAND_MS_MAX = 1000 / 12;
const FACE_EVERY_N_HAND_TICKS = 3;
const CIRCUIT_THRESHOLD = 5; // consecutive failures before a model is benched
const CIRCUIT_COOLDOWN_MS = 10000;

const EMPTY = Object.freeze({ hands: Object.freeze([]), face: Object.freeze([]) });

export class VisionManager {
  constructor({ handEnabled = true, faceEnabled = true, inferenceRate = 30 } = {}) {
    this.handLandmarker = null;
    this.faceLandmarker = null;
    this.ready = false;
    this.failed = false;
    this.failReason = "";
    this.handEnabled = handEnabled;
    this.faceEnabled = faceEnabled;
    this.delegate = "CPU";
    this.vision = null;

    this.inferenceRate = inferenceRate;
    this.latest = { hands: [], face: [], time: 0, handRan: false, faceRan: false };
    this.inferMs = 0;
    this.handInferMs = 0;
    this.faceInferMs = 0;

    // FIX-2/3 diagnostics
    this.handErrors = 0;
    this.faceErrors = 0;
    this.lastHandError = "";
    this.lastFaceError = "";
    this.lastSkip = "";
    this.lastTimestamp = -1;
    this.inferencesPerSec = 0;
    this._inferTimes = [];

    // scheduling
    this._nextHandAt = 0;
    this._handTick = 0;
    this._nextFaceAt = 0;

    // circuit breakers
    this._handFails = 0;
    this._faceFails = 0;
    this._handBenchedUntil = 0;
    this._faceBenchedUntil = 0;
    this.faceError = null;
    this.onInferenceDisabled = null; // (model:string)=>void hook for toast

    this._cancelled = false;
  }

  get handIntervalMs() {
    return clamp(1000 / Math.max(1, this.inferenceRate), HAND_MS_MIN, HAND_MS_MAX);
  }

  // FIX-1: verify a created landmarker actually exposes detectForVideo.
  _assertUsable(lm, name) {
    if (!lm || typeof lm.detectForVideo !== "function") {
      const e = new Error(`${name} did not initialize correctly (detectForVideo missing).`);
      e.name = "ModelLoadError";
      throw e;
    }
    return lm;
  }

  async initRuntime({ onStage = () => {} } = {}) {
    this._cancelled = false;
    if (this.vision) return this;
    const vision = await this._loadRuntime(onStage);
    this._checkCancelled();
    this.vision = vision;
    return this;
  }

  async initHand({ onStage = () => {} } = {}) {
    this._checkCancelled();
    onStage("LOADING VISION MODELS (HandLandmarker)…");
    const hand = await this._createHand();
    if (this._cancelled) {
      try { hand.close(); } catch (e) { console.warn("[AI VISION 4D] close during cancel:", e); }
      throw this._cancelledError();
    }
    this.handLandmarker = this._assertUsable(hand, "HandLandmarker");
    return this;
  }

  async initFace({ onStage = () => {} } = {}) {
    this._checkCancelled();
    onStage("LOADING VISION MODELS (FaceLandmarker)…");
    try {
      const face = await this._createFace();
      if (this._cancelled) {
        try { face.close(); } catch (e) { console.warn("[AI VISION 4D] close during cancel:", e); }
        throw this._cancelledError();
      }
      this.faceLandmarker = this._assertUsable(face, "FaceLandmarker");
    } catch (e) {
      if (this._cancelled) throw this._cancelledError();
      this.faceError = e;
      this.faceEnabled = false;
      console.warn("[AI VISION 4D] Face landmarker unavailable; continuing without face overlay.", e);
    }
    this.ready = !!this.handLandmarker;
    return this;
  }

  async init({ onStage = () => {} } = {}) {
    try {
      await this.initRuntime({ onStage });
      await this.initHand({ onStage });
      await this.initFace({ onStage });
      this.ready = !!this.handLandmarker;
      if (!this.ready) throw new Error("Hand landmarker failed to initialize.");
    } catch (e) {
      this.failed = true;
      this.failReason = e?.message || String(e);
      this.ready = false;
      throw e;
    }
    return this;
  }

  cancel() {
    this._cancelled = true;
  }

  _cancelledError() {
    const e = new Error("Vision initialization was cancelled.");
    e.name = "CancelledError";
    return e;
  }

  _checkCancelled() {
    if (this._cancelled) throw this._cancelledError();
  }

  async _loadRuntime(onStage) {
    onStage("LOADING VISION RUNTIME…");
    const { FilesetResolver } = await import(CDN.tasksVision);
    this._checkCancelled();
    return FilesetResolver.forVisionTasks(CDN.wasmRoot);
  }

  async _createHand() {
    const { HandLandmarker } = await import(CDN.tasksVision);
    this._checkCancelled();
    return HandLandmarker.createFromOptions(this.vision, {
      baseOptions: { modelAssetPath: CDN.handModel, delegate: "CPU" },
      runningMode: "VIDEO",
      numHands: 2,
      minHandDetectionConfidence: 0.5,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
  }

  async _createFace() {
    const { FaceLandmarker } = await import(CDN.tasksVision);
    this._checkCancelled();
    return FaceLandmarker.createFromOptions(this.vision, {
      baseOptions: { modelAssetPath: CDN.faceModel, delegate: "CPU" },
      runningMode: "VIDEO",
      numFaces: 1,
      minFaceDetectionConfidence: 0.5,
      minFacePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
      outputFaceBlendshapes: false,
      outputFacialTransformationMatrixes: false,
    });
  }

  // FIX-4: MediaPipe requires strictly monotonic timestamps in VIDEO mode.
  _safeTimestamp(t) {
    const safe = Math.max(Math.round(t), this.lastTimestamp + 1);
    this.lastTimestamp = safe;
    return safe;
  }

  _noteInfer(dtMs) {
    this._inferTimes.push(dtMs);
    if (this._inferTimes.length > 60) this._inferTimes.shift();
    const sum = this._inferTimes.reduce((a, b) => a + b, 0);
    const windowMs = this._inferTimes.length * (1000 / Math.max(1, this.inferenceRate));
    this.inferencesPerSec = windowMs > 0 ? this._inferTimes.length / (windowMs / 1000) : 0;
  }

  _handFailed(e, nowMs) {
    this.handErrors++;
    this._handFails++;
    this.lastHandError = e?.message || String(e);
    console.error("[AI VISION 4D] Hand inference error:", e);
    if (this._handFails >= CIRCUIT_THRESHOLD) {
      this._handBenchedUntil = nowMs + CIRCUIT_COOLDOWN_MS;
      this._handFails = 0;
      this.handEnabled = false;
      console.error("[AI VISION 4D] HAND INFERENCE DISABLED after", CIRCUIT_THRESHOLD, "consecutive errors.");
      this.onInferenceDisabled?.("HAND");
    }
  }

  _faceFailed(e, nowMs) {
    this.faceErrors++;
    this._faceFails++;
    this.lastFaceError = e?.message || String(e);
    console.error("[AI VISION 4D] Face inference error:", e);
    if (this._faceFails >= CIRCUIT_THRESHOLD) {
      this._faceBenchedUntil = nowMs + CIRCUIT_COOLDOWN_MS;
      this._faceFails = 0;
      this.faceEnabled = false;
      this.onInferenceDisabled?.("FACE");
    }
  }

  // Called once per animation frame. Hands every tick (~inferenceRate Hz),
  // face every 3rd hand tick. Returns the freshest cached result.
  // FIX-3: every early-out records WHY in lastSkip.
  update(video, nowMs) {
    if (!this.ready) {
      this.lastSkip = "not-ready";
      return this._empty(nowMs);
    }
    if (!video || video.readyState < 2) {
      this.lastSkip = "video-not-ready";
      return this._empty(nowMs);
    }
    if (!video.videoWidth || !video.videoHeight) {
      this.lastSkip = "zero-dimensions";
      return this._empty(nowMs);
    }
    this.lastSkip = "";

    const t = this._safeTimestamp(nowMs);
    let handRan = false;
    let faceRan = false;
    const startAll = performance.now();

    if (!this.handEnabled || !this.handLandmarker) this.latest.hands = [];
    if (!this.faceEnabled || !this.faceLandmarker) this.latest.face = [];

    if (this.handEnabled && this.handLandmarker && nowMs >= this._nextHandAt) {
      if (nowMs >= this._handBenchedUntil) {
        const s = performance.now();
        try {
          const result = this.handLandmarker.detectForVideo(video, t);
          this.latest.hands = result?.landmarks || [];
          this._handFails = 0;
          this.handInferMs = performance.now() - s;
          this._noteInfer(this.handInferMs);
        } catch (e) {
          this._handFailed(e, nowMs);
        }
        handRan = true;
        this._handTick++;
        this._nextHandAt = nowMs + this.handIntervalMs;
      } else {
        this._nextHandAt = nowMs + 250;
      }
    }

    if (
      this.faceEnabled &&
      this.faceLandmarker &&
      handRan &&
      this._handTick % FACE_EVERY_N_HAND_TICKS === 0 &&
      nowMs >= this._nextFaceAt
    ) {
      if (nowMs >= this._faceBenchedUntil) {
        const s = performance.now();
        try {
          const result = this.faceLandmarker.detectForVideo(video, t);
          this.latest.face = result?.faceLandmarks || [];
          this._faceFails = 0;
          this.faceInferMs = performance.now() - s;
        } catch (e) {
          this._faceFailed(e, nowMs);
        }
        faceRan = true;
        this._nextFaceAt = nowMs + this.handIntervalMs * FACE_EVERY_N_HAND_TICKS;
      }
    }

    if (handRan || faceRan) {
      this.latest.time = nowMs;
      this.latest.handRan = handRan;
      this.latest.faceRan = faceRan;
      this.inferMs = performance.now() - startAll;
    }
    return this.latest;
  }

  _empty(nowMs) {
    if (this.latest.hands.length || this.latest.face.length) {
      this.latest = { hands: [], face: [], time: nowMs, handRan: false, faceRan: false };
    }
    return this.latest;
  }

  close() {
    try { this.handLandmarker?.close(); } catch (e) { console.warn("[AI VISION 4D] hand close:", e); }
    try { this.faceLandmarker?.close(); } catch (e) { console.warn("[AI VISION 4D] face close:", e); }
    this.handLandmarker = null;
    this.faceLandmarker = null;
    this.ready = false;
    this.latest = { hands: [], face: [], time: 0, handRan: false, faceRan: false };
  }
}
