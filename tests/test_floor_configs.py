"""THE VOLUME FLOOR, MEASURED IN EVERY PANEL CONFIGURATION AN OPERATOR CAN
PRODUCE - not in the one the first measurement happened to use.

WHY THIS FILE EXISTS (CLAUDE.md section 6). The evidence beside
MIN_DISTINCT_Z said "ELEVEN legitimate pairs pass ... the floor refuses ONE
of the twelve". That was measured with EVERY resolved spot grade sent to the
proposed surface. Which surface the spots land on is two clicks on the panel
(webui/app.js: state.ew.spotSide, and the per-tag checkboxes state.ew.spotOn,
whose default set is FG/ME/EG/PE), and under the panel's OWN default the
floor refuses THREE real client grading sheets that computed before - Barn
C4.1-NW, C4.2-NE and C4.4-SE - with a fourth, Home2 Suites C3 Grading,
refused in two of the five configurations. C4.2-NE and C4.4-SE had never
been measured at all.

Those refusals are CORRECT on the merits: in each of them the proposed
surface holds a single distinct elevation, which is the flat plane the floor
exists to stop. This is an evidence defect, and this file is the evidence.

The elevations below are the sheets' own, read live through
/earthwork/suggest on 2026-09-02 (28-sheet sweep). The GEOMETRY is
synthetic - concentric rings and interior points - because the floor reads
nothing but elevations, and that is what is being replayed.

    python tests/test_floor_configs.py
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import numpy as np  # noqa: E402

import takeoff_engine.earthwork as ew  # noqa: E402
from takeoff_engine.earthwork import Surface, cut_fill  # noqa: E402

SRC = (ROOT / "takeoff_engine" / "earthwork.py").read_text(encoding="utf-8")
FT_PER_PT = 40.0 / 72.0

# webui/app.js state.ew.spotOn, the panel's default tag set
DEFAULT_TAGS = {"FG", "ME", "EG", "PE"}

fails = []


def check(ok, msg):
    print(("ok: " if ok else "FAIL: ") + msg)
    if not ok:
        fails.append(msg)


# (sheet, existing contour elevations, proposed contour elevations,
#  resolved spot grades as (tag, z))
SHEETS = [
    ("Barn C4.1-NW", [4534.0, 4536.0, 4536.0, 4537.0, 4537.0, 4537.0, 4538.0],
     [4535.0], [("FF", 4538.52)]),
    ("Barn C4.2-NE", [4534.0, 4535.0, 4535.0, 4536.0, 4537.0, 4538.0],
     [4535.0], [("FF", 4538.52)]),
    ("Barn C4.3-SW", [4537.0, 4538.0, 4538.0, 4539.0, 4540.0],
     [4539.0, 4540.0, 4540.0], [("FF", 4538.52)]),
    ("Barn C4.4-SE",
     [4536.0, 4537.0, 4538.0, 4538.0, 4539.0, 4539.0, 4539.0, 4539.0],
     [4540.0], [("FF", 4538.52)]),
    ("Barn C4.0",
     [4534.0, 4535.0, 4535.0, 4536.0, 4536.0, 4536.0, 4536.0, 4537.0, 4537.0,
      4538.0, 4538.0, 4538.0, 4539.0, 4539.0, 4539.0],
     [4535.0, 4540.0, 4558.77], [("FF", 4538.52)]),
    ("dem_pad_5ft",
     [3375.0, 3380.0, 3380.0, 3385.0, 3390.0, 3395.0, 3395.0, 3400.0, 3400.0,
      3405.0, 3410.0, 3415.0, 3415.0, 3420.0, 3425.0],
     [3400.0, 3401.6, 3405.0],
     [("FG", 3401.6), ("FG", 3401.6), ("FG", 3401.6), ("FG", 3401.6)]),
    ("Home2 Suites C3", [411.0, 444.0, 444.0, 444.0, 444.0],
     [444.0, 444.0, 444.0, 444.0],
     [("FG", 5992.46), ("FL", 5991.96)]),
]

CONFIGS = ("contours", "spots_pr", "spots_ex", "allspots_pr", "allspots_ex")


def _ring(i, side=200.0, n=24):
    """a closed square ring, offset per contour so the TIN has real extent"""
    x0 = y0 = 0.0
    s = side + 6.0 * i
    t = np.linspace(0.0, 1.0, n, endpoint=False)
    xs, ys = [], []
    for u in t:
        if u < 0.25:
            xs.append(x0 + s * (u / 0.25)); ys.append(y0)
        elif u < 0.5:
            xs.append(x0 + s); ys.append(y0 + s * ((u - 0.25) / 0.25))
        elif u < 0.75:
            xs.append(x0 + s * (1 - (u - 0.5) / 0.25)); ys.append(y0 + s)
        else:
            xs.append(x0); ys.append(y0 + s * (1 - (u - 0.75) / 0.25))
    return np.column_stack([xs, ys])


def _surface(name, zs, spots):
    s = Surface(name)
    for i, z in enumerate(zs):
        s.contours.append((_ring(i), float(z)))
    for k, (_tag, z) in enumerate(spots):
        s.points.append((40.0 + 9.0 * k, 40.0 + 7.0 * k, float(z)))
    return s


def split(ex, pr, spots, cfg):
    dflt = [(t, z) for t, z in spots if t in DEFAULT_TAGS]
    if cfg == "contours":
        return ex, pr, [], []
    if cfg == "spots_pr":
        return ex, pr, [], dflt
    if cfg == "spots_ex":
        return ex, pr, dflt, []
    if cfg == "allspots_pr":
        return ex, pr, [], list(spots)
    return ex, pr, list(spots), []


# --------------------------------------------------------------------------
print("1. the floor's verdict on each sheet, in each panel configuration")
# --------------------------------------------------------------------------
# WHAT THE COMMENT BESIDE MIN_DISTINCT_Z NOW CLAIMS, sheet by sheet.
EXPECT = {
    #                   contours spots_pr spots_ex allspots_pr allspots_ex
    "Barn C4.1-NW":    (True,    True,    True,    False,      True),
    "Barn C4.2-NE":    (True,    True,    True,    False,      True),
    "Barn C4.3-SW":    (False,   False,   False,   False,      False),
    "Barn C4.4-SE":    (True,    True,    True,    False,      True),
    "Barn C4.0":       (False,   False,   False,   False,      False),
    "dem_pad_5ft":     (False,   False,   False,   False,      False),
    "Home2 Suites C3": (True,    False,   True,    False,      True),
}
for name, ex, pr, spots in SHEETS:
    got = []
    for cfg in CONFIGS:
        e, p, se, sp = split(ex, pr, spots, cfg)
        r = cut_fill(_surface("existing", e, se), _surface("proposed", p, sp),
                     FT_PER_PT)
        got.append("error" in r)
    want = list(EXPECT[name])
    check(got == want,
          f"{name}: refused in {[c for c, g in zip(CONFIGS, got) if g]}"
          + ("" if got == want
             else f"  EXPECTED {[c for c, w in zip(CONFIGS, want) if w]}"))

refused_default = [n for n, _e, _p, _s in SHEETS if EXPECT[n][1]]
check(refused_default == ["Barn C4.1-NW", "Barn C4.2-NE", "Barn C4.4-SE"],
      f"under the panel DEFAULT the floor refuses three real client grading "
      f"sheets: {refused_default}")
check(not any(EXPECT[n][3] for n, _e, _p, _s in SHEETS),
      "and under all-spots-to-proposed - the configuration the first "
      "measurement used - it refuses none of them, which is why the defect "
      "was invisible")

# --------------------------------------------------------------------------
print("2. each refusal is the flat-plane case, named on the proposed side")
# --------------------------------------------------------------------------
for name in refused_default:
    ex, pr, spots = next((e, p, s) for n, e, p, s in SHEETS if n == name)
    e, p, se, sp = split(ex, pr, spots, "spots_pr")
    r = cut_fill(_surface("existing", e, se), _surface("proposed", p, sp),
                 FT_PER_PT)
    surf = r.get("surface") or {}
    check(r.get("error_code") == "surface_no_relief"
          and surf.get("name") == "proposed"
          and surf.get("distinct_elevations") == 1,
          f"{name}: proposed holds ONE distinct elevation "
          f"({surf.get('distinct_elevations')}), so the refusal is right on "
          f"the merits - the evidence was what was wrong")

# --------------------------------------------------------------------------
print("3. two is still the right COUNT floor")
# --------------------------------------------------------------------------
# Barn C4.3-SW's proposed surface is 3 rows at 2 distinct elevations and it
# passes in every configuration; a floor of 3 would refuse it, and C4.1-NW
# and C4.4-SE with it.
ex, pr, spots = next((e, p, s) for n, e, p, s in SHEETS if n == "Barn C4.3-SW")
# by name, not by `from`: on 4010783 neither symbol exists and this file must
# fail on the VERDICTS above, not on an AttributeError
_basis = getattr(ew, "surface_basis", lambda s: {})
b = _basis(_surface("proposed", pr, []))
check(b.get("distinct_elevations") == 2 and b.get("relief_ft") == 1.0,
      f"Barn C4.3-SW proposed sits exactly on the floor: 2 distinct, "
      f"relief 1.0 ft (got {b.get('distinct_elevations')}, "
      f"{b.get('relief_ft')})")
_min = getattr(ew, "MIN_DISTINCT_Z", None)
check(_min == 2, f"MIN_DISTINCT_Z is 2 (got {_min})")

# --------------------------------------------------------------------------
print("4. the comment beside the constant says all of this")
# --------------------------------------------------------------------------
# to the ASSIGNMENT, not to the first mention: the block opens by naming
# MIN_DISTINCT_Z in prose, and slicing there cuts the measurement out
_assign = re.search(r"^MIN_DISTINCT_Z = 2", SRC, re.M)
BLOCK = SRC[SRC.find("# --- THE VOLUME FLOOR"):
            _assign.start() if _assign else len(SRC)]
for cfg in CONFIGS:
    check(cfg in BLOCK, f"the comment names the {cfg} configuration")
for name in ("C4.1-NW", "C4.2-NE", "C4.4-SE", "Home2 Suites C3"):
    check(name in BLOCK, f"...and the sheet that moves: {name}")
check("spotSide" in BLOCK and "spotOn" in BLOCK,
      "...and where in webui/app.js the configuration lives")
check("refuses ONE of the 12" not in BLOCK
      and "ELEVEN legitimate pairs pass" not in BLOCK,
      "the refuted 'ELEVEN pass, ONE of twelve refused' claim is gone")

print(("\n%d FAILED" % len(fails)) if fails else "\nall checks passed")
sys.exit(1 if fails else 0)
