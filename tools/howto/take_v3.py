"""V3 - Counting windows & doors on a scanned plan (Bill Dunn / Aqua Vista)."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from rig import Take

PDF = (r"C:\Users\kobys\OneDrive\Desktop\past\P\Takeoff Automation"
       r"\client_meet\Bill\Marked Up Window Plans - Aqua Vista - "
       r"Sonora Valley 6-1-26.pdf")

t = Take("v3_counting", Path(__file__).parent / "raw")
p = t.page
try:
    t.cap("Counting windows and doors from a SCANNED plan — no CAD file, "
          "no text layer, just a 300-dpi scan.", 4.0)

    t.type_in("#pathInput", PDF, delay=6)
    ob = p.locator("button", has_text="Open").first
    b = ob.bounding_box()
    t.click_xy(b["x"] + b["width"] / 2, b["y"] + b["height"] / 2)
    t.wait_js("() => state.job && state.kinds && state.kinds.length > 0")
    p.wait_for_timeout(1200)
    t.cap("This is a floor-plan set a window supplier prices from. "
          "Page 1 is the schedule; the floors follow.", 3.8)

    # floor 1 = engine index 1
    p.select_option("#pageSel", value="1")
    p.wait_for_timeout(2200)
    t.cap("Floor 1. Every window carries the architect's printed mark — "
          "a little hexagon with W1L, W2L inside.", 3.8)

    # a scanned page needs a Detect pass before the tools unlock
    t.click("#detectBtn")
    t.cap("First, Detect. A scan has no vectors, so this is the slow "
          "path — several minutes at 300 dpi. (cut for time)", 3.4)
    t.mark("cut_start")
    t.wait_js("() => state.result && state.result.engine_sig",
              timeout=900000)
    p.wait_for_timeout(1000)
    t.mark("cut_end")
    t.cap("Detected. Now count.", 2.2)

    # COUNT
    t.click("#symBtn")
    t.cap("COUNT finds every repeated symbol and reads the mark inside it. "
          "On a scan this takes a few minutes. (cut for time)", 3.4)
    t.mark("cut_start")
    t.wait_js("() => state.sym && state.sym.length > 0", timeout=600000)
    p.wait_for_timeout(1000)
    t.mark("cut_end")

    groups = p.evaluate(
        "state.sym.map(g => ({n: g.n, name: g.name || null}))")
    named = [g for g in groups if g["name"]]
    t.cap(f"Done: {len(groups)} symbol groups found, "
          f"{len(named)} already named by the mark the sheet prints.", 3.8)

    # hover the biggest named group -> markers light up on the canvas
    row = p.evaluate("""() => {
      const rows = [...document.querySelectorAll('#symRows .sym-row')];
      let best = null, bn = -1;
      rows.forEach(r => {
        const n = parseInt(r.querySelector('.sym-n')?.textContent || '0');
        const named = !r.className.includes('sym-unnamed');
        if (named && n > bn) { bn = n; best = r; }
      });
      (best || rows[0]).scrollIntoView({block:'center'});
      const b = (best || rows[0]).getBoundingClientRect();
      return [b.x + b.width/2, b.y + b.height/2];
    }""")
    p.wait_for_timeout(400)
    t.hover((row[0], row[1]), 700)
    t.cap("Hover a row and every instance lights up on the sheet — "
          "you can SEE what it counted, and check it.", 4.0)

    # schedule cross-check chips
    chip = p.evaluate("""() => {
      const el = [...document.querySelectorAll('#symRows .sym-chk-ok, '
        + '#symRows .sym-chk-bad')][0];
      if (!el) return null;
      el.scrollIntoView({block:'center'});
      return el.textContent.trim();
    }""")
    if chip:
        t.cap(f"And it checks itself against the sheet's own schedule: "
              f"\u201c{chip.strip()}\u201d.", 3.8)

    # add the biggest named group to the takeoff
    addpt = p.evaluate("""() => {
      const rows = [...document.querySelectorAll('#symRows .sym-row')]
        .filter(r => !r.className.includes('sym-unnamed'));
      const r = rows.sort((a,b) =>
        parseInt(b.querySelector('.sym-n').textContent) -
        parseInt(a.querySelector('.sym-n').textContent))[0];
      r.scrollIntoView({block:'center'});
      const btn = r.querySelector('button.add');
      const b = btn.getBoundingClientRect();
      return [b.x + b.width/2, b.y + b.height/2];
    }""")
    p.wait_for_timeout(400)
    t.click_xy(addpt[0], addpt[1])
    t.cap("Add puts it on the takeoff as \u201cN each\u201d — the count "
          "came from geometry, the name from the sheet.", 3.8)

    t.cap("The honest part: the panel says what it could NOT read, so you "
          "verify against your own margin tally instead of trusting "
          "blindly. Then export.", 4.4)
    t.cap("Windows counted. No clicking every hexagon.", 3.2)
finally:
    try:
        video, marks = t.finish()
        print("TAKE:", video)
        print("MARKS:", marks)
    except Exception:
        t.crash_shot()
        raise
