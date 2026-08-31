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
        # The deepest single cell each way, in feet - what the color map's
        # darkest spots ARE. A volume alone hides whether the site moves
        # 2 ft everywhere or 40 ft in one canyon; the extremes are the
        # sanity check an estimator runs by eye against the contours.
        "max_cut_ft": round(float(-dz[dz < 0].min()) if (dz < 0).any() else 0.0, 2),
        "max_fill_ft": round(float(dz[dz > 0].max()) if (dz > 0).any() else 0.0, 2),
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


# --- grading zones: declared design vs detected existing ------------------
#
# The estimator's workflow when the sheet does NOT draw a full proposed
# surface (measured on the Stice case, EXCAVATION-PLAN.md section 25):
# pick a region and DECLARE the design - "pad at 2716.0", "1.5% plane
# falling north", "balance it", "strip 8 inches" - then compute exact
# volumes of that declared design against the detected existing ground.
# Reference UX is the AGTEK-style region workflow.

def _zone_centroid(poly: np.ndarray) -> tuple:
    """Area centroid of a simple polygon (shoelace); falls back to the
    vertex mean when the area is ~zero (degenerate ring)."""
    x, y = poly[:, 0], poly[:, 1]
    xn, yn = np.roll(x, -1), np.roll(y, -1)
    cross = x * yn - xn * y
    a = cross.sum() / 2.0
    if abs(a) < 1e-9:
        return float(x.mean()), float(y.mean())
    cx = ((x + xn) * cross).sum() / (6.0 * a)
    cy = ((y + yn) * cross).sum() / (6.0 * a)
    return float(cx), float(cy)


def zone_cut_fill(existing: Surface, polygon, ft_per_pt: float,
                  design: dict, cell_ft: float = 2.0,
                  strip_in: float = 0.0, label_target: int = 120) -> dict:
    """Volumes of a DECLARED design surface against the detected existing
    ground, inside one polygon (page pt).

    design is one of:
      {mode:"pad", elev_ft}                 constant elevation
      {mode:"plane", elev_ft, slope_pct, azimuth_deg, anchor:[x,y]}
          elev_ft at the anchor (default: polygon centroid), falling
          slope_pct per 100 ft ALONG the azimuth. Azimuth is compass-style
          on the sheet: 0 = up the page, 90 = right, measured clockwise.
          That reads the top of the sheet as north - general drafting
          practice, an INFERENCE, not something any one sheet declares;
          the UI says so next to the input.
      {mode:"balance"}                      bisect a pad elevation until
          |cut - fill| < 0.5 CY; reports the solved elevation and its
          offset from the existing mean.
      {mode:"strip_only"}                   no design surface: cut/fill are
          zero and only the strip term computes.

    strip_in > 0 lowers the EXISTING surface by that many inches before
    differencing (same convention as cut_fill's existing_offset_ft:
    stripped ground starts lower, so the design's fill includes replacing
    that depth) and reports the stripped volume as strip_yd3 = area x
    depth. In strip_only mode nothing is differenced, so strip_yd3 is the
    only volume.

    Returns volumes + a "grid" dict (render_cut_fill_map shape) + coarse
    cell_labels [{x, y, dz}] (<= label_target of them) for the per-cell
    numbers display. {"error": reason} on any refusal - never silent.
    """
    poly = np.asarray(polygon, dtype=float)
    if poly.ndim != 2 or poly.shape[0] < 3 or poly.shape[1] != 2:
        return {"error": "the zone polygon needs at least 3 corners, "
                         "each [x, y] in page points"}
    x, y = poly[:, 0], poly[:, 1]
    area_pt2 = abs(float((x * np.roll(y, -1) - np.roll(x, -1) * y).sum())) / 2.0
    zone_area_sf = area_pt2 * ft_per_pt * ft_per_pt
    if zone_area_sf < 1.0:
        return {"error": f"that zone is degenerate - its corners enclose "
                         f"{zone_area_sf:.3f} SF of ground. Draw a region, "
                         f"not a line."}
    mode = str((design or {}).get("mode") or "")
    if mode not in ("pad", "plane", "balance", "strip_only"):
        return {"error": f"unknown design mode {mode!r} - expected pad, "
                         "plane, balance or strip_only"}
    fe, _pe = existing.interpolator()
    if fe is None:
        return {"error": "the existing surface needs at least 3 sample "
                         "points - assign labelled contours and/or spot "
                         "grades to EXISTING first"}

    cell_ft = float(cell_ft or 2.0)
    if cell_ft <= 0:
        cell_ft = 2.0
    cell_pt = cell_ft / ft_per_pt
    lo = poly.min(axis=0)
    hi = poly.max(axis=0)
    nx = max(int((hi[0] - lo[0]) / cell_pt), 1)
    ny = max(int((hi[1] - lo[1]) / cell_pt), 1)
    # same stall guard as cut_fill: widen cells rather than hang the service
    while nx * ny > 4_000_000:
        cell_pt *= 1.5
        cell_ft *= 1.5
        nx = max(int((hi[0] - lo[0]) / cell_pt), 1)
        ny = max(int((hi[1] - lo[1]) / cell_pt), 1)
    gx = lo[0] + (np.arange(nx) + 0.5) * cell_pt
    gy = lo[1] + (np.arange(ny) + 0.5) * cell_pt
    GX, GY = np.meshgrid(gx, gy)
    inside = _points_in_poly(GX, GY, poly)
    if not inside.any():
        return {"error": "the zone is smaller than one grid cell at "
                         f"{cell_ft:g} ft cells - draw it larger"}
    ze = fe(GX, GY)
    ok = inside & ~np.isnan(ze)
    if not ok.any():
        return {"error": "the existing surface does not reach this zone - "
                         "the TIN built from the assigned contours and spot "
                         "grades is undefined everywhere inside it. Assign "
                         "elevations nearer the zone, or move it."}
    existing_mean = float(ze[ok].mean())
    try:
        strip_ft = max(float(strip_in or 0.0), 0.0) / 12.0
    except (TypeError, ValueError):
        strip_ft = 0.0
    zs = ze - strip_ft          # existing AFTER the strip comes off
    cell_area_ft2 = cell_ft * cell_ft

    def _vols(dz_arr):
        d = dz_arr[ok]
        fill3 = float(d[d > 0].sum() * cell_area_ft2)
        cut3 = float(-d[d < 0].sum() * cell_area_ft2)
        return cut3, fill3

    balance_elev = None
    if mode == "pad":
        try:
            elev = float(design["elev_ft"])
        except (KeyError, TypeError, ValueError):
            return {"error": "pad mode needs elev_ft, the pad's finish "
                             "elevation in feet"}
        zp = np.full_like(ze, elev)
        dz = zp - zs
    elif mode == "plane":
        try:
            elev = float(design["elev_ft"])
        except (KeyError, TypeError, ValueError):
            return {"error": "plane mode needs elev_ft, the elevation at "
                             "the anchor point in feet"}
        try:
            slope = float(design.get("slope_pct") or 0.0)
        except (TypeError, ValueError):
            slope = 0.0
        try:
            az = float(design.get("azimuth_deg") or 0.0)
        except (TypeError, ValueError):
            az = 0.0
        anc = design.get("anchor")
        if (isinstance(anc, (list, tuple)) and len(anc) == 2):
            ax, ay = float(anc[0]), float(anc[1])
        else:
            ax, ay = _zone_centroid(poly)
        rad = np.radians(az)
        # page y grows DOWN, so "up the page" (az 0) is -y
        ux, uy = float(np.sin(rad)), -float(np.cos(rad))
        d_ft = ((GX - ax) * ux + (GY - ay) * uy) * ft_per_pt
        zp = elev - (slope / 100.0) * d_ft
        dz = zp - zs
    elif mode == "balance":
        # net = fill - cut is strictly increasing in the pad elevation, so
        # bisection cannot miss; 0.5 CY is the requested tolerance
        lo_e = float(zs[ok].min()) - 1.0
        hi_e = float(zs[ok].max()) + 1.0
        mid = (lo_e + hi_e) / 2.0
        for _ in range(80):
            mid = (lo_e + hi_e) / 2.0
            cut3, fill3 = _vols(np.full_like(ze, mid) - zs)
            if abs(cut3 - fill3) / 27.0 < 0.5:
                break
            if fill3 > cut3:
                hi_e = mid
            else:
                lo_e = mid
        balance_elev = mid
        dz = np.full_like(ze, mid) - zs
    else:  # strip_only: no design surface, volumes only from the strip term
        dz = np.zeros_like(ze)

    cut_ft3, fill_ft3 = _vols(dz)
    d = dz[ok]
    area_sf = float(ok.sum()) * cell_area_ft2
    strip_yd3 = area_sf * strip_ft / 27.0
    coverage = float(ok.sum()) / float(inside.sum())

    # coarse labels: aggregate the fine grid into <= label_target blocks,
    # each labelled with the MEAN dz of its defined cells and positioned at
    # their centroid (so a label on the zone's edge still sits inside it)
    k = 1
    if nx * ny > label_target:
        k = int(np.ceil(np.sqrt(nx * ny / float(label_target))))
        while ((nx + k - 1) // k) * ((ny + k - 1) // k) > label_target:
            k += 1
    labels = []
    dz_ok = np.where(ok, dz, np.nan)
    for bi in range(0, ny, k):
        for bj in range(0, nx, k):
            blk = dz_ok[bi:bi + k, bj:bj + k]
            m = ~np.isnan(blk)
            if not m.any():
                continue
            sub_ok = ok[bi:bi + k, bj:bj + k]
            xs = GX[bi:bi + k, bj:bj + k][sub_ok]
            ys = GY[bi:bi + k, bj:bj + k][sub_ok]
            labels.append({"x": round(float(xs.mean()), 1),
                           "y": round(float(ys.mean()), 1),
                           "dz": round(float(blk[m].mean()), 1)})

    out = {
        "mode": mode,
        "cut_yd3": round(cut_ft3 / 27.0, 1),
        "fill_yd3": round(fill_ft3 / 27.0, 1),
        "net_yd3": round((fill_ft3 - cut_ft3) / 27.0, 1),
        "area_sf": round(area_sf, 0),
        "zone_area_sf": round(zone_area_sf, 0),
        # < 1.0 whenever the existing TIN stops short of the polygon: the
        # volumes cover only the defined share, and the caller must say so
        "coverage": round(coverage, 3),
        "max_cut_ft": round(float(-d[d < 0].min()) if (d < 0).any() else 0.0, 2),
        "max_fill_ft": round(float(d[d > 0].max()) if (d > 0).any() else 0.0, 2),
        "existing_mean_ft": round(existing_mean, 2),
        "existing_n_contours": len(existing.contours),
        "existing_n_spots": len(existing.points),
        "strip_in": round(strip_ft * 12.0, 2),
        "strip_yd3": round(strip_yd3, 1),
        "cell_ft": round(cell_ft, 2),
        "cell_labels": labels,
        "grid": {
            "dz": dz_ok,
            "ok": ok,
            "x0_pt": float(lo[0]), "y0_pt": float(lo[1]),
            "cell_pt": float(cell_pt), "nx": int(nx), "ny": int(ny),
            "bbox_pt": [float(lo[0]), float(lo[1]),
                        float(lo[0] + nx * cell_pt),
                        float(lo[1] + ny * cell_pt)],
        },
    }
    if balance_elev is not None:
        out["balance_elev_ft"] = round(balance_elev, 2)
        out["balance_delta_ft"] = round(balance_elev - existing_mean, 2)
    return out


# ---- label-in-gap machinery ----------------------------------------------
# Contour elevation labels sit in a BREAK of their own line, or over a white
# mask stroke painted along it. Both are located from the vector geometry.
# Constants are measured on Oncor Cloudcrest C-04 (engine page index 3 =
# printed C-04), whose 27 existing + 20 proposed labels are hand-verified in
# out/verify/2026-08-31/oncor-c04-offline/report.json. Each states its
# measurement; a value from one sheet is a sample, not a convention, so the
# spans are chosen between measured populations, not at their edges.

# A gap step: a polyline jump big enough to be part of a label break.
# C-04's label breaks decompose into sub-gaps of 9.8-35.2 pt (tiny glyph
# stubs welded into the chain split them); the largest NON-label jump that
# must not trigger is the existing contours' own 9.0 pt dash gap. 9.5 sits
# between the two measured populations. The floor also scales with the
# chain's own median jump (x1.3): a smooth curve digitised at ~11 pt
# vertex spacing (C-04 chain 813) otherwise reads as one endless "break".
# 1.3 is bounded above by the existing d18/g9 contours, whose label breaks
# measure down to 17.7 pt against a 13.5 pt median jump (ratio 1.31) - a
# larger factor starts eating real label breaks.
_GAP_STEP_PT = 9.5
_GAP_STEP_MED_FACTOR = 1.3
# Sub-gaps merge across drawn stubs totalling <= 8 pt: real dashes on these
# sheets carry >= 9 pt of ink, welded glyph stubs measured 0.5-6 pt.
_GAP_STUB_PT = 8.0
# A merged break must span 14-110 pt end to end: the narrowest verified C-04
# label break chord is 18.7 pt (14 leaves margin for tighter text) and the
# widest 72.4; 110 tolerates a longer 4-digit-with-decimals label before the
# OCR patch grows useless.
_GAP_SPAN_PT = (14.0, 110.0)
# Ranking span for candidate patches: C-04's 3-digit labels occupy breaks
# centered on ~26 pt; regions closest to this are OCR'd first when a page
# offers more candidates than the budget.
_LABEL_SPAN_PT = 26.0
# Near-white ink is invisible on paper: C-04's mask strokes (sids 44-48)
# are exactly 1.0; the lightest visible screening measured on that sheet is
# 0.7 gray. 0.92 splits the populations.
WHITE_MIN = 0.92
# A mask stroke is FAT white drawn along the line it hides: C-04 masks are
# 3.2 pt wide, white glyph halos 0.1-1.2 pt. 1.5 splits them.
_MASK_WIDTH_MIN = 1.5
# One mask dash covers one label: drawn lengths measured 16-25 pt on C-04's
# ten mask-covered labels (12-60 leaves room for longer labels).
_MASK_SEG_PT = (12.0, 60.0)
# The mask lies ON the chain it hides: mask-center-to-chain distance
# measured 0.1-3.9 pt across those ten labels.
_MASK_DIST_PT = 4.0
# ...and runs along it: |cos| between mask segment and local chain tangent
# measured 0.79-0.97 (the lowest is a curving contour under a straight
# mask). 0.75 keeps that case and still rejects crossing strokes.
_MASK_COS = 0.75
# A native text token whose center sits within half a text-line height of
# the break chord is IN the break; label text on these sheets is 7-10 pt
# tall, so 6 pt covers it without reaching the next contour (~10-15 pt away
# on C-04's tightest strip).
_INLINE_PERP_PT = 6.0
# A native token within this of the polyline is printed ON the line itself -
# the PDF's own glyphs there outrank a raster OCR of the same spot, so a
# gap-OCR value never overrides such a match. Measured: Stice's verified
# on-line labels sit 0.2-1.6 pt from their chain; C-04's stolen spot
# tokens sit 2.1-4.4 pt off it (at 6.0 this guard kept spot 570.3 on
# chain 207 against the OCR's correct 570). 3.0 splits the populations.
_ON_LINE_PT = 3.0


def _chain_white(c) -> bool:
    """Near-white stroke = invisible ink (a mask), never a contour."""
    col = getattr(c, "color", None)
    try:
        return bool(col) and min(col) >= WHITE_MIN
    except (TypeError, ValueError):
        return False


def _gap_regions(p: np.ndarray) -> list:
    """Merged label-sized breaks of one polyline.

    Walks the segment list (a gap test, not a bucket): a region opens at a
    jump >= the chain's gap-step threshold and extends across further such
    jumps while the drawn stubs between them total <= _GAP_STUB_PT. A run
    whose chord outgrows the span cap is SPLIT greedily instead of thrown
    away - discarding it silently lost chain 800's label on C-04 when its
    break merged into a longer run. Returns
    [(cx, cy, ux, uy, span), ...] - chord center, unit direction, length.
    """
    d = np.diff(p, axis=0)
    jump = np.hypot(d[:, 0], d[:, 1])
    pos = jump[jump > 0.5]
    med = float(np.median(pos)) if len(pos) else 0.0
    step = max(_GAP_STEP_PT, _GAP_STEP_MED_FACTOR * med)
    out = []
    n = len(jump)
    runs = []
    i = 0
    while i < n:
        if jump[i] < step:
            i += 1
            continue
        run = [i]
        stub = 0.0
        j = i + 1
        while j < n:
            if jump[j] >= step:
                run.append(j)
                stub = 0.0
            else:
                stub += jump[j]
                if stub > _GAP_STUB_PT:
                    break
            j += 1
        runs.append(run)
        i = run[-1] + 1

    def _chord(a_i, b_i):
        return float(np.hypot(*(p[b_i + 1] - p[a_i])))

    for run in runs:
        s = 0
        while s < len(run):
            e = s
            while e + 1 < len(run) \
                    and _chord(run[s], run[e + 1]) <= _GAP_SPAN_PT[1]:
                e += 1
            a, b = p[run[s]], p[run[e] + 1]
            span = float(np.hypot(*(b - a)))
            if _GAP_SPAN_PT[0] <= span <= _GAP_SPAN_PT[1]:
                u = (b - a) / span
                out.append((float((a[0] + b[0]) / 2),
                            float((a[1] + b[1]) / 2),
                            float(u[0]), float(u[1]), span))
            s = e + 1
        # A LONG run also gets one window per big gap step, centered on
        # the STEP itself with the step's own direction. A run's chord is
        # a straight line, but the break curves: on C-04, chain 805's
        # label sat 13 pt perpendicular to its 58 pt region chord (out of
        # the OCR band) and chain 801's sat past the chord's end after
        # the >110 pt split - both are covered only by walking the actual
        # polyline. 2 * _LABEL_SPAN_PT is where one centered patch stops
        # covering a region's ends; 14 pt is the narrowest verified label
        # break (the span floor).
        if _chord(run[0], run[-1]) > 2 * _LABEL_SPAN_PT:
            for idx in run:
                L = float(jump[idx])
                if L < _GAP_SPAN_PT[0]:
                    continue
                a, b = p[idx], p[idx + 1]
                u = (b - a) / L
                out.append((float((a[0] + b[0]) / 2),
                            float((a[1] + b[1]) / 2),
                            float(u[0]), float(u[1]),
                            float(min(L + 8.0, 1.4 * _LABEL_SPAN_PT))))
    return out


def _label_regions(chains: list, exclude: set | None = None) -> dict:
    """Places where a chain's own elevation label can sit.

    {chain_id: [(kind, cx, cy, ux, uy, span), ...]} with kind 0 = under a
    white mask stroke (strongest: something was deliberately hidden there),
    kind 1 = a merged break of the polyline. Chains in `exclude` (legend
    non-contours, white masks) get no regions - their labels are not
    elevations, and the mask strokes themselves serve only as hints for the
    chains they cover.
    """
    exclude = exclude or set()
    plan = [c for c in chains
            if c.length >= 60 and len(c.pts) >= 3 and _is_plan_chain(c)
            and not _chain_white(c) and int(c.chain_id) not in exclude]
    regions: dict = {}
    for c in plan:
        p = np.asarray(c.pts, float)
        for cx, cy, ux, uy, span in _gap_regions(p):
            regions.setdefault(int(c.chain_id), []).append(
                (1, cx, cy, ux, uy, span))
    masks = [c for c in chains
             if _chain_white(c) and (getattr(c, "width", 0) or 0)
             >= _MASK_WIDTH_MIN]
    if masks and plan:
        samp, owner, tang = [], [], []
        for c in plan:
            p = np.asarray(c.pts, float)
            for a, b in zip(p[:-1], p[1:]):
                L = float(np.hypot(*(b - a)))
                if L < 1e-6:
                    continue
                u = (b - a) / L
                k = max(int(L / 3.0), 1)
                for t in np.linspace(0.0, 1.0, k, endpoint=False):
                    samp.append(a + t * (b - a))
                    owner.append(int(c.chain_id))
                    tang.append(u)
        if samp:
            tree = cKDTree(np.asarray(samp))
            tang = np.asarray(tang)
            for c in masks:
                p = np.asarray(c.pts, float)
                for a, b in zip(p[:-1], p[1:]):
                    L = float(np.hypot(*(b - a)))
                    if not (_MASK_SEG_PT[0] <= L <= _MASK_SEG_PT[1]):
                        continue
                    u = (b - a) / L
                    ctr = (a + b) / 2
                    dd, ii = tree.query(ctr, k=12)
                    dd = np.atleast_1d(dd)
                    ii = np.atleast_1d(ii)
                    d, i = float(dd[0]), int(ii[0])
                    if d > _MASK_DIST_PT:
                        continue
                    if abs(float(tang[i] @ u)) < _MASK_COS:
                        continue
                    cid = int(owner[i])
                    # ambiguity guard: when a SECOND chain also passes
                    # within mask distance (C-04's south strip runs its
                    # contours 10 pt apart under one dashed mask line),
                    # the label under this mask cannot be assigned by
                    # geometry - a wrong owner hands a neighbour's
                    # elevation to the chain, which is worse than absence
                    other = next((k for k in range(1, len(ii))
                                  if k < len(dd)
                                  and int(owner[int(ii[k])]) != cid), None)
                    if other is not None \
                            and float(dd[other]) <= _MASK_DIST_PT:
                        continue
                    # one region per spot: a mask redrawn over an already
                    # found break would double the patch for no new info
                    if any(np.hypot(r[1] - ctr[0], r[2] - ctr[1]) < 8.0
                           for r in regions.get(cid, [])):
                        continue
                    # the label follows the CHAIN under the mask, not the
                    # mask stroke: on C-04's south strip the masks run at
                    # 0 deg over contours tilted -10 to -17 deg, and OCR
                    # of the mask-angled patch clipped every digit - so
                    # the region takes the chain's local tangent
                    tv = tang[i]
                    regions.setdefault(cid, []).append(
                        (0, float(ctr[0]), float(ctr[1]),
                         float(tv[0]), float(tv[1]), L))
    return regions


def suggest_elevations(chains: list, words: list,
                       max_d_pt: float = 16.0,
                       gap_z: dict | None = None,
                       exclude: set | None = None) -> list:
    """Auto-pair elevation-looking labels with the contour they sit on.

    Returns [{chain_id, z, label_xy, dist, how}] - a SUGGESTION for the
    review UI; the human confirms/edits, per the agreed human-in-loop flow.
    `how` discloses the evidence: "inline" (native token in the chain's own
    break), "gap-ocr" (OCR of the break), "radius" (nearest label within
    max_d_pt), "inherited" (propagated along the contour, pass 2).
    Chains in `exclude` never seed and never take a label - see the
    explicit source ranking below.
    """
    import re

    exclude = exclude or set()
    cands = []
    for w in words:
        t = str(w[4]).strip()
        if re.fullmatch(r"\d{3,4}(\.\d{1,2})?", t):
            v = float(t)
            if 10.0 <= v <= 9999.0:
                cands.append(((w[0] + w[2]) / 2, (w[1] + w[3]) / 2, v))
    if not cands:
        return []
    # Explicit source ranking, stored in the `dist` slot so the existing
    # keep-the-closest comparisons ARE the ranking (no first-writer-wins):
    #   perp  native token inside the chain's own break ("inline") - its
    #         perpendicular distance to the break chord, so a CLOSER
    #         radius token still wins the chain (on Stice, rank-flat
    #         inline let a neighbour's token in a phantom break outrank
    #         the chain's own on-line label 202 times)
    #   0.5   OCR of the chain's own break              ("gap-ocr") -
    #         never numerically displaces an inline match (the explicit
    #         same-text rule below is the only path), and never a radius
    #         match closer than _ON_LINE_PT: a native token that close is
    #         printed ON the line, and the PDF's own glyphs outrank a
    #         raster re-read of the same spot
    #   d     nearest-label radius match, d <= max_d_pt ("radius")
    #   999   inherited along the contour               ("inherited")
    out, seen, how = [], {}, {}

    samples, owner = [], []
    for c in chains:
        # a profile box or the title block is not plan ground - see
        # _NON_PLAN_LAYER. Filtering the sample pool once keeps both the
        # direct match below and the propagation in pass 2 off them.
        # Excluded chains (legend non-contours, white masks) leave the pool
        # entirely, so a label they used to steal now reaches the nearest
        # chain that can actually be a contour.
        if c.length < 60 or not _is_plan_chain(c) \
                or int(c.chain_id) in exclude:
            continue
        s, _ = _sample_polyline(np.asarray(c.pts), step=4.0, max_n=60000)
        if len(s):
            samples.append(s)
            owner += [c.chain_id] * len(s)
    if not samples:
        return []
    tree = cKDTree(np.vstack(samples))
    owner = np.array(owner)

    # Pass 0 - native tokens sitting inside a chain's own break. Geometry
    # (perpendicular distance to the break chord), not a bucket. A token
    # consumed here is REMOVED from the radius pool: on C-04 the property
    # line and mask strokes each grabbed a nearby contour's inline label as
    # their own z through the radius match - the theft this pass ends.
    # The break's OWNER must also be the STRICT nearest chain to the
    # token: on the Stice sheet (1"=200', terrace contours closer together
    # than the label text is tall) any laxer rule pulls labels sideways
    # into neighbours' break regions - a 2.0 pt margin moved 336 of the
    # operator's 1,487 verified rows off their values, 0.5 pt still moved
    # 124. With owner == nearest, the inline pass can never assign a
    # token to a different chain than the radius pass would, so its whole
    # effect is rank: the chain's own in-break label outranks farther
    # radius tokens and OCR re-reads. C-04's genuine in-break tokens all
    # have their own chain as the strict nearest once the mask and
    # property-line families are excluded from the pool.
    consumed = set()
    regions = _label_regions(chains, exclude=exclude)
    if regions:
        flat = []
        for cid, regs in regions.items():
            for kind, cx, cy, ux, uy, span in regs:
                flat.append((cid, kind, cx, cy, ux, uy, span))
        for ci, (tx, ty, v) in enumerate(cands):
            best = None
            for cid, kind, cx, cy, ux, uy, span in flat:
                dx, dy = tx - cx, ty - cy
                lon = abs(dx * ux + dy * uy)
                per = abs(dx * -uy + dy * ux)
                if lon <= span / 2 + 3.0 and per <= _INLINE_PERP_PT:
                    if best is None or per < best[0]:
                        best = (per, cid)
            if best is None:
                continue
            per, cid = best
            d_near, i_near = tree.query([tx, ty])
            if int(owner[int(i_near)]) != cid:
                continue  # another chain owns this token
            consumed.add(ci)
            # rank by the token's PATH distance, the same metric the
            # radius pass uses - ranking by chord-perp let a phantom
            # region's far token outrank the chain's own on-line label
            # (43 Stice rows moved before this was equalised). Inline
            # keeps its tag (and OCR protection) but can never prefer a
            # token the radius pass would have rejected.
            d_rank = max(float(d_near), 0.05)
            if cid in seen and seen[cid][0] <= d_rank:
                continue
            seen[cid] = (d_rank, v, tx, ty)
            how[cid] = "inline"
    for ci, (cx, cy, v) in enumerate(cands):
        if ci in consumed:
            continue
        d, i = tree.query([cx, cy])
        if d > max_d_pt:
            continue
        cid = int(owner[i])
        # one contour can carry several copies of its label; keep closest
        if cid in seen and seen[cid][0] <= d:
            continue
        seen[cid] = (d, v, cx, cy)
        how[cid] = "radius"
    # gap-OCR labels (see gap_label_elevations) are read out of the chain's
    # own break - stronger than any radius hit except a native token
    # actually printed on the line (see the ranking above)
    if gap_z:
        # OCR misreads produce lone impossible values (195 and 861 on a
        # 548-588ft sheet). Real elevations never stand alone: contours
        # step in small intervals and spot grades cluster with them, so a
        # gap-read value with no other elevation within 25ft - when the
        # sheet offers 6+ to compare against - is a misread, not terrain.
        anchor = sorted({s[1] for s in seen.values()}
                        | {v for v, _, _ in gap_z.values()})
        # Native band gate: with >= 3 distinct GLYPH-derived values on the
        # page (radius or inline - a real witnessed population), an OCR
        # value more than 100 ft from every one of them is a misread, not
        # a second surface. OCR only fills gaps in a surface the native
        # labels already witness; measured on Barn C3.0, the v2 pass also
        # read 826/710/324/307/120/100 out of dimension texts against a
        # 7,7xx-ft native population, and those mutually-supporting reads
        # sail through the 25-ft anchor rule below. 100 ft matches the
        # endpoint's surface-cluster gap.
        native_vals = sorted({s[1] for s in seen.values()})
        for cid, (v, cx, cy) in gap_z.items():
            cid = int(cid)
            if cid in exclude:
                continue
            if len(native_vals) >= 3 and min(
                    (abs(v - a) for a in native_vals), default=0.0) > 100.0:
                continue
            if len(anchor) >= 6:
                near = min((abs(v - a) for a in anchor if a != v),
                           default=0.0)
                if near > 25.0:
                    continue
            if cid not in seen or (how.get(cid) != "inline"
                                   and seen[cid][0] > 0.5
                                   and not (how.get(cid) == "radius"
                                            and seen[cid][0] <= _ON_LINE_PT)):
                seen[cid] = (0.5, v, cx, cy)
                how[cid] = "gap-ocr"
            elif how.get(cid) == "inline" and abs(seen[cid][1] - v) > 0.01:
                # inline vs gap-OCR disagreement. Two measured shapes:
                #  - DIFFERENT texts occupy the area: on C-04 the break
                #    held a vector-exploded label (569/570/571) and a
                #    nearby native SPOT value (565.2/567.8/570.3) merely
                #    overlapped it - the OCR read was right 3 of 3, so a
                #    structurally different value defers to the OCR;
                #  - the SAME text, misread: on Barn C3.0 the native 7725
                #    sat in its own break and the OCR returned 7715 - one
                #    digit off at equal length. Native glyphs are exact;
                #    a raster re-read of the same string cannot beat
                #    them, so equal-length/one-digit-apart keeps inline.
                a, b = f"{seen[cid][1]:g}", f"{v:g}"
                same_text = (len(a) == len(b)
                             and sum(x != y for x, y in zip(a, b)) <= 1)
                # ...and the OCR value must be corroborated by another
                # elevation within 5 ft (a contour interval or two on the
                # measured sheets - C-04 steps 1 ft, Stice 2.5-5): the
                # C-04 wins (569/570/571 over spot values) all have
                # adjacent-contour support, while Stice's one such
                # override was a 400 misread displacing a verified 472.5
                # with nothing within 25 ft of it.
                support = min((abs(v - x) for x in anchor if x != v),
                              default=1e9)
                if not same_text and support <= 5.0:
                    seen[cid] = (0.5, v, cx, cy)
                    how[cid] = "gap-ocr"
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
             if c.length >= 60 and len(c.pts) >= 2 and _is_plan_chain(c)
             and int(c.chain_id) not in exclude]
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
                    how[m] = "inherited"
    for cid, (d, v, cx, cy) in seen.items():
        out.append({"chain_id": cid, "z": v,
                    "label_xy": [round(cx, 1), round(cy, 1)],
                    "dist": round(float(d), 1),
                    "how": how.get(cid, "radius")})
    return sorted(out, key=lambda r: r["z"])


# OCR patch budget, counted in TESSERACT CALLS (the numpy gates are free).
# Candidate regions measured with the v2 triggers: C-04 ~950 raw (202
# chains, ~600 reach tesseract), Barn C3.0 ~2,000, Stice 600-acre ~3,500.
# The global order below is round-robin across chains (every chain's best
# region before any chain's second - the v1 first-come cap starved C-04's
# proposed contours completely, chains 799+ hit `patches_before=400` on
# all 20). 1,400 covers every gate-passing region on C-04 (900 cut it off
# in round ~3 and lost chain 800's fourth-ranked label break) and bounds
# the one-time per-page cache build at ~3 min of tesseract on the largest
# measured sheet.
_OCR_BUDGET = 1400
# Per chain: stop after three reads - a long contour repeats its label,
# and the third read breaks the tie when one of the first two is a
# misread (the majority rule in the conflict resolution below). A fourth
# adds nothing that the ranking can use.
_OCR_READS_PER_CHAIN = 3
# Patch band height: label text on these sheets is 7-10 pt tall; a 12 pt
# band clears it, while v1's 22 pt band pulled in the neighbouring contour
# on C-04's tight strip (~10-15 pt between contours) and its labels with it.
_OCR_BAND_PT = 12.0
# "Ink" is anything darker than 235/255. C-04's screened existing labels
# anti-alias to 193-230 in the 150 dpi raster (thin 0.6-gray strokes) - a
# 200 threshold read whole gray labels as blank paper and every
# existing-contour read vanished; 235 still excludes clean paper (255).
_OCR_INK_LEVEL = 235
# A patch more than 35% ink sits inside hatch or a solid fill, not a
# label (inferred from the C-04 patches, stated as inference).
_OCR_INK_MAX = 0.35
# The label-vs-linework discriminator is ink OFF the chord line: the
# polyline cannot say which segments are pen-up (a drawn 18 pt dash and an
# 18 pt label break are the same jump), but label digits are 7-10 pt tall
# while the linework this must reject is <= 3.5 pt wide - so beyond
# +-2.0 pt of the chord a dash or an empty break is clean and a label is
# not. Measured on C-04's 40 verified label regions: off-chord ink
# 0.025-0.32; drawn dashes and empty breaks sit at ~0. 0.02 passed 40/40
# labels and prunes ~40% of the non-label regions before tesseract, which
# is what keeps the budget for regions that can pay (v1 spent its whole
# 400-patch first-come budget on drawn dashes and starved chains 799+).
_OCR_OFFCHORD_MIN = 0.02
_OCR_OFFCHORD_HALF_PT = 2.0


def _ocr_digit_string(pytesseract, re, img) -> tuple:
    """(valid elevation string or None, raw attempts) for one binary image.

    psm 7 treats the patch as one text line; psm 8 as one word - the
    fallback recovers labels whose leading digit psm 7 clips (measured on
    C-04: 803/804 read only under psm 8).
    """
    outs = []
    for psm in (7, 8):
        try:
            t = pytesseract.image_to_string(
                img,
                config=f"--psm {psm} -c tessedit_char_whitelist=0123456789.",
            ).strip().strip(".")
        except Exception:
            return None, outs
        outs.append(t)
        if re.fullmatch(r"\d{3,4}(\.\d{1,2})?", t):
            return t, outs
    return None, outs


def _read_label_patch(cv2, pytesseract, re, patch) -> str | None:
    """OCR one flattened label patch, two variants with an explicit rule.

    V1: 2x upscale + Otsu, geometry untouched. V2: same, then drop
    connected components that are line-like (w > 2.2h), sub-glyph
    (h < 10 px at 2x150dpi ~ a 2.4 pt speck), or hollow-diagonal
    (area < 15% of box - a stroke crossing the band), and tight-crop what
    remains. V2 unglues digits from the dashes that touch them but can
    also hallucinate: on C-04 it repaired 5833->583 yet misread 572 as
    972. Rule, measured against the 47 hand-verified C-04 labels:
      - V1 valid and V2 a shorter substring of it -> V2 (V1 = same digits
        plus a stray stroke read as an extra digit: 5657->565, 5797->579);
      - V1 valid otherwise -> V1;
      - only V2 valid -> V2, but ONLY if every non-empty V1 raw attempt is
        a substring of it (V1 glimpsed a fragment of the same digits; this
        rejected V2's one plausible-but-wrong read, 575 for a true 577).
    """
    big = cv2.resize(patch, None, fx=2, fy=2, interpolation=cv2.INTER_CUBIC)
    _, bw1 = cv2.threshold(big, 0, 255,
                           cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    t1, raw1 = _ocr_digit_string(pytesseract, re, bw1)
    _, inv = cv2.threshold(big, 0, 255,
                           cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    n, lab, stats, _ = cv2.connectedComponentsWithStats(inv, 8)
    boxes = []
    keep = np.zeros_like(inv)
    for i in range(1, n):
        x, y, w, h, area = stats[i]
        if h < 10 or h > inv.shape[0] - 2 or w > 2.2 * h \
                or area < 0.15 * w * h:
            continue
        keep[lab == i] = 255
        boxes.append((x, y, w, h))
    t2 = None
    if boxes:
        x0 = min(b[0] for b in boxes)
        y0 = min(b[1] for b in boxes)
        x1 = max(b[0] + b[2] for b in boxes)
        y1 = max(b[1] + b[3] for b in boxes)
        tight = 255 - keep[max(y0 - 6, 0):y1 + 6, max(x0 - 6, 0):x1 + 6]
        t2, _ = _ocr_digit_string(pytesseract, re, tight)
    if t1 is not None and t2 is not None:
        if t2 != t1 and len(t2) < len(t1) and t2 in t1:
            return t2
        return t1
    if t1 is not None:
        return t1
    if t2 is not None and all(r in t2 for r in raw1 if r):
        return t2
    return None


def gap_label_elevations(chains: list, page_img: np.ndarray,
                         px_per_pt: float,
                         max_patches: int = _OCR_BUDGET,
                         exclude: set | None = None) -> dict:
    """Read elevation labels printed INSIDE breaks of their own contour.

    Contour elevations sit in a gap of the line, rotated to follow it.
    Native text misses them when the glyphs are exploded to vectors, and
    whole-page OCR misses them because they are rotated (Oncor p4: the
    571-576 labels were found by neither). The chain itself knows where a
    label can sit - a merged break of its own polyline, or a white mask
    stroke painted along it (_label_regions) - so a small patch per
    region, rotated flat by the region's own direction, reads them.

    Patches are scheduled round-robin across chains (every chain's best
    region before any chain's second), regions ranked mask-first then by
    closeness to the measured label span - an explicit ranking, so a
    budget cut trims the least label-like patches instead of whichever
    chains happened to come last (the v1 failure on C-04).

    Returns {chain_id: (z, cx_pt, cy_pt)}. Chains whose gap labels
    disagree are dropped - ambiguity is worse than absence.
    """
    import re

    try:
        import cv2
        import pytesseract
    except Exception:
        return {}
    if page_img.ndim == 3:
        gray = cv2.cvtColor(page_img, cv2.COLOR_RGB2GRAY)
    else:
        gray = page_img
    regions = _label_regions(chains, exclude=exclude)
    if not regions:
        return {}
    # rank regions inside each chain, then interleave chains round-robin;
    # within one round the most label-like regions go first so the budget
    # cut is by likelihood, not by chain order
    for regs in regions.values():
        regs.sort(key=lambda r: (r[0], abs(r[5] - _LABEL_SPAN_PT)))
    order = []
    rnd = 0
    while True:
        layer = [(cid, regs[rnd]) for cid, regs in regions.items()
                 if len(regs) > rnd]
        if not layer:
            break
        layer.sort(key=lambda t: (t[1][0], abs(t[1][5] - _LABEL_SPAN_PT),
                                  t[0]))
        order += layer
        rnd += 1

    reads: dict = {}
    n_ocr = 0  # the budget counts tesseract calls; the numpy gates that
    # reject empty breaks and drawn dashes are ~free and must not starve
    # later chains the way v1's patch counter did
    for cid, (kind, cx, cy, ux, uy, span) in order:
        if n_ocr >= max_patches:
            break
        if len(reads.get(cid, ())) >= _OCR_READS_PER_CHAIN:
            continue
        ang = float(np.degrees(np.arctan2(uy, ux)))
        if ang > 90:
            ang -= 180
        elif ang <= -90:
            ang += 180
        # crop a square that covers the rotated text box, rotate flat.
        # A break region needs margin (the digits can outgrow the visible
        # break); a mask region must stay tight - C-04's south strip
        # prints its labels ~40 pt apart, and a wide mask patch caught the
        # NEIGHBOUR's digits alongside the chain's own.
        w_pt = span + (16.0 if kind == 0 else 30.0)
        h_pt = _OCR_BAND_PT
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
        # ink gates (see the constants): a solid/hatch patch cannot be a
        # label, and a patch with no ink OFF the chord is an empty break
        # or the drawn line itself - skipping both keeps the tesseract
        # time for patches that can pay
        if float(np.mean(patch < _OCR_INK_LEVEL)) > _OCR_INK_MAX:
            continue
        off = int(_OCR_OFFCHORD_HALF_PT * px_per_pt)
        mid = patch.shape[0] // 2
        rows = np.r_[0:max(mid - off, 0),
                     min(mid + off + 1, patch.shape[0]):patch.shape[0]]
        if len(rows) and float(
                np.mean(patch[rows] < _OCR_INK_LEVEL)) < _OCR_OFFCHORD_MIN:
            continue
        n_ocr += 1
        txt = _read_label_patch(cv2, pytesseract, re, patch)
        if txt is None and kind == 0 and n_ocr < max_patches:
            # mask retry with break-sized margin: the tight mask patch
            # clips a label whose digits outgrow the mask stroke (C-04
            # chain 806); the wide patch stays second choice because in
            # a dense strip it can catch a neighbour's digits - a wrong
            # wide read still has to survive the band + kind ranking
            wide = span + 30.0
            D2 = int((np.hypot(wide, h_pt) + 6) * px_per_pt)
            x2, y2 = max(cxp - D2 // 2, 0), max(cyp - D2 // 2, 0)
            crop2 = gray[y2:y2 + D2, x2:x2 + D2]
            if crop2.size:
                M2 = cv2.getRotationMatrix2D((cxp - x2, cyp - y2), ang, 1.0)
                rot2 = cv2.warpAffine(crop2, M2,
                                      (crop2.shape[1], crop2.shape[0]),
                                      borderValue=255)
                bw2 = int(wide * px_per_pt / 2)
                mx2, my2 = cxp - x2, cyp - y2
                patch2 = rot2[max(my2 - bh, 0):my2 + bh,
                              max(mx2 - bw2, 0):mx2 + bw2]
                if patch2.size:
                    n_ocr += 1
                    txt = _read_label_patch(cv2, pytesseract, re, patch2)
        if txt is None:
            continue
        v = float(txt)
        if 10.0 <= v <= 9999.0:
            reads.setdefault(cid, []).append((v, float(cx), float(cy), kind))
    # Conflict resolution - an explicit ranking, measured on C-04's
    # misread population (a line stroke read as an extra or swapped
    # digit: 5674/567, 375/575, 978/578, 382/582, 904/584, 675/575):
    #  1. dominant band: cluster every read value on GAPS > 30 ft (a
    #     gap-walk, not a bucket) and, with >= 6 distinct values and a
    #     band of >= 3, keep only reads inside the biggest band.
    #     Misreads SUPPORT EACH OTHER under a nearest-neighbour rule -
    #     C-04 read both 5657 and 5674, 17 ft apart, and each vouched
    #     for the other - but they cannot outnumber the real labels'
    #     band. 30 because a sheet's contour labels step 1-10 ft (C-04
    #     545-590 dense at 1 ft, Stice 425-521, Barn 7583-7900), while
    #     the closest measured leading-digit misread, 675 against a 590
    #     band edge, sits 85 away; the endpoint's 100 ft surface gap
    #     let that one in;
    #  2. majority: a value read from two regions beats a value read
    #     from one (the label repeats along the contour, the misread
    #     does not repeat the same way);
    #  3. a single break (kind 1) value beats mask reads - a mask patch
    #     in a dense strip can catch a NEIGHBOUR's label, a chain's own
    #     break cannot;
    #  4. still ambiguous -> drop the chain (worse than absence).
    all_vals = sorted({v for vals in reads.values() for v, _, _, _ in vals})
    band = None
    if len(all_vals) >= 6:
        groups, cur = [], [all_vals[0]]
        for prev, v in zip(all_vals, all_vals[1:]):
            if v - prev > 30.0:
                groups.append(cur)
                cur = []
            cur.append(v)
        groups.append(cur)
        top = max(groups, key=len)
        if len(top) >= 3:
            band = set(top)
    found: dict = {}
    for cid, vals in reads.items():
        if band is not None:
            vals = [t for t in vals if t[0] in band]
            if not vals:
                continue
        zs = {v for v, _, _, _ in vals}
        if len(zs) > 1:
            counts = {}
            for v, _, _, _ in vals:
                counts[v] = counts.get(v, 0) + 1
            best = max(counts.values())
            lead = [v for v, n in counts.items() if n == best]
            if best >= 2 and len(lead) == 1:
                vals = [t for t in vals if t[0] == lead[0]]
                zs = {lead[0]}
        if len(zs) > 1:
            brk = [t for t in vals if t[3] == 1]
            if len({v for v, _, _, _ in brk}) == 1:
                vals = brk
                zs = {v for v, _, _, _ in vals}
        if len(zs) == 1:
            v, cx, cy, _ = vals[0]
            found[int(cid)] = (v, cx, cy)
    return found


# --- existing vs proposed: the surface split ------------------------------
# The suggest reply must say WHICH rule decided each row (split_by), and the
# rules apply in an explicit precedence - never first-writer-wins:
#   a. legend verdict   the sheet's own legend names the family
#   b. color screening  gray = screened existing, dark = proposed - only
#                       when the page actually draws both populations
#   c. width median     today's behaviour, the monochrome fallback
_LEGEND_TAG = re.compile(r"\(legend\)\s*$", re.I)
# Screening constants, measured on Oncor C-04: existing contours print
# 0.5-0.6 equal-RGB gray, proposed contours 0.0 black; the sheet's
# annotation grays sit at 0.502 and 0.702. A "gray" must have near-equal
# channels (tolerance 0.05 covers AutoCAD's 0.5019... float grays) - a real
# color (blue water line, red demo) gets NO screening verdict and falls
# through to width rather than being guessed at.
_EQ_RGB_TOL = 0.05
# Gray band: above _DARK_MAX with headroom (0.35), below white ink (0.88 <
# WHITE_MIN so no stroke is both "gray" and "white").
_GRAY_BAND = (0.35, 0.88)
# Dark: C-04 proposed is 0.0; 0.30 leaves room for near-black plots while
# staying clear of the 0.5 grays.
_DARK_MAX = 0.30
# A population is >= 2 rows of that ink: one stray gray stroke on an
# otherwise black-and-white sheet must not flip the whole page to color
# screening (the monochrome Barn sheets are exactly that case).
_POP_MIN = 2


def _ink_kind(color) -> str | None:
    """"gray" / "dark" / "white" for a near-equal-RGB stroke, else None."""
    if not color:
        return None
    try:
        vals = [float(v) for v in color]
    except (TypeError, ValueError):
        return None
    if not vals:
        return None
    if max(vals) - min(vals) > _EQ_RGB_TOL:
        return None  # a real color; screening says nothing about it
    v = sum(vals) / len(vals)
    if v >= WHITE_MIN:
        return "white"
    if v <= _DARK_MAX:
        return "dark"
    if _GRAY_BAND[0] <= v <= _GRAY_BAND[1]:
        return "gray"
    return None


def family_verdicts(styles: list) -> dict:
    """What the sheet's own legend says each style family is.

    {style_id: {"role", "label"}} for legend-matched families only:
      "existing"/"proposed"  a CONTOUR row that names its surface
      "contour"              a CONTOUR row that does not
      "noncontour"           any other legend row (property line, swale,
                             grade break, fence...) - NEVER seeds rows
    Matching is on the legend row's OWN words (CONTOUR / EXIST / PROPOSED),
    not an invented taxonomy of line types (CLAUDE.md section 4); anything
    the legend did not match falls through to color/width unlabeled.
    """
    out: dict = {}
    for s in styles or []:
        if not isinstance(s, dict):
            continue
        sid = s.get("style_id")
        lab = s.get("suggested_label") or ""
        if sid is None or not _LEGEND_TAG.search(lab):
            continue
        up = lab.upper()
        if "CONTOUR" in up:
            role = ("existing" if "EXIST" in up
                    else "proposed" if "PROPOSED" in up
                    else "contour")
        else:
            role = "noncontour"
        out[int(sid)] = {"role": role, "label": lab.strip()}
    return out


def split_rows_surface(rows: list, chain_info: dict,
                       verdicts: dict) -> dict:
    """Assign surface + split_by to each suggest row, by the precedence
    documented above. Mutates rows in place; returns {rule: count}.

    chain_info: {chain_id: {"style_id", "color", "width"}} from the stored
    detect result. Rows whose chain is unknown fall to the width rule.
    """
    counts = {"legend": 0, "color": 0, "width": 0}
    undecided = []
    kinds = {}
    for r in rows:
        info = chain_info.get(r.get("chain_id")) or {}
        kinds[r["chain_id"]] = _ink_kind(info.get("color"))
        v = verdicts.get(info.get("style_id")) or {}
        role = v.get("role")
        if role in ("existing", "proposed"):
            r["surface"] = role
            r["split_by"] = "legend"
            counts["legend"] += 1
        else:
            undecided.append(r)
    # color screening only where the page truly draws both populations -
    # counted over ALL seeded rows so a legend-decided family still proves
    # the sheet is a two-ink sheet
    n_gray = sum(1 for k in (kinds[r["chain_id"]] for r in rows)
                 if k == "gray")
    n_dark = sum(1 for k in (kinds[r["chain_id"]] for r in rows)
                 if k == "dark")
    two_inks = n_gray >= _POP_MIN and n_dark >= _POP_MIN
    still = []
    for r in undecided:
        k = kinds[r["chain_id"]]
        if two_inks and k in ("gray", "dark"):
            r["surface"] = "existing" if k == "gray" else "proposed"
            r["split_by"] = "color"
            counts["color"] += 1
        else:
            still.append(r)
    # width fallback: the median rule the UI applies today, computed over
    # every returned row so a monochrome sheet reproduces today's split
    # exactly
    ws = sorted((r.get("width") or 0) for r in rows)
    wmed = ws[len(ws) // 2] if ws else 0
    for r in still:
        w = r.get("width") or 0
        r["surface"] = "existing" if w <= wmed else "proposed"
        r["split_by"] = "width"
        counts["width"] += 1
    return counts


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
