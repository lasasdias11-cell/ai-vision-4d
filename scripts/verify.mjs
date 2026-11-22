#!/usr/bin/env node
// verify.mjs — static verification for AI VISION 4D.
//  1. Required file tree exists exactly as specified.
//  2. Every bare/CDN import resolves to a pinned version.
//  3. No banned tokens (TODO, FIXME, placeholder, mock, fake, coming soon,
//     API_KEY_HERE) in source files.
// Exit code 0 = pass, 1 = fail.

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;

function fail(msg) {
  failures++;
  console.error(`FAIL  ${msg}`);
}
function ok(msg) {
  console.log(`  ok  ${msg}`);
}

// ---------- 1. file tree -------------------------------------------------

const REQUIRED = [
  "index.html",
  "README.md",
  "styles/base.css",
  "styles/boot.css",
  "styles/hud.css",
  "styles/settings.css",
  "styles/guide.css",
  "styles/overlays.css",
  "styles/responsive.css",
  "src/app.js",
  "src/config.js",
  "src/utils/math.js",
  "src/utils/dom.js",
  "src/utils/storage.js",
  "src/utils/errors.js",
  "src/utils/permissions.js",
  "src/core/camera.js",
  "src/core/vision.js",
  "src/core/tracking.js",
  "src/interaction/gestures.js",
  "src/interaction/air-draw.js",
  "src/interaction/cursor.js",
  "src/render/scene.js",
  "src/render/objects.js",
  "src/render/physics.js",
  "src/render/particles.js",
  "src/render/fourd.js",
  "src/render/overlay.js",
  "src/ui/boot.js",
  "src/ui/hud.js",
  "src/ui/settings.js",
  "src/ui/dock.js",
  "src/ui/gesture-guide.js",
  "scripts/verify.mjs",
];

console.log("== file tree ==");
for (const f of REQUIRED) {
  if (existsSync(join(ROOT, f))) ok(f);
  else fail(`missing required file: ${f}`);
}

// ---------- 2. pinned imports --------------------------------------------

const PINNED = [
  [/three@0\.185\.0/, "three@0.185.0"],
  [/tasks-vision@0\.10\.21/, "@mediapipe/tasks-vision@0.10.21"],
];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(js|mjs|html)$/.test(name)) out.push(p);
  }
  return out;
}

console.log("== imports ==");
const files = walk(ROOT).filter((f) => !f.includes(`${"node_modules"}`));
const importRe = /(?:import|export)[^'"]*from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

const seenExternal = new Set();
for (const file of files) {
  const src = readFileSync(file, "utf8");
  let m;
  while ((m = importRe.exec(src))) {
    const spec = m[1] || m[2];
    if (!spec) continue;
    if (spec.startsWith(".")) continue; // local module
    if (spec === "three" || spec === "@mediapipe/tasks-vision") {
      // bare specifier — resolved via importmap; verify the map pins it.
      const html = readFileSync(join(ROOT, "index.html"), "utf8");
      const mapMatch = html.match(new RegExp(`"${spec.replace("/", "\\/")}"\\s*:\\s*"([^"]+)"`));
      if (!mapMatch) {
        fail(`${file}: bare import "${spec}" missing from importmap`);
      } else {
        seenExternal.add(spec);
        for (const [re, label] of PINNED) {
          if (re.test(spec) || re.test(mapMatch[1])) ok(`${spec} → ${mapMatch[1]}`);
          else if (spec.includes("three") && !/three@0\.185\.0/.test(mapMatch[1])) {
            fail(`${file}: three importmap is not pinned to 0.185.0 (${mapMatch[1]})`);
          } else if (spec.includes("tasks-vision") && !/tasks-vision@0\.10\.21/.test(mapMatch[1])) {
            fail(`${file}: tasks-vision importmap is not pinned to 0.10.21 (${mapMatch[1]})`);
          }
        }
      }
      continue;
    }
    // absolute URL — must be a pinned CDN URL
    seenExternal.add(spec);
    let pinned = false;
    for (const [re] of PINNED) if (re.test(spec)) pinned = true;
    if (!pinned) {
      // allow storage.googleapis.com model URLs (versioned by path, pinned in config)
      if (spec.startsWith("https://storage.googleapis.com/mediapipe-models/")) {
        ok(`model asset ${spec.slice(0, 80)}…`);
      } else {
        fail(`${file}: unpinned external import "${spec}"`);
      }
    } else {
      ok(spec);
    }
  }
}

// ---------- 3. banned tokens ------------------------------------------------

console.log("== banned tokens ==");
const BANNED = /\b(TODO|FIXME|placeholder|mock|fake|coming soon|API_KEY_HERE)\b/i;
const SKIP_DIRS = /node_modules|\.git/;
let bannedHits = 0;
for (const file of files) {
  if (SKIP_DIRS.test(file)) continue;
  // This script necessarily names the tokens it checks.
  if (file.endsWith("verify.mjs")) continue;
  const src = readFileSync(file, "utf8");
  const lines = src.split("\n");
  lines.forEach((line, i) => {
    if (BANNED.test(line)) {
      bannedHits++;
      fail(`${file}:${i + 1}: banned token → ${line.trim().slice(0, 90)}`);
    }
  });
}
if (!bannedHits) ok("no banned tokens in source files");

// ---------- selector sanity -------------------------------------------------

console.log("== dom ids ==");
const html = readFileSync(join(ROOT, "index.html"), "utf8");
const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
const idRefs = new Set();
for (const file of files.filter((f) => f.endsWith(".js"))) {
  const src = readFileSync(file, "utf8");
  for (const m of src.matchAll(/\$\(\s*["'`]([A-Za-z0-9_-]+)["'`]\s*\)/g)) idRefs.add(m[1]);
  for (const m of src.matchAll(/getElementById\(\s*["'`]([A-Za-z0-9_-]+)["'`]\s*\)/g)) idRefs.add(m[1]);
}
for (const id of idRefs) {
  if (!htmlIds.has(id)) fail(`JS references missing #${id}`);
  else ok(`#${id}`);
}

// ---------- circular import sanity (static) ---------------------------------

console.log("== import graph ==");
const graph = new Map();
for (const file of files.filter((f) => f.endsWith(".js"))) {
  const src = readFileSync(file, "utf8");
  const deps = [];
  for (const m of src.matchAll(/from\s+["'](\.[^"']+)["']/g)) {
    deps.push(join(dirname(file), m[1]));
  }
  graph.set(file, deps);
}
function hasCycle(node, seen = new Set(), stack = new Set()) {
  if (stack.has(node)) return true;
  if (seen.has(node)) return false;
  seen.add(node);
  stack.add(node);
  for (const d of graph.get(node) || []) {
    const resolved = d.endsWith(".js") ? d : d + ".js";
    if (graph.has(resolved) && hasCycle(resolved, seen, stack)) return true;
  }
  stack.delete(node);
  return false;
}
let cyclic = false;
for (const node of graph.keys()) {
  if (hasCycle(node)) { cyclic = true; fail(`circular import involving ${node}`); }
}
if (!cyclic) ok("no circular imports detected");

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL CHECKS PASSED");
process.exit(failures ? 1 : 0);
