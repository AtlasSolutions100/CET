"""OCR caption-window rescue — outline-text sheets (FABLE-002).

The 150-dpi full-page OCR pass reads a stylised caption only partially
(Hurricane C.3.1 comes back 'SCALE: = 40' with the 1" dropped), so
detect_scale returned no reading on 296 of 728 plan-like corpus pages.
_ocr_caption_rescue re-reads small windows around the surviving caption
heads at high dpi and scans the reassembled rows.

Pure parts run everywhere:

    python tests/test_scale_ocr_rescue.py

The corpus half needs the plan corpus AND a Tesseract install; it is
skipped (with a message, not silently) when either is missing. These
assertions pin the MEASURED 2026-09-01 behaviour on the three
vector-outline earthwork ground-truth sheets:

  * Hurricane C.3.1 p2 -> NO best, candidate 40.0 ft/in, source "ocr",
    why "abstained-ocr". A rescued caption NEVER becomes best - measured
    the night this was built, promotion was confidently wrong twice by
    two different mechanisms (Thielen's eaten unit mark; Hurricane
    C.3.5 where only the KEY MAP's 1"=300' survived OCR while the
    sheet's HORIZ 40'/VERT 10' did not - "single" by sampling bias,
    7.5x wrong)
  * Bryce Gurr p2 -> NO best, BOTH printed values (20.0 main, 5.0
    blowup) as candidates, why "abstained-ocr"
  * Hurricane C.3.5 p6 (the sampling-bias sheet) -> NO best
  * a healthy text-layer sheet (Home 2 Suites) is untouched: the rescue
    only runs when every existing path found nothing

RC Ontario p7/p8 (1"=10') stays unread - its caption OCRs as garbage in
every window/psm tried and its bar shows only the 0 and 20 endpoint
labels, which graphic_scale_bar's guards refuse. Diagnosed, not fixed;
asserting nothing about it here.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import re  # noqa: E402

from takeoff_engine.scale_detect import (  # noqa: E402
    _OCR_ONE_CONFUSION, _ground_value_marked, _scan)


# --- pure: the one-glyph confusion and detached-mark normalisation ---------

def normalised(row: str) -> str:
    row = re.sub(r"(\d)\s+(?=[\"“”″])", r"\1", row)
    return _OCR_ONE_CONFUSION.sub("1", row)


def test_confusion_bar_for_one():
    # measured verbatim on Approved Construction Set p2
    row = normalised("SCALE: |\"=20'")
    cs = _scan(row)
    assert len(cs) == 1 and abs(cs[0].ft_per_paper_inch - 20.0) < 1e-6, cs


def test_detached_inch_mark():
    # measured shape on Hurricane C.3.1 (marks came back as their own token)
    row = normalised('SCALE: 1 " 40" =')
    cs = _scan(row)
    assert len(cs) == 1 and abs(cs[0].ft_per_paper_inch - 40.0) < 1e-6, cs


def test_bare_pipe_not_rewritten():
    # a | that is not glued to a quote mark must stay untouched
    assert normalised("A | B") == "A | B"


def test_unmarked_ground_value_refused():
    # Thielen ID-1.04 prints SCALE: 1/4" = 1'0"; OCR eats the '0" tail and
    # returns 'SCALE: 1/4" = 10', which _scan reads as 40 ft/in - 10x the
    # truth. The rescue must refuse any ground value with no unit mark.
    assert not _ground_value_marked('SCALE: 1/4” = 10')
    assert not _ground_value_marked('SCALE: 1/4” = 1')
    # ...and must keep the marked forms, either quote kind
    assert _ground_value_marked('SCALE: 1” 40”')      # foot mark read as "
    assert _ground_value_marked('1"=20\'')
    assert _ground_value_marked('1/8"=1\'-0"')
    assert _ground_value_marked('SCALE: 1/2”=1-0"')


# --- corpus: the three outline sheets and one healthy control --------------

def corpus_root():
    for up in [Path(__file__).resolve().parent.parent, *Path(__file__).resolve().parents]:
        if (up / "TakeoffPro AI").is_dir():
            return up
    return None


def tesseract_available() -> bool:
    return Path(r"C:/Program Files/Tesseract-OCR/tesseract.exe").exists()


def corpus_tests(root: Path):
    import pymupdf
    from takeoff_engine.scale_detect import detect_scale

    def read(rel, pno):
        doc = pymupdf.open(root / rel)
        try:
            return detect_scale(doc[pno])
        finally:
            doc.close()

    r = read("TakeoffPro AI/Plans 2/2026.02.13_Civil Design_HURRICANE STORAGE UNITS.pdf", 2)
    vals = sorted(round(c.ft_per_paper_inch, 2) for c in r.candidates)
    assert r.best is None, f"a rescued caption must never be best, got {r.best}"
    assert vals == [40.0], f"hurricane candidates: {vals}"
    assert r.source == "ocr" and r.pick.get("why") == "abstained-ocr", (r.source, r.pick)

    r = read("TakeoffPro AI/Plans 2/Approved Construction Set_2-17-26 (2).pdf", 2)
    vals = sorted(round(c.ft_per_paper_inch, 2) for c in r.candidates)
    assert r.best is None, f"bryce must abstain on two values, picked {r.best}"
    assert vals == [5.0, 20.0], f"bryce candidates: {vals}"
    assert r.pick.get("why") == "abstained-ocr", r.pick

    # the sampling-bias sheet: STORM PROFILE III prints HORIZ 40'/VERT 10'
    # plus a KEY MAP 1"=300'; only the key map survives OCR. Whatever the
    # candidates, there must be NO best.
    r = read("TakeoffPro AI/Plans 2/2026.02.13_Civil Design_HURRICANE STORAGE UNITS.pdf", 6)
    assert r.best is None, f"C.3.5 must not pick (key-map bias), got {r.best}"

    r = read("TakeoffPro AI/Plans 2/Home_2_Suites_Cedar_City_-_Division_31_-_Earthwork_Civil_2026-03-06 (1)/C3-Grading-Plan-Rev.0.pdf", 0)
    assert r.best is not None and abs(r.best.ft_per_paper_inch - 20.0) < 1e-6
    assert r.source == "text", f"healthy sheet must stay text-sourced: {r.source}"


if __name__ == "__main__":
    test_confusion_bar_for_one()
    test_detached_inch_mark()
    test_bare_pipe_not_rewritten()
    test_unmarked_ground_value_refused()
    print("pure tests: 4 passed")
    root = corpus_root()
    if root is None:
        print("SKIP corpus tests: 'TakeoffPro AI' not found above the repo")
    elif not tesseract_available():
        print("SKIP corpus tests: Tesseract not installed")
    else:
        corpus_tests(root)
        print("corpus tests: 4 sheets passed (hurricane abstain-w-candidate, bryce abstain, C.3.5 no pick, h2s untouched)")
