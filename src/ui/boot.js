// boot.js — BootController: real staged initialization. Each stage is an
// actual awaited operation; the progress bar only advances when a stage
// resolves. A 45 s watchdog surfaces the failing stage with a Retry that
// re-runs from that stage onward.

export class BootController {
  /**
   * @param {object} els  {status, progress, enable, reconnectHint?}
   * @param {object} hooks stage implementations, see STAGES below
   * @param {(err:Error, stage:string)=>void} onFatal
   */
  constructor(els, hooks, onFatal = () => {}) {
    this.els = els;
    this.hooks = hooks;
    this.onFatal = onFatal;
    this.stageIndex = 0;
    this.ready = false;
    this._watchdog = 0;
    this._enableLabel = "ENABLE CAMERA";
  }

  setStatus(text) {
    if (this.els.status) this.els.status.textContent = text;
  }

  setProgress(pct) {
    if (this.els.progress) this.els.progress.style.width = `${Math.round(pct)}%`;
  }

  showEnable(label = this._enableLabel) {
    if (this.els.enable) {
      this.els.enable.textContent = label;
      this.els.enable.hidden = false;
    }
  }

  hideEnable() {
    if (this.els.enable) this.els.enable.hidden = true;
  }

  // Camera-lost recovery: return to boot screen with a RECONNECT CTA (D15).
  showReconnect() {
    this.ready = false;
    this.setStatus("CAMERA CONNECTION LOST");
    this.setProgress(100);
    this.showEnable("[ RECONNECT ]");
    if (this.els.boot) this.els.boot.hidden = false;
  }

  hide() {
    if (this.els.boot) this.els.boot.hidden = true;
  }

  show() {
    if (this.els.boot) this.els.boot.hidden = false;
  }

  // Stage table. `run` executes hooks[i] for i >= fromIndex.
  // Each hook is a real async operation owned by app.js.
  stages() {
    return [
      { label: "BOOTING AI VISION SYSTEM…", run: () => this.hooks.checkBrowser() },
      { label: "CHECKING CAMERA (enumerate)…", run: () => this.hooks.enumerateCameras() },
      { label: "LOADING VISION MODELS (runtime)…", run: () => this.hooks.visionRuntime() },
      { label: "LOADING VISION MODELS (HandLandmarker)…", run: () => this.hooks.visionHand() },
      { label: "LOADING VISION MODELS (FaceLandmarker)…", run: () => this.hooks.visionFace() },
      { label: "INITIALIZING 3D ENGINE…", run: () => this.hooks.initScene() },
      { label: "INITIALIZING 4D ENGINE…", run: () => this.hooks.initFourD() },
      { label: "CALIBRATING…", run: () => this.hooks.calibrate() },
    ];
  }

  async run(fromIndex = 0) {
    const stages = this.stages();
    this.ready = false;
    this.hideEnable();

    for (let i = fromIndex; i < stages.length; i++) {
      this.stageIndex = i;
      const stage = stages[i];
      const pct = 8 + (i / stages.length) * 84;
      this.setStatus(stage.label);
      this.setProgress(pct);

      // 45 s watchdog per stage — surfaces the real category on timeout.
      try {
        await this._withTimeout(stage.run(), 45000, `Timed out during: ${stage.label}`);
      } catch (e) {
        if (e?.name === "CancelledError") return;
        this.setStatus("INITIALIZATION FAILED");
        this.setProgress(100);
        this.onFatal(e, stage.label);
        return;
      }
    }

    this.setStatus("SYSTEM READY");
    this.setProgress(100);
    this.ready = true;
    this.showEnable("ENABLE CAMERA");
  }

  // Retry re-runs only from the failed stage (D9 recovery semantics).
  retry() {
    return this.run(this.stageIndex);
  }

  _withTimeout(promise, ms, message) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        reject(Object.assign(new Error(message), { name: "TimeoutError" }));
      }, ms);
      Promise.resolve(promise).then(
        (v) => { clearTimeout(t); resolve(v); },
        (e) => { clearTimeout(t); reject(e); },
      );
    });
  }
}
