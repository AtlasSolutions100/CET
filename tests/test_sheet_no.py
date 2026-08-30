"""read_sheet_number over real title blocks, plus corpus-free basics.

Dependency-free plain asserts, same reasons as test_gate.py:

    python tests/test_sheet_no.py

The synthetic tests need no plans, so CI can always run those. The document
tests resolve the corpus the same walk-up way the regress gate does and
print SKIP (exit 0) for any document this machine does not have.

Ground truth sources, per the accuracy contract:
- Beaumont Barn civil: the sheet-number audit map (task sheet SHEET-NO,
  audit item 12), with one correction made against rendered ink on
  2026-08-30 - engine page index 12 (printed sheet 13) titles itself
  "FOUNDATION DRAIN PLAN" but its SHEET NUMBER cell prints "C4.3"
  (render of the title-block corner at 2x, scratchpad barn_p12_corner.png;
  the audit had recorded "no C-token" for that page). Expected 15 printed
  numbers, and the reader must return exactly those 15.
- Kayden Springs u2: spot values C5.1 at idx 38 and C5.2 at idx 39 from the
  task sheet; the abstains asserted here (idx 0/6/16/30/37) were verified
  by rendering - those pages' bottom-right corners hold border lines and
  no text at all (kayden_p37_corner.png), so None is the truthful answer.
- Oncor: task sheet expects the C-04 family on p3; the reader returns
  C-01..C-09 across all 9 pages, asserted as measured.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pymupdf  # noqa: E402

from takeoff_engine import regress  # noqa: E402
from takeoff_engine.detect_page import read_sheet_number  # noqa: E402


# ---------------------------------------------------------------- synthetic

def test_blank_page_abstains():
    doc = pymupdf.open()
    pg = doc.new_page(width=612, height=792)
    assert read_sheet_number(pg) is None


def test_reads_corner_token_prefers_largest():
    doc = pymupdf.open()
    pg = doc.new_page(width=612, height=792)
    # the sheet number, large, in the title-block corner
    pg.insert_text((540, 770), "C3.1", fontsize=20)
    # a small cross-reference in the same corner must lose on size
    pg.insert_text((450, 700), "C2.0", fontsize=9)
    # big text in the corner that is not number-shaped must not match
    pg.insert_text((440, 640), "SITE PLAN", fontsize=24)
    # number-shaped text OUTSIDE the corner must not match
    pg.insert_text((50, 50), "C9.9", fontsize=40)
    assert read_sheet_number(pg) == "C3.1", read_sheet_number(pg)


def test_bare_integer_never_wins():
    # a lone revision-table "2" in the corner, even huge, is not a sheet
    # number - abstain beats a guess
    doc = pymupdf.open()
    pg = doc.new_page(width=612, height=792)
    pg.insert_text((560, 770), "2", fontsize=30)
    assert read_sheet_number(pg) is None


def test_tiny_reference_below_floor_abstains():
    # only a 5.6pt-style cross-reference in the corner: below the 8pt floor,
    # so the page abstains instead of promoting a reference to an identity
    doc = pymupdf.open()
    pg = doc.new_page(width=612, height=792)
    pg.insert_text((560, 780), "CF3.0", fontsize=5.6)
    assert read_sheet_number(pg) is None


# ---------------------------------------------------------------- documents

def _open(rel):
    """corpus_path walk-up, but SKIP (None) instead of SystemExit."""
    try:
        return pymupdf.open(regress.corpus_path(rel))
    except (SystemExit, RuntimeError):
        return None


BARN = "../client_meet/beaumont/SWR_Barn_Residence_-_Civil_4.7.26.pdf"
BARN_EXPECT = {
    0: "C1.0", 1: "C2.0", 2: "C3.0", 3: "C3.1", 4: "C3.2", 5: "C3.3",
    6: "C3.4", 7: "C3.5", 8: "C3.6", 9: "C4.0", 10: "C4.1", 11: "C4.2",
    12: "C4.3",  # foundation drain plan; its SHEET NUMBER cell prints C4.3
    13: "C5.0", 14: "C5.1",
}


def test_barn_all_15_pages():
    doc = _open(BARN)
    if doc is None:
        print("SKIP barn: corpus not found beside the repo")
        return
    assert len(doc) == 15, f"expected 15 pages, PDF has {len(doc)}"
    got = {i: read_sheet_number(doc[i]) for i in range(len(doc))}
    for i in range(len(doc)):
        mark = "" if got[i] == BARN_EXPECT[i] else \
            f"   <-- expected {BARN_EXPECT[i]}"
        print(f"  barn idx{i:2} (printed sheet {i + 1}) -> {got[i]}{mark}")
    bad = {i: (got[i], BARN_EXPECT[i]) for i in got if got[i] != BARN_EXPECT[i]}
    assert not bad, f"(got, expected) by index: {bad}"
    print("  barn: 15/15 printed sheet numbers read")


def test_kayden_spots():
    p = Path(r"C:/Users/kobys/takeoff-plans/kayden-springs-u2.pdf")
    if not p.exists():
        print("SKIP kayden: C:/Users/kobys/takeoff-plans not on this machine")
        return
    doc = pymupdf.open(str(p))
    got = {i: read_sheet_number(doc[i]) for i in range(len(doc))}
    assert got[38] == "C5.1", got[38]
    assert got[39] == "C5.2", got[39]
    # section-divider pages whose bottom-right corner is verified empty of
    # text (border ink only): the reader must abstain, not invent
    for i in (0, 6, 16, 30, 37):
        assert got[i] is None, (i, got[i])
    n = sum(1 for v in got.values() if v)
    print(f"  kayden: token on {n}/{len(doc)} pages "
          f"(abstains: {sorted(i for i, v in got.items() if v is None)})")


def test_oncor_family():
    doc = _open("../TakeoffPro AI/"
                "Oncor Cloudcrest Substation Civils - 20251212.pdf_safe.pdf")
    if doc is None:
        print("SKIP oncor: corpus not found beside the repo")
        return
    got = {i: read_sheet_number(doc[i]) for i in range(len(doc))}
    assert got[3] == "C-04", got[3]
    expect = {i: f"C-{i + 1:02d}" for i in range(len(doc))}
    assert got == expect, {i: (got[i], expect[i])
                           for i in got if got[i] != expect[i]}
    print(f"  oncor: {len(doc)}/{len(doc)} pages read C-01..C-{len(doc):02d}")


if __name__ == "__main__":
    test_blank_page_abstains()
    test_reads_corner_token_prefers_largest()
    test_bare_integer_never_wins()
    test_tiny_reference_below_floor_abstains()
    test_barn_all_15_pages()
    test_kayden_spots()
    test_oncor_family()
    print("test_sheet_no: OK")
