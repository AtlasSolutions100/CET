// PER-PAGE STATE HAS ONE WRITER, AND THIS TEST IS WHY IT STAYS THAT WAY.
//
// THE CLASS, NOT THE INSTANCE. F5 was reported as "the earthwork panel
// belongs to one sheet" and fixed with ewPageReset(), called from
// selectPage - the chokepoint that ALWAYS runs, unlike loadResult, which
// runs only when the new page HAS a loadable result. That fix was correct
// and it was one instance of a class. Measured at 7eb2a2d by extracting the
// two functions and diffing their assignment sets: loadResult initialised 47
// `state.*` fields and 19 DOM properties; selectPage cleared 29 of the
// fields and 1 of the properties. The 18 fields and 18 properties in the gap
// were live per-page state that survived a switch to an UNDETECTED sheet:
//
//   state.tr  state.sym / symMarks / symInfo  state.xs  state.co
//   state.areaInc / areaLabels / areaRows / areaHot   state.extraItems
//   state.tool / measurePts / vScale   state.hotChain / hotStyle
//   state.include / labels / chainLabels / excluded / clickPt / nextChainId
//   and the PANELS: #trPanel, #symPanel, #rollPanel, #xsPanel, #coPanel
//
// The symptom is F5's exactly: switch to an undetected sheet and the trench
// panel is still open, holding the previous sheet's inputs, over a drawing
// it does not describe.
//
// WHAT IS PINNED, AND WHY IT IS NOT A LIST OF TODAY'S FIELDS.
// A test that enumerated the eighteen would pass forever while the
// nineteenth field somebody adds next month goes unreset. So what is pinned
// is the INVARIANT that makes a nineteenth impossible to forget:
//
//   1. pageReset() is the SINGLE WRITER of per-page state.
//   2. selectPage may assign exactly two `state.*` fields of its own -
//      `page` and `img`, the sheet's identity and its raster - and must
//      call pageReset() for the rest.
//   3. loadResult may assign exactly two - `result` and `nextChainId`,
//      both seeded FROM the result it just fetched - and must call
//      pageReset() first, before either.
//   4. Neither may write a DOM property directly.
//
// Add a field to loadResult and check 3 fails. Add one to selectPage and
// check 2 fails. Put it in pageReset - the only remaining place - and it is
// cleared on every page switch by construction. That is the point.
//
// Suite B then RUNS pageReset against a stub DOM seeded with a previous
// sheet's state, because a source-shape test cannot tell whether the
// function actually clears anything.
//
// webui/app.js is not a module and touches the DOM at load, so the
// behavioural suite evals the extracted functions against a hand-built stub
// DOM - the same technique as MULTISELECT / LINE-FAMILY / SEL-ELEVATION.
//
// Dependency-free:  node tests/test_page_reset.js

"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "webui", "app.js"), "utf8");

let fails = 0;
const check = (ok, msg) => {
  if (ok) console.log("  ok: " + msg);
  else { fails++; console.error("  FAIL: " + msg); }
};
const eq = (got, want, msg) =>
  check(got === want, msg + "  (got " + JSON.stringify(got) + ")");

function fnSrc(name) {
  let j = SRC.indexOf("\nfunction " + name + "(");
  if (j < 0) j = SRC.indexOf("\nasync function " + name + "(");
  if (j < 0) throw new Error("function not found in app.js: " + name);
  let d = 0;
  for (let k = SRC.indexOf("{", j); k < SRC.length; k++) {
    if (SRC[k] === "{") d++;
    else if (SRC[k] === "}" && --d === 0) return SRC.slice(j + 1, k + 1);
  }
  throw new Error("unbalanced braces reading " + name);
}
// Comments in this file describe the OLD behaviour by name, so they have to
// come out before anything is counted - otherwise the prose above a fix
// satisfies the assertion the fix is supposed to earn.
const strip = (b) => b.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
// `state.x =`, `state.x +=`, `state.x++` - assignments, not reads, and not
// `state.x.set(...)` (seeding a map the reset already replaced is fine).
function stateWrites(body) {
  const out = new Set();
  const re = /\bstate\.([A-Za-z_$][\w$]*)\s*(?:\+\+|--|[-+*/]?=(?!=))/g;
  let m;
  while ((m = re.exec(strip(body)))) out.add(m[1]);
  return out;
}
// `$("id").prop = ...`, `$("id").classList.add(...)`, `$("id").innerHTML = ...`
function domWrites(body) {
  const out = new Set();
  const re = /\$\("([A-Za-z0-9_]+)"\)(?:\.classList)?\.([A-Za-z]+)\s*(?:=(?!=)|\()/g;
  let m;
  const s = strip(body);
  while ((m = re.exec(s))) {
    if (m[2] === "querySelector" || m[2] === "querySelectorAll") continue;
    out.add(m[1] + "." + m[2]);
  }
  return out;
}

// ===========================================================================
console.log("A. one writer: the two callers may not clear anything themselves");
// ===========================================================================
const SELECT = fnSrc("selectPage");
const LOAD = fnSrc("loadResult");
const RESET = fnSrc("pageReset");

// The allow-lists ARE the contract, and each entry carries its reason.
//   selectPage: which sheet we are on, and the raster it loads for it.
//   loadResult: the detection, and the next free chain id derived from it.
const SELECT_OK = { page: "which sheet is open - identity, not content",
                    img: "the page raster, loaded by this function itself" };
const LOAD_OK = { result: "the detection just fetched",
                  nextChainId: "derived from that detection's chains" };

for (const [name, body, ok] of [["selectPage", SELECT, SELECT_OK],
                                ["loadResult", LOAD, LOAD_OK]]) {
  const got = [...stateWrites(body)].sort();
  const extra = got.filter((f) => !Object.prototype.hasOwnProperty.call(ok, f));
  const want = Object.keys(ok).sort();
  const missing = want.filter((f) => got.indexOf(f) < 0);
  check(extra.length === 0,
    name + " assigns NO per-page state of its own beyond {" + want.join(", ")
    + "} — a field initialised here and not in pageReset() is a field that "
    + "survives a switch to an undetected sheet"
    + (extra.length ? "  — UNRESET: state." + extra.join(", state.") : ""));
  check(missing.length === 0,
    name + " still assigns the ones it is supposed to own"
    + (missing.length ? "  (missing " + missing.join(", ") + ")" : ""));
  const dom = [...domWrites(body)].sort();
  check(dom.length === 0,
    name + " writes no DOM property directly — panels are per-page state too, "
    + "and #trPanel staying open on an undetected sheet was the reported "
    + "symptom" + (dom.length ? "  — found " + dom.join(", ") : ""));
  check(/\bpageReset\(\)/.test(strip(body)), name + " calls pageReset()");
}
{
  // ORDER MATTERS IN ONE DIRECTION ONLY: pageReset() nulls state.result, so
  // loadResult must call it BEFORE it assigns the parsed result, or the
  // reset would throw the detection away.
  const s = strip(LOAD);
  check(s.indexOf("pageReset()") >= 0
        && s.indexOf("pageReset()") < s.indexOf("state.result ="),
    "loadResult calls pageReset() BEFORE it assigns state.result — the "
    + "reset nulls it, so the other order loads a blank sheet");
}
{
  // ...and pageReset must not be called from anywhere that is not a page
  // boundary. Two call sites, plus its own definition.
  // call sites end in a semicolon; the declaration is `function pageReset()`
  const sites = (strip(SRC).match(/pageReset\(\)\s*;/g) || []).length;
  eq(sites, 2, "pageReset() is called from exactly the two page boundaries");
  eq((strip(SRC).match(/function pageReset\(/g) || []).length, 1,
    "...and there is exactly one definition of it");
}

// ===========================================================================
console.log("\nB. the reset really covers the eighteen the gap analysis found");
// ===========================================================================
// A FLOOR, NOT A CEILING. Suite A stops fields being added outside the
// reset; this stops them being quietly removed from inside it. Every name
// below was measured live in the 7eb2a2d gap between the two callers.
const GAP = [
  "tr", "sym", "symMarks", "symInfo", "xs", "co",
  "areaInc", "areaLabels", "areaRows", "areaHot",
  "extraItems", "tool", "measurePts", "vScale",
  "hotChain", "hotStyle",
  "include", "labels", "chainLabels", "excluded", "clickPt", "nextChainId",
  "result", "isolate", "selected", "selPt", "seedLabels",
];
const GAP_DOM = [
  "trPanel.hidden", "trBtn.hidden", "trResult.textContent",
  "symPanel.hidden", "symBtn.hidden", "rollPanel.hidden", "rollBtn.hidden",
  "xsPanel.hidden", "xsBtn.hidden", "coPanel.hidden", "coBtn.hidden",
  "aiBanner.hidden", "measureInfo.hidden", "restoreBtn.hidden",
];
{
  const w = stateWrites(RESET);
  const miss = GAP.filter((f) => !w.has(f));
  check(miss.length === 0,
    "pageReset writes every per-page field the gap analysis named"
    + (miss.length ? "  — MISSING state." + miss.join(", state.") : ""));
  const d = domWrites(RESET);
  const dmiss = GAP_DOM.filter((f) => !d.has(f));
  check(dmiss.length === 0,
    "...and closes every panel that used to survive the switch"
    + (dmiss.length ? "  — MISSING " + dmiss.join(", ") : ""));
  // the F5 fix itself is still delegated rather than copied, so its own
  // comment stays the record of what that one cost
  for (const h of ["ewPageReset", "gzPageReset", "elevReset"])
    check(new RegExp("\\b" + h + "\\(\\)").test(strip(RESET)),
      "pageReset delegates to " + h + "() rather than duplicating it");
}

// ===========================================================================
console.log("\nC. RUN it: a previous sheet's state does not survive the call");
// ===========================================================================
// Source shape cannot tell you the function clears anything. This seeds the
// state a detected sheet leaves behind, runs the real pageReset (with the
// real ewPageReset / gzPageReset / elevReset inside it), and reads back.
function elem() {
  return {
    hidden: false, textContent: "x", innerHTML: "<div>old rows</div>",
    checked: true, value: "", disabled: false, style: {},
    _cls: new Set(["off", "on", "active"]),
    classList: {
      add(c) { this._o._cls.add(c); },
      remove(c) { this._o._cls.delete(c); },
      contains(c) { return this._o._cls.has(c); },
      toggle(c, v) { v ? this._o._cls.add(c) : this._o._cls.delete(c); },
    },
    querySelector() { return null; }, querySelectorAll() { return []; },
    appendChild(c) { return c; }, setAttribute() {}, focus() {},
  };
}
function runReset() {
  const els = {};
  const $ = (id) => {
    if (!els[id]) { els[id] = elem(); els[id].classList._o = els[id]; }
    return els[id];
  };
  // A DETECTED SHEET'S LEAVINGS. Every one of these is a value that was
  // measured surviving a switch to an undetected page at 7eb2a2d.
  const state = {
    job: "J", page: 3, gen: 7,                 // identity: must NOT move
    img: {}, result: { styles: [], chains: [] },
    isolate: 12, selected: 99, selPt: 4, clickPt: [1, 2],
    include: new Map([[1, true]]), labels: new Map([[1, "OLD"]]),
    seedLabels: new Map([[1, "x"]]), chainLabels: new Map([[9, "y"]]),
    inheritedInc: new Map([[1, true]]), excluded: new Set([5]),
    nextChainId: 500,
    multiSel: new Set([1, 2]), marquee: { a: 1 },
    hotChain: 9, hotStyle: new Set([1]),
    sgPartial: new Map([["solid", new Set([1])]]),
    drawSnaps: [1], snapHit: {}, snapMsg: "snapped",
    extendAnchor: {}, drawPend: {},
    tool: "measure", measurePts: [[0, 0]], vScale: 3,
    ai: { x: 1 }, aiWhy: new Map([[1, "w"]]), aiUndo: {}, aiAuto: true,
    aiHidden: true, measureMode: new Map([[1, "object"]]),
    ew: { rows: [1, 2, 3], page: 3, job: "J" }, ewLoading: true,
    ewFailed: { status: 500 }, suggestReq: {},
    ewBound: { poly: [1] }, ewBoundDraft: [[0, 0]], ewBoundHover: 2,
    elev: { status: "ready", byChain: new Map([[192, { z: 545 }]]) },
    gzones: [{ id: 1 }], gzDraft: [[0, 0]], gzHover: 1, gzDrag: {}, gzSeq: 9,
    workZones: [{ x: 1 }], wzDrag: {}, wzRev: 4,
    conf: { v: 1 }, confKey: "k", confErr: true,
    ckDone: new Set([1]), ckShowAll: true, ckCollapsed: true,
    areaInc: new Map([[1, true]]), areaLabels: new Map([[1, "a"]]),
    areaRows: [{ id: 1 }], areaHot: 3,
    extraItems: [{ label: "hand row" }],
    tr: { bands: [1, 2] }, sym: { g: 1 }, symMarks: [[0, 0]],
    symInfo: { n: 1 }, xs: { rows: [1] }, co: { rows: [1] },
  };
  const famOpen = new Map([[1, 50]]);
  const scope = {
    state, $, famOpen,
    undoStack: [{ snap: 1 }],
    undoClear: (st) => { st.length = 0; },
    drawFamClose: () => {}, toolRowLabel: () => {},
    renderEwBound: () => {}, ewBusyPut: () => {}, renderGz: () => {},
    clearTimeout: () => {}, setTimeout: () => 0,
    gzModalZone: {}, gzModalPoly: {}, gzModalTimer: 1, gzModalSeq: 0,
  };
  const names = Object.keys(scope);
  const body = fnSrc("pageReset") + "\n" + fnSrc("ewPageReset") + "\n"
             + fnSrc("gzPageReset") + "\n" + fnSrc("elevReset");
  new Function(...names, body + "\nreturn pageReset;")
    (...names.map((n) => scope[n]))();
  return { state, els, famOpen, undo: scope.undoStack };
}

{
  const { state, els, famOpen, undo } = runReset();

  // identity is NOT page content
  eq(state.page, 3, "the page number itself survives - it is identity");
  eq(state.job, "J", "...and so does the job");
  eq(state.gen, 7, "...and the generation token");

  // the detection and its derivatives
  eq(state.result, null, "the previous sheet's detection is gone");
  eq(state.isolate, null, "isolate is dropped - style_ids are per page");
  eq(state.selected, null, "nothing is selected");
  eq(state.selPt, null, "...and no vertex of it either (was left stale)");
  eq(state.nextChainId, 1, "the next chain id restarts");
  eq(state.include.size, 0, "no family is ticked from the old sheet");
  eq(state.labels.size, 0, "no labels carry over");
  eq(state.chainLabels.size, 0, "no per-line labels carry over");
  eq(state.excluded.size, 0, "no deletions carry over");
  eq(state.hotStyle, null, "the hover highlight is cleared");
  eq(state.hotChain, null, "...both halves of it");
  eq(famOpen.size, 0, "expanded family lists are closed");
  eq(undo.length, 0, "the undo stack is emptied - its snapshots are per page");

  // the toolkit
  eq(state.tool, null, "no tool stays armed");
  eq(state.measurePts.length, 0, "a half-taken measurement is dropped");
  eq(state.vScale, null, "and its scale");

  // THE EIGHTEEN, one assertion each where the value is readable
  eq(state.tr, null, "TRENCH: the previous sheet's run is gone");
  eq(els.trPanel.hidden, true,
    "TRENCH: the panel is CLOSED — open, holding the previous sheet's "
    + "inputs, over an undetected drawing was the reported symptom");
  eq(els.trResult.textContent, "", "TRENCH: and its numbers are cleared");
  eq(els.trBandRows.innerHTML, "", "TRENCH: and the band table's rows");
  check(els.trTake.classList.contains("off"),
    "TRENCH: the 'add to takeoff' consent button is put away");
  eq(state.sym, null, "SYMBOLS: counts gone");
  eq(state.symMarks, null, "SYMBOLS: and their canvas marks");
  eq(els.symPanel.hidden, true, "SYMBOLS: panel closed");
  eq(els.rollPanel.hidden, true, "ROLLUP: panel closed");
  eq(state.xs, null, "CROSS SECTIONS: gone");
  eq(els.xsPanel.hidden, true, "CROSS SECTIONS: panel closed");
  eq(state.co, null, "CALLOUTS: gone");
  eq(els.coPanel.hidden, true, "CALLOUTS: panel closed");
  eq(state.areaRows.length, 0, "AREAS: rows gone");
  eq(state.areaInc.size, 0, "AREAS: selections gone");
  eq(state.areaHot, null, "AREAS: hover gone");
  eq(state.extraItems.length, 0, "hand-added takeoff rows are gone");
  eq(els.aiBanner.hidden, true, "the analyzer banner is closed");
  eq(state.ai, null, "...and its verdict");
  eq(els.measureInfo.hidden, true, "the measure readout is hidden");
  check(!els.measureBtn.classList.contains("active"),
    "the measure button is not left lit");
  eq(els.restoreBtn.hidden, true, "the restore button is hidden");

  // F5's own fields, still cleared through the delegate
  eq(state.ew, null, "EARTHWORK: rows gone (F5, via ewPageReset)");
  eq(state.ewBound, null, "EARTHWORK: the limit of work gone");
  eq(els.ewPanel.hidden, true, "EARTHWORK: panel closed");
  eq(state.elev.status, "idle", "the elevation reader is back to idle");
  check(state.elev.byChain === null, "...with no map from the old sheet");
  eq(state.gzones.length, 0, "GRADING ZONES: gone");
  eq(state.workZones.length, 0, "WORK AREA: boxes gone");
  eq(state.wzRev, 5, "...and its cache token moved, so nothing is reused");

  // the confidence banner and the review queue
  eq(state.conf, null, "the confidence banner is cleared");
  eq(state.ckDone, null, "the review check-offs are cleared");
  eq(state.ckShowAll, false, "...and their view flags");
}

if (fails) {
  console.error("\n" + fails + " check(s) failed");
  process.exit(1);
}
console.log("\nall page-reset checks passed");
