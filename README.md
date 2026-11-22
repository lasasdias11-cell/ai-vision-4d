# AI VISION 4D

A real-time browser spatial interface. Your webcam feeds **MediaPipe** hand and
face landmark inference, a **Three.js** scene renders what your hands do in
3D, and a 4D tesseract reacts to two-hand gestures — all locally, in the page.

No build step. No server. No accounts. Open `index.html` and grant camera
access.

## Run it

```bash
# any static file server works — ES modules require http(s), not file://
python -m http.server 8080
# then open http://localhost:8080
```

Or push to GitHub Pages and open the Pages URL (HTTPS satisfies the secure
-context requirement).

> `file://` will **not** work: `getUserMedia` and ES modules both require a
> secure context (`https:` or `localhost`).

## Browser support

| Browser            | Status   | Notes                                        |
|--------------------|----------|----------------------------------------------|
| Chrome / Edge 120+ | Supported| Best path; `permissions.query('camera')` used |
| Safari 17+         | Supported| Camera works; permission probe is optimistic  |
| Firefox 120+       | Supported| Same optimistic permission path               |
| Mobile Chrome/Safari | Partial | Touch viewports work; small screens hide HUD chips |

Requirements: WebGL2, `getUserMedia`, ES modules, `importmap`.

## Gestures

All gestures classify with confidence + hysteresis + per-gesture cooldowns.
The **GESTURE CONFIDENCE** slider gates both the raw classification and the
hysteresis commit.

| Gesture      | Rule                                                        | Action                          |
|--------------|-------------------------------------------------------------|---------------------------------|
| POINT        | index extended, middle/ring/pinky folded                    | move cursor, hover-select       |
| PINCH        | `dist(thumb,index) / dist(wrist,middle_mcp) < 0.40`         | grab nearest object / 4D cube   |
| PINCH-HOLD   | pinch held > 120 ms                                         | locks the grab                  |
| PINCH-DRAG   | grabbed + fingertip motion                                  | object follows fingertip        |
| PINCH-RELEASE| pinch ends                                                  | drop; inherits throw velocity   |
| OPEN PALM    | all four fingers extended                                   | deselect + clear air path       |
| FIST         | zero fingers extended                                       | cancel grab, close panels       |
| PEACE        | index + middle only                                         | cycle mode: Select → Draw → 4D  |
| THUMBS UP    | thumb extended, fingers folded                              | confirm mode action (spawn)     |
| SWIPE L / R  | palm crosses >18% width in 400 ms                           | previous / next mode            |
| SWIPE U / D  | palm crosses >18% height in 400 ms                          | camera zoom in / out            |

### Two hands

| Gesture | Effect                                                        |
|---------|---------------------------------------------------------------|
| Scale   | wrist-to-wrist distance ratio → object scale (or 4D / FOV)     |
| Rotate  | hand-orientation difference → `rotation.y` / 4D XW plane       |
| Pan     | both wrists translate → grabbed object or 4D group position    |
| Zoom    | same scale signal → camera FOV when nothing is grabbed         |

Two-hand transforms route to the **currently grabbed target, else the 4D
cube** — never both.

### Air drawing (DRAW mode)

While POINT is active a path is recorded (max 90 decimated samples). A shape
fires only after a **closed loop + minimum area + 700 ms dwell** with a
visible progress ring, then a **2 s cooldown**.

| Shape    | Spawns                                              |
|----------|-----------------------------------------------------|
| CIRCLE   | Sphere                                              |
| SQUARE   | Cube                                                |
| TRIANGLE | 3-sided cylinder                                    |
| RECTANGLE| Cube (wide)                                         |
| LINE     | Cylinder beam                                       |
| ZIGZAG   | Torus                                               |
| SHAPE    | Icosahedron (fallback)                              |

## Keyboard

| Key    | Action                    |
|--------|---------------------------|
| `G`    | toggle Gesture Guide      |
| `S`    | toggle Settings           |
| `F`    | fullscreen                |
| `C`    | start / stop camera       |
| Space  | pause / resume scene      |
| Esc    | close panels / modals     |

## Architecture

```
index.html          markup only + importmap
styles/             base · boot · hud · settings · guide · overlays · responsive
src/
  app.js            App class, engine singletons, guarded rAF loop
  config.js         frozen DEFAULTS, STORAGE_KEYS, VERSION, CDN pins
  utils/            math · dom · storage · errors · permissions
  core/             camera · vision · tracking
  interaction/      gestures · air-draw · cursor
  render/           scene · objects · physics · particles · fourd · overlay
  ui/               boot · hud · settings · dock · gesture-guide
scripts/verify.mjs  static verification (tree, pins, banned tokens)
```

Key correctness points:

- The webcam `<video>` is CSS-mirrored; landmark `x` is flipped **once** inside
  `VisionManager.update()` so every downstream consumer sees screen space.
- Finger extension uses a two-signal test (tip-vs-wrist distance AND joint
  angle), fixing V3's inverted bend test.
- Hand inference runs at the configured rate (~30 Hz); face inference runs
  every 3rd hand tick (~10 Hz).
- The tesseract is one `THREE.LineSegments` with a single `BufferGeometry`;
  `update()` allocates nothing.
- Particles rebuild disposes old geometry/material and the slider is debounced
  150 ms.
- Wireframe is a scene-level flag applied to every new spawn.
- All settings persist to `localStorage` under `aiv4d_` and are restored
  before the first frame.

## Privacy

Camera frames are processed **locally only**. Nothing is uploaded, recorded,
or transmitted. No biometric data leaves the device — MediaPipe runs in-page
against the local video element. Only non-sensitive UI preferences are stored
in `localStorage` under the `aiv4d_` prefix.

## Known limitations

- **Depth is estimated, not measured.** A single webcam gives 2D landmarks;
  `z` values are weak monocular estimates. "3D" interactions are really
  screen-space mapped onto a scene plane — pinch depth does not exist.
- **Thumb reads are unreliable** in monocular inference; OPEN PALM keys on the
  four fingers and THUMBS UP uses a lenient thumb test.
- **Face overlay is cosmetic** — face inference is decimated to ~10 Hz and a
  face-model failure degrades gracefully (HUD shows `ACTIVE*`) rather than
  blocking the app.
- **Hand occlusion** (two hands overlapping, hand leaving frame) drops
  landmarks for those frames; hysteresis smooths but cannot invent data.
- **CPU delegate only** — GPU delegate was intentionally not attempted.
- Air-shape classification is heuristic (corners + aspect + closure); very
  sloppy circles may classify as generic SHAPE.

## Milestones

- [x] **Drop A — Correctness**: multi-file module architecture, mirrored
  skeleton alignment, POINT/PINCH/PEACE/OPEN PALM/FIST classification with
  hysteresis + threshold gating, WebGL fallback, single guarded rAF loop,
  staggered inference, camera restart without loop restart, camera-lost
  recovery, inline-SVG icons.
- [x] **Drop B — Performance & settings**: particle field (rebuild-safe,
  debounced), full object system + physics, persisted settings restored
  pre-frame, reduced-motion class, scene-level wireframe, two-hand routing.
- [x] **Drop C — Guide + air draw + polish**: animated GestureGuide modal
  (shared skeleton renderer, live confidence mirror), dwell-gated air-shape
  spawning, keyboard shortcuts, HUD gesture legend.

## Verification

```bash
node scripts/verify.mjs   # tree, pinned imports, banned-token scan
```

`verify.mjs` checks the required file tree, that every CDN import is the
pinned version, and that no source file contains unfinished-work markers.
A Playwright smoke test can load the page over `http://localhost` — headless
Chromium can be launched with its synthetic-media-stream switches (see the
Playwright docs) **for CI pipeline verification only**; that path exercises
plumbing, not real gesture recognition.
