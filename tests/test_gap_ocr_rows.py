"""Earthwork suggest: OCR-only labels become rows.

THE DEFECT (measured 2026-09-01, DEM-truth outline sheet
dem_hurricane_bench_a_pad_2ft_outline p0, whose every label is a glyph
outline so pymupdf returns 0 words): suggest_elevations built `cands` from
native words and returned [] BEFORE the gap_z merge, so the 17 label reads
the gap-OCR pass had cached (3376..3428) never became rows and /earthwork
answered 400 "each surface needs at least one labeled contour".

Pure, no PDF, dependency-free like tests/test_gate.py:

    python tests/test_gap_ocr_rows.py           # the tests
    python tests/test_gap_ocr_rows.py --dump    # print the native fixture's
                                                # rows as JSON (how the
                                                # 36e065f freeze was made)

Two halves:
  1. chains with breaks, words=[], a gap_z dict of plausible values -> rows
     come back, each how="gap-ocr" on the right chain, a sibling fragment
     inherits, an excluded chain gets nothing, and the 25-ft anchor rule
     still drops a lone impossible read once 6+ values exist. FAILS on
     36e065f (0 rows).
  2. the SAME chains with native words present return exactly what 36e065f
     returned - frozen below as FROZEN_36E065F, produced by running this
     file's --dump against `git archive 36e065f`. Byte-identical behaviour
     when cands is non-empty is the contract; the volume gate
     (tests/test_earthwork_regress.py) pins the rest.
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import numpy as np  # noqa: E402

from takeoff_engine.earthwork import suggest_elevations  # noqa: E402


class _Chain:
    def __init__(self, cid, pts, klass="solid", layer="C-TOPO", width=0.5,
                 color=(0.0, 0.0, 0.0), style_id=None):
        self.chain_id = cid
        self.pts = np.asarray(pts, float)
        d = np.diff(self.pts, axis=0)
        self.length = float(np.hypot(d[:, 0], d[:, 1]).sum())
        self.klass = klass
        self.layer = layer
        self.width = width
        self.color = list(color)
        self.style_id = style_id


def _hline(cid, y, x0=0.0, x1=200.0, step=4.0, skip=None, **kw):
    """Horizontal polyline, optionally with a break (skip=(xa, xb))."""
    xs = list(np.arange(x0, x1 + step / 2, step))
    if skip:
        xs = [x for x in xs if not (skip[0] < x < skip[1])]
    return _Chain(cid, [[x, y] for x in xs], **kw)


def _word(x, y, text, w=14.0, h=8.0):
    return (x - w / 2, y - h / 2, x + w / 2, y + h / 2, text)


def _chains():
    # three parallel contours 40 pt apart, each with a 30 pt label break,
    # and chain 4 continuing chain 3 end-to-end 8 pt past its last point
    # (same layer, same class: the pass-2 weld applies)
    return [
        _hline(1, 100.0, skip=(88.0, 118.0)),
        _hline(2, 140.0, skip=(88.0, 118.0)),
        _hline(3, 180.0, skip=(88.0, 118.0)),
        _hline(4, 180.0, x0=208.0, x1=400.0),
    ]


# the break centres, as gap_label_elevations would report them
_GAP = {1: (3380.0, 103.0, 100.0), 2: (3382.0, 103.0, 140.0),
        3: (3384.0, 103.0, 180.0)}


def _native_words():
    # chain 1: a native token in its own break (inline)
    # chain 2: a native token 12 pt off the line (radius, not on-line)
    # chain 3: no native token at all
    return [_word(103.0, 100.0, "3380"), _word(50.0, 152.0, "3382")]


def _by(rows):
    return {r["chain_id"]: r for r in rows}


# ---- 1. OCR-only population ------------------------------------------------

def test_ocr_only_rows():
    rows = suggest_elevations(_chains(), [], gap_z=dict(_GAP))
    by = _by(rows)
    assert len(rows) == 4, f"expected 4 rows (3 gap-ocr + 1 inherited), got {len(rows)}: {rows}"
    for cid, (v, cx, cy) in _GAP.items():
        assert cid in by, f"chain {cid} lost its gap-OCR read"
        assert by[cid]["z"] == v, (cid, by[cid])
        assert by[cid]["how"] == "gap-ocr", (cid, by[cid])
        assert by[cid]["dist"] == 0.5, (cid, by[cid])
        assert by[cid]["label_xy"] == [cx, cy], (cid, by[cid])
        assert by[cid]["label_tag"] is None
    assert by[4]["z"] == 3384.0 and by[4]["how"] == "inherited", by[4]
    assert rows == sorted(rows, key=lambda r: r["z"])


def test_ocr_only_respects_exclude():
    rows = suggest_elevations(_chains(), [], gap_z=dict(_GAP), exclude={2})
    by = _by(rows)
    assert 2 not in by, "an excluded chain took a gap-OCR row"
    assert set(by) == {1, 3, 4}, sorted(by)


def test_ocr_only_anchor_rule_drops_lone_misread():
    # 7 contours, six reads 3376..3386 plus one 5388 (the digit-flip the
    # understand phase saw for 3388): the 25-ft anchor rule needs 6+ values
    # and runs over the gap population alone - the 5388 stands alone and
    # goes, the six stay
    chains = [_hline(i, 100.0 + 40.0 * i, skip=(88.0, 118.0))
              for i in range(1, 8)]
    gap = {i: (3374.0 + 2.0 * i, 103.0, 100.0 + 40.0 * i) for i in range(1, 7)}
    gap[7] = (5388.0, 103.0, 380.0)
    rows = suggest_elevations(chains, [], gap_z=gap)
    by = _by(rows)
    assert 7 not in by, "5388 survived the anchor rule"
    assert sorted(by) == [1, 2, 3, 4, 5, 6], sorted(by)
    assert all(r["how"] == "gap-ocr" for r in rows)
    # ...and with only 5 values the rule is off (its 6+ floor), so the
    # misread STAYS: nothing stands in for the native band gate on an
    # OCR-only sheet - the row is disclosed as gap-ocr and no more
    gap5 = {i: gap[i] for i in (1, 2, 3, 4)}
    gap5[7] = gap[7]
    rows = suggest_elevations(chains, [], gap_z=gap5)
    assert 7 in _by(rows) and _by(rows)[7]["z"] == 5388.0


def test_no_words_no_gap_is_empty():
    assert suggest_elevations(_chains(), []) == []
    assert suggest_elevations(_chains(), [], gap_z={}) == []


# ---- 2. native population: frozen from 36e065f -----------------------------

# python tests/test_gap_ocr_rows.py --dump, run in `git archive 36e065f`
FROZEN_36E065F = [
    {"chain_id": 1, "z": 3380.0, "label_xy": [103.0, 100.0], "dist": 1.0,
     "how": "inline", "label_tag": None},
    {"chain_id": 2, "z": 3382.0, "label_xy": [103.0, 140.0], "dist": 0.5,
     "how": "gap-ocr", "label_tag": None},
    {"chain_id": 3, "z": 3384.0, "label_xy": [103.0, 180.0], "dist": 0.5,
     "how": "gap-ocr", "label_tag": None},
    {"chain_id": 4, "z": 3384.0, "label_xy": [103.0, 180.0], "dist": 999.0,
     "how": "inherited", "label_tag": None},
]


def _native_rows():
    return suggest_elevations(_chains(), _native_words(), gap_z=dict(_GAP))


def test_native_population_unchanged():
    assert FROZEN_36E065F is not None
    got = json.loads(json.dumps(_native_rows()))
    assert got == FROZEN_36E065F, json.dumps(got, indent=1)
    # and the sanity of what was frozen: the fixture exercises inline,
    # gap-ocr-over-far-radius and inherited at once
    by = _by(got)
    assert by[1]["how"] == "inline" and by[1]["z"] == 3380.0
    assert by[2]["how"] == "gap-ocr" and by[2]["z"] == 3382.0
    assert by[3]["how"] == "gap-ocr" and by[3]["z"] == 3384.0
    assert by[4]["how"] == "inherited" and by[4]["z"] == 3384.0


if __name__ == "__main__":
    if "--dump" in sys.argv:
        print(json.dumps(_native_rows(), indent=1))
        sys.exit(0)
    names = [n for n in dir() if n.startswith("test_")]
    for n in names:
        globals()[n]()
        print("ok", n)
    print(f"{len(names)} passed")
