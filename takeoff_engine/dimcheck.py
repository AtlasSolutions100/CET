"""Dimension strings as a scale check: the sheet measures itself.

A floor plan prints dozens of dimensions - `20'-6"` over a line that runs
between two extension lines. The printed number is what the drafter typed;
the distance between the extension lines is what the sheet is drawn at.
Divide one by the other and every dimension is an independent reading of
the scale, in the drafter's own hand, with no caption and no scale bar
involved. Measured 2026-09-08 on Belle Farms Structural A1.00 (engine page
index 1 = printed sheet 2): the caption in force reads 1/4" = 1'-0" (4 ft
per paper inch), the drawn bar agrees with it, and all seven printed
dimensions - 16', 32', 44', 50', 54', 80', 97' - measure at 8.0 ft per
paper inch, a factor of 2 on every length and 4 on every square foot the
flooring panel reported. The two printed captions on that sheet are 1/8"
(bottom left) and 1/4" (bottom right); the plan is drawn at the first and
the ranking picked the second. The bar is a paper-space block that says
what the caption says. Only the dimensions say what the linework says.

HOW a dimension is measured (all in page pt, rotation applied so text and
strokes share one frame):
  1. TEXT. get_text("rawdict") lines whose text is a feet-and-inches
     dimension: 20'-6", 44' - 0", 8", 3'-2 1/2". The line's `dir` says
     whether it runs along x or y (a bbox aspect cannot: a two-line
     vertical label is wider than it is tall). A fraction drawn as half-
     size digits (7'-0½" arrives as the chars 7 ' - 0 1 2 " with the 1 2
     at half the font size) is folded back to 1/2.
  2. THE DIMENSION LINE. A stroke parallel to the text, within 2.5 text
     heights of it, that covers the text centre - or, when the drafter's
     style breaks the line around the text (Wells Built / Seer Stone
     A2.1: every dimension), the two pieces that end at the text. On a
     sheet with CAD layer names the line must be on a layer named DIM;
     a wall face under a dimension text is the wall the text sits in and
     is never its dimension line (Seer Stone: 40 of 121 dimensions had a
     wall within reach and every one of those read wrong by geometry
     alone).
  3. THE EXTENSION LINES. Strokes crossing the dimension line's row at
     20-160 degrees off it - extension lines, tick marks, arrowheads -
     read on the same layer when the row has one. Two rules, in order:
       endpoints  the dimension line's own two ends each carry a crossing
                  (within 3 pt) and the text is centred between them - the
                  AutoCAD default, one line per dimension, text at its
                  middle. Seer Stone A2.1: 109 of 112 readings, all at
                  exactly 4.00.
       centred    a single long line carries a whole chain of dimensions
                  with ticks along it (Belle: every string). The pair of
                  crossings the text is centred between, SMALLEST span
                  first: a neighbour's extension line is farther out and,
                  in a chain of equal dimensions, also centred. Centring
                  tolerance 0.6 text heights or 3% of the span - AutoCAD
                  centres to the point, and 10% let a pair of grid ticks
                  341 pt apart stand in for Belle's 44' string (394 pt).
     Which rule applies is decided by whether OTHER dimension texts sit
     on the same line (a chain) or this is the only one (its own line) -
     see _pair for the two ways the rules contradict each other otherwise.
     A text that is not centred on any pair - a small dimension with its
     number pushed outside, a leader - is skipped, never guessed.
     Measured: Belle A1.00 7 of 7 at 8.04; Seer Stone A2.1 110 of 112 at
     4.00; the A1.20 door and window types sheet 72 of 84 at 4.10 (printed
     at 97.6%, which is what this check exists to see).
  4. IMPLIED SCALE = printed feet / (span pt / 72). Readings outside
     0.5-400 ft per paper inch are dropped as implausible.
  5. CLUSTER at 4% and take the largest. The check STATES a scale only
     when at least 3 dimensions agree and they are at least 60% of every
     dimension that was measured; otherwise it abstains and leaves every
     cluster visible, with where on the sheet each sits, because a plan
     and a detail on one sheet legitimately measure differently.

WHAT THIS DOES NOT DO. It never changes the scale in force - `scale` is
the scale boundary detect_page owns, and this is a second opinion on it
in the same sense the drawn bar is. The review UI compares the implied
value against whatever is in force right now (a reviewer's pick re-runs
the comparison), offers the dimensions' reading as a one-click choice
when nothing is in force, and the report PDF prints the statement. A
dimension the reader could not pair is not evidence either way.
"""
from __future__ import annotations

import math
import re
from typing import Optional

import numpy as np

# 20'-6"  20' - 6"  44'  3'-2 1/2"  8"  11 1/2"
_DIM_RX = re.compile(
    r"""^\s*(\d{1,3})\s*['’′]\s*-?\s*(?:(\d{1,2})(?:\s*(\d{1,2})/(\d{1,2}))?\s*["”″])?\s*$"""
    r"""|^\s*(\d{1,3})(?:\s*(\d{1,2})/(\d{1,2}))?\s*["”″]\s*$""")
_DIM_LAYER = re.compile(r"dim", re.I)

ROW_REACH_TH = 2.5        # dimension line within this many text heights
CROSS_TOL_PT = 3.0        # a crossing "reaches" the row within this
END_TOL_PT = 3.0          # a crossing "is at" the line's end within this
CLUSTER_PCT = 4.0         # readings within 4% are one cluster
MIN_AGREE = 3             # a stated scale needs this many dimensions...
MIN_SHARE_PCT = 60.0      # ...and this share of everything measured
FT_PER_IN_MIN, FT_PER_IN_MAX = 0.5, 400.0


def parse_dimension(text: str) -> Optional[float]:
    """Feet in a printed dimension, or None when the text is not one.
    Inches >= 12 are refused (a folded fraction that did not fold)."""
    m = _DIM_RX.match(text or "")
    if not m:
        return None
    try:
        if m.group(1):
            v = int(m.group(1))
            if m.group(2):
                if int(m.group(2)) >= 12:
                    return None
                v += int(m.group(2)) / 12.0
            if m.group(3):
                v += int(m.group(3)) / int(m.group(4)) / 12.0
            return v
        v = int(m.group(5)) / 12.0
        if m.group(6):
            v += int(m.group(6)) / int(m.group(7)) / 12.0
        return v
    except (ValueError, ZeroDivisionError):
        return None


def _fold_fraction(digits: str) -> str:
    """'12' -> '1/2', '116' -> '1/16': the half-size glyph run of a stacked
    fraction, denominator a power of two, numerator smaller than it."""
    for dl in (2, 1):
        if len(digits) > dl:
            den, num = digits[-dl:], digits[:-dl]
            if den in ("2", "4", "8", "16", "32") and int(num) < int(den):
                return num + "/" + den
    return digits


def text_lines(page) -> list:
    """[(x0, y0, x1, y1, text, horizontal)] in the rotated frame, with
    stacked fractions folded back to n/d. get_text('rawdict') per line."""
    try:
        d = page.get_text("rawdict")
    except Exception:
        return []
    rot = page.rotation_matrix if page.rotation else None
    out = []
    for blk in d.get("blocks", []):
        for ln in blk.get("lines", []):
            chars = [(c.get("c", ""), float(sp.get("size") or 0))
                     for sp in ln.get("spans", []) for c in sp.get("chars", [])]
            if not chars:
                continue
            main = max(s for _, s in chars)
            txt, small = "", ""
            for c, s in chars:
                if main > 0 and s < 0.7 * main and c.isdigit():
                    small += c
                    continue
                if small:
                    txt += " " + _fold_fraction(small)
                    small = ""
                txt += c
            if small:
                txt += " " + _fold_fraction(small)
            bx = ln.get("bbox")
            dv = ln.get("dir") or (1.0, 0.0)
            if not bx:
                continue
            dx, dy = float(dv[0]), float(dv[1])
            if rot is not None:
                import pymupdf
                a = pymupdf.Point(bx[0], bx[1]) * rot
                b = pymupdf.Point(bx[2], bx[3]) * rot
                x0, x1 = sorted((a.x, b.x))
                y0, y1 = sorted((a.y, b.y))
                # the direction rotates with the page, translation dropped
                dx, dy = dx * rot.a + dy * rot.c, dx * rot.b + dy * rot.d
            else:
                x0, y0, x1, y1 = (float(v) for v in bx)
            out.append((x0, y0, x1, y1, txt, abs(dx) >= abs(dy)))
    return out


def _segments(units) -> tuple:
    """Straight segments of every visible stroke unit as parallel numpy
    arrays: x0, y0, x1, y1, angle (deg, 0-180), layer index; plus the
    layer name list. Whiteout strokes skipped, as chain.py skips them."""
    xs0, ys0, xs1, ys1, angs, lays = [], [], [], [], [], []
    names: list = []
    idx: dict = {}
    for u in units or []:
        col = getattr(u, "color", None)
        if col and min(col) > 0.92 and not getattr(u, "on_fill", False):
            continue
        P = np.asarray(getattr(u, "pts", []), dtype=float)
        if P.ndim != 2 or len(P) < 2:
            continue
        lay = str(getattr(u, "layer", "") or "")
        li = idx.setdefault(lay, len(names))
        if li == len(names):
            names.append(lay)
        d = np.diff(P, axis=0)
        L = np.hypot(d[:, 0], d[:, 1])
        keep = L >= 0.5
        if not keep.any():
            continue
        a = np.degrees(np.arctan2(d[keep, 1], d[keep, 0])) % 180.0
        xs0.append(P[:-1][keep, 0]); ys0.append(P[:-1][keep, 1])
        xs1.append(P[1:][keep, 0]); ys1.append(P[1:][keep, 1])
        angs.append(a); lays.append(np.full(int(keep.sum()), li))
    if not xs0:
        z = np.zeros(0)
        return z, z, z, z, z, np.zeros(0, dtype=int), names
    return (np.concatenate(xs0), np.concatenate(ys0), np.concatenate(xs1),
            np.concatenate(ys1), np.concatenate(angs), np.concatenate(lays), names)


def _pair(xs: np.ndarray, c: float, th: float, a: float, b: float, chained: bool):
    """(span, how) for the two crossings `xs` (positions along the axis)
    that the text centre `c` sits between; None when nothing is centred.

    `chained` says whether OTHER dimension texts sit on this same line.
    One text on the line (AutoCAD: one dimension line per dimension) - the
    line's own ends are the answer, and a crossing between them is a
    foreign line passing through. Several texts on the line (Belle: one
    long line with ticks) - the ends span the whole chain, and the pair
    this text is centred on, smallest first, is its own. Without that
    fact the two shapes contradict each other: the middle string of a
    20|12|12|8 chain is centred on the whole line too, and on Seer Stone
    A2.1 a pair of foreign crossings symmetric about a text within 6 pt
    happens 14 times in 121 (measured: smallest-first alone took the
    sheet from 110 to 96 agreeing dimensions)."""
    left = xs[xs < c - 0.3 * th]
    right = xs[xs > c + 0.3 * th]
    if left.size == 0 or right.size == 0:
        return None
    la = left[np.abs(left - a) <= END_TOL_PT]
    rb = right[np.abs(right - b) <= END_TOL_PT]
    at_ends = (float(la.max()), float(rb.min())) if (la.size and rb.size) else None
    if not chained and at_ends is not None:
        l, r = at_ends
        span = r - l
        if span >= th and abs((l + r) / 2.0 - c) <= max(th, 0.06 * span):
            return span, "endpoints"
    best = None
    for l in left:
        for r in right:
            span = float(r - l)
            if span < th:
                continue
            if abs((l + r) / 2.0 - c) > max(0.6 * th, 0.03 * span):
                continue
            if best is None or span < best[0]:
                best = (span, float(l), float(r))
    if best is None:
        return None
    if at_ends is not None and abs(best[1] - at_ends[0]) <= 0.5 and abs(best[2] - at_ends[1]) <= 0.5:
        return best[0], "endpoints"
    return best[0], "centred"


def read_dimensions(page, units) -> dict:
    """Every printed dimension paired with its extension lines, and what
    they imply. `units` are the page's StrokeUnits (extract_strokes), the
    same geometry every other reader here measures. Pure: nothing on the
    page or in `units` is changed."""
    lines = text_lines(page)
    dims = []
    for (x0, y0, x1, y1, t, horiz) in lines:
        v = parse_dimension(t)
        if v is None or v <= 0:
            continue
        dims.append({"text": t.strip(), "ft": v, "x0": x0, "y0": y0,
                     "x1": x1, "y1": y1, "horiz": horiz})
    out = {"n_printed": len(dims), "n_measured": 0, "samples": [],
           "skipped": {}, "clusters": [], "implied_ft_per_paper_inch": None,
           "n_agree": 0, "share_pct": None, "why": "none"}
    if not dims:
        return out
    X0, Y0, X1, Y1, ANG, LAY, names = _segments(units)
    if X0.size == 0:
        out["why"] = "no-linework"
        out["skipped"]["no linework"] = len(dims)
        return out
    layered = bool((LAY != names.index("")).sum() > 0.5 * LAY.size) if "" in names \
        else LAY.size > 0
    dim_layer = np.array([bool(_DIM_LAYER.search(n)) for n in names])
    par_h = (ANG < 2.0) | (ANG > 178.0)
    par_v = (ANG > 88.0) & (ANG < 92.0)
    cross_h = (ANG > 20.0) & (ANG < 160.0)                # crosses a horizontal row
    cross_v = (ANG < 70.0) | (ANG > 110.0)                # crosses a vertical row
    skipped: dict = {}

    def skip(why):
        skipped[why] = skipped.get(why, 0) + 1

    for d in dims:
        cx, cy = (d["x0"] + d["x1"]) / 2.0, (d["y0"] + d["y1"]) / 2.0
        if d["horiz"]:
            th = d["y1"] - d["y0"]
            tw = d["x1"] - d["x0"]
            c, cp = cx, cy
            par, cross = par_h, cross_h
            A0, A1, P0, P1 = X0, X1, Y0, Y1
        else:
            th = d["x1"] - d["x0"]
            tw = d["y1"] - d["y0"]
            c, cp = cy, cx
            par, cross = par_v, cross_v
            A0, A1, P0, P1 = Y0, Y1, X0, X1
        if th <= 0:
            skip("text has no height")
            continue
        pm = (P0 + P1) / 2.0
        lo, hi = np.minimum(A0, A1), np.maximum(A0, A1)
        reach = tw / 2.0 + 1.5 * th
        rows = par & (np.abs(pm - cp) <= ROW_REACH_TH * th) \
            & (lo <= c + reach) & (hi >= c - reach)
        if layered:
            rows &= dim_layer[LAY]
        ri = np.nonzero(rows)[0]
        if ri.size == 0:
            skip("no dimension line" + (" on a DIM layer" if layered else ""))
            continue
        # the row nearest the text; every piece within 1 pt of it is the
        # same line, broken around the text or not
        near = ri[np.argmin(np.abs(pm[ri] - cp))]
        offset = float(pm[near])
        same = ri[np.abs(pm[ri] - offset) <= 1.0]
        cover = same[(lo[same] <= c) & (hi[same] >= c)]
        if cover.size:
            a, b = float(lo[cover].min()), float(hi[cover].max())
        else:
            lefts = same[hi[same] <= c + 1.0]
            rights = same[lo[same] >= c - 1.0]
            if lefts.size == 0 or rights.size == 0:
                skip("dimension line does not reach the text")
                continue
            lp = lefts[np.argmax(hi[lefts])]
            rp = rights[np.argmin(lo[rights])]
            a, b = float(lo[lp]), float(hi[rp])
        lay_i = int(LAY[near])
        cm = cross & (np.minimum(P0, P1) - CROSS_TOL_PT <= offset) \
            & (np.maximum(P0, P1) + CROSS_TOL_PT >= offset)
        if layered and names[lay_i]:
            cm &= (LAY == lay_i)
        xs = np.unique(np.round((A0[cm] + A1[cm]) / 2.0, 1))
        # TICK MARKS first. An architectural dimension ends in a 45-degree
        # tick (or an arrowhead stroke) - the drafter's explicit end marker
        # - while a grid line or a wall crosses the row square. Belle's 97'
        # string: the true ticks are 873 pt apart and two dashed grid
        # lines 845 pt apart sit inside them, also centred, and neither
        # length nor layer tells them apart; the angle does. Oblique
        # crossings (25-65 degrees off the row) are tried first, every
        # crossing after.
        ob = ((ANG > 25.0) & (ANG < 65.0)) | ((ANG > 115.0) & (ANG < 155.0))
        cs = cm & ob
        xs_short = np.unique(np.round((A0[cs] + A1[cs]) / 2.0, 1))
        # other dimension texts on this same line = a chain of dimensions
        chained = False
        for o in dims:
            if o is d or o["horiz"] != d["horiz"]:
                continue
            ocx, ocy = (o["x0"] + o["x1"]) / 2.0, (o["y0"] + o["y1"]) / 2.0
            oth = (o["y1"] - o["y0"]) if d["horiz"] else (o["x1"] - o["x0"])
            oc, ocp = (ocx, ocy) if d["horiz"] else (ocy, ocx)
            if abs(ocp - offset) <= ROW_REACH_TH * max(oth, 1.0) and a - 1.0 <= oc <= b + 1.0:
                chained = True
                break
        r = _pair(xs_short, c, th, a, b, chained) if xs_short.size >= 2 else None
        if r is None:
            r = _pair(xs, c, th, a, b, chained)
        if r is None:
            skip("text not centred between two crossings")
            continue
        span, how = r
        implied = d["ft"] / (span / 72.0)
        if not (FT_PER_IN_MIN <= implied <= FT_PER_IN_MAX):
            skip("implausible reading")
            continue
        # the measured span's endpoints, for the reviewer to see on the sheet
        mid = (c - span / 2.0, c + span / 2.0)
        if how == "endpoints":
            mid = (a, b)
        if d["horiz"]:
            ends = [round(mid[0], 1), round(offset, 1), round(mid[1], 1), round(offset, 1)]
        else:
            ends = [round(offset, 1), round(mid[0], 1), round(offset, 1), round(mid[1], 1)]
        out["samples"].append({
            "text": d["text"], "ft": round(d["ft"], 4),
            "span_pt": round(span, 1),
            "implied_ft_per_paper_inch": round(implied, 3),
            "how": how, "x": round(cx, 1), "y": round(cy, 1), "ends": ends,
            "layer": names[lay_i] or None,
        })
    out["skipped"] = skipped
    S = out["samples"]
    out["n_measured"] = len(S)
    if not S:
        out["why"] = "none-measured"
        return out
    vals = sorted(S, key=lambda s: s["implied_ft_per_paper_inch"])
    clusters: list = []
    for s in vals:
        v = s["implied_ft_per_paper_inch"]
        if clusters and abs(v - clusters[-1][-1]["implied_ft_per_paper_inch"]) \
                <= CLUSTER_PCT / 100.0 * clusters[-1][-1]["implied_ft_per_paper_inch"]:
            clusters[-1].append(s)
        else:
            clusters.append([s])
    clusters.sort(key=len, reverse=True)
    cl = []
    for grp in clusters:
        vs = sorted(s["implied_ft_per_paper_inch"] for s in grp)
        med = vs[len(vs) // 2] if len(vs) % 2 else (vs[len(vs) // 2 - 1] + vs[len(vs) // 2]) / 2.0
        cl.append({"ft_per_paper_inch": round(med, 3), "n": len(grp),
                   "share_pct": round(100.0 * len(grp) / len(S), 1),
                   "x": round(sum(s["x"] for s in grp) / len(grp), 1),
                   "y": round(sum(s["y"] for s in grp) / len(grp), 1),
                   "min": round(vs[0], 3), "max": round(vs[-1], 3)})
    for i, grp in enumerate(clusters):
        for s in grp:
            s["cluster"] = i
    out["clusters"] = cl
    top = cl[0]
    out["n_agree"] = top["n"]
    out["share_pct"] = top["share_pct"]
    if top["n"] >= MIN_AGREE and top["share_pct"] >= MIN_SHARE_PCT:
        out["implied_ft_per_paper_inch"] = top["ft_per_paper_inch"]
        out["why"] = "dominant"
    elif top["n"] < MIN_AGREE:
        out["why"] = "too-few"
    else:
        out["why"] = "split"
    return out


def compare(check: Optional[dict], ft_per_paper_inch, agree_pct: float = 2.5) -> Optional[dict]:
    """The check against a scale in force: {agrees, delta_pct, ratio_len,
    ratio_area} or None when either side is missing. `ratio_*` is what the
    lengths / areas would move by if the dimensions are right."""
    if not check or not ft_per_paper_inch:
        return None
    imp = check.get("implied_ft_per_paper_inch")
    try:
        imp = float(imp)
        ft = float(ft_per_paper_inch)
    except (TypeError, ValueError):
        return None
    if imp <= 0 or ft <= 0:
        return None
    d = abs(imp - ft) / ft * 100.0
    return {"agrees": d <= agree_pct, "delta_pct": round(d, 1),
            "ratio_len": round(imp / ft, 3), "ratio_area": round((imp / ft) ** 2, 3)}


def describe(check: Optional[dict], ft_per_paper_inch=None) -> str:
    """One plain sentence for a report or a status line."""
    if not check or not check.get("n_printed"):
        return "Dimension check: no printed dimensions were read on this sheet."
    n, m = check.get("n_printed", 0), check.get("n_measured", 0)
    imp = check.get("implied_ft_per_paper_inch")
    if imp is None:
        if check.get("why") == "split" and check.get("clusters"):
            parts = ", ".join("%d at 1 in = %s ft" % (c["n"], _ft(c["ft_per_paper_inch"]))
                              for c in check["clusters"][:3])
            return ("Dimension check: %d of %d printed dimensions were measured and they "
                    "disagree with each other (%s) - more than one scale on this sheet, "
                    "or a detail among the plans. No single reading." % (m, n, parts))
        return ("Dimension check: %d printed dimensions, %d measured against their "
                "extension lines - too few to state a scale." % (n, m))
    head = ("Dimension check: %d of %d printed dimensions measure at 1 in = %s ft "
            "(%d of the %d measured agree)."
            % (check.get("n_agree", 0), n, _ft(imp), check.get("n_agree", 0), m))
    cmp_ = compare(check, ft_per_paper_inch)
    if cmp_ is None:
        return head
    if cmp_["agrees"]:
        return head + " That matches the scale in force."
    return (head + " The scale in force is 1 in = %s ft - %s%% apart. If the dimensions "
            "are right, every length here is off by %sx and every area by %sx."
            % (_ft(ft_per_paper_inch), cmp_["delta_pct"], _ratio(cmp_["ratio_len"]),
               _ratio(cmp_["ratio_area"])))


def _ft(v) -> str:
    try:
        return ("%.2f" % float(v)).rstrip("0").rstrip(".")
    except (TypeError, ValueError):
        return "?"


def _ratio(v) -> str:
    return ("%.2f" % v).rstrip("0").rstrip(".")
