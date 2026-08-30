"""V4 - Full excavation takeoff, start to export (Barn civil).

Flagship: detect -> review queue -> work area -> bid view -> earthwork
(assign, strip, limit of work, calculate, consent) -> trench + depth
bands -> approve & export. Barn C3.1 (engine idx 3) + C3.0 (idx 2).
Prep (done by the runner before recording): p3 result + sidecar removed
so the detect on camera is real.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from rig import Take

PDF = (r"C:\Users\kobys\OneDrive\Desktop\past\P\Takeoff Automation"
       r"\client_meet\beaumont\SWR_Barn_Residence_-_Civil_4.7.26.pdf")

t = Take("v4_full", Path(__file__).parent / "raw")
p = t.page
try:
    t.cap("The full workflow: a real civil set, detected, checked, "
          "quantified and exported — the way an estimator works.", 4.2)

    t.type_in("#pathInput", PDF, delay=5)
    ob = p.locator("button", has_text="Open").first
    b = ob.bounding_box()
    t.click_xy(b["x"] + b["width"] / 2, b["y"] + b["height"] / 2)
    t.wait_js("() => state.job && state.kinds && state.kinds.length > 0")
    p.wait_for_timeout(1500)
    t.cap("Fifteen sheets. Triage has already read them — all civil, "
          "all ours.", 3.4)

    # ---- detect C3.1 for real -----------------------------------------
    p.select_option("#pageSel", value="3")
    p.wait_for_timeout(2000)
    t.click("#detectBtn")
    t.cap("The detailed grading sheet. Detect reads every stroke — about "
          "a minute. (cut for time)", 3.0)
    t.mark("cut_start")
    t.wait_js("() => state.result && state.result.engine_sig",
              timeout=300000)
    p.wait_for_timeout(1200)
    t.mark("cut_end")
    chips = p.evaluate(
        "[...document.querySelectorAll('#sheetHead .sh-chip')]"
        ".map(c=>c.textContent.trim())")
    t.cap(f"Done. It knows which drawing this is — {chips[0]} — and the "
          f"scale, cross-checked against the drawn bar.", 4.2)

    # ---- review queue ---------------------------------------------------
    t.scroll_into("#ckPanel")
    nq = p.evaluate(
        "(document.querySelector('#ckPanel').textContent"
        ".match(/Check these \\((\\d+)\\)/)||[])[1] || '?'")
    t.cap(f"Instead of 200 rows to skim, the engine lists the {nq} things "
          "it is least sure about. Everything else came through clean.", 4.2)
    datum = p.evaluate("""() => {
      const r = [...document.querySelectorAll('#ckPanel button,'
        + ' #ckPanel [role=button]')]
        .find(e => /disagrees with itself/.test(e.textContent));
      if (!r) return null;
      r.scrollIntoView({block:'center'});
      const b = r.getBoundingClientRect();
      return [b.x + b.width/2, b.y + b.height/2];
    }""")
    if datum:
        p.wait_for_timeout(400)
        t.click_xy(datum[0], datum[1])
        t.wait_js("() => state.ew && state.ew.rows", timeout=60000)
        p.wait_for_timeout(1200)
        t.scroll_into(".sp-conflict")
        t.cap("Top of the list: the sheet disagrees with ITSELF about the "
              "elevation datum. Both readings are shown — you can override "
              "with one number. We'll keep the engine's pick.", 5.0)
        t.click("#ewClose")
        t.cap_off()

    # ---- work area --------------------------------------------------------
    t.click("#wzBtn")
    t.cap("Draw the work area: one drag and the title block and legend "
          "drop out of every number.", 3.2)
    a = t.pt2screen(40, 40)
    bb = t.pt2screen(1980, 2120)
    t.drag(a[0], a[1], bb[0], bb[1], 1100)
    p.keyboard.press("Escape")
    p.wait_for_timeout(700)
    tly = p.evaluate(
        "document.querySelector('#tallyBar').textContent.trim()")
    t.cap(f"{tly.split('·')[0].strip()} — and it says exactly what it "
          "excluded. Nothing vanishes silently.", 3.8)

    # ---- bid view -----------------------------------------------------------
    t.scroll_into("#bidHead")
    t.cap("The bid view: everything regrouped into the ten lines an "
          "excavator actually prices. UNASSIGNED stays honest.", 4.0)

    # ---- earthwork on C3.0 ---------------------------------------------------
    p.select_option("#pageSel", value="2")
    p.wait_for_timeout(2500)
    t.cap("Now the overall grading sheet — C3.0, detected earlier.", 3.0)
    t.click("#ewBtn")
    t.wait_js("() => state.ew && state.ew.rows && state.ew.rows.length",
              timeout=90000)
    p.wait_for_timeout(800)
    t.cap("Earthwork. Every contour it read, with its elevation — assign "
          "each to existing or proposed ground. Flip any it got wrong.", 4.4)
    flip = p.evaluate("""() => {
      const row = document.querySelector('#ewRows > *');
      if (!row) return null;
      const btn = [...row.querySelectorAll('button')]
        .find(b => /PROP|EXIST/i.test(b.textContent));
      if (!btn) return null;
      btn.scrollIntoView({block:'center'});
      const b = btn.getBoundingClientRect();
      return [b.x + b.width/2, b.y + b.height/2];
    }""")
    if flip:
        p.wait_for_timeout(300)
        t.click_xy(flip[0], flip[1])
        t.cap("One click — the row moves to the other surface.", 2.6)
        t.click_xy(flip[0], flip[1])   # put it back
        t.cap_off()

    t.scroll_into("#ewStrip")
    t.click("#ewStrip")
    t.cap("Strip topsoil: 8 inches by default — that number comes from "
          "this client's own past estimate, and it's editable.", 3.8)

    # limit of work from the sheet's own line
    t.scroll_into("#ewBound")
    t.click("#ewBoundPick")
    t.cap("The limit of work: click the limit-of-disturbance line the "
          "drafter drew.", 2.8)
    lod = p.evaluate("""() => {
      const c = state.result.chains
        .filter(ch => /limit/i.test(ch.layer || ''))
        .sort((x, y) => y.length_pt - x.length_pt)[0];
      const m = c.points[Math.floor(c.points.length / 2)];
      return m;
    }""")
    s = t.pt2screen(lod[0], lod[1])
    t.click_xy(s[0], s[1], 700)
    p.wait_for_timeout(900)
    st = p.evaluate("document.querySelector('#status').textContent")
    t.cap("Ten broken segments stitch into one ring — every bridged gap "
          "reported, in feet. The volumes stop at this line.", 4.4)

    t.scroll_into("#ewCalc")
    t.click("#ewCalc")
    t.cap("Calculate: both surfaces built from the contours, differenced "
          "inside the ring only\u2026", 3.0)
    t.wait_js("""() => { const r = document.querySelector('#ewResult');
      return r && r.textContent && !/calculating/.test(r.textContent); }""",
              timeout=120000)
    p.wait_for_timeout(600)
    res = p.evaluate(
        "document.querySelector('#ewResult').textContent.trim()")
    t.cap(res.split("\n")[0][:110], 4.2)
    t.scroll_into("#ewAdd")
    t.click("#ewAdd")
    t.cap("Numbers reach the takeoff only when YOU add them. Calculating "
          "is looking; adding is a decision.", 3.8)
    t.click("#ewClose")
    t.cap_off()

    # ---- trench on C3.1 --------------------------------------------------
    p.select_option("#pageSel", value="3")
    p.wait_for_timeout(2500)
    t.click("#trBtn")
    p.wait_for_timeout(800)
    sel = p.evaluate("""() => {
      const s = document.querySelector('#trPanel select');
      const i = [...s.options].findIndex(o =>
        /SE-P-UT-STORM(?!\\s+INLET)/.test(o.textContent));
      return i;
    }""")
    p.select_option("#trPanel select", index=sel)
    p.wait_for_timeout(600)
    t.cap("The storm run: pick the pipe, set size and depths — the "
          "bedding rules are the spec's, and editable.", 3.8)
    t.scroll_into("#trCalc")
    t.click("#trCalc")
    p.wait_for_timeout(1200)
    tr = p.evaluate(
        "document.querySelector('#trResult').textContent.trim()")
    t.cap(f"{tr[:100]} — plus footage per 2-ft depth band, the way "
          "excavators price pipe.", 4.4)
    t.click("#trAdd")
    t.cap("Add to takeoff — same consent rule everywhere.", 2.8)

    # ---- approve ------------------------------------------------------------
    ap = p.evaluate("""() => { const b = [...document.querySelectorAll(
        'button')].find(x => /Approve & export/.test(x.textContent));
        b.scrollIntoView({block:'center'});
        const r = b.getBoundingClientRect();
        return [r.x + r.width/2, r.y + r.height/2]; }""")
    p.wait_for_timeout(400)
    t.click_xy(ap[0], ap[1])
    p.wait_for_timeout(2800)
    t.cap("Approve & export: CSV for pricing, a report PDF stamped with "
          "the printed sheet numbers, every quantity traceable.", 4.4)
    t.cap("Detected by software. Decided by you. That's the whole idea.",
          3.6)
finally:
    try:
        video, marks = t.finish()
        print("TAKE:", video)
        print("MARKS:", marks)
    except Exception:
        t.crash_shot()
        raise
