"""Rooms: the enclosed floor area behind a click, off the detected walls.

THE FLOORING TAKEOFF (Shamrock Flooring via Christian, 2026-09-02). By
hand they draw each room, colour it by the flooring that goes in it, add
up the square feet per colour, and separately trace the walls for base /
molding footage. What that needs from the engine:

  * an enclosed room area - the NEGATIVE SPACE between wall lines, which
    nothing else in the engine finds (every other reader follows open
    chains; areas.py reads solid fills only)
  * a boundary that closes ACROSS DOOR OPENINGS, because flooring runs
    through the doorway and the linework leaves that gap open
  * wall footage for the base, with the openings taken back out

HOW. The operator clicks inside a room; the room is whatever the walls
enclose around that click. Concretely:

  1. RASTER the chains of the styles the operator has visible, at `dpi`,
     as `thick`-pixel lines. Visible-only is the role assignment: a
     dimension string or a fixture outline crossing a room would cut it in
     two, and the style checkboxes are how the operator says "these are
     walls, those are not" - the same gesture the whole review UI uses.
  2. BRIDGE each door opening the detector found (extract.door_swings:
     hinge, radius, arc midpoint). The opening in the wall runs from the
     hinge to the strike jamb, one door-width along the wall; which of the
     two arc-endpoint directions that is, the raster itself says - the
     wall continues past the strike jamb, the open leaf points into empty
     room. A thick line is drawn hinge -> strike, closing the gap exactly
     where the door is and nowhere else. No morphological closing wide
     enough to bridge a door: that would also bridge a corridor.
  3. SEAL hairline gaps (a 3 px close): chains that stop a point short of
     the corner they meet. At 1/4" = 1'-0" the narrowest real doorway is
     ~45 pt, so a 3 px seal can never close one.
  4. FLOOD FILL from the click. Leaks to the sheet edge = not enclosed,
     and the answer says so with the size of the leak rather than
     returning the whole sheet as a room.
  5. CONTOUR the fill: outer polygon (simplified to ~1 px), holes kept as
     their own area so a closet or an island counted out of the flooring
     is visible, not silent. Perimeter from the polygon, door widths that
     sit on that boundary subtracted for the base footage.
  6. NAME from the sheet: the room label is text inside the polygon - the
     largest alphabetic line ("MASTER BEDROOM", "BEDROOM 2"), never a
     dimension string.

Every number carries its scale; with no scale the reply is in pt and the
UI says so, the same rule as the structure and trench tools.

WHAT THIS DOES NOT DO. It does not find rooms on its own (no click, no
room) and it does not decide what flooring goes where - the colour is the
estimator's convention, applied in the panel. There is NO truth data for
any of this yet: the corpus is civil, and the first real flooring plans
with the client's own marked-up takeoff beside them are what turns these
numbers from plausible into scored (memory: flooring-calculator-ask).
"""
from __future__ import annotations

import math
import re
from collections import OrderedDict
from typing import Optional

import cv2
import numpy as np

DEFAULT_DPI = 100
WALL_THICK_PX = 2
SEAL_PX = 3
CAVITY_PX = 9
# rays tried for the strike-jamb direction, degrees off the arc-midpoint
# bearing: a 90-degree door puts its endpoints at +-45, a 45-degree door at
# +-22.5, a 135-degree one at +-67.5 - the sweep is not in the record
_JAMB_OFFSETS = tuple(range(20, 71, 5))

_CACHE: "OrderedDict[tuple, np.ndarray]" = OrderedDict()
_CACHE_MAX = 6


def _bearing_ink(mask: np.ndarray, x: float, y: float, ang: float,
                 r0: float, r1: float, step: float = 1.0) -> int:
    """Ink pixels along a ray from (x, y) at bearing `ang` (radians),
    between distances r0 and r1."""
    h, w = mask.shape
    c, s = math.cos(ang), math.sin(ang)
    n = 0
    d = r0
    while d <= r1:
        px, py = int(round(x + c * d)), int(round(y + s * d))
        if 0 <= px < w and 0 <= py < h and mask[py, px]:
            n += 1
        d += step
    return n


def door_bridges(openings: list, ink: np.ndarray, px_per_pt: float) -> list:
    """For each detected door opening, the segment (in pt) that closes the
    gap in the wall: hinge -> strike jamb. Returns [{x0,y0,x1,y1,r,score}].

    WHICH WAY IS THE OPENING. The arc's two endpoints sit at the hinge plus
    r along two bearings: one is the door drawn open (a leaf line of ink
    from the hinge into the room), the other is the door closed, which IS
    the opening - empty, lying along the wall, with the wall continuing on
    the far side of the hinge. So a bearing scores by: ink BEHIND the
    hinge along it (the wall the door hangs in), minus ink AHEAD of the
    hinge short of r (the open leaf). `ink` is the raster of EVERY chain,
    not just the visible styles, so the leaf and the arc count even when
    the operator has hidden them as non-walls. Measured 2026-09-08 on
    Belle A1.00 (27 doors): the first cut scored "ink beyond the jamb" and
    a partition wall 1.2r away in the open-leaf direction won on both
    hall doors, bridging them INTO the rooms; this scoring closes both."""
    out = []
    if not openings:
        return out
    # The rays are one pixel wide and a hinge sits up to a few px off the
    # row its wall is drawn on (the fitted arc centre is not the line), so
    # sample a raster fattened by 3 px each way - a miss by a row must not
    # read as "no wall here"
    ink = cv2.dilate(ink, cv2.getStructuringElement(cv2.MORPH_RECT, (7, 7)))
    for o in openings or []:
        try:
            cx, cy, r = float(o["cx"]), float(o["cy"]), float(o["r"])
            mx, my = float(o["mx"]), float(o["my"])
        except (KeyError, TypeError, ValueError):
            continue
        if r <= 0:
            continue
        mid = math.atan2(my - cy, mx - cx)
        hx, hy = cx * px_per_pt, cy * px_per_pt
        rp = r * px_per_pt
        best, best_score = None, None
        for off in _JAMB_OFFSETS:
            for sign in (1, -1):
                ang = mid + sign * math.radians(off)
                # the wall a door hangs in continues on BOTH sides of the
                # opening: behind the hinge and beyond the strike jamb. The
                # open-leaf direction has neither. The leaf term is only a
                # tie-breaker: a threshold line drawn through the opening
                # reads as "leaf ink" along the wall (Belle A1.00 storage
                # door: 31 hits) and with a heavy weight it vetoed the right
                # direction on every single-leaf door on the sheet.
                behind = _bearing_ink(ink, hx, hy, ang + math.pi, rp * 0.3, rp * 1.5)
                beyond = _bearing_ink(ink, hx, hy, ang, rp * 1.05, rp * 1.8)
                leaf = _bearing_ink(ink, hx, hy, ang, rp * 0.15, rp * 0.9)
                score = 2 * behind + 2 * beyond - leaf
                if best_score is None or score > best_score:
                    best_score, best = score, ang
        if best is None:
            continue
        x1, y1 = cx + r * math.cos(best), cy + r * math.sin(best)
        out.append({"x0": round(cx, 2), "y0": round(cy, 2),
                    "x1": round(x1, 2), "y1": round(y1, 2), "r": round(r, 2),
                    "score": int(best_score)})
    return out


def wall_raster(chains: list, styles: Optional[set], w_pt: float, h_pt: float,
                dpi: int = DEFAULT_DPI, thick: int = WALL_THICK_PX) -> np.ndarray:
    """uint8 mask (255 = wall ink) of the chains whose style is in `styles`
    (None = every chain), drawn as `thick`-px polylines at `dpi`."""
    k = dpi / 72.0
    W, H = max(1, int(round(w_pt * k))), max(1, int(round(h_pt * k)))
    mask = np.zeros((H, W), dtype=np.uint8)
    for ch in chains or []:
        if styles is not None and ch.get("style_id") not in styles:
            continue
        P = ch.get("points") or []
        if len(P) < 2:
            continue
        pts = np.array([[int(round(p[0] * k)), int(round(p[1] * k))] for p in P],
                       dtype=np.int32).reshape(-1, 1, 2)
        cv2.polylines(mask, [pts], False, 255, thickness=thick, lineType=cv2.LINE_8)
    return mask


def _cache_key(job_id, page, dpi, styles, stamp):
    return (job_id, page, dpi, tuple(sorted(styles)) if styles is not None else None, stamp)


def sealed_walls(result: dict, styles: Optional[set], dpi: int, cache_key=None):
    """The wall raster with door bridges drawn and hairline gaps sealed,
    plus the bridge list. Cached per (job, page, dpi, styles, result stamp)
    so a dozen clicks on one sheet rasterise once."""
    if cache_key is not None and cache_key in _CACHE:
        _CACHE.move_to_end(cache_key)
        return _CACHE[cache_key]
    pg = result.get("page") or {}
    w_pt, h_pt = float(pg.get("width_pt") or 0), float(pg.get("height_pt") or 0)
    if w_pt <= 0 or h_pt <= 0:
        raise ValueError("result carries no page size")
    k = dpi / 72.0
    chains = result.get("chains") or []
    wall = wall_raster(chains, styles, w_pt, h_pt, dpi)
    # orientation evidence for the doors comes from EVERY chain (leaf, arc,
    # the wall behind the hinge), whatever the operator has visible
    ink = wall if styles is None else wall_raster(chains, None, w_pt, h_pt, dpi)
    bridges = door_bridges(result.get("openings") or [], ink, k)
    for b in bridges:
        cv2.line(wall, (int(round(b["x0"] * k)), int(round(b["y0"] * k))),
                 (int(round(b["x1"] * k)), int(round(b["y1"] * k))), 255,
                 thickness=WALL_THICK_PX, lineType=cv2.LINE_8)
    if SEAL_PX > 1:
        ker = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (SEAL_PX, SEAL_PX))
        wall = cv2.morphologyEx(wall, cv2.MORPH_CLOSE, ker)
    out = (wall, bridges)
    if cache_key is not None:
        _CACHE[cache_key] = out
        while len(_CACHE) > _CACHE_MAX:
            _CACHE.popitem(last=False)
    return out


_ALPHA = re.compile(r"[A-Za-z]{3,}")
# a dimension string carries feet/inch marks (20'-0", 3'6", 12") or is a
# long / decimal number; a bare "2" is a room number and stays with its line
_DIMENSION = re.compile(r"(^.*['\"″′].*$)|(^\d{3,}$)|(^\d+[.,]\d+$)|(^[\d]+x[\d]+$)")


def room_name(words: list, poly_px: np.ndarray, k: float) -> Optional[str]:
    """The room's label: the tallest alphabetic text line whose centre is
    inside the polygon. `words` are pymupdf 'words' tuples in pt."""
    inside = []
    for wd in words or []:
        try:
            x0, y0, x1, y1, txt = float(wd[0]), float(wd[1]), float(wd[2]), float(wd[3]), str(wd[4])
        except (IndexError, TypeError, ValueError):
            continue
        t = txt.strip()
        if not t or _DIMENSION.match(t):
            continue
        cx, cy = (x0 + x1) / 2 * k, (y0 + y1) / 2 * k
        if cv2.pointPolygonTest(poly_px, (float(cx), float(cy)), False) < 0:
            continue
        inside.append((x0, y0, x1, y1, t))
    if not inside:
        return None
    # group into lines by vertical overlap
    inside.sort(key=lambda w: (round((w[1] + w[3]) / 2 / 3), w[0]))
    lines = []
    for w in inside:
        cy, h = (w[1] + w[3]) / 2, (w[3] - w[1])
        for ln in lines:
            if abs(ln["cy"] - cy) <= 0.5 * max(h, ln["h"]):
                ln["words"].append(w)
                break
        else:
            lines.append({"cy": cy, "h": h, "words": [w]})
    best = None
    for ln in lines:
        ws = sorted(ln["words"], key=lambda w: w[0])
        text = " ".join(w[4] for w in ws)
        if not _ALPHA.search(text):
            continue
        score = (ln["h"], len(text))
        if best is None or score > best[0]:
            best = (score, text)
    return best[1][:60] if best else None


def pick_room(result: dict, words: list, x_pt: float, y_pt: float,
              styles: Optional[set] = None, dpi: int = DEFAULT_DPI,
              cache_key=None, closures: Optional[list] = None) -> dict:
    """The room enclosing (x_pt, y_pt). See the module docstring.

    `closures` are operator-drawn segments [[x0,y0,x1,y1], ...] in pt that
    count as wall for this fill: the fix for a cased opening the sheet
    leaves open, a partition drawn in no line style at all (Belle A1.00
    p1: the storage and office partitions stop at the door hinge and the
    rooms run into the hall as drawn), or a doorway the detector missed.
    Two clicks by the operator, and the fill is honest about it - the
    reply names how many closures it used.

    Returns {"ok": True, polygon, area_sf|None, area_pt2, perim_lf|None,
    perim_pt, openings_lf|None, openings_pt, holes_sf|None, holes_pt2,
    name, bridges_used, closures_used, scale_ft_per_in, dpi} or
    {"ok": False, "why": ...}.
    """
    k = dpi / 72.0
    wall, bridges = sealed_walls(result, styles, dpi, cache_key)
    if closures:
        wall = wall.copy()               # never draw into the cached raster
        for c in closures:
            try:
                x0, y0, x1, y1 = (float(v) for v in c[:4])
            except (TypeError, ValueError):
                continue
            cv2.line(wall, (int(round(x0 * k)), int(round(y0 * k))),
                     (int(round(x1 * k)), int(round(y1 * k))), 255,
                     thickness=WALL_THICK_PX + 1, lineType=cv2.LINE_8)
    H, W = wall.shape
    px, py = int(round(x_pt * k)), int(round(y_pt * k))
    if not (0 <= px < W and 0 <= py < H):
        return {"ok": False, "why": "that point is off the sheet"}
    if wall[py, px]:
        return {"ok": False, "why": "that click landed on a line - click on the open floor inside the room"}
    # flood from the click over the NON-wall pixels
    free = (wall == 0).astype(np.uint8)
    ff_mask = np.zeros((H + 2, W + 2), dtype=np.uint8)
    cv2.floodFill(free, ff_mask, (px, py), 2, loDiff=0, upDiff=0,
                  flags=4 | cv2.FLOODFILL_FIXED_RANGE)
    region = (free == 2).astype(np.uint8)
    # WALL CAVITIES. A CAD wall is two parallel lines a few pt apart, and
    # where it ends at a door jamb the cavity between them is often not
    # capped - so the fill runs into the wall and along it, and the room
    # grows a tendril the width of the wall (Belle A1.00: 371 LF of
    # perimeter and 91 corners on a 4-room fill). An opening by
    # CAVITY_PX removes anything narrower than a wall; no real room or
    # corridor is (9 px is 0.36 ft at 1/4", 0.72 ft at 1/8").
    if CAVITY_PX > 1:
        ker = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (CAVITY_PX, CAVITY_PX))
        opened = cv2.morphologyEx(region, cv2.MORPH_OPEN, ker)
        n_lab, lab = cv2.connectedComponents(opened, connectivity=4)
        if n_lab > 1:
            want = lab[py, px]
            if want == 0:
                # the click sat inside the shaved rim: take the largest piece
                counts = np.bincount(lab.ravel())
                counts[0] = 0
                want = int(counts.argmax())
            region = (lab == want).astype(np.uint8)
    n_px = int(region.sum())
    edge = int(region[0, :].sum() + region[-1, :].sum() + region[:, 0].sum() + region[:, -1].sum())
    if edge > 0:
        sc = _scale(result)
        sf = (n_px / (k * k)) * (sc / 72.0) ** 2 if sc else None
        return {"ok": False,
                "why": "not enclosed - the fill leaked to the edge of the sheet"
                       + (" (%s SF of open floor)" % _fmt(sf) if sf else "")
                       + ". A wall is missing from the visible line types, or a "
                         "doorway the detector did not find is open: show the "
                         "wall style, or draw the room outline instead.",
                "leak_px": n_px}
    contours, hier = cv2.findContours(region, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)
    if not contours or hier is None:
        return {"ok": False, "why": "no enclosed area at that point"}
    hier = hier[0]
    # the outer contour that contains the click (there is one region, but be exact)
    outer_i = None
    for i, c in enumerate(contours):
        if hier[i][3] == -1 and cv2.pointPolygonTest(c, (float(px), float(py)), False) >= 0:
            outer_i = i
            break
    if outer_i is None:
        outer_i = max((i for i in range(len(contours)) if hier[i][3] == -1),
                      key=lambda i: cv2.contourArea(contours[i]), default=0)
    outer = contours[outer_i]
    # The DISPLAY polygon is simplified (~1 px, at most 0.1% of the ring);
    # every NUMBER comes from the unsimplified fill and contours, so a cut
    # corner in the drawing can never move a square foot.
    eps = max(1.0, 0.001 * cv2.arcLength(outer, True))
    poly = cv2.approxPolyDP(outer, eps, True)
    poly_px = poly.reshape(-1, 2).astype(np.float32)
    holes_px = 0.0
    n_holes = 0
    for i, c in enumerate(contours):
        if hier[i][3] == outer_i:
            # a hole is the closet's interior PLUS its own wall ink - the
            # part of the room the flooring does not cover
            holes_px += float(cv2.contourArea(c))
            n_holes += 1
    # perimeter off the simplified ring: the raw raster contour staircases
    # along a diagonal wall and would over-read it by up to 41%
    perim_px = float(cv2.arcLength(poly, True))
    # door widths on THIS boundary: a bridge whose midpoint lies within a
    # wall's thickness of the fill's edge (the bridge is drawn ON the wall
    # line; the fill stops at the ink's inner face)
    used = []
    tol = WALL_THICK_PX + SEAL_PX
    for b in bridges:
        mx, my = (b["x0"] + b["x1"]) / 2 * k, (b["y0"] + b["y1"]) / 2 * k
        d = cv2.pointPolygonTest(outer, (float(mx), float(my)), True)
        if abs(d) <= tol:
            used.append(b)
    openings_pt = sum(b["r"] for b in used)
    pt = 1.0 / k
    area_pt2 = (n_px) * pt * pt                     # filled pixels: holes already out
    holes_pt2 = holes_px * pt * pt
    perim_pt = perim_px * pt
    sc = _scale(result)
    fpp = (sc / 72.0) if sc else None
    out = {
        "ok": True,
        "polygon": [[round(float(p[0]) * pt, 2), round(float(p[1]) * pt, 2)] for p in poly_px],
        "area_pt2": round(area_pt2, 1), "perim_pt": round(perim_pt, 1),
        "openings_pt": round(openings_pt, 1), "holes_pt2": round(holes_pt2, 1),
        "n_holes": n_holes,
        "area_sf": round(area_pt2 * fpp * fpp, 1) if fpp else None,
        "perim_lf": round(perim_pt * fpp, 1) if fpp else None,
        "openings_lf": round(openings_pt * fpp, 1) if fpp else None,
        "holes_sf": round(holes_pt2 * fpp * fpp, 1) if fpp else None,
        "name": room_name(words, poly_px.reshape(-1, 1, 2), k),
        "bridges_used": [{k2: b[k2] for k2 in ("x0", "y0", "x1", "y1", "r")} for b in used],
        "bridges_total": len(bridges),
        "closures_used": len(closures or []),
        "scale_ft_per_in": sc, "dpi": dpi,
    }
    return out


def _scale(result: dict) -> Optional[float]:
    sc = (result or {}).get("scale") or {}
    v = sc.get("ft_per_paper_inch")
    try:
        v = float(v)
    except (TypeError, ValueError):
        return None
    return v if v > 0 else None


def _fmt(v) -> str:
    return "{:,.0f}".format(v) if v is not None else "?"
