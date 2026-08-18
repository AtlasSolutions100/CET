"""Raster pipeline: page image -> StrokeUnits.

The whole point of this module is to end at the SAME representation the
vector path produces (StrokeUnit polylines with color/width), so chaining,
cadence classification, style discovery, junk pruning, and eval all run
unchanged on scanned or flattened pages.

Shape of the pipeline (same as the client's Blueprint Workbench prototype,
which validated it interactively):
  render page -> ink mask -> Zhang-Suen thinning to a 1px skeleton ->
  split skeleton at junctions -> trace arms into polylines -> measure
  width (distance transform) and color (source pixels) per polyline.

Dashes arrive as many small polylines; solid lines crossing others arrive
as arms meeting at a junction point - the chainer's touching-endpoint links
reassemble them, with a small direction tiebreak so straight continuations
pair up at crossings.
"""

import cv2
import numpy as np
import pymupdf

from .extract import StrokeUnit

# Below this luminance a pixel is ink on a white-background plan.
INK_LEVEL = 185
# Raster measurements are noisy; quantize width/color so style grouping
# doesn't fragment. Width buckets in pt; color channels to this many levels.
WIDTH_BUCKET = 1.6
COLOR_LEVELS = 4


def extract_raster_units(page: pymupdf.Page, dpi: int = 200,
                         words_out: list | None = None) -> list[StrokeUnit]:
    """Full raster page -> StrokeUnits (+ words appended to words_out).

    Runs deskew, glyph masking, and OCR around the core tracer, so the
    units the chainer sees are deskewed clean linework, and words_out gets
    real OCR strings plus pseudo-boxes for rows OCR missed.
    """
    scale = dpi / 72.0
    pix = page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), colorspace="rgb")
    img = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, 3)

    img, undo = _deskew(img)
    units = units_from_image(img, px_to_pt=72.0 / dpi, undo_px=undo,
                             words_out=words_out, dpi=dpi)
    return units


def _deskew(img: np.ndarray, max_deg: float = 6.0):
    """Estimate scan skew from long linework segments; rotate to square if
    beyond 0.2 degrees. Returns (image, undo) where undo is the affine
    matrix mapping deskewed px back to original px - traced geometry goes
    through it so output still registers with the original page render."""
    small = cv2.resize(img, None, fx=0.25, fy=0.25, interpolation=cv2.INTER_AREA)
    gray = cv2.cvtColor(small, cv2.COLOR_RGB2GRAY)
    edges = (gray < INK_LEVEL).astype(np.uint8) * 255
    lines = cv2.HoughLinesP(edges, 1, np.pi / 720, threshold=80,
                            minLineLength=120, maxLineGap=4)
    if lines is None or len(lines) < 8:
        return img, None
    devs = []
    for x1, y1, x2, y2 in lines[:, 0]:
        ang = np.degrees(np.arctan2(y2 - y1, x2 - x1))
        dev = (ang + 45) % 90 - 45  # deviation from nearest axis
        if abs(dev) <= max_deg:
            devs.append(dev)
    if len(devs) < 8:
        return img, None
    skew = float(np.median(devs))
    if abs(skew) < 0.2:
        return img, None
    h, w = img.shape[:2]
    center = (w / 2, h / 2)
    M = cv2.getRotationMatrix2D(center, skew, 1.0)
    fixed = cv2.warpAffine(img, M, (w, h), flags=cv2.INTER_LINEAR,
                           borderValue=(255, 255, 255))
    undo = cv2.invertAffineTransform(M)
    return fixed, undo


def extract_hybrid_image_units(page: pymupdf.Page) -> list[StrokeUnit]:
    """Raster-trace the embedded images of a hybrid page, in place.

    Runs only on the image XObjects (the vector strokes are extracted by the
    vector path - re-tracing a full-page render would double-count them).
    Photo underlays (aerials, site photos) are detected by their tonal
    profile and skipped: linework images are bimodal white-paper/dark-ink.
    """
    units: list[StrokeUnit] = []
    doc = page.parent
    seen = set()
    for info in page.get_image_info(xrefs=True):
        xref = info.get("xref", 0)
        if not xref or xref in seen:
            continue
        seen.add(xref)
        bbox = pymupdf.Rect(info["bbox"]) & page.rect
        if bbox.is_empty or bbox.width < 20 or bbox.height < 20:
            continue  # logos, stamps
        try:
            raw = doc.extract_image(xref)
            arr = np.frombuffer(raw["image"], dtype=np.uint8)
            img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        except Exception:
            continue
        if img is None or img.shape[0] < 40 or img.shape[1] < 40:
            continue
        img = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
        # cap resolution: enormous scans gain nothing above ~250dpi
        max_px = int(max(bbox.width, bbox.height) / 72.0 * 250)
        if max(img.shape[:2]) > max_px > 0:
            f = max_px / max(img.shape[:2])
            img = cv2.resize(img, None, fx=f, fy=f, interpolation=cv2.INTER_AREA)

        gray = cv2.cvtColor(img, cv2.COLOR_RGB2GRAY)
        ink_frac = float((gray < INK_LEVEL).mean())
        mid_frac = float(((gray >= 100) & (gray <= 220)).mean())
        if ink_frac > 0.30 or mid_frac > 0.40:
            continue  # photo-like content, not linework

        h, w = gray.shape
        sx, sy = bbox.width / w, bbox.height / h
        for u in units_from_image(img, px_to_pt=(sx + sy) / 2.0,
                                  transform=(bbox.x0, bbox.y0, sx, sy)):
            units.append(u)
    return units


def units_from_image(img: np.ndarray, px_to_pt: float,
                     transform: tuple | None = None,
                     undo_px: np.ndarray | None = None,
                     words_out: list | None = None,
                     dpi: int = 200) -> list[StrokeUnit]:
    from .text_detect import detect_glyphs, merge_words, ocr_words

    gray = cv2.cvtColor(img, cv2.COLOR_RGB2GRAY)
    # colored linework can be light in luminance but saturated; take a pixel
    # as ink when EITHER the luminance or the darkest channel says so
    ink = (gray < INK_LEVEL) | (img.min(axis=2) < INK_LEVEL - 20)

    # strip text glyphs before thinning: annotation text otherwise traces
    # into scribble chains and breaks lines it collides with
    glyph_mask, row_boxes = detect_glyphs(ink, dpi_scale=dpi / 200.0)
    ink = ink & (glyph_mask == 0)

    if words_out is not None:
        pseudo = [(x0 * px_to_pt, y0 * px_to_pt, x1 * px_to_pt, y1 * px_to_pt)
                  for x0, y0, x1, y1 in row_boxes]
        try:
            ocr = ocr_words(img, px_to_pt)
        except Exception:
            ocr = []
        merged = merge_words(ocr, pseudo)
        if undo_px is not None:
            # words were found in the deskewed frame; map their boxes back
            # to the original frame like the geometry
            fixed = []
            for x0, y0, x1, y1, *rest in merged:
                cs = np.array([[x0, y0], [x1, y1]]) / px_to_pt
                cs = np.column_stack([
                    undo_px[0, 0] * cs[:, 0] + undo_px[0, 1] * cs[:, 1] + undo_px[0, 2],
                    undo_px[1, 0] * cs[:, 0] + undo_px[1, 1] * cs[:, 1] + undo_px[1, 2],
                ]) * px_to_pt
                fixed.append((float(cs[:, 0].min()), float(cs[:, 1].min()),
                              float(cs[:, 0].max()), float(cs[:, 1].max()),
                              *(rest or ["?"])))
            merged = fixed
        words_out.extend(merged)

    mask = ink.astype(np.uint8) * 255

    skel = cv2.ximgproc.thinning(mask)
    dist = cv2.distanceTransform(mask, cv2.DIST_L2, 3)

    paths = _trace_skeleton(skel > 0)

    units: list[StrokeUnit] = []
    h, w = gray.shape
    for path in paths:
        pts_px = np.asarray(path, dtype=np.float32)
        if len(pts_px) >= 3:
            approx = cv2.approxPolyDP(pts_px.reshape(-1, 1, 2), 0.9, False)
            pts_px = approx.reshape(-1, 2).astype(np.float32)
        if len(pts_px) < 2:
            # isolated dot: synthesize a tiny segment so it can chain
            p = pts_px[0]
            pts_px = np.array([p, p + 0.5], dtype=np.float32)

        # sample width and color along the ORIGINAL (unsimplified) trace
        samp = np.asarray(path[:: max(1, len(path) // 12)], dtype=int)
        ys = samp[:, 1].clip(0, h - 1)
        xs = samp[:, 0].clip(0, w - 1)
        width_px = float(np.median(dist[ys, xs]) * 2.0)
        rgb = img[ys, xs].astype(np.float64) / 255.0
        # sample colors can straddle white gaps/antialiasing; take the
        # darkest half as the line's color
        lum = rgb.mean(axis=1)
        dark = rgb[lum <= np.median(lum)]
        color = dark.mean(axis=0) if len(dark) else rgb.mean(axis=0)
        q = COLOR_LEVELS - 1
        color = tuple(round(float(c) * q) / q for c in color)

        width_pt = max(round(width_px * px_to_pt / WIDTH_BUCKET) * WIDTH_BUCKET,
                       WIDTH_BUCKET)
        pts_px = pts_px.astype(np.float64)
        if undo_px is not None:
            # back from the deskewed frame to the original page render
            pts_px = np.column_stack([
                undo_px[0, 0] * pts_px[:, 0] + undo_px[0, 1] * pts_px[:, 1] + undo_px[0, 2],
                undo_px[1, 0] * pts_px[:, 0] + undo_px[1, 1] * pts_px[:, 1] + undo_px[1, 2],
            ])
        if transform is not None:
            ox, oy, sx, sy = transform
            pts = np.column_stack([
                ox + pts_px[:, 0] * sx,
                oy + pts_px[:, 1] * sy,
            ])
        else:
            pts = pts_px * px_to_pt
        units.append(
            StrokeUnit(pts=pts, color=color, width=width_pt, dashes="[] 0",
                       closed=False, layer="")
        )
    return units


def _trace_skeleton(S: np.ndarray) -> list:
    """Split a 1px skeleton at junctions and trace each arm into an ordered
    pixel path [(x, y), ...]. Arms are terminated with their junction
    cluster's centroid so arms that meet at a crossing share a touching
    endpoint the chainer can join."""
    S8 = S.astype(np.uint8)
    deg = cv2.filter2D(S8, -1, np.ones((3, 3), np.uint8), borderType=cv2.BORDER_CONSTANT) - S8
    junction = S & (deg >= 3)
    path_px = S & ~junction

    # junction clusters -> centroid per cluster, lookup by pixel
    n_lbl, lbl = cv2.connectedComponents(junction.astype(np.uint8), connectivity=8)
    cent = np.zeros((n_lbl, 2))
    if n_lbl > 1:
        ys, xs = np.nonzero(junction)
        for label, x, y in zip(lbl[ys, xs], xs, ys):
            cent[label][0] += x
            cent[label][1] += y
        counts = np.bincount(lbl[ys, xs], minlength=n_lbl).clip(1)
        cent[:, 0] /= counts
        cent[:, 1] /= counts

    H, W = S.shape
    NB = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]

    pdeg = cv2.filter2D(path_px.astype(np.uint8), -1, np.ones((3, 3), np.uint8),
                        borderType=cv2.BORDER_CONSTANT) - path_px.astype(np.uint8)
    visited = np.zeros_like(S, dtype=bool)
    paths = []

    def junction_touch(y, x):
        """Centroid of a junction cluster adjacent to (y, x), if any."""
        for dy, dx in NB:
            yy, xx = y + dy, x + dx
            if 0 <= yy < H and 0 <= xx < W and junction[yy, xx]:
                c = cent[lbl[yy, xx]]
                return (float(c[0]), float(c[1]))
        return None

    def walk(y, x):
        path = []
        start_j = junction_touch(y, x)
        if start_j:
            path.append(start_j)
        while True:
            visited[y, x] = True
            path.append((float(x), float(y)))
            nxt = None
            for dy, dx in NB:
                yy, xx = y + dy, x + dx
                if 0 <= yy < H and 0 <= xx < W and path_px[yy, xx] and not visited[yy, xx]:
                    nxt = (yy, xx)
                    break
            if nxt is None:
                end_j = junction_touch(y, x)
                if end_j:
                    path.append(end_j)
                return path
            y, x = nxt

    # arm tips first (degree<=1 within path pixels), then leftover cycles
    ys, xs = np.nonzero(path_px & (pdeg <= 1))
    for y, x in zip(ys, xs):
        if not visited[y, x]:
            paths.append(walk(y, x))
    ys, xs = np.nonzero(path_px)
    for y, x in zip(ys, xs):
        if not visited[y, x]:
            paths.append(walk(y, x))
    return paths
