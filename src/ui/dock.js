// dock.js — DockController: five quick actions + keyboard shortcuts.
// Shortcuts: G guide · S settings · F fullscreen · C camera · Space pause ·
// Esc close panels. Bound once; ignored while typing in a field.

import { on } from "../utils/dom.js";

const SHAPES = ["cube", "sphere", "triangle", "pyramid", "cone", "cylinder", "torus", "icosahedron", "wireframe-cube", "particle-sphere", "crystal"];

export class DockController {
  /**
   * @param {object} ctx
   *   {startCamera, stopCamera, isCameraLive, toggleGuide, toggleSettings,
   *    toggleFullscreen, spawnRandom, toggle4D, toast}
   */
  constructor(ctx) {
    this.ctx = ctx;
    this._bindButtons();
    this._bindKeys();
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
    if (obj) on(obj, "click", () => this.ctx.spawnRandom());

    const four = document.getElementById("dock4D");
    if (four) on(four, "click", () => this.ctx.toggle4D());

    const focus = document.getElementById("dockFocus");
    if (focus) on(focus, "click", () => this.ctx.toggleFullscreen());
  }

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
          break;
      }
    });
  }
}

export { SHAPES as SPAWN_SHAPES };
