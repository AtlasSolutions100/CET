// SUB-ITEMS: the roll-up, the counted-exactly-once invariant, the factor
// that follows a measured parent, the delete-parent cascade, the CSV shape,
// and the provenance tag surviving every path.
//
// An estimator's line item carries components - rebar under concrete, forms
// under an edge - and the parent's cost is its own plus theirs. The one thing
// that must never happen is a component reaching the takeoff total twice:
// that is a confident wrong number in a bid, which is the harm CLAUDE.md
// section 5 is written about. Everything below exists to pin it.
//
// webui/app.js is not a module and touches the DOM at load, so this test
// evals ONLY the block between the SUBITEM-PURE markers - that block is kept
// pure (no DOM, no state.*, no store.*) for exactly this reason. Same
// technique as tests/test_undo_core.js and tests/test_bidview_rules.js.
//
// Dependency-free like tests/test_gate.py:  node tests/test_subitems.js

"use strict";
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "webui", "app.js"), "utf8");
const a = src.indexOf("// SUBITEM-PURE-BEGIN");
const b = src.indexOf("// SUBITEM-PURE-END");
if (a < 0 || b < 0 || b <= a) {
  console.error("FAIL: SUBITEM-PURE markers not found in webui/app.js");
  process.exit(1);
}
const block = src.slice(a, b);
// `document.` / `state.` with the dot, so the word "document" in a comment
// is not mistaken for a DOM reference.
if (/\bdocument\.|\bstate\.|\bstore\./.test(block)) {
  console.error("FAIL: the SUBITEM-PURE block touches the DOM or state - it "
                + "must stay pure so this test can eval it alone");
  process.exit(1);
}
const T = new Function(block + `
  return { SUB_MAX, SUB_NAME_MAX, SUB_UNIT_MAX, SUB_SET_BY,
           subParentKey, subClean, subCleanList, subQtyOf, subRound,
           subExtOf, subRecomputed, subRollupItems, subCascade,
           subDormantKeys, subExportLabel, subCsvCells };`)();

let failures = 0;
function check(cond, msg) {
  if (!cond) { failures++; console.error("FAIL:", msg); }
  else console.log("ok:", msg);
}
function near(x, y, eps, msg) { check(Math.abs(x - y) < (eps || 1e-9), msg); }

// ------------------------------------------------------------------ keys
check(T.subParentKey("  Proposed Concrete  ") === "PROPOSED CONCRETE",
      "parent key trims and uppercases, like tradeKey/bidKey");
check(T.subParentKey(null) === "", "a null label is the empty key, not a throw");
check(T.subParentKey("concrete") === T.subParentKey("CONCRETE "),
      "case and trailing space normalise to one key");

// --------------------------------------------------------------- cleaning
check(T.subClean(null) === null, "null is not a record");
check(T.subClean({ name: "", qty: 5 }) === null, "a nameless component is dropped");
check(T.subClean({ name: "x", mode: "fixed", qty: 0 }) === null,
      "a fixed component with zero quantity is dropped, not counted as free");
check(T.subClean({ name: "x", mode: "fixed", qty: -3 }) === null,
      "a negative quantity is dropped");
check(T.subClean({ name: "x", mode: "factor", factor: 0 }) === null,
      "a factor of zero is dropped");
check(T.subClean({ name: "x", mode: "fixed", qty: "abc" }) === null,
      "a non-numeric quantity is dropped rather than becoming NaN in a total");
{
  const c = T.subClean({ name: " #4 rebar ", mode: "fixed", qty: "12.5",
                         unit: " LB ", price: "1.25", factor: 9, base: 7 });
  check(c.name === "#4 rebar" && c.unit === "LB", "name and unit are trimmed");
  check(c.mode === "fixed" && c.qty === 12.5, "a fixed record keeps its quantity");
  check(c.factor === null && c.base === null,
        "a fixed record carries no factor and no parent baseline");
  check(c.price === 1.25, "price parses");
}
{
  const c = T.subClean({ name: "rebar", mode: "factor", factor: 1.15,
                         qty: 99, unit: "LB", base: 100 });
  check(c.factor === 1.15 && c.qty === null,
        "a factor record carries no fixed quantity");
  check(c.base === 100, "a factor record remembers the parent it followed");
}
check(T.subClean({ name: "x", qty: 1, unit: "VERYLONGUNIT" }).unit.length
      === T.SUB_UNIT_MAX,
      "unit is capped at the same 8 characters server.py caps it at");
check(T.subCleanList(Array.from({ length: T.SUB_MAX + 9 },
        () => ({ name: "x", qty: 1 }))).length === T.SUB_MAX,
      "the per-parent component cap holds");
check(T.subCleanList("not an array").length === 0,
      "a corrupt stored value yields no components, not a throw");

// -------------------------------------------------- quantity: fixed/factor
const fixed = T.subClean({ id: "f", name: "control joints", mode: "fixed",
                           qty: 240, unit: "LF", price: 2 });
const factor = T.subClean({ id: "r", name: "#4 rebar", mode: "factor",
                            factor: 1.15, unit: "LB", price: 1.1, base: 1000 });
check(T.subQtyOf(fixed, 99999) === 240,
      "a fixed component ignores the parent quantity entirely");
near(T.subQtyOf(factor, 1000), 1150, 1e-9,
     "a factor component is rate x parent quantity");
check(T.subQtyOf(factor, null) === null,
      "a factor component against an unmeasured parent has no quantity");
near(T.subExtOf(fixed, 0), 480, 1e-9, "fixed extended = qty x price");
near(T.subExtOf(factor, 1000), 1150 * 1.1, 1e-9, "factor extended = derived qty x price");
check(T.subExtOf(T.subClean({ name: "x", qty: 5 }), 1) === null,
      "no price means no dollars - never a silent zero");
check(T.subRound(1150.04) === 1150 && T.subRound(1150.06) === 1150.1,
      "quantities round to the app's canonical one decimal");

// ------------------------------------------------- the factor RECOMPUTED
check(T.subRecomputed(fixed, 12345) === null,
      "a fixed component never reports a recompute");
check(T.subRecomputed(factor, 1000) === null,
      "an unmoved parent reports no recompute");
check(T.subRecomputed(factor, 1000.04) === null,
      "a move below the displayed precision is not announced as a change");
{
  const r = T.subRecomputed(factor, 1200);
  check(r !== null, "a moved parent reports a recompute");
  near(r.from, 1000, 1e-9, "recompute names the parent quantity it left");
  near(r.to, 1200, 1e-9, "recompute names the parent quantity it arrived at");
  near(r.wasQty, 1150, 1e-9, "recompute names the quantity before");
  near(r.nowQty, 1380, 1e-9, "recompute names the quantity after");
}
{
  const noBase = T.subClean({ name: "x", mode: "factor", factor: 2, unit: "EA" });
  check(T.subRecomputed(noBase, 50) === null,
        "a factor row that has never followed a measurement is not a recompute");
}

// ============================ THE ROLL-UP ===============================
// A real shape: one measured concrete row with two components, one measured
// row with none, one calculator row with none.
const SUBS = {
  "PROPOSED CONCRETE FLATWORK": [fixed, factor],
};
const subsFor = (k) => SUBS[k] || [];
const ITEMS = [
  { key: "PROPOSED CONCRETE FLATWORK", qty: 1000, ext: 1000 * 6.5 },
  { key: "SILT FENCE", qty: 2400, ext: 2400 * 3 },
  { key: "Site Cut", qty: 1300, ext: null },
];
{
  const r = T.subRollupItems(ITEMS, subsFor);
  check(r.rows.length === 3, "one roll-up row per item, in the same order");
  const c = r.rows[0];
  check(c.subs.length === 2, "the concrete row carries both components");
  near(c.ownExt, 6500, 1e-9, "own extended cost is untouched by the roll-up");
  near(c.subExt, 480 + 1150 * 1.1, 1e-9, "component cost is the sum of the two");
  near(c.rowExt, c.ownExt + c.subExt, 1e-9, "rowExt = own + components");
  check(c.dupOf === null, "the only claimant owns its components");
  check(r.rows[1].subs.length === 0 && r.rows[1].rowExt === 7200,
        "a row with no components rolls up to exactly its own cost");
  check(r.rows[2].ownExt === 0 && r.rows[2].rowExt === 0,
        "an unpriced row contributes nothing, and null ext is read as 0");

  // ---- THE INVARIANT: counted exactly once ----
  near(r.total, r.ownTotal + r.subTotal, 1e-9,
       "total = ownTotal + subTotal");
  near(r.total, r.rows.reduce((s, x) => s + x.rowExt, 0), 1e-9,
       "total = the sum of every row's rolled-up cost");
  near(r.ownTotal, 6500 + 7200, 1e-9, "ownTotal is only the parents' own money");
  near(r.subTotal, 480 + 1265, 1e-9, "subTotal is only the components' money");
  // and the arithmetic a double count would break: adding the components a
  // second time as rows of their own must NOT equal the total
  const doubled = r.total + r.subTotal;
  check(Math.abs(doubled - r.total) > 1,
        "a component added a second time would be a different number - the "
        + "roll-up is not accidentally idempotent, so the test above is real");
}

// ---- two labels normalising to one key: exactly one row owns the list ----
{
  const dupItems = [
    { key: "concrete flatwork", qty: 400, ext: 400 },
    { key: "CONCRETE FLATWORK", qty: 900, ext: 900 },
    { key: "Concrete Flatwork ", qty: 100, ext: 100 },
  ];
  const one = { "CONCRETE FLATWORK": [fixed] };   // $480
  const r = T.subRollupItems(dupItems, (k) => one[k] || []);
  const owners = r.rows.filter((x) => x.subs.length);
  check(owners.length === 1, "exactly one row owns a shared parent key");
  check(r.rows[1].subs.length === 1,
        "the LARGEST quantity owns it - an explicit ranking, not arrival order");
  check(r.rows[0].dupOf === "CONCRETE FLATWORK"
        && r.rows[2].dupOf === "CONCRETE FLATWORK",
        "every other claimant is told which row carries the components");
  near(r.subTotal, 480, 1e-9,
       "the shared component list is counted ONCE across all three rows");
  near(r.total, 1400 + 480, 1e-9, "and the total reflects exactly one copy");
}
{
  // ties: first appearance wins, and it is deterministic
  const tie = [{ key: "A", qty: 5, ext: 0 }, { key: "a", qty: 5, ext: 0 }];
  const r1 = T.subRollupItems(tie, () => [fixed]);
  const r2 = T.subRollupItems(tie, () => [fixed]);
  check(r1.rows[0].subs.length === 1 && r1.rows[1].subs.length === 0,
        "a tie is broken by first appearance");
  check(JSON.stringify(r1.rows.map((x) => x.dupOf))
        === JSON.stringify(r2.rows.map((x) => x.dupOf)),
        "ownership is deterministic across runs");
}

// ---- the factor recompute reaches the roll-up ----------------------------
{
  const before = T.subRollupItems(
    [{ key: "SLAB", qty: 1000, ext: 0 }], () => [factor]);
  const after = T.subRollupItems(
    [{ key: "SLAB", qty: 1200, ext: 0 }], () => [factor]);
  near(before.rows[0].subs[0].qty, 1150, 1e-9, "before: 1.15 x 1000");
  near(after.rows[0].subs[0].qty, 1380, 1e-9,
       "after the measured parent moved: 1.15 x 1200, recomputed");
  check(before.rows[0].subs[0].recomputed === null,
        "at the baseline the row does not claim it recomputed");
  check(after.rows[0].subs[0].recomputed !== null,
        "when it does recompute the roll-up hands the caller the evidence, "
        + "so the change can be disclosed at the moment it happens");
  near(after.subTotal - before.subTotal, 230 * 1.1, 1e-9,
       "and the money follows the measurement");
  // a FIXED component does not move with the parent
  const fb = T.subRollupItems([{ key: "SLAB", qty: 1000, ext: 0 }], () => [fixed]);
  const fa = T.subRollupItems([{ key: "SLAB", qty: 9999, ext: 0 }], () => [fixed]);
  near(fb.subTotal, fa.subTotal, 1e-9,
       "a fixed component is unmoved by a changed parent quantity");
}

// ------------------------------------------- delete-parent cascade -------
{
  const all = { "CONCRETE": [fixed, factor], "SILT FENCE": [fixed],
                "SITE CUT": [factor] };
  const r = T.subCascade(all, ["concrete "]);
  check(r.dropped.length === 1 && r.dropped[0] === "CONCRETE",
        "the cascade normalises the key it was handed");
  check(!("CONCRETE" in r.kept), "the deleted parent's components are gone");
  check(Object.keys(r.kept).length === 2,
        "and nothing else was touched - no orphan, no collateral");
  const r2 = T.subCascade(all, ["CONCRETE", "SITE CUT"]);
  check(r2.dropped.join("|") === "CONCRETE|SITE CUT",
        "a multi-key cascade reports every key it dropped, sorted");
  check(T.subCascade(null, ["X"]).dropped.length === 0,
        "cascading over nothing drops nothing");
  check(Object.keys(T.subCascade(all, []).kept).length === 3,
        "an empty delete list is a no-op");
}
// dormant: stored but with no row on this sheet - never counted, never silent
{
  const all = { "CONCRETE": [fixed], "SILT FENCE": [fixed], "EMPTY": [] };
  const d = T.subDormantKeys(all, ["Concrete Flatwork", "concrete"]);
  check(d.join("|") === "SILT FENCE",
        "a stored key with no live row is reported dormant");
  check(T.subDormantKeys(all, ["CONCRETE", "SILT FENCE"]).length === 0,
        "a key whose row is on screen is not dormant");
  check(T.subDormantKeys(all, []).indexOf("EMPTY") < 0,
        "an empty component list is not reported as dormant work");
}

// ---------------------------------------------- the export label ---------
{
  const L = T.subExportLabel("PROPOSED CONCRETE FLATWORK", "#4 rebar", 80);
  check(L === '#4 rebar (sub-item of PROPOSED CONCRETE FLATWORK)',
        "the parent link travels in the name, because the name survives the "
        + "server's item builder and a structured key does not");
  check(L.length <= 80, "and it fits the server's 80-character label cap");
  const long = T.subExportLabel("X".repeat(200), "#4 rebar", 80);
  check(long.length === 80, "an over-long parent is trimmed to the cap");
  check(long.indexOf("#4 rebar") === 0,
        "the COMPONENT name is never what gets trimmed - it is the row's "
        + "own identity");
  check(long.indexOf("…") > 0, "the trim is marked, not silent");
  const huge = T.subExportLabel("P", "N".repeat(120), 80);
  check(huge.length === 80 && huge.indexOf("(sub-item of") < 0,
        "when even the name does not fit, the name wins and the link is "
        + "dropped rather than producing a mangled half-link");
}

// ------------------------------------------------- CSV shape -------------
{
  const s = { rec: fixed, qty: 240, ext: 480, recomputed: null };
  const cells = T.subCsvCells("PROPOSED CONCRETE FLATWORK",
                              "Paving & Concrete", s, "ft");
  check(cells.length === 10,
        "a component line has the same 10 columns takeoffCsv writes");
  check(cells[0] === "  ↳ control joints",
        "the label column is visibly nested under its parent");
  check(cells[1] === "Paving & Concrete",
        "a component takes its PARENT's trade, never a trade of its own");
  check(cells[2] === "240.0 LF",
        "the quantity carries the component's OWN unit");
  check(cells[3] === "",
        "the FEET column is empty: a component was never measured, and a "
        + "number there would read as detected footage");
  check(cells[4] === 2 && cells[5] === "480.00", "price and extended cost");
  check(cells[6] === "" && cells[7] === "",
        "union / drawn-twice are empty: they describe overlapping geometry, "
        + "and a component has none");
  check(cells[8] === T.SUB_SET_BY,
        "the provenance column carries the app's existing word");
  check(cells[9] === "PROPOSED CONCRETE FLATWORK",
        "and the parent column names the row it hangs from");
}

// --------------------------------- provenance: ONE word, not two ---------
check(T.SUB_SET_BY === "reviewer",
      'the provenance token is exactly server.py\'s _BY_REVIEWER = "reviewer" '
      + "- one vocabulary across the panel, the CSV, the export and the report");
{
  // it must actually be the same string the server writes, not a look-alike
  const py = fs.readFileSync(path.join(__dirname, "..", "server.py"), "utf8");
  const m = /_BY_REVIEWER\s*=\s*"([^"]+)"/.exec(py);
  check(m && m[1] === T.SUB_SET_BY,
        "server.py's _BY_REVIEWER and the client's SUB_SET_BY are the same "
        + "literal (they live in two files; if one is edited this fails)");
}
{
  // and every path that emits a component emits it tagged
  const csv = T.subCsvCells("P", "T",
    { rec: fixed, qty: 1, ext: 1, recomputed: null }, "ft");
  check(csv.indexOf(T.SUB_SET_BY) >= 0, "CSV path carries the tag");
  const app = src.slice(src.indexOf("// SUBITEM-PURE-BEGIN"));
  check(/declared:\s*true,\s*set_by:\s*SUB_SET_BY/.test(app),
        "the approve payload path carries declared:true and set_by");
  check(/qty set by/.test(src) && /sub-item of/.test(src),
        "the CSV header carries the provenance and parent columns");
  check(/class = "sub-tag"/.test(src) || /className = "sub-tag"/.test(src),
        "the panel and the bid view carry the declared chip");
}

console.log(failures ? `\n${failures} FAILURE(S)` : "\nall sub-item tests passed");
process.exit(failures ? 1 : 0);
