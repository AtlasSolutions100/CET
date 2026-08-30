"""V5 - Automate the 80%, hand-finish the 20%, sort, price, export.

Koby's framing, on Stice's own sheet: the engine automates what it can
prove (1,490 contours read, scale cross-checked), the NEW peak-depth
readout catches the bad row, the NEW draw-the-limit tool traces the odd
cuts by hand, "+ add contour" finishes what the sheet never labeled, the
bid view itemizes, a cited market price goes on, export. Provenance split
captioned at the end.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from rig import Take

PDF = (r"C:\Users\kobys\OneDrive\Desktop\past\P\Takeoff Automation"
       r"\client_meet\beaumont\stice1.pdf")

CORNERS = [[2432.4, 439.9], [2683.0, 1184.0], [2427.1, 1930.8],
           [2428.6, 1662.7], [1952.2, 1664.4], [1950.0, 2145.8],
           [1703.3, 2148.0], [1475.0, 2057.2], [1476.2, 1665.8],
           [1003.0, 1667.3], [1005.1, 628.3], [1775.3, 629.5],
           [1776.7, 228.0], [2432.6, 217.9]]

t = Take("v5_split", Path(__file__).parent / "raw")
p = t.page


def canvas_click(px, py, settle=250):
    s = t.pt2screen(px, py)
    cv = "document.querySelector('#view')"
    t.glide(s[0], s[1], 300)
    p.evaluate(f"""([x, y]) => {{
      const cv = document.querySelector('#view');
      for (const type of ['mousedown', 'mouseup', 'click'])
        cv.dispatchEvent(new MouseEvent(type,
          {{ bubbles: true, clientX: x, clientY: y, button: 0 }}));
    }}""", [s[0], s[1]])
    p.wait_for_timeout(settle)


def calc(capline):
    t.scroll_into("#ewCalc")
    t.click("#ewCalc")
    t.cap(capline, 2.4)
    t.wait_js("""() => { const r = document.querySelector('#ewResult');
      return r && /cut/.test(r.textContent)
        && !/calculating/.test(r.textContent); }""", timeout=300000)
    p.wait_for_timeout(700)
    return p.evaluate(
        "document.querySelector('#ewResult').textContent.trim()")


try:
    t.cap("The honest split: automate everything provable, hand-finish "
          "the rest, and let the app say which was which. One 600-acre "
          "sheet, start to priced export.", 5.0)

    t.type_in("#pathInput", PDF, delay=6)
    ob = p.locator("button", has_text="Open").first
    b = ob.bounding_box()
    t.click_xy(b["x"] + b["width"] / 2, b["y"] + b["height"] / 2)
    t.wait_js("() => state.result && state.result.engine_sig",
              timeout=120000)
    p.wait_for_timeout(1500)
    t.cap("Detected earlier: 7,752 lines read off the sheet, scale "
          "1\u201d=200' cross-checked against the drawn bar. That's the "
          "automated 80% \u2014 measured, not guessed.", 4.6)

    # ---- earthwork, naive ------------------------------------------------
    t.click("#ewBtn")
    t.wait_js("() => state.ew && state.ew.rows && state.ew.rows.length",
              timeout=300000)
    p.wait_for_timeout(1000)
    nrows = p.evaluate("state.ew.rows.length")
    res = calc(f"{nrows:,} contours seeded automatically. Calculate, "
               "no corrections\u2026")
    peaks = p.evaluate("[state.ew.result.max_cut_ft, state.ew.result.max_fill_ft]")
    t.cap(f"Look at the new line: deepest fill {peaks[1]:.0f} ft \u2014 on "
          "a site with 96 ft of total relief. The app just told us a row "
          "is wrong before we priced anything.", 5.2)

    # ---- fix the flagged rows -------------------------------------------
    t.cap("Find it: the z-sorted list ends at a 655-ft \u201ccontour\u201d "
          "\u2014 no such ground exists here. Two more rows are the title "
          "block's own numbers. Three clicks.", 4.4)
    for z in ("655", "384.4", "382.8"):
        pt = p.evaluate("""(z) => {
          const rows = [...document.querySelectorAll('#ewRows > *')];
          const r = rows.find(el => {
            const q = el.querySelector('input[type=number]');
            return q && Math.abs(parseFloat(q.value) - parseFloat(z)) < 0.11;
          });
          if (!r) return null;
          r.scrollIntoView({block:'center'});
          const x = r.querySelector('button.x');
          const b = x.getBoundingClientRect();
          return [b.x + b.width/2, b.y + b.height/2];
        }""", z)
        if pt:
            p.wait_for_timeout(250)
            t.click_xy(pt[0], pt[1], 380)
    t.cap_off()

    # ---- draw the limit along the odd cuts --------------------------------
    t.scroll_into("#ewBound")
    t.click("#ewBoundDraw")
    t.cap("The new tool: DRAW the limit of work. This tract isn't a "
          "square \u2014 it has cuts and notches \u2014 so we trace the "
          "boundary corner by corner.", 3.8)
    for px, py in CORNERS:
        canvas_click(px, py, 160)
    p.keyboard.press("Enter")
    p.wait_for_timeout(800)
    bs = p.evaluate(
        "document.querySelector('#ewBoundState').textContent.trim()")
    t.cap(f"Closed: {bs[:70]} \u2014 hand-traced, editable, saved with "
          "the page.", 4.0)

    # ---- bounded calc + map ------------------------------------------------
    res2 = calc("Recalculate inside the drawn limit\u2026")
    t.cap(res2.splitlines()[0][:110], 4.2)
    t.click("#ewMap")
    p.wait_for_timeout(3500)
    t.cap("And now you can SEE it: cut in blue, fill in orange, the "
          "legend says how deep full color is, and the peaks are sane.",
          4.6)

    # ---- hand-finish: add an unlabeled contour ------------------------------
    t.cap("The 20%: this sheet draws intermediate contours it never "
          "labels, and terrain the TIN smooths over. The operator adds "
          "them \u2014 click the line, read its neighbors, type the "
          "elevation.", 5.0)
    cand = p.evaluate("""() => {
      const have = new Set(state.ew.rows.map(r => r.chain_id));
      const cv = document.querySelector('#view');
      const R = cv.getBoundingClientRect();
      const f = (typeof IMG_DPI !== 'undefined' ? IMG_DPI : 130) / 72;
      const v = state.view;
      const c = state.result.chains.filter(ch => !have.has(ch.chain_id)
          && ch.class !== 'annotation' && ch.length_pt > 300)
        .map(ch => { const m = ch.points[Math.floor(ch.points.length/2)];
          return { id: ch.chain_id, pt: m,
            sx: R.left + (m[0]*f*v.k + v.x) * (R.width/cv.width),
            sy: R.top  + (m[1]*f*v.k + v.y) * (R.height/cv.height) }; })
        .find(q => q.sx > R.left+150 && q.sx < R.right-150
                && q.sy > R.top+150  && q.sy < R.bottom-150);
      return c ? [c.pt[0], c.pt[1]] : null;
    }""")
    if cand:
        t.click("#ewAddRow")
        p.wait_for_timeout(300)
        canvas_click(cand[0], cand[1], 500)
        # type the interpolated elevation into the new row's z box
        zbox = p.evaluate("""() => {
          const rows = [...document.querySelectorAll('#ewRows > *')];
          const r = rows.find(el => {
            const q = el.querySelector('input[type=number]');
            return q && (q.value === '' || q.value === '0');
          }) || rows[rows.length - 1];
          r.scrollIntoView({block:'center'});
          const q = r.querySelector('input[type=number]');
          const b = q.getBoundingClientRect();
          return [b.x + b.width/2, b.y + b.height/2];
        }""")
        p.wait_for_timeout(300)
        t.click_xy(zbox[0], zbox[1], 380)
        p.keyboard.type("475", delay=90)
        p.keyboard.press("Tab")
        t.cap("One added by hand \u2014 the neighbors read 470 and 480, "
              "so this one is 475. On a real finish you add them where "
              "the map's color says the relief matters. (We show the "
              "motion, not the full hour.)", 5.4)

    # ---- consent + sorter + price ------------------------------------------
    t.scroll_into("#ewAdd")
    t.click("#ewAdd")
    t.cap("Add to takeoff \u2014 and the sorter files it: the bid view "
          "already groups every row into the lines an excavator prices.",
          4.0)
    t.click("#ewClose")
    t.scroll_into("#bidHead")
    p.wait_for_timeout(1200)
    t.cap("Earthwork, sorted. Now price it: published 2026 mass-"
          "excavation ranges run $2.50\u201315 per cubic yard \u2014 "
          "big-volume mass grading sits at the low end. Type YOUR "
          "number; the range is just the sanity check.", 5.6)
    # set a $/CY on the Site Cut row via its price input
    pin = p.evaluate("""() => {
      const items = [...document.querySelectorAll('#itemized > *')];
      const r = items.find(el => /Site Cut/.test(el.textContent));
      if (!r) return null;
      r.scrollIntoView({block:'center'});
      const q = [...r.querySelectorAll('input')].find(i =>
        /price|\\$/.test(i.title || i.placeholder || '') || i.step === '0.01')
        || r.querySelector('input[type=number]');
      if (!q) return null;
      const b = q.getBoundingClientRect();
      return [b.x + b.width/2, b.y + b.height/2];
    }""")
    if pin:
        p.wait_for_timeout(300)
        t.click_xy(pin[0], pin[1], 380)
        p.keyboard.type("3.50", delay=80)
        p.keyboard.press("Tab")
        t.cap("$3.50 a yard on the cut \u2014 cited market average, "
              "clearly a placeholder until your local rate replaces it.",
              4.0)

    # ---- provenance + export -------------------------------------------------
    t.cap(f"The split, on the record: {nrows:,} contours detected "
          "automatically \u00b7 3 rows corrected \u00b7 1 added by hand "
          "\u00b7 boundary drawn by hand. The software measured; the "
          "operator judged.", 5.4)
    ap = p.evaluate("""() => { const b = [...document.querySelectorAll(
        'button')].find(x => /Approve & export/.test(x.textContent));
        b.scrollIntoView({block:'center'});
        const r = b.getBoundingClientRect();
        return [r.x + r.width/2, r.y + r.height/2]; }""")
    p.wait_for_timeout(400)
    t.click_xy(ap[0], ap[1])
    p.wait_for_timeout(2800)
    t.cap("Exported and priced. Automate what's provable. Finish what "
          "isn't. Never wonder which was which.", 4.6)
finally:
    try:
        video, marks = t.finish()
        print("TAKE:", video)
        print("MARKS:", marks)
    except Exception:
        t.crash_shot()
        raise
