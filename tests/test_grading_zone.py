"""Grading-zone math (takeoff_engine.earthwork.zone_cut_fill), pinned to
hand arithmetic.

Every volume asserted here is computed by hand from the cell grid the
function is documented to use (cell centres at lo + (i + 0.5) * cell), so
these are exact expectations, not regression snapshots. Geometry is built
with ft_per_pt = 1.0 so page points ARE feet and nothing hides in the
scale conversion.

The fixture existing surface is a plane through spot points, because
LinearNDInterpolator reproduces a plane exactly inside its hull - any
disagreement is the zone math, never the TIN.

Dependency-free like tests/test_gate.py:  python tests/test_grading_zone.py
(needs the repo venv for numpy/scipy, same as the engine itself)
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from takeoff_engine.earthwork import Surface, zone_cut_fill  # noqa: E402

CHECKS = []


def ok(cond, msg):
    CHECKS.append((bool(cond), msg, None, None))


def near(got, want, msg, tol=0.05):
    CHECKS.append((got is not None and abs(got - want) <= tol,
                   msg, got, want))


def plane_surface(z_fn):
    """A planar existing surface over [0,100]^2 (pt == ft here)."""
    s = Surface("existing")
    for x, y in ((0, 0), (100, 0), (0, 100), (100, 100), (50, 50)):
        s.points.append((float(x), float(y), float(z_fn(x, y))))
    return s


SQ = [[0, 0], [100, 0], [100, 100], [0, 100]]   # 100 ft x 100 ft zone

# ---- 1. pad vs a sloping plane: hand-exact volumes ----------------------
# existing z = 100 + 0.1x, pad at 105.  Cells are 2 ft, centres at
# x = 1, 3, ..., 99.  dz = 5 - 0.1x: positive for the 25 columns x < 50,
# column sum = sum_{j=0..24}(4.9 - 0.2j) = 62.5 ft, each column is
# 50 cells * 4 SF = 200 SF -> fill = 62.5 * 200 = 12,500 ft3 = 462.96 CY.
# Cut is symmetric.  Deepest cell each way is |dz| at x=1 / x=99 = 4.9 ft.
ex_slope = plane_surface(lambda x, y: 100.0 + 0.1 * x)
r = zone_cut_fill(ex_slope, SQ, 1.0, {"mode": "pad", "elev_ft": 105.0})
ok("error" not in r, f"pad-vs-plane computes ({r.get('error')})")
near(r.get("fill_yd3"), 463.0, "pad fill = 12,500 ft3 = 463.0 CY by hand")
near(r.get("cut_yd3"), 463.0, "pad cut symmetric = 463.0 CY by hand")
near(r.get("net_yd3"), 0.0, "pad net = 0 by symmetry")
near(r.get("area_sf"), 10000.0, "pad area = the full 10,000 SF zone", 0.5)
near(r.get("max_fill_ft"), 4.9, "deepest fill cell = 4.9 ft (x = 1)", 0.01)
near(r.get("max_cut_ft"), 4.9, "deepest cut cell = 4.9 ft (x = 99)", 0.01)
near(r.get("existing_mean_ft"), 105.0, "existing mean over centres = 105.0",
     0.01)
near(r.get("coverage"), 1.0, "TIN covers the whole zone", 1e-9)
near(r.get("strip_yd3"), 0.0, "no strip requested -> 0 strip CY", 1e-9)
ok(r.get("existing_n_spots") == 5 and r.get("existing_n_contours") == 0,
   "surface provenance counts reported (5 spots, 0 contours)")
ok(len(r.get("cell_labels") or []) <= 120,
   f"cell labels coarse-capped ({len(r.get('cell_labels') or [])} <= 120)")
ok(all(isinstance(c.get("dz"), float) for c in r["cell_labels"]),
   "every cell label carries a dz")

# ---- 2. plane mode against hand arithmetic ------------------------------
# existing flat 100, design plane 100 at the centre falling 1% east
# (azimuth 90 = +x).  dz = -0.01(x - 50): the 25 columns x < 50 fill,
# column sum = 0.01 * sum(49 - 2j) = 6.25 ft -> 6.25 * 200 = 1,250 ft3
# = 46.3 CY each way; deepest cells 0.49 ft.
ex_flat = plane_surface(lambda x, y: 100.0)
r2 = zone_cut_fill(ex_flat, SQ, 1.0,
                   {"mode": "plane", "elev_ft": 100.0, "slope_pct": 1.0,
                    "azimuth_deg": 90.0, "anchor": [50.0, 50.0]})
ok("error" not in r2, f"plane mode computes ({r2.get('error')})")
near(r2.get("fill_yd3"), 46.3, "plane fill = 1,250 ft3 = 46.3 CY by hand")
near(r2.get("cut_yd3"), 46.3, "plane cut symmetric = 46.3 CY")
near(r2.get("max_fill_ft"), 0.49, "plane deepest fill = 0.49 ft", 0.01)
near(r2.get("max_cut_ft"), 0.49, "plane deepest cut = 0.49 ft", 0.01)

# same plane falling NORTH (azimuth 0 = up the page = -y): symmetric too
r2n = zone_cut_fill(ex_flat, SQ, 1.0,
                    {"mode": "plane", "elev_ft": 100.0, "slope_pct": 1.0,
                     "azimuth_deg": 0.0, "anchor": [50.0, 50.0]})
near(r2n.get("fill_yd3"), 46.3, "north-falling plane fill = 46.3 CY")
near(r2n.get("cut_yd3"), 46.3, "north-falling plane cut = 46.3 CY")

# anchor omitted -> polygon centroid = (50, 50): identical numbers
r2c = zone_cut_fill(ex_flat, SQ, 1.0,
                    {"mode": "plane", "elev_ft": 100.0, "slope_pct": 1.0,
                     "azimuth_deg": 90.0})
near(r2c.get("fill_yd3"), r2.get("fill_yd3"),
     "default anchor is the centroid (same fill)", 1e-9)

# ---- 3. balance mode converges to the analytic elevation ----------------
# On the linear slope, cut = fill exactly at the mean of the (stripped)
# existing surface: 105.0 with no strip, 104.0 with a 12 in strip.
r3 = zone_cut_fill(ex_slope, SQ, 1.0, {"mode": "balance"})
ok("error" not in r3, f"balance computes ({r3.get('error')})")
near(r3.get("balance_elev_ft"), 105.0,
     "balance converges to the analytic 105.0 ft", 0.01)
near(r3.get("balance_delta_ft"), 0.0,
     "delta-to-balance from existing mean = 0.0", 0.02)
ok(abs((r3.get("cut_yd3") or 0) - (r3.get("fill_yd3") or 0)) < 0.5,
   "balance |cut - fill| < 0.5 CY as specified")

r3s = zone_cut_fill(ex_slope, SQ, 1.0, {"mode": "balance"}, strip_in=12.0)
near(r3s.get("balance_elev_ft"), 104.0,
     "12 in strip lowers the balance pad to 104.0 ft", 0.01)
near(r3s.get("balance_delta_ft"), -1.0,
     "delta reported against the UNSTRIPPED existing mean", 0.02)

# ---- 4. strip arithmetic -------------------------------------------------
# flat 100, pad at 100, strip 8 in: strip = 10,000 SF * (8/12) ft / 27
# = 246.9 CY, and the fill that replaces it is the same 246.9 CY
# (the strip lowers existing before differencing, cut_fill's convention).
r4 = zone_cut_fill(ex_flat, SQ, 1.0, {"mode": "pad", "elev_ft": 100.0},
                   strip_in=8.0)
near(r4.get("strip_yd3"), 246.9, "8 in strip over 10,000 SF = 246.9 CY")
near(r4.get("fill_yd3"), 246.9, "pad fill includes replacing the strip")
near(r4.get("cut_yd3"), 0.0, "no cut on a flat site at grade", 1e-6)

# strip_only: no design surface - cut/fill zero, ONLY the strip term
r4s = zone_cut_fill(ex_flat, SQ, 1.0, {"mode": "strip_only"}, strip_in=8.0)
near(r4s.get("cut_yd3"), 0.0, "strip_only cut = 0", 1e-9)
near(r4s.get("fill_yd3"), 0.0, "strip_only fill = 0", 1e-9)
near(r4s.get("strip_yd3"), 246.9, "strip_only strip = 246.9 CY")

# ---- 5. refusals, each with a reason -------------------------------------
r5 = zone_cut_fill(ex_flat, [[0, 0], [10, 10]], 1.0,
                   {"mode": "pad", "elev_ft": 100.0})
ok("error" in r5 and "3 corners" in r5["error"],
   "2-point polygon refused with a reason")
r5b = zone_cut_fill(ex_flat, [[0, 0], [10, 10], [20, 20]], 1.0,
                    {"mode": "pad", "elev_ft": 100.0})
ok("error" in r5b and "degenerate" in r5b["error"],
   "collinear polygon refused as degenerate")
r5c = zone_cut_fill(ex_flat, SQ, 1.0, {"mode": "teleport"})
ok("error" in r5c and "teleport" in r5c["error"],
   "unknown mode named in the refusal")
r5d = zone_cut_fill(ex_flat, SQ, 1.0, {"mode": "pad"})
ok("error" in r5d and "elev_ft" in r5d["error"],
   "pad without an elevation refused with the missing field named")
r5e = zone_cut_fill(Surface("empty"), SQ, 1.0,
                    {"mode": "pad", "elev_ft": 100.0})
ok("error" in r5e and "3 sample points" in r5e["error"],
   "empty existing surface refused with a reason")
far = [[1000, 1000], [1100, 1000], [1100, 1100], [1000, 1100]]
r5f = zone_cut_fill(ex_flat, far, 1.0, {"mode": "pad", "elev_ft": 100.0})
ok("error" in r5f and "does not reach" in r5f["error"],
   "zone outside the TIN refused, not zeroed")

# ---- 6. partial coverage is REPORTED, never silent -----------------------
# zone twice as wide as the 100 ft hull: exactly half the columns defined
wide = [[0, 0], [200, 0], [200, 100], [0, 100]]
r6 = zone_cut_fill(ex_flat, wide, 1.0, {"mode": "pad", "elev_ft": 101.0})
near(r6.get("coverage"), 0.5, "half-covered zone reports coverage 0.5", 0.01)
near(r6.get("area_sf"), 10000.0, "volumes integrate the covered half only",
     0.5)
near(r6.get("zone_area_sf"), 20000.0, "the zone's own area reported beside it",
     0.5)

# --------------------------------------------------------------------------
fails = 0
for cond, msg, got, want in CHECKS:
    if cond:
        print("ok:", msg)
    else:
        fails += 1
        extra = f" (got {got}, want {want})" if got is not None else ""
        print("FAIL:", msg + extra)
print(f"\n{len(CHECKS) - fails}/{len(CHECKS)} checks passed")
sys.exit(1 if fails else 0)
