// THREE PANEL GUARDS THE EARTHWORK CARD WAS MISSING (review 2026-09-03).
//
// All three are display-layer. None of them moves a volume. All three put
// something on the screen - and one of them onto the CLIENT'S REPORT - that
// is not true of the sheet.
//
//  1. "A of the N" COULD GO NEGATIVE. ewCoverageText took A from
//     ewAcceptedSplit().total, which counts every row carrying a finite
//     elevation and a surface, and N from cov.contour_chains, which counts
//     only the chains in a contour family. "+ Add contour" puts a row on any
//     detected chain, so on a sheet with a weak contour family an operator
//     can accept more rows than the denominator holds and the panel prints
//     "25 of the 5 are assigned ... The other -20 are not in it." That
//     string is not confined to the panel: ewCoverageNote feeds it into
//     approve() and it reaches the exported PDF. Even with A < N the
//     sentence is wrong whenever any accepted row sits outside the count,
//     because those rows are in A and are not among the N.
//
//     THE FIX IS NOT A CLAMP. Math.min(A, N) would print a number the code
//     never checked and read as full coverage - CLAUDE.md s5. ewCoverageLive
//     splits the accepted rows against the denominator it already walks, and
//     when there is no denominator to be inside of the remainder clause is
//     dropped rather than guessed.
//
//  2. THE FOLD FORCE-SHOWED TWO BLOCKS THAT OWN THEIR OWN VISIBILITY.
//     ewCoverage and ewFilters are the only members of the earthwork fold
//     list that carry `hidden` in index.html and are un-hidden only by their
//     renderers. The fold handler does `el.hidden = closed` for every id, so
//     collapsing the card and opening it again painted an empty bordered box
//     above the rows on any page where coverage was never computed.
//
//  3. THE FILTER BAR PAINTED FOR AN EMPTY ROW SET. The guard was
//     `!st.rows`, and `[]` is truthy, so a sheet the reader returned nothing
//     for got an "All 0" chip and a sort switch immediately above renderEw's
//     "empty is not an answer" hint. `!st.rows.length` is not the right
//     condition either - a sheet with no rows but unelevated contours still
//     has stubs to filter - so the guard is on the review surface being
//     empty, which is what ewReviewView counts.
//
// Dependency-free, like the other suites:  node tests/test_ew_panel_guards.js

"use strict";
const fs = require("fs");
const path = require("path");
const R = (...p) => fs.readFileSync(path.join(__dirname, "..", ...p), "utf8");
const SRC = R("webui", "app.js");
const HTML = R("webui", "index.html");

let failures = 0;
function check(cond, msg) {
  if (!cond) { failures++; console.error("FAIL:", msg); }
  else console.log("ok:", msg);
}

// ---- pull one function out by matching its braces -------------------------
function extract(name) {
  const start = SRC.indexOf("function " + name + "(");
  if (start < 0) return null;
  let i = SRC.indexOf("{", start), depth = 0;
  for (let j = i; j < SRC.length; j++) {
    if (SRC[j] === "{") depth++;
    else if (SRC[j] === "}" && --depth === 0)
      return SRC.slice(start, j + 1);
  }
  return null;
}

// ===========================================================================
// 1. the arithmetic, run for real out of the EW-REVIEW block
// ===========================================================================
const a = SRC.indexOf("// EW-REVIEW-BEGIN");
const b = SRC.indexOf("// EW-REVIEW-END");
if (a < 0 || b < 0 || b <= a) {
  console.error("FAIL: EW-REVIEW markers not found in webui/app.js");
  process.exit(1);
}
let T;
try {
  T = new Function(SRC.slice(a, b)
    + "\n  return { ewCoverageLive, ewCoverageText };")();
} catch (e) {
  console.error("FAIL: the pure block does not build (" + e.message + ")");
  process.exit(1);
}

// A sheet whose contour family holds five lines, on which the operator has
// hand-added twenty more contours on linework outside every contour family
// and given all twenty-five an elevation and a surface. This is the shape
// that printed the negative.
const den = [];
for (let i = 1; i <= 5; i++) den.push({ chain_id: i, length_pt: 100 });
const rows = [];
for (let i = 1; i <= 25; i++)
  rows.push({ chain_id: i, z: 100 + i, surface: "existing" });

const served = { contour_chains: 5, contour_len_pt: 500,
                 with_elev: 5, with_elev_len_pt: 500,
                 no_elev: 0, no_elev_len_pt: 0, set_aside: {} };
const live = T.ewCoverageLive(served, rows, den);

check(live.accepted_in === 5,
  "ewCoverageLive counts the accepted rows INSIDE the denominator  (got "
  + live.accepted_in + ")");
check(live.accepted_outside === 20,
  "...and the accepted rows outside it, separately  (got "
  + live.accepted_outside + ")");

const sentences = T.ewCoverageText(live, { total: 25 }).join(" ");
check(!/-\d/.test(sentences),
  "no sentence carries a negative number  (" + sentences + ")");
check(sentences.indexOf("5 of the 5") >= 0,
  "the assigned share is stated against the denominator it belongs to");
check(sentences.indexOf("The other 0 ") >= 0,
  "the remainder is 0, not -20");
check(/20 further assigned rows sit/.test(sentences),
  "the twenty rows outside the count are SAID, not folded in or dropped");

// ...and the honest degenerate case: no denominator served, so there is
// nothing to be inside of. The clause must be dropped, not clamped.
const bare = T.ewCoverageLive(served, rows, []);
check(bare.accepted_in === undefined,
  "with no denominator list, ewCoverageLive claims no split");
const bareText = T.ewCoverageText(bare, { total: 25 }).join(" ");
check(bareText.indexOf("25 are assigned to a surface") >= 0,
  "the accepted count is still stated when the split is unknown");
check(bareText.indexOf("of the 5") < 0 && bareText.indexOf("The other") < 0,
  "...but nothing is claimed about a share it could not check  ("
  + bareText + ")");

// ===========================================================================
// 2. the fold, checked against index.html rather than against itself
// ===========================================================================
// The invariant, not the spelling: every id in the earthwork fold list that
// starts hidden in index.html must be one the fold hands back to its
// renderer. A block that gains `hidden` later and is not registered fails
// here, which is the failure the empty box was.
const foldBlock = SRC.slice(SRC.indexOf("const FOLD_RENDERED"),
                            SRC.indexOf("// ---------- SIDEBAR CHROME"));
check(foldBlock.indexOf("FOLD_RENDERED[cid]") >= 0,
  "the fold defers to FOLD_RENDERED before setting hidden");
check(/if \(!closed && FOLD_RENDERED\[cid\]\)/.test(foldBlock),
  "...and only on OPEN - closing still hides the block outright");

const ewSection = SRC.slice(SRC.indexOf('["ewHead", ['));
const ewIds = (ewSection.slice(0, ewSection.indexOf("]]"))
  .match(/"([a-zA-Z]+)"/g) || []).map(s => s.slice(1, -1))
  .filter(s => s !== "ewHead");
check(ewIds.length >= 8,
  "found the earthwork fold's content ids  (" + ewIds.length + ")");
const startsHidden = (id) => {
  const m = HTML.match(new RegExp('id="' + id + '"([^>]*)>'));
  return !!m && /\bhidden\b/.test(m[1]);
};
const needRender = ewIds.filter(startsHidden);
check(needRender.length > 0,
  "at least one earthwork block starts hidden in index.html  ("
  + needRender.join(", ") + ")");
for (const id of needRender)
  check(new RegExp("\\b" + id + ":").test(foldBlock),
    id + " starts hidden in index.html, so the fold must not un-hide it "
    + "- it has to be in FOLD_RENDERED");

// ===========================================================================
// 3. the filter bar, run against a stub DOM
// ===========================================================================
const src = extract("renderEwFilters");
check(!!src, "renderEwFilters() found");
if (src) {
  const mkBox = () => ({
    hidden: false, innerHTML: "stale",
    kids: [], appendChild(c) { this.kids.push(c); },
  });
  const doc = { createElement: () => ({ style: {}, classList: {} }) };
  const run = (ew, view) => {
    const box = mkBox();
    const fn = new Function("$", "state", "ewReviewView", "EW_REVIEW_ORDER",
      "EW_REVIEW", "document", "renderEw",
      src + "\n return renderEwFilters;")(
        (id) => (id === "ewFilters" ? box : null),
        { ew: ew }, () => view, ["none"],
        { none: { chip: "No elevation", why: "" } }, doc, () => {});
    fn();
    return box;
  };
  const empty = run({ rows: [], filter: null, sort: "z" },
                    { total: 0, counts: { none: 0 } });
  check(empty.hidden === true,
    "a sheet with no rows and no stubs hides the filter bar entirely");
  check(empty.kids.length === 0,
    "...and paints no chip and no sort switch  (" + empty.kids.length + ")");

  // the case `!st.rows.length` would have got wrong: no rows, but the sheet
  // draws contours nobody labelled, so there IS a review surface
  const stubs = run({ rows: [], filter: null, sort: "z" },
                    { total: 12, counts: { none: 12 } });
  check(stubs.hidden === false,
    "no rows but twelve unelevated contours still shows the bar");
  check(stubs.kids.length === 3,
    "...with All, the class chip and the sort switch  ("
    + stubs.kids.length + ")");
}

console.log(failures ? "\n" + failures + " FAILED" : "\nall passed");
process.exit(failures ? 1 : 0);
