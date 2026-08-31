// Ctrl+click multi-select and the multi-handle toolkit.
//
// The owner asked for this (2026-09-01): "holding ctrl to multi-select
// whethers its from line styles or the lines themselves on the rendered page
// ... I should be able to multi-select these lines and have a multi-toolkit
// option appear ... so the options are more like change to this line family,
// change color, give it a name, delete, etc."
//
// WHY EACH SUITE IS HERE
//
//   1. THE SELECTION MODEL, pure. One canonical store (a Set of chain_ids);
//      family membership is DERIVED, never stored, so it cannot go stale
//      when a line is deleted, moved or consumed by a split. The toggle
//      grammar, the mixed styles+chains case, the resolution to a chain set
//      and the exact counts the bar prints are all pinned here, because
//      every one of them decides what a BULK action touches - and a bulk
//      action that touches one line more than the operator picked is this
//      codebase's silent-wrong-number shape.
//
//   2. ONE UNDO ENTRY PER BULK ACTION. Non-negotiable and stated in the
//      brief: a family move, a naming and a delete are EDITS, and one
//      Ctrl+Z must reverse the whole set operation - not line 1,240 of it.
//      A source scan, because the failure is structural: a captureUndo
//      moved INSIDE the per-chain loop still passes every behavioural test
//      that only checks the end state.
//
//   3. COLOUR IS STILL NOT UNDOABLE. The colour layer shipped as a RECORDED
//      DECISION with its own reset. tests/test_line_colors.js guards the two
//      shipped entry points; this adds the three the multi-selection brought
//      (msColorApply / msColorResetLines / msColorResetAll) and the popover
//      that opens them. Same reason: the failure mode is a later reader
//      "helpfully" adding the captureUndo that looks missing.
//
//   4. THE TOOLKIT SWAP, as markup and as wiring. Both groups exist, exactly
//      one shows, the five multi actions are all present and titled, and the
//      four tools that are NOT about one line stay outside the swap so a
//      multi-selection cannot make anything unreachable.
//
//   5. THE ESC LAYER. One press clears the multi-selection and restores the
//      toolkit, and it sits BELOW the tool cascade and ABOVE the picked
//      point / single selection / isolate - the shipped order, unbroken.
//
// webui/app.js is not a module and touches the DOM at load, so suite 1 evals
// ONLY the marked pure block, the same technique as TRENCH-MATH / WZ-MATH /
// UNDO-CORE / LINE-FAMILY. Everything else reads source as text.
//
// Dependency-free, like the other suites:  node tests/test_multiselect.js

"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "webui", "app.js"), "utf8");
const HTML = fs.readFileSync(path.join(ROOT, "webui", "index.html"), "utf8");
const CSS = fs.readFileSync(path.join(ROOT, "webui", "style.css"), "utf8");

function block(name, exportsExpr) {
  const a = SRC.indexOf("// " + name + "-BEGIN");
  const b = SRC.indexOf("// " + name + "-END");
  if (a < 0 || b < 0 || b <= a) {
    console.error("FAIL: " + name + " markers not found in webui/app.js");
    process.exit(1);
  }
  return new Function(SRC.slice(a, b) + "\n  return " + exportsExpr + ";")();
}

const M = block("MULTISEL-CORE", `{ msToggleChain, msToggleFamily, msResolve,
  msWholeFamilies, msCounts, msScopeText }`);

let failures = 0;
function check(cond, msg) {
  if (!cond) { failures++; console.error("FAIL:", msg); }
  else console.log("ok:", msg);
}
function eq(got, want, msg) {
  check(got === want,
    msg + `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);
}
function deq(got, want, msg) {
  eq(JSON.stringify(got), JSON.stringify(want), msg);
}

// ==========================================================================
// 1. THE SELECTION MODEL (pure)
// ==========================================================================
// A tiny sheet, deliberately the owner's own scenario: five UNNAMED families
// that are really one item, plus one big unrelated family.
//   fam 1 SE-P-UT-FIBER   chains 101,102        fam 2 C-FIBER    chain 201
//   fam 3 FO              chain 301             fam 4 FIBER-OPT  chains 401,402
//   fam 5 UT-FO           chain 501             fam 9 CONTOUR    chains 901..903
const SHEET = [
  { chain_id: 101, style_id: 1, len: 100 },
  { chain_id: 102, style_id: 1, len: 40 },
  { chain_id: 201, style_id: 2, len: 300 },
  { chain_id: 301, style_id: 3, len: 60 },
  { chain_id: 401, style_id: 4, len: 25 },
  { chain_id: 402, style_id: 4, len: 75 },
  { chain_id: 501, style_id: 5, len: 400 },
  { chain_id: 901, style_id: 9, len: 1000 },
  { chain_id: 902, style_id: 9, len: 1000 },
  { chain_id: 903, style_id: 9, len: 1000 },
];
const FAM = new Map();
for (const r of SHEET) FAM.set(r.style_id, (FAM.get(r.style_id) || 0) + 1);
const famLive = (sid) => FAM.get(sid) || 0;
const famIds = (sid) => SHEET.filter(r => r.style_id === sid).map(r => r.chain_id);
const rowsFor = (sel) => SHEET.filter(r => sel.has(r.chain_id));

// ---- toggling a single line ---------------------------------------------
{
  const sel = new Set();
  eq(M.msToggleChain(sel, 201), "added", "msToggleChain adds a line");
  eq(sel.size, 1, "…and the set holds it");
  eq(M.msToggleChain(sel, 201), "removed", "the same line toggles back out");
  eq(sel.size, 0, "…and the set is empty again");
  eq(M.msToggleChain(sel, null), "none", "a null id is refused, not stored");
  eq(M.msToggleChain(sel, undefined), "none", "an undefined id is refused too");
  eq(sel.size, 0, "…and neither leaked into the set");
}

// ---- toggling a whole family --------------------------------------------
{
  const sel = new Set();
  eq(M.msToggleFamily(sel, famIds(1)), "added", "msToggleFamily adds a family");
  deq([...sel].sort(), [101, 102], "…as ALL of that family's live chain ids");
  eq(M.msToggleFamily(sel, famIds(1)), "removed", "a second click removes it");
  eq(sel.size, 0, "…leaving nothing behind");
  eq(M.msToggleFamily(sel, []), "empty",
    "a family with no live lines reports empty rather than pretending");
  eq(M.msToggleFamily(sel, [null, undefined]), "empty",
    "…and a list of nothing-ids is the same case");
}

// ---- THE PARTIAL CASE: the one behaviour the derived model changes -------
// Family in whole, one line taken out by hand, family clicked again ->
// COMPLETES it. "Add" is the only honest reading of a toggle on a partial
// set, and the app's status line says which of the two happened.
{
  const sel = new Set();
  M.msToggleFamily(sel, famIds(4));               // 401, 402
  M.msToggleChain(sel, 401);                      // hand-removed
  deq([...sel], [402], "one line of a whole family can be taken back out");
  const w1 = M.msWholeFamilies(rowsFor(sel), famLive);
  deq(w1.whole, [], "…and the family is no longer WHOLE");
  deq(w1.partial, [4], "…it is reported PARTIAL, which is what gates the "
    + "family-level actions");
  eq(M.msToggleFamily(sel, famIds(4)), "added",
    "clicking the family row again COMPLETES it rather than clearing it");
  deq([...sel].sort(), [401, 402], "…both lines are in");
}

// ---- MIXED: whole families AND loose lines in one selection --------------
{
  const sel = new Set();
  M.msToggleFamily(sel, famIds(1));    // 101 102   whole
  M.msToggleFamily(sel, famIds(2));    // 201       whole
  M.msToggleFamily(sel, famIds(3));    // 301       whole
  M.msToggleChain(sel, 401);           // one line of family 4 -> partial
  M.msToggleChain(sel, 901);           // one line of family 9 -> partial
  const rows = rowsFor(sel);
  const w = M.msWholeFamilies(rows, famLive);
  deq(w.whole, [1, 2, 3], "whole families are named, ascending");
  deq(w.partial, [4, 9], "partly-selected families are named apart from them");

  const c = M.msCounts(rows, famLive);
  eq(c.lines, 6, "the line count is every resolved chain, whole or loose");
  eq(c.families, 5, "the family count spans BOTH kinds - 3 whole + 2 partial");
  eq(c.len, 100 + 40 + 300 + 60 + 25 + 1000, "the length is the sum of the "
    + "resolved chains only, never a whole family a line came from");
  deq(c.whole, [1, 2, 3], "counts carry the whole list");
  deq(c.partial, [4, 9], "counts carry the partial list");
}

// ---- resolution to a chain set (the thing every action acts on) ---------
{
  const sel = new Set([101, 102, 201, 777]);   // 777 was deleted by an edit
  const live = new Set(SHEET.map(r => r.chain_id));
  const order = SHEET.map(r => r.chain_id);
  deq(M.msResolve(sel, live, order), [101, 102, 201],
    "msResolve drops ids that are no longer live");
  // pick ORDER must not decide the result: the same three, picked backwards,
  // resolve to the same list in sheet order
  const sel2 = new Set([201, 102, 101]);
  deq(M.msResolve(sel2, live, order), M.msResolve(sel, live, order),
    "the resolved order is SHEET order, not the order they were clicked");
  deq(M.msResolve(new Set([201, 101]), live, null).sort(), [101, 201],
    "with no order given it still resolves the same membership");
  deq(M.msResolve(new Set(), live, order), [],
    "an empty selection resolves to nothing");
}

// ---- an empty family can never be counted as whole ----------------------
{
  // family 7 exists as a style row but every line of it was deleted
  const live7 = (sid) => (sid === 7 ? 0 : famLive(sid));
  const w = M.msWholeFamilies([], live7);
  deq(w.whole, [], "no rows -> no whole families");
  deq(w.partial, [], "no rows -> no partial families");
}

// ---- the exact string the bar prints ------------------------------------
{
  const fmt = (pt) => (pt >= 1000 ? (pt / 1000).toFixed(1) + "k" : String(pt)) + " LF";
  eq(M.msScopeText({ families: 5, lines: 1240, len: 12400 }, fmt),
     "5 families · 1,240 lines · 12.4k LF",
     "the bar prints the owner's own sentence, thousands separated");
  eq(M.msScopeText({ families: 1, lines: 1, len: 40 }, fmt),
     "1 family · 1 line · 40 LF",
     "…and it is singular when there is one of each");
}

// ==========================================================================
// 2. ONE UNDO ENTRY PER BULK ACTION  (source scan)
// ==========================================================================
function fnBody(name) {
  const at = SRC.indexOf("\nfunction " + name + "(");
  if (at < 0) return null;
  const open = SRC.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < SRC.length; i++) {
    if (SRC[i] === "{") depth++;
    else if (SRC[i] === "}" && --depth === 0) return SRC.slice(open, i + 1);
  }
  return null;
}

// Strip block/line comments before counting calls - the comments around these
// functions talk ABOUT captureUndo, and a comment must never fail a test.
function code(body) {
  return (body || "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

const BULK = ["multiDeleteAll", "multiMoveAll", "msNameAll", "famNewFromMulti"];
for (const nm of BULK) {
  const body = fnBody(nm);
  check(body !== null, `${nm}() exists in webui/app.js`);
  if (body === null) continue;
  const c = code(body);
  const n = (c.match(/captureUndo\(|famCreate\(/g) || []).length;
  // famNewFromMulti reaches the stack through famCreate, which is itself the
  // single-entry helper (it captures the style row AND the moved chains in
  // one entry) - so exactly one of the two, once, in every case.
  eq(n, 1, `${nm}() takes EXACTLY ONE undo snapshot for the whole set — `
    + "one Ctrl+Z has to reverse the whole bulk action");
  // ...and it must not be inside the per-chain loop, which is the failure a
  // count alone could still miss if the loop ran once in the test sheet.
  const loopAt = c.search(/for\s*\(\s*const\s+c\w*\s+of\s+chs\b/);
  const capAt = c.search(/captureUndo\(|famCreate\(/);
  if (loopAt >= 0)
    check(capAt >= 0 && capAt < loopAt,
      `${nm}() snapshots BEFORE the loop that mutates the chains, not inside it`);
}

// the whole set has to be NAMED to the snapshot, or undoApply restores a
// region smaller than the edit touched
for (const nm of ["multiDeleteAll", "multiMoveAll", "msNameAll"]) {
  const c = code(fnBody(nm));
  check(/map\(\s*\w+\s*=>\s*\w+\.chain_id\s*\)/.test(c),
    `${nm}() lists EVERY affected chain id in its snapshot`);
}

// msNameAll writes the one map the takeoff pools on, and nothing else
{
  const c = code(fnBody("msNameAll"));
  check(/state\.chainLabels\.set\(/.test(c),
    "msNameAll() names the lines through state.chainLabels — the same map "
    + "the shipped Separate tool writes, and the map computeTakeoffRows "
    + "pools its rows by");
  check(!/state\.excluded\.add\(|reclassCore\(|state\.result\.styles\.push\(/.test(c),
    "msNameAll() deletes nothing, moves nothing between families and "
    + "creates no style row — naming is the NON-destructive action");
}

// the takeoff really does pool by that map (the fact this feature is cheap on)
{
  const c = code(fnBody("computeTakeoffRows"));
  check(/state\.chainLabels\.get\(ch\.chain_id\)\s*\|\|/.test(c),
    "computeTakeoffRows() still pools rows by chain label first — this is "
    + "what makes 'name these as one item' produce ONE row");
}

// ==========================================================================
// 3. COLOUR IS STILL NOT UNDOABLE
// ==========================================================================
const COLOR_FNS = ["msColorApply", "msColorResetLines", "msColorResetAll",
                   "msColorPop"];
for (const nm of COLOR_FNS) {
  const body = fnBody(nm);
  check(body !== null, `${nm}() exists`);
  if (!body) continue;
  const c = code(body);
  check(!/captureUndo/.test(c),
    `${nm}() does NOT call captureUndo — colour is a recorded decision with `
    + "its own reset, and Ctrl+Z stays about geometry");
  check(!/undoPush|undoCapture|undoDoc/.test(c),
    `${nm}() does not reach the undo stack by any other name`);
  check(!/\.color\s*=/.test(c),
    `${nm}() never assigns to .color — the engine's measurement is left `
    + "exactly as measured (styleFp, and every set-level decision keyed on "
    + "it, depends on that)");
}
// and it goes through the SHIPPED writers, not a fourth colour path
{
  const c = code(fnBody("msColorApply"));
  check(/setFamColor\(/.test(c) && /setLineColor\(/.test(c),
    "msColorApply() writes through the shipped setFamColor / setLineColor");
  check(/c\.whole/.test(c),
    "msColorApply() decides family-vs-line from WHICH families are selected "
    + "whole — a partly-selected family must not have its unselected lines "
    + "repainted");
}

// ==========================================================================
// 4. THE TOOLKIT SWAP
// ==========================================================================
const MS_BTNS = ["msNameBtn", "msFamBtn", "msColorBtn", "msDelBtn", "msClearBtn"];
check(/<div id="tkSingle" class="tk-group">/.test(HTML),
  "#tkSingle wraps the single-line tools");
check(/<div id="tkMulti" class="tk-group" hidden>/.test(HTML),
  "#tkMulti is the multi-handle toolkit and starts hidden");
for (const id of MS_BTNS) {
  const m = HTML.match(new RegExp(`<button id="${id}" class="tk[^"]*" title="([^"]{5,})"`));
  check(!!m, `#${id} exists on the rail with a title`);
  check(new RegExp(`id="${id}"[^>]*>\\s*<svg`).test(HTML),
    `#${id} carries a drawn SVG icon, like the ones that shipped`);
  check(new RegExp(`\\$\\("${id}"\\)\\.onclick`).test(SRC),
    `#${id} is wired in app.js`);
}
// the five buttons live INSIDE #tkMulti, not loose on the rail
{
  const a = HTML.indexOf('<div id="tkMulti"');
  const b = HTML.indexOf("</div>", HTML.indexOf('id="msClearBtn"'));
  const inner = a >= 0 && b > a ? HTML.slice(a, b) : "";
  for (const id of MS_BTNS)
    check(inner.includes('id="' + id + '"'), `#${id} is inside #tkMulti`);
}
// the single-line tools are inside #tkSingle, and the four that are NOT
// about one line are OUTSIDE both groups so they never become unreachable
{
  const a = HTML.indexOf('<div id="tkSingle"');
  const b = HTML.indexOf("</div>", HTML.indexOf('id="removeBtn"'));
  const inner = a >= 0 && b > a ? HTML.slice(a, b) : "";
  for (const id of ["splitBtn", "extendBtn", "cutSpanBtn", "drawBtn",
                    "reclassBtn", "mergeBtn", "sepBtn", "removeBtn"])
    check(inner.includes('id="' + id + '"'),
      `#${id} is a single-line tool and swaps out with #tkSingle`);
  for (const id of ["measureBtn", "wzBtn", "wzClearBtn", "faithfulBtn", "kbdBtn"])
    check(!inner.includes('id="' + id + '"'),
      `#${id} stays on the rail whatever is selected — a multi-selection `
      + "must not make it unreachable");
}
// exactly one group is on screen, and the size of the selection is the only
// thing that decides which
{
  const c = code(fnBody("msSyncToolkit"));
  check(/single\.hidden\s*=\s*on/.test(c) && /multi\.hidden\s*=\s*!on/.test(c),
    "msSyncToolkit() shows exactly one group — never both, never neither");
  check(/state\.multiSel\s*&&\s*state\.multiSel\.size/.test(c),
    "…and the size of the ONE shipped selection set is what decides it");
  for (const id of MS_BTNS)
    check(new RegExp(`\\$\\("${id}"\\)\\.title`).test(c),
      `msSyncToolkit() rewrites #${id}'s title with the live scope, so the `
      + "action states what it will touch BEFORE it is pressed");
}
// the swap is driven from renderMultiBar, which every edit path already calls
{
  const c = code(fnBody("renderMultiBar"));
  check((c.match(/msSyncToolkit\(\)/g) || []).length >= 2,
    "renderMultiBar() syncs the toolkit on BOTH branches — the empty one too, "
    + "or the multi rail would survive its own selection");
  check(/msMarkRows\(\)/.test(c),
    "renderMultiBar() also repaints the style rows' selection marks");
}
// the bar prints the scope through the one shared string
{
  const c = code(fnBody("renderMultiBar"));
  check(/msScopeLine\(/.test(c),
    "the bar's readout comes from msScopeLine — the same sentence the rail's "
    + "titles use, so readout and disclosure cannot disagree");
}
// CSS: the two groups, and the [hidden] rule without which both would paint
check(/\.tk-group\s*\{[^}]*display:\s*flex/.test(CSS),
  "css: .tk-group is its own flex column so the rail looks the same either way");
check(/\.tk-group\[hidden\]\s*\{\s*display:\s*none/.test(CSS),
  "css: .tk-group[hidden] is explicit — the author display would otherwise "
  + "out-specify the UA's [hidden] and paint both groups at once");

// ==========================================================================
// 5. ESC LAYERING, and the shipped cascade below it
// ==========================================================================
{
  // there are eleven Escape handlers in this file (modals, pickers, the tip
  // popover). The CASCADE is the one that owns the canvas; anchor on the
  // keyboard-overlay line that only it has, then back up to its own `if`.
  const kb = SRC.indexOf('if (!$("kbdHelp").hidden) { $("kbdHelp").hidden = true;');
  const at = kb < 0 ? -1 : SRC.lastIndexOf('if (e.key === "Escape") {', kb);
  check(at >= 0, "the Escape cascade is where it was");
  const esc = SRC.slice(at, at + 6000);
  const iPop = esc.indexOf("msPopClose()");
  const iTool = esc.indexOf('state.tool === "drawline"');
  const iMulti = esc.indexOf("msClearSel()");
  const iSelPt = esc.indexOf("state.selPt !== null");
  const iIso = esc.indexOf("state.isolate !== null");
  check(iPop >= 0 && iPop < iTool,
    "an open anchored menu dies first — it is a menu, not a state");
  check(iTool >= 0 && iMulti > iTool,
    "the armed tools still get Escape BEFORE the multi-selection (the "
    + "shipped tools-first grammar)");
  check(iSelPt > iMulti,
    "ONE press clears the multi-selection, before the picked point");
  check(iIso > iSelPt,
    "…and isolate is still last, so nothing below the new layer moved");
  check(/msClearSel\(\)/.test(esc),
    "Esc clears through msClearSel — the same function the bar's Clear and "
    + "the rail's Clear call, so the toolkit is restored by all three");
}
// msClearSel restores the toolkit and touches no quantity
{
  const c = code(fnBody("msClearSel"));
  check(/state\.multiSel = new Set\(\)/.test(c) && /renderMultiBar\(\)/.test(c),
    "msClearSel() empties the set and repaints (which swaps the rail back)");
  check(!/captureUndo|state\.excluded|reclassCore|chainLabels/.test(c),
    "msClearSel() changes nothing on the sheet — clearing a selection is "
    + "not an edit");
}

// ==========================================================================
// 6. Ctrl+click reaches BOTH surfaces, and cannot steal an armed tool's click
// ==========================================================================
{
  const c = code(fnBody("handleCanvasClick"));
  check(/\(e\.ctrlKey \|\| e\.metaKey\)/.test(c),
    "handleCanvasClick answers Ctrl and Cmd alike");
  check(/!state\.tool/.test(c.slice(0, c.indexOf("msPickChain("))),
    "…and only while NO tool owns the canvas — an armed draw/measure/cut/join "
    + "keeps every click it had (the same gate the Shift+drag marquee uses)");
  const iCtrl = c.indexOf("msPickChain(");
  const iVert = c.indexOf("vertexAt(e)");
  check(iCtrl >= 0 && iVert > iCtrl,
    "the Ctrl+click branch runs before the vertex pick and the plain "
    + "selection, so it can never be swallowed by them");
  check(/chainHitAt\(/.test(c),
    "it picks the line with chainHitAt — the SAME hit test the plain click "
    + "uses, so the two can never disagree about what was clicked");
}
{
  // the style row: the modified click multi-selects, the plain click still
  // isolates, and Shift+drag is untouched
  check(/if \(e && \(e\.ctrlKey \|\| e\.metaKey\)[^)]*\) \{\s*\n?\s*msPickFamily\(s\);/
        .test(SRC.replace(/\r/g, "")),
    "a style row's Ctrl/Cmd+click adds or removes that FAMILY");
  check(/e\.shiftKey && !state\.tool/.test(SRC),
    "Shift+drag marquee is exactly as it shipped");
  const c = code(fnBody("msPickFamily"));
  check(/msToggleFamily\(state\.multiSel,/.test(c),
    "…and it feeds the SAME set the marquee fills (state.multiSel)");
  const c2 = code(fnBody("msPickChain"));
  check(/msToggleChain\(state\.multiSel,/.test(c2),
    "…as does the canvas half");
}
// the app-side family pick set and the WHOLE test share one predicate
{
  const a = code(fnBody("msFamIds"));
  const b = code(fnBody("msLiveByStyle"));
  check(/!state\.excluded\.has\(/.test(a) && /!state\.excluded\.has\(/.test(b),
    "the pick set and the 'is this family whole?' denominator use the same "
    + "live-line predicate — they can never disagree");
  check(!/_ms\w*Key|_msLive\w*\s*=/.test(b),
    "msLiveByStyle() is NOT memoized: an undo restores the obvious cache key "
    + "while the style_ids under it have changed");
}
// bulk actions walk the sheet in sheet order, not pick order
{
  const c = code(fnBody("multiLive"));
  check(/for \(const ch of state\.result\.chains\)/.test(c),
    "multiLive() walks the sheet, so a bulk action's result does not depend "
    + "on the order the operator built the selection in");
}

if (failures) { console.error(`\n${failures} FAILURE(S)`); process.exit(1); }
console.log("\nall multi-select checks passed");
