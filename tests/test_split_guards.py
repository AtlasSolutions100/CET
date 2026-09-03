"""TWO GUARDS ON THE SURFACE SPLIT, before the UI starts trusting it.

webui/app.js is about to stop recomputing its own stroke-width median and
start using the `surface` the server put on each suggest row.  That hands
the legend and colour tiers real authority over which contours enter which
TIN, so the two places they can be confidently wrong get closed first.

  1. BOTH TOKENS -> ABSTAIN.  family_verdicts() tested "EXIST" before
     "PROPOSED" as a bare substring, so an ordinary legend caption -
     "PROPOSED CONTOUR TO MATCH EXISTING GRADE" - resolved to "existing".
     The legend tier has ABSOLUTE precedence in split_rows_surface with no
     consistency check behind it (tests/test_ew_suggest.py deliberately pins
     that a legend verdict beats contradicting ink AND width), so nothing
     downstream could have caught it: every chain in that family would have
     gone onto the wrong surface, silently, in a volume.

  2. A MINORITY INK MUST BE A SHARE, NOT TWO STROKES.  _POP_MIN = 2 does not
     do what its comment claims - two stray strokes trip it.  Measured over
     the corpus on 2026-09-03 (grey / dark / minority share of seeded rows):

       Oncor C-04 p3      89 / 26 / 23%   screens, correct
       Oncor C-06 p5      60 / 15 / 20%   screens, correct
       Oncor C-08 p7      34 / 18 / 35%   screens, correct
       Belle Farms ROAD   39 /  1 /  2%   held off - by ONE stroke
       C2.1-Grading        1 / 17 /  6%   held off - by ONE stroke
       C4.0, C4.1-C4.4     0 / 5-13/  0%  held off

     Belle Farms would screen 39 rows against 2 with one more dark stroke.
     _POP_SHARE_MIN = 0.15 sits in the empty band between 6% and 20%, so it
     closes both near-misses and moves none of the eight measured sheets.

Run:  python tests/test_split_guards.py
"""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import takeoff_engine.earthwork as _ew  # noqa: E402
from takeoff_engine.earthwork import (  # noqa: E402
    _POP_MIN, family_verdicts, split_rows_surface)

# Imported defensively ON PURPOSE. If this were a plain `from ... import`
# the suite would die with an ImportError on the pre-fix commit, which
# proves only that a constant is new. Reading it with a default lets every
# BEHAVIOURAL assertion below actually run against the old code and fail
# there, which is the thing worth pinning.
_POP_SHARE_MIN = getattr(_ew, "_POP_SHARE_MIN", 0.0)

FAILS = []


def check(ok, msg):
    if ok:
        print("ok:", msg)
    else:
        FAILS.append(msg)
        print("FAIL:", msg)


def styles(*labels):
    return [{"style_id": i, "suggested_label": lab}
            for i, lab in enumerate(labels)]


# ===========================================================================
# 1. the legend caption that named both surfaces
# ===========================================================================
v = family_verdicts(styles(
    "EXISTING CONTOUR (legend)",                          # 0
    "PROPOSED CONTOUR (legend)",                          # 1
    "PROPOSED CONTOUR TO MATCH EXISTING GRADE (legend)",  # 2
    "EXISTING CONTOUR TO BE REMOVED, PROPOSED SHOWN (legend)",  # 3
    "CONTOUR (legend)",                                   # 4
    "PROPERTY LINE (legend)",                             # 5
))
check(v[0]["role"] == "existing", "a plain EXISTING CONTOUR row still seeds existing")
check(v[1]["role"] == "proposed", "a plain PROPOSED CONTOUR row still seeds proposed")
check(v[2]["role"] == "contour",
      "'PROPOSED CONTOUR TO MATCH EXISTING GRADE' ABSTAINS - it names both "
      "surfaces, so it says which family this is but not which side  (got "
      + v[2]["role"] + ")")
check(v[3]["role"] == "contour",
      "...and so does the other word order, which the substring test would "
      "have called existing too  (got " + v[3]["role"] + ")")
check(v[4]["role"] == "contour", "an unqualified CONTOUR row is still 'contour'")
check(v[5]["role"] == "noncontour", "a non-contour legend row is unaffected")

# an abstaining family must still SEED rows - it falls through to colour and
# width rather than being dropped, which is the difference between "we do not
# know the side" and "this is not a contour"
rows = [{"chain_id": 1, "width": 0.2}, {"chain_id": 2, "width": 0.9}]
info = {1: {"style_id": 2, "color": None, "width": 0.2},
        2: {"style_id": 2, "color": None, "width": 0.9}}
counts = split_rows_surface(rows, info, v)
check(all(r.get("surface") in ("existing", "proposed") for r in rows),
      "an abstaining legend family still gets a surface from width, not None")
check(counts["legend"] == 0 and counts["width"] == 2,
      "...and it is recorded as decided by WIDTH, not by legend  ("
      + str(counts) + ")")

# ===========================================================================
# 2. the minority-ink share floor
# ===========================================================================
GRAY, DARK = (0.6, 0.6, 0.6), (0.0, 0.0, 0.0)


def ink_case(n_gray, n_dark):
    """A sheet with no legend at all: only ink and width can decide."""
    rows, info = [], {}
    cid = 0
    for _ in range(n_gray):
        cid += 1
        rows.append({"chain_id": cid, "width": 0.5})
        info[cid] = {"style_id": 9, "color": GRAY, "width": 0.5}
    for _ in range(n_dark):
        cid += 1
        rows.append({"chain_id": cid, "width": 0.5})
        info[cid] = {"style_id": 9, "color": DARK, "width": 0.5}
    return rows, info, split_rows_surface(rows, info, {})


# Belle Farms' shape, one stroke over the old absolute floor: 39 grey, 2 dark
rows, info, c = ink_case(39, 2)
check(c["color"] == 0,
      "39 grey + 2 dark does NOT trip colour screening - 2 strokes is 5% of "
      "the sheet, not a population  (" + str(c) + ")")
check(c["width"] == 41, "...all 41 rows fall through to width instead")

# C2.1's shape the other way up: 2 grey, 17 dark
rows, info, c = ink_case(2, 17)
check(c["color"] == 0,
      "2 grey + 17 dark does not trip it either  (" + str(c) + ")")

# the three sheets where screening is right must still screen
for label, ng, nd in (("C-04", 89, 26), ("C-06", 60, 15), ("C-08", 34, 18)):
    rows, info, c = ink_case(ng, nd)
    check(c["color"] == ng + nd,
          label + "'s ink shape (%d grey / %d dark, minority %.0f%%) still "
          "screens every row" % (ng, nd, 100.0 * min(ng, nd) / (ng + nd)))
    ex = sum(1 for r in rows if r["surface"] == "existing")
    pr = sum(1 for r in rows if r["surface"] == "proposed")
    check((ex, pr) == (ng, nd),
          "   ...grey to existing, dark to proposed  (%d/%d)" % (ex, pr))

# the boundary itself, stated as a fact about the constant rather than a
# number retyped: just under the share fails, just over it passes
n = 100
under = int(n * _POP_SHARE_MIN) - 1
over = int(n * _POP_SHARE_MIN) + 1
rows, info, c = ink_case(n - under, under)
check(c["color"] == 0,
      "a minority of %d/%d (%.0f%%) is below the share floor and does not "
      "screen" % (under, n, 100.0 * under / n))
rows, info, c = ink_case(n - over, over)
check(c["color"] == n,
      "a minority of %d/%d (%.0f%%) is above it and does"
      % (over, n, 100.0 * over / n))

check(_POP_MIN == 2, "the absolute floor is still there as well")
check(0 < _POP_SHARE_MIN < 0.20,
      "the share floor sits below the lowest correct case measured (20%)")

print("\n%d FAILED" % len(FAILS) if FAILS else "\nall passed")
sys.exit(1 if FAILS else 0)
