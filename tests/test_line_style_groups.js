// Line-style GROUPS: the collapsible headers in the Line styles list, pinned.
//
// The owner asked for two things this block implements (2026-09-01):
//   "the ability to close by line style in the line styles tab, so inside
//    line styles close and turn off all annotation, or solid, or dashed
//    etc.. this way instead of scrolling past 1,000 lines i can just close
//    annotation and scroll through solids"
//   "can we have a way where if we click a line there is a way to quickly go
//    to that line in the line style tab as well"
//
// Three rules are load-bearing, and all three fail SILENTLY rather than
// loudly - a wrong one leaves a plausible-looking list that has quietly
// dropped rows or quietly changed a bid. So they are pinned here:
//
//   1. CLOSING IS NOT UNTICKING. sgPlan must report a collapsed group's
//      rows, its tick state and its counted footage EXACTLY as it reports an
//      open group's. `collapsed` may only decide what is painted. If a fold
//      ever leaked into `rows`, `tick` or `lenOn`, closing Annotation would
//      silently take 49 families out of the takeoff and the total would move
//      with nothing on screen saying why.
//   2. A SEARCH MUST REACH INSIDE A CLOSED GROUP. A query that could not
//      return a row because the operator had folded its group would be a
//      search that lies - the same failure class as the A-WALL fix
//      (30 of 31 rows returned, the missing one being the valuable one). A
//      group with hits renders open, flagged `forcedOpen`, and the stored
//      collapse is NOT rewritten - clearing the box restores it.
//   3. sgReveal MUST REFUSE RATHER THAN PRETEND. Sending the operator to a
//      row the current filter has removed from the list means scrolling to
//      nothing and calling it a hit. It has to come back { ok: false } with
//      a sentence naming the filter that is in the way.
//
// webui/app.js is not a module and touches the DOM at load, so this evals
// ONLY the block between the STYLEGROUP markers - that block is kept pure
// (no DOM, no state.*, no store.*) for exactly this reason.
//
// Dependency-free, like the other suites:  node tests/test_line_style_groups.js

"use strict";
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "webui", "app.js"), "utf8");
const a = src.indexOf("// STYLEGROUP-PURE-BEGIN");
const b = src.indexOf("// STYLEGROUP-PURE-END");
if (a < 0 || b < 0 || b <= a) {
  console.error("FAIL: STYLEGROUP markers not found in webui/app.js");
  process.exit(1);
}
const F = new Function(src.slice(a, b) + `
  return { SG_DEFS, sgKeyOf, sgFoldKey, sgPlan, sgTickState, sgReveal };`)();

let failures = 0;
function check(cond, msg) {
  if (!cond) { failures++; console.error("FAIL:", msg); }
  else console.log("ok:", msg);
}
function eq(got, want, msg) {
  check(got === want, msg + `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);
}

// ---------------- a synthetic sheet shaped like Barn Civil C3.0 ------------
// Same class mix and the same proportions as the real 280-row sheet the
// feature was built against (solid 103, dash1 81, annotation 49, dash2 41,
// dash3 6), scaled down so the expected numbers are readable here.
let nextId = 1;
function mk(cls, n, opt) {
  const o = opt || {};
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      style_id: nextId++,
      class: cls,
      signature: cls === "solid" ? "solid" : "d18.0 g9.0",
      layer: o.layer ? o.layer + "-" + i : "",
      length_pt: (o.len === undefined ? 100 : o.len) + i,
      suggested_label: cls + " " + i,
    });
  }
  return out;
}
const styles = [].concat(
  mk("solid", 10, { layer: "C-WALL" }),
  mk("dash1", 8),
  mk("annotation", 5),
  mk("dash2", 4),
  mk("dash3", 1),
  mk("dash-text", 1)
);
const lenOf = (s) => s.length_pt;
const allOn = () => true;

// ---------------- 1. the buckets ------------------------------------------
eq(F.sgKeyOf("solid"), "solid", "solid -> Solid");
eq(F.sgKeyOf("dash1"), "dashed", "dash1 -> Dashed");
eq(F.sgKeyOf("dash2"), "dashed", "dash2 -> Dashed");
eq(F.sgKeyOf("dash3"), "dashed", "dash3 -> Dashed");
eq(F.sgKeyOf("dash-text"), "dashed", "dash-text -> Dashed");
eq(F.sgKeyOf("annotation"), "annotation", "annotation -> Annotation");
// the catch-all is the point: a class this file has never heard of still
// gets a header and a count instead of dropping out of the list unseen
eq(F.sgKeyOf("hatch-future"), "other", "an unknown class falls to Other");
eq(F.sgKeyOf(undefined), "other", "a missing class falls to Other");
eq(F.sgFoldKey("annotation"), "core-sgfold-annotation",
   "the fold key uses the existing core- namespace");

// ---------------- 2. the plan, nothing collapsed --------------------------
{
  const p = F.sgPlan(styles, { isOn: allOn, lenOf });
  eq(p.groups.length, 3, "three groups on a sheet with no unknown class");
  eq(p.groups.map(g => g.key).join(","), "solid,dashed,annotation",
     "group order is the operator's reading order, solid first");
  // the old flat list sorted annotation ABOVE solid (CLASS_ORDER had no
  // entry for it, so indexOf returned -1) - pinned so it cannot come back
  check(p.groups[0].key === "solid" && p.groups[2].key === "annotation",
        "annotation no longer sorts above solid");
  eq(p.groups[1].nAll, 14, "Dashed folds dash1+dash2+dash3+dash-text (8+4+1+1)");
  eq(p.nAll, styles.length, "every style row lands in exactly one group");
  eq(p.nShown, styles.length, "with nothing collapsed every row is painted");
  // the engine's four-way split survives at group level
  eq(p.groups[1].breakdown.join(", "), "8 dash1, 4 dash2, 1 dash-text, 1 dash3",
     "the Dashed header still carries the engine's own cadence split");
  // longest first inside a group
  const solid = p.groups[0];
  check(solid.rows.every((s, i) => i === 0 || lenOf(solid.rows[i - 1]) >= lenOf(s)),
        "rows inside a group are longest-first");
}

// ---------------- 3. CLOSING CHANGES NO QUANTITY --------------------------
{
  const open = F.sgPlan(styles, { isOn: allOn, lenOf });
  const shut = F.sgPlan(styles, { isOn: allOn, lenOf,
                                  closed: new Set(["annotation"]) });
  const oAnn = open.groups.find(g => g.key === "annotation");
  const sAnn = shut.groups.find(g => g.key === "annotation");
  eq(sAnn.collapsed, true, "the closed group reports itself collapsed");
  eq(oAnn.collapsed, false, "the open group does not");
  // THE RULE. Same rows, same tick state, same footage - only the painting
  // differs. Anything else here is a fold silently editing the takeoff.
  eq(sAnn.rows.length, oAnn.rows.length,
     "a collapsed group still ACTS ON every one of its rows");
  eq(sAnn.tick.on, oAnn.tick.on, "a collapse does not untick anything");
  eq(sAnn.tick.state, oAnn.tick.state, "a collapse does not move the tick state");
  eq(sAnn.lenOn, oAnn.lenOn, "a collapse does not move the counted footage");
  eq(sAnn.nAll, oAnn.nAll, "a collapse does not change the group's count");
  // what DOES change is the scroll, and only the scroll
  eq(shut.nShown, open.nShown - oAnn.nHit,
     "closing Annotation removes exactly its rows from what is painted");
  eq(shut.nHit, open.nHit, "and removes nothing from what the list holds");
}

// ---------------- 4. UNTICKING DOES change the quantity -------------------
{
  const on = F.sgPlan(styles, { isOn: allOn, lenOf });
  const annIds = new Set(on.groups.find(g => g.key === "annotation")
                           .rows.map(s => s.style_id));
  const off = F.sgPlan(styles, { lenOf,
    isOn: (s) => !annIds.has(s.style_id) });
  const g = off.groups.find(k => k.key === "annotation");
  eq(g.tick.on, 0, "an unticked group reports 0 on");
  eq(g.tick.state, "none", "and a 'none' tick state");
  eq(g.lenOn, 0, "and contributes nothing to the takeoff");
  eq(g.rows.length, annIds.size, "while still listing all its rows");
  eq(off.nShown, on.nShown, "unticking hides no rows from the scroll");
  // the other two groups are untouched by the annotation untick
  eq(off.groups.find(k => k.key === "solid").lenOn,
     on.groups.find(k => k.key === "solid").lenOn,
     "unticking one group moves no other group's footage");
}

// ---------------- 5. the three-state header tick --------------------------
{
  const rows = styles.filter(s => s.class === "solid");
  eq(F.sgTickState(rows, allOn).state, "all", "all ticked -> all");
  eq(F.sgTickState(rows, () => false).state, "none", "none ticked -> none");
  const half = F.sgTickState(rows, s => s.style_id === rows[0].style_id);
  eq(half.state, "some", "part ticked -> some (the indeterminate box)");
  eq(half.on, 1, "and says how many are on");
  eq(half.n, rows.length, "out of how many it acts on");
  eq(F.sgTickState([], allOn).state, "none", "an empty group is not 'all'");
}

// ---------------- 6. THE SEARCH REACHES INSIDE A CLOSED GROUP -------------
{
  const matches = (s, q) =>
    ((s.suggested_label || "") + " " + s.signature + " " + s.class + " "
      + (s.layer || "")).toUpperCase().includes(q);
  const closed = new Set(["annotation", "solid", "dashed"]);
  const p = F.sgPlan(styles, { q: "ANNOTATION", matches, isOn: allOn, lenOf,
                               closed });
  const g = p.groups.find(k => k.key === "annotation");
  check(!!g, "a query finds the group even though it was folded away");
  eq(g.collapsed, false, "a group with hits renders OPEN while the query stands");
  eq(g.forcedOpen, true, "and says so, so the header can explain itself");
  eq(p.nShown, g.nHit, "every hit is painted; none is left unreachable");
  eq(g.nHit, 5, "all five annotation rows are hits");
  eq(g.filtered, false, "and none of the group's rows was filtered out");
  // groups with no hits are simply absent, exactly as the flat list dropped
  // rows with no hits
  check(!p.groups.some(k => k.key === "solid"),
        "a group with no hits is omitted rather than shown empty");
  // the stored collapse is NOT rewritten by a search
  check(closed.has("annotation"),
        "the operator's stored collapse survives the query untouched");
  // ...and comes back the moment the box is cleared
  const after = F.sgPlan(styles, { isOn: allOn, lenOf, closed });
  eq(after.groups.find(k => k.key === "annotation").collapsed, true,
     "clearing the box restores the fold");
  eq(after.nShown, 0, "with all three folded, nothing is painted");
}
{
  // a partial hit reports its own denominator rather than the smaller number
  const matches = (s, q) => (s.layer || "").toUpperCase().includes(q);
  const p = F.sgPlan(styles, { q: "C-WALL-3", matches, isOn: allOn, lenOf });
  const g = p.groups.find(k => k.key === "solid");
  eq(g.nHit, 1, "one solid row matches C-WALL-3");
  eq(g.nAll, 10, "out of the group's ten");
  eq(g.filtered, true, "so the header prints '1 of 10', never a bare 1");
  eq(g.tick.n, 1, "and the header tick acts on the row shown, not on all ten");
}

// ---------------- 7. the declared-trade filter, unchanged -----------------
{
  // the scope filter applies only when the text box is EMPTY - typing
  // anything is itself the "show me everything" gesture, and that rule is
  // the flat list's, carried over verbatim
  const aside = new Set([styles[0].style_id]);
  const sees = (s) => !aside.has(s.style_id);
  const p = F.sgPlan(styles, { sees, isOn: allOn, lenOf });
  eq(p.groups.find(k => k.key === "solid").nHit, 9, "a set-aside row is hidden");
  const q = F.sgPlan(styles, { q: "SOLID", matches: (s, qq) =>
    s.class.toUpperCase().includes(qq), sees, isOn: allOn, lenOf });
  eq(q.groups.find(k => k.key === "solid").nHit, 10,
     "and comes back the moment anything is typed");
}

// ---------------- 8. sgReveal refuses rather than pretends ----------------
{
  const matches = (s, q) => (s.suggested_label || "").toUpperCase().includes(q);
  const target = styles.find(s => s.class === "annotation");

  const plain = F.sgReveal(target, { closed: new Set() });
  eq(plain.ok, true, "with no filter and no fold, the row is reachable");
  eq(plain.group, "annotation", "and names the group it is in");
  eq(plain.expand, false, "with nothing to expand");

  const folded = F.sgReveal(target, { closed: new Set(["annotation"]) });
  eq(folded.ok, true, "a folded group does not block the jump");
  eq(folded.expand, true, "it asks the caller to open the group first");

  const hidden = F.sgReveal(target,
    { q: "ZZZ", qRaw: "zzz", matches, closed: new Set() });
  eq(hidden.ok, false, "a row the search box has filtered out is NOT reachable");
  eq(hidden.why, "search", "and the reason is named");
  check(hidden.msg.indexOf("zzz") >= 0,
        "the message quotes what is actually in the box");

  const aside = F.sgReveal(target, { sees: () => false, closed: new Set() });
  eq(aside.ok, false, "a row the trade filter set aside is NOT reachable");
  eq(aside.why, "scope", "and that reason is named separately");
  check(aside.msg.length > 20, "with a sentence saying how to get it back");

  const gone = F.sgReveal(null, {});
  eq(gone.ok, false, "a deleted style is NOT reachable");
  eq(gone.why, "gone", "and says so rather than scrolling to nothing");
}

// ---------------- 9. degenerate input -------------------------------------
{
  const p = F.sgPlan([], {});
  eq(p.groups.length, 0, "an empty sheet renders no headers");
  eq(p.nAll, 0, "and counts nothing");
  const p2 = F.sgPlan(null, {});
  eq(p2.groups.length, 0, "a null style list does not throw");
  // an unknown class gets its own header rather than disappearing
  const p3 = F.sgPlan([{ style_id: 1, class: "hatch-future", length_pt: 5 }],
                      { isOn: allOn, lenOf });
  eq(p3.groups.length, 1, "an unknown class still gets a group");
  eq(p3.groups[0].key, "other", "under Other");
  eq(p3.groups[0].nAll, 1, "carrying its count");
}

console.log(failures ? `\n${failures} FAILURE(S)` : "\nall style-group assertions pass");
process.exit(failures ? 1 : 0);
