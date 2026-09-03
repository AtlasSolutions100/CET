"""THE DENOMINATOR MUST NOT DROP WHAT IT CLAIMS TO REPORT.

THE DEFECT (review finding R2, 2026-09-03). takeoff_engine.earthwork's
contour_coverage() ran four filters before the `else: unclassed`
accumulator - a missing chain_id, `not _is_plan_chain`, `_chain_white`, the
route's own exclusion list, and the legend-noncontour verdict - and every
one of them dropped its chains with a bare `continue`. Only the chains that
survived all of them could ever be reported as `unclassed`, while the block
comment above the function promised the opposite in as many words ("NOT
silently dropped either ... because CLAUDE.md s5's rule is that a cap must
be said out loud").

MEASURED, DEM dem_hurricane_bench_a_pad_2ft_outline page 0: 22 chains
carrying 33,301.7 pt - 50.6% of everything the engine assembled on that
page - were in neither count and in no reported class. Sixteen of them are
a grey 0.4 pt family the OCR'd legend called "GRADING NOTES", drawn in the
identical ink as the family the same legend read called "EXISTING CONTOUR";
two are the sheet border, traced as `annotation`. On screen that became
"57 contour lines, 21 carry an elevation (58% of that contour footage)"
where the elevated share of the sheet's whole plan linework is 33.5%. It
OVERSTATED by 24 points on the one sheet where the reader is weakest.

WHAT THIS PINS
 1. Every chain lands in exactly one bucket and the buckets add up to the
    page - contour + set_aside(...) + not_plan + no_chain_id == page.
 2. `plan_chains` / `plan_len_pt` are the wider denominator: everything
    that could be a contour, WITHOUT the annotation and title-block
    geometry (argued in the function's own comment - two of the outline
    sheet's six are the drawing frame, 7,776 pt each, and a frame in a
    contour denominator misstates in the other direction).
 3. Each set-aside class carries its own count AND footage, and a legend
    exclusion carries the legend's own words.
 4. The denominator itself did NOT move: contour_chains, with_elev, no_elev
    and the two footages are exactly what they were.
 5. The UI states BOTH shares and labels the wider one the floor, so the
    disclosure adds up out loud (webui/app.js, checked at source).

Dependency-free like tests/test_ew_coverage.py:
    python tests/test_ew_denominator.py
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from takeoff_engine.earthwork import contour_coverage  # noqa: E402

fails = 0


def check(ok, msg):
    global fails
    if ok:
        print("ok: " + msg)
    else:
        fails += 1
        print("FAIL: " + msg)


def eq(got, want, msg):
    check(got == want, "%s  (got %r, want %r)" % (msg, got, want))


def ch(cid, sid, length, klass="", layer="", color=None):
    return {"chain_id": cid, "style_id": sid, "length_pt": length,
            "class": klass, "layer": layer, "color": color}


def row(cid, how="inline"):
    return {"chain_id": cid, "how": how, "z": 100.0}


# The DEM outline sheet's shape, small enough to read: one contour family
# (5) with three lines, two of them elevated; one family the legend called
# something else (8), grey and 0.4 pt like the contours; one line in no
# family at all (13); one annotation chain standing for the sheet border.
CHAINS = [
    ch(1, 5, 400.0), ch(2, 5, 300.0), ch(3, 5, 200.0),          # contour fam
    ch(10, 8, 500.0), ch(11, 8, 600.0),                          # legend: no
    ch(20, 13, 90.0),                                            # no family
    ch(30, 0, 7776.0, klass="annotation"),                       # the border
    ch(40, 9, 12.0, color=[1.0, 1.0, 1.0]),                      # mask ink
]
VERDICTS = {5: {"role": "existing", "label": "EXISTING CONTOUR (legend)"},
            8: {"role": "noncontour", "label": "GRADING NOTES (legend)"}}
ROWS = [row(1), row(2)]

print("1. every chain lands in exactly one bucket, and the buckets add up")
cov = contour_coverage(CHAINS, ROWS, verdicts=VERDICTS, excluded={10, 11})
sa = cov.get("set_aside")
check(isinstance(sa, dict),
      "contour_coverage reports what it set aside, class by class")
if not isinstance(sa, dict):
    print("\n%d FAILED" % max(fails, 1))
    sys.exit(1)

eq(cov["contour_chains"], 3, "the contour family is the denominator it was")
eq(cov["with_elev"], 2, "...and the numerator")
eq(cov["no_elev"], 1, "...and what carries none")
eq(cov["contour_len_pt"], 900.0, "...and the footage")
eq(cov["with_elev_len_pt"], 700.0, "...and the elevated footage")

eq(sa["legend_noncontour"]["n"], 2,
   "the family the legend called something else is COUNTED")
eq(sa["legend_noncontour"]["len_pt"], 1100.0, "...with its footage")
eq(sa["legend_noncontour"].get("labels"), ["GRADING NOTES (legend)"],
   "...and named in the legend's own words, so a reader can disbelieve it")
eq(sa["white"]["n"], 1, "near-white mask ink is counted")
eq(sa["not_plan"]["n"], 1, "annotation and title-block geometry is counted")
eq(sa["not_plan"]["len_pt"], 7776.0, "...with its footage - it is the border")
eq(sa["unclassed"]["n"], 1, "and so is the linework in no contour family")
eq(sa["no_chain_id"]["n"], 0, "a chain with no id has its own class too")
eq(sa["excluded_other"]["n"], 0,
   "an exclusion the legend did not explain has its own class")

n_all = cov["contour_chains"] + sum(v["n"] for v in sa.values())
len_all = round(cov["contour_len_pt"]
                + sum(v["len_pt"] for v in sa.values()), 1)
# `unclassed` is inside the contour loop's else-branch, not inside
# contour_chains, so the sum above is the whole page exactly once.
eq(n_all, cov["page_chains"],
   "contour + every set-aside class == the page, with nothing counted twice")
eq(len_all, cov["page_len_pt"], "...and the same for the footage")
eq(cov["page_chains"], len(CHAINS), "the page is every chain the engine made")

print("\n2. the wider denominator, and what it deliberately leaves out")
eq(cov["plan_chains"], 3 + 2 + 1 + 1,
   "plan linework = contour + legend-excluded + unclassed + white")
eq(cov["plan_len_pt"], round(900.0 + 1100.0 + 90.0 + 12.0, 1),
   "...and its footage")
check(cov["plan_chains"] + sa["not_plan"]["n"] + sa["no_chain_id"]["n"]
      == cov["page_chains"],
      "...and the only thing outside it is the annotation/title-block class")
check(cov["with_elev_len_pt"] / cov["plan_len_pt"]
      < cov["with_elev_len_pt"] / cov["contour_len_pt"],
      "the wider share is the SMALLER one - a coverage number may "
      "understate, never overstate")

print("\n3. a sheet with nothing set aside still reports the classes")
cov2 = contour_coverage([ch(1, 5, 100.0)], [row(1)], verdicts=VERDICTS)
eq(sum(v["n"] for v in cov2["set_aside"].values()), 0,
   "every class is present and zero rather than absent")
eq(cov2["plan_chains"], 1, "plan linework is the one contour line")
eq(cov2["page_chains"], 1, "and so is the page")

print("\n4. the panel says both shares, and calls the wider one the floor")
js = (ROOT / "webui" / "app.js").read_text(encoding="utf-8")
check("function ewSetAside(cov)" in js,
      "webui/app.js turns the set-aside classes into words")
check(re.search(r"the elevated share is \" \+ floor \+ \"% - the floor",
                js) is not None,
      "...and prints the wider share, labelled as the floor")
check("cov.plan_len_pt" in js and "cov.plan_chains" in js,
      "...over the denominator earthwork.py hands it")
check("outside that count" in js,
      "...and lists what sits outside the contour count, so the parts add up")
check("annotation or title-block geometry" in js,
      "...and names the class it deliberately left out of that denominator")

print()
if fails:
    print("%d FAILED" % fails)
    sys.exit(1)
print("all denominator checks passed")
