"""V6 - The Liberty Park session, on camera: app vs hand estimate.

Re-performs the live operator session that produced Rev 1 of the bid:
scale doubts typed, playground traced (app computes SF/LF), the family
table corrections (sewer 205 vs hand 60; demo hatch planimetry), export.
Captions carry the hand-vs-app scoreboard throughout.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from rig import Take

PDF = (r"C:\Users\kobys\OneDrive\Desktop\past\P\Takeoff Automation"
       r"\client_meet\beaumont\stice.pdf")

RING = [[666.3,478.5],[658.5,722.8],[680.7,625.3],[679.0,723.3],[739.4,727.2],
        [658.0,758.8],[657.4,857.4],[727.8,823.0],[733.8,865.7],[944.3,870.6],
        [1051.8,952.1],[1412.3,970.9],[1556.3,1127.1],[1640.5,1129.3],
        [1611.1,1060.6],[1644.4,1131.5],[1762.9,1099.9],[1774.5,848.5],
        [1707.5,788.7],[1220.7,696.2],[1102.2,480.7]]

t = Take("v6_liberty", Path(__file__).parent / "raw")
p = t.page


def type_scale(val, capline):
    b = p.evaluate("""() => { const b = [...document.querySelectorAll(
        '#sheetHead button')].find(x => /type the scale/.test(x.textContent));
        if (!b) return null; const r = b.getBoundingClientRect();
        return [r.x + r.width/2, r.y + r.height/2]; }""")
    if not b:
        t.cap("Scale already on record from the working session - the app "
              "remembered the typed value.", 3.2)
        return
    t.click_xy(b[0], b[1])
    p.wait_for_timeout(400)
    inp = p.locator("#sheetHead input").first
    bb = inp.bounding_box()
    t.click_xy(bb["x"] + bb["width"]/2, bb["y"] + bb["height"]/2, 350)
    p.keyboard.type(str(val), delay=110)
    p.keyboard.press("Enter")
    p.wait_for_timeout(700)
    t.cap(capline, 4.0)


def goto(page_no, wait=4000):
    p.select_option("#pageSel", value=str(page_no))
    p.wait_for_timeout(wait)


def canvas_click(px, py, settle=140):
    s = t.pt2screen(px, py)
    t.glide(s[0], s[1], 200)
    p.evaluate("""([x, y]) => { const cv = document.querySelector('#view');
      for (const ty of ['mousedown','mouseup','click'])
        cv.dispatchEvent(new MouseEvent(ty, {bubbles:true, clientX:x,
          clientY:y, button:0})); }""", [s[0], s[1]])
    p.wait_for_timeout(settle)


try:
    t.cap("Yesterday: a full hand estimate of this park bid. Today: the "
          "same takeoff through CORE Takeoff, like an operator - and the "
          "two check each other.", 5.0)

    t.type_in("#pathInput", PDF, delay=6)
    ob = p.locator("button", has_text="Open").first
    b = ob.bounding_box()
    t.click_xy(b["x"] + b["width"]/2, b["y"] + b["height"]/2)
    t.wait_js("() => state.job && state.kinds && state.kinds.length > 0")
    p.wait_for_timeout(1500)
    t.cap("Liberty Park Renovation - Boise Parks & Rec. Twenty sheets.", 3.0)

    # ---- L5.4: scale doubt + the trace --------------------------------
    goto(15)
    t.wait_js("() => state.result && state.result.engine_sig", timeout=120000)
    p.wait_for_timeout(1000)
    t.cap("The layout sheet. The chip knows which drawing this is - and "
          "says NO SCALE: this sheet only has a graphic bar, and honest "
          "beats guessed.", 4.6)
    type_scale(10, "The operator types it - the bar reads 0-5-10-20, so "
               "1 inch = 10 feet - and the chip stamps it SET BY HAND. "
               "Provenance on its face.")

    t.click("#stBtn")
    p.wait_for_timeout(600)
    db = p.evaluate("""() => { const b = [...document.querySelectorAll(
        '#stPanel button')].find(x => /Draw outline/i.test(x.textContent));
        const r = b.getBoundingClientRect();
        return [r.x + r.width/2, r.y + r.height/2]; }""")
    t.click_xy(db[0], db[1])
    t.cap("Now the playground: trace the curb ring, corner by corner - "
          "the app does the math live.", 3.2)
    for px, py in RING:
        canvas_click(px, py)
    p.keyboard.press("Enter")
    p.wait_for_timeout(800)
    st1 = p.evaluate("document.querySelector('#status').textContent")
    if "corner" in st1:
        p.evaluate("""() => document.querySelector('#view')
            .dispatchEvent(new MouseEvent('dblclick', {bubbles:true}))""")
        p.wait_for_timeout(800)
    t.cap("Closed: 7,376 SF, 500 LF of curb. The hand planimeter said "
          "7,416 SF - half a percent apart, two independent methods.", 4.8)

    nums = p.locator("#stPanel input[type=number]")
    bb = nums.nth(0).bounding_box()
    t.click_xy(bb["x"] + bb["width"]/2, bb["y"] + bb["height"]/2, 300)
    p.keyboard.press("Control+a"); p.keyboard.type("0.57", delay=90)
    bb = nums.nth(1).bounding_box()
    t.click_xy(bb["x"] + bb["width"]/2, bb["y"] + bb["height"]/2, 300)
    p.keyboard.press("Control+a"); p.keyboard.type("0", delay=90)
    p.wait_for_timeout(300)
    ab = p.evaluate("""() => { const b = [...document.querySelectorAll(
        '#stPanel button')].find(x => /add to takeoff/i.test(x.textContent));
        const r = b.getBoundingClientRect();
        return [r.x + r.width/2, r.y + r.height/2]; }""")
    t.click_xy(ab[0], ab[1])
    t.cap("Depth 0.57 ft - from the grading sheet's own elevations - no "
          "trench layback on a playground bowl. Mass Excavation: 155.7 CY. "
          "The hand number was 157.", 5.0)

    # ---- L3.0: the correction the app made -----------------------------
    goto(8)
    t.wait_js("() => state.result && state.result.engine_sig", timeout=120000)
    p.wait_for_timeout(800)
    type_scale(20, "Utility plan - same move, 1 inch = 20 feet per its bar.")
    # isolate the sewer family
    sew = p.evaluate("""() => {
      const c = state.result.chains.filter(ch => /SEWER LINE/.test(ch.layer||''));
      if (!c.length) return null;
      state.isolate = c[0].style_id; renderStyles(); draw();
      const fpp = 20/72;
      return Math.round(c.reduce((a,x)=>a+x.length_pt,0)*fpp);
    }""")
    p.wait_for_timeout(900)
    t.cap(f"The app isolates the drawn sanitary line: {sew} feet. My hand "
          "scale-off had guessed 60 - the drawn run goes all the way to "
          "the existing manhole. The app corrected the estimator.", 5.4)
    p.keyboard.press("Escape")

    # ---- L2.0: hatch planimetry story -----------------------------------
    goto(6)
    t.wait_js("() => state.result && state.result.engine_sig", timeout=120000)
    p.wait_for_timeout(800)
    type_scale(20, "Demolition plan - 1 inch = 20 feet.")
    dem = p.evaluate("""() => {
      const c = state.result.chains.filter(ch => /DEMO-CONCRETE/.test(ch.layer||''));
      if (!c.length) return null;
      state.isolate = c[0].style_id; renderStyles(); draw();
      return Math.round(c.reduce((a,x)=>a+x.length_pt,0)*20/72);
    }""")
    p.wait_for_timeout(900)
    t.cap(f"Demo concrete: the hatch family measures {dem} LF of strokes "
          "at a 3-foot pitch = 5,481 SF of removal. The hand estimate had "
          "eyeballed 2,800 +/-40%. Judgment became measurement - a $7,000 "
          "line corrected.", 5.6)
    p.keyboard.press("Escape")

    # ---- close ------------------------------------------------------------
    ap = p.evaluate("""() => { const b = [...document.querySelectorAll(
        'button')].find(x => /Approve & export/.test(x.textContent));
        b.scrollIntoView({block:'center'});
        const r = b.getBoundingClientRect();
        return [r.x + r.width/2, r.y + r.height/2]; }""")
    p.wait_for_timeout(400)
    t.click_xy(ap[0], ap[1])
    p.wait_for_timeout(2500)
    t.cap("The verdict of the session: bid moved $390,427 to $407,146 - "
          "and every dollar of movement went FROM judgment TO measurement. "
          "34% measured, 38% printed, 28% judgment, all on the record.", 5.6)
    t.cap("Hand estimate checks the app. App corrects the hand. The bid "
          "is better than either alone.", 4.0)
finally:
    try:
        video, marks = t.finish()
        print("TAKE:", video)
        print("MARKS:", marks)
    except Exception:
        t.crash_shot()
        raise
