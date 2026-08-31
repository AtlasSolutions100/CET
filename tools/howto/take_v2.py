"""V2 - Cut & fill, corrected like an operator (Josh Stice's 600-acre sheet).

The scoreboard is the sheet's OWN printed earthwork table: cut 2,236,137 /
fill 1,631,080 CY. The naive run reproduces what the client saw in the
meeting (fill a million yards over, "filling all that stuff outside");
the operator recipe (3 bad rows out, strays cleared, tract-ring limit of
work) brings fill from 2.70M to 1.16M. The residual ~25% under-read on
both surfaces is SAID in the captions - contour fidelity, not region.
Recipe: out/verify/2026-08-30/stice-recipe/recipe.json.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from rig import Take

PDF = (r"C:\Users\kobys\OneDrive\Desktop\past\P\Takeoff Automation"
       r"\client_meet\beaumont\stice1.pdf")

ROWS_OUT = ["382.8", "384.4", "655"]          # z text of the three bad rows
FRAGS = [(6550, 1015.7, 193.0), (6552, 1466.6, 163.7), (6553, 1588.3, 163.7),
         (6554, 1979.5, 288.7), (6556, 2150.5, 395.5), (6557, 2286.5, 768.8),
         (6559, 2712.6, 721.3)]
BOUND_PT = (1760.4, 2147.5)
BOUND_ID = 6544

t = Take("v2_earthwork", Path(__file__).parent / "raw")
p = t.page


def ew_result():
    return p.evaluate(
        "(document.querySelector('#ewResult')||{textContent:''})"
        ".textContent.trim()")


def calc_and_wait(capline):
    t.scroll_into("#ewCalc")
    t.click("#ewCalc")
    t.cap(capline, 2.6)
    t.mark("cut_start")
    t.wait_js("""() => { const r = document.querySelector('#ewResult');
      return r && r.textContent && /cut/.test(r.textContent)
        && !/calculating/.test(r.textContent); }""", timeout=600000)
    p.wait_for_timeout(800)
    t.mark("cut_end")
    return ew_result()


def zoom_at(px, py, steps, direction=-1):
    """Wheel-zoom the canvas at a page-pt location; remap each step."""
    for _ in range(steps):
        s = t.pt2screen(px, py)
        p.mouse.move(s[0], s[1])
        p.mouse.wheel(0, direction * 480)
        p.wait_for_timeout(140)


try:
    t.cap("A real client scored this app on a 600-acre mass-grading sheet. "
          "The sheet prints the engineer's own table: cut 2,236,137 - "
          "fill 1,631,080 cubic yards. That's the scoreboard.", 5.4)

    t.type_in("#pathInput", PDF, delay=6)
    ob = p.locator("button", has_text="Open").first
    b = ob.bounding_box()
    t.click_xy(b["x"] + b["width"] / 2, b["y"] + b["height"] / 2)
    t.wait_js("() => state.job && state.kinds && state.kinds.length > 0")
    p.wait_for_timeout(1500)

    t.click("#detectBtn")
    t.cap("Preliminary Grading Plan, 1 inch = 200 feet. Detect - about two "
          "minutes on a sheet this dense. (cut for time)", 3.4)
    t.mark("cut_start")
    t.wait_js("() => state.result && state.result.engine_sig",
              timeout=600000)
    p.wait_for_timeout(1200)
    t.mark("cut_end")
    t.cap("Detected. The scale is read and cross-checked against the "
          "sheet's own bar - 0.0% apart.", 3.6)

    # ---- naive run -----------------------------------------------------
    t.click("#ewBtn")
    t.wait_js("() => state.ew && state.ew.rows && state.ew.rows.length",
              timeout=300000)
    p.wait_for_timeout(1000)
    nrows = p.evaluate("state.ew.rows.length")
    t.cap(f"Earthwork reads every labeled contour - {nrows:,} of them - "
          "and splits existing from proposed by ink weight. First: "
          "calculate with NO corrections, exactly what the client saw.", 5.0)
    res = calc_and_wait("Building both 600-acre surfaces\u2026 (cut for time)")
    t.cap(f"{res.splitlines()[0][:105]}", 4.0)
    t.cap("Cut looks close to the table. Fill is A MILLION YARDS OVER - "
          "the client's own words: \u201cit's filling all that stuff "
          "outside.\u201d Let's work it like an operator.", 5.2)

    # ---- three bad rows --------------------------------------------------
    t.cap("Three bad rows. Two \u201celevations\u201d are the title block's "
          "own numbers. One is a phantom 200-foot cone worth 128,000 "
          "yards.", 4.2)
    for z in ROWS_OUT:
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
            t.click_xy(pt[0], pt[1], 420)
    t.cap("Out. The engine found them; the operator judged them.", 3.0)

    # ---- clear the stray fragments ---------------------------------------
    t.cap("The sheet draws its tract boundary as one heavy ring - plus a "
          "few stray tick scraps the detector filed with it. Clear the "
          "scraps so the ring picks clean.", 4.4)
    deleted = 0
    for cid, px, py in FRAGS:
        zoom_at(px, py, 4)
        s = t.pt2screen(px, py)
        t.click_xy(s[0], s[1], 320)
        sel = p.evaluate("state.selected")
        if sel == cid:
            t.click("#removeBtn", 320)
            deleted += 1
        else:
            p.keyboard.press("Escape")
        zoom_at(px, py, 4, direction=1)
    t.cap(f"{deleted} scraps removed - each one selected, checked, "
          "deleted. Reversible, like every edit.", 3.4)

    # ---- limit of work -----------------------------------------------------
    t.scroll_into("#ewBound")
    t.click("#ewBoundPick")
    t.cap("Now the fix the client asked for by name: \u201cit's got the "
          "grading limit, right? Can you add that line?\u201d Click the "
          "tract boundary.", 4.0)
    zoom_at(BOUND_PT[0], BOUND_PT[1], 3)
    s = t.pt2screen(BOUND_PT[0], BOUND_PT[1])
    t.click_xy(s[0], s[1], 600)
    p.wait_for_timeout(900)
    bstate = p.evaluate(
        "(document.querySelector('#ewBoundState')||{textContent:''})"
        ".textContent.trim()")
    ok = str(BOUND_ID) in bstate or "16,855" in bstate
    zoom_at(BOUND_PT[0], BOUND_PT[1], 3, direction=1)
    t.cap(f"The ring: {bstate[:80]} \u2014 386.9 acres. Volumes stop at "
          "this line.", 4.2)

    # ---- bounded run ---------------------------------------------------------
    res2 = calc_and_wait("Recalculating inside the ring\u2026 (cut for time)")
    t.cap(f"{res2.splitlines()[0][:105]}", 4.2)
    t.cap("Fill: 2.70 million became 1.16 million - the phantom million "
          "yards is GONE. The engineer's table says 1.63M.", 4.6)
    t.cap("And the rest, said plainly: inside the ring this build still "
          "under-reads both surfaces about 25%. That residual is contour "
          "fidelity - our next engineering job - and the app tells you "
          "instead of hiding it.", 5.6)
    t.cap("A number you can defend beats a number that looks right. "
          "That's the product.", 4.0)
finally:
    try:
        video, marks = t.finish()
        print("TAKE:", video)
        print("MARKS:", marks)
    except Exception:
        t.crash_shot()
        raise
