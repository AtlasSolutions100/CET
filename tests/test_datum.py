"""The spot-elevation datum rule, pinned on synthetic pages.

Both failure directions have SHIPPED from this one plan set, so both are
pinned here symbolically:

  C3.1 shape - the legend note is RIGHT (7705.25) and the only band is a
  false two-label [7900] built from the legend's own sample text. Before the
  declared-datum feature existed, all 272 grades shipped exactly 200 ft high.
  A weak band must NOT veto the note.

  C3.3 shape - the note is a STALE boilerplate example (7605.25) while four
  contours printed on the drawing read 7720-7735. Declared-always-wins
  shipped 171 grades exactly 100 ft low, resolved, under a green banner. A
  strong band (>= 3 labels) MUST veto the note.

The prefix cannot distinguish the two: every datum line in the set, genuine
and stale alike, begins "EXAMPLE:". Band strength is the discriminator, and
either direction regressing means one of those two shipped defects is back.

Dependency-free like tests/test_gate.py:  python tests/test_datum.py
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from takeoff_engine.earthwork import read_spot_grades  # noqa: E402


def _word(x, y, text):
    """(x0, y0, x1, y1, text) - the pymupdf words tuple shape."""
    return (x, y, x + 30.0, y + 8.0, text)


def _line(text):
    """page_lines row: only [4] is read."""
    return (0, 0, 0, 0, text)


def _page(spot_values, full_elevs, note_value):
    """Synthetic page: FG spots, full elevations spread out, a legend note."""
    words = []
    y = 100.0
    for v in spot_values:
        words.append(_word(50.0, y, "FG:"))
        words.append(_word(82.0, y, f"{v:05.2f}"))
        y += 60.0
    x = 400.0
    for e in full_elevs:
        words.append(_word(x, 300.0, f"{e:.0f}"))
        x += 220.0
    lines = []
    if note_value is not None:
        lines.append(_line(
            f"NOTE: ALL SPOT ELEVATIONS ARE TRUNCATED CIVIL ELEVATIONS "
            f"(IE. EXAMPLE: TOP OF PATIO @ {note_value:.2f}' = FIN:05.25')"))
    return words, lines


CASES = []


def case(fn):
    CASES.append(fn)
    return fn


def _run(spot_values, full_elevs, note_value):
    words, lines = _page(spot_values, full_elevs, note_value)
    info = {}
    out = read_spot_grades(words, lines=lines, datum_info=info)
    return out, info


@case
def test_agreement_resolves_by_note():
    """Note 7705.25 and contours 77xx agree: note wins, no conflict."""
    out, info = _run([5.25, 18.89], [7720, 7725, 7730], 7705.25)
    assert info["conflict"] is False, info
    assert info["chosen"] == "declared", info
    assert [g["z"] for g in out] == [7705.25, 7718.89], out


@case
def test_c33_shape_strong_band_vetoes_stale_note():
    """Note says 7605.25, FOUR printed contours say 77xx: band wins."""
    out, info = _run([5.25, 18.89], [7720, 7725, 7730, 7735], 7605.25)
    assert info["conflict"] is True, info
    assert info["chosen"] == "band", info
    for g in out:
        assert g["resolved"], g
        assert 7700.0 <= g["z"] <= 7740.0, (g, "would have shipped 100 ft low")


@case
def test_c31_shape_weak_band_does_not_veto_note():
    """Note says 7705.25, only TWO labels (legend echo) say 79xx: note wins."""
    out, info = _run([5.25, 18.89], [7900, 7900.0 + 0.0], 7705.25)
    assert info["conflict"] is True, info
    assert info["chosen"] == "declared", info
    for g in out:
        assert g["resolved"], g
        assert 7700.0 <= g["z"] <= 7740.0, (g, "would have shipped 200 ft high")


@case
def test_conflict_is_always_reported():
    """Whichever side wins, a disagreement must reach datum_info.

    Spot values must SPAN the anchors' mod-100 residues: the band only admits
    an anchor whose value-mod-100 falls within [min(spot)-15, max(spot)+15],
    because an anchor is only evidence if it could be the full version of a
    truncated number on the page. C3.3's real spots span 05-35 against
    contours at 20-35, so these synthetic pages do the same.
    """
    _, weak = _run([5.25, 18.89], [7900, 7900], 7705.25)
    _, strong = _run([5.25, 18.89, 30.10], [7720, 7725, 7730, 7735], 7605.25)
    assert weak["conflict"] and strong["conflict"], (weak, strong)


@case
def test_no_note_falls_to_band():
    out, info = _run([5.25, 18.89, 30.10], [7720, 7725, 7730], None)
    assert info["declared"] is None
    assert info["chosen"] == "band"
    assert out[0]["resolved"] and abs(out[0]["z"] - 7705.25) < 30.0, out


@case
def test_nothing_resolves_to_unresolved():
    """No note, no band: honest blank, never a guess."""
    out, info = _run([5.25], [], None)
    assert info["chosen"] is None
    assert not out[0]["resolved"], out
    assert out[0]["z"] is None


@case
def test_printed_in_full_never_touched():
    """A 7718.89 printed in full keeps its printed value under any datum."""
    out, _ = _run([7718.89], [7720, 7725, 7730, 7735], 7605.25)
    assert out[0]["z"] == 7718.89


@case
def test_pe_tag_and_three_digit_full_site():
    """Stice shape: PE pad elevations on a 3-digit site resolve as printed.

    Coral Mountain (site 425-521 ft) prints ~200 "PE 466.0" pads; before
    2026-08-30 the PE tag was unknown and a 3-digit value could never be
    printed-in-full (the rule was >= 1000). Corroboration required: at
    least two page anchors within 100 ft, so a lone 466 on a 7,000-ft
    sheet still abstains.
    """
    words = []
    words.append((50.0, 100.0, 80.0, 108.0, "PE"))
    words.append((82.0, 100.0, 112.0, 108.0, "466.0"))
    x = 400.0
    for e in (452, 470, 480):          # the sheet's own full elevations
        words.append((x, 300.0, x + 30.0, 308.0, f"{e}"))
        x += 220.0
    out = read_spot_grades(words, lines=[])
    assert out and out[0]["tag"] == "PE", out
    assert out[0]["resolved"] and out[0]["z"] == 466.0, out
    # the same value with NO corroborating anchors must abstain
    out2 = read_spot_grades(words[:2], lines=[])
    assert not out2[0]["resolved"] and out2[0]["z"] is None, out2


def main() -> int:
    failed = []
    for fn in CASES:
        try:
            fn()
        except AssertionError as e:
            failed.append(f"{fn.__name__}: {e}")
        except Exception as e:                      # noqa: BLE001
            failed.append(f"{fn.__name__} ({e.__class__.__name__}: {e})")
    print(f"\n{len(CASES) - len(failed)}/{len(CASES)} datum tests passed")
    for f in failed:
        print(f"  FAILED  {f}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
