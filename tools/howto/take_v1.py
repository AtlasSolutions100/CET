"""V1 - A regular takeoff, start to export (Belle Farms Structural)."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from rig import Take

t = Take("v1_regular", Path(__file__).parent / "raw")
p = t.page
try:
    t.cap("This is CORE Takeoff. Let's run a regular takeoff — open a plan, "
          "detect the lines, check the numbers, export.", 4.2)

    # -- open the sample plan ------------------------------------------
    t.hover("#sampleSel")
    idx = [i for i, o in enumerate(
        p.locator("#sampleSel option").all_text_contents())
        if "Belle Farms Structural" in o][0]
    p.select_option("#sampleSel", index=idx)
    t.cap("Open the plan. The whole set loads — every page in the strip on "
          "the left.", 3.6)
    t.wait_js("() => state.job && state.kinds && state.kinds.length > 0")
    p.wait_for_timeout(1200)

    # -- detect ----------------------------------------------------------
    t.click("#detectBtn")
    t.cap("Detect reads every stroke on the sheet — vector-exact, "
          "not pixel guessing.", 3.2)
    already = p.evaluate("!!(state.result && state.result.engine_sig)")
    if not already:
        t.cap("It takes about a minute on a dense sheet. (cut for time)", 2.6)
        t.mark("cut_start")
        t.wait_js("() => state.result && state.result.engine_sig",
                  timeout=300000)
        p.wait_for_timeout(800)
        t.mark("cut_end")
    n = p.evaluate("[state.result.chains.length, state.result.styles.length]")
    t.cap(f"Done — {n[0]:,} lines in {n[1]} styles, each with its length "
          "already measured.", 3.8)

    # -- sheet head: scale ------------------------------------------------
    t.hover("#sheetHead")
    sc = p.evaluate("(document.querySelectorAll('#sheetHead .sh-chip')[2]||{}).textContent || ''")
    t.cap(f"The scale is read off the sheet itself: {sc.strip()}. "
          "Wrong scale is the most expensive mistake in takeoff — "
          "so it always shows its evidence.", 4.4)

    # -- style list: tick/untick -----------------------------------------
    t.scroll_into("#styleList")
    row = p.evaluate("""() => {
      const rows = [...document.querySelectorAll('#styleList .style-row')]
        .filter(r => r.querySelector('input[type=checkbox]')?.checked);
      const r = rows[1] || rows[0];
      r.scrollIntoView({block:'center'});
      const b = r.getBoundingClientRect();
      const cb = r.querySelector('input[type=checkbox]').getBoundingClientRect();
      return { rx: b.x + b.width/2, ry: b.y + b.height/2,
               cx: cb.x + cb.width/2, cy: cb.y + cb.height/2 };
    }""")
    p.wait_for_timeout(400)
    t.cap("Every line family is a row: its footage, its count, the CAD "
          "layer it came from.", 3.4)
    tally0 = p.evaluate("document.querySelector('#tallyBar').textContent.trim()")
    t.click_xy(row["cx"], row["cy"])
    t.cap("Untick a family and every number updates — the tally, the "
          "itemized takeoff, the export.", 3.4)
    t.click_xy(row["cx"], row["cy"])   # put it back
    t.cap_off()

    # -- hover a line on canvas -------------------------------------------
    pt = p.evaluate("""() => {
      const cv = document.querySelector('#view');
      const R = cv.getBoundingClientRect();
      const f = (typeof IMG_DPI !== 'undefined' ? IMG_DPI : 130) / 72;
      const v = state.view;
      const best = state.result.chains
        .filter(c => c.length_pt > 200 && c.class !== 'annotation')
        .map(c => { const m = c.points[Math.floor(c.points.length/2)];
          return [ R.left + (m[0]*f*v.k + v.x) * (R.width/cv.width),
                   R.top  + (m[1]*f*v.k + v.y) * (R.height/cv.height) ]; })
        .find(q => q[0] > R.left+120 && q[0] < R.right-120
                && q[1] > R.top+120  && q[1] < R.bottom-120);
      return best;
    }""")
    if pt:
        t.hover((pt[0], pt[1]), 700)
        t.click_xy(pt[0], pt[1])
        t.cap("Click any line: what it is, how long it is, where it lives. "
              "Esc deselects.", 3.6)

        # -- toolkit: delete + restore ---------------------------------
        t.click("#removeBtn")
        t.cap("Wrong line? Delete it — the tally drops and the style row "
              "says so out loud. Nothing is silent.", 3.8)
        t.click("#restoreBtn")
        t.cap("Reset edits brings everything back. Corrections are always "
              "reversible.", 3.2)
    p.keyboard.press("Escape")
    t.cap_off()

    # -- measure -----------------------------------------------------------
    t.click("#measureBtn")
    cvb = p.evaluate("""() => { const r = document.querySelector('#view')
        .getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; }""")
    mx, my = cvb[0] + cvb[2] * 0.42, cvb[1] + cvb[3] * 0.5
    t.click_xy(mx, my)
    t.click_xy(mx + 180, my)
    t.cap("Measure anything, in real feet. And if you know what a line "
          "SHOULD measure, type it — the whole sheet recalibrates.", 4.2)
    p.keyboard.press("Escape")
    p.keyboard.press("Escape")
    t.cap_off()

    # -- work area -----------------------------------------------------------
    t.click("#wzBtn")
    t.cap("The work area: drag a box around what counts. Title blocks and "
          "detail junk drop out of every number — and it says how much it "
          "excluded.", 4.0)
    x0, y0 = cvb[0] + cvb[2] * 0.08, cvb[1] + cvb[3] * 0.08
    x1, y1 = cvb[0] + cvb[2] * 0.72, cvb[1] + cvb[3] * 0.9
    t.drag(x0, y0, x1, y1, 1100)
    p.keyboard.press("Escape")
    p.wait_for_timeout(700)
    tly = p.evaluate("document.querySelector('#tallyBar').textContent.trim()")
    t.cap(f"{tly.split('·')[0].strip()} — the rest is on the record, not "
          "in your bid.", 3.8)
    t.click("#wzClearBtn")
    t.cap_off()

    # -- export ---------------------------------------------------------------
    ap = p.evaluate("""() => { const b = [...document.querySelectorAll('button')]
        .find(x => /Approve & export/.test(x.textContent));
        b.scrollIntoView({block:'center'});
        const r = b.getBoundingClientRect();
        return [r.x + r.width/2, r.y + r.height/2]; }""")
    p.wait_for_timeout(400)
    t.click_xy(ap[0], ap[1])
    p.wait_for_timeout(2500)
    t.cap("Approve & export: a CSV for pricing and a report PDF, with "
          "every quantity traceable to the lines you just saw.", 4.2)

    t.cap("That's a takeoff. Measured by software — checked by you.", 3.4)
finally:
    try:
        video, marks = t.finish()
        print("TAKE:", video)
        print("MARKS:", marks)
    except Exception as e:
        t.crash_shot()
        raise
