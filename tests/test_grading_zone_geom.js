// The grading-zone client geometry, pinned.
//
// The zone modal's "existing from the sheet: N contours + M spots in zone"
// line counts membership with gzPtInPoly / gzChainTouches, and the plane
// design anchors on gzCentroid. gzPtInPoly is the same even-odd ray cast
// the server's _points_in_poly applies, so agreement with these hand
// fixtures IS agreement between the two sides about what "inside" means.
//
// webui/app.js is not a module and touches the DOM at load, so this test
// evals ONLY the block between the GZ-GEOM markers - kept pure (no DOM,
// no state.*), like WZ-MATH and TRENCH-MATH.
//
// Dependency-free like tests/test_gate.py:  node tests/test_grading_zone_geom.js

"use strict";
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "webui", "app.js"), "utf8");
const a = src.indexOf("// GZ-GEOM-BEGIN");
const b = src.indexOf("// GZ-GEOM-END");
if (a < 0 || b < 0 || b <= a) {
  console.error("FAIL: GZ-GEOM markers not found in webui/app.js");
  process.exit(1);
}
const G = new Function(src.slice(a, b) + `
  return { gzPtInPoly, gzCentroid, gzChainTouches };`)();

let failures = 0;
function check(cond, msg) {
  if (!cond) { failures++; console.error("FAIL:", msg); }
  else console.log("ok:", msg);
}
function near(x, y, tol, msg) {
  check(Math.abs(x - y) <= (tol == null ? 1e-9 : tol),
        `${msg} (got ${x}, want ${y})`);
}

const SQ = [[0, 0], [10, 0], [10, 10], [0, 10]];   // unit fixture

// ---- gzPtInPoly ---------------------------------------------------------
check(G.gzPtInPoly(5, 5, SQ), "centre of the square is inside");
check(!G.gzPtInPoly(15, 5, SQ), "point right of the square is outside");
check(!G.gzPtInPoly(5, -1, SQ), "point above the square is outside");
check(!G.gzPtInPoly(-0.001, 5, SQ), "just left of the edge is outside");
check(G.gzPtInPoly(0.001, 5, SQ), "just right of the left edge is inside");

// concave L-shape: the notch must read OUTSIDE even though the bbox holds it
const L = [[0, 0], [10, 0], [10, 4], [4, 4], [4, 10], [0, 10]];
check(G.gzPtInPoly(2, 8, L), "L-shape: lower arm is inside");
check(G.gzPtInPoly(8, 2, L), "L-shape: upper arm is inside");
check(!G.gzPtInPoly(8, 8, L), "L-shape: the notch is OUTSIDE (bbox would lie)");

// triangle with a horizontal edge (the dy==0 guard)
const T = [[0, 0], [10, 0], [5, 10]];
check(G.gzPtInPoly(5, 4, T), "triangle: interior point inside");
check(!G.gzPtInPoly(1, 6, T), "triangle: outside the slanted edge");

// ---- gzCentroid ---------------------------------------------------------
{
  const [cx, cy] = G.gzCentroid(SQ);
  near(cx, 5, 1e-9, "square centroid x = 5");
  near(cy, 5, 1e-9, "square centroid y = 5");
}
{
  // right triangle (0,0)(6,0)(0,6): centroid at (2, 2) by hand
  const [cx, cy] = G.gzCentroid([[0, 0], [6, 0], [0, 6]]);
  near(cx, 2, 1e-9, "triangle centroid x = 2");
  near(cy, 2, 1e-9, "triangle centroid y = 2");
}
{
  // AREA centroid, not vertex mean: same square with one edge subdivided
  // by 3 extra vertices must give the identical centroid
  const SQ2 = [[0, 0], [2.5, 0], [5, 0], [7.5, 0], [10, 0], [10, 10], [0, 10]];
  const [cx, cy] = G.gzCentroid(SQ2);
  near(cx, 5, 1e-9, "subdivided square centroid x still 5 (area, not vertex mean)");
  near(cy, 5, 1e-9, "subdivided square centroid y still 5");
}
{
  // degenerate (collinear) ring falls back to the vertex mean, no NaN
  const [cx, cy] = G.gzCentroid([[0, 0], [5, 5], [10, 10]]);
  near(cx, 5, 1e-9, "degenerate ring: vertex-mean fallback x");
  near(cy, 5, 1e-9, "degenerate ring: vertex-mean fallback y");
}

// ---- gzChainTouches ------------------------------------------------------
check(G.gzChainTouches([[20, 20], [5, 5]], SQ),
      "polyline with one vertex inside touches");
check(!G.gzChainTouches([[20, 20], [30, 30]], SQ),
      "polyline fully outside does not touch");
// documented limitation, pinned so a change to it is a conscious one: a
// segment CROSSING the square with both vertices outside does not count
// (vertex test only - the server samples the TIN, not this list)
check(!G.gzChainTouches([[-5, 5], [15, 5]], SQ),
      "crossing segment with no vertex inside: not counted (by design)");

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
