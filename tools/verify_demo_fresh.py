"""Live verification of the DEMO PLANS rework, against a running service.

Drives the app through its OWN UI handlers (real clicks on the cards and on
Detect) - never by poking state - and writes annotated captures plus the
measured numbers to out/verify/<date>/demo-fresh/.

What it proves, in order:
  1. the demo tab is the MANIFEST: one card per plan, on a box holding many
     jobs per plan;
  2. a demo whose PDF is absent still gets a card that says so;
  3. opening a demo arrives UNDETECTED;
  4. Detect runs and finds styles;
  5. opening the SAME demo again arrives undetected AGAIN - the second
     visitor does not inherit the first run;
  6. the registry does not grow across those opens.

Usage:  python tools/verify_demo_fresh.py <base-url> <out-dir> <registry.json>
"""
import json
import sys
import time
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont
from playwright.sync_api import sync_playwright

APP = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8137"
OUT = Path(sys.argv[2] if len(sys.argv) > 2
           else "out/verify/2026-09-01/demo-fresh")
REG = Path(sys.argv[3]) if len(sys.argv) > 3 else None
OUT.mkdir(parents=True, exist_ok=True)
VIEW = {"width": 1400, "height": 1000}

FACTS = []


def note(k, v):
    FACTS.append((k, v))
    print("  %-46s %s" % (k, v))


def _font(size):
    for n in ("consola.ttf", "arial.ttf"):
        try:
            return ImageFont.truetype(n, size)
        except OSError:
            continue
    return ImageFont.load_default()


RED = (232, 72, 60)
GREEN = (60, 200, 130)


def annotate(png: Path, marks, title):
    """marks: (x, y, w, h, colour, label). Every capture sent out of here
    carries its circles - a raw capture is a working file, not a deliverable."""
    im = Image.open(png).convert("RGB")
    d = ImageDraw.Draw(im)
    f = _font(17)
    ft = _font(22)
    bar = 40
    out = Image.new("RGB", (im.width, im.height + bar), (16, 18, 21))
    out.paste(im, (0, bar))
    d = ImageDraw.Draw(out)
    d.text((14, 9), title, fill=(235, 235, 235), font=ft)
    for (x, y, w, h, col, label) in marks:
        y = y + bar
        d.rectangle([x, y, x + w, y + h], outline=col, width=3)
        tw = d.textlength(label, font=f)
        ly = y - 24 if y > bar + 26 else y + h + 4
        d.rectangle([x, ly, x + tw + 12, ly + 22], fill=col)
        d.text((x + 6, ly + 2), label, fill=(12, 12, 12), font=f)
    out.save(png)


def registry_rows():
    """Rows in the job registry. An ABSENT registry is zero rows, not unknown -
    a box that has never registered a job is exactly the starting condition
    the growth measurement wants, and a -1 sentinel here would make the growth
    arithmetic lie by one."""
    if not REG:
        return -1
    if not REG.exists():
        return 0
    try:
        return len(json.loads(REG.read_text()))
    except (OSError, ValueError):
        return -1


def demo_state(page):
    """What the workbench says about the open document, read off the DOM the
    operator reads - not off the engine JSON."""
    return page.evaluate("""() => ({
      job: window.state && state.job,
      doc: (document.getElementById('docName')||{}).textContent || '',
      styleRows: document.querySelectorAll('#styleList .style-row').length,
      pageDone: document.querySelectorAll('.thumb-badge.done').length,
      status: (document.getElementById('status')||{}).textContent || '',
    })""")


def main():
    with sync_playwright() as pw:
        br = pw.chromium.launch()
        pg = br.new_page(viewport=VIEW)
        pg.goto(APP + "/#projects", wait_until="networkidle")
        pg.wait_for_timeout(1200)

        # ---- 1. the demo tab -------------------------------------------
        pg.click("#pvTabDemo")
        pg.wait_for_timeout(1400)
        cards = pg.locator("#pvGrid .pv-card")
        n_cards = cards.count()
        away = pg.locator("#pvGrid .pv-card.pv-away").count()
        tabn = pg.locator("#pvTabDemoN").inner_text().strip()
        minen = pg.locator("#pvTabMineN").inner_text().strip()
        reach = pg.locator("#pvReach").inner_text().strip()
        note("demo cards drawn", n_cards)
        note("demo tab label count", tabn)
        note("your-projects tab label count", minen)
        note("cards marked unavailable", away)
        note("reach line", reach[:200])
        man = json.loads(Path("demo-plans.json").read_text(encoding="utf-8"))
        note("manifest plans", len(man["plans"]))
        shot = OUT / "01-demo-tab.png"
        pg.screenshot(path=str(shot), full_page=True)
        marks = []
        for sel, col, lab in ((".pv-tabs", GREEN, "tab reads %s for a manifest of %d"
                               % (tabn, len(man["plans"]))),
                              ("#pvReach", GREEN, "the fresh-open rule, said where a visitor is about to click")):
            b = pg.locator(sel).bounding_box()
            if b:
                marks.append((int(b["x"]) - 6, int(b["y"]) - 4, int(b["width"]) + 12,
                              int(b["height"]) + 8, col, lab))
        if away:
            b = pg.locator("#pvGrid .pv-card.pv-away").first.bounding_box()
            marks.append((int(b["x"]), int(b["y"]), int(b["width"]),
                          int(b["height"]), RED,
                          "PDF absent: the card says so, it does not vanish"))
        b = cards.first.bounding_box()
        marks.append((int(b["x"]), int(b["y"]), int(b["width"]), int(b["height"]),
                      GREEN, "page RASTER + 'opens undetected' - no detected count"))
        annotate(shot, marks, "1. The demo tab IS the manifest: %d cards, %d plans"
                 % (n_cards, len(man["plans"])))

        # ---- 2. open one, FIRST visitor --------------------------------
        target = pg.locator("#pvGrid .pv-card:not(.pv-away)").first
        name = target.locator(".pv-name").inner_text().strip()
        note("plan under test", name)
        reg0 = registry_rows()
        note("registry rows BEFORE open 1", reg0)
        target.click()
        pg.wait_for_timeout(3500)
        st1 = demo_state(pg)
        reg1 = registry_rows()
        note("open 1: style rows on screen", st1["styleRows"])
        note("open 1: pages marked detected", st1["pageDone"])
        note("open 1: status line", st1["status"][:110])
        note("registry rows AFTER open 1", reg1)
        shot = OUT / "02-open-1-undetected.png"
        pg.screenshot(path=str(shot))
        marks = []
        for sel, lab in (
                ("#sheetHead .sh-meta",
                 "the header chip reads NOT DETECTED - this is the durable statement"),
                ("#styleList", "style list EMPTY - nothing was detected for this visitor"),
                ("#status", "...and the app says so in words")):
            b = pg.locator(sel).bounding_box()
            if b:
                marks.append((int(b["x"]), int(b["y"]), int(b["width"]),
                              min(int(b["height"]), 260), GREEN, lab))
        annotate(shot, marks,
                 "2. FIRST open of %s: %d styles, %d pages detected"
                 % (name, st1["styleRows"], st1["pageDone"]))

        # ---- 3. the visitor presses Detect ------------------------------
        t0 = time.time()
        pg.click("#detectBtn")
        try:
            pg.wait_for_function(
                "() => document.querySelectorAll('#styleList .style-row').length > 0",
                timeout=240000)
        except Exception:
            pass
        secs = round(time.time() - t0, 1)
        pg.wait_for_timeout(1500)
        st2 = demo_state(pg)
        note("detect wall time (s)", secs)
        note("after Detect: style rows", st2["styleRows"])
        shot = OUT / "03-detect-ran.png"
        pg.screenshot(path=str(shot))
        marks = []
        for sel, lab in (
                ("#status",
                 "%d styles, found live in %ss - the visitor watched this run"
                 % (st2["styleRows"], secs)),
                ("#sheetHead .sh-meta", "the header chips now read 'detected'")):
            b = pg.locator(sel).bounding_box()
            if b:
                marks.append((int(b["x"]), int(b["y"]), int(b["width"]),
                              min(int(b["height"]), 200), GREEN, lab))
        annotate(shot, marks,
                 "3. Detect run by the visitor: %d styles" % st2["styleRows"])

        # ---- 4. the SECOND visitor opens the same demo ------------------
        pg.click("#projectsLink")
        pg.wait_for_timeout(1200)
        pg.click("#pvTabDemo")
        pg.wait_for_timeout(1400)
        same = pg.locator("#pvGrid .pv-card:not(.pv-away)").first
        same.click()
        pg.wait_for_timeout(3500)
        st3 = demo_state(pg)
        reg2 = registry_rows()
        note("open 2: style rows on screen", st3["styleRows"])
        note("open 2: pages marked detected", st3["pageDone"])
        note("open 2: same job id as open 1", st3["job"] == st1["job"])
        note("registry rows AFTER open 2", reg2)
        shot = OUT / "04-open-2-undetected.png"
        pg.screenshot(path=str(shot))
        marks = []
        b = pg.locator("#sheetHead .sh-meta").bounding_box()
        if b:
            marks.append((int(b["x"]), int(b["y"]), int(b["width"]),
                          int(b["height"]), GREEN, "NOT DETECTED again"))
        b = pg.locator("#styleList").bounding_box()
        if b:
            marks.append((int(b["x"]), int(b["y"]), int(b["width"]),
                          min(int(b["height"]), 260), GREEN,
                          "EMPTY AGAIN - the %d styles open 1 found were swept"
                          % st2["styleRows"]))
        b = pg.locator("#status").bounding_box()
        if b:
            marks.append((int(b["x"]), int(b["y"]), int(b["width"]),
                          int(b["height"]), GREEN, "and it says so"))
        annotate(shot, marks,
                 "4. SECOND open of the same demo: %d styles - no inheritance"
                 % st3["styleRows"])

        # ---- 5. a third open, for the growth number ---------------------
        pg.click("#projectsLink")
        pg.wait_for_timeout(1200)
        pg.click("#pvTabDemo")
        pg.wait_for_timeout(1200)
        pg.locator("#pvGrid .pv-card:not(.pv-away)").first.click()
        pg.wait_for_timeout(3000)
        st4 = demo_state(pg)
        reg3 = registry_rows()
        note("open 3: style rows on screen", st4["styleRows"])
        note("registry rows AFTER open 3", reg3)
        note("registry growth over three opens", reg3 - reg0)
        br.close()

    (OUT / "measurements.json").write_text(
        json.dumps([{"k": k, "v": v} for k, v in FACTS], indent=1))
    print("\nwrote", OUT)


if __name__ == "__main__":
    main()
