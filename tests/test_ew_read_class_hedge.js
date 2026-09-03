// "READ FROM THE SHEET" MAY NOT CLAIM MORE THAN THE PROVENANCE CARRIES.
//
// THE DEFECT (review finding R3, 2026-09-03). The chip for `how: "inline"`
// carried the tooltip "Read out of the label this sheet prints in the break
// in this contour - real text in the PDF, not a reading of ours." The first
// half is true and the second half is a promise the class cannot keep:
// reading a label out of a break says nothing about WHICH line the break
// belongs to, and the chainer can weld two contour levels into a single
// chain - at which point one of the two printed elevations wins and the row
// still wears "from the sheet".
//
// MEASURED, DEM dem_hurricane_bench_a_pad_1ft page 0 (144 contour lines, 101
// suggest rows, 9 of them wrong against the DEM at 0.4 ft tolerance): three
// of the nine - chains 429, 430 and 339, at doubt-ranks 89, 90 and 127 of
// 144 - are in this class, and all three are WELDED, their true elevation
// spanning exactly 1.0 ft along one chain. Off-interval catches none of
// them: every wrong value is a whole number on a 1 ft sheet.
//
// AND NO SIGNAL FOUND THEM, which is why this is a hedge and not a new
// badge. Three were measured over the sheet's rows (98 of the 101 carry
// enough vertices for the geometry test; all 101 for the other two):
//   * self-approach (the hairpin a weld leaves): the three rank 17th, 25th
//     and 96th of 98 - no separation at any threshold;
//   * two printed elevations >= 1 ft apart near one chain: at 16 pt it
//     flags 33 of the 101 and catches 1 of 3; at 30 pt it catches 3 and
//     flags 92 of the 101;
//   * length: two of the three are SHORTER than the sheet's median contour
//     chain (290.5 and 396.5 pt against 550.8).
// Dropping all three moves no volume (+22.40% cut / -22.41% fill either
// way), so the honest repair is the words, not the ranking.
//
// WHAT THIS PINS
//  1. The tooltip no longer says the elevation is "not a reading of ours".
//  2. It says what IS ours - which line the digits were attached to - and
//     names the weld, in plain words, with the measurement behind it.
//  3. The class keeps rank 7. Promoting 66 rows to catch 3 would bury the
//     25 the sweep actually needs, and the volume proves it: the flagship
//     claim is that sweeping the doubtful chips moves the DEM 1 ft run from
//     +22.40% / -22.41% to +0.13% / +0.57%.
//  4. The measurement lives beside the constant, so the next reader does
//     not re-derive it.
//
// Dependency-free like tests/test_ew_review.js:
//    node tests/test_ew_read_class_hedge.js
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
const blk = js.slice(a, b);
const T = new Function(blk + "\n  return { EW_REVIEW, EW_REVIEW_ORDER };")();
const read = T.EW_REVIEW.read;

console.log("1. the tooltip stops over-claiming");
check(!/not a reading of ours/.test(read.why),
  "it no longer says the elevation is “not a reading of ours” - the digits "
  + "are the sheet's, the PAIRING is ours, and this class cannot tell them "
  + "apart");
check(/still ours/.test(read.why),
  "...it says which half is still ours");
check(/weld/.test(read.why),
  "...and names the mechanism: two contour levels welded into one line");
// TEN, not nine. `python -m tools.dem_truth.verify_rows` on pad_1ft at
// tolerance_ft 0.4 reports 'rows 101 z-ok 91 wrong 10' - chains 429, 430,
// 449, 452, 541, 568, 527, 473, 339 and 85. Nine is the count of wrong
// rows the engine READ; the tenth (chain 85) is interval-infill, which
// the sentence does not exclude. The 3 in this class and the 6 in
// 'printed nearby' both reproduce; only the denominator was off by one.
check(/3 of its 10 known-wrong rows/.test(read.why)
   && /1\.0 ft/.test(read.why),
  "...with the measurement, not an adjective: 3 of the 9 known-wrong rows "
  + "on the 1 ft test sheet, each welded across 1.0 ft");
check(/nothing on this surface can point them out/.test(read.why),
  "...and says the surface cannot find them, so a sweep of this class is a "
  + "read of the drawing");

console.log("\n2. the digits are still the sheet's - the hedge is not a smear");
check(/the sheet's own text/.test(read.why),
  "the tooltip still says the digits are printed text, because they are - "
  + "this class is not the machine-read one");
eq(read.chip, "Read from the sheet", "the chip label is unchanged");
eq(read.badge, "from the sheet", "and so is the row badge");
eq(read.short, "label printed in this line's own break",
  "and the row's own one-liner");

console.log("\n3. the rank does not move");
eq(read.rank, 7,
  "“read from the sheet” stays LAST in the sweep: promoting 66 rows to "
  + "reach 3 would bury the 25 that move the volume");
eq(T.EW_REVIEW_ORDER[T.EW_REVIEW_ORDER.length - 1], "read",
  "...and it is still the last chip in the bar");
{
  const ranks = T.EW_REVIEW_ORDER.map(k => T.EW_REVIEW[k].rank);
  check(ranks.every((r, i) => i === 0 || r > ranks[i - 1]),
    "...with the chip order still the doubt order, strictly increasing");
}

console.log("\n4. the measurement is recorded where the next reader will be");
for (const [needle, what] of [
  ["429", "the three welded chain ids"],
  ["SELF-APPROACH", "the hairpin signal that was tried"],
  ["17th, 25th and 96th of 98", "...and how badly it separated"],
  ["550.8", "the median contour length the two short welds sit under"],
  ["+22.40%", "and that dropping the three moves no volume"],
]) {
  check(blk.indexOf(needle) >= 0,
    "the block records " + what + " (\"" + needle + "\")");
}

console.log();
if (fails) { console.error(fails + " FAILED"); process.exit(1); }
console.log("all read-class hedge checks passed");
