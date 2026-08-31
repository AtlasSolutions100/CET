// Operator-created line families + the per-family line list, pinned.
//
// The owner asked for two things this block implements (2026-08-31):
//   "missing the ability to label lines into its own line style/family from
//    the menu, I guess also can we get a drop down of each line in each line
//    style/family?"
//
// A created family is a REAL style row: it counts, prices and exports like
// any other. That makes two pieces of bookkeeping load-bearing, and both are
// the kind that fail silently rather than loudly, so they are pinned here.
//
//   1. famAllocStyleId must return an id NOTHING is using. The approve
//      payload labels an element with `body.labels.get(chain.style_id)` - a
//      plain dict lookup - so an id that collides with a family already on
//      the sheet would silently rename that family's linework in the export.
//      It therefore has to scan CHAINS as well as style rows: an id that is
//      on a chain but has no style row is exactly the case a style-only scan
//      would miss and hand out.
//   2. famLines must be BOUNDED and must never hide anything without a
//      count. A family with hundreds of lines has to cost a bounded number
//      of DOM rows, so `cap` bounds what is built - and `total`/`hidden` are
//      returned so the footer can say "showing 50 of 214". A truncation with
//      no denominator is the failure this test exists to prevent.
//
// webui/app.js is not a module and touches the DOM at load, so this evals
// ONLY the block between the LINE-FAMILY markers - that block is kept pure
// (no DOM, no state.*) for exactly this reason.
//
// Dependency-free, like the other suites:  node tests/test_line_family.js

"use strict";
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "webui", "app.js"), "utf8");
const a = src.indexOf("// LINE-FAMILY-BEGIN");
const b = src.indexOf("// LINE-FAMILY-END");
if (a < 0 || b < 0 || b <= a) {
  console.error("FAIL: LINE-FAMILY markers not found in webui/app.js");
  process.exit(1);
}
const F = new Function(src.slice(a, b) + `
  return { famAllocStyleId, famNewStyle, famLines };`)();

let failures = 0;
function check(cond, msg) {
  if (!cond) { failures++; console.error("FAIL:", msg); }
  else console.log("ok:", msg);
}
function eq(got, want, msg) {
  check(got === want, msg + `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);
}

// ---------------- a synthetic page, shaped like state.result --------------
const styles = [
  { style_id: 3, class: "solid", color: [0, 0, 0], width: 0.5, signature: "solid" },
  { style_id: 7, class: "dash1", color: [1, 0, 0], width: 0.7, signature: "d18.0 g9.0" },
];
function chain(id, sid, len, nPts, extra) {
  const pts = [];
  for (let i = 0; i < nPts; i++) pts.push([i, i]);
  return Object.assign({ chain_id: id, style_id: sid, class: "solid",
                         length_pt: len, points: pts }, extra || {});
}

// ================= 1. style-id allocation ================================
{
  const chains = [chain(1, 3, 10, 2), chain(2, 7, 20, 3)];
  eq(F.famAllocStyleId(styles, chains), 8,
     "a new family takes one past the highest style_id in use");
}
{
  // the case a style-row-only scan gets wrong: an id living on a chain with
  // no style row of its own (a family whose every row was consumed by edits)
  const chains = [chain(1, 3, 10, 2), chain(2, 41, 20, 3)];
  eq(F.famAllocStyleId(styles, chains), 42,
     "allocation scans CHAINS too, so an id with no style row cannot be reissued");
}
{
  eq(F.famAllocStyleId([], []), 1, "the first family on an empty page is id 1");
  eq(F.famAllocStyleId(null, null), 1, "null inputs allocate id 1 rather than NaN");
}
{
  // allocate, insert, allocate again: two families created back to back must
  // not collide (the shape that would silently merge them in the export)
  const st = styles.slice();
  const chains = [chain(1, 3, 10, 2)];
  const one = F.famNewStyle(st, chains, "DITCH", null);
  st.push(one);
  const two = F.famNewStyle(st, chains, "SWALE", null);
  check(one.style_id !== two.style_id,
        "two families created back to back get different ids");
  eq(two.style_id, one.style_id + 1, "the second takes the next id");
}

// ================= 2. the new style row ==================================
{
  const donor = { class: "dash2", color: [0.2, 0.4, 0.6], width: 1.25,
                  dash_signature: "d12.0 g4.0 d2.0 g4.0" };
  const st = F.famNewStyle(styles, [], "  STORM DITCH  ".trim(), donor);
  eq(st.suggested_label, "STORM DITCH", "the row carries the name the operator typed");
  eq(st.operator_created, true, "the row is MARKED operator-created, never disguised");
  eq(st.class, "dash2", "it inherits the donor's pattern class");
  eq(st.width, 1.25, "…its plotted width");
  eq(st.signature, "d12.0 g4.0 d2.0 g4.0", "…and its dash signature");
  eq(st.layer, "", "no CAD layer: no drafter filed this, and absence says so");
  eq(st.length_pt, 0, "a fresh family measures 0 pt - nothing is in it yet");
  eq(st.n, 0, "…and holds 0 lines");
  check(st.color !== donor.color, "the colour is copied, not aliased to the donor");
  donor.color[0] = 0.9;
  eq(st.color[0], 0.2, "…so mutating the donor cannot repaint the new family");
}
{
  const st = F.famNewStyle([], [], "HAND DRAWN", null);
  eq(st.class, "solid", "with no donor the family falls back to solid");
  eq(st.operator_created, true, "…and is still marked operator-created");
}

// ================= 3. the bounded per-family line list ====================
const many = [];
for (let i = 1; i <= 214; i++) many.push(chain(i, 7, i, 2 + (i % 5)));
many.push(chain(900, 3, 9999, 2));      // another family: must never appear

{
  const d = F.famLines(many, 7, { cap: 50 });
  eq(d.shown, 50, "the list builds at most `cap` rows");
  eq(d.total, 214, "…and reports the TRUE total, not the shown count");
  eq(d.hidden, 164, "…and how many are not shown, so nothing truncates silently");
  eq(d.rows.length, 50, "the row array matches `shown`");
  check(d.rows.every(r => r.chain_id !== 900),
        "a line of another family is never listed");
  eq(d.rows[0].chain_id, 214, "longest first");
  eq(d.rows[49].chain_id, 165, "…all the way down the page");
  eq(Math.round(d.totalLen), 214 * 215 / 2,
     "totalLen sums the WHOLE family, not just the shown rows");
}
{
  const d = F.famLines(many, 7, { cap: 300 });
  eq(d.shown, 214, "a cap above the family size shows everything");
  eq(d.hidden, 0, "…and hides nothing");
}
{
  const d = F.famLines(many, 7, {});
  eq(d.shown, 50, "the default cap is 50");
  const d0 = F.famLines(many, 7, { cap: 0 });
  eq(d0.shown, 50, "a nonsense cap falls back to the default rather than showing 0");
}
{
  const ex = new Set([214, 213, 212]);
  const d = F.famLines(many, 7, { cap: 50, excluded: ex });
  eq(d.total, 211, "a deleted line is not a line of the family any more");
  eq(d.rows[0].chain_id, 211, "…and cannot head the list");
}
{
  // the app passes chainLenPt, which applies a vertical-scale axis ratio.
  // The list must sort and total on THAT length, not on the raw field.
  const d = F.famLines(many, 7, { cap: 3, lenOf: (c) => 1000 - c.length_pt });
  eq(d.rows[0].chain_id, 1, "ordering follows the caller's length accessor");
  eq(d.rows[0].len, 999, "…and so does the reported length");
}
{
  // determinism: equal lengths must not reorder between repaints
  const tied = [chain(9, 7, 5, 2), chain(4, 7, 5, 2), chain(6, 7, 5, 2)];
  const one = F.famLines(tied, 7, {}).rows.map(r => r.chain_id).join(",");
  const two = F.famLines(tied.slice().reverse(), 7, {}).rows.map(r => r.chain_id).join(",");
  eq(one, "4,6,9", "equal lengths tie-break on chain_id, ascending");
  eq(two, one, "…so the order does not depend on the chains array order");
}
{
  const d = F.famLines(many, 99, {});
  eq(d.total, 0, "an empty family reports 0 total");
  eq(d.rows.length, 0, "…and builds no rows");
  eq(d.hidden, 0, "…and hides nothing");
  const dn = F.famLines(null, 1, {});
  eq(dn.total, 0, "a missing chains array is 0, not a crash");
}
{
  // the fields the row needs to tell two lines of one family apart
  const d = F.famLines([chain(5, 7, 12.5, 4, { custom: true, class: "dash1" })], 7, {});
  const r = d.rows[0];
  eq(r.chain_id, 5, "the row carries the chain id");
  eq(r.len, 12.5, "…its length");
  eq(r.nPts, 4, "…its vertex count");
  eq(r.custom, true, "…and whether it is a line an edit created");
  eq(r.cls, "dash1", "…and its pattern class");
}

if (failures) {
  console.error(`\n${failures} line-family test(s) FAILED`);
  process.exit(1);
}
console.log("\nall line-family tests passed");
