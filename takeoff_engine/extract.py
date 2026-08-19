"""Vector linework extraction from a PDF page.

Produces StrokeUnits: connected polylines with stroke attributes. A dashed
line exploded by the CAD plot driver arrives as many tiny disconnected
units; a solid polyline arrives as one long unit; a natively-dashed path
arrives as one unit carrying a PDF dash array. All three shapes are
preserved here and disambiguated downstream in chain.py.
"""

from dataclasses import dataclass, field

import numpy as np
import pymupdf

# Two points closer than this (in pt) are considered coincident when
# splitting a path's items into connected polylines.
CONNECT_EPS = 0.05


@dataclass
class StrokeUnit:
    pts: np.ndarray  # (N, 2) float64, page coordinates in pt
    color: tuple  # stroke RGB, 0-1 floats (or None)
    width: float  # stroke width in pt
    dashes: str  # raw PDF dash string, "[] 0" means solid
    closed: bool = False
    layer: str = ""  # CAD layer (OCG) name when the PDF preserves it
    on_fill: bool = False  # near-white stroke sitting on a darker fill
                           # (white-over-wash is VISIBLE; white-on-paper is
                           # whiteout and gets skipped downstream)
    length: float = field(init=False)

    def __post_init__(self):
        d = np.diff(self.pts, axis=0)
        self.length = float(np.hypot(d[:, 0], d[:, 1]).sum())

    @property
    def start(self) -> np.ndarray:
        return self.pts[0]

    @property
    def end(self) -> np.ndarray:
        return self.pts[-1]

    def direction(self) -> np.ndarray:
        """Overall unit direction start->end (chord, not arc). Cached:
        chaining asks ~500k times per heavy sheet. Anything that mutates
        pts (twin midline averaging) must clear _dir."""
        d = getattr(self, "_dir", None)
        if d is None:
            v = self.pts[-1] - self.pts[0]
            n = np.hypot(*v)
            d = v / n if n > 1e-9 else np.array([1.0, 0.0])
            self._dir = d
        return d


def page_words(page) -> list:
    """Text words in the SAME coordinate space as extract_strokes output.

    page.get_text("words") reports UNROTATED page coordinates, while stroke
    geometry is mapped through page.rotation_matrix into display space. On a
    /Rotate 90|180|270 sheet the two therefore disagree, and every
    word-driven rule - legend rows, dash-text bridging, text-box demotion -
    silently matches the wrong part of the page. Verified by rendering: on a
    270 sheet the raw box for "PROPOSED" lands on unrelated linework while
    the mapped box lands exactly on "PROPOSED BUILDING".

    OCR words need no correction - they come from get_pixmap, which is
    already rotation-aware.
    """
    words = page.get_text("words")
    if not page.rotation:
        return words
    rot = page.rotation_matrix
    out = []
    for w in words:
        a = pymupdf.Point(w[0], w[1]) * rot
        b = pymupdf.Point(w[2], w[3]) * rot
        x0, x1 = sorted((a.x, b.x))
        y0, y1 = sorted((a.y, b.y))
        out.append((x0, y0, x1, y1) + tuple(w[4:]))
    return out


def _bezier_points(p0, p1, p2, p3, n=8) -> list:
    t = np.linspace(0, 1, n + 1)[1:]
    pts = []
    for tt in t:
        mt = 1 - tt
        x = mt**3 * p0.x + 3 * mt**2 * tt * p1.x + 3 * mt * tt**2 * p2.x + tt**3 * p3.x
        y = mt**3 * p0.y + 3 * mt**2 * tt * p1.y + 3 * mt * tt**2 * p2.y + tt**3 * p3.y
        pts.append((x, y))
    return pts


def _close(a, b) -> bool:
    return abs(a[0] - b[0]) <= CONNECT_EPS and abs(a[1] - b[1]) <= CONNECT_EPS


def _thin_rect_centerline(pts: np.ndarray) -> np.ndarray | None:
    """If a closed polyline is a thin elongated box (a stroked 'thick line
    segment'), return its 2-point centerline; else None.

    Estimate: longest vertex-pair distance is the length axis; half the
    perimeter minus that is the width. Orientation-independent, so rotated
    pipe segments work.
    """
    if len(pts) > 8:
        return None
    d = np.diff(pts, axis=0)
    perimeter = float(np.hypot(d[:, 0], d[:, 1]).sum())
    diffs = pts[:, None, :] - pts[None, :, :]
    dist = np.hypot(diffs[..., 0], diffs[..., 1])
    k = np.unravel_index(np.argmax(dist), dist.shape)
    diam = float(dist[k])
    if diam < 1e-6:
        return None
    width = max(perimeter / 2 - diam, 0.05)
    # heavy dashed boundaries plot as fat bars up to ~6pt thick
    if width > 7.0 or diam < 3.0 * width:
        return None
    axis = (pts[k[1]] - pts[k[0]]) / diam
    t = (pts - pts[k[0]]) @ axis
    lo, hi = float(t.min()), float(t.max())
    # mean perpendicular offset centers the line inside the box
    mid = (pts - (pts[k[0]] + t[:, None] * axis)).mean(axis=0)
    p0 = pts[k[0]] + lo * axis + mid
    p1 = pts[k[0]] + hi * axis + mid
    return np.vstack([p0, p1])


def _clip_runs(pt_list: list, clip) -> list:
    """Trim a polyline to a clip rect: keep runs of consecutive inside
    points. Border-crossing segments lose their outside tail (error bounded
    by one segment length) - fine for linework, exact intersection can come
    later if measurement at viewport edges ever matters."""
    if clip is None:
        return [pt_list]
    runs = []
    cur = []
    for p in pt_list:
        if clip.x0 <= p[0] <= clip.x1 and clip.y0 <= p[1] <= clip.y1:
            cur.append(p)
        elif cur:
            runs.append(cur)
            cur = []
    if cur:
        runs.append(cur)
    return runs


def _split_loops(pt_list: list) -> list:
    """Split a polyline at points it revisits, separating closed sub-loops
    from open tails.

    CAD arrow/marker glyphs are often plotted as one stroke that draws a
    closed shape (arrowhead, tick box) and continues with a line: the
    resulting unit starts mid-shape and its endpoints lie about anywhere.
    Splitting the loop out leaves a clean open segment whose endpoints are
    the real connection points, and a closed decoration that chaining
    ignores.
    """
    out = []
    pts = pt_list
    guard = 0
    while len(pts) >= 3 and guard < 16:
        guard += 1
        seen = {}
        split = None
        for k, p in enumerate(pts):
            key = (round(p[0], 1), round(p[1], 1))
            if key in seen and k - seen[key] >= 2:
                split = (seen[key], k)
                break
            seen[key] = k
        if split is None:
            break
        j, k = split
        out.append(pts[j : k + 1])  # the closed loop
        pts = pts[: j + 1] + pts[k + 1 :]  # remainder continues through pts[j]
    out.append(pts)
    return out


def extract_strokes(page: pymupdf.Page) -> list[StrokeUnit]:
    """Extract visible stroke units.

    Honors what the renderer honors and get_drawings alone does not:
    - clip regions: CAD sheets are paper-space viewports; xref/model
      content outside the viewport scissor exists in the file but is never
      drawn ("phantom geometry"). Polylines are trimmed to the effective
      clip; fully-outside strokes are dropped.
    - hidden OCG layers: strokes on layers toggled off are skipped.
    - page rotation: get_drawings returns RAW unrotated coordinates (unlike
      get_text and get_pixmap, which are rotation-aware). Clipping happens
      in raw space, then all geometry is mapped through rotation_matrix so
      output matches the rendered page and the text layer.
    """
    units: list[StrokeUnit] = []
    fill_rects: list = []  # raw-space bboxes of non-white fills
    rot = page.rotation_matrix if page.rotation else None
    off_layers = {
        info["name"]
        for info in (page.parent.get_ocgs() or {}).values()
        if not info.get("on", True)
    }

    # margin for numeric slop at viewport borders
    PAD = 0.5
    clip_stack: list[tuple[int, pymupdf.Rect | None]] = []

    for path in page.get_drawings(extended=True):
        ptype = path.get("type") or ""
        level = path.get("level", 0)
        # entries at deeper-or-equal levels have gone out of scope
        while clip_stack and clip_stack[-1][0] >= level:
            clip_stack.pop()
        if ptype == "clip":
            scissor = path.get("scissor")
            rect = None
            if scissor is not None and not pymupdf.Rect(scissor).is_empty:
                # scissor stays in raw space; points are clipped raw too
                rect = pymupdf.Rect(scissor) + (-PAD, -PAD, PAD, PAD)
            clip_stack.append((level, rect))
            continue
        if "f" in ptype:
            fc = path.get("fill")
            # a fill DARKER than near-white creates contrast beneath any
            # white stroke drawn over it (FEMA flood washes etc.)
            if fc and min(fc) <= 0.9 and path.get("rect") is not None:
                fill_rects.append(pymupdf.Rect(path["rect"]))
        if "s" not in ptype:
            continue  # stroke units are what linework is made of
        if path.get("layer") in off_layers:
            continue
        clip = None
        for _, r in clip_stack:
            if r is not None:
                clip = r if clip is None else clip & r
        color = path.get("color")
        width = path.get("width") or 0.0
        dashes = path.get("dashes") or "[] 0"
        layer = path.get("layer") or ""

        current: list = []  # growing polyline point list

        def emit(pt_list):
            for part in _split_loops(pt_list):
                for run in _clip_runs(part, clip):
                    if len(run) >= 2:
                        pts = np.asarray(run, dtype=np.float64)
                        closed = _close(run[0], run[-1]) and len(run) > 2
                        if closed:
                            # thick line segments are often plotted as thin
                            # closed rectangles (pipe runs, wide dashes);
                            # collapse those to their centerline so they can
                            # chain like any other dash
                            cl = _thin_rect_centerline(pts)
                            if cl is not None:
                                pts, closed = cl, False
                        if rot is not None:
                            pts = np.column_stack([
                                rot.a * pts[:, 0] + rot.c * pts[:, 1] + rot.e,
                                rot.b * pts[:, 0] + rot.d * pts[:, 1] + rot.f,
                            ])
                        units.append(
                            StrokeUnit(pts=pts, color=color, width=width,
                                       dashes=dashes, closed=closed, layer=layer)
                        )

        def flush():
            nonlocal current
            if len(current) >= 2:
                emit(current)
            current = []

        for item in path["items"]:
            op = item[0]
            if op == "l":
                p1, p2 = item[1], item[2]
                seg = [(p1.x, p1.y), (p2.x, p2.y)]
            elif op == "c":
                p1, p2, p3, p4 = item[1], item[2], item[3], item[4]
                seg = [(p1.x, p1.y)] + _bezier_points(p1, p2, p3, p4)
            elif op == "re":
                r = item[1]
                seg = [
                    (r.x0, r.y0),
                    (r.x1, r.y0),
                    (r.x1, r.y1),
                    (r.x0, r.y1),
                    (r.x0, r.y0),
                ]
            elif op == "qu":
                q = item[1]
                seg = [
                    (q.ul.x, q.ul.y),
                    (q.ur.x, q.ur.y),
                    (q.lr.x, q.lr.y),
                    (q.ll.x, q.ll.y),
                    (q.ul.x, q.ul.y),
                ]
            else:
                continue

            if current and _close(current[-1], seg[0]):
                current.extend(seg[1:])
            else:
                flush()
                current = seg
        flush()

    # Near-white strokes over a darker fill are VISIBLE linework (Oncor p4
    # draws its floodplain contours white over the FEMA wash - 26k pt of
    # real line). Mark them so the downstream whiteout skip spares them;
    # white on bare paper stays skipped. Fill rects are raw-space, so map
    # them into display space the same way stroke geometry was.
    # only OPEN strokes qualify: closed white shapes over a fill are label
    # knockout frames (they masked text on the wash), and emitting them
    # produced spiky phantom rectangles in the takeoff. The floodplain
    # contours this exists for are open dash marks.
    whites = [u for u in units
              if u.color and min(u.color) > 0.92 and not u.closed]
    if whites and fill_rects:
        rects = []
        for r in fill_rects:
            if rot is not None:
                r = pymupdf.Rect(r) * rot
            r = pymupdf.Rect(r)
            r.normalize()
            rects.append((r.x0 - 1, r.y0 - 1, r.x1 + 1, r.y1 + 1))
        R = np.asarray(rects)
        for u in whites:
            m = u.pts[len(u.pts) // 2]
            hit = ((R[:, 0] <= m[0]) & (m[0] <= R[:, 2]) &
                   (R[:, 1] <= m[1]) & (m[1] <= R[:, 3]))
            if bool(hit.any()):
                u.on_fill = True

    return units


def fill_boxes(page: pymupdf.Page) -> list:
    """Rotation-mapped bboxes of non-white fills, page coords.

    Walls/objects on architectural plans are drawn as FILLED bands; leaders
    and dimension strings are bare strokes. That contrast lets the reviewer
    UI tell a wall face from an annotation drawn with the same pen."""
    rot = page.rotation_matrix if page.rotation else None
    out = []
    for path in page.get_drawings():
        if "f" not in (path.get("type") or ""):
            continue
        col = path.get("fill")
        if col and min(col) > 0.92:
            continue  # white fill = knockout, not a band
        r = path.get("rect")
        if r is None:
            continue
        if rot is not None:
            r = pymupdf.Rect(r) * rot
        r = pymupdf.Rect(r)
        r.normalize()
        if r.width < 1 and r.height < 1:
            continue
        out.append([round(r.x0, 1), round(r.y0, 1),
                    round(r.x1, 1), round(r.y1, 1)])
    return out


def door_swings(units: list, scale_ft_per_in: float | None = None,
                words: list | None = None) -> list:
    """Door-swing opening symbols: swing arcs corroborated by structure.

    A drafted door is a compass construction - a straight LEAF line from
    the hinge plus an arc swept about that same hinge - so a bare arc is
    never reported on its own. Every arc candidate must be corroborated by
    its leaf line, or by a mirrored partner arc (a double door). That
    corroboration is what keeps civil sheets clean: at 1"=30'-60' the
    scaled door-radius window shrinks to a few pt and contour bends /
    symbol fillets pass every per-arc gate. Measured 2026-08-19 (function
    output, after dedupe): Oncor Cloudcrest p4 went 72 phantom openings ->
    1 (a title-block logo glyph); Belle Farms ROAD GRADING 1of2 p1 went
    103 -> 0; Belle Structural p1 went 6 -> 23, all 23 eyeballed real
    (crops in out/verify/2026-08-19/double-doors/).

    Arc candidate: >=5 vertices (Belle Structural p1 flattens 45-degree
    door arcs to 6-pt polylines, 90-degree ones to 9-11 pt), open, points
    equidistant from a fitted center, sweep 35-135 degrees, radius in door
    range (1.25-6 ft when the scale is known; 8-80 pt otherwise).

    Corroboration, either of:
    - LEAF: a straight unit of length ~r joining the fitted center (the
      hinge) to an arc endpoint - the drawn door leaf. Belle Structural p1
      draws each leaf as two parallel strokes, both exactly length r.
    - PAIR: a partner arc with matching radius whose center sits ~r1+r2
      away, both arcs having an endpoint at the shared meeting point (the
      closed leaves touch mid-opening) and bulging to the same side of the
      hinge-hinge line. Measured on Belle Structural p1: three grand-hall
      double doors, each two 45-degree arcs r=27pt with center distance
      54.1pt = (r1+r2) within 0.1% and endpoint-to-meeting-point gap
      0.0-0.1pt; the 90-degree main-entry pair (r=36pt) matches the same
      template. The tight meeting-point gate is load-bearing: adjacent
      section-callout bubbles on the same sheet (r=13.5/14.4pt) sit at
      center distance 1.05x(r1+r2) but their arc endpoints miss the
      meeting point by 14-27pt.

    Returns [{cx, cy, r}] opening zones the takeoff must not measure
    through."""
    if scale_ft_per_in:
        # 1.25 ft radius floor (was 1.5): Belle Structural p1 restroom /
        # office doors are r=24pt = 1.33 ft at the sheet's detected
        # 1/4"=1'-0" scale (its title block also carries a 1/8" candidate,
        # so the detected scale can sit 2x off on mixed-scale sheets) -
        # the 1.5 ft floor missed 7 real doors there.
        r_lo = (1.25 / scale_ft_per_in) * 72
        r_hi = (6.0 / scale_ft_per_in) * 72
    else:
        r_lo, r_hi = 8.0, 80.0
    # absolute paper-space floor: smallest real door measured across the
    # corpus is r=10.8pt (C3.0/C4.0/C9.0 building doors at 1"=20');
    # phantom classes below it: leader-arrowhead curls r=3.2-3.4pt
    # (Oncor p4, admitted when the 25-35deg fragment window landed at
    # civil scales), logo glyph bowls r=2.1-2.4pt. 8.0 splits the
    # populations with margin both ways.
    r_lo = max(r_lo, 8.0)

    # pass 1 - arc candidates
    cands = []  # (cx, cy, r, end0, end1, arc midpoint, sweep)
    da_cands = []  # double-acting 180deg candidates
    for u in units:
        # arc length = r x sweep: with r in [r_lo, r_hi] and sweep in
        # [35deg, 135deg] a door arc's length must sit in
        # [0.611 r_lo, 2.356 r_hi] - widened to 0.55/2.5 for flattening
        # slop. Only skips units the r/sweep gates would reject anyway,
        # and spares the circle fit on every long contour polyline
        # (Oncor p4: 5302 -> 1924 fits).
        if not (0.55 * r_lo <= u.length <= 2.5 * r_hi):
            continue
        p = np.asarray(u.pts, dtype=float)
        # 4-point floor: a 30deg fragment flattens to 4 vertices at the
        # drafting tool's ~9deg/vertex (Belle p1 measured); the circle
        # fit needs 3, and the fit-std gate below rejects degenerates
        if len(p) < 4 or u.closed:
            continue
        chord = float(np.hypot(*(p[-1] - p[0])))
        # arc/chord: 90deg sweep = 1.111, 55deg = 1.039, 45deg = 1.026,
        # 35deg = 1.016. The floor sits below the shallowest drawn leaf
        # (Belle Structural p1 half-open doors sweep 45deg; measured
        # arc/chord 1.0255 after polyline flattening) - corroboration, not
        # this floor, now does the discriminating.
        # 35deg = 1.016, 30deg = 1.0115, 25deg = 1.0080; polyline
        # flattening noise on straight runs measures <= 1.005. The gate
        # sits between so 25-35deg FRAGMENTS reach the candidate pool
        # (their leaf + template-radius gates do the discriminating).
        if chord < 1e-6 or u.length < 1.0075 * chord:
            continue  # straight-ish, not an arc
        # fit center: perpendicular bisector intersection via least squares
        # (algebraic circle fit)
        A = np.column_stack([2 * p[:, 0], 2 * p[:, 1], np.ones(len(p))])
        b = (p ** 2).sum(axis=1)
        try:
            sol, *_ = np.linalg.lstsq(A, b, rcond=None)
        except np.linalg.LinAlgError:
            continue
        cx, cy = float(sol[0]), float(sol[1])
        rr = np.hypot(p[:, 0] - cx, p[:, 1] - cy)
        r = float(rr.mean())
        if r < r_lo or r > r_hi:
            continue
        if float(rr.std()) > max(0.06 * r, 0.8):
            continue  # not circular enough
        va = p[0] - (cx, cy)
        vb = p[-1] - (cx, cy)
        sweep = float(np.degrees(np.arccos(np.clip(
            (va @ vb) / (np.hypot(*va) * np.hypot(*vb) + 1e-9), -1, 1))))
        # 35deg is the confident floor (half-open doors draw at 45deg);
        # 25-35deg admits FRAGMENTS - arcs a crossing line split (Belle
        # Structural p1: two doors survive only as 30.0deg r=27 pieces,
        # perfect circle fits) - but those must corroborate via their
        # LEAF specifically (pair logic assumes whole leaves). 165-195deg
        # is a DOUBLE-ACTING door (glass connector: two 180deg r=36
        # semicircles, no leaf drawn) gated separately below; the 135 cap
        # still excludes callout-bubble halves from the swing path.
        if 165.0 <= sweep <= 195.0:
            da_cands.append((cx, cy, r, p[0], p[-1]))
            continue
        if not (25.0 <= sweep <= 135.0):
            continue
        cands.append((cx, cy, r, p[0], p[-1], p[len(p) // 2], sweep))

    if not cands:
        return []

    # pass 2 - straight-unit endpoints, the leaf-line pool (length
    # pre-filtered to the door-leaf range to bound the search)
    rows = []
    for u in units:
        p = u.pts
        chord = float(np.hypot(*(p[-1] - p[0])))
        if chord < 1e-6 or u.length > 1.02 * chord:
            continue  # not straight enough to be a drawn leaf
        if not (0.8 * r_lo <= u.length <= 1.2 * r_hi):
            continue
        rows.append((p[0][0], p[0][1], p[-1][0], p[-1][1], u.length))
    E = np.asarray(rows) if rows else np.zeros((0, 5))

    def leaf_ok(cx, cy, r, ends):
        # length window 0.8-1.2r and summed endpoint tolerance
        # max(1.5, 0.15r): measured leaves on Belle Structural p1 are
        # length 0.95-1.00r with endpoint mismatch 0.03-2.98pt at
        # r=24-27pt (the leaf is two parallel strokes ~2pt apart and the
        # far stroke must still match).
        if not len(E):
            return False
        lok = (E[:, 4] >= 0.8 * r) & (E[:, 4] <= 1.2 * r)
        if not bool(lok.any()):
            return False
        tol = max(1.5, 0.15 * r)
        for ex, ey in ends:
            da = (np.hypot(E[:, 0] - cx, E[:, 1] - cy)
                  + np.hypot(E[:, 2] - ex, E[:, 3] - ey))
            db = (np.hypot(E[:, 2] - cx, E[:, 3] - cy)
                  + np.hypot(E[:, 0] - ex, E[:, 1] - ey))
            if bool((lok & (np.minimum(da, db) < tol)).any()):
                return True
        return False

    def pair_ok(i):
        cxi, cyi, ri, a0, a1, mi, _swi = cands[i]
        for j, (cxj, cyj, rj, b0, b1, mj, _swj) in enumerate(cands):
            if j == i:
                continue
            # leaf radii match within 15% (leaf-and-a-half doors are
            # unequal; the measured pairs are exactly equal)
            if abs(ri - rj) > 0.15 * max(ri, rj):
                continue
            d = float(np.hypot(cxj - cxi, cyj - cyi))
            rsum = ri + rj
            # hinges sit one opening apart: measured 1.000x(r1+r2) on all
            # four Belle Structural p1 pairs; 8% slop for astragal gaps
            if not (0.92 * rsum <= d <= 1.08 * rsum) or d < 1e-6:
                continue
            # meeting point: where the closed leaves touch, ri along the
            # hinge-hinge line. Both arcs must END there - measured gap
            # 0.0-0.1pt on real pairs, 14-27pt on the callout-bubble trap.
            mx = cxi + (ri / d) * (cxj - cxi)
            my = cyi + (ri / d) * (cyj - cyi)
            tol = max(1.5, 0.05 * max(ri, rj))
            if min(np.hypot(a0[0] - mx, a0[1] - my),
                   np.hypot(a1[0] - mx, a1[1] - my)) > tol:
                continue
            if min(np.hypot(b0[0] - mx, b0[1] - my),
                   np.hypot(b1[0] - mx, b1[1] - my)) > tol:
                continue
            # both leaves open into the same room: arc midpoints on the
            # same side of the hinge-hinge line (measured: sides agree on
            # every real pair; a fillet facing a fillet does not)
            ux, uy = cxj - cxi, cyj - cyi
            si = ux * (mi[1] - cyi) - uy * (mi[0] - cxi)
            sj = ux * (mj[1] - cyi) - uy * (mj[0] - cxi)
            if si == 0.0 or sj == 0.0 or (si > 0) != (sj > 0):
                continue
            return True
        return False

    out = []
    confirmed_r = []
    for i, (cx, cy, r, e0, e1, _mid, sweep) in enumerate(cands):
        if sweep < 35.0:
            continue   # fragments resolved in a second pass below
        if leaf_ok(cx, cy, r, (e0, e1)) or pair_ok(i):
            out.append({"cx": round(cx, 1), "cy": round(cy, 1),
                        "r": round(r, 1)})
            confirmed_r.append(r)
    # FRAGMENT pass: a 25-35deg arc is admitted only when (a) its leaf
    # corroborates AND (b) its radius matches a CONFIRMED full door on
    # this page within 15% - the drafting template repeats, so real
    # split doors share r with their whole siblings (Belle p1: r=27.0
    # fragments vs confirmed r=27 doors). Radius-dimension callouts on
    # civil sheets have leaf-like leaders but no confirmed-door radius
    # to match (Oncor p4 grew +10 phantoms without this gate).
    for i, (cx, cy, r, e0, e1, _mid, sweep) in enumerate(cands):
        if sweep >= 35.0:
            continue
        if not any(abs(r - cr) <= 0.15 * max(r, cr) for cr in confirmed_r):
            continue
        if leaf_ok(cx, cy, r, (e0, e1)):
            out.append({"cx": round(cx, 1), "cy": round(cy, 1),
                        "r": round(r, 1)})

    # double-acting doors: 180deg swing, no leaf drawn. Guards, each
    # measured on Belle Structural p1 vs its own callout bubbles:
    #  - no text inside the circle (bubbles carry sheet numbers; the two
    #    real glass-connector doors are empty)
    #  - both arc endpoints sit ON straight linework (the wall/track line
    #    the door hangs from), within 3pt
    if da_cands:
        strt = []
        for u in units:
            pu = u.pts
            ch2 = float(np.hypot(*(pu[-1] - pu[0])))
            if ch2 > 1e-6 and u.length <= 1.02 * ch2 and u.length >= 6.0:
                strt.append((pu[0][0], pu[0][1], pu[-1][0], pu[-1][1]))
        S = np.asarray(strt) if strt else np.zeros((0, 4))

        def on_straight(x, y, tol=3.0):
            if not len(S):
                return False
            dx = S[:, 2] - S[:, 0]
            dy = S[:, 3] - S[:, 1]
            L2 = dx * dx + dy * dy
            t = ((x - S[:, 0]) * dx + (y - S[:, 1]) * dy) / np.maximum(L2, 1e-9)
            t = np.clip(t, 0.0, 1.0)
            qx = S[:, 0] + t * dx
            qy = S[:, 1] + t * dy
            return bool((np.hypot(x - qx, y - qy) <= tol).any())

        def center_crossed(cx, cy, r, chord_dir, ex0, ey0):
            # equipment symbols (substation breakers on bus lines) are
            # circles with straight feeds THROUGH the middle in non-chord
            # directions; a door's only center-adjacent line is the track
            # it hangs on, collinear with its chord. Measured on Oncor
            # p4: every phantom had a >20deg crossing; the two real glass
            # doors have none.
            if not len(S):
                return False
            dx = S[:, 2] - S[:, 0]
            dy = S[:, 3] - S[:, 1]
            L2 = dx * dx + dy * dy
            t = ((cx - S[:, 0]) * dx + (cy - S[:, 1]) * dy) / np.maximum(L2, 1e-9)
            t = np.clip(t, 0.0, 1.0)
            qx = S[:, 0] + t * dx
            qy = S[:, 1] + t * dy
            near = np.hypot(cx - qx, cy - qy) <= 0.35 * r
            # only strokes long enough to be a feed/bus count as crossings:
            # dashed zone-line MARKS (~11pt) also cross door centers
            # (Belle glass door #2) but a symbol's feed line runs >= r
            L = np.sqrt(np.maximum(L2, 1e-9))
            near &= L >= r
            if not bool(near.any()):
                return False
            cosang = np.abs(dx * chord_dir[0] + dy * chord_dir[1]) / L
            # a crossing goes THROUGH the opening - endpoints on opposite
            # sides of the chord line. Walls that TERMINATE at the door
            # track (measured 5.9pt shy on Belle glass #2) stay one-sided
            # and are jambs, not feeds.
            nx, ny = -chord_dir[1], chord_dir[0]
            s0 = (S[:, 0] - ex0) * nx + (S[:, 1] - ey0) * ny
            s1 = (S[:, 2] - ex0) * nx + (S[:, 3] - ey0) * ny
            through = (s0 * s1) < -1.0
            return bool((near & through & (cosang < 0.94)).any())

        for cx, cy, r, e0, e1 in da_cands:
            if words:
                inside = False
                for w in words:
                    wx, wy = (w[0] + w[2]) / 2, (w[1] + w[3]) / 2
                    if np.hypot(wx - cx, wy - cy) < r * 0.95:
                        inside = True
                        break
                if inside:
                    continue
            ch = np.asarray(e1, dtype=float) - np.asarray(e0, dtype=float)
            n = float(np.hypot(*ch)) or 1.0
            if center_crossed(cx, cy, r, ch / n, float(e0[0]), float(e0[1])):
                continue
            if on_straight(*e0) and on_straight(*e1):
                out.append({"cx": round(float(cx), 1),
                            "cy": round(float(cy), 1),
                            "r": round(float(r), 1)})
    # dedupe coincident arcs (double-drawn swings)
    ded = []
    for o in out:
        if any(abs(o["cx"] - d["cx"]) < 4 and abs(o["cy"] - d["cy"]) < 4
               and abs(o["r"] - d["r"]) < 4 for d in ded):
            continue
        ded.append(o)
    return ded
