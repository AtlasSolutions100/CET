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

  * Bryce Gurr p2 -> NO best, BOTH printed values (20.0 main, 5.0
    blowup) as candidates, why "abstained-ocr"
  * a healthy text-layer sheet (Home 2 Suites) is untouched: the rescue
    only runs when every existing path found nothing

MOVED BY STAGE 1b (SPEC 7.4, psm 6 in the bar zoom + the zoom running on
refused / non-native rows). Two of the sheets this file used to pin as
"no best" now read their DRAWN BAR, off tick geometry, before the rescue
is ever reached - which is the outcome the rescue's own docstring named
as its follow-up ("upgrading a candidate to best on independent
bar-geometry agreement"). Read off 400-dpi crops of the sheets
themselves, 2026-09-02:

  * Hurricane C.3.1 p2 prints a bar `0 40' 80'` over `SCALE: 1" = 40'`.
    Was: no best, rescued candidate 40.0, why "abstained-ocr".
    Now: best 40.0167 ft/in, source "graphic-bar", bar_source
    "psm6-zoom-ticks" - the same 40, measured off the drafter's ticks.
  * Hurricane C.3.5 p6 (the sampling-bias sheet) prints `0 40' 80'`
    over `HORIZ. SCALE: 1" = 40'` / `VERT. SCALE: 1" = 10'`.
    Was: no best, the KEY MAP's 1"=300' the only candidate.
    Now: best 40.0166 off the horizontal bar. The 7.5x key-map reading
    is not promoted and no longer needs to be - an independent reading
    of the horizontal bar exists.

The INVARIANT the file exists to protect is unchanged and is now
asserted on every sheet it reads: a candidate stamped
`ocr-caption-window` is never `best`.

RC Ontario p7/p8 (1"=10') USED to stay unread - its caption OCRs as
garbage in every window/psm tried and psm 11 shredded its `0 5 10 20`
ladder into `2`/`99`/`9`/`6`/`4`. Under psm 6 the ladder reads whole and
both pages return 10.0 off ticks; tests/test_scale_bar_psm6.py pins that.
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

    def never_rescued_best(r, who):
        """The invariant: an OCR-rescued caption is never the reading."""
        assert not (r.best is not None
                    and getattr(r.best, "origin", "") == "ocr-caption-window"), (
            f"{who}: a rescued caption became best ({r.best})")

    # C.3.1 p2: the drawn bar now reads (stage 1b), and it reads the same
    # 40 the rescue used to offer as a candidate. Printed: `0 40' 80'`
    # over `SCALE: 1" = 40'`.
    r = read("TakeoffPro AI/Plans 2/2026.02.13_Civil Design_HURRICANE STORAGE UNITS.pdf", 2)
    never_rescued_best(r, "C.3.1 p2")
    assert r.best is not None, "C.3.1 p2 lost its bar reading"
    assert abs(r.best.ft_per_paper_inch - 40.0) / 40.0 <= 0.02, r.best.text
    assert r.source == "graphic-bar", r.source
    assert r.pick.get("bar_source") == "psm6-zoom-ticks", r.pick

    r = read("TakeoffPro AI/Plans 2/Approved Construction Set_2-17-26 (2).pdf", 2)
    vals = sorted(round(c.ft_per_paper_inch, 2) for c in r.candidates)
    assert r.best is None, f"bryce must abstain on two values, picked {r.best}"
    assert vals == [5.0, 20.0], f"bryce candidates: {vals}"
    assert r.pick.get("why") == "abstained-ocr", r.pick

    never_rescued_best(r, "bryce p2")

    # the sampling-bias sheet: STORM PROFILE III prints HORIZ 40'/VERT 10'
    # plus a KEY MAP 1"=300'; only the key map survives OCR. The key map
    # must never be the reading - and since stage 1b the horizontal bar
    # gives an independent one, so the page reads 40 instead of nothing.
    r = read("TakeoffPro AI/Plans 2/2026.02.13_Civil Design_HURRICANE STORAGE UNITS.pdf", 6)
    never_rescued_best(r, "C.3.5 p6")
    got = None if r.best is None else round(r.best.ft_per_paper_inch, 2)
    assert got is not None and abs(got - 40.0) / 40.0 <= 0.02, (
        f"C.3.5 must read its HORIZ bar, never the key map's 300, got {got}")
    assert r.source == "graphic-bar", r.source

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
        print("corpus tests: 4 sheets passed (C.3.1 reads its bar, bryce "
              "abstains, C.3.5 reads its HORIZ bar not the key map, h2s "
              "untouched; no rescued caption is ever best)")
