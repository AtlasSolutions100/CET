"""Surface model + interval infill: the rules, on synthetic ground truth.

Dependency-free plain asserts, same as tests/test_gate.py and
tests/test_ew_suggest.py (pytest is not installed here):

    python tests/test_surface_model.py

The reference-job numbers live in the measurement folder
(out/verify/2026-08-31/cutfill-accuracy/); what is pinned HERE is the
behaviour those numbers rest on, on ground whose right answer is known by
construction:

  * a bowl surface both models can be measured against, so "the smooth
    model is nearer the truth between the contours" is a test, not a claim;
  * the clamp actually clamps - no evaluated elevation escapes the local
    contour bracket, which is the entire safety argument for shipping a
    C1 interpolant at all (raw CloughTocher rang to 1,242 ft on Stice);
  * auto picks linear on dense labels and clamped on sparse ones;
  * area_sf does not depend on the model - a model change must move
    elevations, never the region being integrated;
  * the infill REFUSAL rule: a fan lands only when the crossed sibling
    count equals dz/interval - 1, and nothing lands when it does not.
"""
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from takeoff_engine.earthwork import (  # noqa: E402
    AUTO_BAND_FT, CLAMP_K, Surface, contour_interval, cut_fill,
    infill_intervals, label_band_ft)

FAILS = []


def check(ok, msg):
    if ok:
        print("ok: " + msg)
    else:
        FAILS.append(msg)
        print("FAIL: " + msg)


def ring(cx, cy, r, n=200):
    t = np.linspace(0, 2 * np.pi, n)
    return np.column_stack([cx + r * np.cos(t), cy + r * np.sin(t)])


def bowl_surface(radii_z, cx=0.0, cy=0.0):
    """Concentric contours of a paraboloid: z = z0 + k*r^2 sampled at the
    given (radius, z) pairs. The true surface BETWEEN two contours bulges
    away from the chord - which is exactly the relief a linear TIN loses."""
    s = Surface("s")
    for r, z in radii_z:
        s.contours.append((ring(cx, cy, r), float(z)))
    return s


# ---- 1. the clamp clamps ------------------------------------------------
# A ring bundle 1 ft apart and very close together is what made raw CT ring
# on Oncor's retaining wall. Every evaluated cell must stay inside the
# bracket of its CLAMP_K nearest contour samples.
from takeoff_engine.earthwork import _clamped_ct_eval  # noqa: E402

tight = bowl_surface([(100.0, 550.0), (103.0, 551.0), (106.0, 552.0),
                      (109.0, 553.0), (112.0, 554.0), (140.0, 560.0)])
P, Z = tight.samples()
ev = _clamped_ct_eval(P, Z)
gx, gy = np.meshgrid(np.linspace(-140, 140, 90), np.linspace(-140, 140, 90))
z = ev(gx, gy)
fin = np.isfinite(z)
check(fin.any(), "the clamped model evaluates somewhere on a ring bundle")
from scipy.spatial import cKDTree  # noqa: E402
_, idx = cKDTree(P).query(np.column_stack([gx[fin], gy[fin]]),
                          k=min(CLAMP_K, len(P)))
zn = Z[idx]
lo, hi = zn.min(axis=1), zn.max(axis=1)
over = np.maximum(z[fin] - hi, lo - z[fin]).max()
check(over <= 1e-9,
      f"no clamped elevation escapes its local contour bracket (max escape "
      f"{over:.2e} ft)")
check(float(z[fin].max()) <= float(Z.max()) + 1e-9
      and float(z[fin].min()) >= float(Z.min()) - 1e-9,
      "and none escapes the sheet's own elevation range either")

# ---- 2. between contours, the smooth model is NEARER the real ground ----
# Truth: z = 550 + (r/10)^2. Contours drawn every 20 ft of radius, so the
# TIN has to guess the bulge in between - the terracing finding #1 is about.
def truth(x, y):
    return 550.0 + (np.hypot(x, y) / 10.0) ** 2


sparse = Surface("sparse")
for r in (20.0, 40.0, 60.0, 80.0, 100.0):
    sparse.contours.append((ring(0, 0, r), truth(r, 0.0)))
Ps, Zs = sparse.samples()
from scipy.interpolate import LinearNDInterpolator  # noqa: E402
lin = LinearNDInterpolator(Ps, Zs)
cla = _clamped_ct_eval(Ps, Zs)
# probe MID-BAND, where the two models are allowed to differ
rr = np.array([30.0, 50.0, 70.0, 90.0])
px, py = rr, np.zeros_like(rr)
t = truth(px, py)
e_lin = float(np.abs(lin(px, py) - t).mean())
e_cla = float(np.abs(cla(px, py) - t).mean())
check(e_cla < e_lin,
      f"between contours the clamped smooth model beats linear on known "
      f"ground ({e_cla:.3f} ft vs {e_lin:.3f} ft mean |err|)")
# ...and ON a contour both are exact, so the gain is not bought with drift
on = np.array([40.0, 80.0])
check(float(np.abs(lin(on, np.zeros_like(on)) - truth(on, 0)).max()) < 1e-6,
      "the linear TIN is exact on the contours themselves")

# ---- 3. the band statistic and the auto gate ---------------------------
dense = Surface("dense")
for r in np.arange(20.0, 101.0, 5.0):      # 1 ft apart in elevation
    dense.contours.append((ring(0, 0, float(r)), 550.0 + (r - 20.0) / 5.0))
Pd, Zd = dense.samples()
gx2, gy2 = np.meshgrid(np.linspace(-95, 95, 60), np.linspace(-95, 95, 60))
m = np.isfinite(LinearNDInterpolator(Pd, Zd)(gx2, gy2))
bd = label_band_ft(Pd, Zd, gx2[m], gy2[m])["median_ft"]
ms = np.isfinite(lin(gx2, gy2))
bs = label_band_ft(Ps, Zs, gx2[ms], gy2[ms])["median_ft"]
check(bd < AUTO_BAND_FT <= bs,
      f"the band statistic separates dense from sparse labels "
      f"({bd} ft vs {bs} ft, threshold {AUTO_BAND_FT})")

# auto acts on that: dense -> linear, sparse -> clamped
r_dense = cut_fill(dense, bowl_surface(
    [(r, 552.0 + (r - 20.0) / 5.0) for r in np.arange(20.0, 101.0, 5.0)]),
    ft_per_pt=1.0, cell_ft=4.0)
check(r_dense["surface_model"] == "linear",
      "auto keeps the linear TIN on a densely labelled sheet")
r_sparse = cut_fill(sparse, bowl_surface(
    [(r, truth(r, 0.0) + 2.0) for r in (20.0, 40.0, 60.0, 80.0, 100.0)]),
    ft_per_pt=1.0, cell_ft=4.0)
check(r_sparse["surface_model"] == "clamped_ct",
      "auto switches to the clamped smooth model on a sparsely labelled one")
check("auto" in r_sparse["surface_model_source"]
      and str(r_sparse["label_band_ft"]) in r_sparse["surface_model_why"],
      "auto says it chose, and quotes the measurement it chose on")

# every answer names its model, INCLUDING the plain linear default
for mdl in ("auto", "linear", "clamped_ct"):
    r = cut_fill(sparse, bowl_surface(
        [(rr_, truth(rr_, 0.0) + 2.0) for rr_ in (20.0, 40., 60., 80., 100.)]),
        ft_per_pt=1.0, cell_ft=4.0, surface_model=mdl)
    check(bool(r.get("surface_model") and r.get("surface_model_source")
               and r.get("surface_model_why")),
          f"the {mdl} answer names its surface model, source and reason")
check("error" in cut_fill(sparse, dense, 1.0, surface_model="magic"),
      "an unknown surface model is refused, not silently defaulted")

# ---- 4. a model change moves elevations, never the region ---------------
prop = bowl_surface([(r, truth(r, 0.0) + 2.0)
                     for r in (20.0, 40.0, 60.0, 80.0, 100.0)])
areas = {cut_fill(sparse, prop, 1.0, cell_ft=4.0,
                  surface_model=m)["area_sf"]
         for m in ("linear", "clamped_ct")}
check(len(areas) == 1,
      f"area_sf is identical across surface models ({areas.pop()} SF)")

# ---- 5. the infill refusal rule ----------------------------------------
# Parallel contours 1 ft apart in elevation. Three consecutive labelled ones
# (98, 99, 100) let the interval be READ as 1 ft off the labels themselves -
# two labels alone would only show the 4 ft span ACROSS the fan, which is
# not an interval, and contour_interval abstains there on purpose. Then a
# gap: three unlabelled lines between 100 and the next label, 104, so they
# can only be 101, 102, 103.
def hline(y):
    return np.column_stack([np.linspace(0.0, 200.0, 40), np.full(40, y)])


assigned = [{"chain_id": 8, "pts": hline(-20.0), "z": 98.0, "family": 7},
            {"chain_id": 9, "pts": hline(-10.0), "z": 99.0, "family": 7},
            {"chain_id": 1, "pts": hline(0.0), "z": 100.0, "family": 7},
            {"chain_id": 5, "pts": hline(40.0), "z": 104.0, "family": 7}]
cands = [{"chain_id": c, "pts": hline(y), "family": 7}
         for c, y in ((2, 10.0), (3, 20.0), (4, 30.0))]
r = infill_intervals(assigned, cands)
got = {x["chain_id"]: x["z"] for x in r["rows"]}
check(got == {2: 101.0, 3: 102.0, 4: 103.0},
      f"the monotone fan lands when the count matches dz/interval - 1 ({got})")
check(all(x["inferred"] and x["how"] == "interval-infill" for x in r["rows"]),
      "every fan row is flagged inferred at the source")
check(all("counted between labelled 100" in x["src"] for x in r["rows"]),
      "each row names the two labelled contours it was counted between")

# REFUSE: one sibling missing, so the count says 2 where 3 are needed
r2 = infill_intervals(assigned, [c for c in cands if c["chain_id"] != 3])
check(r2["rows"] == [] and r2["refused"]["count_mismatch"] > 0,
      "a missing sibling refuses the whole fan rather than guessing")
# REFUSE: an extra line in the band
r3 = infill_intervals(assigned, cands + [{"chain_id": 6, "pts": hline(25.0),
                                          "family": 7}])
check(r3["rows"] == [] and r3["refused"]["count_mismatch"] > 0,
      "an extra line in the band refuses the fan too")
# REFUSE: a sibling of a DIFFERENT family is not a countable sibling, and
# leaving it in the pool must not silently corrupt the count
r4 = infill_intervals(assigned, [dict(c, family=9) for c in cands])
check(r4["rows"] == [],
      "a candidate outside the labelled families is never assigned")
# the interval is READ, and a sheet note outranks the labels
check(contour_interval([100.0, 101.0, 102.0, 103.0])["interval_ft"] == 1.0,
      "the interval reads off the modal step between labelled elevations")
iv = contour_interval([100.0, 101.0, 102.0], note_ft=2.0)
check(iv["interval_ft"] == 2.0 and "note" in iv["source"],
      "a stated sheet interval outranks the modal step")
check(contour_interval([100.0])["interval_ft"] is None,
      "too few labelled elevations abstains instead of inventing an interval")

if FAILS:
    print(f"\n{len(FAILS)} check(s) failed")
    for f in FAILS:
        print("  - " + f)
    sys.exit(1)
print("\nall surface-model / interval-infill checks passed")
