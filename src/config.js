// config.js — frozen defaults, storage keys, version.
// Every tunable lives here; engines read from an AppConfig snapshot.

export const VERSION = "4.0.0";

export const STORAGE_KEYS = Object.freeze({
  settings: "settings",
  guideSeen: "guideSeen",
  airSpawn: "airSpawn",
  version: "version",
});

export const CDN = Object.freeze({
  three: "https://cdn.jsdelivr.net/npm/three@0.185.0/build/three.module.min.js",
  tasksVision: "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/+esm",
  wasmRoot: "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/wasm",
  handModel:
    "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
  faceModel:
    "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
});

export const RESOLUTIONS = Object.freeze([
  { label: "640 × 480", width: 640, height: 480 },
  { label: "1280 × 720", width: 1280, height: 720 },
  { label: "1920 × 1080", width: 1920, height: 1080 },
]);

export const GESTURE_NAMES = Object.freeze([
  "NONE",
  "POINT",
  "PINCH",
  "PEACE",
  "OPEN PALM",
  "FIST",
  "THUMBS UP",
  "SWIPE LEFT",
  "SWIPE RIGHT",
  "SWIPE UP",
  "SWIPE DOWN",
  "HAND",
]);

export const MODES = Object.freeze(["SELECT", "DRAW", "4D"]);

export const DEFAULTS = Object.freeze({
  // camera / capture
  mirror: true,
  deviceId: "",
  resolution: "1280x720",
  captureFps: 30,
  inferenceRate: 30, // hand inference Hz; face runs at ~1/3 of this

  // vision toggles
  handEnabled: true,
  faceEnabled: true,
  trails: true,

  // gesture engine
  smoothing: 0.78,
  gestureThreshold: 0.55,
  grabEnabled: true,
  twoHandEnabled: true,
  minStableFrames: 2,
  gestureCooldownMs: 300,

  // interaction
  mode: "SELECT", // SELECT | DRAW | 4D

  // 4D
  fourDEnabled: true,
  fourDSpeed: 0.65,

  // graphics
  particleCount: 1000,
  wireframe: false,
  paused: false,
  reducedMotion: false,

  // air drawing
  airDrawEnabled: true,
  airSpawnEnabled: false, // auto-spawn on closed loop — OFF by default (C1)
  airMaxSamples: 90,
  airDwellMs: 700,
  airCooldownMs: 2000,
});
