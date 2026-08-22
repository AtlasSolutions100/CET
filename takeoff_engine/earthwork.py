"""Cut & fill volumes from labeled contour lines (Delaunay TIN).

The estimator's question: between the EXISTING grade and the PROPOSED
grade, how much material comes out (cut) and how much goes in (fill)?

Model: each surface is a set of contour polylines, each carrying one
elevation in feet. Sampled points of every contour become a Delaunay TIN
(scipy LinearNDInterpolator = piecewise-linear surface). Volumes integrate
the difference over a grid restricted to where BOTH surfaces are defined -
extrapolating beyond a TIN's hull would invent terrain, and invented
terrain is invented truckloads.

Units: page geometry in pt, elevations in ft. ft_per_pt converts plan
distance; volumes report in cubic yards (ft^3 / 27).
"""

import re
from dataclasses import dataclass, field

import numpy as np
from scipy.interpolate import LinearNDInterpolator
from scipy.spatial import cKDTree

from .chain import _sample_polyline


@dataclass
class Surface:
    name: str
    contours: list = field(default_factory=list)  # (pts Nx2 pt-space, z_ft)
    points: list = field(default_factory=list)    # (x_pt, y_pt, z_ft) spot grades

    def interpolator(self, step_pt: float = 6.0):
        xs, zs = [], []
        for pts, z in self.contours:
            s, _ = _sample_polyline(np.asarray(pts, float), step=step_pt,
                                    max_n=250000)
            if len(s):
                xs.append(s)
                zs.append(np.full(len(s), float(z)))
        # spot grades are single points, not polylines: a surveyed FG/TS/TW
        # elevation at one location. On detailed grading sheets they vastly
        # outnumber labelled contours (Barn C3.4: 45 spot grades vs 2 labelled
        # contours), so a TIN built from them is often the ONLY surface the
        # sheet can give.
        if self.points:
            P2 = np.asarray([[float(x), float(y)] for x, y, _ in self.points],
                            dtype=float)
            xs.append(P2)
            zs.append(np.asarray([float(z) for _, _, z in self.points],
                                 dtype=float))
        if not xs:
            return None, None
        P = np.vstack(xs)
        Z = np.concatenate(zs)
        if len(P) < 3:
            return None, None
        return LinearNDInterpolator(P, Z), P


def cut_fill(existing: Surface, proposed: Surface, ft_per_pt: float,
             cell_ft: float = 2.0, existing_offset_ft: float = 0.0,
             proposed_offset_ft: float = 0.0,
             return_grid: bool = False) -> dict:
    """Grid-integrate (proposed - existing) where both TINs are defined.

    Offsets LOWER a surface before differencing (z - offset). The client's
    workflow (Beaumont, F52): strip topsoil first - a thickness from the
    soils report, never on the plans - so the existing ground the cut/fill
    starts from is that much lower; remove named layers (asphalt, road
    base) the same way. On the proposed side the sheet draws finish grade
    but the dig stops at subgrade under the pavement stack, so the proposed
    surface drops by that stack. Lowering existing by e and proposed by p
    shifts every dz by (e - p): net_yd3 moves by exactly area * (e - p) / 27.

    return_grid=True adds "grid": the full dz array (NaN where either TIN
    is undefined), the "ok" mask, and the grid's origin / cell size in page
    pt so a caller can paint a cut/fill map registered to the sheet. The
    default call path (offsets 0, no grid) returns exactly what it always
    did - same keys, same numbers.
    """
    fe, pe = existing.interpolator()
    fp, pp = proposed.interpolator()
    if fe is None or fp is None:
        return {"error": "each surface needs at least one labeled contour "
                         "(and 3+ sample points)"}
    lo = np.maximum(pe.min(axis=0), pp.min(axis=0))
    hi = np.minimum(pe.max(axis=0), pp.max(axis=0))
    if (hi <= lo).any():
        return {"error": "the two surfaces do not overlap in plan"}
    cell_pt = cell_ft / ft_per_pt
    nx = max(int((hi[0] - lo[0]) / cell_pt), 1)
    ny = max(int((hi[1] - lo[1]) / cell_pt), 1)
    # cap the grid so a giant sheet cannot stall the service; widen cells
    while nx * ny > 4_000_000:
        cell_pt *= 1.5
        cell_ft *= 1.5
        nx = max(int((hi[0] - lo[0]) / cell_pt), 1)
        ny = max(int((hi[1] - lo[1]) / cell_pt), 1)
    gx = lo[0] + (np.arange(nx) + 0.5) * cell_pt
    gy = lo[1] + (np.arange(ny) + 0.5) * cell_pt
    GX, GY = np.meshgrid(gx, gy)
    ze = fe(GX, GY)
    zp = fp(GX, GY)
    ok = ~(np.isnan(ze) | np.isnan(zp))
    if not ok.any():
        return {"error": "surfaces overlap in plan but their TINs do not"}
    # guarded so the zero-offset path is the exact expression it always was
    if existing_offset_ft:
        ze = ze - float(existing_offset_ft)
    if proposed_offset_ft:
        zp = zp - float(proposed_offset_ft)
    dz_grid = zp - ze
    dz = dz_grid[ok]
    cell_area_ft2 = cell_ft * cell_ft
    fill_ft3 = float(dz[dz > 0].sum() * cell_area_ft2)
    cut_ft3 = float(-dz[dz < 0].sum() * cell_area_ft2)
    out = {
        "cut_yd3": round(cut_ft3 / 27.0, 1),
        "fill_yd3": round(fill_ft3 / 27.0, 1),
        "net_yd3": round((fill_ft3 - cut_ft3) / 27.0, 1),
        "area_sf": round(float(ok.sum()) * cell_area_ft2, 0),
        "cell_ft": round(cell_ft, 2),
        "existing_contours": len(existing.contours),
        "proposed_contours": len(proposed.contours),
    }
    if return_grid:
        # row i / col j of dz covers page-pt box
        #   [x0 + j*cell_pt, x0 + (j+1)*cell_pt] x [y0 + i*cell_pt, ...]
        # (samples sit at the cell centres), so an nx-by-ny image placed at
        # bbox registers to the sheet without a half-cell shift
        out["grid"] = {
            "dz": np.where(ok, dz_grid, np.nan),
            "ok": ok,
            "x0_pt": float(lo[0]), "y0_pt": float(lo[1]),
            "cell_pt": float(cell_pt), "nx": int(nx), "ny": int(ny),
            "bbox_pt": [float(lo[0]), float(lo[1]),
                        float(lo[0] + nx * cell_pt),
                        float(lo[1] + ny * cell_pt)],
        }
    return out


def render_cut_fill_map(grid: dict) -> tuple[bytes, dict]:
    """Paint a dz grid as an RGBA PNG: cut (dz < 0) blue, fill (dz > 0)
    yellow-orange, |dz| -> alpha 0.15..0.75, undefined cells transparent.

    Colour convention is the client's (Beaumont: "cut blue, fill yellow"),
    not an industry standard. Alpha saturates at the 95th percentile of
    |dz| so one deep pad corner does not wash out the rest of the map;
    the reference depth is returned so a legend can say what full
    opacity means.
    """
    import io

    from PIL import Image

    dz = np.asarray(grid["dz"], float)
    ok = np.asarray(grid["ok"], bool)
    mag = np.abs(np.where(ok, dz, 0.0))
    # below a millimetre is TIN floating-point noise, not earth: leave clear
    EPS = 0.003
    nz = mag[ok & (mag > EPS)]
    ref = float(np.percentile(nz, 95)) if nz.size else 1.0
    if ref <= EPS:
        ref = 1.0
    t = np.clip(mag / ref, 0.0, 1.0)
    alpha = np.where(ok & (mag > EPS), 0.15 + 0.60 * t, 0.0)
    H, W = dz.shape
    rgba = np.zeros((H, W, 4), np.uint8)
    cut = ok & (dz < -EPS)
    fill = ok & (dz > EPS)
    rgba[cut] = (30, 100, 255, 0)       # blue
    rgba[fill] = (255, 190, 20, 0)      # yellow-orange
    rgba[..., 3] = np.round(alpha * 255).astype(np.uint8)
    buf = io.BytesIO()
    Image.fromarray(rgba, "RGBA").save(buf, format="PNG")
    meta = {
        "bbox_pt": grid["bbox_pt"], "cell_pt": grid["cell_pt"],
        "nx": grid["nx"], "ny": grid["ny"],
        "ref_dz_ft": round(ref, 3),
        "cut_cells": int(cut.sum()), "fill_cells": int(fill.sum()),
    }
    return buf.getvalue(), meta


def suggest_elevations(chains: list, words: list,
                       max_d_pt: float = 16.0,
                       gap_z: dict | None = None) -> list:
    """Auto-pair elevation-looking labels with the contour they sit on.

    Returns [{chain_id, z, label_xy, dist}] - a SUGGESTION for the review
    UI; the human confirms/edits, per the agreed human-in-loop flow.
    """
    import re

    cands = []
    for w in words:
        t = str(w[4]).strip()
        if re.fullmatch(r"\d{3,4}(\.\d{1,2})?", t):
            v = float(t)
            if 10.0 <= v <= 9999.0:
                cands.append(((w[0] + w[2]) / 2, (w[1] + w[3]) / 2, v))
    if not cands:
        return []
    samples, owner = [], []
    for c in chains:
        # a profile box or the title block is not plan ground - see
        # _NON_PLAN_LAYER. Filtering the sample pool once keeps both the
        # direct match below and the propagation in pass 2 off them.
        if c.length < 60 or not _is_plan_chain(c):
            continue
        s, _ = _sample_polyline(np.asarray(c.pts), step=4.0, max_n=60000)
        if len(s):
            samples.append(s)
            owner += [c.chain_id] * len(s)
    if not samples:
        return []
    tree = cKDTree(np.vstack(samples))
    owner = np.array(owner)
    out, seen = [], {}
    for cx, cy, v in cands:
        d, i = tree.query([cx, cy])
        if d > max_d_pt:
            continue
        cid = int(owner[i])
        # one contour can carry several copies of its label; keep closest
        if cid in seen and seen[cid][0] <= d:
            continue
        seen[cid] = (d, v, cx, cy)
    # gap-OCR labels (see gap_label_elevations) are read out of the chain's
    # own break - the strongest evidence there is; they outrank radius hits
    if gap_z:
        # OCR misreads produce lone impossible values (195 and 861 on a
        # 548-588ft sheet). Real elevations never stand alone: contours
        # step in small intervals and spot grades cluster with them, so a
        # gap-read value with no other elevation within 25ft - when the
        # sheet offers 6+ to compare against - is a misread, not terrain.
        anchor = sorted({s[1] for s in seen.values()}
                        | {v for v, _, _ in gap_z.values()})
        for cid, (v, cx, cy) in gap_z.items():
            cid = int(cid)
            if len(anchor) >= 6:
                near = min((abs(v - a) for a in anchor if a != v),
                           default=0.0)
                if near > 25.0:
                    continue
            if cid not in seen or seen[cid][0] > 0.5:
                seen[cid] = (0.5, v, cx, cy)
    # Pass 2 - propagate along the contour. A long contour splits into
    # several chains at wide gaps, and only the fragment nearest a printed
    # label matches directly (Oncor p4: 29 labeled chains, but each
    # contour's sibling fragments showed nothing on click). End-to-end
    # continuation identifies the same contour: ends within 60pt, each
    # end's outward tangent pointing at the other, and small lateral
    # offset - adjacent PARALLEL contours never meet end-to-end, so a
    # neighbour's elevation cannot leak across. A component whose direct
    # matches disagree keeps only its direct matches (ambiguity is worse
    # than absence).
    ch_ok = [c for c in chains
             if c.length >= 60 and len(c.pts) >= 2 and _is_plan_chain(c)]
    ends, tangs, cid_of = [], [], []
    for c in ch_ok:
        p = np.asarray(c.pts, float)
        for e_i, (end, inner) in enumerate(((p[0], p[min(3, len(p) - 1)]),
                                            (p[-1], p[max(len(p) - 4, 0)]))):
            t = end - inner
            n = float(np.hypot(*t))
            if n < 1e-6:
                t = np.array([1.0, 0.0])
            else:
                t = t / n
            ends.append(end)
            tangs.append(t)
            cid_of.append(int(c.chain_id))
    if ends:
        ends = np.asarray(ends)
        etree = cKDTree(ends)
        parent = {int(c.chain_id): int(c.chain_id) for c in ch_ok}

        def _find(a):
            while parent[a] != a:
                parent[a] = parent[parent[a]]
                a = parent[a]
            return a
        pairs = sorted(map(tuple, etree.query_pairs(60.0)))
        chain_of = {int(c.chain_id): c for c in ch_ok}
        for i, j in pairs:
            if cid_of[i] == cid_of[j]:
                continue
            # A contour continuing itself past a gap keeps its CAD layer and
            # its linetype. Anything that changes either is a different
            # object whose end merely happens to land nearby, and welding it
            # in hands it an elevation it never had: on Guide civil page 3 a
            # BG-L-Riprap rock apron took 7915 as proposed, and an
            # A-GR PATIO chain took 7921 from a label 907 pt away - 126 ft on
            # the ground. Union-find is transitive, so without this guard
            # each 60 pt hop compounds into an unbounded reach.
            ca, cb = chain_of.get(cid_of[i]), chain_of.get(cid_of[j])
            if ca is None or cb is None:
                continue
            if (getattr(ca, "layer", "") or "") != (getattr(cb, "layer", "") or ""):
                continue
            if ca.klass != cb.klass:
                continue
            v = ends[j] - ends[i]
            d = float(np.hypot(*v))
            if d < 1e-6:
                cos_i = cos_j = 1.0
                lat = 0.0
            else:
                u = v / d
                cos_i = float(tangs[i] @ u)
                cos_j = float(tangs[j] @ -u)
                lat = abs(float(tangs[i][0] * v[1] - tangs[i][1] * v[0]))
            if cos_i < 0.86 or cos_j < 0.86 or lat > 5.0:
                continue
            ra, rb = _find(cid_of[i]), _find(cid_of[j])
            if ra != rb:
                parent[ra] = rb
        comp = {}
        for c in ch_ok:
            comp.setdefault(_find(int(c.chain_id)), []).append(int(c.chain_id))
        for members in comp.values():
            zs = {seen[m][1] for m in members if m in seen}
            if len(zs) != 1:
                continue  # unlabeled or conflicting component
            z = zs.pop()
            src = next(m for m in members if m in seen and seen[m][1] == z)
            _, _, cx, cy = seen[src]
            for m in members:
                if m not in seen:
                    seen[m] = (999.0, z, cx, cy)  # dist marks it inherited
    for cid, (d, v, cx, cy) in seen.items():
        out.append({"chain_id": cid, "z": v,
                    "label_xy": [round(cx, 1), round(cy, 1)],
                    "dist": round(float(d), 1)})
    return sorted(out, key=lambda r: r["z"])


def gap_label_elevations(chains: list, page_img: np.ndarray,
                         px_per_pt: float, max_patches: int = 400) -> dict:
    """Read elevation labels printed INSIDE breaks of their own contour.

    Contour elevations sit in a gap of the line, rotated to follow it.
    Native text misses them when the glyphs are exploded to vectors, and
    whole-page OCR misses them because they are rotated (Oncor p4: the
    571-576 labels were found by neither). The chain itself knows both the
    gap's position and its angle, so a small patch per wide gap, rotated
    flat by the line's own direction, reads them.

    Returns {chain_id: (z, cx_pt, cy_pt)}. Chains whose gap labels
    disagree are dropped - ambiguity is worse than absence.
    """
    import re

    try:
        import cv2
        import pytesseract
    except Exception:
        return {}
    H, W = page_img.shape[:2]
    if page_img.ndim == 3:
        gray = cv2.cvtColor(page_img, cv2.COLOR_RGB2GRAY)
    else:
        gray = page_img
    found: dict = {}
    n_patches = 0
    for c in chains:
        if c.length < 60 or len(c.pts) < 3:
            continue
        p = np.asarray(c.pts, float)
        d = np.diff(p, axis=0)
        jump = np.hypot(d[:, 0], d[:, 1])
        pos = jump[jump > 0.5]
        med = float(np.median(pos)) if len(pos) else 0.0
        vals = []
        for i in np.nonzero((jump >= max(18.0, 1.8 * med)) & (jump <= 90.0))[0]:
            if n_patches >= max_patches:
                break
            n_patches += 1
            a, b = p[i], p[i + 1]
            cx, cy = (a + b) / 2
            u = (b - a) / max(float(jump[i]), 1e-6)
            ang = float(np.degrees(np.arctan2(u[1], u[0])))
            if ang > 90:
                ang -= 180
            elif ang <= -90:
                ang += 180
            # crop a square that covers the rotated text box, rotate flat
            w_pt = float(jump[i]) + 36.0
            h_pt = 22.0
            D = int((np.hypot(w_pt, h_pt) + 6) * px_per_pt)
            cxp, cyp = int(cx * px_per_pt), int(cy * px_per_pt)
            x0, y0 = max(cxp - D // 2, 0), max(cyp - D // 2, 0)
            crop = gray[y0:y0 + D, x0:x0 + D]
            if crop.size == 0:
                continue
            M = cv2.getRotationMatrix2D((cxp - x0, cyp - y0), ang, 1.0)
            rot = cv2.warpAffine(crop, M, (crop.shape[1], crop.shape[0]),
                                 borderValue=255)
            bw = int(w_pt * px_per_pt / 2)
            bh = int(h_pt * px_per_pt / 2)
            mx, my = cxp - x0, cyp - y0
            patch = rot[max(my - bh, 0):my + bh, max(mx - bw, 0):mx + bw]
            if patch.size == 0:
                continue
            try:
                txt = pytesseract.image_to_string(
                    patch,
                    config="--psm 7 -c tessedit_char_whitelist=0123456789.",
                ).strip().strip(".")
            except Exception:
                continue
            if re.fullmatch(r"\d{3,4}(\.\d{1,2})?", txt):
                v = float(txt)
                if 10.0 <= v <= 9999.0:
                    vals.append((v, float(cx), float(cy)))
        if vals:
            zs = {v for v, _, _ in vals}
            if len(zs) == 1:
                found[int(c.chain_id)] = vals[0]
    return found


# --- spot grades: the elevations a grading sheet actually prints ----------

# The grade type printed before the value. FG finish grade, FIN finished
# floor, TS/BS top/bottom of step or stair, TW/BW top/bottom of wall,
# EG existing grade, TC top of curb, RIM structure rim, INV invert,
# ME match existing, HP/LP high/low point. Verified against the Beaumont
# SWR sheets 2026-08-21; the list is the sheet's own vocabulary, not a
# guess (each appears with a colon and a value to its right).
# Layers that are not plan ground. A profile or section box is a DIFFERENT
# VIEW drawn on the same sheet: its axes are elevation-against-station, not
# plan position, so a "contour" found inside one is grid, not ground - and
# its station lines get handed elevations off nearby pipe-invert numbers.
# Title-block layers carry sheet metadata; the sheet DATE reads as a clean
# four-digit elevation. Measured on Beaumont Guide civil engine page index 3:
# 18 of 51 suggestions sat on C-ROAD-PROF-VIEW and one (2026, the date) on
# G-ANNO-TTLB-THIN, and 18 of the 23 PROPOSED contours were profile geometry.
# Rejecting on the interval alone does not work - 7 of those 18 carry a clean
# whole-foot value.
# The tokens are read off the layer names in Beaumont's Guide and Barn civil
# sets. That they carry the same meaning under other CAD layer standards is
# an INFERENCE, not something these sheets establish.
_NON_PLAN_LAYER = re.compile(
    r"(?i)(?:^|[-_|\s])(PROF|PROFILE|SECT|SECTION|TTLB|TITLEBLOCK)(?:[-_|\s]|$)")


def _is_plan_chain(c) -> bool:
    """False for chains that live in a non-plan view or in the title block."""
    return not _NON_PLAN_LAYER.search(getattr(c, "layer", "") or "")


_SPOT_TAG = re.compile(r"^(FG|FIN|TS|BS|TW|BW|EG|FF|TC|RIM|INV|ME|HP|LP)\s*:?$", re.I)
# EXISTING-ground tags. Everything else describes the built surface.
_SPOT_EXISTING = {"EG", "ME"}
_SPOT_VALUE = re.compile(r"^\d{1,4}(\.\d{1,2})?$")
_FULL_ELEV = re.compile(r"^\d{3,4}$")


def read_spot_grades(words: list, max_dx: float = 26.0,
                     row_tol: float = 6.0) -> list:
    """Spot elevations printed as `FG: 15.96` / `TW: 7918.60`.

    Civil sheets abbreviate: the value carries only the last two digits and
    the hundreds come from the nearest full contour label (`7715` written in
    a break in its own contour). Beaumont's own sheets do this everywhere -
    125 spot grades on C3.1 alone - and none of them match the 3-4-digit
    pattern `suggest_elevations` looks for, so the whole population was
    invisible.

    Resolving the hundreds needs care, because a sheet is full of other
    4-digit numbers - the DATE (2026) and the legend's own sample text
    (7900) both look like contour labels. Rule, measured on the Beaumont
    sheets:
      1. value already >= 1000 -> a full elevation, use as printed;
      2. otherwise find the page DATUM by consensus. A real contour label's
         own last two digits must fall inside the spread of the spot values
         (a labelled contour sits at an elevation the spot grades cover),
         and at least TWO surviving labels must agree on the same hundreds
         band. That kills the date (one lone 20xx) and the legend 7900
         (its last two digits, 00, sit outside the 12-31 spread). The
         hundreds then come from the nearest label in that band, choosing
         the multiple of 100 that lands closest to it - so 15.96 near 7715
         gives 7715.96, and 98.20 near 7700 gives 7698.20.
      3. no credible datum -> z is None and resolved is False. The caller
         asks the human for the datum; we never invent one. (Barn C3.1
         prints 125 spot grades and NO usable contour label - one typed
         number unlocks the whole sheet.)

    words: (x0, y0, x1, y1, text) in the SAME space as chain geometry -
    pass takeoff_engine.extract.page_words(page), not page.get_text("words"),
    or rotated sheets silently mis-place every grade.

    Returns [{tag, value, z, base, x, y, resolved}].
    """
    ws = [w for w in words if str(w[4]).strip()]
    raw_anchors = [((w[0] + w[2]) / 2, (w[1] + w[3]) / 2, float(w[4]))
                   for w in ws if _FULL_ELEV.fullmatch(str(w[4]).strip())]
    out = []
    for w in ws:
        t = str(w[4]).strip()
        m = _SPOT_TAG.match(t)
        if not m:
            continue
        tag = m.group(1).upper()
        cy = (w[1] + w[3]) / 2
        best = None
        for v in ws:
            if v is w:
                continue
            if abs(((v[1] + v[3]) / 2) - cy) > row_tol:
                continue
            dx = v[0] - w[2]
            if not (-2.0 < dx < max_dx):
                continue
            if not _SPOT_VALUE.fullmatch(str(v[4]).strip()):
                continue
            if best is None or dx < best[0]:
                best = (dx, v)
        if best is None:
            continue
        val = float(best[1][4])
        x = (w[0] + best[1][2]) / 2
        y = cy
        out.append({"tag": tag, "value": val, "x": round(float(x), 1),
                    "y": round(float(y), 1),
                    "side": "existing" if tag in _SPOT_EXISTING else "proposed"})

    # --- page datum by consensus (see the docstring) ---
    partial = [g["value"] for g in out if g["value"] < 1000.0]
    anchors = []
    if partial:
        vlo, vhi = min(partial), max(partial)
        for ax, ay, av in raw_anchors:
            if vlo - 15.0 <= (av % 100.0) <= vhi + 15.0:
                anchors.append((ax, ay, av))
    bands = {}
    for a in anchors:
        bands.setdefault(int(a[2] // 100), []).append(a)
    band = max(bands.values(), key=len) if bands else []
    if len(band) < 2:
        band = []          # one lone number is not a datum

    for g in out:
        val = g["value"]
        if val >= 1000.0:
            g.update(z=val, base=None, resolved=True)
        elif band:
            ax, ay, av = min(band, key=lambda a: (a[0] - g["x"]) ** 2
                                                 + (a[1] - g["y"]) ** 2)
            k = round((av - val) / 100.0)
            g.update(z=val + 100.0 * k, base=av, resolved=True)
        else:
            g.update(z=None, base=None, resolved=False)
    return out
