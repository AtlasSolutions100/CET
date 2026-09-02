"""THE LADDER GATE'S TUNING EVIDENCE, PINNED TO THE POPULATIONS IT WAS
MEASURED ON.

WHY THIS FILE EXISTS. The thresholds in takeoff_engine/earthwork.py carried
a table of corpus measurements, in the form CLAUDE.md section 6 asks for -
and the table did not reproduce. Two faults, both found by re-running the
measurement:

  1. IT WAS MEASURED ON THE WRONG POPULATION. ladder_verdict runs INSIDE
     suggest_elevations, over every row the readers produced, BEFORE
     server.py's `wit` filter and its glyph-first group ranking. The table
     was written from the values the ROUTE returns, which is the set AFTER
     those filters. So Barn C0.00 p0 was described as "{464, 535} - 2
     distinct, NOT TESTABLE, rows kept". Its actual pre-filter population is
     {60, 464, 535, 4534}: 4 distinct, TESTABLE, step 71 ft, repeats 1 of 3,
     laddered FALSE - and all 6 rows are DROPPED, the opposite of what the
     comment claimed. Live through /earthwork/suggest: suggestions 0,
     suggestions_dropped 6.
  2. THE DENOMINATOR WAS WRONG. "the three OCR-only pages in the corpus" -
     a 30-page sweep finds NINE.

Every population below is the page's OWN gap-OCR cache (p<N>_elevgaps2.json
in the job dir), recovered 2026-09-02 and replayed here: for each one the
verdict this file asserts was checked against the live
/earthwork/suggest ocr_ladder.verdict on the same page, and matched on
n_values, repeats, n_gaps, laddered and interval_ft.

Pure - no PDF, no service, no fixtures on disk:

    python tests/test_ladder_evidence.py
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import takeoff_engine.earthwork as ew  # noqa: E402

SRC = (ROOT / "takeoff_engine" / "earthwork.py").read_text(encoding="utf-8")
# ...and the same source with comment continuations folded away, so a
# refuted claim cannot hide from a search by falling across a line break.
# e6ac867 wrote the wrong denominator as "three of the" / "# corpus's
# grading sheets are", which no contiguous search finds.
FLAT = re.sub(r"\s*\n\s*#\s*", " ", SRC)

ladder_verdict = getattr(ew, "ladder_verdict", None)
MIN_REPEATS = getattr(ew, "LADDER_MIN_REPEATS", None)
MIN_SHARE = getattr(ew, "LADDER_MIN_SHARE", None)
BAND_MULT = getattr(ew, "LADDER_BAND_MULT", None)

fails = []


def check(ok, msg):
    print(("ok: " if ok else "FAIL: ") + msg)
    if not ok:
        fails.append(msg)


# --------------------------------------------------------------------------
# 1. THE NINE OCR-ONLY PAGES, plus Oncor p4 which is the tenth firing page
#    and the one that refutes "the gate never fires on a native sheet".
# --------------------------------------------------------------------------
# (name, the page's own gap-OCR reads, expected verdict fields)
PAGES = [
    ("Oncor engine p4",
     [541.0, 543.0, 544.0, 545.0, 546.0, 547.0, 548.0, 550.0, 553.0, 554.0,
      555.0, 556.0, 557.0, 558.0, 559.0, 560.0, 561.0, 562.0, 563.0, 564.0,
      565.0, 566.0, 567.0, 568.0, 569.0, 570.0, 571.0, 572.0, 573.0, 574.0,
      575.0, 576.0, 577.0, 578.0, 579.0, 580.0, 581.0, 582.0, 583.0, 584.0,
      585.0, 586.0, 587.0, 588.0, 589.0, 590.0],
     dict(n_values=46, testable=True, laddered=True, interval_ft=1.0,
          repeats=42, n_gaps=45, share=0.933)),
    ("dem_pad_2ft_outline p0",
     [3376.0, 3378.0, 3380.0, 3382.0, 3388.0, 3390.0, 3394.0, 3396.0, 3398.0,
      3400.0, 3402.0, 3406.0, 3418.0, 3422.0, 3424.0, 3428.0],
     dict(n_values=16, testable=True, laddered=True, interval_ft=2.0,
          repeats=9, n_gaps=15, share=0.6)),
    ("Plans2 C2.1 Grading p0",
     [5801.0, 5803.0, 5804.0, 5806.0, 5807.0, 5808.0, 5809.0, 5810.0, 5811.0,
      5812.0, 5813.0],
     dict(n_values=11, testable=True, laddered=True, interval_ft=1.0,
          repeats=8, n_gaps=10, share=0.8)),
    ("Barn C0.00 p0",
     [60.0, 464.0, 535.0, 4534.0],
     dict(n_values=4, testable=True, laddered=False, interval_ft=71.0,
          repeats=1, n_gaps=3, share=0.333)),
    ("Barn C2.1 Demo p0",
     [148.0, 200.0, 558.0, 2868.0, 3262.0],
     dict(n_values=5, testable=True, laddered=False, interval_ft=52.0,
          repeats=1, n_gaps=4, share=0.25)),
    ("Ernies Too C2.1 Demo p0",
     [100.0, 441.0, 444.0],
     dict(n_values=3, testable=True, laddered=False, interval_ft=3.0,
          repeats=1, n_gaps=2, share=0.5)),
    ("Ernies Too C4 Grading p0",
     [145.0, 435.0, 700.0, 4004.0],
     dict(n_values=4, testable=True, laddered=False, interval_ft=265.0,
          repeats=1, n_gaps=3, share=0.333)),
    ("Plans2 C4 GRADING p0",
     [145.0, 435.0, 700.0, 4004.0],
     dict(n_values=4, testable=True, laddered=False, interval_ft=265.0,
          repeats=1, n_gaps=3, share=0.333)),
    ("remay C1.4 Grading p0",
     [469.0, 470.0, 711.0],
     dict(n_values=3, testable=True, laddered=False, interval_ft=1.0,
          repeats=1, n_gaps=2, share=0.5)),
    ("Home2 Suites C3 Grading p0",
     [411.0, 444.0],
     dict(n_values=2, testable=False, laddered=False, interval_ft=None,
          repeats=0, n_gaps=0, share=None)),
]

print("1. every measured population replays to the verdict the comment states")
if ladder_verdict is None:
    check(False, "takeoff_engine.earthwork has a ladder_verdict at all")
else:
    for name, vals, want in PAGES:
        got = ladder_verdict(vals)
        bad = {k: (want[k], got.get(k)) for k in want if got.get(k) != want[k]}
        check(not bad, f"{name}: {want['n_values']} distinct, repeats "
                       f"{want['repeats']}/{want['n_gaps']}, laddered "
                       f"{want['laddered']}" + (f"  MISMATCH {bad}" if bad else ""))

# --------------------------------------------------------------------------
print("2. the separation the thresholds actually earn")
# --------------------------------------------------------------------------
LADDERS = [p for p in PAGES if p[2]["laddered"]]
NOT = [p for p in PAGES if p[2]["testable"] and not p[2]["laddered"]]
check(len(LADDERS) == 3 and len(NOT) == 6,
      f"3 laddered pages, 6 refused, 1 not testable (got {len(LADDERS)} / "
      f"{len(NOT)} / {len(PAGES) - len(LADDERS) - len(NOT)})")
lo_rep = min(p[2]["repeats"] for p in LADDERS)
hi_rep = max(p[2]["repeats"] for p in NOT)
check((lo_rep, hi_rep) == (8, 1),
      f"repeats separates 8..42 from 1 (got ladders>={lo_rep}, "
      f"non-ladders<={hi_rep})")
# SHARE DOES NOT SEPARATE, and the comment must not claim it does: two of
# the six refused pages sit at exactly 0.5 (as does the crafted adversary),
# which MIN_SHARE does not reject - only their single repeat refuses them.
at_thresh = [p[0] for p in NOT if p[2]["share"] == 0.5]
check(len(at_thresh) == 2,
      f"2 refused pages sit exactly ON LADDER_MIN_SHARE - it does not reject "
      f"them, their single repeat does: {at_thresh}")
if ladder_verdict is not None:
    adv = ladder_verdict([324.0, 710.0, 826.0])
    check(adv["share"] == 0.5 and adv["repeats"] == 1 and not adv["laddered"],
          "...and so does the crafted adversary {324, 710, 826}")
check(min(p[2]["share"] for p in LADDERS) == 0.6,
      "the closest legitimate share is 0.60, clearing the 0.50 floor by 0.10")

# --------------------------------------------------------------------------
print("3. the constants, and why they are where they are")
# --------------------------------------------------------------------------
check(MIN_REPEATS == 2, f"LADDER_MIN_REPEATS is 2 (got {MIN_REPEATS})")
check(MIN_SHARE == 0.5, f"LADDER_MIN_SHARE is 0.5 (got {MIN_SHARE})")
check(BAND_MULT == 8.0, f"LADDER_BAND_MULT is 8 (got {BAND_MULT})")
# 2 is BELOW the corpus margin on purpose: the smallest population this
# codebase asserts must survive is the 3-value gap-OCR fixture in
# tests/test_gap_ocr_rows.py, repeats 2 of 2, and raising the floor to match
# the corpus separation would refuse a set whose every gap is the same step.
if ladder_verdict is not None:
    fx = ladder_verdict([3380.0, 3382.0, 3384.0])
    check(fx["repeats"] == 2 and fx["laddered"],
          "the pinned 3-row fixture ladders at repeats 2/2 - which is why "
          "the floor is 2 and not 8")
    check(not ladder_verdict([3380.0, 3382.0, 3384.0], min_repeats=3)["laddered"],
          "...and a floor of 3 would refuse it")
# the band multiplier, against the widest internal gap on each laddered page
for name, vals, want in LADDERS:
    v = ladder_verdict(vals)
    widest = max(b - a for a, b in zip(sorted(vals), sorted(vals)[1:]))
    check(v["n_bands"] == 1 and widest <= BAND_MULT * want["interval_ft"],
          f"{name}: widest internal gap {widest:g} ft = "
          f"{widest / want['interval_ft']:.1f}x its step, so it is one band")

# --------------------------------------------------------------------------
print("4. the comment beside the constants says what was measured")
# --------------------------------------------------------------------------
BLOCK = SRC[SRC.find("# --- LADDER: is a set of elevations"):
            SRC.find("def ladder_verdict(")]
for name, _vals, want in PAGES:
    key = name.split(" p")[0]
    check(key in BLOCK, f"the comment names {key}")
check("42/45" in BLOCK or "42 of 45" in BLOCK or "42" in BLOCK,
      "...with Oncor p4's 42 repeats")
check(re.search(r"\bNINE\b|\bnine\b", BLOCK) is not None,
      "the comment states the real denominator (nine firing pages), not three")
# e6ac867's wording, verbatim: "measured over every OCR-only page reachable
# here (a page qualifies only when NO row on it is glyph-backed; three of the
# corpus's grading sheets are)". Nine are.
for gone in ("three OCR-only pages", "THREE OCR-ONLY PAGES",
             "three of the corpus's grading sheets"):
    check(gone not in FLAT,
          f"the refuted count is gone from the source: {gone!r}")
check(not re.search(r"Barn C0\.00 p0\s+\{464, 535\}", FLAT),
      "the refuted 'Barn C0.00 {464, 535}, NOT TESTABLE' line is gone")
check("the gate never fires" not in FLAT,
      "the refuted 'the gate never fires on a native sheet' claim is gone")
check("Oncor engine page 4" in SRC,
      "...and the native sheet where it DOES fire is named instead")

print(("\n%d FAILED" % len(fails)) if fails else "\nall checks passed")
sys.exit(1 if fails else 0)
