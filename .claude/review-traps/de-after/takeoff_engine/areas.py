"""Filled AREA regions: the square-foot takeoff the engine could not do.

Concrete, patio, walking path, gravel parking, pool, water feature - an
estimator buys these by the square foot, never by the linear foot. Beaumont
Excavating's own Estimate #853 prices "Paths To Subgrade 22,796 SF @ $3.00",
"Slab Prep 9,237 SF @ $5.50", "Gravel Parking area 2,500 SF" (client
document, not an industry prior). Before this module the engine could only
offer a perimeter, so a filled hardscape region reported as "20 LF".

WHY THIS DOES ITS OWN get_drawings() WALK - DO NOT "TIDY" IT INTO extract.py
----------------------------------------------------------------------------
extract.py is the most load-bearing file in the repo: its output feeds the
byte-identical vector gate (`python -m takeoff_engine.regress`). Fills are
deliberately read here, in a second independent pass, so that the stroke
path is not edited at all and the gate is protected BY CONSTRUCTION rather
than by testing. The duplicated ~40 lines of path walking are the price and
they are worth it. `extract.fill_boxes()` already sets this precedent.

WHAT IT DOES AND DOES NOT SEE (measured, Barn Civil engine page index 1)
----------------------------------------------------------------------------
SOLID fills only - PDF path types 'f' and 'fs'. That is slice 1.

A hatched region (stipple concrete, squiggle patio, x-mark walking path) is
NOT a fill: it is thousands of tiny strokes over a boundary polyline kept on
a separate layer (`BG-Hatch Conc` + `BG-L-Conc`, 14 such pairs on that
sheet; 87.4% of the 41,866 Hatch Conc paths fall inside a BG-L-Conc ring).
Recovering those needs ring-closing over chains and is slice 2 - deliberately
not attempted here, because today's closed chains on those layers include a
spurious 11,863 SF mega-ring where a linear metal edger closed on itself.

A pure 'f' path never becomes a StrokeUnit at all (`extract_strokes` skips
anything without 's'), which is why these regions were previously invisible
end to end: not a unit, not a chain, not a style, not a takeoff row.

NAMING - a region's identity is TEXT, never geometry
----------------------------------------------------------------------------
Every legend swatch on that sheet is drawn on ONE CAD layer, because in
paper space the layer means nothing. Three signals, in confidence order:

  1. TAG   - a "<name>  N sf" annotation sitting inside the polygon. This is
             the drafter's own name AND his own area, so it doubles as a
             self-check on our arithmetic and on the page scale.
  2. LEGEND- the region's fill colour equals a legend swatch's fill colour;
             the swatch's adjacent text is the class name.
  3. LAYER - the CAD layer name tail, as the style list already does.

A legend class with NO matching region is reported in `unmatched_legend`
with no quantity at all - never a zero, never a guess. On Barn Civil p1 the
legend is a DOCUMENT-WIDE key: PROPOSED WATER FEATURE and EXISTING MAPPED
WETLANDS are named there but drawn nowhere on the sheet.

SCALE PROVENANCE
----------------------------------------------------------------------------
Every area carries the scale it was computed with, and `scale.tag_check`
reports what the sheet's own printed areas imply. On Barn Civil p1 the
detected scale is 5.167 ft/inch while 13 printed tags all imply 20.00
ft/inch - a 15.0x area error the reader must surface, not hide. Areas are
also emitted in raw pt so a consumer can rescale without re-detecting.
"""

import math
import re
from collections import defaultdict

import numpy as np
import pymupdf

# A fill lighter than this on every channel is a knockout - the white box a
# drafter puts behind text so linework does not run through it. Same
# threshold extract.fill_boxes() already uses, for the same reason.
WHITE_MIN = 0.92

# Smallest region worth a takeoff row, in PAPER area. Deliberately NOT
# scale-derived: this sheet's detected scale is currently 15x wrong, and a
# scale-derived floor would then either hide real regions (too big) or flood
# the list with symbol confetti (too small). A paper floor cannot do either.
# 324 pt2 is 25 SF at 1"=20', 6.3 SF at 1"=10', 100 SF at 1"=40' - all inside
# "is this worth its own takeoff row", and far above the confetti (Barn Civil
# p1 carries 4,992 tree-stem fills averaging 0.33 pt2 each).
MIN_AREA_PT2 = 324.0

# A legend swatch is a short wide bar with its label immediately to the
# right. Measured on Barn Civil p1: every swatch is 121.0 x 15.1 pt and its
# text starts 9.3 pt past the bar's right edge.
#
# Shape alone is NOT enough - measured: it also matched 36 building floor-
# hatch bands on that sheet, which both invented six nonsense legend classes
# ("14'-8", "3/4\"") and ate those bands out of the region pool. A legend is
# a COLUMN: real swatches stack at one x with one width. Requiring a run of
# SWATCH_MIN_STACK of them killed all 36 false positives and kept all 7 real
# ones.
SWATCH_W = (40.0, 260.0)
SWATCH_H = (5.0, 30.0)
SWATCH_ASPECT = 4.0
SWATCH_TEXT_GAP = 34.0
SWATCH_MIN_STACK = 3

# Sheet furniture by layer name: title blocks, text masks, borders. These
# still get reported (so nothing is silently dropped) but default OFF in the
# review UI, the same treatment texture styles already get.
FURNITURE_RE = re.compile(r"(?i)ANNO|TTLB|TITLE|\bTXT\b|TEXT|BORDER|LOGO")

# Payload guard: pages of dense symbol fills should not ship a huge polygon
# list. Regions are emitted largest-first.
MAX_REGIONS = 400

# Printed-tag agreement window. The 13 tags on Barn Civil p1 agree with
# shoelace to ratio 1.000, so anything past a couple of percent is a real
# disagreement (wrong scale, or the tag belongs to a different region).
TAG_TOL_PCT = 2.0


def _bezier(p0, p1, p2, p3, n=8) -> list:
    out = []
    for i in range(1, n + 1):
        t = i / n
        m = 1 - t
        out.append((m**3 * p0.x + 3 * m * m * t * p1.x
                    + 3 * m * t * t * p2.x + t**3 * p3.x,
                    m**3 * p0.y + 3 * m * m * t * p1.y
                    + 3 * m * t * t * p2.y + t**3 * p3.y))
    return out


def _rings(path) -> list:
    """Sub-paths of one drawing path, as point lists. Mirrors the item walk
    in extract._emit; kept local on purpose (see module docstring)."""
    out, cur = [], []
    for it in path["items"]:
        op = it[0]
        if op == "l":
            a, b = it[1], it[2]
            seg = [(a.x, a.y), (b.x, b.y)]
        elif op == "c":
            a, b, c, d = it[1], it[2], it[3], it[4]
            seg = [(a.x, a.y)] + _bezier(a, b, c, d)
        elif op == "re":
            r = it[1]
            seg = [(r.x0, r.y0), (r.x1, r.y0), (r.x1, r.y1),
                   (r.x0, r.y1), (r.x0, r.y0)]
        elif op == "qu":
            q = it[1]
            seg = [(q.ul.x, q.ul.y), (q.ur.x, q.ur.y), (q.lr.x, q.lr.y),
                   (q.ll.x, q.ll.y), (q.ul.x, q.ul.y)]
        else:
            continue
        if cur and abs(cur[-1][0] - seg[0][0]) < 0.05 \
                and abs(cur[-1][1] - seg[0][1]) < 0.05:
            cur.extend(seg[1:])
        else:
            if len(cur) >= 3:
                out.append(cur)
            cur = list(seg)
    if len(cur) >= 3:
        out.append(cur)
    return out


def _shoelace(ring) -> float:
    a = 0.0
    n = len(ring)
    for i in range(n):
        x0, y0 = ring[i]
        x1, y1 = ring[(i + 1) % n]
        a += x0 * y1 - x1 * y0
    return abs(a) / 2.0


def _ring_perimeter(ring) -> float:
    L = 0.0
    n = len(ring)
    for i in range(n):
        x0, y0 = ring[i]
        x1, y1 = ring[(i + 1) % n]
        L += math.hypot(x1 - x0, y1 - y0)
    return L


def _inside(ring, x: float, y: float) -> bool:
    """Crossing-number point-in-polygon."""
    ins = False
    n = len(ring)
    for i in range(n):
        x0, y0 = ring[i]
        x1, y1 = ring[(i + 1) % n]
        if (y0 > y) != (y1 > y):
            if x < (x1 - x0) * (y - y0) / (y1 - y0 + 1e-12) + x0:
                ins = not ins
    return ins


# A name made only of dimension-string debris ("UE 52'-2", "10''", "3/4\"")
# is a row-join artefact, not a name. Same failure family as the scale
# reader's "GRAPHIC SCALE 5'-2\"": words far apart on the sheet share a
# y-band. Require some real alphabetic content.
_NAMEY = re.compile(r"[A-Za-z]{3}")
# tokens that are measurements, elevations or leader abbreviations rather
# than part of a name
_DEBRIS = re.compile(r"""(?ix) ^(
      [\d'"./,\-]+            # 12'-7  3/4"  7727.2'  52'-2
    | INV:? | RE\.? | STBK | UE | WL | WS | TYP\.? | \(?TYP\)? )$""")


def _clean_name(text: str, max_words: int = 6) -> str:
    """Keep a tag/legend label only when it still reads as a NAME.

    Words are gathered by y-band, and on a CAD sheet two unrelated labels can
    interleave in x on one band ("CONC. PAVER PATIO;" + "RE. TO STRUCTURAL"
    came back merged on Barn Civil p1). Contiguity fixes the far-apart case
    but not the interleaved one, so anything still carrying measurement
    debris after this filter is reported as UNNAMED rather than as a wrong
    name - an unnamed row the reviewer types over is honest; a plausible
    wrong name is not.
    """
    toks = [t for t in text.split() if t and not _DEBRIS.match(t)]
    if not toks or len(toks) > max_words:
        return ""
    out = " ".join(toks).strip(" ;,:-")
    if len(out) < 4 or not _NAMEY.search(out) or ":" in out:
        return ""
    return out


def _contiguous_run(cands: list, x0: float, x1: float, max_gap: float) -> list:
    """The run of words that actually touch each other AND overlap [x0,x1].

    Words are collected by y-band, which on a CAD sheet joins text from
    opposite ends of the page. Keeping only the gap-connected run through
    the anchor's x-span is what turns that back into one label.
    """
    if not cands:
        return []
    cands = sorted(cands, key=lambda w: w[0])
    runs, cur = [], [cands[0]]
    for w in cands[1:]:
        if w[0] - cur[-1][2] <= max_gap:
            cur.append(w)
        else:
            runs.append(cur)
            cur = [w]
    runs.append(cur)
    for run in runs:
        if run[0][0] <= x1 and run[-1][2] >= x0:
            return run
    return []


_SF_SPAN = re.compile(r"(?i)^\s*(\d[\d,]*(?:\.\d+)?)\s*(?:sf|s\.f\.)\s*$")
# how far above its value the tag's name line may sit, in pt
TAG_NAME_RISE = 60.0


def _area_tags(page: pymupdf.Page, rot) -> list:
    """'<name>  1,234.56 sf' annotations: the drafter's own area for a region.

    Read from TEXT SPANS, not from the words list, and paired by span COLOUR.
    A span is atomic, so "3,086.86 sf" and "Flooring, Ceiling, Glazing" each
    arrive whole; the word-level route grouped by y-band instead and merged
    unrelated labels that happen to share a band ("CONC. PAVER PATIO;" came
    back fused with "RE. TO STRUCTURAL"). On Barn Civil p1 every area tag is
    colour 0x800080 against 0x000000 body text, so same-colour + directly
    above is an exact pairing.

    Returns [{value, x, y, name}] in DISPLAY space, matching the geometry.

    The VALUE is the trustworthy half: it is the drafter's own computation
    for exactly this polygon, so it cross-checks both our arithmetic and the
    page scale. The NAME may be a modelling-scheme label rather than a
    material ("Flooring, Ceiling, Glazing" is Revit's area scheme, not a
    finish), which is why it is only the first rung of the naming ladder.
    """
    def disp(bbox):
        r = pymupdf.Rect(bbox)
        if rot is not None:
            r = pymupdf.Rect(r) * rot
        r = pymupdf.Rect(r)
        r.normalize()
        return [r.x0, r.y0, r.x1, r.y1]

    spans = []
    try:
        d = page.get_text("dict")
    except Exception:
        return []
    for blk in d.get("blocks", []):
        for line in blk.get("lines", []):
            for sp in line.get("spans", []):
                t = (sp.get("text") or "").strip()
                if t:
                    spans.append({"t": t, "c": sp.get("color", 0),
                                  "b": disp(sp["bbox"])})
    out = []
    for s in spans:
        m = _SF_SPAN.match(s["t"])
        if not m:
            continue
        try:
            val = float(m.group(1).replace(",", ""))
        except ValueError:
            continue
        if val <= 0:
            continue
        b = s["b"]
        cx, cy = (b[0] + b[2]) / 2, (b[1] + b[3]) / 2
        w = max(b[2] - b[0], 1.0)
        best = None
        for o in spans:
            if o is s or o["c"] != s["c"] or _SF_SPAN.match(o["t"]):
                continue
            ob = o["b"]
            rise = cy - (ob[1] + ob[3]) / 2
            if not (0 < rise <= TAG_NAME_RISE):
                continue
            if min(b[2], ob[2]) - max(b[0], ob[0]) < 0.3 * w:
                continue      # not stacked over the value
            if best is None or rise < best[0]:
                best = (rise, o)
        name = _clean_name(best[1]["t"], max_words=8) if best else ""
        out.append({"value": val, "x": cx, "y": cy, "name": name})
    return out


def _swatch_columns(filled: list, outlines: list) -> tuple:
    """Split swatch-shaped FILLS into real legend swatches and ordinary bands.

    A legend stacks its swatches at one x with one width; an isolated bar of
    swatch-like proportions out in the drawing is floor hatch, a wall band or
    a table rule.

    The column evidence must include OUTLINE-only bars, not just filled ones:
    on Barn Civil p1 five of the seven legend rows are hatched rather than
    filled, so the filled swatches number two and would never reach a stack
    of three on their own. Counting the stroked bars finds all seven and
    confirms both filled ones.
    """
    bars = [(s["bbox"], s) for s in filled] + [(b, None) for b in outlines]
    bars.sort(key=lambda t: (t[0][0], t[0][2] - t[0][0]))
    cols, cur = [], []
    for bbox, s in bars:
        if cur:
            rx0, rx1 = cur[0][0][0], cur[0][0][2]
            if abs(bbox[0] - rx0) > 4.0 \
                    or abs((bbox[2] - bbox[0]) - (rx1 - rx0)) > 6.0:
                cols.append(cur)
                cur = []
        cur.append((bbox, s))
    if cur:
        cols.append(cur)
    keep, rejected = [], []
    for members in cols:
        tgt = keep if len(members) >= SWATCH_MIN_STACK else rejected
        tgt.extend(s for _, s in members if s is not None)
    return keep, rejected


def _legend_fill_classes(swatches: list, words: list) -> list:
    """A legend swatch's identity is the text immediately to its right."""
    if not words:
        return []
    out = []
    for s in swatches:
        x0, y0, x1, y1 = s["bbox"]
        cy = (y0 + y1) / 2
        near = [w for w in words
                if abs((w[1] + w[3]) / 2 - cy) <= (y1 - y0) * 0.75 + 3
                and x1 - 2 <= w[0] <= x1 + SWATCH_TEXT_GAP]
        if not near:
            continue
        anchor = min(near, key=lambda w: w[0])
        acy = (anchor[1] + anchor[3]) / 2
        row = [w for w in words
               if abs((w[1] + w[3]) / 2 - acy) <= 3.5
               and anchor[0] - 1 <= w[0] <= anchor[0] + 260]
        # gap-connected run only: the notes column shares this y-band and
        # appended "DRAINS." to "PROPOSED WATER FEATURE" without this
        run = _contiguous_run(row, anchor[0], anchor[2], max_gap=9.0)
        label = _clean_name(" ".join(str(w[4]).strip() for w in run),
                            max_words=8)
        if 3 <= len(label) <= 60:
            out.append({"label": label, "fill": s["fill"],
                        "layer": s["layer"], "bbox": s["bbox"]})
    return out


def page_areas(page: pymupdf.Page, scale: dict | None = None,
               words: list | None = None) -> dict:
    """Solid-filled regions on one page, with area in SF and a name.

    `scale` is the dict from scale_detect.detect_scale().to_dict(); `words`
    the rotation-mapped words from extract.page_words(). Both optional: with
    no scale the regions still come back, measured in pt, with SF null.
    """
    rot = page.rotation_matrix if page.rotation else None
    fpi = (scale or {}).get("ft_per_paper_inch")
    fpp = (fpi / 72.0) if fpi else None

    def to_display(pts):
        if rot is None:
            return pts
        return [((rot.a * x + rot.c * y + rot.e),
                 (rot.b * x + rot.d * y + rot.f)) for x, y in pts]

    def bar_shaped(w, h):
        return (h > 0 and SWATCH_W[0] <= w <= SWATCH_W[1]
                and SWATCH_H[0] <= h <= SWATCH_H[1] and w / h >= SWATCH_ASPECT)

    raw, swatches, outline_bars = [], [], []
    for path in page.get_drawings():
        ptype = path.get("type") or ""
        if "f" not in ptype:
            # stroke-only paths are not regions, but a bar-shaped one is
            # evidence of a legend COLUMN (see _swatch_columns). Test the
            # raw rect first - under /Rotate 90|270 w and h simply swap, so
            # the cheap check is orientation-free and spares 900k transforms.
            r0 = path.get("rect")
            if r0 is None or not ("s" in ptype):
                continue
            a, b = abs(r0.width), abs(r0.height)
            if not (bar_shaped(a, b) or bar_shaped(b, a)):
                continue
            rr = pymupdf.Rect(r0) * rot if rot is not None else pymupdf.Rect(r0)
            rr = pymupdf.Rect(rr)
            rr.normalize()
            outline_bars.append([rr.x0, rr.y0, rr.x1, rr.y1])
            continue
        fill = path.get("fill")
        if not fill or min(fill) > WHITE_MIN:
            continue           # knockout mask, not a region
        rings = [to_display(r) for r in _rings(path)]
        if not rings:
            continue
        areas = [_shoelace(r) for r in rings]
        k = int(np.argmax(areas))
        outer = rings[k]
        gross = areas[k]
        if gross <= 0:
            continue
        holes = sum(a for i, a in enumerate(areas)
                    if i != k and _inside(outer, *rings[i][0]))
        net = max(gross - holes, 0.0)
        xs = [p[0] for p in outer]
        ys = [p[1] for p in outer]
        bbox = [min(xs), min(ys), max(xs), max(ys)]
        w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
        rec = {"fill": [round(float(c), 3) for c in fill],
               "layer": path.get("layer") or "",
               "outer": outer, "net": net, "gross": gross,
               "perim": _ring_perimeter(outer), "bbox": bbox,
               "n_rings": len(rings)}
        # a legend swatch is furniture AND the naming key - hold it aside
        # before the area floor, since swatches are small. Whether it really
        # IS a swatch is decided by column structure below, not shape alone.
        if bar_shaped(w, h):
            swatches.append(rec)
            continue
        if net < MIN_AREA_PT2:
            continue
        raw.append(rec)

    # bars that failed the column test are ordinary geometry - put them back
    swatches, not_swatches = _swatch_columns(swatches, outline_bars)
    raw.extend(r for r in not_swatches if r["net"] >= MIN_AREA_PT2)

    legend_classes = _legend_fill_classes(swatches, words or [])
    # One fill, one name - or NO name. This was a first-writer-wins
    # setdefault: whichever legend row the walk reached first kept the
    # colour and the rest were dropped with no ranking and no record. That
    # is the same silent race that shipped Beaumont's footer drain as
    # "> > >" out of read_legend (fixed in legend_detect._assign_label).
    # There is no honest ranking between two legend rows claiming the same
    # fill, so a CONTESTED colour names nothing and the region falls
    # through to its CAD layer name - this file's own doctrine, per
    # _clean_name: "an unnamed row the reviewer types over is honest; a
    # plausible wrong name is not". The losing labels stay visible in
    # legend_classes rather than being discarded.
    # Measured over 2,059 corpus pages (client_meet + TakeoffPro AI): 19
    # legend rows on 10 pages, 14 distinct fills, 3 fills carrying a
    # duplicate row and all 3 duplicates agreeing on the label - so this is
    # a no-op today and a guard against the sheet where it is not.
    _labels_by_fill = defaultdict(list)
    for lc in legend_classes:
        seen = _labels_by_fill[tuple(lc["fill"])]
        if lc["label"] not in seen:
            seen.append(lc["label"])
    by_colour = {k: v[0] for k, v in _labels_by_fill.items() if len(v) == 1}
    _contested = {k for k, v in _labels_by_fill.items() if len(v) > 1}

    tags = _area_tags(page, rot)
    raw.sort(key=lambda r: -r["net"])
    truncated = max(0, len(raw) - MAX_REGIONS)
    raw = raw[:MAX_REGIONS]

    used_tags = set()
    regions = []
    for i, r in enumerate(raw):
        tag = None
        for ti, t in enumerate(tags):
            if ti in used_tags:
                continue
            bx = r["bbox"]
            if not (bx[0] <= t["x"] <= bx[2] and bx[1] <= t["y"] <= bx[3]):
                continue
            if _inside(r["outer"], t["x"], t["y"]):
                tag = t
                used_tags.add(ti)
                break
        name, src = None, None
        if tag and tag["name"]:
            name, src = tag["name"], "tag"
        elif tuple(r["fill"]) in by_colour:
            name, src = by_colour[tuple(r["fill"])], "legend"
        elif r["layer"]:
            name, src = r["layer"].split("|")[-1], "layer"
        area_sf = r["net"] * fpp * fpp if fpp else None
        perim_lf = r["perim"] * fpp if fpp else None
        delta = None
        check = None
        if tag and area_sf:
            delta = (area_sf - tag["value"]) / tag["value"] * 100.0
            check = "ok" if abs(delta) <= TAG_TOL_PCT else "mismatch"
        regions.append({
            "region_id": i,
            "fill": r["fill"],
            "layer": r["layer"],
            "name": name,
            "name_source": src,
            "area_pt2": round(r["net"], 1),
            "perim_pt": round(r["perim"], 1),
            "area_sf": round(area_sf, 1) if area_sf is not None else None,
            "perim_lf": round(perim_lf, 1) if perim_lf is not None else None,
            "bbox": [round(v, 1) for v in r["bbox"]],
            "n_rings": r["n_rings"],
            "furniture": bool(FURNITURE_RE.search(r["layer"])),
            "printed_sf": tag["value"] if tag else None,
            "sf_check": check,
            "sf_delta_pct": round(delta, 1) if delta is not None else None,
            "points": [[round(float(x), 2), round(float(y), 2)]
                       for x, y in r["outer"]],
        })

    # GROUPS are the takeoff-facing unit: one appearance = one class. A group
    # holds region_ids, never its own copy of the geometry, so one region can
    # be referenced by several priced rows (Estimate #853 bills the same
    # 22,796 SF twice: once to subgrade, once for 4" road base).
    gmap = defaultdict(list)
    for reg in regions:
        gmap[(tuple(reg["fill"]), reg["layer"])].append(reg)
    groups = []
    for gi, ((fill, layer), members) in enumerate(sorted(
            gmap.items(), key=lambda kv: -sum(m["area_pt2"] for m in kv[1]))):
        named = [m for m in members if m["name_source"] == "tag"]
        # Same ladder as a region - tag, then legend, then layer - except
        # that a tag names ONE polygon, so it may only name the GROUP when
        # every tagged member agrees on it. Members that disagree fall
        # through to the legend/layer signals rather than one of them
        # winning arbitrarily.
        if named and len({m["name"] for m in named}) == 1:
            gname, gsrc = named[0]["name"], "tag"
        elif tuple(fill) in by_colour:
            gname, gsrc = by_colour[tuple(fill)], "legend"
        elif layer:
            gname, gsrc = layer.split("|")[-1], "layer"
        else:
            gname, gsrc = None, None
        for m in members:
            m["group_id"] = gi
        a_pt2 = sum(m["area_pt2"] for m in members)
        p_pt = sum(m["perim_pt"] for m in members)
        printed = [m["printed_sf"] for m in members if m["printed_sf"]]
        bad = [m for m in members if m["sf_check"] == "mismatch"]
        # like-for-like: only the TAGGED members may be compared against the
        # printed total. Summing all members against a partial set of tags
        # manufactures a difference that is really just the untagged regions.
        tagged_pt2 = sum(m["area_pt2"] for m in members if m["printed_sf"])
        groups.append({
            "group_id": gi,
            "fill": list(fill),
            "layer": layer,
            "name": gname,
            "name_source": gsrc,
            "n": len(members),
            "region_ids": [m["region_id"] for m in members],
            "area_pt2": round(a_pt2, 1),
            "perim_pt": round(p_pt, 1),
            "area_sf": round(a_pt2 * fpp * fpp, 1) if fpp else None,
            "perim_lf": round(p_pt * fpp, 1) if fpp else None,
            "furniture": all(m["furniture"] for m in members),
            "printed_sf": round(sum(printed), 2) if printed else None,
            # our measurement of ONLY the tagged members - the number that is
            # actually comparable with printed_sf
            "area_sf_tagged": (round(tagged_pt2 * fpp * fpp, 1)
                               if fpp and printed else None),
            "n_printed": len(printed),
            "n_mismatch": len(bad),
        })

    # legend classes with no region: named, NO quantity. On a document-wide
    # legend most rows describe some other sheet.
    matched = {tuple(r["fill"]) for r in regions}
    unmatched = [{"label": lc["label"], "fill": lc["fill"],
                  "layer": lc["layer"], "bbox": [round(v, 1) for v in lc["bbox"]]}
                 for lc in legend_classes if tuple(lc["fill"]) not in matched]

    # what the sheet's OWN printed areas say the scale is - the only
    # independent check available without a human
    implied = []
    for reg in regions:
        if reg["printed_sf"] and reg["area_pt2"] > 0:
            implied.append(math.sqrt(reg["printed_sf"] / reg["area_pt2"]) * 72.0)
    n_ok = sum(1 for r in regions if r["sf_check"] == "ok")
    n_bad = sum(1 for r in regions if r["sf_check"] == "mismatch")
    tag_check = {
        "n_tags": len(tags),
        "n_matched": n_ok + n_bad,
        "n_ok": n_ok,
        "n_mismatch": n_bad,
        "implied_ft_per_paper_inch":
            round(float(np.median(implied)), 3) if implied else None,
        "unattached": [{"value": t["value"], "name": t["name"],
                        "x": round(t["x"], 1), "y": round(t["y"], 1)}
                       for i, t in enumerate(tags) if i not in used_tags],
    }
    return {
        "scale": {
            "ft_per_paper_inch": fpi,
            "text": (scale or {}).get("text"),
            "source": (scale or {}).get("source"),
            "tag_check": tag_check,
        },
        "regions": regions,
        "groups": groups,
        "unmatched_legend": unmatched,
        "legend_classes": [{"label": lc["label"], "fill": lc["fill"],
                            "contested": tuple(lc["fill"]) in _contested}
                           for lc in legend_classes],
        "truncated": truncated,
    }
