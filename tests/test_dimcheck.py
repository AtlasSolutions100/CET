"""DIMENSION STRINGS as a scale check (takeoff_engine/dimcheck.py).

A synthetic sheet drawn with pymupdf, every number known by construction,
at 1/8" = 1'-0" (8 ft per paper inch: 1 ft = 9 pt):

  * four chained dimensions on ONE long dimension line with tick marks -
    the Belle style: 20', 12', 12', 8' (180, 108, 108, 72 pt), text
    centred on each span
  * two dimensions drawn the AutoCAD way, one line each broken around the
    text, extension lines at the ends: 15'-6" (139.5 pt) horizontal and
    9'-0" (81 pt) vertical
  * a stacked fraction 7'-0 1/2" written as half-size digits (the way the
    text layer delivers it), on its own broken line
  * a dimension text sitting over a WALL line (no dimension line of its
    own) that must be skipped, not measured against the wall
  * a caption that is not a dimension ("SCALE: 1/8\" = 1'-0\"")

What is pinned:
  * every parsed dimension value
  * the fraction folding (7'-0 1/2" -> 7.0417 ft)
  * each measured span within 1% and the implied scale 8.0 within 1.5%
  * the wall-sitting text is skipped and SAYS why
  * the cluster verdict: "dominant", n_agree = the seven, share 100%
  * compare(): agrees against 8, contradicts against 4 with ratio 2 / 4
  * describe() names the counts
  * a rotated page (/Rotate 90) reads the same dimensions

Run:  python tests/test_dimcheck.py
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pymupdf  # noqa: E402

from takeoff_engine import dimcheck  # noqa: E402
from takeoff_engine.extract import extract_strokes  # noqa: E402

FAILS: list[str] = []


def check(cond, msg):
    print(("  ok   " if cond else "  FAIL ") + msg)
    if not cond:
        FAILS.append(msg)


PT_PER_FT = 9.0          # 1/8" = 1'-0"


def build(rotate=0, layered=True):
    """Two sheets in one builder. LAYERED (the AutoCAD / Seer Stone shape):
    dimension geometry on an "A-Dim" optional-content layer, walls on
    "A-wall", each dimension line broken around its text with extension
    lines at the ends, a stacked-fraction dimension, and a dimension text
    over a WALL that must be skipped. UNLAYERED (the Belle shape): one long
    dimension line with tick marks and four chained dimensions, no layer
    names at all, plus the same wall trap - which geometry alone cannot
    tell from a dimension, so that one is measured (and is off-cluster)."""
    doc = pymupdf.open()
    pg = doc.new_page(width=1000, height=700)
    dim = doc.add_ocg("A-Dim") if layered else None
    wall = doc.add_ocg("A-wall") if layered else None

    def stroke(lines, oc):
        sh = pg.new_shape()
        for a, b in lines:
            sh.draw_line(a, b)
        if oc is None:
            sh.finish(color=(0, 0, 0), width=0.5)
        else:
            sh.finish(color=(0, 0, 0), width=0.5, oc=oc)
        sh.commit()

    def put(x, y, t, size=8, rot=0):
        pg.insert_text((x, y), t, fontsize=size, rotate=rot)

    if not layered:
        # ---- chained dimension line with ticks (Belle style) ----
        y = 100.0
        xs = [100.0]
        for ft in (20, 12, 12, 8):
            xs.append(xs[-1] + ft * PT_PER_FT)
        L = [((xs[0], y), (xs[-1], y))]
        for x in xs:
            L.append(((x - 4, y + 4), (x + 4, y - 4)))      # 45-degree tick
            L.append(((x, y + 2), (x, y + 30)))              # extension line
        stroke(L, None)
        for (a, b), t in zip(zip(xs, xs[1:]), ("20'-0\"", "12'-0\"", "12'-0\"", "8'-0\"")):
            put((a + b) / 2 - 12, y - 3, t)
    # ---- AutoCAD style: a line broken around its text, ext lines ----
    def broken_h(x0, x1, y, txt_w):
        cx = (x0 + x1) / 2
        return [((x0, y), (cx - txt_w / 2 - 2, y)), ((cx + txt_w / 2 + 2, y), (x1, y)),
                ((x0, y - 12), (x0, y + 12)), ((x1, y - 12), (x1, y + 12))]
    L = broken_h(100.0, 100.0 + 15.5 * PT_PER_FT, 250.0, 30)         # 15'-6"
    L += broken_h(500.0, 500.0 + 7.0417 * PT_PER_FT, 250.0, 34)      # 7'-0 1/2"
    L += broken_h(100.0, 100.0 + 10 * PT_PER_FT, 320.0, 30)          # 10'-0"
    L += broken_h(300.0, 300.0 + 6 * PT_PER_FT, 320.0, 30)           # 6'-0"
    # vertical 9'-0"
    x = 700.0
    y0, y1 = 300.0, 300.0 + 9 * PT_PER_FT
    cy = (y0 + y1) / 2
    L += [((x, y0), (x, cy - 12)), ((x, cy + 12), (x, y1)), ((x - 12, y0), (x + 12, y0)), ((x - 12, y1), (x + 12, y1))]
    stroke(L, dim)
    put(100.0 + 15.5 * PT_PER_FT / 2 - 14, 253.0, "15'-6\"")
    put(100.0 + 10 * PT_PER_FT / 2 - 14, 323.0, "10'-0\"")
    put(300.0 + 6 * PT_PER_FT / 2 - 14, 323.0, "6'-0\"")
    # the stacked fraction: 7'-0 then half-size "12" then the inch mark, ONE line
    bx = 500.0 + 7.0417 * PT_PER_FT / 2 - 16
    tw = pymupdf.TextWriter(pg.rect)
    tw.append((bx, 253.0), "7'-0", fontsize=8)
    w1 = pymupdf.get_text_length("7'-0", fontsize=8)
    tw.append((bx + w1, 253.0), "12", fontsize=4)
    w2 = pymupdf.get_text_length("12", fontsize=4)
    tw.append((bx + w1 + w2, 253.0), "\"", fontsize=8)
    tw.write_text(pg)
    pg.insert_text((x + 3, cy + 12), "9'-0\"", fontsize=8, rotate=90)
    # ---- a wall with a dimension text over it and no dimension line ----
    stroke([((100.0, 500.0), (400.0, 500.0)), ((100.0, 480.0), (100.0, 520.0)), ((400.0, 480.0), (400.0, 520.0))], wall)
    put(240.0, 497.0, "30'-0\"")
    put(600.0, 600.0, "SCALE: 1/8\" = 1'-0\"", size=9)
    if rotate:
        pg.set_rotation(rotate)
    return doc, pg


# ---- parsing -----------------------------------------------------------------------
print("parse")
for t, v in (("20'-6\"", 20.5), ("44' - 0\"", 44.0), ("8\"", 8 / 12), ("3'-2 1/2\"", 3 + 2.5 / 12),
             ("11 1/2\"", 11.5 / 12), ("7'-0 1/2\"", 7 + 0.5 / 12), ("97'", 97.0)):
    got = dimcheck.parse_dimension(t)
    check(got is not None and abs(got - v) < 1e-9, "%r -> %s" % (t, got))
for t in ("SCALE: 1/8\" = 1'-0\"", "2x6 STUDS", "12'-14\"", "BEDROOM 2", "1/4\" = 1'-0\""):
    check(dimcheck.parse_dimension(t) is None, "%r is not a dimension" % t)
check(dimcheck._fold_fraction("12") == "1/2" and dimcheck._fold_fraction("116") == "1/16"
      and dimcheck._fold_fraction("34") == "3/4" and dimcheck._fold_fraction("57") == "57",
      "half-size digit runs fold to n/d only when d is a power of two and n < d")

# ---- the synthetic sheet ------------------------------------------------------------
print("layered sheet at 1/8\" (AutoCAD style, DIM layer)")
doc, pg = build()
lines = dimcheck.text_lines(pg)
texts = [t.strip() for (_, _, _, _, t, _) in lines]
check(any(t == "7'-0 1/2\"" for t in texts), "the stacked fraction arrives folded as 7'-0 1/2\": %s" % [t for t in texts if t.startswith("7'")])
check(any(t == "9'-0\"" and not h for (_, _, _, _, t, h) in lines), "rotated text is read as vertical")
units = extract_strokes(pg)
r = dimcheck.read_dimensions(pg, units)
check(r["n_printed"] == 6, "6 printed dimensions found (5 real + 1 over a wall), got %d" % r["n_printed"])
check(r["n_measured"] == 5, "5 measured, got %d: %s" % (r["n_measured"], r["skipped"]))
by = {s["text"]: s for s in r["samples"]}
for t, ft in (("15'-6\"", 15.5), ("7'-0 1/2\"", 7.0417), ("10'-0\"", 10), ("6'-0\"", 6), ("9'-0\"", 9)):
    s = by.get(t)
    check(s is not None and abs(s["span_pt"] - ft * PT_PER_FT) <= 0.01 * ft * PT_PER_FT + 0.6,
          "%s measures %.1f pt (want %.1f)" % (t, s["span_pt"] if s else -1, ft * PT_PER_FT))
    check(s is not None and abs(s["implied_ft_per_paper_inch"] - 8.0) <= 0.12,
          "%s implies 8.0 ft/in, got %s" % (t, s and s["implied_ft_per_paper_inch"]))
    check(s is not None and s["how"] == "endpoints" and s["layer"] == "A-Dim",
          "%s: a line broken around its text is measured end to end, on the DIM layer" % t)
check("30'-0\"" not in by, "the text over a WALL line is not measured against the wall")
check(r["skipped"].get("no dimension line on a DIM layer") == 1, "and the skip says why: %s" % r["skipped"])
check(r["why"] == "dominant" and r["n_agree"] == 5 and r["share_pct"] == 100.0,
      "verdict: dominant, 5 agree, 100%% (got %s / %s / %s)" % (r["why"], r["n_agree"], r["share_pct"]))
check(r["implied_ft_per_paper_inch"] is not None and abs(r["implied_ft_per_paper_inch"] - 8.0) <= 0.08,
      "the sheet's dimensions say 8.0 ft per paper inch: %s" % r["implied_ft_per_paper_inch"])
check(len(r["clusters"]) == 1 and r["clusters"][0]["n"] == 5, "one cluster of five")
for s in r["samples"]:
    e = s["ends"]
    check(len(e) == 4 and abs(((e[2] - e[0]) ** 2 + (e[3] - e[1]) ** 2) ** 0.5 - s["span_pt"]) < 0.6,
          "%s carries the measured span's endpoints for the overlay" % s["text"])

print("unlayered sheet at 1/8\" (Belle style, chained ticks)")
docu, pgu = build(layered=False)
ru = dimcheck.read_dimensions(pgu, extract_strokes(pgu))
byu = {s["text"]: s for s in ru["samples"]}
check(ru["n_printed"] == 10, "10 printed dimensions, got %d" % ru["n_printed"])
for t, ft in (("20'-0\"", 20), ("8'-0\"", 8), ("15'-6\"", 15.5), ("9'-0\"", 9)):
    s = byu.get(t)
    check(s is not None and abs(s["span_pt"] - ft * PT_PER_FT) <= 0.01 * ft * PT_PER_FT + 0.6
          and abs(s["implied_ft_per_paper_inch"] - 8.0) <= 0.12,
          "%s measures %.1f pt -> %s ft/in" % (t, s["span_pt"] if s else -1, s and s["implied_ft_per_paper_inch"]))
chained = [s for s in ru["samples"] if s["text"] == "12'-0\""]
check(len(chained) == 2 and all(abs(s["span_pt"] - 108) <= 1.7 and s["how"] == "centred" for s in chained),
      "the two chained 12' strings are each measured between their OWN ticks, not the outer pair: %s" % [(s["span_pt"], s["how"]) for s in chained])
check(byu.get("20'-0\"", {}).get("how") == "centred", "a chained line with ticks is measured between the ticks the text is centred on")
w = byu.get("30'-0\"")
check(w is not None and abs(w["implied_ft_per_paper_inch"] - 7.2) < 0.1 and w.get("cluster") != 0,
      "without layer names the wall trap IS measured (geometry cannot tell), lands off-cluster and is disclosed: %s" % (w and w["implied_ft_per_paper_inch"]))
check(ru["why"] == "dominant" and ru["n_agree"] == 9 and abs(ru["implied_ft_per_paper_inch"] - 8.0) <= 0.08,
      "verdict: dominant, 9 of 10 agree on 8.0 (got %s / %s / %s)" % (ru["why"], ru["n_agree"], ru["implied_ft_per_paper_inch"]))

# ---- compare / describe --------------------------------------------------------------
print("compare")
c8 = dimcheck.compare(r, 8.0)
check(c8 and c8["agrees"] and c8["delta_pct"] < 2.5, "against 8 ft/in: agrees (%s)" % c8)
c4 = dimcheck.compare(r, 4.0)
check(c4 and not c4["agrees"] and abs(c4["ratio_len"] - 2.0) < 0.05 and abs(c4["ratio_area"] - 4.0) < 0.2,
      "against 4 ft/in (the Belle case): contradicts, lengths 2x, areas 4x (%s)" % c4)
check(dimcheck.compare(r, None) is None and dimcheck.compare(None, 4.0) is None, "compare abstains without both sides")
d = dimcheck.describe(r, 4.0)
check("5 of 6 printed dimensions" in d and "8 ft" in d and "4 ft" in d and "2x" in d and "4x" in d,
      "describe names the counts, both scales and the ratios: %s" % d)
check("matches" in dimcheck.describe(r, 8.0), "describe says when it matches")
check("no printed dimensions" in dimcheck.describe({"n_printed": 0}), "describe: nothing printed")
check("too few" in dimcheck.describe({"n_printed": 3, "n_measured": 1, "why": "too-few"}), "describe: too few")
split = {"n_printed": 9, "n_measured": 8, "why": "split",
         "clusters": [{"ft_per_paper_inch": 4.0, "n": 4}, {"ft_per_paper_inch": 8.0, "n": 4}]}
check("disagree" in dimcheck.describe(split) and "4 at 1 in = 4 ft" in dimcheck.describe(split),
      "describe: a split sheet lists its clusters")

# ---- the verdict rules ----------------------------------------------------------------
print("verdict")
check(dimcheck.MIN_AGREE == 3 and dimcheck.MIN_SHARE_PCT == 60.0, "3 dimensions and 60% of the measured are the floor")
# split: build a page whose chained dims are at 1/8" and broken dims at 1/4"
doc2, pg2 = build()
sh = pg2.new_shape()
# five more AutoCAD-style dims at 4 ft/in (1 ft = 18 pt), on the DIM layer - 5 vs 5: neither reaches 60%
dim2 = [x for x in doc2.get_ocgs() if doc2.get_ocgs()[x]["name"] == "A-Dim"][0]
for i, ft in enumerate((10, 10, 6, 8, 12)):
    x0 = 100.0 + i * 160
    x1 = x0 + ft * 18.0
    yy = 620.0
    cx = (x0 + x1) / 2
    sh.draw_line((x0, yy), (cx - 16, yy)); sh.draw_line((cx + 16, yy), (x1, yy))
    sh.draw_line((x0, yy - 12), (x0, yy + 12)); sh.draw_line((x1, yy - 12), (x1, yy + 12))
    pg2.insert_text((cx - 14, yy + 3), "%d'-0\"" % ft, fontsize=8)
sh.finish(color=(0, 0, 0), width=0.5, oc=dim2); sh.commit()
r2 = dimcheck.read_dimensions(pg2, extract_strokes(pg2))
check(r2["n_measured"] == 10 and r2["why"] == "split" and r2["implied_ft_per_paper_inch"] is None,
      "5 at 8 ft/in against 5 at 4 ft/in: no single reading, verdict 'split' (got %s, %s measured)" % (r2["why"], r2["n_measured"]))
check(len(r2["clusters"]) == 2 and {c["n"] for c in r2["clusters"]} == {5}
      and sorted(round(c["ft_per_paper_inch"]) for c in r2["clusters"]) == [4, 8],
      "both clusters stay visible with their counts: %s" % [(c["ft_per_paper_inch"], c["n"]) for c in r2["clusters"]])

# ---- rotation -----------------------------------------------------------------------
print("rotated page")
doc3, pg3 = build(rotate=90)
r3 = dimcheck.read_dimensions(pg3, extract_strokes(pg3))
check(r3["n_measured"] == 5 and r3["why"] == "dominant" and abs(r3["implied_ft_per_paper_inch"] - 8.0) <= 0.08,
      "a /Rotate 90 page reads the same five dimensions at 8.0: %s / %s / %s" % (r3["n_measured"], r3["why"], r3["implied_ft_per_paper_inch"]))
docr, pgr = build(rotate=270, layered=False)
rr = dimcheck.read_dimensions(pgr, extract_strokes(pgr))
check(rr["n_agree"] == 9 and abs(rr["implied_ft_per_paper_inch"] - 8.0) <= 0.08,
      "a /Rotate 270 unlayered page reads its nine: %s / %s" % (rr["n_agree"], rr["implied_ft_per_paper_inch"]))

# ---- nothing --------------------------------------------------------------------------
print("empty")
doc4 = pymupdf.open()
pg4 = doc4.new_page(width=200, height=200)
r4 = dimcheck.read_dimensions(pg4, extract_strokes(pg4))
check(r4["n_printed"] == 0 and r4["why"] == "none" and r4["implied_ft_per_paper_inch"] is None, "a blank page: nothing, and says none")

print("\n%d FAILED" % len(FAILS) if FAILS else "\nall passed")
sys.exit(1 if FAILS else 0)
