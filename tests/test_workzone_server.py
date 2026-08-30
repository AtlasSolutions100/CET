"""The approve route's work-area clip (_wz_norm/_wz_seg_t/_wz_frac).

These three mirror wzNorm/wzSegT/wzChainFrac in webui/app.js: the panel the
operator reads and the export the operator signs must clip a chain the SAME
way, or the approved number and the exported number silently diverge - the
exact defect class the work-area feature exists to prevent. The cases here
are the same hand-arithmetic fixtures tests/test_workzone_math.js pins on
the JS side, so agreement with these numbers IS agreement between the two
implementations, to 1e-9.

Also pinned: the zero-change invariant. _wz_frac over a zone that holds the
whole polyline accumulates `inside` and `total` from IDENTICAL additions,
so the fraction is float-exactly 1.0 and the exported quantity is the
engine's own length_pt untouched - a whole-sheet zone cannot move an export
by one ulp.

Dependency-free like tests/test_gate.py:  python tests/test_workzone_server.py
"""

import math
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

# server.py resolves and creates JOBS_DIR at import time - point it
# somewhere disposable first (same pattern as tests/test_calcstate.py)
os.environ["TAKEOFF_JOBS_DIR"] = tempfile.mkdtemp(prefix="workzone_test_")

import server  # noqa: E402

R = [(0.0, 0.0, 10.0, 10.0)]

CHECKS = []


def near(got, want, msg, tol=1e-9):
    CHECKS.append((abs(got - want) <= tol, msg, got, want))


def ok(cond, msg):
    CHECKS.append((cond, msg, None, None))


# ---- the same hand-arithmetic fixtures the JS test pins -----------------
near(server._wz_seg_t(-5, 5, 15, 5, R) * math.hypot(20, 0), 10,
     "horizontal crossing clips to exactly 10")
near(server._wz_seg_t(-1, -1, 11, 11, R) * math.hypot(12, 12),
     10 * math.sqrt(2), "diagonal crossing clips to exactly 10*sqrt(2)")
near(server._wz_seg_t(-5, -5, 5, 15, R) * math.hypot(10, 20),
     math.sqrt(500) / 4, "corner clip is the exact t-interval piece")
near(server._wz_seg_t(1, 1, 9, 9, R), 1, "fully inside is exactly 1", 0)
near(server._wz_seg_t(11, 0, 20, 10, R), 0, "fully outside is exactly 0", 0)
near(server._wz_seg_t(0, 0, 10, 0, R) * 10, 10,
     "edge-riding segment counts in full (boundary inclusive)")
near(server._wz_seg_t(20, 0, 20, 10, R), 0,
     "vertical segment outside the x-slab is 0", 0)
near(server._wz_seg_t(5, -5, 5, 15, R) * 20, 10,
     "vertical segment clips the y-slab exactly")
near(server._wz_seg_t(5, 5, 5, 5, R), 1, "zero-length inside counts as 1", 0)
near(server._wz_seg_t(15, 5, 15, 5, R), 0, "zero-length outside counts as 0", 0)

# union semantics: overlap merged, disjoint summed
near(server._wz_seg_t(0, 5, 15, 5,
                      [(0, 0, 10, 10), (5, 0, 15, 10)]) * 15, 15,
     "overlapping boxes never double-count")
near(server._wz_seg_t(0, 5, 10, 5,
                      [(0, 0, 4, 10), (6, 0, 10, 10)]) * 10, 8,
     "disjoint boxes sum their pieces")

# ---- _wz_frac -------------------------------------------------------------
near(server._wz_frac([(-10, 5), (5, 5), (5, 20)], R), 10.0 / 30.0,
     "L-polyline: 10 of 30 inside")
near(server._wz_frac([(0, -10), (0, 10)], R, ratio=2.0), 0.5,
     "vertical-scale weighting: portion decided in page space")
ok(server._wz_frac([(1, 1), (9, 9)], []) == 1.0,
   "no zones = fraction exactly 1.0 (mask off)")

# the zero-change invariant, float-exact
pts, sd = [], 42
for _ in range(200):
    sd = (sd * 1103515245 + 12345) % 2147483648
    x = sd / 2147483648 * 100
    sd = (sd * 1103515245 + 12345) % 2147483648
    pts.append((x, sd / 2147483648 * 100))
ok(server._wz_frac(pts, [(-1, -1, 101, 101)]) == 1.0,
   "whole-sheet zone: fraction is exactly 1.0, bit for bit")

# ---- _wz_norm ---------------------------------------------------------------
z = server._wz_norm([[10, 8, 2, 3], [1, 1, 1, 5], [0, 0, float("nan"), 5],
                     [1, 2, 3], "junk", [4, 4, 6, 6]])
ok(len(z) == 2, "junk and zero-area rows dropped (got %d)" % len(z))
ok(z[0] == (2, 3, 10, 8), "swapped corners sorted (got %r)" % (z[0],))

# ---- report ---------------------------------------------------------------
failures = 0
for cond, msg, got, want in CHECKS:
    if cond:
        print("ok:", msg)
    else:
        failures += 1
        print("FAIL:", msg, "" if got is None else "(got %r, want %r)" % (got, want))
if failures:
    sys.exit("%d failure(s)" % failures)
print("all workzone server tests passed")
