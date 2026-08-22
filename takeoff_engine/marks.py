"""Mark-bubble counting on SCANNED architectural plans.

A "mark bubble" (also "tag") is the little outlined shape a drafter puts
next to an opening with a short code inside it.  On the sheet this module
was built against - Kevin Tsai Architecture, Aqua Vista Apartments - the
sheet's OWN "SYMBOL LEGEND" block spells the convention out, so none of it
is an industry guess:

    hexagon with W#      WINDOW TAG        <- the window estimator's unit
    hexagon with SF#     STOREFRONT TAG
    stadium with D###    DOOR TAG (rating below)
    diamond with L##     WALL TAG          (partition type - not an opening)
    circle with #/A###   detail/section callout (a cross-reference)

That legend is the ground for every shape assumption below.  Note two
consequences that a generic "circle = door, hexagon = window" rule gets
wrong here: the door tag is a STADIUM (rounded rectangle), not a circle,
and the storefront tag is the SAME hexagon as the window tag - only the
code inside separates them.  So the SHAPE finds candidates and the CODE
decides what each candidate is.

Why not the vector path (server.symbols_suggest)?  These PDFs are 300-dpi
print-and-scan images: no text layer, no vectors, nothing to group.  This
module works on the page raster instead.

Pipeline
--------
    render 300 dpi -> orient (a landscape sheet scanned onto a portrait
    page) -> deskew -> seed a tag template off the sheet itself -> match it
    in GRAYSCALE across the page -> gate on ring contrast -> isolate each
    bubble's interior -> group identical codes -> read one averaged image
    per group -> map back to page points for the UI.

Every constant below was measured on "Marked Up Window Plans - Aqua Vista"
page 1 at 300 dpi; the evidence is in out/verify/2026-08-21/bill-marks/.

  * The tag is 31 x 35 px (0.10 x 0.12 in on paper), ~2 px stroke, ~12 px
    cap-height text inside.
  * INK_LEVEL: the outline only survives a narrow threshold band.  At
    V<170 it breaks into arcs; at V<235 it fattens into the wall beside it.
    210 sits mid-band.  This mask is used to FIND seeds, not to match.
  * MATCH_MIN: with grayscale matching the real hexagons on page 1 score
    0.70-1.00 and the nearest confusable class - the diamond WALL tags -
    tops out around 0.60.  Swept 0.58 / 0.62 / 0.65 over all five floor
    plans: 0.62 and 0.65 give identical mark counts, and 0.58 buys one
    extra W1L on page 3 at the cost of 19 extra wall tags on page 1.  0.62
    it is - low enough to take the faint tags the band gate now protects,
    high enough to leave the diamonds out.

Two things this design buys, both measured rather than assumed:

  * Highlighter immunity.  The client marks his prints with cyan/pink/
    orange highlighter.  Everything reads the HSV *value* channel (max of
    R,G,B), where saturated highlighter is still "white".  On page 1, 0.60%
    of the sheet is highlighter and only 0.015% is both highlighter-coloured
    and below the ink threshold.
  * Faint-print tolerance.  Matching in grayscale rather than on the binary
    mask is contrast-normalised, so a lightly-printed tag still correlates:
    the two palest tags on page 1 score 0.46/0.47 binary but 0.77/0.81
    grayscale.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field

import cv2
import numpy as np

# ---------------------------------------------------------------- constants

RENDER_DPI = 300          # the scans are 300 dpi; rendering higher only blurs
INK_LEVEL = 210           # seed-finding threshold - measured band, not a guess
MATCH_MIN = 0.62          # grayscale correlation floor, with the band gate on
RING_CONTRAST = 22        # ring must be this much darker than the corners
BAND_MIN = 8              # ...and so must EVERY third of it, top to bottom
NMS_FRAC = 0.62           # centres closer than this x tag width are one tag
MAX_SKEW_DEG = 6.0
MAX_TEMPLATES = 8         # matching cost is linear in these
TAG_MIN_PX, TAG_MAX_PX = 14, 70    # plausible tag bbox at 300 dpi
CLUSTER_LINK = 0.42       # code_dist between two pictures of the same code

_LOOKALIKE = str.maketrans({"I": "1", "L": "1", "O": "0", "Q": "0", "S": "5",
                            "Z": "2", "B": "8", "G": "6", "T": "1", "J": "1"})


@dataclass
class Tag:
    """One detected mark bubble."""
    x: int                       # bbox in the upright working raster, px
    y: int
    w: int
    h: int
    score: float
    code: str = ""
    off_schedule: str = ""       # a confident read that is not in the schedule
    group: int = -1              # index of the appearance group it read from
    cx_pt: float = 0.0           # centre in ORIGINAL page points (for the UI)
    cy_pt: float = 0.0
    kind: str = "unknown"        # window | storefront | door | legend |
                                 # other-tag | unknown

    def as_dict(self) -> dict:
        return {"x": self.x, "y": self.y, "w": self.w, "h": self.h,
                "score": round(self.score, 3), "code": self.code,
                "off_schedule": self.off_schedule,
                "group": self.group, "kind": self.kind,
                "cx": round(self.cx_pt, 1), "cy": round(self.cy_pt, 1)}


@dataclass
class MarkPage:
    """Everything the counter learned about one page."""
    tags: list[Tag] = field(default_factory=list)
    orient: int = 0              # degrees the raster was turned CCW to stand up
    skew_deg: float = 0.0
    tag_size: tuple = (0, 0)
    seeds: int = 0
    groups: list[dict] = field(default_factory=list)
    img_size: tuple = (0, 0)
    notes: list[str] = field(default_factory=list)

    def counts(self) -> dict[str, int]:
        """Schedule marks only - the number the estimator is here for."""
        out: dict[str, int] = {}
        for t in self.tags:
            if t.kind in ("legend", "other-tag"):
                continue
            out[t.code or "?"] = out.get(t.code or "?", 0) + 1
        return dict(sorted(out.items()))

    def off_schedule(self) -> dict[str, int]:
        """Bubbles read confidently as something the schedule does not list
        (on Bill's floor plans: the WALL tags, L04/L06/L26)."""
        out: dict[str, int] = {}
        for t in self.tags:
            if t.kind == "other-tag":
                out[t.off_schedule] = out.get(t.off_schedule, 0) + 1
        return dict(sorted(out.items()))


# --------------------------------------------------------------- raster prep

def render(pdf_path: str, page: int, dpi: int = RENDER_DPI) -> np.ndarray:
    """Page -> BGR image at `dpi`.  No orientation work yet."""
    import pymupdf
    doc = pymupdf.open(pdf_path)
    try:
        pg = doc[page]
        pix = pg.get_pixmap(matrix=pymupdf.Matrix(dpi / 72.0, dpi / 72.0),
                            colorspace="rgb")
        img = np.frombuffer(pix.samples, np.uint8).reshape(
            pix.height, pix.width, 3)[:, :, ::-1].copy()   # RGB -> BGR
    finally:
        doc.close()
    return img


def value(img: np.ndarray) -> np.ndarray:
    """HSV value channel: highlighter stays bright, ink stays dark."""
    return img.max(axis=2) if img.ndim == 3 else img


def ink_mask(img: np.ndarray, level: int = INK_LEVEL) -> np.ndarray:
    return (value(img) < level).astype(np.uint8)


def orient_ccw(img: np.ndarray) -> int:
    """Degrees CCW the raster must turn to stand its text up.

    These sheets are landscape drawings printed on 11x17 and scanned onto a
    portrait page, so the content is a quarter turn off and the PDF does not
    declare it (page.rotation is 0).  Ask tesseract's orientation detector,
    which is what it is for; fall back to the page's own aspect otherwise.
    """
    h, w = img.shape[:2]
    guess = 90 if h > w else 0
    try:
        import pytesseract
        small = cv2.resize(img, None, fx=0.34, fy=0.34,
                           interpolation=cv2.INTER_AREA)
        osd = pytesseract.image_to_osd(small, output_type=pytesseract.Output.DICT)
        cw = int(osd.get("rotate", 0)) % 360        # tesseract reports CW
        if cw in (0, 90, 180, 270) and float(osd.get("orientation_conf", 0)) >= 1.0:
            return (360 - cw) % 360
    except Exception:
        pass
    return guess


def _rot_ccw(img: np.ndarray, deg: int) -> np.ndarray:
    if deg == 90:
        return cv2.rotate(img, cv2.ROTATE_90_COUNTERCLOCKWISE)
    if deg == 180:
        return cv2.rotate(img, cv2.ROTATE_180)
    if deg == 270:
        return cv2.rotate(img, cv2.ROTATE_90_CLOCKWISE)
    return img


def skew_deg(ink: np.ndarray) -> float:
    """Scan skew from the long straight linework, in degrees.

    Deliberately local rather than reusing raster._deskew, so this module
    does not ride on another module's private helper.
    """
    lines = cv2.HoughLinesP((ink * 255), 1, np.pi / 1800, 200,
                            minLineLength=600, maxLineGap=6)
    if lines is None:
        return 0.0
    angs = []
    for x1, y1, x2, y2 in lines.reshape(-1, 4):
        a = math.degrees(math.atan2(float(y2 - y1), float(x2 - x1)))
        if abs(a) < MAX_SKEW_DEG:
            angs.append(a)
        elif abs(abs(a) - 90) < MAX_SKEW_DEG:
            angs.append(a - 90 if a > 0 else a + 90)
    if len(angs) < 6:
        return 0.0
    return float(np.median(angs))


def _compose(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """Affine composition a . b, both 2x3."""
    return (np.vstack([a, [0, 0, 1]]) @ np.vstack([b, [0, 0, 1]]))[:2]


def upright(img: np.ndarray,
            force: int | None = None) -> tuple[np.ndarray, np.ndarray, int, float]:
    """Orient + deskew.

    Returns (working image, undo, orient_ccw_deg, skew_deg) where `undo` is a
    2x3 affine mapping WORKING pixel -> ORIGINAL render pixel, so detections
    can be reported in the page's own coordinates.
    """
    deg = orient_ccw(img) if force is None else force % 360
    rot = _rot_ccw(img, deg)
    h0, w0 = img.shape[:2]
    # working px -> original px for the quarter turn. Verified numerically
    # against cv2.rotate with a single marked pixel (they are easy to get
    # transposed, and a transposed overlay puts every marker in the wrong
    # place on the canvas while the counts stay right).
    if deg == 90:            # ROTATE_90_COUNTERCLOCKWISE
        r_undo = np.array([[0.0, -1.0, w0 - 1.0], [1.0, 0.0, 0.0]])
    elif deg == 270:         # ROTATE_90_CLOCKWISE
        r_undo = np.array([[0.0, 1.0, 0.0], [-1.0, 0.0, h0 - 1.0]])
    elif deg == 180:
        r_undo = np.array([[-1.0, 0.0, w0 - 1.0], [0.0, -1.0, h0 - 1.0]])
    else:
        r_undo = np.array([[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]])

    sk = skew_deg(ink_mask(rot))
    if abs(sk) < 0.15:
        return rot, r_undo, deg, sk
    h, w = rot.shape[:2]
    fwd = cv2.getRotationMatrix2D((w / 2.0, h / 2.0), sk, 1.0)
    work = cv2.warpAffine(rot, fwd, (w, h), flags=cv2.INTER_LINEAR,
                          borderValue=(255, 255, 255))
    undo = _compose(r_undo, cv2.invertAffineTransform(fwd))
    return work, undo, deg, sk


def to_page_pt(undo: np.ndarray, dpi: int, x: float, y: float) -> tuple[float, float]:
    """Working px -> original page points (72 dpi), the UI's coordinates."""
    ox = undo[0, 0] * x + undo[0, 1] * y + undo[0, 2]
    oy = undo[1, 0] * x + undo[1, 1] * y + undo[1, 2]
    return ox * 72.0 / dpi, oy * 72.0 / dpi


# ------------------------------------------------------------- the template

def seed_tags(ink: np.ndarray) -> list[tuple]:
    """Unambiguous tags found by pure geometry, to cut a template from.

    A tag that happens to touch no linework traces as a clean convex ring:
    an outer contour of tag size, high solidity, a hole inside it, 5-7
    corners after simplification.  Most tags on a busy sheet do NOT qualify
    (they touch a wall) - which is exactly why the template match exists -
    but a handful always do, and a handful is all we need.
    """
    cnts, hier = cv2.findContours(ink * 255, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)
    if hier is None:
        return []
    hier = hier[0]
    out = []
    for i, c in enumerate(cnts):
        x, y, w, h = cv2.boundingRect(c)
        if not (TAG_MIN_PX <= w <= TAG_MAX_PX and TAG_MIN_PX <= h <= TAG_MAX_PX):
            continue
        if hier[i][2] < 0:                      # no hole -> not an outline
            continue
        if not (0.7 < w / float(h) < 1.45):
            continue
        a = cv2.contourArea(c)
        hull = cv2.contourArea(cv2.convexHull(c))
        if not hull or a / hull < 0.92 or a / float(w * h) < 0.6:
            continue
        nv = len(cv2.approxPolyDP(c, 0.035 * cv2.arcLength(c, True), True))
        if not (5 <= nv <= 8):
            continue
        out.append((x, y, w, h))
    return out


def size_families(seeds: list[tuple]) -> list[tuple]:
    """Group the seeds into congruent-size families, biggest family first.

    A sheet carries several bubble shapes at once - on Bill's A110 the
    window hexagon (31x35 px), the wall-tag diamond, the small keynote
    circle (~14x18 px) and the detail callout - and they are NOT
    interchangeable: mixing sizes into one template set makes the keynote
    circles outvote the window tags 12 seeds to 4.  Each family is matched
    and counted separately and the CODE decides which family is which.

    Returns [(w, h, [seed, ...]), ...].
    """
    from collections import Counter
    if not seeds:
        return []
    buckets = Counter((round(w / 3.0) * 3, round(h / 3.0) * 3)
                      for _, _, w, h in seeds)
    out = []
    for (bw, bh), _ in buckets.most_common():
        fam = [s for s in seeds if abs(s[2] - bw) <= 3 and abs(s[3] - bh) <= 3]
        if len(fam) < 2:
            continue
        w = int(np.median([s[2] for s in fam]))
        h = int(np.median([s[3] for s in fam]))
        if any(abs(w - o[0]) <= 2 and abs(h - o[1]) <= 2 for o in out):
            continue          # overlapping buckets picked the same family
        out.append((w, h, fam))
    return out


def _patch_box(x, y, w, h, tw, th) -> tuple[int, int]:
    return int(round(x + w / 2.0 - tw / 2.0)), int(round(y + h / 2.0 - th / 2.0))


# ---------------------------------------------------------------- the match

@dataclass
class Family:
    """One congruent bubble family and the masks learned from its seeds."""
    w: int
    h: int
    pad: int
    ring: np.ndarray             # bool: the outline stroke
    corner: np.ndarray           # bool: paper outside the bubble
    inner: np.ndarray            # bool: inside the bubble, clear of the stroke
    bands: list                  # the ring split into top / middle / bottom


def build_family(gray: np.ndarray, ink: np.ndarray, seeds: list[tuple],
                 tag_w: int, tag_h: int) -> tuple[Family, list[np.ndarray]] | None:
    """Learn the family's masks and cut its templates, from the sheet itself.

    Everything here is measured off the seeds rather than drawn from a
    shape assumption, so the same code counts hexagons, diamonds, circles
    and stadiums without being told which it is looking at.
    """
    pad = 3
    tw, th = tag_w + 2 * pad, tag_h + 2 * pad
    H, W = gray.shape[:2]
    gpats, bpats = [], []
    for (x, y, w, h) in seeds:
        x0, y0 = _patch_box(x, y, w, h, tw, th)
        if x0 < 0 or y0 < 0 or x0 + tw > W or y0 + th > H:
            continue
        gpats.append(gray[y0:y0 + th, x0:x0 + tw])
        bpats.append(ink[y0:y0 + th, x0:x0 + tw].astype(np.float32))
        if len(gpats) >= MAX_TEMPLATES:
            break
    if not gpats:
        return None
    mean = np.mean(bpats, axis=0)
    ring = mean >= 0.75          # ink in nearly every seed = the outline
    corner = mean <= 0.02        # white in every seed = outside the bubble
    if ring.sum() < 30 or corner.sum() < 30:
        return None
    # inside the bubble = fill the ring, then pull back past the stroke, so
    # neither the outline nor a wall line grazing the box can reach the code
    pts = cv2.findNonZero(ring.astype(np.uint8))
    inner = np.zeros((th, tw), np.uint8)
    cv2.fillConvexPoly(inner, cv2.convexHull(pts), 1)
    ero = max(3, int(round(min(tag_w, tag_h) * 0.16)) | 1)
    inner = cv2.erode(inner, np.ones((ero, ero), np.uint8)).astype(bool)
    if inner.sum() < 60:
        return None
    # the ring in three horizontal bands.  A bubble is inked all the way
    # round; the false positive that survives everything else on this
    # document - the client's solid marker bar redacting the permit stamp -
    # is inked in ONE band only.  Requiring all three is what let the match
    # threshold come down from 0.65 to 0.58 and pick up the W4 tags.
    b1, b2 = th // 3, 2 * th // 3
    bands = []
    for lo, hi in ((0, b1), (b1, b2), (b2, th)):
        b = np.zeros_like(ring)
        b[lo:hi] = ring[lo:hi]
        bands.append(b)
    if min(int(b.sum()) for b in bands) < 12:
        return None
    return Family(tag_w, tag_h, pad, ring, corner, inner, bands), gpats


def find_tags(gray: np.ndarray, fam: Family, gpats: list[np.ndarray],
              thr: float = MATCH_MIN) -> list[Tag]:
    """Grayscale multi-template match + non-max suppression + a ring gate.

    Several templates rather than one average: a template carries its own
    code text, so a single "W1L" template scores W1L tags 0.7-1.0 but W1R
    tags only 0.58-0.65.  Taking the max over templates cut from different
    tags puts every code on the same footing without blurring the ring.
    """
    th, tw = gpats[0].shape[:2]
    best = None
    for t in gpats:
        r = cv2.matchTemplate(gray, t, cv2.TM_CCOEFF_NORMED)
        best = r if best is None else np.maximum(best, r)
    ys, xs = np.where(best >= thr)
    if not len(ys):
        return []
    nms = max(4, int(fam.w * NMS_FRAC))
    out: list[Tag] = []
    kx: list[int] = []
    ky: list[int] = []
    for i in np.argsort(-best[ys, xs]):
        px, py = int(xs[i]), int(ys[i])
        if any(abs(px - a) < nms and abs(py - b) < nms for a, b in zip(kx, ky)):
            continue
        g = gray[py:py + th, px:px + tw]
        if g.shape != (th, tw):
            continue
        # a real bubble is a dark ring on clean paper, inked all the way
        # round: this kills the faint ghosts correlation alone accepts, and
        # the client's solid marker bars, which only ink one band
        cm = g[fam.corner].mean()
        if g[fam.ring].mean() - cm < RING_CONTRAST:
            continue
        if min(g[b].mean() for b in fam.bands) - cm < BAND_MIN:
            continue
        kx.append(px)
        ky.append(py)
        out.append(Tag(x=px + fam.pad, y=py + fam.pad, w=fam.w, h=fam.h,
                       score=float(best[py, px])))
    return out


# ------------------------------------------------------------------ the code

def isolate_code(gray: np.ndarray, t: Tag, fam: Family) -> np.ndarray | None:
    """The code text alone, with the bubble outline masked away.

    Erasing the outline is what makes the read possible at all: at 12 px
    cap height the ring's arcs get classified as glyphs and the string
    comes back as noise.  The mask is the family's own learned interior,
    not this patch's ink, so a wall line grazing the bubble cannot pull the
    mask open (it did, when the mask was the patch's convex hull).
    """
    y0, x0 = t.y - fam.pad, t.x - fam.pad
    h, w = fam.inner.shape[:2]
    if y0 < 0 or x0 < 0 or y0 + h > gray.shape[0] or x0 + w > gray.shape[1]:
        return None
    g = gray[y0:y0 + h, x0:x0 + w].astype(np.float32).copy()
    g[~fam.inner] = 0.0
    if g.max() < 40:
        return None
    return g


CANON = (48, 28)


def _canonical(g: np.ndarray, size: tuple = CANON) -> np.ndarray | None:
    """Normalise a code image so two instances of one code are the same
    picture: drop specks, crop to the ink, scale by ONE factor (aspect is
    information - "W4" is not a squashed "W1L") and centre on a fixed
    canvas."""
    m = (g >= max(40.0, g.max() * 0.45)).astype(np.uint8)
    n, _, st, _ = cv2.connectedComponentsWithStats(m, connectivity=8)
    keep = [i for i in range(1, n) if st[i, cv2.CC_STAT_AREA] >= 6]
    if not keep:
        return None
    x0 = min(st[i, cv2.CC_STAT_LEFT] for i in keep)
    y0 = min(st[i, cv2.CC_STAT_TOP] for i in keep)
    x1 = max(st[i, cv2.CC_STAT_LEFT] + st[i, cv2.CC_STAT_WIDTH] for i in keep)
    y1 = max(st[i, cv2.CC_STAT_TOP] + st[i, cv2.CC_STAT_HEIGHT] for i in keep)
    sub = g[y0:y1, x0:x1]
    if sub.size == 0 or sub.shape[0] < 3 or sub.shape[1] < 3:
        return None
    sub = sub / max(sub.max(), 1.0)
    k = min(size[0] / sub.shape[1], size[1] / sub.shape[0])
    nw, nh = max(2, int(round(sub.shape[1] * k))), max(2, int(round(sub.shape[0] * k)))
    sub = cv2.resize(sub, (nw, nh), interpolation=cv2.INTER_AREA)
    out = np.zeros((size[1], size[0]), np.float32)
    oy, ox = (size[1] - nh) // 2, (size[0] - nw) // 2
    out[oy:oy + nh, ox:ox + nw] = sub
    return out


def _ncc(a: np.ndarray, b: np.ndarray) -> float:
    a = a - a.mean()
    b = b - b.mean()
    d = math.sqrt(float((a * a).sum()) * float((b * b).sum()))
    return float((a * b).sum() / d) if d else 0.0


CODE_BANDS = 4


def code_dist(a: np.ndarray, b: np.ndarray, n: int = CODE_BANDS) -> float:
    """Distance between two code pictures, per character band.

    Whole-image correlation is the wrong metric for marks that differ in ONE
    character: W1L and W2L share the W and the L, so two thirds of the
    picture agrees and the difference is averaged away.  Measured on floor 3,
    where four real W2L tags exist: whole-image distance put W1L-vs-W2L as
    close as 0.142 while W1L-vs-W1L ran to 0.395, so no threshold could
    separate them - and the four W2L tags were silently absorbed into the
    W1L group and counted as W1L.  Scoring the worst of four column bands
    instead pulls them apart: W2L-vs-W2L tops out at 0.393 and W1L-vs-W2L
    never comes closer than 0.454.

    Splitting one code across several groups is harmless (each group reads
    the same code and the counts add up); merging two codes is not, so the
    metric is deliberately biased towards splitting.
    """
    w = a.shape[1] // n
    return max(1.0 - _ncc(a[:, k * w:(k + 1) * w], b[:, k * w:(k + 1) * w])
               for k in range(n))


def group_codes(canon: list[np.ndarray | None],
                link: float = CLUSTER_LINK) -> list[list[int]]:
    """Group tags whose code pictures are the same picture.

    The codes are printed type, so two W1L tags are pixel-siblings and a
    W1L and a W1R are not.  Grouping first, then reading ONE averaged image
    per group, is the whole trick: averaging 20 noisy 12-px scans produces a
    glyph tesseract can actually read, and it makes the read a per-CODE
    decision instead of 20 independent coin flips.

    Leader clustering (assign to the nearest centroid, else start a new
    group, then one re-assignment pass) rather than full agglomerative:
    the same answer on this data at a fraction of the cost, and a page can
    legitimately produce hundreds of candidate bubbles.
    """
    idx = [i for i, c in enumerate(canon) if c is not None]
    if not idx:
        return []
    cents: list[np.ndarray] = []
    members: list[list[int]] = []
    for i in idx:
        v = canon[i]
        bs, bj = 9.0, -1
        for j, c in enumerate(cents):
            s = code_dist(v, c)
            if s < bs:
                bs, bj = s, j
        if bj >= 0 and bs <= link:
            members[bj].append(i)
            n = len(members[bj])
            cents[bj] = cents[bj] * ((n - 1) / n) + v / n
        else:
            cents.append(v.copy())
            members.append([i])
    # one clean-up pass: an early member may now sit nearer another centroid
    for _ in range(2):
        moved = False
        for j, mem in enumerate(members):
            for i in list(mem):
                if len(mem) == 1:
                    continue
                bs, bj = 9.0, j
                for k, c in enumerate(cents):
                    s = code_dist(canon[i], c)
                    if s < bs:
                        bs, bj = s, k
                if bj != j and bs <= link:
                    mem.remove(i)
                    members[bj].append(i)
                    moved = True
        if not moved:
            break
        cents = [np.mean([canon[i] for i in m], axis=0) for m in members]
    members = [m for m in members if m]
    members.sort(key=len, reverse=True)
    return members


def _shift(a: np.ndarray, dx: int, dy: int) -> np.ndarray:
    out = np.zeros_like(a)
    h, w = a.shape
    sy0, sy1 = max(0, dy), min(h, h + dy)
    sx0, sx1 = max(0, dx), min(w, w + dx)
    out[sy0:sy1, sx0:sx1] = a[sy0 - dy:sy1 - dy, sx0 - dx:sx1 - dx]
    return out


def align_average(imgs: list[np.ndarray], rad: int = 2) -> np.ndarray:
    """Average code pictures after nudging each onto the running mean.

    Without this the average of twenty tags is a smear: each crop is
    normalised off its own ink bbox, and one stray pixel of the outline
    moves the bbox by one, so the glyphs drift a pixel or two apart.  Two
    passes of an integer +/-2 px search sharpen the average enough that
    tesseract reads it - measured on page 4, where the same group went from
    unreadable to "W1L".
    """
    if len(imgs) == 1:
        return imgs[0].copy()
    mean = np.mean(imgs, axis=0)
    for _ in range(2):
        aligned = []
        for im in imgs:
            bs, bshift = -2.0, (0, 0)
            for dy in range(-rad, rad + 1):
                for dx in range(-rad, rad + 1):
                    s = _ncc(_shift(im, dx, dy), mean)
                    if s > bs:
                        bs, bshift = s, (dx, dy)
            aligned.append(_shift(im, *bshift))
        new = np.mean(aligned, axis=0)
        if _ncc(new, mean) > 0.999:
            return new
        mean = new
    return mean


def _clean(s: str) -> str:
    return re.sub(r"[^A-Z0-9]", "", (s or "").upper())


def _lev(a: str, b: str) -> int:
    if a == b:
        return 0
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def snap(raw: str, vocab: list[str]) -> tuple[str, float]:
    """Snap an OCR string onto the schedule's own vocabulary.

    Constrained reading, not free reading: the schedule says which codes can
    legally appear, so a read of "WIL" resolves to W1L (I-for-1 is the
    classic confusion at this glyph size) instead of inventing a mark.
    Returns (code, penalty); penalty 0 = exact, higher = weaker evidence.

    Note the whitelist route does NOT work here and was measured failing:
    with `tessedit_char_whitelist` set to the schedule's letters, tesseract
    drops the characters it actually saw ("WIL" -> "WL") and the string
    becomes unsnappable.  Read free, snap afterwards.
    """
    t = _clean(raw)
    if not t:
        return "", 100.0
    if t in vocab:
        return t, 0.0
    t2 = t.translate(_LOOKALIKE)
    for v in vocab:
        if t2 == v.translate(_LOOKALIKE):
            return v, 4.0
    # NO fuzzy fallback beyond the lookalike map.  It was measured turning a
    # real "W2L" - which the averaged picture reads correctly to a human but
    # which tesseract returns as "WA" - into a confident "W4", because W4 is
    # one edit away.  A wrong mark is worse for the estimator than no mark:
    # the panel shows an unread group he can name in one click, whereas a
    # wrong name is silent and ends up on the supplier order.
    return "", 100.0


_PSMS = ("7", "8", "6", "10", "13")


def read_image(g: np.ndarray, vocab: list[str],
               flip: bool = False) -> tuple[str, float, str, int]:
    """Read one isolated code picture.

    Returns (code, vote weight, raw read, how many PSMs agreed on the raw).
    """
    try:
        import pytesseract
    except Exception:
        return "", 0.0, "", 0
    if flip:
        g = cv2.rotate(g, cv2.ROTATE_180)
    v = (255 - g).clip(0, 255).astype(np.uint8)
    big = cv2.resize(v, None, fx=8, fy=8, interpolation=cv2.INTER_CUBIC)
    big = cv2.GaussianBlur(big, (0, 0), 2)
    _, bb = cv2.threshold(big, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    bb = cv2.copyMakeBorder(bb, 30, 30, 30, 30, cv2.BORDER_CONSTANT, value=255)
    votes: dict[str, float] = {}
    raws: list[str] = []
    for psm in _PSMS:
        try:
            raw = pytesseract.image_to_string(bb, config=f"--psm {psm}").strip()
        except Exception:
            return "", 0.0, "", 0
        if not _clean(raw):
            continue
        raws.append(_clean(raw))
        code, pen = snap(raw, vocab)
        if code:
            votes[code] = votes.get(code, 0.0) + (2.0 if pen == 0 else
                                                  1.5 if pen <= 4 else 0.4)
    # the commonest free read, kept so an out-of-schedule bubble can SAY what
    # it looked like ("read L04, not in the schedule") instead of just "?".
    # `agree` counts how many page-segmentation modes produced it: a read
    # three or more of them agree on is a real string, just not one of this
    # schedule's marks - almost always a neighbouring tag family (the WALL
    # tags on Bill's A110 read L04/L06 and land here).
    from collections import Counter
    top_raw, agree = ("", 0)
    if raws:
        top_raw, agree = Counter(raws).most_common(1)[0]
    if not votes:
        return "", 0.0, top_raw, agree
    code = max(votes, key=votes.get)
    return code, votes[code], top_raw, agree


# A read is only believed when the page-setter modes agree well enough:
# one exact vocabulary hit (2.0), or several lookalike-corrected ones.
# Measured: real groups on Bill's A110 land at 2.0-6.0, while the keynote
# circles' noise tops out at 1.2.
READ_MIN_WEIGHT = 1.5


# ------------------------------------------------------------------- driver

def _legend_box(img: np.ndarray) -> tuple | None:
    """The sheet's SYMBOL LEGEND block.

    Its key symbols are real tags with real codes in them, so the legend
    counts itself unless it is excluded.  Returns a box covering the key
    column under the heading (narrow, because the legend's TEXT column is
    beside it and real tags may live further right).
    """
    try:
        import pytesseract
    except Exception:
        return None
    h, w = img.shape[:2]
    # the heading is set large, so a half-scale page reads it fine and OCRs
    # in a couple of seconds instead of a couple of minutes
    f = 0.5
    small = cv2.resize(value(img), None, fx=f, fy=f, interpolation=cv2.INTER_AREA)
    try:
        d = pytesseract.image_to_data(small, config="--psm 11",
                                      output_type=pytesseract.Output.DICT)
    except Exception:
        return None
    for i, word in enumerate(d["text"]):
        if _clean(word) != "SYMBOL":
            continue
        nxt = _clean(d["text"][i + 1]) if i + 1 < len(d["text"]) else ""
        if not nxt.startswith("LEGEN"):
            continue
        x, y = int(d["left"][i] / f), int(d["top"][i] / f)
        return (max(0, x - 30), max(0, y - 10), min(w, x + 220), min(h, y + 900))
    return None


# ------------------------------------------------------- the sheet's schedule

# Plain English for a reader who is not an estimator: a "schedule" on an
# architectural sheet is a TABLE, not a calendar.  One row per mark, with the
# size, the material and (sometimes) how many of them the job needs.  The
# estimator counts the bubbles on the plan and checks the total against this
# table's QTY column; that cross-check is the whole point of reading it.

# The column that holds the mark.  Different offices head it differently -
# Kevin Tsai's A830 says MARK, Mission Bell's A-6.00 says WINDOW TYPE - and
# both mean "the code you will see inside the bubbles".
_MARK_HEADS = ("MARK", "TYPE", "SYMBOL", "TAG")
_TYPE_PREFIX = ("WINDOW", "DOOR", "STOREFRONT", "GLAZING", "FRAME", "OPENING")
# The column that holds how many.  NO. is ambiguous (it also heads "DOOR NO.")
# so it is accepted only when nothing better is on the header row.
_QTY_HEADS = ("QTY", "QTY.", "QUANTITY", "COUNT", "TOTAL", "EA")
_QTY_WEAK = ("NO", "NO.", "#")

# A mark code: one to three letters then an optional number then an optional
# suffix letter (W1L, SF2, D101A), or a bare letter used as a type name
# (Mission Bell heads its window types A..Z).
_MARK_RE = re.compile(r"^[A-Z]{1,3}-?\d{1,3}[A-Z]?$")
_LETTER_RE = re.compile(r"^[A-Z]{1,2}$")


def _txt(w) -> str:
    return str(w[4]).strip().upper()


# A wide table on a SKEWED scan does not have a flat header row. Bill Dunn's
# Aqua Vista schedule is OCR'd off a 300 dpi scan that marks.upright measures
# at 2.2 deg, and its MARK and QUANTITY headers sit ~700 pt apart, so their
# y centres differ by ~28 pt - six times the flat y_tol. The row match has to
# widen with horizontal distance or a quantity column is simply never seen.
# 0.045 covers ~2.6 deg, above every skew measured on his sheets. On a real
# text layer dx-widening costs nothing because dy there is ~0.
SKEW_SLOPE = 0.045


def _row_tol(y_tol: float, dx: float) -> float:
    """y tolerance for two words claimed to be on the same table row."""
    return y_tol + SKEW_SLOPE * abs(dx)


def _is_qty_head(t: str) -> bool:
    """QTY column header, tolerant of OCR noise.

    A table rule touching the word comes back glued to it - Bill's schedule
    OCRs as "LQUANTITY" - so a head token is accepted when it sits inside a
    slightly longer word as well as when it matches outright.
    """
    if t in _QTY_HEADS:
        return True
    core = "".join(c for c in t if c.isalpha())
    for q in _QTY_HEADS:
        qa = "".join(c for c in q if c.isalpha())
        if len(qa) >= 3 and core.endswith(qa) and len(core) - len(qa) <= 2:
            return True
    return False


def read_mark_schedule(words: list, y_tol: float = 5.0,
                       fuzzy: bool = False) -> dict:
    """Read a MARK/QTY (or WINDOW TYPE/QTY) schedule out of a page's words.

    Returns {"marks": [code, ...] in sheet order, "qty": {code: n},
             "box": (x0, y0, x1, y1) or None, "header": "MARK"|"WINDOW TYPE",
             "fuzzy": [raw, ...], "source": "text"|"ocr"|"none"}.

    QTY is OPTIONAL.  A schedule with no quantity column - Mission Bell's
    A-6.00 lists 22 readable window types and never says how many - is still
    worth reading, because the type list IS the legal vocabulary the bubbles
    must come from, and constraining the read to it is what stops OCR
    inventing marks at 12 px glyph height.

    `fuzzy` is for schedules that had to be OCR'd off a scan: the mark
    column comes back as WIL / WIR / WS rather than W1L / W1R / W5, so the
    same lookalike map used on the bubbles is applied here.  It is off by
    default because on a real text layer it can only do harm.
    """
    out = {"marks": [], "qty": {}, "box": None, "header": "",
           "fuzzy": [], "source": "none"}
    if not words:
        return out
    best = None
    for hw in words:
        t = _txt(hw)
        if t not in _MARK_HEADS:
            continue
        hy = (hw[1] + hw[3]) / 2.0
        hx = (hw[0] + hw[2]) / 2.0
        row = [w for w in words
               if abs((w[1] + w[3]) / 2.0 - hy)
               <= _row_tol(y_tol, (w[0] + w[2]) / 2.0 - hx)]
        row.sort(key=lambda w: w[0])
        texts = [_txt(w) for w in row]
        # "WINDOW TYPE" / "DOOR TYPE": the qualifier sits immediately left
        header = t
        if t == "TYPE":
            j = texts.index(t)
            if j and texts[j - 1] in _TYPE_PREFIX:
                header = texts[j - 1] + " TYPE"
            elif len(set(texts)) < 3:
                continue        # a bare "TYPE" with no table around it
        qcol = None
        for w in row:
            if _is_qty_head(_txt(w)):
                qcol = w
                break
        if qcol is None:
            for w in row:
                if _txt(w).rstrip(".") in [q.rstrip(".") for q in _QTY_WEAK]:
                    qcol = w
                    break
        cand = _harvest(words, hw, qcol, row, header, y_tol, fuzzy)
        if cand and (best is None or len(cand["marks"]) > len(best["marks"])):
            best = cand
    return best or out


# Characters an OCR pass confuses at drafting-text size, both directions.
_AMBIG = {"I": "1", "L": "1", "O": "0", "S": "5", "Z": "2", "B": "8", "G": "6",
          "1": "I", "0": "O", "5": "S", "2": "Z", "8": "B", "6": "G"}
_STRICT_MARK = re.compile(r"^[A-Z]{1,2}\d{1,3}[A-Z]?$")


def _fuzzy_mark(t: str) -> str | None:
    """Best mark-shaped reading of an OCR'd word, or None.

    A blanket translate is wrong - it turns "WIL" into "W11" - so every
    ambiguous character is tried both ways and the variant that fits the
    mark grammar (letters, then digits, then an optional suffix letter)
    wins.  "WIL" -> W1L, "WS" -> W5, "WIR" -> W1R.
    """
    amb = [i for i, c in enumerate(t) if c in _AMBIG]
    if not amb or len(amb) > 4 or len(t) > 5:
        return None
    for bits in range(1 << len(amb)):
        v = list(t)
        for k, i in enumerate(amb):
            if bits >> k & 1:
                v[i] = _AMBIG[t[i]]
        s = "".join(v)
        if _STRICT_MARK.match(s):
            return s
    return None


def _as_mark(t: str, fuzzy: bool) -> str | None:
    """One word -> a mark code, or None."""
    if _MARK_RE.match(t):
        return t
    if len(t) == 1 and t.isalpha():
        return t              # a bare type letter: Mission Bell heads A..Z
    if fuzzy and t[:1].isalpha():
        return _fuzzy_mark(t)
    return None


def _harvest(words: list, hw, qcol, row: list, header: str,
             y_tol: float, fuzzy: bool) -> dict | None:
    """Rows under one header: mark codes in the mark column, qty beside."""
    mx0, mx1 = hw[0] - 14, hw[2] + 14
    rx0 = min(w[0] for w in row) - 8
    rx1 = max(w[2] for w in row) + 8
    qcx = (qcol[0] + qcol[2]) / 2.0 if qcol is not None else None
    # The table's own two headers give its row slope, so a quantity 700 pt
    # away is looked for where that row ACTUALLY runs rather than inside a
    # band wide enough to swallow its neighbours. Widening symmetrically
    # instead gave every mark on Bill's schedule the same quantity (148).
    slope = 0.0
    if qcol is not None:
        hxc, hyc = (hw[0] + hw[2]) / 2.0, (hw[1] + hw[3]) / 2.0
        qyc = (qcol[1] + qcol[3]) / 2.0
        if abs(qcx - hxc) > 1.0:
            slope = (qyc - hyc) / (qcx - hxc)
    marks, raws, qty, y_max = [], [], {}, hw[3]
    letters_only = True
    for w in words:
        if w[1] <= hw[3] or not (mx0 <= (w[0] + w[2]) / 2.0 <= mx1):
            continue
        t = _txt(w)
        code = _as_mark(t, fuzzy)
        if code is None:
            continue
        # the mark column is the table's FIRST column: nothing else on this
        # row may sit to its left.  Without this, a "WINDOW TYPE" heading
        # over a hardware column harvests prose ("OR", "OF", "IN", "IS")
        wy = (w[1] + w[3]) / 2.0
        if any(m[2] < w[0] - 1 and abs((m[1] + m[3]) / 2.0 - wy) <= y_tol
               and rx0 <= m[0] and len(_txt(m)) > 1 and _txt(m).isalnum()
               for m in words):
            continue
        if len(code) > 1:
            letters_only = False
        if code in marks:
            continue
        marks.append(code)
        raws.append(t)
        y_max = max(y_max, w[3])
        if qcx is None:
            continue
        wxc = (w[0] + w[2]) / 2.0
        want = wy + slope * (qcx - wxc)      # where this row runs at qcx
        mates = [m for m in words
                 if abs((m[1] + m[3]) / 2.0 - want) <= y_tol
                 and _txt(m).isdigit() and rx0 <= m[0] and m[2] <= rx1]
        if mates:
            q = min(mates, key=lambda m: abs((m[0] + m[2]) / 2.0 - qcx))
            if abs((q[0] + q[2]) / 2.0 - qcx) <= 30.0:
                qty[code] = int(_txt(q))
    if len(marks) < 2:
        return None
    if letters_only and len(marks) < 3:
        # two stray capitals under a "TYPE" heading is not a schedule
        return None
    return {"marks": marks, "qty": qty, "header": header,
            "source": "ocr" if fuzzy else "text",
            "fuzzy": [r for r, c in zip(raws, marks) if r != c],
            "box": (rx0, hw[1] - 4, rx1, y_max + 8)}


RESCUE_MIN = 0.62         # a groupless average must look this like a named one
RESCUE_MARGIN = 0.07      # ...and this much more like it than like any other


def _rescue(gdicts: list[dict], gfirst: int, means: list[np.ndarray],
            groups: list[list[int]], tags: list[Tag]) -> None:
    """Give an unread group the code of the named group it looks like.

    Some appearance groups average badly - a couple of instances sitting on
    a wall line, or a group of two - and come back unread even though the
    page has already resolved that same code from a cleaner group of twenty.
    Comparing the two averaged pictures is stronger evidence than a second
    OCR attempt, so the page's own best read is reused, but only when the
    match is decisive AND unambiguous between codes.
    """
    named = [(gi, gdicts[gfirst + gi]["code"]) for gi in range(len(groups))
             if gdicts[gfirst + gi]["code"]]
    if not named:
        return
    for gi in range(len(groups)):
        g = gdicts[gfirst + gi]
        if g["code"]:
            continue
        per: dict[str, float] = {}
        for nj, code in named:
            s = 1.0 - code_dist(means[gi], means[nj])
            per[code] = max(per.get(code, -2.0), s)
        code = max(per, key=per.get)
        others = [v for k, v in per.items() if k != code]
        if per[code] < RESCUE_MIN:
            continue
        if others and per[code] - max(others) < RESCUE_MARGIN:
            continue
        g["code"] = code
        g["weight"] = round(per[code], 2)
        g["raw"] = (g.get("raw") or "") + " ~matched"
        for i in groups[gi]:
            tags[i].code = code


DEFAULT_VOCAB = ["W1", "W2", "W3", "W4", "W5", "SF1", "SF2", "SF3"]
MAX_FAMILIES = 3          # bubble families matched per page
MAX_GROUP_READS = 14      # appearance groups OCR'd per family
CHAR_PX = 7.0             # measured advance of one code character at 300 dpi


def detect_marks(pdf_path: str, page: int, vocab: list[str] | None = None,
                 dpi: int = RENDER_DPI, thr: float = MATCH_MIN,
                 with_ocr: bool = True, img: np.ndarray | None = None,
                 debug: dict | None = None,
                 max_families: int = MAX_FAMILIES,
                 force_orient: int | None = None,
                 _retry: bool = True) -> MarkPage:
    """Count the mark bubbles on one scanned page.

    `vocab` is the legal code list - normally the MARK column of the sheet's
    own schedule.  Passing it is what turns free OCR (which reads "WIL",
    "WlL", "NIL" at this glyph size) into a constrained classification.
    """
    src = render(pdf_path, page, dpi) if img is None else img
    work, undo, deg, sk = upright(src, force_orient)
    gray = (255 - value(work)).astype(np.float32)     # ink high
    ink = ink_mask(work)
    mp = MarkPage(orient=deg, skew_deg=round(sk, 3),
                  img_size=(work.shape[1], work.shape[0]))

    vocab = [v.upper() for v in (vocab or DEFAULT_VOCAB)]
    # A vocabulary of single letters cannot constrain anything.  Kevin Tsai's
    # schedule lists W1L/W1R/W2L - three characters, so a wrong read almost
    # never lands on a legal mark.  WORKSHOP-P's Mission Bell schedule lists
    # window types A..Z, and with 21 one-character codes virtually ANY glyph
    # the OCR emits is "in vocabulary": measured on that sheet, the page came
    # back with 88 unread and confident-looking counts for A/B/C/G/Q/S that
    # are grid bubbles and sensor dots, not windows.  Counting still works
    # there; NAMING does not, so it is withheld rather than guessed.
    weak_vocab = max((len(v) for v in vocab), default=0) < 2
    if weak_vocab:
        mp.notes.append(
            "this schedule's marks are single letters, which is too weak to "
            "tell one bubble's code from another at this glyph size - "
            "bubbles are counted but left unnamed for you to name")
    seeds = seed_tags(ink)
    mp.seeds = len(seeds)
    fams = size_families(seeds)
    # Only families whose bubble can physically hold the longest legal code
    # are mark bubbles.  Measured on this sheet: "W1L" spans ~21 px inside a
    # 31 px hexagon at 300 dpi, i.e. ~7 px per character plus the stroke and
    # its clearance.  This is what separates a WINDOW TAG from the ~14 px
    # keynote circle that carries a single digit - the small one is a real
    # repeated symbol, it just cannot be a mark from this schedule.
    need = CHAR_PX * (dpi / 300.0) * max(len(v) for v in vocab) + 8
    small = [f for f in fams if f[0] < need]
    fams = [f for f in fams if f[0] >= need][:max_families]
    if small:
        mp.notes.append(
            f"{len(small)} smaller repeated symbol famil"
            f"{'y' if len(small) == 1 else 'ies'} on this page "
            f"({', '.join(f'{f[0]}x{f[1]}px' for f in small[:4])}) are too "
            f"small to hold a {max(len(v) for v in vocab)}-character mark - "
            f"not counted as marks")
    if not fams:
        mp.notes.append("no repeated outlined symbol big enough to carry a "
                        "mark from this schedule")
        return mp
    mp.tag_size = (fams[0][0], fams[0][1])
    lb = _legend_box(work) if with_ocr else None
    if lb:
        mp.notes.append("SYMBOL LEGEND key symbols excluded from the count")

    all_tags: list[Tag] = []
    dbg_codes, dbg_canon, dbg_groups = [], [], []
    upright_votes = flipped_votes = 0
    for fi, (tw, th, seedset) in enumerate(fams):
        built = build_family(gray, ink, seedset, tw, th)
        if built is None:
            continue
        fam, gpats = built
        tags = find_tags(gray, fam, gpats, thr)
        if not tags:
            continue
        for t in tags:
            cx, cy = t.x + t.w / 2.0, t.y + t.h / 2.0
            t.cx_pt, t.cy_pt = to_page_pt(undo, dpi, cx, cy)
            if lb and lb[0] <= cx <= lb[2] and lb[1] <= cy <= lb[3]:
                t.kind = "legend"
        base = len(all_tags)
        if with_ocr:
            codes = [isolate_code(gray, t, fam) for t in tags]
            canon = [_canonical(c) if c is not None else None for c in codes]
            groups = group_codes(canon)
            gfirst = len(mp.groups)
            means: list[np.ndarray] = []
            for gi, members in enumerate(groups):
                code, weight, raw, agree = "", 0.0, "", 0
                avg = align_average([canon[i] for i in members]) * 255.0
                means.append(avg)
                if gi < MAX_GROUP_READS:
                    code, weight, raw, agree = read_image(avg, vocab)
                    if not code and len(members) == 1:
                        # a lone tag has no siblings to average with
                        code, weight, raw, agree = read_image(
                            codes[members[0]], vocab)
                    if weight < READ_MIN_WEIGHT or weak_vocab:
                        code = ""
                    if not code:
                        # tesseract's page-orientation detector picks 270 for
                        # 90 now and then (measured: it did on page 4 of this
                        # very document).  A 180-degree read of the code
                        # picture is the cheap check, and its vote decides
                        # whether the whole page gets re-run the other way up.
                        fc, fw, _, _ = read_image(avg, vocab, flip=True)
                        if fc and fw >= READ_MIN_WEIGHT:
                            flipped_votes += len(members)
                    else:
                        upright_votes += len(members)
                # a string most modes agreed on that is not in the schedule
                # is a NEIGHBOURING tag family, not an unread window mark
                off = raw if (not code and agree >= 3 and len(raw) >= 2) else ""
                mp.groups.append({"family": fi, "w": tw, "h": th,
                                  "n": len(members), "code": code,
                                  "raw": raw, "off_schedule": off,
                                  "weight": round(weight, 1)})
                for i in members:
                    tags[i].code = code
                    tags[i].off_schedule = off
                    tags[i].group = len(mp.groups) - 1
            _rescue(mp.groups, gfirst, means, groups, tags)
            dbg_codes += codes
            dbg_canon += canon
            dbg_groups += [[base + i for i in m] for m in groups]
        else:
            mp.groups.append({"family": fi, "w": tw, "h": th,
                              "n": len(tags), "code": "", "raw": "",
                              "weight": 0.0})
        all_tags += tags

    # (no point retrying the other way up when the vocabulary was too weak to
    # read either way - nothing would vote)
    if _retry and not weak_vocab and flipped_votes > upright_votes \
            and flipped_votes >= 3:
        mp2 = detect_marks(pdf_path, page, vocab, dpi, thr, with_ocr, src,
                           debug, max_families, (deg + 180) % 360, False)
        mp2.notes.append(f"page orientation corrected: the detector's first "
                         f"pass stood the sheet at {deg} deg and no code read "
                         f"as a mark; re-run at {(deg + 180) % 360} deg")
        return mp2

    for t in all_tags:
        if t.kind == "legend":
            continue
        t.kind = ("storefront" if t.code.startswith("SF")
                  else "door" if t.code.startswith("D")
                  else "window" if t.code.startswith("W")
                  else "other-tag" if t.off_schedule
                  else "unknown")
    mp.tags = all_tags
    if debug is not None:
        debug.update(work=work, gray=gray, codes=dbg_codes, canon=dbg_canon,
                     groups=dbg_groups, undo=undo, families=fams)
    return mp
