// THE COVERAGE STATEMENT MUST COUNT THE ROWS THAT ARE THERE NOW.
//
// THE DEFECT (review finding R1, 2026-09-03). `state.ew.cov` is the dict
// /earthwork/suggest served, captured once in ewFetchSuggest. Three
// surfaces read it verbatim - the panel block above the rows, the
// `ew-basis-cov` lines beside the volume, and the printed report's CONTOUR
// COVERAGE note - while ONLY the chips were counted off the live rows.
// Measured live on the DEM pad_1ft sheet at b5f890f: as served the block
// reads "144 contour lines. 101 carry an elevation ... 43 carry none at
// all"; after twenty rows are deleted with the rows' own x, state.ew.rows
// holds 81 and the chips read "All 124 ... No elevation 43" while the
// block one line above still says 144 / 101 / 43. Paper said 101 when 81
// were true: a coverage number that OVERSTATES, the one direction
// CLAUDE.md s5 forbids.
//
// The second half of the same defect: those twenty contours then appeared
// in NO chip at all. They were not rows any more, and they had never been
// in the served `unelevated` list, so the review surface built to make
// doubtful contours findable could no longer show them.
//
// WHAT THIS PINS
//  1. ewCoverageLive() re-derives contour_chains / with_elev / no_elev and
//     both footages from the rows handed to it, over the denominator the
//     server names in two halves (`elevated` + `unelevated`).
//  2. Deleting a row moves it from "carries an elevation" to "carries none
//     at all" - the count of contour lines does NOT drop, because deleting
//     a row does not rub the line off the sheet.
//  3. A row with no elevation typed yet (z NaN) counts as no-elevation, so
//     the sentence and the "No elevation" chip cannot disagree.
//  4. A row on a chain outside the denominator is counted and SAID
//     (rows_outside), so the "All" chip reconciles with the sentence.
//  5. All three surfaces read the one live source, and ewStubs() is built
//     from the whole denominator so a deleted row comes back as a stub.
//
// Dependency-free like tests/test_ew_review.js:
//    node tests/test_ew_live_coverage.js
"use strict";
const fs = require("fs");
const path = require("path");
const R = (...p) => fs.readFileSync(path.join(__dirname, "..", ...p), "utf8");
const js = R("webui", "app.js");

let fails = 0;
const check = (ok, msg) => {
  if (ok) console.log("ok: " + msg);
  else { fails++; console.error("FAIL: " + msg); }
};
const eq = (got, want, msg) =>
  check(got === want, msg + "  (got " + JSON.stringify(got) + ")");

const a = js.indexOf("// EW-REVIEW-BEGIN");
const b = js.indexOf("// EW-REVIEW-END");
if (a < 0 || b < 0 || b <= a) {
  console.error("FAIL: EW-REVIEW markers not found in webui/app.js");
  process.exit(1);
}
let T;
try {
  T = new Function(js.slice(a, b)
    + "\n  return { ewCoverageLive, ewCoverageText, ewCoverageNote };")();
} catch (e) {
  console.error("FAIL: the pure block does not define ewCoverageLive - the "
    + "coverage statement is still whatever the route said once ("
    + e.message + ")");
  process.exit(1);
}
if (typeof T.ewCoverageLive !== "function") {
  console.error("FAIL: ewCoverageLive is not a function");
  process.exit(1);
}

// The DEM pad_1ft sheet's shape, scaled down to something readable: six
// contour lines, four of them elevated. Lengths are paper points.
const ELEV = [{ chain_id: 10, style_id: 5, length_pt: 400.0 },
              { chain_id: 11, style_id: 5, length_pt: 300.0 },
              { chain_id: 12, style_id: 5, length_pt: 200.0 },
              { chain_id: 13, style_id: 5, length_pt: 100.0 }];
const UNEL = [{ chain_id: 20, style_id: 5, length_pt: 60.0 },
              { chain_id: 21, style_id: 5, length_pt: 40.0 }];
const DEN = ELEV.concat(UNEL);
const SERVED = {
  contour_chains: 6, contour_len_pt: 1100.0,
  with_elev: 4, with_elev_len_pt: 1000.0,
  no_elev: 2, no_elev_len_pt: 100.0,
  rows: 4, rows_outside: 0, unclassed_chains: 0, unclassed_len_pt: 0,
  by_how: {}, families: [5], elevated: ELEV, unelevated: UNEL,
};
const row = (cid, z) => ({ chain_id: cid, z: z, how: "inline" });
const ROWS = [row(10, 100), row(11, 101), row(12, 102), row(13, 103)];

// 1. as served, the live arithmetic reproduces the route's own numbers
{
  const L = T.ewCoverageLive(SERVED, ROWS, DEN);
  eq(L.contour_chains, 6, "as served: the contour count is the route's");
  eq(L.with_elev, 4, "as served: so is the elevated count");
  eq(L.no_elev, 2, "as served: and the no-elevation count");
  eq(L.with_elev_len_pt, 1000.0, "as served: and the elevated footage");
  eq(L.no_elev_len_pt, 100.0, "as served: and the footage with none");
  eq(L.rows_outside, 0, "as served: no row sits outside the denominator");
}

// 2. THE DEFECT. Delete two rows with the row's own x; the sentence must
//    follow the list, and the two deleted contours must land in "no
//    elevation" rather than vanishing from every count.
{
  const kept = ROWS.filter(r => r.chain_id !== 12 && r.chain_id !== 13);
  const L = T.ewCoverageLive(SERVED, kept, DEN);
  eq(L.contour_chains, 6,
    "after two deletions the sheet still draws six contour lines");
  eq(L.with_elev, 2, "...only two of them still carry an elevation");
  eq(L.no_elev, 4, "...and four now carry none - the deleted two are HERE");
  eq(L.with_elev_len_pt, 700.0, "...the elevated footage follows the rows");
  eq(L.no_elev_len_pt, 400.0, "...and so does the footage with none");
  check(L.with_elev + L.no_elev === L.contour_chains,
    "...the two halves still add up to the whole");
  check(L.with_elev_len_pt + L.no_elev_len_pt === L.contour_len_pt,
    "...and so do the two footages");
  const s = T.ewCoverageText(L, null).join(" ");
  check(/6 contour lines/.test(s) && /2 carry an elevation/.test(s)
     && /4 carry none at all/.test(s),
    "the SENTENCE says 6 / 2 / 4, not the served 6 / 4 / 2");
  const note = T.ewCoverageNote(L, null, 400).join(" ");
  check(/2 carry an elevation/.test(note)
     && !/4 carry an elevation/.test(note),
    "and the printed report's note says the same, from the same source - "
    + "a stale copy on paper is the whole of the defect");
}

// 3. a row whose elevation has not been typed yet is a row with NO
//    elevation, the same as the "No elevation" chip counts it
{
  const rows = ROWS.slice(0, 3)
    .concat([{ chain_id: 20, z: NaN, manual: true }]);
  const L = T.ewCoverageLive(SERVED, rows, DEN);
  eq(L.with_elev, 3, "a blank hand-added row does not count as elevated");
  eq(L.no_elev, 3, "...it counts as a contour line with no elevation");
}

// 4. a row on a line outside the denominator is counted and said
{
  const rows = ROWS.concat([{ chain_id: 999, z: 120, manual: true }]);
  const L = T.ewCoverageLive(SERVED, rows, DEN);
  eq(L.contour_chains, 6, "a hand-added row off the contour families does "
    + "not inflate the contour count");
  eq(L.rows_outside, 1, "...it is counted as a row outside the denominator");
  const s = T.ewCoverageText(L, null).join(" ");
  check(/1 row in the list sits on a line that is not one of those 6/.test(s)
     && /list runs to 7/.test(s),
    "...and SAID, so the All chip's 7 reconciles with the sentence's 6");
}

// 5. no denominator at all (a payload with no `elevated` half): the served
//    dict is returned untouched rather than silently counted down to zero
{
  const L = T.ewCoverageLive(SERVED, [], []);
  eq(L.with_elev, 4, "with no denominator to work over, the served dict is "
    + "passed through rather than counted down to nothing");
  check(T.ewCoverageLive(null, ROWS, DEN) === null,
    "and no coverage block means no statement");
}

// ---- the wiring, at source level -----------------------------------------
check(/"elevated": elevated,/.test(R("takeoff_engine", "earthwork.py")),
  "contour_coverage names the elevated half of the denominator too");
check(/elev: \(j\.contour_coverage && j\.contour_coverage\.elevated\) \|\| \[\]/
  .test(js), "the panel state holds it");
check(/function ewDenomList\(\)[\s\S]{0,200}\(st\.elev \|\| \[\]\)\.concat\(st\.unelev \|\| \[\]\)/
  .test(js), "and the two halves are the denominator the panel works over");
check(/function ewCovNow\(\)[\s\S]{0,300}ewCoverageLive\(st\.cov, st\.rows \|\| \[\], ewDenomList\(\)\)/
  .test(js), "ewCovNow() is the one live source");
{
  const uses = js.match(/ewCovNow\(\)/g) || [];
  check(uses.length >= 4,
    "...and the panel block, the basis block and the report all call it "
    + "(" + uses.length + " references)");
  check(!/ewCoverageText\(state\.ew && state\.ew\.cov/.test(js)
     && !/ewCoverageNote\(state\.ew && state\.ew\.cov/.test(js),
    "no surface reads the served dict directly any more");
}
{
  const m = js.match(/function ewStubs\(\) \{[\s\S]*?\n\}/);
  check(!!m && /ewDenomList\(\)/.test(m[0]) && !/st\.removed/.test(m[0]),
    "ewStubs() is built from the whole denominator, so a deleted row comes "
    + "back as a contour with no elevation instead of leaving every list");
}

console.log();
if (fails) { console.error(fails + " FAILED"); process.exit(1); }
console.log("all live-coverage checks passed");
