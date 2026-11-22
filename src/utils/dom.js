// dom.js — tiny DOM helpers. No framework, no dependencies.

export function $(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing required element #${id}`);
  return el;
}

export function $$(sel, root = document) {
  return [...root.querySelectorAll(sel)];
}

export function on(el, event, fn, opts) {
  el.addEventListener(event, fn, opts);
  return () => el.removeEventListener(event, fn, opts);
}

export function esc(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

export function debounce(fn, ms) {
  let t = 0;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// rAF-throttled callback: fn receives the frame timestamp.
export function rafThrottle(fn) {
  let last = 0;
  let queued = false;
  return (now = 0) => {
    if (queued) return;
    if (now - last < 16) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      last = now;
      fn(now);
    });
  };
}
