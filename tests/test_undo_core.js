// The chain-edit undo stack, pinned.
//
// Every reviewed edit (delete line/point, split, extend, cut span, draw,
// reclassify, merge, separate, bulk delete/reclass) snapshots ONLY the
// chains it touches, BEFORE it touches them, and undoApply is its own
// inverse builder - so undo and redo are one operation walking two stacks.
// What this test pins:
//
//   - round-trip exactness for every edit shape the app performs: after
//     undo the document (chains array incl. order and every field, the
//     excluded set, the chain-label map, the id counter, the selection)
//     is BYTE-IDENTICAL to the pre-edit state, and after redo to the
//     post-edit state - twice over, because a swap bug shows on pass 2;
//   - the LIFO creation rule: a chain whose id is >= an entry's
//     nextChainId at apply time belongs to exactly that entry's edit
//     (exercised by split-then-delete-the-piece sequences);
//   - depth cap eviction (oldest falls off, the rest still apply);
//   - a fresh edit kills the redo future;
//   - page-switch clear empties both stacks;
//   - (added 2026-09-01) the STYLE region: an edit may also list style ROWS
//     it adds or rewrites, so creating an operator line family and moving a
//     line into it is ONE entry that one Ctrl+Z reverses whole. Same
//     round-trip exactness as the chain region, over the style array AND the
//     positional per-style maps in doc.smaps. Every pre-existing assertion
//     above is unchanged: the region defaults to empty, so a chain-only edit
//     snapshots exactly what it always did.
//
// webui/app.js is not a module and touches the DOM at load, so this evals
// ONLY the block between the UNDO-CORE markers - that block is kept pure
// (no DOM, no state.*) for exactly this reason.
//
// Dependency-free, like the other suites:  node tests/test_undo_core.js

"use strict";
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "webui", "app.js"), "utf8");
const a = src.indexOf("// UNDO-CORE-BEGIN");
const b = src.indexOf("// UNDO-CORE-END");
if (a < 0 || b < 0 || b <= a) {
  console.error("FAIL: UNDO-CORE markers not found in webui/app.js");
  process.exit(1);
}
const block = src.slice(a, b);
const U = new Function(block + `
  return { UNDO_DEPTH, undoNewStack, undoCapture, undoApply, undoPush,
           undoStep, undoClear, undoEntryBytes };`)();

let failures = 0;
function check(cond, msg) {
  if (!cond) { failures++; console.error("FAIL:", msg); }
  else console.log("ok:", msg);
}

// ---------- a synthetic document, shaped like state.result + friends ------
function polyLen(ps) {
  let L = 0;
  for (let i = 1; i < ps.length; i++)
    L += Math.hypot(ps[i][0] - ps[i - 1][0], ps[i][1] - ps[i - 1][1]);
  return L;
}
function chain(id, sid, pts, extra) {
  return Object.assign({
    chain_id: id, style_id: sid, class: "solid", color: [0, 0, 0],
    width: 0.5, points: pts.map(p => p.slice()), length_pt: polyLen(pts),
  }, extra || {});
}
function mkDoc() {
  const chains = [
    chain(1, 10, [[0, 0], [100, 0]]),
    chain(2, 10, [[0, 10], [50, 10], [100, 10]]),
    chain(3, 20, [[0, 20], [100, 20]], { class: "dash1", dash_signature: "d9g5", template: [9, 5] }),
    chain(4, 20, [[0, 30], [40, 30]], { class: "dash1", dash_signature: "d9g5" }),
    chain(5, 30, [[0, 40], [10, 40], [20, 40], [30, 40]]),
  ];
  const doc = { chains, excluded: new Set(), labels: new Map(),
                nextChainId: 6, selected: null, selPt: null };
  doc.labels.set(2, "footer drain — separated");
  return doc;
}
function snap(doc) {
  return JSON.stringify({
    chains: doc.chains,
    excluded: [...doc.excluded].sort((x, y) => x - y),
    labels: [...doc.labels.entries()].sort((x, y) => x[0] - y[0]),
    nextChainId: doc.nextChainId,
    selected: doc.selected, selPt: doc.selPt,
  });
}
// the glue in app.js writes the returned scalars back onto state; mirror it
function step(stack, doc, dir) {
  const r = U.undoStep(stack, doc, dir);
  if (r) {
    doc.nextChainId = r.nextChainId;
    doc.selected = r.selected;
    doc.selPt = r.selPt;
  }
  return r;
}

// ---------- the app's own mutation shapes, replayed on the doc ------------
function materialize(doc, ch) {           // mirrors app.js materialize()
  if (ch.custom) return ch;
  doc.excluded.add(ch.chain_id);
  const clone = JSON.parse(JSON.stringify(ch));
  clone.chain_id = doc.nextChainId++;
  clone.custom = true;
  delete clone.seg_counts; delete clone._scOK;
  if (doc.labels.has(ch.chain_id))
    doc.labels.set(clone.chain_id, doc.labels.get(ch.chain_id));
  doc.chains.push(clone);
  return clone;
}
const byId = (doc, id) => doc.chains.find(c => c.chain_id === id) || null;

const EDITS = {
  "delete line": (doc) => {           // ids: [1]
    doc.excluded.add(1);
    doc.selected = null; doc.selPt = null;
    return [1];
  },
  "delete point": (doc) => {          // ids: [5] (materialize + splice)
    const m = materialize(doc, byId(doc, 5));
    m.points.splice(1, 1);
    m.length_pt = polyLen(m.points);
    doc.selected = m.chain_id;
    return [5];
  },
  "point move": (doc) => {            // ids: [1]
    const m = materialize(doc, byId(doc, 1));
    m.points[0] = [5, 5];
    m.length_pt = polyLen(m.points);
    doc.selected = m.chain_id;
    return [1];
  },
  "split": (doc) => {                 // ids: [2] - exclude orig, add 2 pieces
    const ch = byId(doc, 2);
    doc.excluded.add(2);
    for (const pts of [[[0, 10], [50, 10]], [[50, 10], [100, 10]]]) {
      const c = JSON.parse(JSON.stringify(ch));
      c.chain_id = doc.nextChainId++;
      c.custom = true;
      c.points = pts;
      c.length_pt = polyLen(pts);
      if (doc.labels.has(2)) doc.labels.set(c.chain_id, doc.labels.get(2));
      doc.chains.push(c);
    }
    doc.selected = null;
    return [2];
  },
  "extend": (doc) => {                // ids: [4]
    const m = materialize(doc, byId(doc, 4));
    m.points.push([80, 30]);
    m.length_pt += 40;
    doc.selected = m.chain_id;
    return [4];
  },
  "cut span": (doc) => {              // ids: [3] - exclude orig, 2 remnants
    const ch = byId(doc, 3);
    doc.excluded.add(3);
    for (const pts of [[[0, 20], [30, 20]], [[70, 20], [100, 20]]]) {
      const c = JSON.parse(JSON.stringify(ch));
      c.chain_id = doc.nextChainId++;
      c.custom = true;
      c.points = pts;
      c.length_pt = polyLen(pts);
      doc.chains.push(c);
    }
    doc.selected = null;
    return [3];
  },
  "draw (fusing one end)": (doc) => { // ids: [4] - consume + one new chain
    doc.excluded.add(4);              // the fused family line leaves the sheet
    const c = chain(doc.nextChainId++, 20, [[0, 30], [40, 30], [90, 35]],
                    { custom: true, class: "dash1", dash_signature: "d9g5" });
    doc.chains.push(c);
    doc.labels.set(c.chain_id, "hand-drawn run");
    doc.selected = c.chain_id;
    return [4];
  },
  "reclass": (doc) => {               // ids: [1] -> family 20
    const donor = byId(doc, 3);
    const m = materialize(doc, byId(doc, 1));
    m.style_id = donor.style_id;
    m.class = donor.class; m.color = donor.color; m.width = donor.width;
    m.dash_signature = donor.dash_signature;
    m.template = JSON.parse(JSON.stringify(donor.template));
    doc.selected = m.chain_id;
    return [1];
  },
  "merge": (doc) => {                 // ids: [3, 4]
    const sel = byId(doc, 3), tgt = byId(doc, 4);
    const m = materialize(doc, sel);
    m.points = m.points.concat(tgt.points);
    m.length_pt = sel.length_pt + tgt.length_pt + 12.3;
    doc.excluded.add(4);
    doc.selected = m.chain_id;
    return [3, 4];
  },
  "separate (label only)": (doc) => { // ids: [5]
    doc.labels.set(5, "east wall — its own row");
    return [5];
  },
  "bulk delete": (doc) => {           // ids: [1,2,5] - ONE entry
    for (const id of [1, 2, 5]) doc.excluded.add(id);
    doc.selected = null; doc.selPt = null;
    return [1, 2, 5];
  },
  "bulk reclass": (doc) => {          // ids: [1,2] -> family 20, ONE entry
    const out = [];
    for (const id of [1, 2]) {
      const donor = byId(doc, 3);
      const m = materialize(doc, byId(doc, id));
      m.style_id = 20;
      m.class = donor.class; m.dash_signature = donor.dash_signature;
      out.push(id);
    }
    doc.selected = null;
    return out;
  },
};

// ---------- 1. every edit type round-trips exactly, twice -----------------
for (const [name, mutate] of Object.entries(EDITS)) {
  const doc = mkDoc();
  doc.selected = 1; doc.selPt = null;   // some selection to round-trip
  const stack = U.undoNewStack(50);
  const before = snap(doc);

  // capture BEFORE mutation, exactly as the app sites do. The ids an edit
  // touches are known before it runs; learn them from a scratch copy so the
  // real doc's capture strictly precedes its mutation.
  const scratch = mkDoc();
  scratch.selected = 1;
  const ids = mutate(scratch);

  U.undoPush(stack, U.undoCapture(doc, ids, name));
  mutate(doc);
  const after = snap(doc);
  check(after !== before, `${name}: the edit actually changed the doc`);

  step(stack, doc, "undo");
  check(snap(doc) === before, `${name}: undo restores the pre-edit doc exactly`);
  step(stack, doc, "redo");
  check(snap(doc) === after, `${name}: redo restores the post-edit doc exactly`);
  step(stack, doc, "undo");
  check(snap(doc) === before, `${name}: second undo still exact (swap symmetry)`);
  step(stack, doc, "redo");
  check(snap(doc) === after, `${name}: second redo still exact`);
}

// ---------- 2. a sequence unwinds LIFO and rewinds exactly ----------------
{
  const doc = mkDoc();
  const stack = U.undoNewStack(50);
  const states = [snap(doc)];
  const seq = ["split", "extend", "merge", "bulk delete"];
  for (const name of seq) {
    // learn ids on a copy of the CURRENT doc (mid-sequence shapes differ)
    const copy = { chains: JSON.parse(JSON.stringify(doc.chains)),
                   excluded: new Set(doc.excluded),
                   labels: new Map(doc.labels),
                   nextChainId: doc.nextChainId,
                   selected: doc.selected, selPt: doc.selPt };
    const ids = EDITS[name](copy);
    U.undoPush(stack, U.undoCapture(doc, ids, name));
    EDITS[name](doc);
    states.push(snap(doc));
  }
  for (let i = seq.length - 1; i >= 0; i--) {
    step(stack, doc, "undo");
    check(snap(doc) === states[i], `sequence: undo to state ${i} exact`);
  }
  check(step(stack, doc, "undo") === null, "sequence: stack empty after full unwind");
  for (let i = 1; i <= seq.length; i++) {
    step(stack, doc, "redo");
    check(snap(doc) === states[i], `sequence: redo to state ${i} exact`);
  }
  check(step(stack, doc, "redo") === null, "sequence: redo empty after full rewind");
}

// ---------- 3. split then delete-the-piece (LIFO creation rule) -----------
{
  const doc = mkDoc();
  const stack = U.undoNewStack(50);
  const s0 = snap(doc);
  // edit 1: split chain 2 -> pieces 6 and 7
  U.undoPush(stack, U.undoCapture(doc, [2], "split"));
  EDITS["split"](doc);
  const s1 = snap(doc);
  // edit 2: delete piece 6 (a chain that did not exist at edit 1's capture)
  U.undoPush(stack, U.undoCapture(doc, [6], "delete piece"));
  doc.excluded.add(6);
  const s2 = snap(doc);
  step(stack, doc, "undo");
  check(snap(doc) === s1, "split+delete: undoing the delete leaves the split intact");
  step(stack, doc, "undo");
  check(snap(doc) === s0, "split+delete: undoing the split removes both pieces");
  step(stack, doc, "redo");
  step(stack, doc, "redo");
  check(snap(doc) === s2, "split+delete: redo x2 lands on the final state");
}

// ---------- 4. depth cap evicts the oldest, the rest still apply ----------
{
  const doc = mkDoc();
  const stack = U.undoNewStack(3);
  for (let i = 0; i < 5; i++) {
    const id = (i % 5) + 1;
    U.undoPush(stack, U.undoCapture(doc, [id], `delete ${id}`));
    doc.excluded.add(id);
  }
  check(stack.undo.length === 3, "depth cap: stack holds exactly `depth` entries");
  let n = 0;
  while (step(stack, doc, "undo")) n++;
  check(n === 3, "depth cap: only the 3 newest edits can be undone");
  check([...doc.excluded].sort().join() === "1,2",
    "depth cap: the two evicted deletes stay applied");
}

// ---------- 5. a fresh edit kills the redo future --------------------------
{
  const doc = mkDoc();
  const stack = U.undoNewStack(50);
  U.undoPush(stack, U.undoCapture(doc, [1], "delete 1"));
  doc.excluded.add(1);
  step(stack, doc, "undo");
  check(stack.redo.length === 1, "redo future exists after an undo");
  U.undoPush(stack, U.undoCapture(doc, [2], "delete 2"));
  doc.excluded.add(2);
  check(stack.redo.length === 0, "a fresh edit clears the redo stack");
  check(step(stack, doc, "redo") === null, "redo after a fresh edit returns null");
}

// ---------- 6. page-switch clear ------------------------------------------
{
  const doc = mkDoc();
  const stack = U.undoNewStack(50);
  U.undoPush(stack, U.undoCapture(doc, [1], "delete 1"));
  doc.excluded.add(1);
  step(stack, doc, "undo");
  U.undoPush(stack, U.undoCapture(doc, [2], "delete 2"));
  doc.excluded.add(2);
  U.undoClear(stack);
  check(stack.undo.length === 0 && stack.redo.length === 0,
    "undoClear empties both stacks");
  check(step(stack, doc, "undo") === null && step(stack, doc, "redo") === null,
    "nothing to step after a clear");
}

// ---------- 7. entries are per-edit sized, never per-sheet ----------------
{
  const doc = mkDoc();
  const one = U.undoCapture(doc, [1], "delete 1");
  const all = U.undoCapture(doc, doc.chains.map(c => c.chain_id), "everything");
  check(U.undoEntryBytes(one) < U.undoEntryBytes(all),
    "a one-chain snapshot is smaller than a whole-doc snapshot");
  check(one.chains.length === 1 && one.excluded.length === 1 && one.labels.length === 1,
    "a one-chain snapshot lists exactly one chain");
}

// ---------- 8. the STYLE region (operator-created line families) ---------
// A created family is a real row in state.result.styles plus four per-style
// map entries (labels / include / measureMode / seedLabels). If undo reversed
// the LINE MOVE but not the ROW, the sheet would keep an empty family the
// operator never asked for - and if it reversed the row but not the maps, the
// include map would keep a tick pointing at a style_id that no longer exists.
// Both are silent. This pins them.
function mkStyleDoc() {
  const doc = mkDoc();
  doc.styles = [
    { style_id: 10, suggested_label: "CURB", class: "solid", color: [0, 0, 0] },
    { style_id: 20, suggested_label: "CONTOUR", class: "dash1", color: [1, 0, 0] },
    { style_id: 30, suggested_label: "FENCE", class: "dash2", color: [0, 1, 0] },
  ];
  const labels = new Map([[10, "CURB"], [20, "CONTOUR"]]);
  const include = new Map([[10, true], [20, true], [30, false]]);
  const measure = new Map([[30, "object"]]);
  const seeds = new Map([[10, "solid solid"], [20, "dash1 d9g5"]]);
  doc.smaps = [labels, include, measure, seeds];
  doc._m = { labels, include, measure, seeds };
  return doc;
}
function snapStyles(doc) {
  return JSON.stringify({
    styles: doc.styles,
    maps: doc.smaps.map(m => [...m.entries()].sort((x, y) => x[0] - y[0])),
  });
}
{
  const doc = mkStyleDoc();
  const stack = U.undoNewStack(50);
  const before = snap(doc) + "|" + snapStyles(doc);

  // the famCreate gesture: capture the row that does not exist yet PLUS the
  // chain about to move, then create the row, its map entries, and reclass
  U.undoPush(stack, U.undoCapture(doc, [3], 'new family "DITCH"', [99]));
  doc.styles.push({ style_id: 99, suggested_label: "DITCH", class: "dash1",
                    color: [1, 0, 0], operator_created: true, length_pt: 0, n: 0 });
  doc._m.labels.set(99, "DITCH");
  doc._m.include.set(99, true);
  doc._m.seeds.set(99, "");
  const moved = materialize(doc, byId(doc, 3));
  moved.style_id = 99;
  doc.selected = moved.chain_id;
  const after = snap(doc) + "|" + snapStyles(doc);

  check(doc.styles.length === 4, "the created family is on the sheet");
  check(doc._m.include.get(99) === true, "…and ticked on");

  for (let pass = 1; pass <= 2; pass++) {
    step(stack, doc, "undo");
    check(snap(doc) + "|" + snapStyles(doc) === before,
      `new-family undo restores the document byte-identically (pass ${pass})`);
    check(doc.styles.every(s2 => s2.style_id !== 99),
      `…the family row is gone, not left empty (pass ${pass})`);
    check(!doc._m.include.has(99) && !doc._m.labels.has(99)
          && !doc._m.seeds.has(99),
      `…and no per-style map keeps an entry for it (pass ${pass})`);
    step(stack, doc, "redo");
    check(snap(doc) + "|" + snapStyles(doc) === after,
      `new-family redo reapplies the row AND the move (pass ${pass})`);
    check(doc._m.labels.get(99) === "DITCH",
      `…including the name the operator typed (pass ${pass})`);
  }
}
{
  // a style row REWRITTEN rather than created (the same region, other branch):
  // the row must come back with its old content and at its old index
  const doc = mkStyleDoc();
  const stack = U.undoNewStack(50);
  const before = snapStyles(doc);
  U.undoPush(stack, U.undoCapture(doc, [], "rename", [20]));
  doc.styles[1].suggested_label = "CONTOUR (renamed)";
  doc._m.labels.set(20, "CONTOUR (renamed)");
  doc._m.measure.set(20, "object");
  step(stack, doc, "undo");
  check(snapStyles(doc) === before,
    "a rewritten style row and its map entries restore exactly");
  check(doc.styles[1].style_id === 20,
    "…at its original index, not appended to the end");
}
{
  // the region must be inert for every edit that does not use it - this is
  // what keeps the 476 B median snapshot in the comment above honest
  const doc = mkStyleDoc();
  const e = U.undoCapture(doc, [1], "delete 1");
  check(Array.isArray(e.styles) && e.styles.length === 0,
    "a chain-only capture carries an EMPTY style region");
  const bare = mkDoc();            // no .styles, no .smaps at all
  const e2 = U.undoCapture(bare, [1], "delete 1");
  check(e2.styles.length === 0,
    "a doc with no style region at all captures cleanly rather than throwing");
  bare.excluded.add(1);
  const r = U.undoApply(bare, e2);
  check(r && bare.excluded.size === 0,
    "…and applies cleanly too");
}

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall undo-core tests passed");
