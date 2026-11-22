// errors.js — user-facing error modal + console logging.
// One ErrorManager instance lives in app.js and is passed to subsystems.

export class ErrorManager {
  constructor({ box, title, text, retryBtn, closeBtn, helpBtn } = {}) {
    this.box = box || null;
    this.titleEl = title || null;
    this.textEl = text || null;
    this.retryBtn = retryBtn || null;
    this.closeBtn = closeBtn || null;
    this.helpBtn = helpBtn || null;
    this.onRetry = null;
    this.onHelp = null;

    if (this.closeBtn) this.closeBtn.addEventListener("click", () => this.hide());
    if (this.retryBtn) {
      this.retryBtn.addEventListener("click", () => {
        const fn = this.onRetry;
        this.hide();
        if (fn) fn();
      });
    }
    if (this.helpBtn) {
      this.helpBtn.addEventListener("click", () => {
        if (this.onHelp) this.onHelp();
      });
    }
  }

  show(err, context = "Error", { retry = null, help = null, title = "SYSTEM ERROR" } = {}) {
    const message = err?.message || String(err || "Unknown error");
    console.error(`[AI VISION 4D] ${context}:`, err);
    this.lastError = { context, message, err };
    this.onRetry = retry;
    this.onHelp = help;

    if (this.titleEl) this.titleEl.textContent = title;
    if (this.textEl) {
      this.textEl.textContent = `${context}: ${message}`;
    }
    if (this.box) this.box.hidden = false;
    if (this.retryBtn) this.retryBtn.hidden = !retry;
    if (this.helpBtn) this.helpBtn.hidden = !help;
  }

  hide() {
    if (this.box) this.box.hidden = true;
    this.onRetry = null;
    this.onHelp = null;
  }

  wrap(fn, context) {
    return (...args) => {
      try {
        return fn(...args);
      } catch (e) {
        this.show(e, context);
      }
    };
  }
}
