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
_LEAF_OFFSETS = (0, 10, 20, 30, 40, 45, 50, 60, 70, 80, 90)

_DOOR_LAYER = re.compile(r"door|swing|opng|openin|dr\b", re.I)

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


def _disk_ink(mask: np.ndarray, x: float, y: float, rad: int) -> int:
    """Ink pixels within `rad` px of (x, y)."""
    h, w = mask.shape
    px, py = int(round(x)), int(round(y))
    if not (0 <= px < w and 0 <= py < h):
        return 0
    sub = mask[max(0, py - rad):py + rad + 1, max(0, px - rad):px + rad + 1]
    return int((sub > 0).sum())


def door_bridges(openings: list, ink: np.ndarray, px_per_pt: float,
                 wall: Optional[np.ndarray] = None) -> list:
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
    # sample rasters fattened by 3 px each way - a miss by a row must not
    # read as "no wall here". WALL evidence (behind the hinge, beyond the
    # jamb) is read off the wall raster when one is given: on the full ink
    # the bed drawn under a bedroom door counted as "wall behind" and the
    # opening was bridged into the room (Seer Stone A2.1 bed 2). The leaf
    # test stays on the full ink, where the leaf is.
    ker = cv2.getStructuringElement(cv2.MORPH_RECT, (7, 7))
    ink = cv2.dilate(ink, ker)
    wall = ink if wall is None else cv2.dilate(wall, ker)
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
        # CANDIDATE BEARINGS. An arc door found from its chain carries its
        # two arc-end bearings exactly (a0, a1): the opening is one of the
        # two, no search. A unit-pass record has only the arc midpoint, so
        # the ends are somewhere 20-70 degrees off it; a leaf's "mid" is
        # the leaf tip and the opening lies 0-90 degrees off it.
        if o.get("a0") is not None and o.get("a1") is not None:
            cands = [float(o["a0"]), float(o["a1"])]
        else:
            offsets = _LEAF_OFFSETS if o.get("source") == "leaf" else _JAMB_OFFSETS
            cands = [mid + sign * math.radians(off) for off in offsets for sign in (1, -1)]
        rad = max(3, int(round(6.0 * px_per_pt)))
        for ang in cands:
            # THE STRIKE JAMB IS ON THE WALL. The far end of the opening
            # sits on the wall line; the far end of the open leaf stands in
            # the room. That disk test decides; the wall continuing behind
            # the hinge and beyond the jamb corroborates; leaf ink along the
            # bearing is a tie-breaker only (a threshold line through the
            # opening reads as leaf ink, Belle A1.00 storage door: 31 hits).
            sx, sy = hx + rp * math.cos(ang), hy + rp * math.sin(ang)
            strike = _disk_ink(wall, sx, sy, rad)
            behind = _bearing_ink(wall, hx, hy, ang + math.pi, rp * 0.3, rp * 1.5)
            beyond = _bearing_ink(wall, hx, hy, ang, rp * 1.05, rp * 1.8)
            leaf = _bearing_ink(ink, hx, hy, ang, rp * 0.15, rp * 0.9)
            score = 3 * strike + 2 * behind + 2 * beyond - leaf
            if best_score is None or score > best_score:
                best_score, best = score, ang
        if best is None:
            continue
        x1, y1 = cx + r * math.cos(best), cy + r * math.sin(best)
        out.append({"x0": round(cx, 2), "y0": round(cy, 2),
                    "x1": round(x1, 2), "y1": round(y1, 2), "r": round(r, 2),
                    "score": int(best_score)})
    return out


def doors_from_chains(chains: list, scale_ft_per_in: Optional[float] = None,
                      known: Optional[list] = None, ink: Optional[np.ndarray] = None,
                      px_per_pt: float = 1.0) -> list:
    """Door swings the detector's unit pass cannot see: a DASHED arc.

    extract.door_swings works on stroke units and needs an arc that is one
    polyline. A drafter who draws the swing dashed (Wells Built / Seer
    Stone A2.1, layer A-Door: every door on the sheet) gives the unit pass
    forty 2-point dashes and no arc, so that sheet reported 0 doors. The
    chain builder, though, joins the dashed arc and its solid leaf into
    ONE chain - measured there: 27 A-Door chains, bbox a square of side
    r = 42 / 48 / 54 pt (2'-4", 2'-8", 3'-0" at 1/4"), length 2.57 r
    (quarter arc 1.571 r + leaf 1.0 r), 40-88 points.

    So: a chain whose bbox is square (within 12%), whose length is a
    quarter arc plus a leaf (2.3-2.85 r) or a bare quarter arc (1.45-1.7
    r), and whose points sit either on the circle of radius r about one
    bbox corner or on the two bbox edges out of that corner (>= 85% of
    them, 7% tolerance) is a door hinged at that corner. r is gated to
    1.25-6 ft when the scale is known, 8-80 pt otherwise - the same window
    door_swings uses. Emits the same {cx, cy, r, mx, my} record, skipping
    any hinge the unit pass already reported within r/4."""
    out = []
    if scale_ft_per_in and scale_ft_per_in > 0:
        ppf = 72.0 / scale_ft_per_in
        r_lo, r_hi = 1.25 * ppf, 6.0 * ppf
    else:
        r_lo, r_hi = 8.0, 80.0
    known_pts = [(float(o.get("cx", 0)), float(o.get("cy", 0)), float(o.get("r", 0)))
                 for o in (known or []) if isinstance(o, dict)]
    for ch in chains or []:
        P = ch.get("points") or []
        if len(P) < 8:
            continue
        # A LAYER NAME IS EVIDENCE. When the drafter named the layer, a door
        # is on a door layer; a quarter-arc on SIT-TREE or North Arrow is a
        # tree or an arrow (Approved Construction Set 3.0: 10 phantom doors
        # by geometry alone, 0 with this gate). Unnamed chains (Belle's
        # sheets carry no layers) are judged by geometry.
        layer = str(ch.get("layer") or "").strip()
        if layer and not _DOOR_LAYER.search(layer):
            continue
        xs = [p[0] for p in P]
        ys = [p[1] for p in P]
        w, h = max(xs) - min(xs), max(ys) - min(ys)
        short = min(w, h)
        if short <= 0 or short < r_lo * 0.8 or max(w, h) > 1.6 * r_hi:
            continue
        L = float(ch.get("length_pt") or 0)
        fit = _fit_door(P, L, r_lo, r_hi)
        if fit is None:
            continue
        hx, hy, r, mx, my, a0, a1 = fit
        if any(math.hypot(hx - kx, hy - ky) <= max(kr, r) / 4.0 for kx, ky, kr in known_pts):
            continue
        out.append({"cx": round(hx, 1), "cy": round(hy, 1), "r": round(r, 1),
                    "mx": round(mx, 1), "my": round(my, 1), "source": "chain",
                    "a0": round(a0, 4), "a1": round(a1, 4),
                    "chain_id": ch.get("chain_id")})
    # THE LEAF PASS. A double door, a pair, a bi-fold run: several arcs in
    # one chain, which no single circle fits (Seer Stone A2.1 bed 2: chain
    # 721, two 45-degree arcs side by side; the foyer closet: three). Those
    # doors still draw their LEAVES as plain 2-point strokes on the door
    # layer, one per door, each exactly one door-width long. A leaf is a
    # door whose hinge is the end that sits on wall ink; the far end stands
    # in for the arc midpoint, and door_bridges tries bearings 0-90 degrees
    # off it (a leaf drawn closed lies IN the opening, at 0). Needs the ink
    # raster to tell the ends apart, and a named door layer - an unnamed
    # 3 ft stroke is any short line on the sheet.
    if ink is not None:
        H, W = ink.shape
        known_all = known_pts + [(o["cx"], o["cy"], o["r"]) for o in out]
        # wall ink within ~8.5 pt of an end (12 px at 100 dpi). A hinge is
        # drawn a few px off the wall's inner face (Seer Stone: 5-10 px), so
        # a tight dilation read both ends as bare; a disk sees the wall.
        rad = max(4, int(round(8.5 * px_per_pt)))

        def _ink_at(x, y):
            px, py = int(round(x * px_per_pt)), int(round(y * px_per_pt))
            if not (0 <= px < W and 0 <= py < H):
                return 0
            sub = ink[max(0, py - rad):py + rad + 1, max(0, px - rad):px + rad + 1]
            return int((sub > 0).sum())

        for ch in chains or []:
            P = ch.get("points") or []
            layer = str(ch.get("layer") or "").strip()
            if len(P) != 2 or not layer or not _DOOR_LAYER.search(layer):
                continue
            (x0, y0), (x1, y1) = P[0], P[1]
            L = math.hypot(x1 - x0, y1 - y0)
            if not (r_lo <= L <= r_hi):
                continue
            i0, i1 = _ink_at(x0, y0), _ink_at(x1, y1)
            if max(i0, i1) < 2 * min(i0, i1) + 10:
                continue                     # cannot tell the hinge: abstain
            hx, hy, fx, fy = (x0, y0, x1, y1) if i0 > i1 else (x1, y1, x0, y0)
            if any(math.hypot(hx - kx, hy - ky) <= max(kr, L) / 4.0 for kx, ky, kr in known_all):
                continue
            rec = {"cx": round(hx, 1), "cy": round(hy, 1), "r": round(L, 1),
                   "mx": round(fx, 1), "my": round(fy, 1), "source": "leaf",
                   "chain_id": ch.get("chain_id")}
            out.append(rec)
            known_all.append((hx, hy, L))
    return out


def _fit_circle(pts):
    """Algebraic (Kasa) circle fit: x^2 + y^2 + a x + b y + c = 0."""
    A = np.array([[p[0], p[1], 1.0] for p in pts], dtype=float)
    b = -np.array([p[0] ** 2 + p[1] ** 2 for p in pts], dtype=float)
    try:
        (a, bb, c), *_ = np.linalg.lstsq(A, b, rcond=None)
    except np.linalg.LinAlgError:
        return None
    cx, cy = -a / 2.0, -bb / 2.0
    r2 = cx * cx + cy * cy - c
    if r2 <= 0:
        return None
    return cx, cy, math.sqrt(r2)


def _fit_door(P, L, r_lo, r_hi):
    """One door out of a chain: a circle fitted to the ARC points (hinge =
    centre), the leaf tolerated as a straight run ending at the centre.

    The first cut assumed a quarter arc hinged at a bbox corner; a swing
    drawn past 90 degrees, or a leaf drawn outside the arc's quadrant,
    puts the hinge inside the box's edge and failed it (Seer Stone A2.1:
    chains 720/728/735, bbox 58 x 42 for a 42 pt door). Fitting the circle
    on the points that are NOT on a straight run through the centre - two
    passes: fit all, drop the leaf, refit - takes the hinge from the arc
    itself. Accepts when >= 80% of the points sit on that circle (7%) or
    on the leaf, the arc spans 35-135 degrees, r is a door, and the chain
    is not much longer than arc + leaf (a wall stub can ride along)."""
    fit = _fit_circle(P)
    if fit is None:
        return None
    cx, cy, r = fit
    for _ in range(2):
        arc = [p for p in P if abs(math.hypot(p[0] - cx, p[1] - cy) - r) <= 0.07 * r]
        if len(arc) < 5:
            return None
        fit = _fit_circle(arc)
        if fit is None:
            return None
        cx, cy, r = fit
    if not (r_lo <= r <= r_hi):
        return None
    arc = [p for p in P if abs(math.hypot(p[0] - cx, p[1] - cy) - r) <= 0.07 * r]
    angs = sorted(math.atan2(p[1] - cy, p[0] - cx) for p in arc)
    # angular span, handling the wrap: the largest gap between neighbours
    gaps = [(angs[i + 1] - angs[i]) for i in range(len(angs) - 1)] + [angs[0] + 2 * math.pi - angs[-1]]
    span = 2 * math.pi - max(gaps)
    if not (math.radians(35) <= span <= math.radians(135)):
        return None
    # the arc's two ends, then the leaf = points on either radius to an end
    gi = max(range(len(gaps)), key=lambda i: gaps[i])
    a_end1 = angs[(gi + 1) % len(angs)]
    a_end2 = angs[gi]
    ok = len(arc)
    for p in P:
        d = math.hypot(p[0] - cx, p[1] - cy)
        if abs(d - r) <= 0.07 * r or d > 1.07 * r or d < 1e-6:
            continue
        a = math.atan2(p[1] - cy, p[0] - cx)
        if min(abs((a - a_end1 + math.pi) % (2 * math.pi) - math.pi),
               abs((a - a_end2 + math.pi) % (2 * math.pi) - math.pi)) <= math.radians(4):
            ok += 1
    if ok < 0.8 * len(P):
        return None
    if L > 3.2 * r or L < 0.55 * r * span:
        return None
    a_mid = a_end1 + span / 2.0        # forward from the end after the gap
    return cx, cy, r, cx + r * math.cos(a_mid), cy + r * math.sin(a_mid), a_end1, a_end2


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
    openings = list(result.get("openings") or [])
    # the leaf pass tells a hinge from a free end by wall ink at each end -
    # on a raster WITHOUT the door layer, or the leaf's own stroke makes
    # both ends look like wall and every leaf abstains
    door_layer = [ch for ch in chains if _DOOR_LAYER.search(str(ch.get("layer") or ""))]
    ink_nodoor = ink
    if door_layer:
        keep = [ch for ch in chains if not _DOOR_LAYER.search(str(ch.get("layer") or ""))]
        ink_nodoor = wall_raster(keep, None, w_pt, h_pt, dpi)
    openings += doors_from_chains(chains, _scale(result), known=openings, ink=ink_nodoor, px_per_pt=k)
    bridges = door_bridges(openings, ink, k, wall=wall)
    for b in bridges:
        # A fitted hinge sits a few pt INTO the opening (the arc centre is
        # not the wall's end), so a bridge drawn hinge-to-jamb leaves a
        # sliver between the wall's end and the hinge - Seer Stone A2.1
        # bed 2: a 5 pt passage at the top of its door, and the room ran
        # into the hall through it. Overshoot both ends by 0.15 r (8 pt at
        # most); the overshoot lands on wall either way.
        dx, dy = b["x1"] - b["x0"], b["y1"] - b["y0"]
        L = math.hypot(dx, dy) or 1.0
        ext = min(8.0, 0.15 * b["r"]) / L
        x0, y0 = b["x0"] - dx * ext, b["y0"] - dy * ext
        x1, y1 = b["x1"] + dx * ext, b["y1"] + dy * ext
        cv2.line(wall, (int(round(x0 * k)), int(round(y0 * k))),
                 (int(round(x1 * k)), int(round(y1 * k))), 255,
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


# What a room is CALLED on a plan, and what is written inside a room that
# is not its name. Measured 2026-09-08 on Seer Stone A2.1: the tallest text
# inside a room was the wall note ("2x6 STUDS @ 16\" O.C.", "12'-6\" WALL
# HT.", "INSULATED"), never the label - a label is a room word, short, and
# near the middle of the room.
_ROOM_WORDS = re.compile(
    r"\b(BED(ROOM)?|BATH(ROOM)?|KITCHEN|GARAGE|ROOM|HALL(WAY)?|CLOSET|W\.?I\.?C\.?|PANTRY|FOYER|"
    r"LAUNDRY|MUD(ROOM)?|DINING|LIVING|GREAT|FAMILY|OFFICE|STUDY|DEN|STORAGE|MECH(ANICAL)?|"
    r"SHOP|PORCH|PATIO|ENTRY|NOOK|UTILITY|RESTROOM|TOILET|LINEN|MASTER|PRIMARY|LOBBY|"
    r"CORRIDOR|VESTIBULE|STAIR(S)?|LOFT|BONUS|FLEX|MEDIA|THEATER|GYM|SAUNA|SUITE|POWDER|"
    r"BREAK|CONFERENCE|RECEPTION|LOUNGE|CAFE|CLASSROOM|LAB|JANITOR|ELEC(TRICAL)?|"
    r"DRESSING|SALON|SPA|WORK(SHOP)?|CRAWL|ATTIC|BASEMENT|CELLAR|BAR|WC)\b", re.I)
_NOTE_WORDS = re.compile(
    r"\b(STUDS?|DRYWALL|SLAB|CEILING|INSUL(ATION|ATED)?|CONC(RETE)?|O\.C\.|HT\.?|HEIGHT|SLOPE|"
    r"BELOW|ABOVE|T\.O\.|FDN|COMMON|VAULTED|HIGH|LIFT|FUTURE|HEATER|ELECT|GAS|STUB|WATER|LINE|"
    r"SHUT|OFF|ACCESS|SELF|CLOSING|MIN\.?|OPTIONAL|TYP\.?|SEE|SCHEDULE|R\.O\.|DOOR|WINDOW|"
    r"STEEL|WALL|WALLS|PLATE|BEAM|HEADER|FLUSH|PROVIDED|OUTLET|R\d\d|VERIFY|NOTE|SHEAR)\b", re.I)


def room_name(words: list, poly_px: np.ndarray, k: float) -> Optional[str]:
    """The room's label: of the text lines whose centre is inside the
    polygon, the one that reads like a room name. Scored: room words in,
    note words out, short over long, nearer the room's centre over the
    edge, taller as a last tie-break. Nothing that reads like a note is
    returned - the caller names the room "Room N" instead, which is a
    smaller lie than "INSULATED". `words` are pymupdf 'words' tuples."""
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
        key = (int(wd[5]), int(wd[6])) if len(wd) >= 7 else None
        inside.append((x0, y0, x1, y1, t, key))
    if not inside:
        return None
    m = cv2.moments(poly_px)
    ccx = (m["m10"] / m["m00"]) / k if m["m00"] else 0.0
    ccy = (m["m01"] / m["m00"]) / k if m["m00"] else 0.0
    # group into lines: pymupdf's own (block, line) when present, else by
    # vertical overlap
    lines = {}
    order = []
    for w in inside:
        cy, h = (w[1] + w[3]) / 2, (w[3] - w[1])
        key = w[5]
        if key is None:
            for kk, ln in lines.items():
                if abs(ln["cy"] - cy) <= 0.5 * max(h, ln["h"]):
                    key = kk
                    break
            else:
                key = ("v", len(lines))
        if key not in lines:
            lines[key] = {"cy": cy, "h": h, "words": []}
            order.append(key)
        lines[key]["words"].append(w)
    best = None
    for key in order:
        ln = lines[key]
        ws = sorted(ln["words"], key=lambda w: w[0])
        text = " ".join(w[4] for w in ws)
        if not _ALPHA.search(text):
            continue
        n_room = len(_ROOM_WORDS.findall(text))
        n_note = len(_NOTE_WORDS.findall(text))
        if n_note and not n_room:
            continue
        lx = sum((w[0] + w[2]) / 2 for w in ws) / len(ws)
        ly = sum((w[1] + w[3]) / 2 for w in ws) / len(ws)
        dist = math.hypot(lx - ccx, ly - ccy)
        score = (3.0 * n_room - 4.0 * n_note - 0.05 * max(0, len(text) - 20)
                 - 0.002 * dist + 0.1 * ln["h"] + (0.5 if text.isupper() else 0.0))
        if n_room == 0 and (len(ws) > 3 or not text.isupper()):
            continue
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
