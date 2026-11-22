// dock.js — DockController: five quick actions + keyboard shortcuts.
// Shortcuts: G guide · S settings · F fullscreen · C camera · Space pause ·
// Esc close panels. Bound once; ignored while typing in a field.
// Objects button: TAP spawns a cube at the fingertip, HOLD >= 600 ms deletes
// the object under the fingertip (B2). A shape palette popover offers the
// full spawn list (C5).

import { on } from "../utils/dom.js";

export const SPAWN_SHAPES = [
  "cube", "sphere", "triangle", "pyramid", "cone", "cylinder",
  "torus", "icosahedron", "wireframe-cube", "particle-sphere", "crystal",
];

const SHAPE_LABEL = {
  "cube": "Cube", "sphere": "Sphere", "triangle": "Tri", "pyramid": "Pyr",
  "cone": "Cone", "cylinder": "Cyl", "torus": "Torus",
  "icosahedron": "Ico", "wireframe-cube": "Wire", "particle-sphere": "Pts",
  "crystal": "Crystal",
};

const HOLD_HINT_MS = 300;
const HOLD_DELETE_MS = 600;

export class DockController {
  /**
   * @param {object} ctx
   *   {startCamera, stopCamera, isCameraLive, toggleGuide, toggleSettings,
   *    toggleFullscreen, spawnCube, spawnShape, deleteUnderFingertip,
   *    toggle4D, togglePause, closePanels, toast}
   */
  constructor(ctx) {
    this.ctx = ctx;
    this._holdTimer = 0;
    this._hintTimer = 0;
    this._palette = null;
    this._bindButtons();
    this._bindKeys();
    this._buildPalette();
  }

  _bindButtons() {
    const cam = document.getElementById("dockCamera");
    if (cam) on(cam, "click", () => {
      if (this.ctx.isCameraLive()) this.ctx.stopCamera();
      else this.ctx.startCamera();
    });

    const gest = document.getElementById("dockGesture");
    if (gest) on(gest, "click", () => this.ctx.toggleGuide());

    const obj = document.getElementById("dockObject");
    if (obj) {
      obj.setAttribute("aria-label", "Spawn at fingertip · Hold to delete");
      on(obj, "pointerdown", () => this._objDown());
      on(obj, "pointerup", () => this._objUp());
      on(obj, "pointerleave", () => this._objCancel());
      on(obj, "pointercancel", () => this._objCancel());
    }

    const four = document.getElementById("dock4D");
    if (four) on(four, "click", () => this.ctx.toggle4D());

    const focus = document.getElementById("dockFocus");
    if (focus) on(focus, "click", () => this.ctx.toggleFullscreen());
  }

  // ---- Objects button: tap = spawn, hold = delete -------------------------

  _objDown() {
    this._holdStart = performance.now();
    this._deleted = false;
    this._hintTimer = setTimeout(() => {
      if (!this._deleted) this.ctx.toast?.("HOLD TO DELETE…");
    }, HOLD_HINT_MS);
    this._holdTimer = setTimeout(() => {
      if (this.ctx.deleteUnderFingertip?.()) {
        this._deleted = true;
        this._clearTimers();
      }
    }, HOLD_DELETE_MS);
  }

  _objUp() {
    const held = performance.now() - (this._holdStart || 0);
    this._clearTimers();
    if (!this._deleted && held < HOLD_DELETE_MS) {
      // TAP: spawn a cube at the fingertip and reveal the shape palette.
      this.ctx.spawnCube?.();
      this._togglePalette();
    }
  }

  _objCancel() {
    this._clearTimers();
  }

  _clearTimers() {
    clearTimeout(this._holdTimer);
    clearTimeout(this._hintTimer);
    this._holdTimer = this._hintTimer = 0;
  }

  // ---- shape palette popover (C5) ------------------------------------------

  _buildPalette() {
    const dock = document.querySelector(".bottom-dock");
    if (!dock) return;
    const pal = document.createElement("div");
    pal.id = "spawnPalette";
    pal.className = "spawn-palette glass";
    pal.hidden = true;
    for (const shape of SPAWN_SHAPES) {
      const b = document.createElement("button");
      b.className = "palette-btn";
      b.dataset.shape = shape;
      b.title = SHAPE_LABEL[shape];
      b.textContent = SHAPE_LABEL[shape];
      on(b, "click", (e) => {
        e.stopPropagation();
        this.ctx.spawnShape?.(shape);
        this._setPalette(false);
      });
      pal.appendChild(b);
    }
    dock.appendChild(pal);
    this._palette = pal;
    // Tap anywhere else closes the palette.
    window.addEventListener("pointerdown", (e) => {
      if (this._palette && !this._palette.hidden && !this._palette.contains(e.target)) {
        this._setPalette(false);
      }
    });
  }

  _togglePalette() {
    this._setPalette(!this._palette || this._palette.hidden);
  }

  _setPalette(show) {
    if (!this._palette) return;
    this._palette.hidden = !show;
  }

  // ---- keyboard ------------------------------------------------------------

  _isTypingTarget(e) {
    const t = e.target;
    if (!t) return false;
    return t.closest("input, textarea, select, [contenteditable='true']") != null;
  }

  _bindKeys() {
    window.addEventListener("keydown", (e) => {
      if (this._isTypingTarget(e)) return;
      if (e.repeat && e.code !== "Space") return;
      switch (e.code) {
        case "KeyG":
          e.preventDefault();
          this.ctx.toggleGuide();
          break;
        case "KeyS":
          e.preventDefault();
          this.ctx.toggleSettings();
          break;
        case "KeyF":
          e.preventDefault();
          this.ctx.toggleFullscreen();
          break;
        case "KeyC":
          e.preventDefault();
          if (this.ctx.isCameraLive()) this.ctx.stopCamera();
          else this.ctx.startCamera();
          break;
        case "Space":
          e.preventDefault();
          this.ctx.togglePause();
          break;
        case "Escape":
          this.ctx.closePanels();
          this._setPalette(false);
          break;
      }
    });
  }
}
