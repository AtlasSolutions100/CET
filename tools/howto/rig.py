"""Recording rig for the CORE Takeoff how-to series.

Drives the live dev app (:8128) in Playwright Chromium with native video
recording. A fake cursor (real OS cursors don't render in these videos) and
an on-page caption bar are injected, so captions are burned in perfectly
synced during the take - no subtitle timing work in the edit. Cut points
(dead waits like Detect) are logged as wall-clock marks and removed by
edit.py afterwards.

Honesty rules for these videos (the demo-integrity contract):
  - the app is driven through its own UI handlers only (real mouse events);
  - waits that get cut are SAID on screen ("about a minute - cut for time");
  - nothing is pre-labeled or staged beyond using already-detected sheets,
    and captions say when a sheet was detected earlier.
"""
import json
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

APP = "http://localhost:8128"
VIEW = {"width": 1600, "height": 900}

INIT_JS = """
(() => {
  const mk = () => {
    if (document.getElementById('rig-cursor')) return;
    const c = document.createElement('div');
    c.id = 'rig-cursor';
    c.style.cssText = 'position:fixed;left:-40px;top:-40px;width:18px;height:18px;'
      + 'border:2.5px solid #fff;border-radius:50%;background:rgba(20,20,20,.45);'
      + 'box-shadow:0 0 6px rgba(0,0,0,.6);z-index:2147483647;pointer-events:none;'
      + 'transform:translate(-50%,-50%);';
    document.body.appendChild(c);
    const cap = document.createElement('div');
    cap.id = 'rig-cap';
    cap.style.cssText = 'position:fixed;left:50%;bottom:30px;transform:translateX(-50%);'
      + 'max-width:1150px;padding:11px 20px;border-radius:10px;'
      + 'background:rgba(10,12,15,.85);color:#fff;'
      + 'font:600 21px/1.4 "Segoe UI",system-ui,sans-serif;'
      + 'z-index:2147483646;pointer-events:none;opacity:0;transition:opacity .25s;'
      + 'text-align:center;letter-spacing:.01em;';
    document.body.appendChild(cap);
    document.addEventListener('mousemove', e => {
      c.style.left = e.clientX + 'px'; c.style.top = e.clientY + 'px';
    }, true);
    document.addEventListener('mousedown', e => {
      const r = document.createElement('div');
      r.style.cssText = 'position:fixed;left:' + e.clientX + 'px;top:' + e.clientY
        + 'px;width:10px;height:10px;border:2.5px solid #4dd0e1;border-radius:50%;'
        + 'z-index:2147483647;pointer-events:none;transform:translate(-50%,-50%);'
        + 'transition:all .45s ease-out;opacity:1;';
      document.body.appendChild(r);
      requestAnimationFrame(() => {
        r.style.width = '46px'; r.style.height = '46px'; r.style.opacity = '0';
      });
      setTimeout(() => r.remove(), 500);
    }, true);
  };
  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', mk);
  else mk();
})();
"""


class Take:
    def __init__(self, name, out_dir):
        self.name = name
        self.out = Path(out_dir)
        self.out.mkdir(parents=True, exist_ok=True)
        self.marks = []
        self._pw = sync_playwright().start()
        self._browser = self._pw.chromium.launch()
        self._ctx = self._browser.new_context(
            viewport=VIEW, record_video_dir=str(self.out),
            record_video_size=VIEW)
        self._ctx.add_init_script(INIT_JS)
        self.page = self._ctx.new_page()
        self.t0 = time.time()
        self.page.goto(APP)
        self.page.wait_for_load_state("networkidle")

    # ---- time marks for the edit ------------------------------------
    def t(self):
        return round(time.time() - self.t0, 2)

    def mark(self, kind):
        self.marks.append({"kind": kind, "t": self.t()})

    # ---- presentation -----------------------------------------------
    def cap(self, text, hold=3.4):
        self.page.evaluate(
            "t => { const c = document.getElementById('rig-cap');"
            " c.textContent = t; c.style.opacity = t ? '1' : '0'; }", text)
        if hold:
            self.page.wait_for_timeout(int(hold * 1000))

    def cap_off(self):
        self.cap("", hold=0.3)

    # ---- motion -------------------------------------------------------
    def glide(self, x, y, ms=550):
        self.page.mouse.move(x, y, steps=max(12, int(ms / 18)))
        self.page.wait_for_timeout(120)

    def click_xy(self, x, y, ms=550):
        self.glide(x, y, ms)
        self.page.mouse.down()
        self.page.wait_for_timeout(90)
        self.page.mouse.up()
        self.page.wait_for_timeout(250)

    def el_center(self, sel):
        b = self.page.locator(sel).first.bounding_box()
        if not b:
            raise RuntimeError(f"no box for {sel}")
        return b["x"] + b["width"] / 2, b["y"] + b["height"] / 2

    def click(self, sel, ms=550):
        x, y = self.el_center(sel)
        self.click_xy(x, y, ms)

    def hover(self, sel_or_xy, ms=550):
        if isinstance(sel_or_xy, str):
            x, y = self.el_center(sel_or_xy)
        else:
            x, y = sel_or_xy
        self.glide(x, y, ms)

    def drag(self, x0, y0, x1, y1, ms=900):
        self.glide(x0, y0, 450)
        self.page.mouse.down()
        self.page.mouse.move(x1, y1, steps=max(20, int(ms / 16)))
        self.page.wait_for_timeout(120)
        self.page.mouse.up()
        self.page.wait_for_timeout(250)

    def type_in(self, sel, text, delay=14):
        self.click(sel)
        self.page.keyboard.type(text, delay=delay)

    def scroll_into(self, sel):
        self.page.evaluate(
            "s => document.querySelector(s).scrollIntoView({block:'center'})", sel)
        self.page.wait_for_timeout(400)

    # ---- app-space mapping ---------------------------------------------
    def pt2screen(self, px, py):
        """Page-pt -> client px via the app's own live view transform."""
        return self.page.evaluate(
            """([px, py]) => {
              const cv = document.querySelector('#view');
              const r = cv.getBoundingClientRect();
              const f = (typeof IMG_DPI !== 'undefined' ? IMG_DPI : 130) / 72;
              const v = state.view;
              return [ r.left + (px * f * v.k + v.x) * (r.width / cv.width),
                       r.top  + (py * f * v.k + v.y) * (r.height / cv.height) ];
            }""", [px, py])

    def wait_js(self, expr, timeout=180000):
        self.page.wait_for_function(expr, timeout=timeout)

    # ---- lifecycle -----------------------------------------------------
    def finish(self):
        self.page.wait_for_timeout(600)
        video = self.page.video
        self._ctx.close()
        path = video.path()
        self._browser.close()
        self._pw.stop()
        mk = self.out / f"{self.name}.marks.json"
        mk.write_text(json.dumps({"marks": self.marks}, indent=1))
        dst = self.out / f"{self.name}.webm"
        Path(path).replace(dst)
        return str(dst), str(mk)

    def crash_shot(self):
        try:
            self.page.screenshot(path=str(self.out / f"{self.name}.crash.png"))
        except Exception:
            pass
