"""/earthwork/map must REFUSE what the floor refuses, not crash on it.

THE DEFECT (measured live 2026-09-02 on :9901 vs :9902, dem_hurricane_bench_
a_pad_2ft_outline p0). When the volume floor trips AND the body carries layer
stacks over an area, `_earthwork_run` answers the layers-only dict - stripping
is area x depth and owes nothing to a TIN, so those slabs still compute. That
dict has no "grid" key, and `earthwork_map` did `result.pop("grid")` on it:

    KeyError: 'grid'  ->  HTTP 500, body "Internal Server Error" (text/plain)

POST /earthwork/map with existing=[{205, 324.0}], proposed=[{214, 826.0}],
a 6-in topsoil strip and strip_area_sf 50000 returned 500 on e6ac867 and
200 image/png on 4010783 - a NEW crash on a body the base served.

In the panel it was worse than a crash: ewFetchMap's error branch could not
parse a text/plain body, so #ewResult became "map failed (500)" and the
floor's whole explanation - which surface, what it held, what to do - was
wiped off the screen by a status code.

This calls the ROUTE FUNCTIONS, not the source text: a source test cannot
tell a KeyError from a refusal. No PDF and no service - a synthetic job dir
with a hand-built result.

    python tests/test_ew_map_refusal.py
"""
import json
import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
_TMP = tempfile.mkdtemp(prefix="ewmap_")
os.environ["TAKEOFF_JOBS_DIR"] = str(Path(_TMP) / "jobs")
os.environ["TAKEOFF_LEDGER_DIR"] = str(Path(_TMP) / "ledger")

import server  # noqa: E402
from fastapi import HTTPException  # noqa: E402

fails = []


def check(ok, msg):
    print(("ok: " if ok else "FAIL: ") + msg)
    if not ok:
        fails.append(msg)


# --- a job with two crossing contours, 40 ft to the paper inch -------------
JID = "ewmaptest01"
d = server._job_dir(JID)
d.mkdir(parents=True, exist_ok=True)


def _box(x0, y0, x1, y1):
    return [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]


RESULT = {
    "scale": {"ft_per_paper_inch": 40.0, "source": "test"},
    "chains": [
        {"chain_id": 205, "points": _box(100, 100, 160, 160), "length_pt": 240.0},
        {"chain_id": 214, "points": _box(110, 110, 150, 150), "length_pt": 160.0},
        {"chain_id": 206, "points": _box(102, 102, 158, 158), "length_pt": 224.0},
        {"chain_id": 215, "points": _box(112, 112, 148, 148), "length_pt": 144.0},
    ],
}
(d / "p0_result.json").write_text(json.dumps(RESULT))
server.JOBS[JID] = {"path": str(d / "nosuch.pdf"), "status": {}, "owner": None}


def body(**kw):
    return server.EarthworkBody(**kw)


def call(fn, b):
    """(status, payload) for a route function, whatever it does."""
    try:
        r = fn(JID, 0, b)
    except HTTPException as e:
        return e.status_code, e.detail
    except Exception as e:                      # the defect: KeyError -> 500
        return 500, "%s: %s" % (type(e).__name__, e)
    return 200, r


# --- 1. the floor trips and layer stacks exist ----------------------------
print("1. the floor trips AND the body carries layer stacks (the 500)")
FLAT = dict(existing=[{"chain_id": 205, "z": 324.0}],
            proposed=[{"chain_id": 214, "z": 826.0}],
            existing_layers=[{"name": "Strip Topsoil", "thickness_in": 6.0}],
            strip_area_sf=50000.0)

st, payload = call(server.earthwork_calc, body(**FLAT))
check(st == 200, "/earthwork still answers 200 (got %s)" % st)
j = json.loads(bytes(payload.body)) if st == 200 else {}
check(j.get("layers_only") is True,
      "...as a layers-only answer, so the strip slabs are not lost")
check(j.get("cut_fill_error_code") == "surface_no_relief",
      "...naming the guard that refused the volume (got %r)"
      % j.get("cut_fill_error_code"))
check("cut_yd3" not in j and "fill_yd3" not in j,
      "...with no cut/fill volume in it")

st, detail = call(server.earthwork_map, body(**FLAT))
check(st != 500, "/earthwork/map does not 500 (got %s: %r)" % (st, detail))
check(st == 400, "/earthwork/map refuses with 400 (got %s)" % st)
check(isinstance(detail, dict),
      "...and the detail is the STRUCTURED refusal, not a bare string")
if isinstance(detail, dict):
    check(detail.get("code") == "surface_no_relief",
          "...code names the guard (got %r)" % detail.get("code"))
    check("324" in str(detail.get("message", "")),
          "...message carries the floor's own sentence")
    check((detail.get("surface") or {}).get("name") == "existing",
          "...surface names WHICH side was short")
    check("existing" in (detail.get("basis") or {})
          and "proposed" in (detail.get("basis") or {}),
          "...basis carries BOTH sides so the panel can compare them")

# --- 2. it is the SAME refusal the volume route gives ---------------------
print("2. the two routes answer the same refusal, from the same builder")
BARE = dict(existing=[{"chain_id": 205, "z": 324.0}],
            proposed=[{"chain_id": 214, "z": 826.0}])
st_v, det_v = call(server.earthwork_calc, body(**BARE))
st_m, det_m = call(server.earthwork_map, body(**BARE))
check(st_v == 400 and st_m == 400,
      "with no layer stack both routes refuse (got %s / %s)" % (st_v, st_m))
check(det_v == det_m,
      "and the two details are identical, field for field")

# --- 3. a real pair still gets a map -------------------------------------
print("3. a surface pair with relief still gets its PNG")
GOOD = dict(existing=[{"chain_id": 205, "z": 100.0},
                      {"chain_id": 206, "z": 102.0}],
            proposed=[{"chain_id": 214, "z": 104.0},
                      {"chain_id": 215, "z": 106.0}])
st, resp = call(server.earthwork_map, body(**GOOD))
check(st == 200, "the map route still renders (got %s: %r)" % (st, resp))
if st == 200:
    check(getattr(resp, "media_type", "") == "image/png",
          "...a PNG (got %r)" % getattr(resp, "media_type", None))
    check(bytes(resp.body)[:4] == b"\x89PNG", "...with a PNG magic number")
    check("X-Map-Bbox" in resp.headers,
          "...and its page-pt registration header")

print(("\n%d FAILED" % len(fails)) if fails else "\nall checks passed")
sys.exit(1 if fails else 0)
