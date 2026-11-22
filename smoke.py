# CI-only smoke test: drives system Edge via Playwright with SYNTHETIC media
# flags (--use-fake-ui-for-media-stream --use-fake-device-for-media-stream).
# This exercises the boot + pipeline plumbing only — it is NOT gesture
# verification. Real gesture checks require a physical webcam.
import sys, time
from playwright.sync_api import sync_playwright

URL = "http://127.0.0.1:8931/"
errors = []

with sync_playwright() as p:
    browser = p.chromium.launch(
        channel="msedge",
        headless=True,
        args=[
            "--use-fake-ui-for-media-stream",
            "--use-fake-device-for-media-stream",
            "--autoplay-policy=no-user-gesture-required",
        ],
    )
    page = browser.new_page(viewport={"width": 1400, "height": 900})
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append(str(e)))

    page.goto(URL, wait_until="domcontentloaded")

    # Wait for SYSTEM READY (real model downloads — allow generous time).
    page.wait_for_function(
        "document.getElementById('bootStatus').textContent.includes('SYSTEM READY')",
        timeout=180_000,
    )
    print("BOOT: reached SYSTEM READY")
    page.screenshot(path="smoke_boot.png")

    # Enable camera (fake device in CI).
    page.click("#enable")
    page.wait_for_function(
        "document.getElementById('boot').hidden === true || getComputedStyle(document.getElementById('boot')).display === 'none'",
        timeout=30_000,
    )
    print("CAMERA: started, boot dismissed")

    # Let the loop run ~5 s with the synthetic feed, then inspect HUD.
    page.wait_for_timeout(5000)
    hud = page.evaluate("""() => ({
        camera: document.getElementById('sCamera').textContent,
        vision: document.getElementById('sVision').textContent,
        fps: document.getElementById('sFPS').textContent,
        renderer: document.getElementById('sRenderer').textContent,
        gesture: document.getElementById('sGesture').textContent,
        hands: document.getElementById('sHands').textContent,
        debug: document.getElementById('debug').textContent.slice(0, 400),
    })""")
    print("HUD:", hud)
    page.screenshot(path="smoke_live.png")

    # Open the gesture guide (G key path) and verify cards rendered.
    page.keyboard.press("g")
    page.wait_for_timeout(800)
    cards = page.eval_on_selector_all(".guide-card", "els => els.length")
    print("GUIDE: cards =", cards)
    page.screenshot(path="smoke_guide.png")
    page.keyboard.press("Escape")

    # Settings panel contains the air-draw spawning toggle; verify persistence.
    toggle = page.evaluate("""() => {
        const el = document.getElementById('airSpawnToggle');
        if (!el) return null;
        el.click();
        const v1 = localStorage.getItem('aiv4d_airSpawn');
        return { found: true, stored: v1 };
    }""")
    print("AIRSPAWN TOGGLE:", toggle)
    page.reload(wait_until="domcontentloaded")
    persisted = page.evaluate("localStorage.getItem('aiv4d_airSpawn')")
    print("AIRSPAWN PERSISTED:", persisted)

    real_errors = [e for e in errors if "ERR_" not in e and "GPU" not in e.upper() and "INFO:" not in e and "404" not in e]
    print("CONSOLE ERRORS:", real_errors if real_errors else "none")
    browser.close()

    ok = (
        hud["camera"] == "CONNECTED"
        and hud["vision"] in ("ACTIVE", "ACTIVE*")
        and int(hud["fps"] or 0) > 0
        and cards == 7
        and not real_errors
    )
    print("SMOKE:", "PASS" if ok else "CHECK MANUALLY")
    sys.exit(0 if ok else 1)
