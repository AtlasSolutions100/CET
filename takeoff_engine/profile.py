"""Profile-view detection: find the graphs on a sheet and calibrate their axes.

A PROFILE is a graph drawn on a construction sheet - distance along a route
(stationing) on X, elevation on Y, with the vertical deliberately exaggerated
so grade changes are readable. (CONVENTION: general civil practice for
plan-and-profile drawings. Corroborated on this corpus by Sheridan
WASHINGTON ST p2, which prints "NOTE: PROFILE VERTICALLY EXAGGERATED 3:1",
and by Belle Farms ROAD GRADING 1 of 2, whose caption states both scales.)

There is NO linear construction quantity inside a profile. Its grid, its
ground line and its grade line are a picture of elevations, not lengths of
anything that gets built. On Belle Farms ROAD GRADING 1 of 2 engine page
index 0 the engine currently emits 58,896.7 pt of profile as 49,081 ft of
takeoff - 17.2% of that sheet. On Loves Lane C9.1 it is 60.7%.

--------------------------------------------------------------------------
WHAT THIS MODULE DOES AND DOES NOT DO
--------------------------------------------------------------------------
It locates profile regions and reports their axis calibration, with the
provenance of every number. It is a pure function of the page: it imports
only `takeoff_engine.extract`, mutates nothing, and is wired to nothing.
`detect_page` does not call it; see WIRING at the bottom of this file for
what that would take.

It does NOT compute a cut/fill volume, and must not be extended to.
A profile is a CENTRELINE. Cubic yards additionally need the typical
cross-section (roadway width, side-slope ratio, subgrade depth) which lives
on a different sheet, and a shrink/swell factor which is usually in a soils
report and often not in the plan set at all. A volume produced from a
centreline alone would be a confident wrong number with no visible symptom.

--------------------------------------------------------------------------
WHY THREE BRANCHES
--------------------------------------------------------------------------
Measured over 706 corpus PDFs / 6,724 pages on 2026-08-23
(out/verify/2026-08-22/profile-survey/SURVEY.md), 57 pages in 21 documents
carry a profile. No single signal reaches them all:

  LAYER   at least 42 pages draw on a CAD layer named *PROF*/*PROFILE*.
          Unambiguous where present - and it is the ONLY signal on the 28
          pages whose drawing text was converted to outlines or rasterised
          (all 10 Loves Lane sheets, Bozeman p3-p17 and p26, Approved
          Construction Set p3/p4). But 0.0% of Gardiner's profile-box length
          carries any layer at all, and 1.1% of Belle Farms 1of2's.
          Read layers from extract_strokes, NOT from doc.get_ocgs(): SWR
          Barn Civil's OCG dictionary declares no PROF layer while its page
          streams draw 122,400.2 pt on three of them.
  LABELS  24 pages carry both a station-label axis and an elevation-label
          axis. This is the only branch that yields a SCALE.
  CAPTION 35 pages print an explicit HORIZONTAL and VERTICAL scale pair.
          Used as a cross-check, never as the primary: it is stale on Belle
          Farms 2 of 2 (says 1"=80'/1"=20', the labels measure 59.99/15.00)
          and 2x out on the three half-size 17x11 documents, where the
          labels describe the PDF and the caption describes a full-size
          print that this PDF is not.

Ranking is explicit and every result says which branch fired
(`ProfileRegion.source`), per CLAUDE.md sec.5 "first-writer-wins discards
the right answer".

--------------------------------------------------------------------------
WHY IT ABSTAINS
--------------------------------------------------------------------------
Two things on a PLAN look exactly like a profile axis and are not: contour
labels running down a slope, and stationing along a curved alignment. Both
appear on Gardiner water main p299, whose upper drawing is a plan.

Measured margin over 110 label series on the 57 pages:

    genuine axis series (105):  max residual  0.842 ft, max (1-r2) 1.35e-5
    impostors             (5):  min residual  2.593 ft, min (1-r2) 2.33e-3

3.1x on residual, 173x on (1-r2). `MAX_RESID_FT` sits at the genuine end of
that band and `ABSTAIN_RESID_FT` at the impostor end; a series that lands
between them is returned with `abstain=True` and no scale, rather than being
guessed either way.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

import numpy as np

from .extract import StrokeUnit, page_words

# --- station / elevation label grammar ------------------------------------
# A station: 0+00, 12+39, 100+25, 15+56.97. The lookarounds stop 1+2 and stop
# a match inside a longer number.
_STA = re.compile(r"^(\d{1,3})\+(\d{2}(?:\.\d+)?)$")
# An elevation axis label is a bare 3-5 digit integer. Decimals are DATA, not
# axis labels: every axis series in the corpus is whole-numbered.
_INT = re.compile(r"^(\d{3,5})$")

_IN = r"""(?:["”″]|(?:inch(?:es)?|in)\.?(?![a-z]))"""
_FT = r"""(?:['’′]|(?:feet|ft)\.?(?![a-z]))"""
_RAT = rf"""(\d+(?:\.\d+)?)\s*{_IN}\s*(?:[=:\-]\s*){{1,2}}(\d+(?:\.\d+)?)\s*{_FT}?"""
# Both word orders seen in the corpus, and both spellings of HORZ:
#   "HORIZONTAL SCALE: 1" = 20'"   (Loves Lane, Bozeman, East Gallatin)
#   "SCALE: HORZ. 1"=20'"          (Beaumont SWR)
#   "PROFILE 1"=80' (HOR), 1"=20' (VERT)"   (Belle Farms)
_H_FIRST = re.compile(rf"(?i)HOR(?:IZ|Z)?[A-Z]*\.?\s*(?:SCALE)?\s*[:=]?\s*{_RAT}", re.X)
_V_FIRST = re.compile(rf"(?i)VER(?:T)?[A-Z]*\.?\s*(?:SCALE)?\s*[:=]?\s*{_RAT}", re.X)
_H_LAST = re.compile(rf"(?i){_RAT}\s*[(\[]?\s*HOR", re.X)
_V_LAST = re.compile(rf"(?i){_RAT}\s*[(\[]?\s*VER", re.X)

# CAD layer tokens that name a profile view. Same vocabulary as
# earthwork._NON_PLAN_LAYER, deliberately: it was read off the drafters' own
# layer names and it matches every profile layer in the corpus
# (C-PROFILE-EG/FG, O-PROF-VIEW-*, C-ROAD-PROF-*, PNP-PROF-*, U-*-PROFILE,
# OBJ_PROFILE, Stream-CT-PROF-FGC).
_PROF_LAYER = re.compile(r"(?i)(?:^|[-_|\s])(PROF|PROFILE)(?:[-_|\s]|$)")

# --- tuning constants, each with the measurement behind it -----------------
# Sort-and-walk gap tolerances. A label row is one text line; 6.0 pt is far
# under the smallest inter-row gap seen (Hurricane p11 labels the same box at
# top and foot, 585 pt apart) and over the largest within-row baseline wobble
# measured (0.4 pt on Gardiner p299's plan stationing).
ROW_TOL_PT = 6.0
# Elevation labels sit in one column. 8.0 pt covers the drift of a
# right-aligned column between 3- and 4-digit values.
COL_TOL_PT = 8.0
MIN_LABELS = 4          # 4 is the smallest genuine series in the corpus
                        # (SWR Barn p7/p10/p11 elevation columns, n=4)
MIN_SPAN_PT = 200.0     # smallest genuine station row span: 516 pt
                        # (East Gallatin p3). 200 leaves headroom without
                        # admitting a 3-label callout cluster.
MIN_COL_SPAN_PT = 100.0
# Constant-step test for an elevation column. Every genuine column in the
# corpus is exactly constant; 2% admits rounding in the label centres.
STEP_TOL = 0.02
# See "WHY IT ABSTAINS". Genuine worst 0.842 ft; best impostor 2.593 ft.
MAX_RESID_FT = 1.0
ABSTAIN_RESID_FT = 2.5


@dataclass
class AxisFit:
    """A label series fitted to a straight line, with its own error bars."""

    kind: str                  # "station" | "elevation"
    n: int
    labels: list[str]
    pos0: float                # page coord ALONG the axis, first label
    pos1: float                # page coord ALONG the axis, last label
    across: float              # page coord ACROSS it: a station row's y,
                               # an elevation column's x
    val0: float                # ft
    val1: float
    step_ft: float             # 0.0 when the labels are not evenly stepped
    ft_per_pt: float           # signed: negative Y = elevation up the page
    ft_per_paper_inch: float   # abs(ft_per_pt) * 72
    max_resid_ft: float
    r2: float
    left_to_right: bool = True  # station series only; False on SWR Barn p9

    @property
    def trustworthy(self) -> bool:
        return self.max_resid_ft <= MAX_RESID_FT

    @property
    def abstain(self) -> bool:
        """True in the band between a good fit and a known impostor."""
        return MAX_RESID_FT < self.max_resid_ft <= ABSTAIN_RESID_FT


@dataclass
class ProfileRegion:
    """One profile graph on one page. A page may carry several."""

    box: tuple[float, float, float, float]   # page coords, x0 y0 x1 y1
    source: str          # "layer" | "labels" | "caption+layer" | ...
    why: str             # one sentence naming the evidence
    station: AxisFit | None = None
    elevation: AxisFit | None = None
    caption_h_ft_per_in: float | None = None
    caption_v_ft_per_in: float | None = None
    layers: list[str] = field(default_factory=list)
    layer_len_pt: float = 0.0
    notes: list[str] = field(default_factory=list)

    # ---- what a caller actually wants -----------------------------------
    @property
    def h_ft_per_paper_inch(self) -> float | None:
        """Horizontal scale, LABELS FIRST. None when nothing is trustworthy.

        The caption is never preferred over a good label fit: it is stale on
        Belle Farms 2 of 2 and 2x out on every half-size sheet in the corpus.
        """
        if self.station and self.station.trustworthy:
            return self.station.ft_per_paper_inch
        return self.caption_h_ft_per_in

    @property
    def v_ft_per_paper_inch(self) -> float | None:
        if self.elevation and self.elevation.trustworthy:
            return self.elevation.ft_per_paper_inch
        return self.caption_v_ft_per_in

    @property
    def exaggeration(self) -> float | None:
        h, v = self.h_ft_per_paper_inch, self.v_ft_per_paper_inch
        return (h / v) if (h and v) else None

    @property
    def caption_disagrees(self) -> float | None:
        """Ratio caption/labels when both exist and differ by >2%.

        A finding, not an error: on the three half-size documents the caption
        is right for the full-size print and the labels are right for this
        PDF, and the engine measures this PDF.
        """
        worst = None
        for cap, fit in ((self.caption_h_ft_per_in, self.station),
                         (self.caption_v_ft_per_in, self.elevation)):
            if cap and fit and fit.trustworthy and fit.ft_per_paper_inch:
                r = cap / fit.ft_per_paper_inch
                if abs(r - 1.0) > 0.02 and (worst is None
                                            or abs(r - 1) > abs(worst - 1)):
                    worst = r
        return worst


# ==========================================================================
# helpers
# ==========================================================================
def _walk(items: list, tol: float, key) -> list[list]:
    """Sort-and-walk gap clustering.

    NOT round(x/TOL): a bucket answers "which bin", not "are these within
    TOL of each other", and a bin edge between two labels splits a real
    series. CLAUDE.md sec.5, defect shape A.
    """
    out: list[list] = []
    for v in sorted(items, key=key):
        if out and key(v) - key(out[-1][-1]) <= tol:
            out[-1].append(v)
        else:
            out.append([v])
    return out


def _dedupe(words: list) -> list:
    """Drop words drawn twice at the same coordinates.

    Hurricane Storage prints every station and elevation label TWICE at
    identical positions (verified on engine page index 11: "0+00" at
    (884.2, 667.0) twice, and so for every label in the row). Left in, the
    tied pair fails a strict monotonic test and five real profile pages
    score as having no axis.
    """
    seen, out = set(), []
    for w in words:
        k = (round(w[0], 1), round(w[1], 1), round(w[2], 1), round(w[3], 1),
             str(w[4]).strip())
        if k in seen:
            continue
        seen.add(k)
        out.append(w)
    return out


def _monotonic(vs: list[float]) -> bool:
    return (all(b > a for a, b in zip(vs, vs[1:]))
            or all(b < a for a, b in zip(vs, vs[1:])))


def _lsq(xs: list[float], ys: list[float]):
    n = len(xs)
    mx, my = sum(xs) / n, sum(ys) / n
    sxx = sum((x - mx) ** 2 for x in xs)
    if sxx == 0:
        return None
    m = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / sxx
    b = my - m * mx
    res = [y - (m * x + b) for x, y in zip(xs, ys)]
    syy = sum((y - my) ** 2 for y in ys)
    r2 = 1 - sum(r * r for r in res) / syy if syy else 1.0
    return m, b, max(abs(r) for r in res), r2


def read_captions(words: list) -> tuple[float | None, float | None]:
    """The page's stated horizontal and vertical scale, in ft per paper inch.

    Returns (None, None) when the page states no pair - true of Hurricane,
    Gardiner and Sheridan, which give a graphic bar or nothing at all.
    """
    full = re.sub(r"\s+", " ", " ".join(str(w[4]).strip() for w in words))
    hm, vm = _H_FIRST.search(full), _V_FIRST.search(full)
    if not (hm and vm):
        hm, vm = _H_LAST.search(full), _V_LAST.search(full)
    if not (hm and vm):
        return None, None
    try:
        h = float(hm.group(2)) / float(hm.group(1))
        v = float(vm.group(2)) / float(vm.group(1))
    except (ValueError, ZeroDivisionError):
        return None, None
    return h, v


def station_axes(words: list) -> list[AxisFit]:
    """Every row of >=4 station labels that behaves like an axis."""
    pts = []
    for x0, y0, x1, y1, *rest in words:
        m = _STA.match(str(rest[0]).strip())
        if m:
            pts.append(((y0 + y1) / 2, (x0 + x1) / 2,
                        int(m.group(1)) * 100 + float(m.group(2)),
                        str(rest[0]).strip()))
    out = []
    for row in _walk(pts, ROW_TOL_PT, lambda e: e[0]):
        if len(row) < MIN_LABELS:
            continue
        row = sorted(row, key=lambda e: e[1])
        if not _monotonic([e[2] for e in row]):
            continue
        if row[-1][1] - row[0][1] < MIN_SPAN_PT:
            continue
        f = _lsq([e[1] for e in row], [e[2] for e in row])
        if not f:
            continue
        m, _b, mr, r2 = f
        steps = {round(b[2] - a[2], 2) for a, b in zip(row, row[1:])}
        out.append(AxisFit(
            kind="station", n=len(row), labels=[e[3] for e in row],
            pos0=row[0][1], pos1=row[-1][1],
            across=sum(e[0] for e in row) / len(row),
            val0=row[0][2], val1=row[-1][2],
            step_ft=(steps.pop() if len(steps) == 1 else 0.0),
            ft_per_pt=m, ft_per_paper_inch=abs(m) * 72.0,
            max_resid_ft=mr, r2=r2, left_to_right=m > 0))
    return sorted(out, key=lambda a: (-a.n, a.max_resid_ft))


def elevation_axes(words: list) -> list[AxisFit]:
    """Every column of >=4 evenly-stepped integers that behaves like an axis.

    The even-step test is what keeps CONTOUR labels out: contours are evenly
    stepped in VALUE too, but they are not evenly stepped in POSITION, which
    the residual test then catches (Gardiner p299: step exactly 5 ft, fit
    residual 2.593 ft against 0.026 ft for a real axis).
    """
    pts = []
    for x0, y0, x1, y1, *rest in words:
        m = _INT.match(str(rest[0]).strip())
        if m:
            pts.append(((x0 + x1) / 2, (y0 + y1) / 2, float(m.group(1)),
                        str(rest[0]).strip()))
    out = []
    for col in _walk(pts, COL_TOL_PT, lambda e: e[0]):
        if len(col) < MIN_LABELS:
            continue
        col = sorted(col, key=lambda e: e[1])
        if not _monotonic([e[2] for e in col]):
            continue
        if col[-1][1] - col[0][1] < MIN_COL_SPAN_PT:
            continue
        steps = [abs(b[2] - a[2]) for a, b in zip(col, col[1:])]
        if min(steps) <= 0 or (max(steps) - min(steps)) / max(steps) > STEP_TOL:
            continue
        f = _lsq([e[1] for e in col], [e[2] for e in col])
        if not f:
            continue
        m, _b, mr, r2 = f
        out.append(AxisFit(
            kind="elevation", n=len(col), labels=[e[3] for e in col],
            pos0=col[0][1], pos1=col[-1][1],
            across=sum(e[0] for e in col) / len(col),
            val0=col[0][2], val1=col[-1][2],
            step_ft=steps[0], ft_per_pt=m, ft_per_paper_inch=abs(m) * 72.0,
            max_resid_ft=mr, r2=r2))
    return sorted(out, key=lambda a: (-a.n, a.max_resid_ft))


def layer_regions(units: list[StrokeUnit]) -> list[ProfileRegion]:
    """Profile boxes from CAD layer names alone.

    This is the branch for the 28 pages whose drawing text is outlines or
    raster. On Loves Lane C9.1 it returns the box (354.1, 836.0)-(2096.8,
    1510.0) holding 92,316.1 pt on five O-PROF-* layers, on a page whose
    entire text layer is 84 words.
    """
    hits = [u for u in units if u.layer and _PROF_LAYER.search(u.layer)]
    if not hits:
        return []
    # One region per connected cluster of profile-layer geometry would be
    # better; a single bbox is what is justified by what has been measured,
    # and the caller is told so.
    pts = np.vstack([u.pts for u in hits])
    box = (float(pts[:, 0].min()), float(pts[:, 1].min()),
           float(pts[:, 0].max()), float(pts[:, 1].max()))
    by_layer: dict[str, float] = {}
    for u in hits:
        by_layer[u.layer] = by_layer.get(u.layer, 0.0) + u.length
    total = sum(by_layer.values())
    note = ("single bounding box over all profile-layer geometry; if the "
            "sheet carries two stacked profiles this box spans both")
    return [ProfileRegion(
        box=box, source="layer",
        why=(f"{len(hits)} stroke units totalling {total:,.1f} pt on "
             f"{len(by_layer)} CAD layer(s) matching PROF/PROFILE"),
        layers=sorted(by_layer, key=lambda k: -by_layer[k]),
        layer_len_pt=total, notes=[note])]


def _merge_overlapping(regions: list[ProfileRegion]) -> list[ProfileRegion]:
    """Union regions whose boxes overlap; keep the better-fitting axes.

    Overlap, not proximity. Two different drawings on one page (Gardiner
    p299: a plan above a profile) have disjoint boxes and stay separate. Two
    label rows of the SAME graph always overlap, because the elevation column
    spans the box between them - Belle Farms 1 of 2 and Hurricane p11 both
    label one box at top and foot, 646 pt and 585 pt apart.
    """
    out: list[ProfileRegion] = []
    for r in sorted(regions, key=lambda z: -(z.box[2] - z.box[0])):
        for q in out:
            if (r.box[0] < q.box[2] and r.box[2] > q.box[0]
                    and r.box[1] < q.box[3] and r.box[3] > q.box[1]):
                q.box = (min(q.box[0], r.box[0]), min(q.box[1], r.box[1]),
                         max(q.box[2], r.box[2]), max(q.box[3], r.box[3]))
                # keep whichever station fit has more labels; a longer series
                # is a better-conditioned fit, not merely a luckier one
                if r.station and (q.station is None
                                  or r.station.n > q.station.n):
                    q.station = r.station
                if r.elevation and (q.elevation is None
                                    or r.elevation.n > q.elevation.n):
                    q.elevation = r.elevation
                for n in r.notes:
                    if n not in q.notes:
                        q.notes.append(n)
                break
        else:
            out.append(r)
    return out


def find_profiles(page, units: list[StrokeUnit] | None = None
                  ) -> list[ProfileRegion]:
    """Every profile region on one page, best-evidenced branch first.

    `page` is a pymupdf Page. `units` is extract_strokes(page) if the caller
    already has it; pass it to avoid a second extraction on a heavy sheet.
    Read-only: nothing on the page or in `units` is mutated.
    """
    words = _dedupe(page_words(page))
    cap_h, cap_v = read_captions(words)
    sax = station_axes(words)
    eax = elevation_axes(words)

    regions: list[ProfileRegion] = []

    # --- branch 1: labels. The only branch that yields a scale. ----------
    # Pair each station row with the elevation column whose y-range contains
    # it, so a page carrying two DIFFERENT drawings does not merge them into
    # one poisoned fit (Gardiner p299 is a plan above a profile).
    used_elev: set[int] = set()
    for s in sax:
        best, best_i = None, None
        for i, e in enumerate(eax):
            if i in used_elev:
                continue
            lo, hi = min(e.pos0, e.pos1), max(e.pos0, e.pos1)
            # the station row sits at the top or the foot of the box, so its
            # y must be within a caption's height of the column's y range.
            if not (lo - 120 <= s.across <= hi + 120):
                continue
            if best is None or e.n > best.n:
                best, best_i = e, i
        if best is None:
            continue
        used_elev.add(best_i)
        # the box is the union of the two label extents: the station row
        # gives x, the elevation column gives y, and the column's own x
        # position is one edge of the box.
        xs = sorted((s.pos0, s.pos1, best.across))
        ys = sorted((best.pos0, best.pos1, s.across))
        r = ProfileRegion(
            box=(xs[0], ys[0], xs[-1], ys[-1]),
            source="labels",
            why=(f"{s.n} station labels {s.labels[0]}..{s.labels[-1]} at "
                 f"{s.ft_per_paper_inch:.4f} ft/paper-in (max resid "
                 f"{s.max_resid_ft:.3f} ft) crossed with {best.n} elevation "
                 f"labels {best.labels[0]}..{best.labels[-1]} at "
                 f"{best.ft_per_paper_inch:.4f} (max resid "
                 f"{best.max_resid_ft:.3f} ft)"),
            station=s, elevation=best,
            caption_h_ft_per_in=cap_h, caption_v_ft_per_in=cap_v)
        if s.abstain or best.abstain:
            r.notes.append(
                "ABSTAIN: a label series fits worse than a genuine axis "
                "(<=0.842 ft measured) but better than a known impostor "
                "(>=2.593 ft). No scale is asserted.")
        if not s.trustworthy or not best.trustworthy:
            r.notes.append(
                "at least one label series fails the residual test; it is "
                "probably plan contour labels or curved-alignment stationing, "
                "not an axis (Gardiner p299 is the measured example)")
        d = r.caption_disagrees
        if d is not None:
            r.notes.append(
                f"CAPTION DISAGREES WITH LABELS by {d:.3f}x. Believe the "
                f"labels: they describe this PDF. On the corpus this is "
                f"either a stale caption copied between sheets (Belle Farms "
                f"2 of 2) or a half-size reproduction whose caption is true "
                f"of the full-size print (East Gallatin, 17x11 pt page).")
        if not s.left_to_right:
            r.notes.append("stationing runs RIGHT TO LEFT on this sheet "
                           "(SWR Barn Civil p9 is the measured example)")
        regions.append(r)

    # A profile is normally labelled TWICE along X - a station row at the top
    # of the box and another at the foot (Belle Farms 1 of 2: y = 108.5 and
    # y = 754.5, 22 and 20 labels, fitting 80.0157 and 80.0164). Both pair
    # with the same elevation column, so the loop above emits one region per
    # row. Merge regions that overlap: they are one graph.
    regions = _merge_overlapping(regions)

    # --- branch 2: CAD layer. Adds the outlined-text pages. --------------
    if units is not None:
        for lr in layer_regions(units):
            lr.caption_h_ft_per_in = cap_h
            lr.caption_v_ft_per_in = cap_v
            # If a label-derived region already covers this box, merge the
            # evidence rather than reporting the same graph twice.
            merged = False
            for r in regions:
                if (lr.box[0] < r.box[2] and lr.box[2] > r.box[0]
                        and lr.box[1] < r.box[3] and lr.box[3] > r.box[1]):
                    r.layers = lr.layers
                    r.layer_len_pt = lr.layer_len_pt
                    r.source = "labels+layer"
                    r.why += f"; {lr.why}"
                    merged = True
                    break
            if not merged:
                if cap_h and cap_v:
                    lr.source = "layer+caption"
                    lr.why += (f"; page states H 1\"={cap_h:g}' "
                               f"V 1\"={cap_v:g}'")
                lr.notes.append(
                    "no readable station or elevation labels on this page - "
                    "the drawing text is outlines or raster. Scale here comes "
                    "from the caption only and has NOT been corroborated "
                    "against label geometry.")
                regions.append(lr)

    # --- branch 3: caption alone. Detect only, never calibrate. ----------
    if not regions and cap_h and cap_v and abs(cap_h - cap_v) > 1e-9:
        regions.append(ProfileRegion(
            box=(0.0, 0.0, 0.0, 0.0), source="caption",
            why=(f"page states two different scales for one drawing "
                 f"(H 1\"={cap_h:g}', V 1\"={cap_v:g}'), which only a profile "
                 f"or a section does"),
            caption_h_ft_per_in=cap_h, caption_v_ft_per_in=cap_v,
            notes=["region NOT located: no labels and no profile CAD layer. "
                   "Flag the page for a human; do not exclude geometry on "
                   "this evidence alone."]))
    return regions


def strokes_in_profile(units: list[StrokeUnit],
                       regions: list[ProfileRegion],
                       pad_pt: float = 12.0) -> tuple[list[int], float]:
    """Indices of `units` wholly inside a located profile box, and their pt.

    Wholly inside, not merely overlapping: a match line or a leader that
    crosses the box edge belongs to the plan. `pad_pt` matches the slack the
    survey used so the numbers in SURVEY.md reproduce.

    A region whose box is (0,0,0,0) - branch 3, caption only - selects
    nothing, deliberately.
    """
    idx: list[int] = []
    total = 0.0
    boxes = [r.box for r in regions if r.box[2] > r.box[0]]
    if not boxes:
        return idx, total
    for i, u in enumerate(units):
        p = u.pts
        xs0, xs1 = float(p[:, 0].min()), float(p[:, 0].max())
        ys0, ys1 = float(p[:, 1].min()), float(p[:, 1].max())
        for bx0, by0, bx1, by1 in boxes:
            if (xs0 >= bx0 - pad_pt and xs1 <= bx1 + pad_pt
                    and ys0 >= by0 - pad_pt and ys1 <= by1 + pad_pt):
                idx.append(i)
                total += u.length
                break
    return idx, total


# ==========================================================================
# WIRING - what detect_page / server.py would need. NOT DONE HERE.
# ==========================================================================
# Nothing in this file is called by anything. To use it:
#
# 1. takeoff_engine/detect_page.py
#    After extract_strokes and BEFORE build_chains, call
#        regions = profile.find_profiles(page, units)
#    and put a serialised form on the result dict as `result["profiles"]`
#    (box, source, why, h/v ft-per-paper-inch, exaggeration, notes). Adding
#    a key is additive and cannot move the gate on its own.
#    Excluding the geometry is a SEPARATE, larger change: strokes_in_profile
#    gives the indices, but dropping them changes every downstream count on
#    the 57 pages and needs its own before/after corpus diff. Do not smuggle
#    it in with the reporting change.
#    detect_page.py is in _ENGINE_FILES, so touching it changes engine_sig
#    and every cached result re-detects. Expect a full corpus re-run.
#
# 2. takeoff_engine/scale_detect.py
#    ScaleResult.ft_per_paper_inch is a single isotropic scalar and is
#    structurally unable to describe a page with a horizontal and a vertical
#    scale (F126). A profile region carries two. Either scale_detect grows a
#    per-region scale, or the profile regions stay a separate field and the
#    takeoff refuses to price anything inside one. The second is smaller and
#    is what the abstain-first posture argues for.
#
# 3. server.py + webui/app.js
#    A `profiles` array on the result wants a panel row per region: the box,
#    which branch fired, both scales with their provenance, and the caption
#    disagreement when there is one. The UI should be able to isolate a
#    profile region the way it isolates a style, so a reviewer can see what
#    is being held back. server.py is CRLF; webui/* is LF.
#
# 4. Gate
#    This module is off the chain path entirely - it imports extract only and
#    is called by nothing - so `python -m takeoff_engine.regress` must be
#    unchanged by its presence. Run it as a collateral guard, not as
#    evidence that the module works.
