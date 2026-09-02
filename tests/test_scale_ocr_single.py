"""An OCR-read caption is promoted only when an INDEPENDENT bar agrees.

`detect_scale`'s OCR path ranked whatever captions Tesseract managed to
recover and promoted the winner. A ranker can only see the candidates a
reader recovered and has no way to know which it dropped, so "the single
surviving value" is not "the single printed value" - CLAUDE.md section 5,
fourth shape. Measured live on this branch, 2026-09-02, with the bar read
at psm 6 (stage 1b) so the sheets' own evidence is finally available:

  RC Ontario engine page index 10 promotes 10 ft/in off a DETAIL 1
      caption (`1" = 10' WHEN PRINTED AT FULL SIZE`). The sheet's own
      GRAPHIC SCALE draws `0 10 20 40` under `1" = 20'`. 2x on every
      length, 4x on every area.
  Hurricane Storage engine page index 1 (SITE PLAN) promotes 1.0 ft/in
      off a detail's `1" = 1'-0"`; the site plan's bar draws `0 40' 80'`
      under `SCALE: 1" = 40'`. 40x low.
  Hurricane Storage engine page index 3 promotes 10 where the sheet
      prints `SCALE: 1" = 40'`. 4x low.

The rule (SPEC 6.2 rule 1 for what "independent" means): a bar corroborates
an OCR caption only when its ladder came from somewhere the caption did NOT
- the PDF's own text, the psm-6 pixel zoom, or drawn tick geometry with an
endpoint label from one of those. A ladder read by the same 150-dpi psm-11
pass that produced the caption is one recogniser, one render, one mistake,
and the rate guard cannot catch it because the guard derives its rate from
those same labels.

A caption an independent bar CONTRADICTS is refused: `best` is None, the
candidates stay on view, and `pick["values_refused"]` names the value that
was not promoted. Refusing is not going quiet - `ScaleResult.to_dict`
serialises the page with `abstained` true, `detect_page` routes it to
`scale_suggestions`, and accepting the value there is one click recorded
as a REVIEWER decision (tests/test_scale_suggestions.py).

Where NO independent bar exists at all the reading is kept and stamped
`pick["corroborated"] = False`. That is a deliberate narrowing of SPEC 7.5,
which asks for an abstention there too; the measured reason is in
`_ocr_promotion`'s docstring (over the 6,460-page OCR sweep the strict rule
abstains 77 such pages, and four of the five checked against crops were
already right). This file pins BOTH halves, so the narrowing cannot be
widened or dropped by accident without a test saying so.

Two tests:

  1. frozen: each fixture's recovered caption value, its psm-6 zoom ladder
     and its `_page_ticks` strokes are driven through `_ocr_promotion` with
     the two page-touching helpers stubbed - no PDF, no Tesseract. On
     084f5eb `_ocr_promotion` does not exist and the fallback composes the
     line that commit actually runs (`ScaleResult(best, cands, nts, "ocr",
     pick=pick)`), so the assertions fail on the VALUE.
  2. the real pages, when the plan corpus is on disk. Skipped WITH A
     PRINTED REASON when it is not.

A NOTE ON C.3.5, honestly. The brief expected this file to pin C.3.5 p6 as
`best None` with the key map's 300 in `values_refused`. It does not, and
the reason is stage 1b: that page's HORIZONTAL bar now reads 40.0166 off
its own ticks BEFORE the caption rescue is reached, so the page returns a
correct reading rather than an abstention and the 300 is never a candidate
at all. The frozen half below still drives C.3.5's OWN ladder and ticks
against the 300 its 2026-09-01 OCR recovered, because that is the rule the
sheet motivated; the real-page half pins what the sheet now does. Both
assert the thing that matters: 300 is never the reading.

    python tests/test_scale_ocr_single.py
"""

import inspect
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from takeoff_engine import scale_detect as sd  # noqa: E402
from takeoff_engine.scale_detect import (  # noqa: E402
    ScaleCandidate, ScaleResult, _rank)

try:
    from takeoff_engine.scale_detect import _ocr_promotion
except ImportError:      # 084f5eb: the OCR path promotes unconditionally
    _ocr_promotion = None

BASE = Path(__file__).resolve().parent / "baselines"
PLANS = Path(os.environ.get(
    "TAKEOFF_PLANS",
    r"C:\Users\kobys\OneDrive\Desktop\past\P\Takeoff Automation\TakeoffPro AI"))

RC = PLANS / "Plans" / "RC Ontario.pdf"
HUR = (PLANS / "Plans 2"
       / "2026.02.13_Civil Design_HURRICANE STORAGE UNITS.pdf")


class _Page:
    """Non-None stand-in; the page-touching helpers are stubbed."""


def _load(name):
    fx = json.loads((BASE / name).read_text(encoding="utf-8"))
    for k in ("words", "zoom_psm6", "zoom_psm11"):
        fx[k] = [tuple(w) for w in fx[k]]
    fx["ticks"] = [tuple(t) for t in fx["ticks"]]
    return fx


def promote(fx, cands):
    """detect_scale's OCR promotion over frozen evidence.

    Through `_ocr_promotion` where it exists; on the baseline commit the
    one line that commit runs, so the assertions fail on the VALUE rather
    than on an import."""
    ws = fx["words"]
    best, pick = _rank(cands, None, ws)

    def fake_zoom(page, region, min_conf=35, psm=11):
        return list(fx["zoom_psm6"] if psm == 6 else fx["zoom_psm11"])

    def fake_ticks(page):
        return list(fx["ticks"])

    real_zoom, real_ticks = sd._ocr_zoom, sd._page_ticks
    sd._ocr_zoom, sd._page_ticks = fake_zoom, fake_ticks
    try:
        if _ocr_promotion is None:
            return ScaleResult(best, cands, False, "ocr", pick=pick)
        return _ocr_promotion(best, cands, False, pick, _Page(), [], ws)
    finally:
        sd._ocr_zoom, sd._page_ticks = real_zoom, real_ticks


# (fixture, the value the OCR path recovered, what the drawn bar says)
FROZEN = [
    ("rc-ontario_p10.json", 10.0, 20.0,
     "a DETAIL 1 caption against the sheet's own 1\" = 20' bar"),
    ("hurricane-c35_p6.json", 300.0, 40.0,
     "the KEY MAP's 1\"=300' against the sheet's own HORIZ 1\" = 40' bar"),
]


def test_frozen_contradicted_caption_abstains():
    for name, refused, barval, why in FROZEN:
        fx = _load(name)
        cands = [ScaleCandidate(f'1" = {refused:g}\'', refused, True)]
        res = promote(fx, cands)

        assert res.best is None, (name, why, "promoted", res.best)
        assert res.pick.get("why") == "abstained-ocr-single", (name, res.pick)
        assert res.pick.get("values_refused") == [refused], (name, res.pick)
        # the candidate is still on view - abstaining is not deleting
        vals = sorted(round(c.ft_per_paper_inch, 4) for c in res.candidates)
        assert vals == [refused], (name, vals)
        # and the evidence that refused it is present, with its provenance
        assert res.bar_ft_per_paper_inch is not None, (name, "no bar recorded")
        assert abs(res.bar_ft_per_paper_inch - barval) / barval <= 0.02, (
            name, res.bar_ft_per_paper_inch, barval)
        assert res.pick.get("bar_source") == "psm6-zoom-ticks", (name, res.pick)
        # serialised, the page offers no number as the scale in force
        d = res.to_dict()
        assert d and d.get("abstained") is True, (name, d)
        assert d["ft_per_paper_inch"] is None, (name, d)


def test_frozen_agreeing_caption_is_still_promoted():
    """The rule must not eat the pages it has no quarrel with: a caption the
    drawn bar backs keeps its reading, gains `agrees`, and says which
    recogniser read the bar."""
    fx = _load("rc-ontario_p10.json")
    cands = [ScaleCandidate('1" = 20\'', 20.0, True)]
    res = promote(fx, cands)
    assert res.best is not None and res.best.ft_per_paper_inch == 20.0, res.best
    assert res.agrees is True, (res.agrees, res.bar_ft_per_paper_inch)
    assert res.pick.get("bar_source") == "psm6-zoom-ticks", res.pick
    assert res.pick.get("why") == "single", res.pick


def test_independence_refuses_the_callers_own_ocr():
    """SPEC 6.2 rule 1: a ladder the SAME psm-11 pass read is not a second
    opinion. Hand the promotion a page whose only bar comes from the caller's
    own OCR words and it must not be counted as corroboration, even when the
    numbers agree - the page reads UNCORROBORATED, not `agrees True`."""
    if _ocr_promotion is None:
        print("  (baseline commit: no independence rule to exercise)")
        return
    fx = _load("rc-ontario_p10.json")
    # the zooms are taken away; only the caller's own words remain
    fx_own = dict(fx)
    fx_own["zoom_psm6"] = []
    fx_own["zoom_psm11"] = []
    fx_own["words"] = list(fx["zoom_psm6"])      # the ladder, as psm-11 words
    bar = sd.graphic_scale_bar(fx["zoom_psm6"], None)
    assert bar is not None, ("the ladder itself must be readable, else the "
                             "test proves nothing")
    cands = [ScaleCandidate('1" = 20\'', 20.0, True)]
    res = promote(fx_own, cands)
    assert res.pick.get("corroborated") is False, (
        "a bar from the caption's own OCR pass was counted as a second "
        "opinion", res.pick)
    assert res.pick.get("bar_source") is None, res.pick
    assert res.agrees is not True, res.agrees
    assert res.bar_ft_per_paper_inch is None, res.bar_ft_per_paper_inch


def test_uncorroborated_caption_is_kept_and_says_so():
    """The narrowing, pinned: with no bar of any kind on the page the OCR
    caption still reads - and the result says nothing checked it. Removing
    this arm is what SPEC 7.5 asks for and what the corpus sweep refused;
    changing it must break a test, not 77 pages quietly."""
    if _ocr_promotion is None:
        print("  (baseline commit: nothing to stamp)")
        return
    fx = _load("rc-ontario_p10.json")
    blank = dict(fx)
    blank["zoom_psm6"] = []
    blank["zoom_psm11"] = []
    blank["words"] = []
    blank["ticks"] = []
    cands = [ScaleCandidate('1" = 50\'', 50.0, True)]
    res = promote(blank, cands)
    assert res.best is not None and res.best.ft_per_paper_inch == 50.0, res.best
    assert res.pick.get("corroborated") is False, res.pick
    assert res.pick.get("why") == "single", res.pick
    assert res.agrees is None and res.bar_ft_per_paper_inch is None, (
        res.agrees, res.bar_ft_per_paper_inch)


def _skip(msg):
    print(f"  SKIP {msg}")


def test_real_pages_when_present():
    if not RC.is_file() or not HUR.is_file():
        _skip(f"test_real_pages_when_present: plan corpus not at {PLANS} "
              f"(set TAKEOFF_PLANS); the frozen tests above still ran")
        return
    try:
        import pytesseract
        pytesseract.get_tesseract_version()
    except Exception as e:
        _skip(f"test_real_pages_when_present: Tesseract not usable "
              f"({type(e).__name__}); the frozen tests above still ran")
        return
    import pymupdf

    # RC Ontario p10: the DETAIL 1 caption is refused and the bar says so
    doc = pymupdf.open(str(RC))
    res = sd.detect_scale(doc[10])
    doc.close()
    assert res.best is None, ("RC p10 still promotes a contradicted caption",
                              res.best)
    assert res.pick.get("why") == "abstained-ocr-single", res.pick
    assert res.pick.get("values_refused") == [10.0], res.pick
    assert res.bar_ft_per_paper_inch is not None
    assert abs(res.bar_ft_per_paper_inch - 20.0) <= 0.4, res.bar_ft_per_paper_inch
    assert res.pick.get("bar_source") == "psm6-zoom-ticks", res.pick
    assert [round(c.ft_per_paper_inch, 4) for c in res.candidates] == [10.0], (
        [c.text for c in res.candidates])

    # Hurricane C.3.5 p6: the key map's 300 is never the reading. Since
    # stage 1b the page reads its own HORIZONTAL bar instead of abstaining.
    doc = pymupdf.open(str(HUR))
    res = sd.detect_scale(doc[6])
    doc.close()
    got = None if res.best is None else res.best.ft_per_paper_inch
    assert got is None or abs(got - 300.0) > 1.0, ("C.3.5 promoted the key map",
                                                   got)
    assert got is not None and abs(got - 40.0) / 40.0 <= 0.02, (
        "C.3.5 should read its HORIZ bar", got, res.pick)
    assert res.source == "graphic-bar", res.source
    assert res.pick.get("bar_source") == "psm6-zoom-ticks", res.pick

    # Hurricane p1 (SITE PLAN): the 40x-low detail caption is refused
    doc = pymupdf.open(str(HUR))
    res = sd.detect_scale(doc[1])
    doc.close()
    assert res.best is None, ("Hurricane p1 still promotes 1.0 ft/in on a "
                              "site plan the bar reads at 40", res.best)
    assert res.pick.get("why") == "abstained-ocr-single", res.pick
    assert 1.0 in (res.pick.get("values_refused") or []), res.pick
    assert res.bar_ft_per_paper_inch is not None and abs(
        res.bar_ft_per_paper_inch - 40.0) / 40.0 <= 0.02, res.bar_ft_per_paper_inch
    print("  ran detect_scale on 3 real pages (RC p10, C.3.5 p6, HUR p1)")


if __name__ == "__main__":
    fails = 0
    for fn in (test_frozen_contradicted_caption_abstains,
               test_frozen_agreeing_caption_is_still_promoted,
               test_independence_refuses_the_callers_own_ocr,
               test_uncorroborated_caption_is_kept_and_says_so,
               test_real_pages_when_present):
        try:
            fn()
            print("  ok  " + fn.__name__)
        except AssertionError as e:
            fails += 1
            print("  FAIL " + fn.__name__ + ": " + str(e))
        except Exception as e:
            fails += 1
            print(f"  FAIL {fn.__name__}: {type(e).__name__}: {e}")
    if fails:
        print(f"{fails} FAILED")
        sys.exit(1)
    print("5 tests passed")
