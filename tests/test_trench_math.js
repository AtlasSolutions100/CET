// The trench calculator's arithmetic, pinned (audit items 6a and 6b).
//
// Both defects were MEASURED before the fix, so both are pinned with the
// measured numbers:
//
//   6a  100 LF at a constant 1.0 ft invert, 6-in pipe, default rules:
//       the old bedding envelope integral ignored that the envelope cannot
//       exceed the hole and returned bedding = 137% of the dig. The fix
//       makes the envelope a z-sub-range of the hole, so bed + backfill +
//       pipe == dig exactly whenever the pipe fits, and nothing floors
//       below zero when it does not.
//
//   6b  the N=60 slices along a sloped run each snapped WHOLE to their
//       midpoint's rule band - a staircase error. Fixed by splitting
//       every slice at rule-edge crossings with exact midpoint pieces.
//       The 4.00 -> 4.01 ft step ITSELF stays: trench pay width is the
//       full bottom width for the run's depth class (a hole cannot be
//       narrower above than below, and the band-by-band alternative
//       reads LOW into a bid), so a depth-class edge is a price step by
//       design - the same shape as Pierce's 2-ft pricing bands.
//
// webui/app.js is not a module and touches the DOM at load, so this test
// evals ONLY the block between the TRENCH-MATH markers - that block is
// kept pure (no DOM, no state.*) for exactly this reason.
//
// Dependency-free like tests/test_gate.py:  node tests/test_trench_math.js

"use strict";
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "webui", "app.js"), "utf8");
const a = src.indexOf("// TRENCH-MATH-BEGIN");
const b = src.indexOf("// TRENCH-MATH-END");
if (a < 0 || b < 0 || b <= a) {
  console.error("FAIL: TRENCH-MATH markers not found in webui/app.js");
  process.exit(1);
}
const block = src.slice(a, b);
const T = new Function(block + `
  return { trNormRules, trClrAt, trHoleArea, trEnvArea, trRunVolumes,
           trTotals, trCY, trDepthBands };`)();

let failures = 0;
function check(cond, msg) {
  if (!cond) { failures++; console.error("FAIL:", msg); }
  else console.log("ok:", msg);
}
function near(x, y, tol, msg) {
  check(Math.abs(x - y) <= (tol == null ? 1e-9 : tol),
        `${msg} (got ${x}, want ${y})`);
}

const RULES = [        // the panel's defaults, verbatim
  { to_ft: 2, clr_in: 6 },
  { to_ft: 4, clr_in: 12 },
  { to_ft: 99, clr_in: 18 },
];
const OD = 0.5;        // 6-in pipe in ft
const N = 60;          // same slice count the UI uses
const rs = T.trNormRules(RULES);

// ---- 6a: bedding can no longer exceed the hole --------------------------
// 100 LF at constant 1.0 ft. Hand arithmetic: width in the 0-2 ft band is
// 0.5 + 2*0.5 = 1.5 ft; dig = 1.5 * 1.0 * 100 = 150 cf. The envelope is the
// bottom min(0.5 + 2*0.5, 1.0) = 1.0 ft of the hole = the whole hole =
// 150 cf. pipe = pi * 0.25^2 * 100 = 19.635 cf. bed = 130.365 cf,
// backfill = 0, and the three parts sum to the dig.
{
  const v = T.trRunVolumes(rs, OD, 100, 1.0, 1.0, N);
  const pipe = Math.PI * 0.25 ** 2 * 100;
  const t = T.trTotals(v.dig, v.env, pipe);
  near(t.dig, 150, 1e-9, "6a dig = 150 cf at 100 LF x 1.0 ft");
  near(t.bed, 150 - pipe, 1e-9, "6a bed = dig - pipe (envelope clamped to the hole)");
  near(t.backfill, 0, 1e-9, "6a backfill = 0 when bedding fills the hole");
  near(t.bed + t.backfill + pipe, t.dig, 1e-6, "6a INVARIANT bed+backfill+pipe == dig");
  check(t.bed < t.dig, "6a bedding strictly inside the dig (was 137% of it)");
  // displayed figures: dig 5.6 CY, bedding 4.8 CY, backfill 0 CY
  near(T.trCY(t.dig), 5.6, 0, "6a display dig 5.6 CY");
  near(T.trCY(t.bed), 4.8, 0, "6a display bedding 4.8 CY");
}

// ---- the depth-class step is pinned as INTENDED behavior ------------------
// Full bottom width per depth class: constant 4.00 ft is in the 2-4 band
// (w = 2.5 ft) -> 10.0 sf; 4.01 ft is in the >4 band (w = 3.5 ft) ->
// 14.035 sf. The step at the class edge is the pay convention, not a bug;
// both sides are pinned so neither silently drifts.
{
  const d400 = T.trRunVolumes(rs, OD, 100, 4.00, 4.00, N).dig;
  const d401 = T.trRunVolumes(rs, OD, 100, 4.01, 4.01, N).dig;
  near(d400, 1000, 1e-9, "class step: dig(4.00) = 1000 cf per 100 LF (2-4 ft band)");
  near(d401, 1403.5, 1e-9, "class step: dig(4.01) = 1403.5 cf per 100 LF (>4 ft band)");
}

// ---- 6b: in-slice split is exact on a sloped run --------------------------
// d0=0 -> d1=7 over 100 LF puts the rule edges at x = 2/7 and 4/7, inside
// slices - the OLD code snapped whole slices to their midpoint band. Exact
// integral by hand: A(d) = 1.5d (d<=2), 2.5d (2<d<=4), 3.5d (d>4);
// integral A dd = 3 + 15 + 57.75 = 75.75 sf*ft over d in [0,7], times
// dx/dd = 100/7 -> 7575/7 = 1082.142857... cf.
{
  const v = T.trRunVolumes(rs, OD, 100, 0, 7, N);
  near(v.dig, 7575 / 7, 1e-6, "6b sloped-run dig exact despite mid-slice rule edges");
}

// ---- 6a edge: a pipe that cannot fit its trench never goes negative ------
// 24-in pipe, 0.5 ft invert: dig = (2+2*0.5)*0.5*100 = 150 cf but the pipe
// alone is 314 cf. Zeros, not negatives; bed+backfill stays <= dig.
{
  const v = T.trRunVolumes(rs, 2.0, 100, 0.5, 0.5, N);
  const pipe = Math.PI * 1 ** 2 * 100;
  const t = T.trTotals(v.dig, v.env, pipe);
  near(t.bed, 0, 1e-9, "6a oversize pipe: bed floors at 0");
  near(t.backfill, 0, 1e-9, "6a oversize pipe: backfill floors at 0");
  check(t.bed + t.backfill <= t.dig + 1e-9, "6a oversize pipe: bed+backfill <= dig");
}

// ---- deep run: envelope stays a sub-range of the hole ---------------------
{
  const v = T.trRunVolumes(rs, OD, 100, 10, 10, N);
  const pipe = Math.PI * 0.25 ** 2 * 100;
  const t = T.trTotals(v.dig, v.env, pipe);
  near(t.dig, 3500, 1e-9, "deep dig = 35.0 sf x 100 LF (full width, >4 ft class)");
  near(v.env, 1225, 1e-9, "deep envelope = bottom 3.5 ft of the hole (12.25 sf)");
  near(t.bed + t.backfill + pipe, t.dig, 1e-6, "deep INVARIANT bed+backfill+pipe == dig");
}

// ---- rules table order must not matter ------------------------------------
{
  const shuffled = T.trNormRules([RULES[2], RULES[0], RULES[1]]);
  const v1 = T.trRunVolumes(rs, OD, 100, 0, 7, N);
  const v2 = T.trRunVolumes(shuffled, OD, 100, 0, 7, N);
  near(v2.dig, v1.dig, 1e-9, "reordered rule rows give identical dig");
  near(v2.env, v1.env, 1e-9, "reordered rule rows give identical envelope");
}

// ---- Pierce depth bands ----------------------------------------------------
// d0=2 -> d1=10 over 300 LF, edges 6 then 2-ft steps. Hand arithmetic:
// d(x) = 2+8x. d<=6 at x<=0.5 -> 150 LF; 6<d<=8 at 0.5<x<=0.75 -> 75 LF;
// 8<d<=10 at 0.75<x<=1 -> 75 LF. Sum = 300.
{
  const bt = T.trDepthBands(300, 2, 10, 6, 2, 64);
  check(bt.rows.length === 3, "bands: 3 rows for 2->10 ft");
  near(bt.rows[0].lf, 150, 1e-9, "bands: 0-6 ft = 150 LF");
  near(bt.rows[1].lf, 75, 1e-9, "bands: 6-8 ft = 75 LF");
  near(bt.rows[2].lf, 75, 1e-9, "bands: 8-10 ft = 75 LF");
  near(bt.rows.reduce((s, r) => s + r.lf, 0), 300, 1e-9, "bands: LF sums to the run");
  const rev = T.trDepthBands(300, 10, 2, 6, 2, 64);
  near(rev.rows[0].lf, 150, 1e-9, "bands: reversed profile identical (0-6)");
  near(rev.rows[2].lf, 75, 1e-9, "bands: reversed profile identical (8-10)");
}
// constant 7 ft: everything in 6-8; constant 6 ft: ON the edge -> shallower band
{
  const c7 = T.trDepthBands(300, 7, 7, 6, 2, 64);
  near(c7.rows[0].lf, 0, 1e-9, "bands: constant 7 ft leaves 0-6 empty");
  near(c7.rows[1].lf, 300, 1e-9, "bands: constant 7 ft all in 6-8");
  const c6 = T.trDepthBands(300, 6, 6, 6, 2, 64);
  near(c6.rows[0].lf, 300, 1e-9, "bands: exactly 6 ft counts in 0-6 (edge -> shallower)");
  check(c6.rows.length === 1, "bands: constant 6 ft needs one row");
}
// Rick's ceiling: 0 -> 24 ft is 0-6 plus nine 2-ft rows = 10 rows, no cap hit
{
  const bt = T.trDepthBands(300, 0, 24, 6, 2, 64);
  check(bt.rows.length === 10 && !bt.truncated, "bands: 0-24 ft = 10 rows, untruncated");
  near(bt.rows.reduce((s, r) => s + r.lf, 0), 300, 1e-9, "bands: 0-24 LF sums to the run");
}
// junk edges refuse instead of rendering nonsense
{
  check(T.trDepthBands(300, 2, 10, 0, 2, 64) === null, "bands: zero first edge refused");
  check(T.trDepthBands(300, 2, 10, 6, -1, 64) === null, "bands: negative step refused");
}

if (failures) { console.error(`\n${failures} FAILURE(S)`); process.exit(1); }
console.log("\nall trench math checks passed");
