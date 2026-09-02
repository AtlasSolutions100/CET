"""The volume floor and the ladder gate. Both FAIL on 4010783.

TWO SERIOUS DEFECTS, both reproduced live on 2026-09-02 against
C:/Users/kobys/takeoff-demtruth/out/dem_truth/
dem_hurricane_bench_a_pad_2ft_outline.pdf page 0 (contour interval 2 ft,
every label a vector outline so pymupdf returns zero words):

  P1  NO PLAUSIBILITY FLOOR. POST /api/job/{id}/page/0/earthwork with
      existing=[{chain_id 205, z 324}] and proposed=[{chain_id 214, z 826}]
      answered cut -0.0 / fill 17,997.6 CY over area_sf 968 - 502 ft of
      fill in a 31 ft x 31 ft footprint - surface_model linear,
      existing_contours 1, proposed_contours 1. cut_fill's only entry test
      was "the interpolator built", which ONE polyline satisfies, and a TIN
      whose every sample carries the same elevation is a horizontal plane
      nothing on the sheet drew.

  P2  ON AN OCR-ONLY PAGE EVERY CONSENSUS FILTER IS INERT. Overwriting that
      job's p0_elevgaps2.json with three crafted reads (324 / 710 / 826) on
      real chains and calling GET /earthwork/suggest returned 3 rows, all
      how="gap-ocr", suggestions_dropped 0. Each filter needs native text
      it does not have: server.py's `wit` filter wants 6+ glyph-derived or
      resolved-spot values, its group ranking keeps a band only when the
      band holds 2+ rows or a glyph-backed one, suggest_elevations' 25-ft
      anchor rule wants 6+ distinct values, and its native band gate wants
      3+ glyph values. earthwork.py's own comment said "NOTHING stands in
      for [the native band gate]" - it was right.

Pure, no PDF, dependency-free like tests/test_gate.py:

    python tests/test_volume_floor.py

Part 3 replays the two live cases against the real DEM sheets and SKIPS
VISIBLY when they are absent (this box has them; a fresh clone does not).
"""

import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np  # noqa: E402

import takeoff_engine.earthwork as ew  # noqa: E402
from takeoff_engine.earthwork import (  # noqa: E402
    Surface, cut_fill, suggest_elevations)

# IMPORTED BY NAME, NOT BY `from`, ON PURPOSE. Run against `git archive
# 4010783` this file must fail on BEHAVIOUR - a volume published from two
# planes, three crafted reads minted into rows - not on an ImportError,
# which proves only that a symbol is new. Missing helpers degrade to stubs
# so every behavioural check below still executes and still fails there.
MIN_DISTINCT_Z = getattr(ew, "MIN_DISTINCT_Z", None)
MIN_RELIEF_FT = getattr(ew, "MIN_RELIEF_FT", None)
LADDER_MIN_REPEATS = getattr(ew, "LADDER_MIN_REPEATS", None)
LADDER_BAND_MULT = getattr(ew, "LADDER_BAND_MULT", None)
ladder_verdict = getattr(ew, "ladder_verdict",
                         lambda *a, **k: {"n_values": 0, "testable": False,
                                          "laddered": False, "repeats": 0,
                                          "n_gaps": 0, "interval_ft": None,
                                          "keep_lo": None, "keep_hi": None,
                                          "why": "ladder_verdict is absent"})
surface_basis = getattr(ew, "surface_basis",
                        lambda s: {"name": s.name, "n_contours": None,
                                   "n_spots": None,
                                   "distinct_elevations": None})


def _suggest(chains, words, gap_z, diag):
    """suggest_elevations with the diag out-param, degrading on a tree that
    has no such parameter (4010783) so the ROW COUNT is still asserted."""
    try:
        return suggest_elevations(chains, words, gap_z=gap_z, diag=diag)
    except TypeError:
        diag["ocr_ladder"] = {"applied": False, "dropped": 0,
                              "kept": None,
                              "verdict": ladder_verdict([]),
                              "why": "this tree has no ladder gate"}
        return suggest_elevations(chains, words, gap_z=gap_z)


FAILS = []
SKIPS = []


def check(ok, msg):
    if ok:
        print("ok: " + msg)
    else:
        print("FAIL: " + msg)
        FAILS.append(msg)


def skip(msg):
    print("SKIPPED: " + msg)
    SKIPS.append(msg)


# --------------------------------------------------------------------------
# 1. THE FLOOR
# --------------------------------------------------------------------------
# A square ring of contour, so the TIN has a real hull; z is what varies.

def _ring(x0, y0, side=200.0, n=40):
    t = np.linspace(0.0, 1.0, n, endpoint=False)
    xs, ys = [], []
    for u in t:
        if u < 0.25:
            xs.append(x0 + side * (u / 0.25)); ys.append(y0)
        elif u < 0.5:
            xs.append(x0 + side); ys.append(y0 + side * ((u - 0.25) / 0.25))
        elif u < 0.75:
            xs.append(x0 + side * (1 - (u - 0.5) / 0.25)); ys.append(y0 + side)
        else:
            xs.append(x0); ys.append(y0 + side * (1 - (u - 0.75) / 0.25))
    return np.column_stack([xs, ys])


FT_PER_PT = 40.0 / 72.0          # the DEM sheets' own 1" = 40'


def _surf(name, rings, spots=()):
    s = Surface(name)
    for pts, z in rings:
        s.contours.append((pts, float(z)))
    for x, y, z in spots:
        s.points.append((float(x), float(y), float(z)))
    return s


# --- the reported case, in miniature: one contour on each side -----------
one_ex = _surf("existing", [(_ring(0, 0), 324.0)])
one_pr = _surf("proposed", [(_ring(20, 20), 826.0)])
r = cut_fill(one_ex, one_pr, FT_PER_PT)
check("error" in r,
      "P1: one contour per surface no longer publishes a volume")
check(r.get("error_code") == "surface_no_relief",
      f"P1: the refusal names the guard (got {r.get('error_code')!r})")
check("existing" in str(r.get("error", "")),
      "P1: the refusal names WHICH surface (existing is tested first)")
check("324" in str(r.get("error", "")),
      "P1: the refusal quotes the one elevation it found")
check("cut_yd3" not in r and "fill_yd3" not in r,
      "P1: no volume field survives the refusal - nothing can print a number")
b = r.get("basis") or {}
check(b.get("existing", {}).get("distinct_elevations") == 1
      and b.get("proposed", {}).get("distinct_elevations") == 1,
      "P1: the refusal carries both surfaces' counts, not just the loser's")
check(b.get("ranges_overlap") is False and b.get("range_gap_ft") == 502.0,
      f"P1: the 502 ft gap between the two surfaces is reported "
      f"(got {b.get('range_gap_ft')})")

# --- one contour is still refused when it has many samples ---------------
dense = _surf("existing", [(_ring(0, 0, n=400), 324.0)])
r2 = cut_fill(dense, _surf("proposed", [(_ring(20, 20), 826.0), ]), FT_PER_PT)
check(r2.get("error_code") == "surface_no_relief",
      "P1: 400 samples at one elevation are still one elevation")

# --- TWO elevations on each side compute, and are unchanged --------------
good_ex = _surf("existing", [(_ring(0, 0), 100.0), (_ring(40, 40, 120.0), 104.0)])
good_pr = _surf("proposed", [(_ring(0, 0), 106.0), (_ring(40, 40, 120.0), 110.0)])
g = cut_fill(good_ex, good_pr, FT_PER_PT)
check("error" not in g, f"the floor passes a two-elevation pair: {g.get('error')}")
check(g.get("fill_yd3", 0) > 0, "...and it still produces a volume")
check(MIN_DISTINCT_Z == 2, "the floor is 2 distinct elevations, not 3")

# --- ONE contour + THREE spot grades is a legitimate surface -------------
# Barn C4.1-NW's proposed surface is 1 contour + 1 FF spot when every
# RESOLVED spot grade is sent to the proposed side (2 distinct, 3.52 ft of
# relief); Barn C3.4 prints 45 spots against 2 labelled contours. A floor
# that counted contours alone would refuse both. (Which surface C4.1-NW's
# spot lands on is a panel setting, and under the panel's own default tag
# filter it lands on neither - see the MIN_DISTINCT_Z block in
# takeoff_engine/earthwork.py for the per-configuration measurement.)
spotted = _surf("proposed", [(_ring(0, 0), 106.0)],
                spots=[(60.0, 60.0, 108.0), (80.0, 60.0, 109.0),
                       (60.0, 80.0, 110.0)])
s = cut_fill(good_ex, spotted, FT_PER_PT)
check("error" not in s,
      f"one contour + spot grades at other elevations computes: {s.get('error')}")
sb = surface_basis(spotted)
check(sb["n_contours"] == 1 and sb["n_spots"] == 3
      and sb["distinct_elevations"] == 4,
      f"surface_basis counts contours and spots together: {sb}")

# ...and one contour + spots that are ALL AT ITS OWN ELEVATION is not.
flat = _surf("proposed", [(_ring(0, 0), 106.0)],
             spots=[(60.0, 60.0, 106.0), (80.0, 60.0, 106.0),
                    (60.0, 80.0, 106.0)])
f2 = cut_fill(good_ex, flat, FT_PER_PT)
check(f2.get("error_code") == "surface_no_relief",
      "a contour plus spots all at the same elevation is still a plane")

# --- R3: A PLANE THAT COUNTS TO TWO ---------------------------------------
# "2 distinct elevations" is a COUNT, and a count cannot see the difference
# between a slope and a plane. Reproduced live 2026-09-02 on the DEM outline
# sheet: existing=[{205, 324.0}, {220, 324.0001}] with
# proposed=[{214, 826.0}, {222, 826.0001}] answered HTTP 200 and
# fill 3,367,118.5 CY - both surfaces "2 distinct", both relief_ft 0.0.
hair_ex = _surf("existing", [(_ring(0, 0), 324.0), (_ring(0, 0, 120.0), 324.0001)])
hair_pr = _surf("proposed", [(_ring(20, 20), 826.0),
                             (_ring(20, 20, 120.0), 826.0001)])
h = cut_fill(hair_ex, hair_pr, FT_PER_PT)
check("error" in h,
      "R3: two elevations 0.0001 ft apart no longer publish a volume")
check(h.get("error_code") == "surface_no_relief",
      f"R3: it is the same finding, under the same code "
      f"(got {h.get('error_code')!r})")
check("cut_yd3" not in h and "fill_yd3" not in h,
      "R3: no volume field survives it either")
check("0.0001" in str(h.get("error", "")),
      f"R3: the refusal states the MEASURED span, not just the count: "
      f"{str(h.get('error', ''))[:90]!r}")
check((h.get("surface") or {}).get("distinct_elevations") == 2,
      "R3: and admits the count was satisfied - it is relief that failed")
check((h.get("surface") or {}).get("relief_ft") == 0.0001,
      f"R3: relief_ft is reported to 4 decimals, not rounded to 0.0 "
      f"(got {(h.get('surface') or {}).get('relief_ft')!r})")
check(MIN_RELIEF_FT == 0.01,
      f"R3: the floor is 0.01 ft - one printed increment on the finest "
      f"sheet in the corpus (got {MIN_RELIEF_FT!r})")

# ...and 0.01 ft apart - the smallest step any corpus sheet prints, measured
# on Town Pump #3 C4.00 Grading Map p0 - still computes. The floor is set AT
# that increment, not above it, so the tightest legitimate pair survives.
tight_ex = _surf("existing", [(_ring(0, 0), 100.0), (_ring(0, 0, 120.0), 100.01)])
t = cut_fill(tight_ex, good_pr, FT_PER_PT)
check("error" not in t,
      f"R3: two elevations exactly 0.01 ft apart still compute: "
      f"{t.get('error')}")

# --- the empty and too-few-samples cases name their surface too ----------
e0 = cut_fill(Surface("existing"), good_pr, FT_PER_PT)
check(e0.get("error_code") == "surface_empty" and "existing" in e0["error"],
      f"an empty surface is named: {e0.get('error_code')}")
e1 = cut_fill(_surf("existing", [], spots=[(1.0, 1.0, 10.0), (2.0, 2.0, 11.0)]),
              good_pr, FT_PER_PT)
check(e1.get("error_code") == "surface_too_few_samples",
      f"two spot grades cannot make a TIN: {e1.get('error_code')}")

# --- the DISCLOSURE, not a refusal: disjoint elevation ranges ------------
# Measured over 13 corpus surface pairs: every one overlaps (gap 0.0 ft), so
# this sentence appears on none of them. It is a caution because a pure-fill
# pad and a deep excavation legitimately do not overlap, and a guard that
# refuses real work is worse than the hole.
hi_pr = _surf("proposed", [(_ring(0, 0), 140.0), (_ring(40, 40, 120.0), 144.0)])
d = cut_fill(good_ex, hi_pr, FT_PER_PT)
check("error" not in d, "disjoint elevation ranges still COMPUTE")
cb = (d.get("surface_basis") or {})
check(cb.get("ranges_overlap") is False and cb.get("range_gap_ft") == 36.0,
      f"...and the gap is disclosed: {cb.get('range_gap_ft')}")
check("check the rows" in (cb.get("caution") or ""),
      "...with a sentence that tells the operator what to do")
ov_pr = _surf("proposed", [(_ring(0, 0), 102.0), (_ring(40, 40, 120.0), 107.0)])
ov = cut_fill(good_ex, ov_pr, FT_PER_PT)
check("error" not in ov and (ov.get("surface_basis") or {}).get(
          "ranges_overlap") is True
      and (ov.get("surface_basis") or {}).get("caution") is None,
      "an OVERLAPPING pair carries no caution - which is every corpus pair")
check((g.get("surface_basis") or {}).get("existing", {}).get(
          "distinct_elevations") == 2,
      "surface_basis rides on every SUCCESSFUL volume too, not only refusals")


# --------------------------------------------------------------------------
# 2. THE LADDER GATE
# --------------------------------------------------------------------------
adv = ladder_verdict([324.0, 710.0, 826.0])
check(adv["testable"] and not adv["laddered"],
      "P2: {324, 710, 826} is not a contour ladder")
check(adv["repeats"] == 1 and adv["n_gaps"] == 2,
      f"P2: ...because no step repeats ({adv['repeats']} of {adv['n_gaps']})")
real = ladder_verdict([3376, 3378, 3380, 3382, 3388, 3390, 3394, 3396,
                       3398, 3400, 3402, 3406, 3418, 3422, 3424, 3428])
check(real["laddered"] and real["interval_ft"] == 2.0 and real["repeats"] == 9,
      f"P2: the outline sheet's own 16 reads ARE a ladder: {real}")
check(real["keep_lo"] == 3376.0 and real["keep_hi"] == 3428.0,
      "P2: ...and the whole run is kept - its widest internal gap is 12 ft, "
      "6x the interval, under the 8x band split")
check((LADDER_BAND_MULT or 0) > 6.0,
      "the band multiplier clears the largest real internal gap measured (6x)")
junk = ladder_verdict([145.0, 435.0, 700.0, 4004.0])
check(not junk["laddered"],
      "P2: Plans2 'C4 GRADING PLAN' p0's four OCR reads are not a ladder")
small = ladder_verdict([464.0, 535.0])
check(not small["testable"] and not small["laddered"],
      "P2: two values are NOT TESTABLE, which is not the same as refused")
check(LADDER_MIN_REPEATS == 2,
      "the repeat floor is 2 - the smallest number that can show a repeat")


class _Chain:
    def __init__(self, cid, pts, klass="solid", layer="C-TOPO", width=0.5):
        self.chain_id = cid
        self.pts = np.asarray(pts, float)
        dd = np.diff(self.pts, axis=0)
        self.length = float(np.hypot(dd[:, 0], dd[:, 1]).sum())
        self.klass = klass
        self.layer = layer
        self.width = width
        self.color = [0.0, 0.0, 0.0]
        self.style_id = None


def _hline(cid, y, x0=0.0, x1=200.0, step=4.0, skip=(88.0, 118.0)):
    xs = [x for x in np.arange(x0, x1 + step / 2, step)
          if not (skip and skip[0] < x < skip[1])]
    return _Chain(cid, [[x, y] for x in xs])


CH = [_hline(i, 100.0 + 40.0 * i) for i in range(1, 4)]

# the live P2 body: three crafted gap reads on three real chains
diag = {}
rows = _suggest(CH, [], {1: (324.0, 103.0, 140.0),
                         2: (710.0, 103.0, 180.0),
                         3: (826.0, 103.0, 220.0)}, diag)
check(rows == [],
      f"P2: the crafted 324/710/826 population mints NO rows (got {rows})")
check(diag["ocr_ladder"]["applied"] and diag["ocr_ladder"]["dropped"] == 3,
      f"P2: ...and the drop is reported: {diag['ocr_ladder']}")
check(not diag["ocr_ladder"]["verdict"]["laddered"]
      and "do not step like contours" in diag["ocr_ladder"]["verdict"]["why"],
      "P2: ...with the reason in words the panel can print")

# the legitimate shape on the same chains: rows survive untouched
diag2 = {}
ok_rows = _suggest(CH, [], {1: (3376.0, 103.0, 140.0),
                            2: (3378.0, 103.0, 180.0),
                            3: (3380.0, 103.0, 220.0)}, diag2)
check(len(ok_rows) == 3 and diag2["ocr_ladder"]["dropped"] == 0,
      f"P2: a 2-ft ladder of three reads is untouched (got {len(ok_rows)})")

# A PAGE WITH A GLYPH-BACKED ROW IS NOT TOUCHED AT ALL: one inline or radius
# row anywhere on the page stands the gate down. That - and not "the page has
# native text" - is what keeps Oncor p3 (C-04), Stice p0, the four native DEM
# sheets and the Barn C4.x grading sheets byte-identical. Oncor engine p4 is
# a native sheet with NO glyph-backed elevation row, and the gate does fire
# there: it ladders at 1 ft over 42 of 45 gaps and keeps all 106 rows.
diag3 = {}
words = [(96.0, 136.0, 110.0, 144.0, "324")]
nat = _suggest(CH, words, {2: (710.0, 103.0, 180.0),
                           3: (826.0, 103.0, 220.0)}, diag3)
check(len(nat) >= 3 and not diag3["ocr_ladder"]["applied"],
      f"P2: one native token stands the gate down (rows {len(nat)}, "
      f"applied {diag3['ocr_ladder']['applied']})")


# --------------------------------------------------------------------------
# 3. THE REAL PAGES (skipped visibly when the DEM sheets are absent)
# --------------------------------------------------------------------------
DEM = Path(os.environ.get("DEM_TRUTH_DIR")
           or r"C:/Users/kobys/takeoff-demtruth/out/dem_truth")
OUTLINE = DEM / "dem_hurricane_bench_a_pad_2ft_outline.pdf"
CONTROL = DEM / "dem_hurricane_bench_a_pad_2ft.pdf"

# The outline sheet's OWN cached gap reads, verbatim from the job dir the
# live reproduction ran in - the 17 the gap-OCR fix recovered. The point of
# the ladder gate is to stop the 2-row garbage, NOT to undo that fix.
OUTLINE_GAPS = {
    214: 3428.0, 229: 3390.0, 205: 3424.0, 248: 3422.0, 224: 3380.0,
    228: 3388.0, 233: 3396.0, 280: 3406.0, 246: 3418.0, 58: 3382.0,
    222: 3378.0, 238: 3402.0, 252: 3394.0, 237: 3400.0, 275: 3398.0,
    253: 3396.0, 220: 3376.0,
}

if not OUTLINE.exists() or not CONTROL.exists():
    skip(f"the DEM truth sheets are not on this box ({DEM}) - the live "
         f"outline and control replays did not run")
else:
    import pymupdf  # noqa: E402

    doc = pymupdf.open(str(OUTLINE))
    n_words = len(doc[0].get_text("words"))
    doc.close()
    check(n_words == 0,
          f"the outline sheet still has NO native text ({n_words} words) - "
          f"it is the OCR-only case this gate is for")

    lv = ladder_verdict(list(OUTLINE_GAPS.values()))
    check(lv["laddered"] and lv["interval_ft"] == 2.0,
          f"the outline sheet's 17 cached reads ladder at 2 ft: {lv['why']}")
    kept = [c for c, z in OUTLINE_GAPS.items()
            if lv["keep_lo"] is not None
            and lv["keep_lo"] <= z <= lv["keep_hi"]]
    check(len(kept) == 17,
          f"ALL 17 legitimate gap-OCR rows survive the gate (kept {len(kept)})")

    doc = pymupdf.open(str(CONTROL))
    n_ctrl = len(doc[0].get_text("words"))
    doc.close()
    check(n_ctrl > 0,
          f"the real-text control sheet has native text ({n_ctrl} words), so "
          f"the ladder gate stands down on it entirely")


print()
if SKIPS:
    print(f"{len(SKIPS)} skipped")
if FAILS:
    print(f"{len(FAILS)} FAILED")
    for f in FAILS:
        print("  - " + f)
    sys.exit(1)
print("all checks passed")
