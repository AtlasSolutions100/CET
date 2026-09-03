"""The contour COVERAGE arithmetic: how much of a sheet's contour linework
carries an elevation, and how much does not.

WHY THIS FILE EXISTS. Measured 2026-09-02 on 512f474: nothing in the engine
or the app stated a contour DENOMINATOR. `spot_z_missing` counts spot grades
with no height and the suggest route reports `n_chains` per excluded family,
but no surface anywhere said "this sheet has N contour chains and M of them
carry an elevation". Every fact was on the wire and nothing added them up, so
a sheet whose reader elevated 150 of 368 contour lines was byte-identical to
one that elevated all of them - and the operator's only route to the
difference was counting linework by eye. The owner's business partner asked
for exactly this on the same day, after spotting by eye that two contours a
sheet prints as 562 and 563 had been given 564 and 570.

WHAT IS PINNED HERE.

  1. The pure arithmetic of takeoff_engine.earthwork.contour_coverage over
     hand-built inputs: the denominator's three exclusions (non-plan chains,
     white mask ink, legend-noncontour families), the family rule (a legend
     verdict OR a family that produced a row), the numerator's `how` split,
     the length figures, and the two escape hatches that keep a cap from
     being silent - `unclassed_chains` (plan linework in no contour family)
     and `rows_outside` (a row whose chain is not in the denominator).
  2. The same function over a FROZEN row set recorded off the real sheet -
     tests/baselines/ew_coverage_oncor_c04.json, Oncor Cloudcrest engine page
     index 3 = printed sheet C-04, 589 chains and the 150 suggestion rows the
     route returned for it - compared to the numbers measured that day. A
     frozen fixture, not a live run: the OCR that produces `gap-ocr` rows is
     a 204 s pytesseract loop and this test must run in a second.
  3. That the route SHIPS it. Grep-level, because the route needs a PDF: the
     suggest handler must call contour_coverage and put it on the reply under
     `contour_coverage`, with the sheet's contour interval beside it.

Dependency-free plain asserts like tests/test_gate.py (needs the repo venv
for numpy, same as the engine):

    python tests/test_ew_coverage.py
"""

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
sys.path.insert(0, str(REPO))

from takeoff_engine.earthwork import contour_coverage  # noqa: E402

FAILS = []


def check(ok, msg):
    if ok:
        print("ok: " + msg)
    else:
        FAILS.append(msg)
        print("FAIL: " + msg)


def eq(got, want, msg):
    check(got == want, f"{msg}  (got {got!r}, want {want!r})")


def ch(cid, sid, ln=100.0, klass="curve", layer="", color=(0.0, 0.0, 0.0)):
    return {"chain_id": cid, "style_id": sid, "length_pt": ln,
            "class": klass, "layer": layer, "color": color}


def row(cid, how, z=100.0):
    return {"chain_id": cid, "how": how, "z": z}


# ---------------------------------------------------------------------------
print("1. the denominator: what counts as this sheet's contour linework")
# ---------------------------------------------------------------------------
# A family with NO legend verdict and NO row is not a contour family. Its
# chains are reported as `unclassed`, never folded into the denominator (that
# would make every sheet look hopeless) and never silently dropped (that is
# the silent cap CLAUDE.md s5 forbids). Measured motivation: Barn civil p2 has
# 351 chains in contour families and 1,000 more with no contour evidence at
# all - a coverage claim over a third of the sheet's linework either way.
if True:   # a scope, so the fixtures below cannot leak
    cov = contour_coverage(
        [ch(1, 10), ch(2, 10), ch(3, 20), ch(4, 20)],
        [row(1, "inline", 100.0)],
        verdicts={}, excluded=None)
    eq(cov["contour_chains"], 2,
       "only the family that produced a row is in the denominator")
    eq(cov["with_elev"], 1, "one of its two chains carries an elevation")
    eq(cov["no_elev"], 1, "...and the other is counted as carrying none")
    eq(cov["unclassed_chains"], 2,
       "the family with no contour evidence is reported, not absorbed")
    eq(cov["unclassed_len_pt"], 200.0, "...with its footage")
# A legend verdict alone makes a family a contour family even with zero rows.
# Barn civil p3, measured: 178 chains in legend-named contour families and NOT
# ONE elevation - the sheet whose coverage statement matters most.
if True:   # a scope, so the fixtures below cannot leak
    cov = contour_coverage(
        [ch(1, 10), ch(2, 10)], [],
        verdicts={10: {"role": "existing", "label": "EXISTING CONTOUR (legend)"}})
    eq(cov["contour_chains"], 2, "a legend-named contour family counts")
    eq(cov["with_elev"], 0, "with no elevations at all")
    eq(cov["by_how"]["inline"], 0, "and no bucket populated")
# A legend NONCONTOUR verdict disqualifies - but only when the same legend
# read also found a contour family. That is the route's own rule, and the
# reason is Stice: a legend that hung "PROPOSED LOT LINE" on the contours
# themselves would otherwise delete 634 of the operator's verified rows.
if True:   # a scope, so the fixtures below cannot leak
    v = {10: {"role": "noncontour", "label": "PROPERTY LINE (legend)"},
         20: {"role": "existing", "label": "EXISTING CONTOUR (legend)"}}
    cov = contour_coverage([ch(1, 10), ch(2, 20)], [], verdicts=v)
    eq(cov["contour_chains"], 1, "a legend noncontour family is disqualified")
    eq(cov["unclassed_chains"], 0,
       "...and it is not reported as unclassed either - the legend placed it")
    v2 = {10: {"role": "noncontour", "label": "PROPERTY LINE (legend)"}}
    cov2 = contour_coverage([ch(1, 10), ch(2, 20)],
                            [row(1, "inline"), row(2, "inline")],
                            verdicts=v2)
    eq(cov2["contour_chains"], 2,
       "with NO contour family in the legend read, the noncontour verdict "
       "has no standing and both families are judged on their rows")
# Chains that cannot be contours at all: an annotation glyph, a profile-box
# layer, near-white mask ink. Each is the suggest route's own exclusion.
if True:   # a scope, so the fixtures below cannot leak
    chains = [ch(1, 10), ch(2, 10, klass="annotation"),
              ch(3, 10, layer="C-PROF-BOX"),
              ch(4, 10, color=(0.99, 0.99, 0.99))]
    cov = contour_coverage(chains, [row(1, "inline")], verdicts={})
    eq(cov["contour_chains"], 1,
       "annotation glyphs, profile layers and white mask ink are not "
       "contour linework")
    eq(cov["unclassed_chains"], 0, "...and none of them is unclassed either")
# The route's explicit exclusion list is honoured too.
if True:   # a scope, so the fixtures below cannot leak
    cov = contour_coverage([ch(1, 10), ch(2, 10)], [row(1, "inline")],
                           verdicts={}, excluded={2})
    eq(cov["contour_chains"], 1, "a chain the route excluded is out of both")

# ---------------------------------------------------------------------------
print("2. the numerator: every elevation says which mechanism produced it")
# ---------------------------------------------------------------------------
if True:   # a scope, so the fixtures below cannot leak
    chains = [ch(i, 10) for i in range(1, 8)]
    rows = [row(1, "inline"), row(2, "radius"), row(3, "gap-ocr"),
            row(4, "inherited"), row(5, "interval-infill"),
            row(6, "some-reader-we-do-not-know")]
    cov = contour_coverage(chains, rows, verdicts={})
    eq(cov["contour_chains"], 7, "seven contour chains")
    eq(cov["with_elev"], 6, "six carry an elevation")
    eq(cov["no_elev"], 1, "one carries none")
    eq(cov["by_how"], {"inline": 1, "radius": 1, "gap-ocr": 1,
                       "inherited": 1, "interval-infill": 1, "unknown": 1},
       "every mechanism is counted, and an unrecognised one lands in "
       "`unknown` rather than being dropped or counted as printed")
# LENGTH AS WELL AS COUNT, and the two disagree - which is the point. C-04's
# elevated chains are 40.8% of the contour chains and 59.0% of the contour
# footage: the reader lands labels on the long through-going contours.
if True:   # a scope, so the fixtures below cannot leak
    cov = contour_coverage([ch(1, 10, 900.0), ch(2, 10, 100.0)],
                           [row(1, "inline")], verdicts={})
    eq(cov["with_elev"], 1, "one chain of two")
    eq(cov["contour_len_pt"], 1000.0, "the contour footage is both chains")
    eq(cov["with_elev_len_pt"], 900.0, "...and 90% of it carries a height")
    eq(cov["no_elev_len_pt"], 100.0, "the rest is stated, not implied")
# A row on a chain that is NOT in the denominator (an annotation glyph the
# reader elevated, a chain the exclusions removed) is not silently counted as
# coverage and not silently discarded: `rows` and `rows_outside` reconcile it.
if True:   # a scope, so the fixtures below cannot leak
    cov = contour_coverage([ch(1, 10), ch(2, 10, klass="annotation")],
                           [row(1, "inline"), row(2, "gap-ocr")],
                           verdicts={})
    eq(cov["with_elev"], 1, "the annotation row is not coverage")
    eq(cov["rows"], 2, "both rows are counted as rows")
    eq(cov["rows_outside"], 1, "...and the one outside the denominator says so")
    eq(cov["by_how"]["gap-ocr"], 0,
       "the mechanism split describes the numerator, not every row")
# The unelevated list is what the review surface lists, longest first.
if True:   # a scope, so the fixtures below cannot leak
    cov = contour_coverage([ch(1, 10, 50.0), ch(2, 10, 500.0),
                            ch(3, 10, 100.0)], [row(1, "inline")],
                           verdicts={})
    eq([u["chain_id"] for u in cov["unelevated"]], [2, 3],
       "every contour line with no elevation is named, longest first")
# An empty sheet must not divide by anything or claim anything.
if True:   # a scope, so the fixtures below cannot leak
    cov = contour_coverage([], [], verdicts={})
    eq(cov["contour_chains"], 0, "no chains: no denominator")
    eq(cov["with_elev"], 0, "...and no claim of coverage")

# ---------------------------------------------------------------------------
print("3. the frozen sheet: Oncor C-04, the row set the route really returned")
# ---------------------------------------------------------------------------
# Recorded 2026-09-02 off job e183a0d44d89 page index 3 (printed sheet C-04)
# with the elevation-gap OCR cache warm. The numbers below are the measurement
# this whole change was designed against; if the reader changes, this file
# fails and the new numbers get written down in a commit that says why.
FROZEN = HERE / "baselines" / "ew_coverage_oncor_c04.json"
if not FROZEN.is_file():
    check(False, f"the frozen C-04 row set is missing: {FROZEN}")
else:
    fx = json.loads(FROZEN.read_text())
    verdicts = {int(k): v for k, v in fx["verdicts"].items()}
    cov = contour_coverage(fx["chains"], fx["rows"], verdicts=verdicts)
    eq(len(fx["chains"]), 589, "the sheet detected 589 chains")
    eq(len(fx["rows"]), 150, "the suggest route returned 150 elevation rows")
    eq(cov["contour_chains"], 368, "C-04 draws 368 contour lines")
    eq(cov["with_elev"], 150, "150 of them carry an elevation")
    eq(cov["no_elev"], 218, "218 carry none at all")
    eq(cov["contour_len_pt"], 139582.7, "the contour footage, in paper points")
    eq(cov["with_elev_len_pt"], 82309.6, "...and the elevated part of it")
    check(abs(100.0 * cov["with_elev_len_pt"] / cov["contour_len_pt"] - 59.0)
          < 0.1,
          "coverage by FOOTAGE is 59% where coverage by COUNT is 41% - the "
          "two disagree, and both ship")
    eq(cov["by_how"], {"inline": 0, "radius": 20, "gap-ocr": 69,
                       "inherited": 26, "interval-infill": 35, "unknown": 0},
       "not one of C-04's 150 elevations is read out of the sheet's own "
       "text: 20 are the nearest printed number beside the line, 69 were "
       "transcribed by machine off a picture, 61 nobody printed at all")
    eq(cov["rows_outside"], 0, "every row sits on a chain in the denominator")
    eq(cov["unclassed_chains"], 75,
       "and 75 more lines of plan linework are in no contour family - said "
       "out loud, because if any of them is a contour it is in neither count")
    eq(len(cov["unelevated"]), 218,
       "the review surface gets all 218 unelevated lines by name")
    eq(cov["unelevated"][0]["chain_id"], 76,
       "longest first: line 76 (2,803 pt) is the biggest contour on this "
       "sheet with no height on it")

# ---------------------------------------------------------------------------
print("4. the route ships it")
# ---------------------------------------------------------------------------
srv = (REPO / "server.py").read_text(encoding="utf-8")
check("contour_coverage(res.get(\"chains\")" in srv,
      "the suggest route computes coverage from the stored chains")
check('"contour_coverage": coverage' in srv,
      "...and puts it on the reply under `contour_coverage`")
check('coverage["interval"] = contour_interval(' in srv,
      "the sheet's own contour interval rides with it - the evidence the "
      "review surface ranks rows on")
check("is_printed_how(r.get(\"how\"))" in srv,
      "...read off the elevations the engine believes are PRINTED, never "
      "off an inferred one (which was produced by assuming an interval)")

print()
if FAILS:
    print(f"{len(FAILS)} FAILED")
    for f in FAILS:
        print("  - " + f)
    sys.exit(1)
print("all checks passed")
