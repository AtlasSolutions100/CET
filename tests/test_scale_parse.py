"""Scale caption parsing - the ratio form, and thousands separators.

Audit A2: _PAT_KEYWORD's separator group admits ':', so "SCALE 1:100" was
read as paper=1 inch, ground=100 feet -> 100.0 ft per paper inch. The UI's
own hand-typed parser (webui/app.js parseScale) reads the same text the
standard ratio way - 1 unit of paper = 100 of the SAME unit on the ground,
(100/1)/12 = 8.333 ft/in - so the engine disagreed with its own UI 12x on
identical text. The fix reads a colon-related, unit-free match as a
dimensionless ratio; anything carrying a real unit mark keeps the feet
reading. The feet group also accepts thousands separators: "1:8,010"
truncated to feet=8 before.

Deliberately dependency-free, same as tests/test_gate.py:

    python tests/test_scale_parse.py

Needs no plan corpus - _scan is pure text in, candidates out.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from takeoff_engine.scale_detect import _scan  # noqa: E402


def one(text: str) -> float:
    """The single candidate's ft-per-paper-inch, asserting there IS one."""
    cs = _scan(text)
    assert len(cs) == 1, f"{text!r}: expected 1 candidate, got {cs!r}"
    return cs[0].ft_per_paper_inch


def close(a: float, b: float) -> bool:
    return abs(a - b) < 1e-3


# --- the ratio form (the A2 fix) -------------------------------------------

def test_ratio_bare_keyword():
    # was 100.0 - a 12x disagreement with the UI on identical text
    assert close(one("SCALE 1:100"), 100 / 12)   # 8.333


def test_ratio_keyword_colon():
    # the keyword's own colon (<kwsep>) must not confuse the ratio read
    assert close(one("SCALE: 1:100"), 100 / 12)


def test_ratio_thousands():
    # feet group used to stop at the comma: feet=8, not 8010
    assert close(one("SCALE 1:8,010"), 8010 / 12)   # 667.5


def test_ratio_text_verbatim():
    cs = _scan("SCALE 1:8,010")
    assert cs[0].text == "SCALE 1:8,010", cs[0].text


def test_ratio_needs_keyword():
    # a bare ratio with no SCALE keyword is not a caption (pipe slopes,
    # gradients and odds ratios all print as N:M mid-sheet)
    assert _scan("1:100") == []


def test_ratio_small():
    # metric-style detail ratio: 1:20 is 20 paper inches of ground / 12
    assert close(one("SCALE 1:20"), 20 / 12)   # 1.667


# --- units anywhere in the match keep the old feet reading -----------------

def test_colon_with_unit_marks_is_feet():
    assert close(one("1\" : 100'"), 100.0)


def test_colon_with_spelled_unit_is_feet():
    assert close(one("SCALE 1:100 FT"), 100.0)


def test_noise_stands_for_inch_mark():
    # OCR mangles the double prime to U+FFFD; the <noise> group stands in
    # for the inch mark, so this is NOT a dimensionless ratio
    assert close(one("SCALE: 1/4�=1'-0\""), 4.0)


def test_compound_suffix_is_not_ratio():
    # a feet-and-inches ground term is the architectural form, never a ratio
    assert close(one("SCALE 1:1'-0\""), 1.0)


# --- unchanged forms --------------------------------------------------------

def test_civil():
    assert close(one("1\" = 50'"), 50.0)


def test_keyword_bare_equals():
    # a real client sheet prints this form
    assert close(one("SCALE: 1 = 20"), 20.0)


def test_keyword_doubled_separator():
    # the OCR case _PAT_KEYWORD exists for
    assert close(one("SCALE: 1 = = 20"), 20.0)


def test_architectural():
    assert close(one("1/4\" = 1'-0\""), 4.0)


def test_architectural_mixed():
    assert close(one("1-1/2\" = 1'-0\""), 2 / 3)


def test_spelled_units():
    assert close(one("1 inch = 10 ft."), 10.0)


def test_ratio_first_ocr_order():
    # _PAT_KEYWORD_PRE: ratio before the keyword, inch mark present ->
    # units are declared, so the ratio interpretation must NOT hijack it
    assert close(one("1\" 10' SCALE:"), 10.0)


def test_hyphen_separator_is_feet():
    # only ':' signals the ratio form; a hyphen separator keeps feet
    assert close(one("SCALE 1-100"), 100.0)


# --- thousands separators in the FEET form stay inside the sane band -------

def test_feet_form_thousands_rejected_not_truncated():
    # before: feet stopped at the comma and a WRONG 8.0 candidate survived;
    # now the full 8010 is read, fails the 400 ft/in feet-form cap, and the
    # match is refused outright
    cs = _scan("SCALE: 1 = 8,010")
    assert cs == [], cs


def main():
    mod = sys.modules[__name__]
    tests = [getattr(mod, n) for n in dir(mod) if n.startswith("test_")]
    for t in tests:
        t()
        print(f"  ok  {t.__name__}")
    print(f"{len(tests)} tests passed")


if __name__ == "__main__":
    main()
