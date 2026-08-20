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

from dataclasses import dataclass, field

import numpy as np
from scipy.interpolate import LinearNDInterpolator
from scipy.spatial import cKDTree

from .chain import _sample_polyline


@dataclass
class Surface:
    name: str
    contours: list = field(default_factory=list)  # (pts Nx2 pt-space, z_ft)

    def interpolator(self, step_pt: float = 6.0):
        xs, zs = [], []
        for pts, z in self.contours:
            s, _ = _sample_polyline(np.asarray(pts, float), step=step_pt,
                                    max_n=250000)
            if len(s):
                xs.append(s)
                zs.append(np.full(len(s), float(z)))
        if not xs:
            return None, None
        P = np.vstack(xs)
        Z = np.concatenate(zs)
        if len(P) < 3:
            return None, None
        return LinearNDInterpolator(P, Z), P


def cut_fill(existing: Surface, proposed: Surface, ft_per_pt: float,
             cell_ft: float = 2.0) -> dict:
    """Grid-integrate (proposed - existing) where both TINs are defined."""
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
    dz = (zp - ze)[ok]
    cell_area_ft2 = cell_ft * cell_ft
    fill_ft3 = float(dz[dz > 0].sum() * cell_area_ft2)
    cut_ft3 = float(-dz[dz < 0].sum() * cell_area_ft2)
    return {
        "cut_yd3": round(cut_ft3 / 27.0, 1),
        "fill_yd3": round(fill_ft3 / 27.0, 1),
        "net_yd3": round((fill_ft3 - cut_ft3) / 27.0, 1),
        "area_sf": round(float(ok.sum()) * cell_area_ft2, 0),
        "cell_ft": round(cell_ft, 2),
        "existing_contours": len(existing.contours),
        "proposed_contours": len(proposed.contours),
    }


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
        if c.length < 60:
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
    ch_ok = [c for c in chains if c.length >= 60 and len(c.pts) >= 2]
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
        for i, j in pairs:
            if cid_of[i] == cid_of[j]:
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
