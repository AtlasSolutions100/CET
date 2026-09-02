"""A tick ladder is one printed LINE of digits, and psm 11 shreds it.

`text_detect.ocr_words` hard-coded `--psm 11` (Tesseract's "sparse text, no
particular order"). That is right for a plan sheet's scattered callouts and
wrong for the thing `graphic_scale_bar` needs most: the row of numbers over
a drawn scale bar. Measured 2026-09-02 on two RC Ontario sheets, at the
600-dpi zoom `graphic_scale_bar` already paid for:

  RC Ontario engine page index 7 (bar 144.0 pt, ticks 5/5/10 ft, printed
      `0 5 10 20` over `1" = 10' WHEN PRINTED AT FULL SIZE (24" X 36")`)
      psm 11 -> `2`, `99`, `9`, `6`, `4`, `4` - rows of one and two
                labels, every one refused by the >=3-label guard
      psm 6  -> `0 5 10 20`, conf 78/64/64/97, centred on the ticks
  RC Ontario engine page index 3 (printed `0 10 20 40` over `1" = 20'`)
      the 150-dpi full-page pass returns a THREE-label row `10 0 4`
      (the 20 read as 0, the 40 as 4). "Rows exist", so the old gate
      `if not rows and ocr_retry` skipped the zoom entirely, and the
      corrupt row then failed the rate check - the page returned nothing
      where the sheet draws a perfectly good bar.

So two things change together and this file pins both:

  1. `ocr_words(img, px_to_pt, min_conf, psm=11)` takes the mode, default
     unchanged; `_ocr_zoom` passes it through; only the bar zoom passes 6.
  2. the zoom runs when (a) no row was found, (b) rows were found and
     every guard refused them, or (c) the rows are not native text at all
     - the caller's own recogniser cannot be the second opinion on its own
     reading (SPEC 6.2 rule 2) - and a ladder that passes from the zoom is
     preferred over one that passes from the caller's words.

Two tests:

  1. frozen words + frozen tick geometry, no PDF and NO TESSERACT: the
     fixture's psm-11 window words, its psm-11 zoom, its psm-6 zoom and
     its `_page_ticks` strokes are driven through `graphic_scale_bar`
     with `_ocr_zoom` and `_page_ticks` stubbed. On 084f5eb the stub is
     called without a psm (the parameter does not exist), so it hands
     back the psm-11 ladder and both pages return None - the assertions
     fail on the VALUE, not on an import.
  2. the real pages, when RC Ontario.pdf is on disk. Skipped WITH A
     PRINTED REASON when it is not.

    python tests/test_scale_bar_psm6.py
"""

import inspect
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from takeoff_engine import scale_detect as sd  # noqa: E402

BASE = Path(__file__).resolve().parent / "baselines"
FIXTURES = ("rc-ontario_p7.json", "rc-ontario_p3.json")
PLANS = Path(os.environ.get(
    "TAKEOFF_PLANS",
    r"C:\Users\kobys\OneDrive\Desktop\past\P\Takeoff Automation\TakeoffPro AI"))


def _load(name):
    fx = json.loads((BASE / name).read_text(encoding="utf-8"))
    for k in ("words", "zoom_psm6", "zoom_psm11"):
        fx[k] = [tuple(w) for w in fx[k]]
    fx["ticks"] = [tuple(t) for t in fx["ticks"]]
    return fx


class _Page:
    """Stands in for a pymupdf page: `graphic_scale_bar` only needs it to be
    non-None once `_ocr_zoom` and `_page_ticks` are answered from the
    fixture."""


def bar_from_fixture(fx, ocr_retry=True, words=None):
    """`graphic_scale_bar` over frozen evidence, with the two page-touching
    helpers answered from the fixture. `_ocr_zoom` honours the psm it is
    called with, which is the whole point: at 084f5eb it is called without
    one and the psm-11 ladder comes back."""
    calls = []

    def fake_zoom(page, region, min_conf=35, psm=11):
        calls.append(psm)
        return list(fx["zoom_psm6"] if psm == 6 else fx["zoom_psm11"])

    def fake_ticks(page):
        return list(fx["ticks"])

    real_zoom, real_ticks = sd._ocr_zoom, sd._page_ticks
    sd._ocr_zoom, sd._page_ticks = fake_zoom, fake_ticks
    try:
        ws = fx["words"] if words is None else words
        kw = {}
        if "words_source" in inspect.signature(sd.graphic_scale_bar).parameters:
            kw["words_source"] = "ocr"
        return sd.graphic_scale_bar(ws, _Page(), ocr_retry=ocr_retry, **kw), calls
    finally:
        sd._ocr_zoom, sd._page_ticks = real_zoom, real_ticks


def test_ocr_words_default_psm_is_unchanged():
    """Every existing caller must be byte-identical: the parameter exists and
    its default is 11."""
    from takeoff_engine.text_detect import ocr_words
    sig = inspect.signature(ocr_words)
    assert "psm" in sig.parameters, "ocr_words gained no psm parameter"
    assert sig.parameters["psm"].default == 11, sig.parameters["psm"].default
    assert "psm" in inspect.signature(sd._ocr_zoom).parameters
    assert inspect.signature(sd._ocr_zoom).parameters["psm"].default == 11


def test_frozen_ladders_read_at_psm6():
    for name in FIXTURES:
        fx = _load(name)
        truth = fx["truth_bar_ft_per_paper_inch"]

        # the psm-6 zoom holds a >=3-label ladder; the counterfactual test
        # below shows the psm-11 evidence cannot produce the reading.
        rows6 = sd._label_rows(fx["zoom_psm6"])
        assert rows6, (name, "psm 6 produced no >=3-label row")

        bar, psms = bar_from_fixture(fx)
        assert 6 in psms, (name, "the bar zoom did not ask for psm 6", psms)
        assert bar is not None, (name, "no bar read from the frozen ladder")
        got = bar.ft_per_paper_inch
        assert abs(got - truth) / truth <= 0.02, (name, got, truth, bar.text)
        assert "ticks" in bar.text, (name, "not a tick-measured span", bar.text)
        assert getattr(bar, "bar_source", "") == "psm6-zoom-ticks", (
            name, getattr(bar, "bar_source", None))


def test_frozen_psm11_alone_still_fails():
    """The counterfactual, so the test cannot pass for the wrong reason: hand
    the same reader the psm-11 zoom for both modes and the pages go dark
    again - which is exactly what 084f5eb does."""
    for name in FIXTURES:
        fx = _load(name)
        fx11 = dict(fx)
        fx11["zoom_psm6"] = fx["zoom_psm11"]
        bar, _ = bar_from_fixture(fx11)
        got = None if bar is None else round(bar.ft_per_paper_inch, 4)
        truth = fx["truth_bar_ft_per_paper_inch"]
        assert got is None or abs(got - truth) / truth > 0.02, (
            name, "psm 11 alone should not have read this bar", got)


def test_p3_zoom_runs_although_rows_exist():
    """RC p3's own trap: the 150-dpi words DO form a >=3-label row (`10 0 4`),
    so the old `if not rows` gate skipped the zoom. The row is refused by the
    rate guard, so the page returned nothing."""
    fx = _load("rc-ontario_p3.json")
    rows = sd._label_rows(fx["words"])
    assert rows, "fixture no longer carries the corrupt 3-label row"
    assert any(len(r) >= 3 for r in rows), [len(r) for r in rows]
    vals = sorted(t[0] for r in rows for t in r)
    assert vals != sorted(set(vals)) or 4.0 in vals or 0.0 in vals, vals
    bar, psms = bar_from_fixture(fx)
    assert 6 in psms, ("the zoom must run even though rows exist", psms)
    assert bar is not None and abs(bar.ft_per_paper_inch - 20.0) < 1e-6, (
        None if bar is None else bar.text)


def test_real_pages_when_present():
    pdf = PLANS / "Plans" / "RC Ontario.pdf"
    if not pdf.is_file():
        print(f"  SKIP test_real_pages_when_present: {pdf} not on disk "
              f"(set TAKEOFF_PLANS); the frozen tests above still ran")
        return
    try:
        import pytesseract
        pytesseract.get_tesseract_version()
    except Exception as e:
        print(f"  SKIP test_real_pages_when_present: Tesseract not usable "
              f"({type(e).__name__}); the frozen tests above still ran")
        return
    import pymupdf
    doc = pymupdf.open(str(pdf))
    ran = 0
    for name in FIXTURES:
        fx = _load(name)
        idx = int(fx["source"].split("engine page index ")[1].split()[0])
        res = sd.detect_scale(doc[idx])
        truth = fx["truth_bar_ft_per_paper_inch"]
        got = None if res.best is None else res.best.ft_per_paper_inch
        assert got is not None, (name, "no reading", res.pick)
        assert abs(got - truth) / truth <= 0.02, (name, got, truth)
        assert res.source == "graphic-bar", (name, res.source)
        assert res.pick.get("bar_source") == "psm6-zoom-ticks", (name, res.pick)
        ran += 1
    doc.close()
    print(f"  ran detect_scale on {ran} of {len(FIXTURES)} real pages")


if __name__ == "__main__":
    fails = 0
    for fn in (test_ocr_words_default_psm_is_unchanged,
               test_frozen_ladders_read_at_psm6,
               test_frozen_psm11_alone_still_fails,
               test_p3_zoom_runs_although_rows_exist,
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
