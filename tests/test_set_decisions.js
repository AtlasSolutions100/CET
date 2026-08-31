// Set-level include/exclude decisions (EXCAVATION-PLAN §7 item 5): the
// key a hand decision is recorded under for the whole document, and the
// precedence that lets a page-level record always beat it.
//
// Measured before building (Barn 15 pages + a 12-page Kayden spread, both
// recomputed offline with this tree's detect_page; numbers in the
// SET-DECISIONS block comment in webui/app.js). The two facts these tests
// pin:
//
//   * the identity is styleFp with the EXACT signature and the FULL layer.
//     The measured alternative - layer leaf + class + cadence rounded to
//     1 pt - fuses rows the engine split ON THE SAME PAGE for 714/2,664
//     Barn rows (26.8%) and 262/1,059 Kayden rows (24.7%), and a fused key
//     lets an exclusion of one delete the other. styleFp fused 0/2,664 and
//     0/1,059;
//   * rows with no CAD layer never inherit - across pages they are
//     indistinguishable under every key the UI can build, and a wrongly
//     travelling EXCLUSION is silently deleted footage (the styleFp comment
//     block documents the same residue for labels, where it is merely a
//     visible wrong name).
//
// webui/app.js is not a module and touches the DOM at load, so this evals
// ONLY the block between the SET-DECISIONS markers - that block is kept
// pure (no DOM, no state.*, no store.*) for exactly this reason.
//
// Dependency-free like tests/test_gate.py:  node tests/test_set_decisions.js

"use strict";
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "webui", "app.js"), "utf8");
const a = src.indexOf("// SET-DECISIONS-BEGIN");
const b = src.indexOf("// SET-DECISIONS-END");
if (a < 0 || b < 0 || b <= a) {
  console.error("FAIL: SET-DECISIONS markers not found in webui/app.js");
  process.exit(1);
}
const block = src.slice(a, b);
const T = new Function(block + `
  return { weightClass, rawColor, styleFp, setDecEligible, setDecKey,
           setDecResolve };`)();

let failures = 0;
function check(cond, msg) {
  if (!cond) { failures++; console.error("FAIL:", msg); }
  else console.log("ok:", msg);
}

const DOC = "doc::SWR_Barn_Residence_-_Civil_4.7.26.pdf";

// A real Barn C3.0 title-block style, fields verbatim from the offline
// detect run on this tree (style 265 of engine page index 2 = printed
// sheet C3.0; 7,576.7 pt of title-block linework).
const ttlb = { style_id: 265, class: "annotation", width: 0.8,
               color: [0, 0, 0], signature: "sheet furniture",
               layer: "G-ANNO-TTLB" };

// ---- key derivation --------------------------------------------------
{
  const k = T.setDecKey(DOC, ttlb);
  check(k === DOC
        + "::setinc::annotation|w2|0,0,0|sheet furniture|L=G-ANNO-TTLB",
        "key = doc + ::setinc:: + styleFp, verbatim");
  // the same style met on ANOTHER page of the set derives the same key -
  // style_id and page are not in it, that is the whole feature
  const other = Object.assign({}, ttlb, { style_id: 7 });
  check(T.setDecKey(DOC, other) === k, "same family on another page, same key");
  // and the key can never collide with labelKey (doc + :: + styleFp):
  // the segment "::setinc::" would have to open the fingerprint, i.e. be
  // the class name, and no class is named "setinc"
  check(k.indexOf("::setinc::") > 0 && !k.includes("::::"),
        "setinc namespace segment present");
}

// ---- the engine's distinctions survive in the key ---------------------
{
  // weight-class edge: 0.3 vs 0.4 pt straddle the 0.35 hairline limit -
  // the engine holds these as two families, the key must too
  const w1 = Object.assign({}, ttlb, { width: 0.3 });
  const w2 = Object.assign({}, ttlb, { width: 0.4 });
  check(T.setDecKey(DOC, w1) !== T.setDecKey(DOC, w2),
        "weight-class edge keeps two families two keys");
  // Kayden p38 near-twin cadences, fields verbatim from the offline detect
  // run on this tree: styles 8 and 149 of ONE page, 'd8.8 g4.5' vs
  // 'd9.1 g4.5', the same utility-easement linetype reaching the sheet
  // directly and through the XREF. Rounding cadences to 1 pt (plus a leaf
  // layer) would fuse them into one key; the exact signature and the full
  // layer keep them apart. Excluding one must not exclude the other.
  const c1 = { style_id: 8, class: "dash1", width: 0.3, color: [0, 0, 0],
               signature: "d8.8 g4.5",
               layer: "Kayden Springs U2 - CAD Base|C-U2-ESMT-UTIL" };
  const c2 = { style_id: 149, class: "dash1", width: 0.3, color: [0, 0, 0],
               signature: "d9.1 g4.5", layer: "C-U2-ESMT-UTIL" };
  check(T.setDecKey(DOC, c1) !== T.setDecKey(DOC, c2),
        "near-twin cadences (0.3 pt apart, same page) stay two keys");
  // XREF host prefix stays in the key (same trade labelKey made):
  // BARN EAST|S-FNDN and PRIM BDRM|S-FNDN are two keys
  const x1 = Object.assign({}, ttlb, { layer: "BARN EAST|S-FNDN" });
  const x2 = Object.assign({}, ttlb, { layer: "PRIM BDRM|S-FNDN" });
  check(T.setDecKey(DOC, x1) !== T.setDecKey(DOC, x2),
        "XREF host prefix keeps two hosts two keys");
}

// ---- eligibility: no CAD layer, no inheritance ------------------------
{
  check(T.setDecEligible(ttlb) === true, "layered row is eligible");
  check(T.setDecEligible(Object.assign({}, ttlb, { layer: "" })) === false,
        "empty layer is not eligible");
  check(T.setDecEligible(Object.assign({}, ttlb, { layer: "   " })) === false,
        "whitespace layer is not eligible");
  check(T.setDecEligible(Object.assign({}, ttlb, { layer: undefined })) === false,
        "missing layer is not eligible");
  check(T.setDecEligible(null) === false, "no style at all is not eligible");
}

// ---- precedence: page record ALWAYS outranks the set-level one --------
{
  const R = T.setDecResolve;
  // no records at all: no decision, the per-page seed stands
  check(R(null, null, true) === null, "no records -> null (seed stands)");
  // set-level record alone, eligible: inherited
  let d = R(null, "0", true);
  check(d && d.on === false && d.inherited === true,
        "doc '0' alone -> off, inherited");
  d = R(null, "1", true);
  check(d && d.on === true && d.inherited === true,
        "doc '1' alone -> on, inherited");
  // page record alone: applied, NOT inherited
  d = R("1", null, true);
  check(d && d.on === true && d.inherited === false,
        "page '1' alone -> on, not inherited");
  // both present and disagreeing: the page wins, both ways round
  d = R("1", "0", true);
  check(d && d.on === true && d.inherited === false,
        "page '1' beats doc '0'");
  d = R("0", "1", true);
  check(d && d.on === false && d.inherited === false,
        "page '0' beats doc '1'");
  // ineligible rows never read the doc record, even when one exists
  check(R(null, "0", false) === null,
        "ineligible + doc record -> null (no-layer rows never inherit)");
  d = R("0", "1", false);
  check(d && d.on === false, "ineligible rows still honour their page record");
  // garbage in the store is a no-record, not a crash and not a guess
  check(R("yes", "junk", true) === null, "unrecognised record strings -> null");
}

if (failures) {
  console.error(failures + " failure(s)");
  process.exit(1);
}
console.log("all set-decision tests passed");
