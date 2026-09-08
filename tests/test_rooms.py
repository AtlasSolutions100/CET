"""ROOMS: the enclosed floor area behind a click (takeoff_engine/rooms.py).

Synthetic plan, every number known by construction, at 1/4" = 1'-0"
(4 ft per paper inch -> 1 ft = 18 pt; a 20 ft room is 500 px at 100 dpi,
so the 2 px wall and 3 px seal are a few hundredths of a foot):

   room A  20 ft x 15 ft = 300 SF, perimeter 70 LF
   room B  12 ft x 15 ft = 180 SF, perimeter 54 LF
   a 3 ft door in the wall between them, drawn as a GAP in the wall line
   plus a swing-arc opening record (hinge, r = 3 ft, arc midpoint), the
   shape extract.door_swings emits
   a 4 ft x 4 ft closet drawn inside room A (a hole)

What is pinned:
  * the click in room A gives 300 SF within 1.5% (raster at 100 dpi),
    perimeter 70 LF within 2%, ONE door opening of 3 LF on its boundary,
    the closet as a hole of 16 SF that is NOT in the area
  * room B's click gives 180 SF and the same door
  * with the door record removed the two rooms MERGE (the gap is open) -
    that is the doorway bridging doing its job
  * a click on a wall line says so; a room with a wall style hidden LEAKS
    and says so, never returning the sheet as a room
  * the name is the room's label, not a dimension string
  * no scale -> pt only, sf None

Run:  python tests/test_rooms.py
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from takeoff_engine import rooms  # noqa: E402

FAILS: list[str] = []


def check(cond, msg):
    print(("  ok   " if cond else "  FAIL ") + msg)
    if not cond:
        FAILS.append(msg)


FT = 18.0                     # pt per ft at 1/4" = 1'-0" (4 ft per paper inch: 72 / 4)
W_PT, H_PT = 72 * 14, 72 * 10 # a 14x10 in sheet
OX, OY = 100.0, 100.0         # plan origin on the sheet


def P(xf, yf):
    return [OX + xf * FT, OY + yf * FT]


def chain(cid, pts, style=0):
    return {"chain_id": cid, "style_id": style, "points": pts}


def plan(with_door=True, wall_style=0, closet=True):
    # room A: (0,0)-(20,15); room B: (20,0)-(32,15); door at x=20, y 6..9
    chains = [
        chain(0, [P(0, 0), P(32, 0)], wall_style),            # top
        chain(1, [P(0, 15), P(32, 15)], wall_style),          # bottom
        chain(2, [P(0, 0), P(0, 15)], wall_style),            # left
        chain(3, [P(32, 0), P(32, 15)], wall_style),          # right
        chain(4, [P(20, 0), P(20, 6)], wall_style),           # party wall, above the door
        chain(5, [P(20, 9), P(20, 15)], wall_style),          # party wall, below the door
    ]
    if closet:
        chains.append(chain(6, [P(2, 2), P(6, 2), P(6, 6), P(2, 6), P(2, 2)], wall_style))
    # a dimension string wall-to-wall across room A on its own style (NOT a
    # wall - but it would cut the room in two if it were counted as one)
    chains.append(chain(7, [P(0, 12), P(20, 12)], 9))
    openings = []
    if with_door:
        # hinge at (20,6), r = 3 ft, leaf swings into room B: arc midpoint
        # 45 deg between the closed leaf (down the wall, +y) and open (+x)
        hx, hy, r = 20, 6, 3
        import math
        mid = (hx + r * math.cos(math.radians(45)), hy + r * math.sin(math.radians(45)))
        openings.append({"cx": P(hx, hy)[0], "cy": P(hx, hy)[1], "r": r * FT,
                         "mx": P(*mid)[0], "my": P(*mid)[1]})
    return {"chains": chains, "openings": openings,
            "page": {"width_pt": W_PT, "height_pt": H_PT},
            "scale": {"ft_per_paper_inch": 4.0}}


def words():
    def w(xf, yf, txt, h=4.0):
        x, y = P(xf, yf)
        return (x, y, x + 3.0 * len(txt), y + h, txt, 0, 0, 0)
    return [w(9, 8, "LIVING", 6.0), w(12, 8, "ROOM", 6.0), w(8, 13, "20'-0\"", 3.0),
            w(24, 8, "BEDROOM", 6.0), w(28, 8, "2", 6.0), w(3, 4, "CL", 3.0)]


# ---- room A --------------------------------------------------------------------
print("room A")
res = plan()
a = rooms.pick_room(res, words(), *P(10, 10), styles={0}, dpi=100)
check(a["ok"], "room A is enclosed: " + str(a.get("why")))
if a["ok"]:
    check(abs(a["area_sf"] - (300 - 16)) / 284 < 0.02,
          "area = 284 SF (300 less the 16 SF closet hole), got %.1f" % a["area_sf"])
    # the hole is the closet's interior plus its own wall ink (16 ft of 2 px
    # line at 100 dpi is about 1.3 SF), so 16 to 18.5
    check(a["n_holes"] == 1 and 16.0 <= a["holes_sf"] <= 18.5,
          "the closet is ONE hole of ~16 SF (interior + its wall ink), got %s / %s" % (a["n_holes"], a["holes_sf"]))
    check(abs(a["perim_lf"] - 70) / 70 < 0.02, "perimeter 70 LF, got %.1f" % a["perim_lf"])
    check(len(a["bridges_used"]) == 1 and abs(a["openings_lf"] - 3) < 0.2,
          "one 3 ft door on this boundary, got %d / %s" % (len(a["bridges_used"]), a["openings_lf"]))
    check(a["name"] == "LIVING ROOM", "named from the tallest label line: %r" % a["name"])
    check(4 <= len(a["polygon"]) <= 8, "polygon simplified to a few corners (%d)" % len(a["polygon"]))
    xs = [p[0] for p in a["polygon"]]
    check(abs(min(xs) - P(0, 0)[0]) < 3 and abs(max(xs) - P(20, 0)[0]) < 3,
          "polygon spans the room, not the doorway")

# ---- room B --------------------------------------------------------------------
print("room B")
b = rooms.pick_room(res, words(), *P(26, 4), styles={0}, dpi=100)
check(b["ok"] and abs(b["area_sf"] - 180) / 180 < 0.02, "room B = 180 SF, got %s" % b.get("area_sf"))
check(b["ok"] and abs(b["perim_lf"] - 54) / 54 < 0.02, "room B perimeter 54 LF, got %s" % b.get("perim_lf"))
check(b["ok"] and len(b["bridges_used"]) == 1, "the same door is on room B's boundary")
check(b["ok"] and b["name"] == "BEDROOM 2", "room B named BEDROOM 2, got %r" % b.get("name"))

# ---- the bridge is what separates them --------------------------------------------
print("doorway")
nodoor = plan(with_door=False)
m = rooms.pick_room(nodoor, words(), *P(10, 10), styles={0}, dpi=100)
check(m["ok"] and abs(m["area_sf"] - (480 - 16)) / 464 < 0.02,
      "without the door record the two rooms MERGE through the gap: %s SF" % m.get("area_sf"))
check(m["ok"] and len(m["bridges_used"]) == 0, "...and no opening is reported")
# the bridge picked the strike jamb (down the wall), not the open leaf
w, br = rooms.sealed_walls(res, {0}, 100)
check(len(br) == 1 and abs(br[0]["x1"] - P(20, 9)[0]) < 1.0 and abs(br[0]["y1"] - P(20, 9)[1]) < 1.0,
      "the bridge runs hinge -> strike jamb along the wall, got %s" % ((br[0]["x1"], br[0]["y1"]) if br else None,))

# ---- role assignment: only visible styles are walls -------------------------------
print("styles")
allst = rooms.pick_room(res, words(), *P(10, 10), styles=None, dpi=100)
# the click at y=10 ft lands in the 20 x 12 ft upper part: 240 SF less the
# closet's ~17 SF = ~223 SF, not the whole room
check(allst["ok"] and abs(allst["area_sf"] - 223) / 223 < 0.03,
      "with the dimension string counted as a wall the room is cut in two: ~223 SF, got %s" % allst.get("area_sf"))
leak = rooms.pick_room(res, words(), *P(10, 10), styles={9}, dpi=100)
check(not leak["ok"] and "not enclosed" in leak["why"], "walls hidden: the fill leaks and says so")
online = rooms.pick_room(res, words(), *P(0, 7), styles={0}, dpi=100)
check(not online["ok"] and "landed on a line" in online["why"], "a click on a wall says so")

# ---- no scale --------------------------------------------------------------------
print("scale")
ns = plan()
ns["scale"] = {}
n = rooms.pick_room(ns, words(), *P(10, 10), styles={0}, dpi=100)
check(n["ok"] and n["area_sf"] is None and n["area_pt2"] > 0, "no scale: pt only, sf None")

# ---- cache -----------------------------------------------------------------------
print("cache")
rooms._CACHE.clear()
k1 = rooms._cache_key("j", 0, 100, {0}, 1.0)
rooms.pick_room(res, [], *P(10, 10), styles={0}, dpi=100, cache_key=k1)
rooms.pick_room(res, [], *P(26, 4), styles={0}, dpi=100, cache_key=k1)
check(len(rooms._CACHE) == 1, "two clicks on one sheet rasterise once")
check(rooms._cache_key("j", 0, 100, {0, 1}, 1.0) != k1 and rooms._cache_key("j", 0, 100, {0}, 2.0) != k1,
      "a different style set or a re-detect is a different key")

print("\n%d FAILED" % len(FAILS) if FAILS else "\nall passed")
sys.exit(1 if FAILS else 0)
