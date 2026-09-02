"""The volume floor reaches /earthwork/zone, not only /earthwork.

THE DEFECT (measured 2026-09-02, adversarial pass on feat/ocr-volume-floor).
The branch gave cut_fill a floor: a surface carrying one elevation is a flat
plane the interpolator invented, so no volume is published. The grading-zone
calculator differences the SAME detected existing ground against a declared
design surface, and its only entry test was "the existing surface needs at
least 3 sample points". So the very rows /earthwork refuses published a
volume here: on the DEM outline sheet, an existing surface of ONE contour at
324 ft against a declared pad at 826 ft returned 417,664 CY of fill through
/earthwork/zone while POST /earthwork on the same job, page and chain
answered 400 surface_no_relief. Those cubic yards reach the priced takeoff
and the drawing.

A guard that lives on one route and not on its sibling is not a guard.

ONLY THE EXISTING SURFACE IS JUDGED here, and that is deliberate: the design
surface is DECLARED by the operator rather than read off the sheet, and a
pad is a flat plane on purpose. What may not be invented is the ground the
design is differenced against.

    python tests/test_zone_floor.py
"""

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from takeoff_engine.earthwork import Surface, zone_cut_fill  # noqa: E402

POLY = [[0, 0], [400, 0], [400, 400], [0, 400]]
FT_PER_PT = 0.5

fails = 0


def check(ok, msg):
    global fails
    if ok:
        print("ok: " + msg)
    else:
        fails += 1
        print("FAIL: " + msg)


def surf(*contours):
    return Surface("existing",
                   contours=[(np.array(pts, dtype=float), z)
                             for pts, z in contours])


def main():
    # ---- the adversary's shape: one contour, one elevation --------------
    one = surf(([[10, 10], [390, 10], [390, 390]], 324.0))
    r = zone_cut_fill(one, POLY, FT_PER_PT, {"mode": "pad", "elev_ft": 826.0})
    check(r.get("error_code") == "surface_one_label",
          "an existing surface resting on ONE label is refused (got %r)"
          % r.get("error_code"))
    check("cut_yd3" not in r and "fill_yd3" not in r and "strip_yd3" not in r,
          "and NO volume field survives the refusal - nothing downstream can "
          "print a number from it")
    check("existing" in (r.get("error") or ""),
          "the sentence names which surface is flat")
    check(isinstance(r.get("surface"), dict) and r.get("basis"),
          "and carries the structured basis the panel needs")

    # ---- two elevations a whisker apart is still a plane -----------------
    # ---- but TWO labels that agree are MEASURED flat ground -------------
    # The discriminator here is independent labels, not relief: level ground
    # is ordinary (a paved lot, a pad being re-graded) and the design is
    # declared, so "declared pad minus measured flat ground" is real
    # arithmetic. tests/test_grading_zone.py's plane cases are five spot
    # grades all reading 100.0 ft, and a relief test would refuse them.
    level = surf(([[10, 10], [390, 10]], 324.0),
                 ([[10, 300], [390, 300]], 324.0))
    r = zone_cut_fill(level, POLY, FT_PER_PT, {"mode": "pad",
                                               "elev_ft": 330.0})
    check("error" not in r,
          "two labels that agree are measured level ground, not invention "
          "(error %r)" % r.get("error"))

    # ---- real ground still computes, against a FLAT declared pad ---------
    real = surf(([[10, 10], [390, 10]], 324.0),
                ([[10, 300], [390, 300]], 340.0))
    r = zone_cut_fill(real, POLY, FT_PER_PT, {"mode": "pad", "elev_ft": 330.0})
    check("error" not in r,
          "ground with real relief still computes (error %r)" % r.get("error"))
    check(r.get("fill_yd3", 0) > 0 and r.get("cut_yd3", 0) > 0,
          "and produces both cut and fill - a pad through a slope does both")
    # the design surface is DECLARED and may legitimately be flat: this is
    # the case a floor applied to both sides would have refused
    check(r.get("cut_yd3") is not None,
          "a flat PAD is not refused - the operator declared it, the engine "
          "did not invent it")

    # ---- and in the other design modes -----------------------------------
    for mode, design in (("plane", {"mode": "plane", "elev_ft": 330.0,
                                    "slope_pct": 2.0, "azimuth_deg": 90.0}),
                         ("balance", {"mode": "balance"}),
                         ("strip_only", {"mode": "strip_only"})):
        bad = zone_cut_fill(one, POLY, FT_PER_PT, design)
        check(bad.get("error_code") == "surface_one_label",
              "the floor holds in %s mode too - it is the EXISTING side that "
              "is short, whatever the design is (got %r)"
              % (mode, bad.get("error_code")))

    print()
    if fails:
        print("%d FAILED" % fails)
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
