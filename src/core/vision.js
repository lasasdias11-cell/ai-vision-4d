// vision.js — VisionManager: MediaPipe Hand + Face Landmarker lifecycle,
// staggered inference scheduling, cancellation, and a per-model circuit
// breaker. The mirror flip (x → 1 − x) is applied ONCE here at the
// vision-output boundary (defect D1); everything downstream is screen-space.

import { CDN } from "../config.js";
import { clamp } from "../utils/math.js";

const HAND_MS_MIN = 1000 / 60;
const HAND_MS_MAX = 1000 / 12;
const FACE_EVERY_N_HAND_TICKS = 3;
const CIRCUIT_THRESHOLD = 5; // consecutive failures before a model is benched
const CIRCUIT_COOLDOWN_MS = 10000;

export class VisionManager {
  constructor({ handEnabled = true, faceEnabled = true, inferenceRate = 30 } = {}) {
    this.handLandmarker = null;
    this.faceLandmarker = null;
    this.ready = false;
    this.handEnabled = handEnabled;
    this.faceEnabled = faceEnabled;
    this.delegate = "CPU";
    this.vision = null; // FilesetResolver result

    this.inferenceRate = inferenceRate;
    this.latest = { hands: [], face: [], time: 0, handRan: false, faceRan: false };
    this.inferMs = 0;
    this.handInferMs = 0;
    this.faceInferMs = 0;

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

    this._cancelled = false;
  }

  get handIntervalMs() {
    return clamp(1000 / Math.max(1, this.inferenceRate), HAND_MS_MIN, HAND_MS_MAX);
  }

  // Load the WASM runtime once; safe to call before initHand/initFace.
  async initRuntime({ onStage = () => {} } = {}) {
    this._cancelled = false;
    if (this.vision) return this; // already loaded — retry-safe
    const vision = await this._loadRuntime(onStage);
    this._checkCancelled();
    this.vision = vision;
    return this;
  }

  async initHand({ onStage = () => {} } = {}) {
    this._checkCancelled();
    onStage("LOADING VISION MODELS (HandLandmarker)…");
    const hand = await this._createHand();
    // D9: if init was cancelled while the model downloaded, close the
    // partially-initialized landmarker instead of leaking it.
    if (this._cancelled) {
      try { hand.close(); } catch { /* ignore */ }
      throw this._cancelledError();
    }
    this.handLandmarker = hand;
    return this;
  }

  async initFace({ onStage = () => {} } = {}) {
    this._checkCancelled();
    onStage("LOADING VISION MODELS (FaceLandmarker)…");
    try {
      const face = await this._createFace();
      if (this._cancelled) {
        try { face.close(); } catch { /* ignore */ }
        throw this._cancelledError();
      }
      this.faceLandmarker = face;
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
    await this.initRuntime({ onStage });
    await this.initHand({ onStage });
    await this.initFace({ onStage });
    this.ready = true;
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

  // Called once per animation frame. Runs hand inference when due (~inferenceRate Hz)
  // and face inference every FACE_EVERY_N_HAND_TICKS-th hand tick (D8).
  // Always returns the freshest result so the overlay stays smooth between ticks.
  update(video, nowMs) {
    if (!this.ready || !video || video.readyState < 2) {
      // Camera stopped or not yet live: drop stale landmarks so the overlay
      // never freezes on the last frame.
      if (this.latest.hands.length || this.latest.face.length) {
        this.latest = { hands: [], face: [], time: nowMs, handRan: false, faceRan: false };
      }
      return this.latest;
    }

    const t = Math.round(nowMs);
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
          this.latest.hands = this._mirrorHands(result?.landmarks || []);
          this._handFails = 0;
          this.handInferMs = performance.now() - s;
        } catch (e) {
          this._handFails++;
          if (this._handFails >= CIRCUIT_THRESHOLD) {
            this._handBenchedUntil = nowMs + CIRCUIT_COOLDOWN_MS;
            this._handFails = 0;
            console.warn("[AI VISION 4D] Hand inference circuit-broken for 10s.", e);
          }
        }
        handRan = true;
        this._handTick++;
        this._nextHandAt = nowMs + this.handIntervalMs;
      } else {
        this._nextHandAt = nowMs + 250; // benched: retry soon but cheaply
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
          this.latest.face = this._mirrorFace(result?.faceLandmarks || []);
          this._faceFails = 0;
          this.faceInferMs = performance.now() - s;
        } catch (e) {
          this._faceFails++;
          if (this._faceFails >= CIRCUIT_THRESHOLD) {
            this._faceBenchedUntil = nowMs + CIRCUIT_COOLDOWN_MS;
            this._faceFails = 0;
            console.warn("[AI VISION 4D] Face inference circuit-broken for 10s.", e);
          }
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
    } else if (this.latest.hands.length === 0 && this.latest.face.length === 0) {
      // No inference ran and nothing cached — still stamp time so HUD can tell.
      this.latest.time = nowMs;
    }
    return this.latest;
  }

  // D1: flip x exactly once, here. Video is CSS-mirrored with scaleX(-1),
  // so raw landmark x must become screen-space x = 1 - x before anyone else
  // (overlay, gestures, cursor) sees it.
  _mirrorPoint(p) {
    return { x: 1 - p.x, y: p.y, z: p.z || 0, visibility: p.visibility };
  }

  _mirrorHands(hands) {
    return hands.map((hand) => hand.map((p) => this._mirrorPoint(p)));
  }

  _mirrorFace(faces) {
    return faces.map((face) => face.map((p) => this._mirrorPoint(p)));
  }

  close() {
    try { this.handLandmarker?.close(); } catch { /* already closed */ }
    try { this.faceLandmarker?.close(); } catch { /* already closed */ }
    this.handLandmarker = null;
    this.faceLandmarker = null;
    this.ready = false;
    this.latest = { hands: [], face: [], time: 0, handRan: false, faceRan: false };
  }
}
