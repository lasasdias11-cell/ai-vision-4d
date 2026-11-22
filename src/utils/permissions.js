// permissions.js — camera permission state probing.
// Uses mediaDevices.permissions.query('camera') where the browser supports it
// (Chromium). Where unsupported, falls back to an optimistic "prompt" state —
// the real answer arrives from getUserMedia itself.

export class PermissionManager {
  constructor() {
    this.state = "unknown"; // granted | denied | prompt | unknown
    this.supported = false;
  }

  async query() {
    try {
      if (navigator.permissions?.query) {
        const status = await navigator.permissions.query({ name: "camera" });
        this.supported = true;
        this.state = status.state; // 'granted' | 'denied' | 'prompt'
        status.onchange = () => { this.state = status.state; };
      } else {
        this.supported = false;
        // Optimistic: assume prompt until getUserMedia proves otherwise.
        this.state = "prompt";
      }
    } catch {
      // Firefox/Safari may throw on 'camera' descriptor — stay optimistic.
      this.supported = false;
      this.state = "prompt";
    }
    return this.state;
  }

  // Map a getUserMedia DOMException to a user-facing message + kind.
  static describeError(err) {
    switch (err?.name) {
      case "NotAllowedError":
      case "SecurityError":
        return {
          kind: "denied",
          message: "Camera access was denied.",
          detail: "Allow camera access for this site in your browser's site settings, then retry.",
        };
      case "NotFoundError":
      case "DevicesNotFoundError":
        return { kind: "notfound", message: "No camera was detected.", detail: "" };
      case "NotReadableError":
      case "TrackStartError":
        return {
          kind: "busy",
          message: "Your camera may be in use by another application.",
          detail: "Close other apps using the camera and retry.",
        };
      case "OverconstrainedError":
        return {
          kind: "overconstrained",
          message: "The requested camera settings are not supported.",
          detail: "Try a lower resolution or different camera.",
        };
      default:
        return { kind: "unknown", message: err?.message || "Camera start failed.", detail: "" };
    }
  }
}
