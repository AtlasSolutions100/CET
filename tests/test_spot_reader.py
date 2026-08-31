"""The spot-grade READER: token orders, legend exclusion, honest None.

Pinned off the Oncor Cloudcrest C-04 defect set (engine page index 3 =
printed sheet C-04, out/verify/2026-08-31/oncor-c04-offline/report.json):
the sheet prints its plan callouts VALUE-FIRST ("583.5 ME") while its
legend prints the samples TAG-FIRST ("ME 100.0"), and the reader came back
with 5 spots, all z=None, 3 of them the legend's own illustration.

Four families, all shipped-defect shapes:
  1. both print orders parse ("583.5 ME" and "TW: 14.00" are the same label)
  2. the legend's sample rows are excluded - by the detect result's legend
     boxes when the caller has them, by the identical-value column cluster
     when it does not - and the count is DISCLOSED
  3. a genuinely absent z stays None, says why, and is counted - never
     invented
  4. 0.0 is a real elevation, not a missing one (CLAUDE.md section 5)

Dependency-free like tests/test_gate.py:  python tests/test_spot_reader.py
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from takeoff_engine.earthwork import read_spot_grades  # noqa: E402

PASS = 0


def ok(name, cond, detail=""):
    global PASS
    if not cond:
        print(f"FAIL: {name} {detail}")
        sys.exit(1)
    print(f"ok: {name}")
    PASS += 1


def _line(x0, y0, x1, y1, text):
    return (x0, y0, x1, y1, text)


def _word(x, y, text, w=20.0):
    return (x, y, x + w, y + 8.0, text)


# --- 1. both token orders --------------------------------------------------

# C-04 shape: 3 value-first callouts, in full, one 100-ft family, no bare
# full-elevation words anywhere (its contour labels are exploded vectors).
lines = [_line(500, 700, 543, 711, "569.0 TW"),
         _line(500, 800, 543, 811, "583.5 ME"),
         _line(500, 900, 543, 911, "557.2 BW")]
info = {}
out = read_spot_grades([], lines=lines, datum_info=info)
ok("value-first lines parse", [
    (g["tag"], g["value"]) for g in out] == [
    ("TW", 569.0), ("ME", 583.5), ("BW", 557.2)],
    f"got {[(g['tag'], g['value']) for g in out]}")
ok("printed-in-full family self-corroborates (3 agreeing spots, 0 anchors)",
   all(g["z"] == g["value"] and g["resolved"] for g in out),
   f"got {[(g['z'], g['resolved']) for g in out]}")
ok("z is a number, never a string",
   all(isinstance(g["z"], float) for g in out))
ok("ME reads as existing ground, TW/BW as proposed",
   [g["side"] for g in out] == ["proposed", "existing", "proposed"])

# tag-first still reads, both glued and spaced, same standard
out = read_spot_grades([], lines=[_line(10, 10, 60, 20, "FIN:05.25'"),
                                  _line(10, 50, 60, 60, "TW: 14.00")])
ok("tag-first lines still parse", [
    (g["tag"], g["value"]) for g in out] == [("FIN", 5.25), ("TW", 14.0)],
    f"got {[(g['tag'], g['value']) for g in out]}")

# a lone 3-digit value has NO family and no anchors: stays honest-unresolved
out = read_spot_grades([], lines=[_line(0, 0, 40, 10, "585.0 TW")])
ok("lone printed-in-full value cannot vouch for itself",
   out[0]["z"] is None and not out[0]["resolved"])

# EW is C-04's own legend vocabulary (PROPOSED END OF WALL ELEVATION)
out = read_spot_grades([], lines=[_line(0, 0, 40, 10, "568.6 EW"),
                                  _line(0, 50, 40, 60, "569.8 EW"),
                                  _line(0, 90, 40, 100, "557.6 EW")])
ok("EW tag reads, proposed side",
   len(out) == 3 and all(g["side"] == "proposed" for g in out))

# --- 1b. a consumed line cannot be re-read by the word pass ----------------

# C-04 cross-capture shape: "585.3 ME" is one whole line; the NEXT callout's
# value 585.7 sits 17 pt right of the ME word. The tag word lives inside a
# line pass A already read whole, so pass B must not pair it again.
words = [_word(500, 700, "585.3", w=25), _word(528, 700, "ME", w=15),
         _word(560, 700, "585.7", w=25)]
lines = [_line(500, 700, 543, 708, "585.3 ME")]
out = read_spot_grades(words, lines=lines)
ok("tag inside a consumed line is not re-paired (no neighbour grab)",
   [(g["tag"], g["value"]) for g in out] == [("ME", 585.3)],
   f"got {[(g['tag'], g['value']) for g in out]}")

# --- 2. legend exclusion ----------------------------------------------------

# C-04's legend, verbatim: tag-first sample rows at 19.2 pt pitch in one
# column, every value the sample 100.0 - plus 3 real value-first callouts.
LEGEND = [_line(168.9, 140.0, 203.3, 149.0, "ME 100.0"),
          _line(169.3, 159.2, 204.2, 168.2, "TW 100.0"),
          _line(168.9, 178.4, 204.2, 187.3, "BW 100.0"),
          _line(168.8, 197.6, 204.1, 206.5, "EW 100.0")]
REAL = [_line(500, 700, 543, 711, "569.0 TW"),
        _line(500, 800, 543, 811, "583.5 ME"),
        _line(500, 900, 543, 911, "557.2 BW")]

# 2a. by legend boxes: C-04's detected sample rows end at y=114.9 and resume
# at y=212.7 - the spot rows live in the GAP, covered only by merging the
# boxes into one block.
BOXES = [[26.5, 77.5, 262.5, 95.5], [27.1, 96.9, 263.1, 114.9],
         [26.5, 212.7, 262.5, 230.7], [26.5, 232.0, 262.5, 250.0]]
info = {}
out = read_spot_grades([], lines=LEGEND + REAL, datum_info=info,
                       legend_boxes=BOXES)
ok("legend rows inside the merged box block are excluded",
   len(out) == 3 and all(g["value"] != 100.0 for g in out),
   f"got {[(g['tag'], g['value']) for g in out]}")
ok("legend exclusion count disclosed",
   info.get("legend_excluded") == 4, f"got {info.get('legend_excluded')}")

# 2b. no boxes: the identical-value column cluster catches the same rows
info = {}
out = read_spot_grades([], lines=LEGEND + REAL, datum_info=info)
ok("legend sample column excluded without boxes (cluster fallback)",
   len(out) == 3 and info.get("legend_excluded") == 4,
   f"got n={len(out)} excluded={info.get('legend_excluded')}")

# 2c. exclusion runs BEFORE corroboration: the legend's identical 100.0s
# must not vouch for a real 105.0 (three agreeing values would)
info = {}
out = read_spot_grades([], lines=LEGEND + [_line(500, 700, 540, 710,
                                                 "105.0 TW")],
                       datum_info=info)
ok("excluded legend values cannot corroborate a real spot",
   len(out) == 1 and out[0]["z"] is None and not out[0]["resolved"],
   f"got {out}")

# 2d. two same-value spots do NOT make a cluster; three spread out in x
# do not either - real callouts survive
info = {}
out = read_spot_grades([], lines=[
    _line(100, 100, 140, 110, "TW: 32.30"),
    _line(102, 125, 142, 135, "FG: 32.30"),
    _line(600, 100, 640, 110, "BW: 32.30"),   # same value, far away in x
], datum_info=info)
ok("no false legend cluster from 2 aligned + 1 distant same-value rows",
   len(out) == 3 and info.get("legend_excluded") == 0,
   f"got n={len(out)} excluded={info.get('legend_excluded')}")

# --- 3. absent z stays None, says why, and is counted -----------------------

info = {}
out = read_spot_grades([], lines=[_line(0, 0, 40, 10, "FG: 12.50"),
                                  _line(0, 300, 40, 310, "TW: 14.00")],
                       datum_info=info)
ok("truncated values with no datum: z None, why said, count disclosed",
   all(g["z"] is None and g["why"] == "no_datum" for g in out)
   and info.get("z_missing") == 2,
   f"got {[(g['z'], g.get('why')) for g in out]} "
   f"z_missing={info.get('z_missing')}")

# --- 4. 0.0 is not None ------------------------------------------------------

# a spot at exactly the datum: value 0.0 resolves to base + 0.0 and is
# NOT counted missing (`is None`, never truthiness - CLAUDE.md section 5)
note = ("NOTE: ALL SPOT ELEVATIONS ARE TRUNCATED CIVIL ELEVATIONS "
        "(IE. EXAMPLE: TOP OF PATIO @ 7705.25' = FIN:05.25')")
info = {}
out = read_spot_grades([], lines=[_line(0, 0, 300, 10, note),
                                  _line(0, 100, 40, 110, "FG: 0.0")],
                       datum_info=info)
ok("value 0.0 resolves against the declared datum",
   len(out) == 1 and out[0]["z"] == 7700.0 and out[0]["resolved"],
   f"got {out}")
ok("z present and 0-adjacent: z_missing stays 0",
   info.get("z_missing") == 0 and "why" not in out[0],
   f"got z_missing={info.get('z_missing')}")

print(f"{PASS}/{PASS} spot-reader tests passed")
