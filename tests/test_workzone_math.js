// The WORK AREA quantity mask's clipping math, pinned.
//
// The mask's one promise is EXACTNESS: a chain counts by its length inside
// the union of operator-drawn rectangles, computed by clipping every
// polyline segment against the rect union (Liang-Barsky parameter
// intervals, merged) - never by midpoint voting. These tests check the
// clipped lengths against hand arithmetic to 1e-9, and pin the two
// structural properties every consumer leans on:
//
//   * overlapping boxes never double-count (intervals are MERGED);
//   * a zone covering the whole polyline returns inside == total EXACTLY
//     (the same float additions), which is what makes "zone over the whole
//     sheet = zero change in every number" true bit-for-bit - chainCountedPt
//     takes the fraction-1 fast path and returns chainLenPt untouched.
//
// webui/app.js is not a module and touches the DOM at load, so this test
// evals ONLY the block between the WZ-MATH markers - kept pure (no DOM,
// no state.*) for exactly this reason, like the TRENCH-MATH block.
//
// Dependency-free like tests/test_gate.py:  node tests/test_workzone_math.js

"use strict";
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "webui", "app.js"), "utf8");
const a = src.indexOf("// WZ-MATH-BEGIN");
const b = src.indexOf("// WZ-MATH-END");
if (a < 0 || b < 0 || b <= a) {
  console.error("FAIL: WZ-MATH markers not found in webui/app.js");
  process.exit(1);
}
const block = src.slice(a, b);
const W = new Function(block + `
  return { wzNorm, wzPtIn, wzSegT, wzPolyInsideLen, wzComplementRects };`)();

let failures = 0;
function check(cond, msg) {
  if (!cond) { failures++; console.error("FAIL:", msg); }
  else console.log("ok:", msg);
}
function near(x, y, tol, msg) {
  check(Math.abs(x - y) <= (tol == null ? 1e-9 : tol),
        `${msg} (got ${x}, want ${y})`);
}

const R = [[0, 0, 10, 10]];   // the unit fixture: a 10x10 box at the origin

// ---- wzSegT: hand-arithmetic exactness --------------------------------

// horizontal, entering and leaving: inside is x in [0,10] of a 20-long run
near(W.wzSegT(-5, 5, 15, 5, R) * Math.hypot(20, 0), 10, 1e-9,
     "horizontal crossing clips to exactly 10");

// diagonal corner-to-corner overshoot: x,y in [0,10] of (-1,-1)->(11,11)
near(W.wzSegT(-1, -1, 11, 11, R) * Math.hypot(12, 12), 10 * Math.SQRT2, 1e-9,
     "diagonal crossing clips to exactly 10*sqrt(2)");

// oblique through one corner region: t in [0.5, 0.75] of (-5,-5)->(5,15)
// (x reaches 0 at t=.5; y reaches 10 at t=.75) -> quarter of hypot(10,20)
near(W.wzSegT(-5, -5, 5, 15, R) * Math.hypot(10, 20), Math.sqrt(500) / 4, 1e-9,
     "corner clip is the exact t-interval piece");

// fully inside / fully outside
near(W.wzSegT(1, 1, 9, 9, R), 1, 0, "segment fully inside has T exactly 1");
near(W.wzSegT(11, 0, 20, 10, R), 0, 0, "segment fully outside has T exactly 0");

// a segment lying ON the box edge counts (boundary inclusive)
near(W.wzSegT(0, 0, 10, 0, R) * 10, 10, 1e-9, "edge-riding segment counts in full");

// axis-parallel degenerate slabs: dx == 0 outside / inside the x-slab
near(W.wzSegT(20, 0, 20, 10, R), 0, 0, "vertical segment outside the x-slab is 0");
near(W.wzSegT(5, -5, 5, 15, R) * 20, 10, 1e-9, "vertical segment clips y-slab exactly");

// zero-length segment scores by point-in-union
near(W.wzSegT(5, 5, 5, 5, R), 1, 0, "zero-length inside counts as 1");
near(W.wzSegT(15, 5, 15, 5, R), 0, 0, "zero-length outside counts as 0");

// ---- union semantics ----------------------------------------------------

// overlapping boxes merge - NEVER double-count the overlap
{
  const Z = [[0, 0, 10, 10], [5, 0, 15, 10]];
  near(W.wzSegT(0, 5, 15, 5, Z) * 15, 15, 1e-9,
       "overlapping boxes: 15-long run counts 15, not 20");
}

// disjoint boxes sum their pieces
{
  const Z = [[0, 0, 4, 10], [6, 0, 10, 10]];
  near(W.wzSegT(0, 5, 10, 5, Z) * 10, 8, 1e-9,
       "two disjoint boxes count 4 + 4 = 8 of a 10 run");
}

// ---- wzPolyInsideLen ----------------------------------------------------

// L-shaped polyline, half of each leg inside
{
  const m = W.wzPolyInsideLen([[-10, 5], [5, 5], [5, 20]], R, 1);
  near(m.total, 30, 1e-9, "polyline total is 15 + 15");
  near(m.inside, 10, 1e-9, "polyline inside is 5 + 5 exactly");
}

// vertical scale weighting: portion decided in page space, length weighted
{
  const m = W.wzPolyInsideLen([[0, -10], [0, 10]], R, 2);
  near(m.total, 40, 1e-9, "yScale=2 doubles the axis length");
  near(m.inside, 20, 1e-9, "half the run is inside, at the weighted length");
}

// THE zero-change invariant: a zone holding the whole polyline gives
// inside === total EXACTLY (identical additions), so the fraction is a
// float-exact 1 and chainCountedPt returns chainLenPt through its === 1
// fast path - a whole-sheet zone cannot move any number by even one ulp.
{
  const pts = [];
  let sd = 42;
  const rnd = () => (sd = (sd * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = 0; i < 200; i++) pts.push([rnd() * 100, rnd() * 100]);
  const m = W.wzPolyInsideLen(pts, [[-1, -1, 101, 101]], 1);
  check(m.inside === m.total && m.total > 0,
        "whole-sheet zone: inside === total, bit for bit");
}

// ---- wzNorm -------------------------------------------------------------
{
  const z = W.wzNorm([[10, 8, 2, 3], [1, 1, 1, 5], [0, 0, NaN, 5],
                      [1, 2, 3], "junk", [4, 4, 6, 6]]);
  check(z.length === 2, "wzNorm keeps only real areas (got " + z.length + ")");
  check(z[0][0] === 2 && z[0][1] === 3 && z[0][2] === 10 && z[0][3] === 8,
        "wzNorm sorts swapped corners");
}

// ---- wzComplementRects ----------------------------------------------------
// complement area + union area == page area, with overlapping zones
{
  const Z = [[2, 2, 5, 5], [4, 3, 8, 6]];
  const comp = W.wzComplementRects(Z, 10, 8);
  const area = (rs) => rs.reduce((s, r) => s + (r[2] - r[0]) * (r[3] - r[1]), 0);
  // union area by hand: 9 + 12 - 2 (the [4,3,5,5] overlap) = 19
  near(area(comp), 10 * 8 - 19, 1e-9,
       "complement area is page minus the UNION (overlap not double-cut)");
  // no complement rect may reach inside the union: probe every rect center
  for (const r of comp) {
    const cx = (r[0] + r[2]) / 2, cy = (r[1] + r[3]) / 2;
    check(!W.wzPtIn(cx, cy, Z), `complement rect center (${cx},${cy}) outside union`);
  }
}
// no zones -> the whole page is complement (the wash never fires then,
// but the function must still be honest)
{
  const comp = W.wzComplementRects([], 10, 8);
  check(comp.length === 1 && comp[0][2] === 10 && comp[0][3] === 8,
        "empty zone list complements to the full page");
}

if (failures) { console.error(failures + " failure(s)"); process.exit(1); }
console.log("all workzone math tests passed");
