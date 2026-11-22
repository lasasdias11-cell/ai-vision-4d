// camera.js — CameraManager: enumerate, start/stop, restart with new
// constraints, device-change handling, and state callbacks.
// The render/inference loop lives in app.js and is independent of stream
// restarts, so APPLY/resolution changes never kill the rAF loop (D7, D4).

export class CameraManager {
  /**
   * @param {HTMLVideoElement} video
   * @param {(state:string, detail?:any)=>void} onState
   */
  constructor(video, onState = () => {}) {
    this.video = video;
    this.onState = onState;
    this.stream = null;
    this.devices = [];
    this.deviceId = "";
    this.width = 1280;
    this.height = 720;
    this.fps = 30;
    this.mirror = true;
    this.state = "idle"; // idle | starting | live | lost | stopped | error
    this._deviceChangeHandler = null;
  }

  get active() {
    return this.state === "live" && !!this.stream;
  }

  async enumerate() {
    if (!navigator.mediaDevices?.enumerateDevices) {
      throw new Error("Camera APIs are unavailable in this browser.");
    }
    const devices = await navigator.mediaDevices.enumerateDevices();
    this.devices = devices.filter((d) => d.kind === "videoinput");
    return this.devices;
  }

  // Populate a <select> with video inputs. Labels are only non-empty after
  // permission has been granted once; fall back to "Camera N".
  fillSelect(selectEl) {
    if (!selectEl) return;
    selectEl.innerHTML = "";
    this.devices.forEach((d, i) => {
      const opt = document.createElement("option");
      opt.value = d.deviceId;
      opt.textContent = d.label || `Camera ${i + 1}`;
      selectEl.appendChild(opt);
    });
    if (this.deviceId && this.devices.some((d) => d.deviceId === this.deviceId)) {
      selectEl.value = this.deviceId;
    } else if (this.devices[0]) {
      this.deviceId = this.devices[0].deviceId;
      selectEl.value = this.deviceId;
    }
  }

  _constraints() {
    const video = {
      width: { ideal: this.width },
      height: { ideal: this.height },
      frameRate: { ideal: this.fps, max: this.fps },
    };
    if (this.deviceId) video.deviceId = { exact: this.deviceId };
    return { audio: false, video };
  }

  async start() {
    if (!window.isSecureContext) {
      const e = new Error("Camera access requires HTTPS or localhost.");
      e.name = "InsecureContext";
      throw e;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("getUserMedia is not supported by this browser.");
    }

    this.state = "starting";
    this.stopTracksOnly();

    try {
      this.stream = await navigator.mediaDevices.getUserMedia(this._constraints());
    } catch (e) {
      if (e.name === "OverconstrainedError") {
        // Relax to whatever the camera supports, then adopt real settings.
        this.stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: true,
        });
      } else {
        this.state = "error";
        this.onState("error", e);
        throw e;
      }
    }

    this.video.srcObject = this.stream;
    try {
      await this.video.play();
    } catch (e) {
      this.stopTracksOnly();
      this.state = "error";
      this.onState("error", e);
      throw e;
    }

    const track = this.stream.getVideoTracks()[0];
    if (track) {
      const s = track.getSettings();
      this.width = s.width || this.width;
      this.height = s.height || this.height;
      this.fps = s.frameRate || this.fps;
      this.deviceId = s.deviceId || this.deviceId;
      track.onended = () => {
        this.state = "lost";
        this.stream = null;
        this.onState("lost");
      };
      track.onmute = () => {
        // Track muted usually precedes 'ended' on some platforms; ignore.
      };
    }

    try {
      await this.enumerate();
    } catch {
      /* enumeration is best-effort */
    }

    this.state = "live";
    this.onState("connected");
    return this.stream;
  }

  // Re-apply constraints (resolution/FPS/device) on a live or idle camera.
  // Safe to call while the rAF loop runs — the loop keys off video frames,
  // not the stream object.
  async restart() {
    const wasLive = this.state === "live";
    try {
      await this.start();
    } catch (e) {
      if (wasLive) this.onState("lost");
      throw e;
    }
  }

  stopTracksOnly() {
    if (this.stream) {
      this.stream.getTracks().forEach((t) => {
        t.onended = null;
        t.stop();
      });
      this.stream = null;
    }
  }

  stop() {
    this.stopTracksOnly();
    if (this.video) {
      this.video.pause();
      this.video.srcObject = null;
    }
    if (this.state !== "error") this.state = "stopped";
    this.onState("stopped");
  }

  watchDeviceChanges() {
    if (this._deviceChangeHandler || !navigator.mediaDevices?.addEventListener) return;
    this._deviceChangeHandler = () => {
      this.enumerate()
        .then(() => this.onState("devices"))
        .catch(() => {});
    };
    navigator.mediaDevices.addEventListener("devicechange", this._deviceChangeHandler);
  }

  unwatchDeviceChanges() {
    if (this._deviceChangeHandler && navigator.mediaDevices?.removeEventListener) {
      navigator.mediaDevices.removeEventListener("devicechange", this._deviceChangeHandler);
      this._deviceChangeHandler = null;
    }
  }
}
