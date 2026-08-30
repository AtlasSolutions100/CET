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


def _points_in_poly(GX, GY, poly):
    """Vectorised even-odd (ray casting) test over a whole grid.

    Even-odd rather than winding: a limit-of-work line drawn as a single ring
    is the normal case, and even-odd also does the right thing for a figure
    that doubles back on itself, which a hand-traced boundary sometimes does.
    Written against the grid in one pass - a per-cell Python loop over a
    4-million-cell grid would take minutes.
    """
    x = GX.ravel()
    y = GY.ravel()
    inside = np.zeros(x.shape, dtype=bool)
    n = len(poly)
    j = n - 1
    for i in range(n):
        xi, yi = poly[i]
        xj, yj = poly[j]
        # does the horizontal ray from (x, y) cross edge j->i ?
        straddles = (yi > y) != (yj > y)
        if straddles.any():
            # x of the edge at this y; guard the horizontal edge
            dy = (yj - yi) or 1e-12
            xcross = (xj - xi) * (y - yi) / dy + xi
            inside ^= straddles & (x < xcross)
        j = i
    return inside.reshape(GX.shape)


def cut_fill(existing: Surface, proposed: Surface, ft_per_pt: float,
             cell_ft: float = 2.0, existing_offset_ft: float = 0.0,
             proposed_offset_ft: float = 0.0,
             return_grid: bool = False,
             boundary: "list | None" = None) -> dict:
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

    boundary is the LIMIT OF WORK: a polygon in page pt, outside which no
    volume is counted. Without it the region integrated over is wherever BOTH
    TINs are defined - which is the intersection of the two surfaces' convex
    hulls, and a hull bulges anywhere the graded area is concave or the
    contours sprawl. Two clients reported the same consequence independently:
    Jason Knudson asked "can we boundary these?" of a 172,094 CY read, and on
    a 600-acre mass-grading sheet Josh Stice scored us against his own takeoff
    at cut 2.1M vs his 2.2M (close) but fill 2.6M vs his 1.6M - "it's filling
    all that stuff outside" - and pointed at the grading-limit line the sheet
    already draws.

    Passing None is not a special case that is merely handled; it is the
    original code path untouched, so every existing number is unchanged.
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
    if boundary is not None:
        poly = np.asarray(boundary, dtype=float)
        if poly.ndim != 2 or poly.shape[0] < 3 or poly.shape[1] != 2:
            return {"error": "the boundary needs at least 3 points, each [x, y] "
                             "in page points"}
        inside = _points_in_poly(GX, GY, poly)
        if not (ok & inside).any():
            return {"error": "no part of the graded surface falls inside that "
                             "boundary - check it is the limit-of-work line and "
                             "not a detail or a legend box"}
        ok = ok & inside
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
        # Stated so a reader of the export can tell a site-wide figure from a
        # figure clipped to a limit of work. Silence would make the two
        # indistinguishable, which is the whole defect this argument fixes.
        "boundary_applied": boundary is not None,
        "boundary_points": (len(boundary) if boundary is not None else 0),
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


# --- material balance: export / reuse / import ---------------------------
#
# The estimator's second question, after "how much moves?": how much LEAVES,
# how much gets REUSED, how much must be BOUGHT. Beaumont, 2026-08-21
# transcript line 186 - HIS words, not the interviewer's: "in a building or
# something, I can't reuse that top soil. So, yeah, now I need to know,
# structural dirt wise, what I can use to replace that."
#
# Their vocabulary is EXPORT and IMPORT (Estimate #853 line items; bid-sheet
# exclusion 23, "All import and export is subject to loading and knock down
# fee's"). Deliberately NOT "haul off": that phrasing came from the
# interviewer, and exclusion 6 ("Topsoil and fill material required fro the
# job will be stockpiled onsite") plus the "On site" suffix on both #853
# balance lines show their export frequently never leaves the property.
# Hence the per-row destination note, defaulting to "on site".
#
# Every default below is measured against Beaumont Estimate #853 (SWR Barn
# Residence, 4/29/2026) - their own priced takeoff, not an industry prior:
#
#     Strip Topsoil        5,730 CYD     Site Cut            5,551 CYD
#     Rough Place Topsoil  2,865 CYD     Site Fill          17,123 CYD
#     Export Topsoil       2,865 CYD     Import Structural  11,581 CYD
#
#   * 2,865 + 2,865 = 5,730 exactly. The strip splits between respread and
#     export - but that split is the estimator's judgement (soils report,
#     landscape area), so NO default is seeded for it. #853's exact 50/50 is
#     a fact about that job, not a rule.
#   * 17,123 - 5,551 = 11,572 against their 11,581: a 9 CYD / 0.078%
#     residual. Two consequences, both measurements:
#       - site cut IS reused against site fill 1:1, so cut_reuse_pct
#         defaults to 100 - the only defaulted assumption here;
#       - NO swell / shrink / compaction factor is applied anywhere. A
#         factor would put tens of percent between those two numbers, not
#         0.078%. export_factor / import_factor therefore default to 1.0 and
#         exist only so a user whose job needs one can type it. Volumes are
#         in-place yards measured between two surfaces; this module does not
#         convert between in-place, loose and compacted volume, because
#         #853 does not.
#   * Had the stripped topsoil counted as structural reuse, their import
#     would read 11,572 - 5,730 = 5,842. It reads 11,581 - so #853 confirms
#     line 186 as a NUMBER. Removal layers therefore default to 100% export.
#
# The 9 CYD residual is an OPEN QUESTION for the client, not an assumption.

_BALANCE_UNIT = "CY"
# #853 writes CYD. The app writes CY on every existing earthwork row and CY
# is the commoner abbreviation, so one client's house style does not get to
# churn the whole app; revisit as a per-client display preference.


def clamp_pct(v, default: float = 0.0) -> float:
    """A percentage the UI may hand us blank, negative or over 100."""
    try:
        p = float(v)
    except (TypeError, ValueError):
        return default
    if p != p:                      # NaN
        return default
    return min(max(p, 0.0), 100.0)


def material_balance(cut_yd3: float, fill_yd3: float, layers: list,
                     cut_reuse_pct: float = 100.0,
                     export_factor: float = 1.0,
                     import_factor: float = 1.0,
                     cut_area_sf: float | None = None,
                     layer_area_sf: float | None = None) -> dict:
    """Split the computed volumes into export / reuse / import.

        reuse_pool  = cut x cut_reuse%  +  SUM(layer x layer.reuse%)
        fill_demand = fill
        reuse       = min(reuse_pool, fill_demand)
        import      = fill_demand - reuse       -> "Import Structural"
        surplus     = reuse_pool  - reuse       -> "Export Surplus Cut"
        per layer:  volume x export%            -> "Export <name>"
                    volume x respread%          -> "Rough Place <name>"

    `layers` is the list `_earthwork_run` already builds - each
    {name, side, thickness_in, volume_yd3} plus the UI's reuse_pct /
    respread_pct / destination.

    Returns the summary plus `rows`, ready to become takeoff line items.
    """
    cut = max(float(cut_yd3 or 0.0), 0.0)
    fill = max(float(fill_yd3 or 0.0), 0.0)
    cut_reuse = clamp_pct(cut_reuse_pct, 100.0)
    try:
        ef = max(float(export_factor), 0.0) or 1.0
    except (TypeError, ValueError):
        ef = 1.0
    try:
        imf = max(float(import_factor), 0.0) or 1.0
    except (TypeError, ValueError):
        imf = 1.0

    def r1(v: float) -> float:
        return round(float(v), 1)

    removals = []
    for lay in layers or []:
        # TRAP 2 - PROPOSED LAYERS MUST NOT ENTER THE BALANCE. The proposed
        # stack (road base, paving) LOWERS the proposed surface in cut_fill,
        # so fill_yd3 is fill to SUBGRADE and that stack sits on top of it,
        # already priced as its own "Place <name>" row. Adding it to
        # fill_demand double-counts it; treating it as site dirt is worse -
        # nobody backfills a driveway section with the spoil pile.
        if str(lay.get("side")) != "existing":
            continue
        vol = max(float(lay.get("volume_yd3") or 0.0), 0.0)
        reuse_p = clamp_pct(lay.get("reuse_pct"), 0.0)
        respread_p = clamp_pct(lay.get("respread_pct"), 0.0)
        if reuse_p + respread_p > 100.0:     # UI clamps, but never trust it
            respread_p = max(100.0 - reuse_p, 0.0)
        export_p = max(100.0 - reuse_p - respread_p, 0.0)
        removals.append({
            "name": str(lay.get("name") or "layer"),
            "volume_yd3": vol,
            "reuse_pct": reuse_p, "respread_pct": respread_p,
            "export_pct": export_p,
            "destination": str(lay.get("destination") or "on site")[:40],
            "offer_yd3": r1(vol * reuse_p / 100.0),
            "used_yd3": 0.0,
        })

    # TRAP 1 - fill_yd3 ALREADY CONTAINS THE TOPSOIL REPLACEMENT. cut_fill()
    # lowers the existing surface by the strip thickness, which shifts every
    # dz by (e - p), so stripping a foot raises fill by a foot across the
    # overlap. That IS Beaumont's "structural dirt to replace that" and it is
    # already inside this number. Do not add the strip volume to fill_demand.
    fill_demand = fill

    # Round FIRST, then subtract, so the arithmetic an estimator reads off
    # the panel closes exactly instead of drifting a tenth.
    cut_r, demand_r = r1(cut), r1(fill_demand)
    cut_offer_r = r1(cut_r * cut_reuse / 100.0)
    pool_r = r1(cut_offer_r + sum(rm["offer_yd3"] for rm in removals))
    reuse_r = min(pool_r, demand_r)
    import_r = r1(demand_r - reuse_r)
    surplus_r = r1(pool_r - reuse_r)

    # Draw the reuse from the site cut first, then from any removal layer the
    # estimator marked reusable, in list order. The ordering only bites when a
    # removal layer is ALSO marked reusable; otherwise the cut is the only
    # thing in the pool, which is #853's shape and the ordinary case. "Cut
    # first" is an INFERENCE (it is already in the machine and already being
    # moved), not a rule Beaumont stated - it is on the open-questions list.
    cut_used_r = min(cut_offer_r, reuse_r)
    left = r1(reuse_r - cut_used_r)
    for rm in removals:
        rm["used_yd3"] = min(rm["offer_yd3"], left)
        left = r1(left - rm["used_yd3"])
    # Cut that is NOT reused has to leave: the part the estimator never
    # offered (cut_reuse_pct < 100) plus the offered part fill did not need.
    # Dropping the un-offered part would delete real truckloads from the bid.
    cut_export_r = r1(cut_r - cut_used_r)

    cut_area = float(cut_area_sf) if cut_area_sf else None
    lay_area = float(layer_area_sf) if layer_area_sf else None
    rows = []
    for rm in removals:
        # "Export Topsoil" and "Rough Place Topsoil" are #853's own line
        # names and fall out of a layer named Topsoil. "Export <anything
        # else>" follows the same shape and is an INFERENCE, exactly like the
        # existing "Remove <name>" / "Place <name>" rows.
        # what this layer exports = the share never offered for reuse, plus
        # any offered share the fill did not actually need
        spare = r1(rm["offer_yd3"] - rm["used_yd3"])
        base = r1(rm["volume_yd3"] * rm["export_pct"] / 100.0)
        if base + spare > 0:
            q = r1((base + spare) * ef)
            if q > 0:
                rows.append({
                    "label": f'Export {rm["name"]}'.strip(),
                    "qty": q, "unit": _BALANCE_UNIT, "kind": "export",
                    "basis": f'{r1(rm["volume_yd3"]):,} CY x '
                             f'{rm["export_pct"]:g}% export'
                             + (f' + {spare:,} CY offered but not needed'
                                if spare > 0 else '')
                             + (f' x {ef:g}' if ef != 1.0 else ''),
                    "area_sf": lay_area, "area_source": "layer area",
                    "destination": rm["destination"],
                })
        if rm["respread_pct"] > 0:
            q = r1(rm["volume_yd3"] * rm["respread_pct"] / 100.0)
            if q > 0:
                rows.append({
                    "label": f'Rough Place {rm["name"]}'.strip(),
                    "qty": q, "unit": _BALANCE_UNIT, "kind": "respread",
                    "basis": f'{r1(rm["volume_yd3"]):,} CY x '
                             f'{rm["respread_pct"]:g}% respread',
                    "area_sf": lay_area, "area_source": "layer area",
                    "destination": rm["destination"],
                })
    if cut_export_r > 0:
        # PROVISIONAL NAME - not Beaumont's. #853's nearest line is
        # "Allowances- Export rocks and boulders to lower field". Open
        # question: what do they call surplus cut?
        q = r1(cut_export_r * ef)
        rows.append({
            "label": "Export Surplus Cut", "qty": q, "unit": _BALANCE_UNIT,
            "kind": "export",
            "basis": f'site cut {cut_r:,} CY - reused {cut_used_r:,} CY'
                     + (f' (only {cut_reuse:g}% offered for reuse)'
                        if cut_reuse < 100.0 else '')
                     + (f' x {ef:g}' if ef != 1.0 else ''),
            "area_sf": cut_area, "area_source": "cut/fill area",
            "destination": "on site",
        })
    if import_r > 0:
        q = r1(import_r * imf)
        rows.append({
            "label": "Import Structural", "qty": q, "unit": _BALANCE_UNIT,
            "kind": "import",
            "basis": f'fill {demand_r:,} CY - reused {reuse_r:,} CY'
                     + (f' x {imf:g}' if imf != 1.0 else ''),
            "area_sf": cut_area, "area_source": "cut/fill area",
            "destination": "on site",
        })

    export_total = r1(sum(r["qty"] for r in rows if r["kind"] == "export"))
    return {
        "reuse_pool_yd3": pool_r,
        "fill_demand_yd3": demand_r,
        "reuse_yd3": reuse_r,
        "import_yd3": r1(import_r * imf),
        "surplus_yd3": r1(surplus_r * ef),
        # the site cut's own fate, so the panel can show that every yard of
        # it is accounted for even when the estimator says none is reusable
        "cut_yd3": cut_r,
        "cut_reused_yd3": cut_used_r,
        "cut_export_yd3": r1(cut_export_r * ef),
        "export_total_yd3": export_total,
        "respread_total_yd3": r1(sum(r["qty"] for r in rows
                                     if r["kind"] == "respread")),
        "cut_reuse_pct": cut_reuse,
        "export_factor": ef, "import_factor": imf,
        "cut_area_sf": cut_area, "layer_area_sf": lay_area,
        "rows": rows,
        # every volume here is in-place yards between the two surfaces; see
        # the module comment for why no swell/compaction factor is applied
        "basis": "in-place cubic yards; no swell or compaction factor "
                 "applied" if (ef == 1.0 and imf == 1.0) else
                 "in-place cubic yards; user factors applied",
    }


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
    """False for chains that cannot be a contour.

    Two tests, because the layer one is not always available. On Beaumont's
    Guide civil grading sheet ALL plan linework carries an empty CAD layer,
    so a layer guard is vacuous there - but the chainer has already decided
    that a traced numeral is `annotation`, and a contour is linework by
    definition. Measured across Guide civil p2/p3 and Barn civil p3/p6:
    exactly one elevation suggestion sits on an annotation-class chain, and
    it is the printed number "7919" traced off layer C-TOPO-TEXT and handed
    to the TIN as a contour at 7919 ft. Zero other suggestions are touched.
    """
    if getattr(c, "klass", "") == "annotation":
        return False
    return not _NON_PLAN_LAYER.search(getattr(c, "layer", "") or "")


# FL flow line and FFE finished floor elevation were added 2026-08-22: both
# appear in the Beaumont Guide civil legend, and 11 printed labels were being
# skipped for want of them. Same standard of evidence as the rest of the list
# - the sheet's own vocabulary, each printed with a value beside it.
# PE = pad elevation, the finish grade of a building pad. Measured absent
# on 2026-08-30: Stice's Coral Mountain preliminary grading sheet prints
# ~204 "PE 486.0" pad callouts and every one was invisible to this reader
# (out/verify/2026-08-30/stice-recipe/RECIPE.md). A pad elevation is
# PROPOSED ground, like FG.
_SPOT_TAG = re.compile(
    r"^(FG|FIN|FFE|TS|BS|TW|BW|EG|FF|FL|TC|RIM|INV|ME|HP|LP|PE)\s*:?$",
    re.I)
# EXISTING-ground tags. Everything else describes the built surface.
_SPOT_EXISTING = {"EG", "ME"}
_SPOT_VALUE = re.compile(r"^\d{1,4}(\.\d{1,2})?$")
_FULL_ELEV = re.compile(r"^\d{3,4}$")

# One whole PDF text line that IS a spot grade: a tag, an optional colon or
# equals, a value, and an optional foot mark. Anchored at both ends so a line
# carrying anything else cannot match - the point of reading lines is that a
# neighbour's value is on a DIFFERENT line and can no longer be captured.
# The glued form `FIN:05.25'` is the one the sheet's own legend prints as its
# example, and the word-pair reader could never see it.
_SPOT_LINE = re.compile(
    r"^\s*(FG|FIN|FFE|TS|BS|TW|BW|EG|FF|FL|TC|RIM|INV|ME|HP|LP)"
    r"\s*[:=]?\s*(\d{1,4}(?:\.\d{1,2})?)\s*'?\s*$", re.I)
# These sheets DECLARE their datum in the spot-elevation legend:
#   "NOTE: ALL SPOT ELEVATIONS ARE TRUNCATED CIVIL ELEVATIONS
#    (IE. EXAMPLE: TOP OF PATIO @ 7705.25' = FIN:05.25')"
# That single line is worth more than any amount of consensus guessing, and
# it is the sheet's own statement rather than an inference. Barn civil p3
# says 7705.25 (datum 7700) while its labelled contours pushed consensus to
# 7900 - so every one of its 272 spot grades came out exactly 200.00 ft
# high, resolved and confident. Guide civil p2 says 7905.25 and consensus
# happened to agree, which is why the defect hid.
_SPOT_DATUM_LINE = re.compile(
    r"(?i)(?:EXAMPLE|\bIE\b|\bI\.E\.)[^0-9]{0,30}(\d{3,5})\.(\d{1,2})")


def read_spot_datum(lines: list) -> float | None:
    """The hundreds band the sheet's own legend declares, or None.

    Returns e.g. 7700.0 for a legend reading "@ 7705.25'". Only a 3-5 digit
    whole part counts, so a date or a dimension cannot be mistaken for one.
    """
    for ln in (lines or ()):
        m = _SPOT_DATUM_LINE.search(" ".join(str(ln[4]).split()))
        if not m:
            continue
        whole = int(m.group(1))
        if 100 <= whole <= 99999:
            return float(whole // 100 * 100)
    return None


# Two readings of the same tag closer than this are the same printed label.
# The two passes place one label 2.5-3.4 pt apart on Guide civil p2, and the
# nearest genuinely distinct same-tag labels there are far further off, so
# 10 pt separates them with room on both sides.
_SPOT_SAME_R2 = 10.0 ** 2


def read_spot_grades(words: list, max_dx: float = 26.0,
                     row_tol: float = 6.0, lines: list | None = None,
                     datum_info: dict | None = None) -> list:
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
    # Where pass A already read a label, keyed by tag. A grid bucket is the
    # wrong tool here: the two passes place the same label a few points apart
    # (a line's bbox centre against a tag-to-value midpoint), so any bucket
    # edge between them lets the label through twice. Measured on Guide civil
    # p2: 12 labels double-counted at 2.5-3.4 pt apart. A radius test is what
    # the question actually is.
    line_at: dict = {}

    # Pass A - whole PDF text lines. The PDF's own line grouping is
    # rotation-independent, so this reads the labels written up the side of a
    # sheet that a horizontal row window cannot see, and it cannot pair a tag
    # to a neighbour's value because the two are on different lines.
    for ln in (lines or ()):
        t = str(ln[4]).strip()
        m = _SPOT_LINE.match(t)
        if not m:
            continue
        tag = m.group(1).upper()
        x = (ln[0] + ln[2]) / 2.0
        y = (ln[1] + ln[3]) / 2.0
        out.append({"tag": tag, "value": float(m.group(2)),
                    "x": round(float(x), 1), "y": round(float(y), 1),
                    "side": "existing" if tag in _SPOT_EXISTING else "proposed"})
        line_at.setdefault(tag, []).append((x, y))

    # Pass B - the original word-pair reader, for anything the line grouping
    # split (a tag and its value emitted as two lines). Anything already found
    # in pass A is skipped: the line reading is the more trustworthy of the
    # two, because it cannot cross into a neighbouring label.
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
        # Pass A already read this label - keep its reading and drop this one,
        # whatever value this pass arrived at. Pass A is the more trustworthy
        # of the two precisely because a line cannot reach into a neighbour's
        # value, which is how the word reader put 10.36 against a TW: 14.00
        # tag and reported a wall top 3.64 ft out.
        if any((x - px) ** 2 + (y - py) ** 2 <= _SPOT_SAME_R2
               for px, py in line_at.get(tag, ())):
            continue
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

    # The sheet's own declared datum versus the consensus band - and NEITHER
    # always wins, because each has a measured failure on this one plan set:
    #
    #   Barn C3.1 (engine index 3): the note's 7705.25 is RIGHT and the band
    #   is a false [7900] built from the legend's own sample text, two labels
    #   strong. Declared-always-wins was added for this sheet; before it, all
    #   272 spot grades shipped exactly 200 ft high.
    #
    #   Barn C3.3 (engine index 5, printed sheet C3.3): the note reads
    #   "EXAMPLE: TOP OF PATIO @ 7605.25'" - a stale boilerplate value - while
    #   the sheet's own contours print 7720/7725/7730/7735, a four-label band.
    #   Declared-always-wins shipped all 171 spot grades exactly 100 ft LOW,
    #   marked resolved, under a green banner. Same defect on C3.5 and C3.6
    #   (1 grade each).
    #
    # The prefix cannot distinguish them: every datum line in the set, genuine
    # and stale alike, begins "EXAMPLE:" (it is how the legend note is
    # worded). What distinguishes them is BAND STRENGTH. Three or more full
    # elevations printed on the sheet body agreeing with each other outrank
    # one boilerplate legend sentence; a two-label band is exactly the shape a
    # legend echo produces and must not veto the note. Measured on all 15
    # pages of the Barn set: this rule corrects the 3 poisoned pages (173
    # grades fall to their genuine bands) and preserves C3.1's 272.
    #
    # Where the two sources disagree AT ALL, the disagreement is reported, not
    # swallowed - `datum_info["conflict"]` - so the UI can show both numbers
    # and offer the override. A wrong elevation that is visible is survivable;
    # the shipped defect was wrong-and-green with the override hidden.
    declared = read_spot_datum(lines)
    band_base = float(int(band[0][2] // 100) * 100) if band else None
    conflict = (declared is not None and band_base is not None
                and abs(band_base - declared) > 50.0)
    use_declared = declared is not None and not (conflict and len(band) >= 3)
    if datum_info is not None:
        datum_info.update(
            declared=declared, band_base=band_base, band_n=len(band),
            conflict=bool(conflict),
            chosen=("declared" if use_declared and declared is not None
                    else "band" if band else None))

    # A 3-digit spot on a 3-digit site is printed in full, not truncated.
    # Measured 2026-08-30 on Stice's Coral Mountain sheet (site runs
    # 425-521 ft): 191 PE pad elevations print as 466.0-style values and
    # the >= 1000 rule alone left every one unresolved. The truncation
    # convention keeps the LAST TWO digits (Barn: 7705.25' prints as
    # 05.25'), so a value >= 100 is only "full" when the sheet's own full
    # elevations corroborate it - at least two page anchors within 100 ft.
    # A lone 3-digit value on a 7,000-ft sheet still falls through to the
    # datum machinery / honest unresolved.
    full3 = sorted(av for _, _, av in raw_anchors)
    def _corroborated(v):
        import bisect
        i = bisect.bisect_left(full3, v - 100.0)
        j = bisect.bisect_right(full3, v + 100.0)
        return (j - i) >= 2

    for g in out:
        val = g["value"]
        if val >= 1000.0:
            g.update(z=val, base=None, resolved=True)
        elif val >= 100.0 and _corroborated(val):
            g.update(z=val, base=None, resolved=True)
        elif use_declared and val < 100.0:
            g.update(z=declared + val, base=declared, resolved=True)
        elif band:
            ax, ay, av = min(band, key=lambda a: (a[0] - g["x"]) ** 2
                                                 + (a[1] - g["y"]) ** 2)
            k = round((av - val) / 100.0)
            g.update(z=val + 100.0 * k, base=av, resolved=True)
        else:
            g.update(z=None, base=None, resolved=False)
    return out
