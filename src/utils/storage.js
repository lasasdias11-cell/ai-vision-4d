// storage.js — typed localStorage wrapper. All keys are prefixed aiv4d_.
// Only non-sensitive UI settings are ever persisted (see README privacy note).

import { STORAGE_KEYS, DEFAULTS, VERSION } from "../config.js";

const PREFIX = "aiv4d_";

export class StorageManager {
  constructor(storage = globalThis.localStorage) {
    this.store = storage;
    this.available = (() => {
      try {
        const k = PREFIX + "__probe__";
        this.store.setItem(k, "1");
        this.store.removeItem(k);
        return true;
      } catch {
        return false;
      }
    })();
  }

  #key(k) {
    return PREFIX + k;
  }

  raw(key) {
    try {
      return this.store.getItem(this.#key(key));
    } catch {
      return null;
    }
  }

  getJSON(key, fallback = null) {
    try {
      const raw = this.raw(key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  }

  setJSON(key, value) {
    if (!this.available) return false;
    try {
      this.store.setItem(this.#key(key), JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  }

  getBool(key, fallback) {
    const v = this.getJSON(key, fallback);
    return typeof v === "boolean" ? v : fallback;
  }

  getNum(key, fallback) {
    const v = this.getJSON(key, fallback);
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

  getStr(key, fallback) {
    const v = this.getJSON(key, fallback);
    return typeof v === "string" ? v : fallback;
  }

  remove(key) {
    try {
      this.store.removeItem(this.#key(key));
    } catch { /* storage unavailable */ }
  }

  // ---- settings blob -------------------------------------------------

  // Merge persisted settings over DEFAULTS. Called once before first frame
  // so every engine initializes with restored state (defect D12).
  loadSettings() {
    const saved = this.getJSON(STORAGE_KEYS.settings, {}) || {};
    const out = { ...DEFAULTS };
    for (const k of Object.keys(DEFAULTS)) {
      if (saved[k] !== undefined) out[k] = saved[k];
    }
    return out;
  }

  saveSettings(settings) {
    const clean = {};
    for (const k of Object.keys(DEFAULTS)) {
      if (settings[k] !== undefined) clean[k] = settings[k];
    }
    this.setJSON(STORAGE_KEYS.settings, clean);
  }

  get guideSeen() {
    return this.getBool(STORAGE_KEYS.guideSeen, false);
  }

  set guideSeen(v) {
    this.setJSON(STORAGE_KEYS.guideSeen, !!v);
  }

  // Bump the stored schema version; callers may wipe settings on mismatch.
  get dataVersion() {
    return this.getNum(STORAGE_KEYS.version, 0);
  }

  set dataVersion(v) {
    this.setJSON(STORAGE_KEYS.version, v);
  }

  static get appVersion() {
    return VERSION;
  }
}
