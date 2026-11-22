// hud.js — HUDManager: topbar status chips + live gesture legend.
// Updates are throttled by app.js to 150 ms; values use textContent on <b>
// nodes so the DOM diff stays cheap.

import { safeFixed } from "../utils/math.js";

export class HUDManager {
  constructor() {
    this.els = {
      camera: document.getElementById("sCamera"),
      vision: document.getElementById("sVision"),
      hands: document.getElementById("sHands"),
      face: document.getElementById("sFace"),
      gesture: document.getElementById("sGesture"),
      confidence: document.getElementById("sConfidence"),
      fps: document.getElementById("sFPS"),
      tracking: document.getElementById("sTracking"),
      renderer: document.getElementById("sRenderer"),
      legendName: document.getElementById("legendName"),
      legendBars: [...document.querySelectorAll("#legendBars i")],
      mode: document.getElementById("sMode"),
      debug: document.getElementById("debug"),
    };
    this._last = {};
  }

  _set(el, key, value) {
    if (!el) return;
    const v = String(value);
    if (this._last[key] === v) return;
    this._last[key] = v;
    el.textContent = v;
  }

  // state: {camera,vision,hands,face,gesture,confidence,fps,tracking,
  //         renderer,inferMs,mode,visionFaceEnabled,scene,vision,cameraObj}
  update(s) {
    this._set(this.els.camera, "cam", s.camera);
    this._set(this.els.vision, "vis", s.vision);
    this._set(this.els.hands, "hands", s.hands);
    this._set(this.els.face, "face", s.face);
    this._set(this.els.gesture, "gest", s.gesture);
    this._set(this.els.confidence, "conf", safeFixed(s.confidence, 2));
    this._set(this.els.fps, "fps", s.fps);
    this._set(this.els.tracking, "trk", s.tracking);
    this._set(this.els.renderer, "ren", s.renderer);
    this._set(this.els.mode, "mode", s.mode);

    // Live legend: gesture name + 3-segment confidence meter.
    this._set(this.els.legendName, "leg", s.gesture);
    const lit = Math.round((s.confidence || 0) * this.els.legendBars.length);
    this.els.legendBars.forEach((bar, i) => {
      bar.classList.toggle("on", i < lit);
    });

    if (this.els.debug && s.debugText) {
      this._set(this.els.debug, "dbg", s.debugText);
    }
  }
}
