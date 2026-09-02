"""A caption welded to a bar tick label across a line break is not a reading.

The defect, measured 2026-09-02 on two public plan sets (Walsh Engineering &
Surveying grading plans, San Diego County CEQA postings):

  sundale-road-30366.pdf engine page index 1 (printed SHEET 2, GRADING PLAN)
      prints  SCALE: 1"=30'  under a bar ticked 30'-15'-0-30'-60'-90'.
      Read as 90.0 ft/in - "single", one candidate, text '1"=\\n90''.
  harbison-canyon-21316.pdf engine page index 0
      prints  SCALE: 1"= 60'  under a bar ticked 60'-30'-0-60'-120'-180'.
      Read as 180.0 ft/in - "single", text '1"=\\n180''.

Mechanism, in the words (tests/baselines/*.json freeze them): `SCALE:` and
`1"=` are one text block, the caption's own number is a SEPARATE block on the
same printed row 1.8 pt to the right, and the bar's tick labels are a third
block emitted BETWEEN them - last label first. page.get_text() therefore
reads `1"=` + newline + `90'`, `_scan`'s `\\s*` walks the newline, `_rank`
sees one value and calls it "single", and `_corroborate` - purely additive
by design - records the bar's 30.0 and a 200% delta and changes nothing.
3x on every length, 9x on every area and volume, shipped green.

CLAUDE.md section 5, fourth shape: what was extracted is not what is
printed. The fix (`read_text_layer`) refuses a get_text() candidate whose
number sits across a line break from its paper term AND is one of the drawn
bar's own tick labels, keeps it in the candidates stamped
`text-linebreak-join`, and lets the page fall through to the row-assembled
text - which reads `1"= 30'` off the same words - or the bar, or abstain.

Two tests:

  1. frozen words, no PDF, no rendering: the fixture's get_text() lines and
     word tuples are driven through the text-layer reading. FAILS on a35f971
     (best == 90.0 / 180.0).
  2. the real pages, when the PDFs are on disk under
     %TAKEOFF_PUBLIC_PLANS% (default C:\\Users\\kobys\\takeoff-plans\\public-ceqa):
     detect_scale end to end. Skipped WITH A PRINTED REASON when absent.

    python tests/test_scale_bar_contradiction.py
"""

import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from takeoff_engine.scale_detect import (  # noqa: E402
    ScaleResult, _corroborate, _rank, _scan, graphic_scale_bar)

try:
    from takeoff_engine.scale_detect import read_text_layer, ORIGIN_JOIN_ARTEFACT
except ImportError:      # a35f971: the text path is composed inline below
    read_text_layer = None
    ORIGIN_JOIN_ARTEFACT = "text-linebreak-join"

BASE = Path(__file__).resolve().parent / "baselines"
FIXTURES = ("sundale-road-30366_p1.json", "harbison-canyon-21316_p0.json")
PLANS = Path(os.environ.get("TAKEOFF_PUBLIC_PLANS",
                            r"C:\Users\kobys\takeoff-plans\public-ceqa"))


def _load(name):
    fx = json.loads((BASE / name).read_text(encoding="utf-8"))
    fx["words"] = [tuple(w) for w in fx["words"]]
    return fx


def _text_layer(text, words):
    """The text-layer reading as detect_scale composes it: get_text() scan,
    rank, corroborate. Through `read_text_layer` where it exists; on the
    baseline commit the same three calls inline, so the assertions below
    fail on the VALUE rather than on an import."""
    if read_text_layer is not None:
        return read_text_layer(text, words)
    cands = _scan(text)
    best, pick = _rank(cands, None, words)
    return _corroborate(ScaleResult(best, cands, False, "text", pick=pick),
                        words)


def _tick_span_ft_per_inch(fx):
    """The bar as the drawn ticks measure it, from the frozen geometry
    alone: the 0 label's tick to the largest label's tick."""
    labels = []
    for w in fx["words"]:
        t = str(w[4]).rstrip("'")
        if t.isdigit() and float(w[3]) < fx["caption_at"][1] - 15:
            labels.append((float(t), (float(w[0]) + float(w[2])) / 2))
    zero = next(x for v, x in labels if v == 0)
    vmax, xmax = max(labels)
    xs = [t[0] for t in fx["bar_ticks"]]
    t0 = min(xs, key=lambda x: abs(x - zero))
    t1 = min(xs, key=lambda x: abs(x - xmax))
    return 72.0 * vmax / abs(t1 - t0), abs(t1 - t0)


def test_frozen_words_refuse_the_join():
    for name in FIXTURES:
        fx = _load(name)
        truth, artefact = fx["truth_ft_per_paper_inch"], fx["join_artefact_ft_per_paper_inch"]
        # the mechanism, pinned: get_text() order alone yields the artefact
        got = sorted(c.ft_per_paper_inch for c in _scan(fx["get_text_lines"]))
        assert got == [artefact], (name, got)
        # and the frozen tick geometry says what the bar really draws
        fpi, span = _tick_span_ft_per_inch(fx)
        assert abs(fpi - truth) / truth < 0.01, (name, fpi, span)

        res = _text_layer(fx["get_text_lines"], fx["words"])
        assert res is not None, name
        b = res.best.ft_per_paper_inch if res.best else None
        assert b != artefact, (name, "still promotes the join artefact", b)
        if b is not None:
            assert abs(b - truth) < 1e-6, (name, "best", b, "truth", truth)
        vals = {round(c.ft_per_paper_inch, 4): c for c in res.candidates}
        # the caption's own reading is on view ...
        assert truth in vals, (name, sorted(vals))
        assert '1"=' in vals[truth].text, (name, vals[truth].text)
        # ... and the refused join is NOT a candidate: a promoted reading has
        # one distinct value, and the UI builds "this sheet prints N
        # different scales" from this list (the leak measured 2026-09-02)
        assert artefact not in vals, (name, sorted(vals))
        assert len(vals) == 1, (name, sorted(vals))
        # It stays visible in `refused`, stamped with how it formed
        ref = {round(c.ft_per_paper_inch, 4): c for c in res.refused}
        assert artefact in ref, (name, sorted(ref))
        assert ref[artefact].origin == ORIGIN_JOIN_ARTEFACT, (
            name, ref[artefact].origin)
        # the bar's second opinion is present and backs the truth
        assert res.bar_ft_per_paper_inch is not None, name
        assert abs(res.bar_ft_per_paper_inch - truth) / truth <= 0.025, (
            name, res.bar_ft_per_paper_inch)
        bar = graphic_scale_bar(fx["words"])
        assert bar and abs(bar.ft_per_paper_inch - truth) / truth <= 0.025, (
            name, bar and bar.text)
        # serialised, the page carries no line-broken text as its reading
        d = res.to_dict()
        assert d and d.get("ft_per_paper_inch") != artefact, (name, d)
        if d.get("text") is not None:
            assert "\n" not in d["text"], (name, d["text"])
        assert [c["ft_per_paper_inch"] for c in d["candidates"]] == [truth], (
            name, d["candidates"])
        assert [c["ft_per_paper_inch"] for c in d["refused"]] == [artefact], (
            name, d.get("refused"))


def test_real_pages_when_present():
    if not PLANS.is_dir():
        print(f"  SKIP test_real_pages_when_present: {PLANS} not on disk "
              f"(set TAKEOFF_PUBLIC_PLANS); the frozen-words test above "
              f"still ran")
        return
    import pymupdf
    from takeoff_engine.scale_detect import detect_scale

    ran = 0
    for name in FIXTURES:
        fx = _load(name)
        pdf, _, rest = fx["source"].partition(" ")
        idx = int(rest.split("engine page index ")[1].split()[0])
        path = PLANS / Path(pdf).name
        if not path.is_file():
            print(f"  SKIP {name}: {path} not on disk")
            continue
        truth, artefact = fx["truth_ft_per_paper_inch"], fx["join_artefact_ft_per_paper_inch"]
        page = pymupdf.open(str(path))[idx]
        res = detect_scale(page, ocr_if_needed=False)
        b = res.best.ft_per_paper_inch if res.best else None
        assert b != artefact, (name, "detect_scale promotes the join", b)
        assert b is not None and abs(b - truth) < 1e-6, (name, b, res.pick)
        assert res.source == "text" and res.pick.get("why") == "single", (
            name, res.source, res.pick)
        assert res.agrees is True, (name, res.bar_ft_per_paper_inch, res.delta_pct)
        vals = {round(c.ft_per_paper_inch, 4) for c in res.candidates}
        assert vals == {truth}, (name, vals)
        ref = {round(c.ft_per_paper_inch, 4): c for c in res.refused}
        assert ref[artefact].origin == ORIGIN_JOIN_ARTEFACT, (name, ref)
        ran += 1
    print(f"  ran detect_scale on {ran} of {len(FIXTURES)} real pages")


def test_join_with_nothing_behind_it_abstains():
    """The Sundale caption and ladder with the caption's own `30'` removed
    and the ladder's `0` gone - nothing intact to fall through to, and a
    zero-less non-increasing ladder the bar reader refuses. The join
    artefact is then the ONLY text-layer reading, and it must not be
    promoted: best None, the artefact on view stamped with how it formed,
    and the serialised page says abstained (CLAUDE.md s5, fourth shape)."""
    words = [
        (197.5, 1609.8, 235.0, 1619.9, "SCALE:", 29, 0, 0),
        (237.8, 1609.8, 254.0, 1619.9, '1"=', 29, 0, 1),
        (371.0, 1573.0, 384.6, 1583.0, "90'", 30, 0, 0),
        (299.5, 1573.0, 313.1, 1583.0, "60'", 30, 1, 0),
        (227.5, 1573.0, 241.1, 1583.0, "30'", 30, 2, 0),
        (120.0, 1573.0, 133.0, 1583.0, "15'", 30, 3, 0),
    ]
    res = _text_layer('SCALE: 1"=\n90\'\n60\'\n30\'\n15\'\n', words)
    assert res is not None
    b = res.best.ft_per_paper_inch if res.best else None
    assert b != 90.0, ("promoted the join artefact", b)
    assert res.best is None, (res.best, res.pick)
    assert [c.ft_per_paper_inch for c in res.candidates] == [90.0], res.candidates
    assert res.candidates[0].origin == ORIGIN_JOIN_ARTEFACT
    d = res.to_dict()
    assert d and d.get("abstained") is True and d["ft_per_paper_inch"] is None, d
    assert d["pick"].get("why") == "abstained-join", d["pick"]


def main():
    mod = sys.modules[__name__]
    tests = [getattr(mod, n) for n in dir(mod) if n.startswith("test_")]
    for t in tests:
        t()
        print(f"  ok  {t.__name__}")
    print(f"{len(tests)} tests passed")


if __name__ == "__main__":
    main()
