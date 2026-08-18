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
        """Overall unit direction start->end (chord, not arc)."""
        v = self.pts[-1] - self.pts[0]
        n = np.hypot(*v)
        return v / n if n > 1e-9 else np.array([1.0, 0.0])


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
        if "s" not in ptype:
            continue  # fills only; stroke units are what linework is made of
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

    return units
