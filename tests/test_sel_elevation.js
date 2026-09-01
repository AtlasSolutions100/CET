// THE SELECTION PILL'S ELEVATION, AND WHY IT IS NOT A WORD IN A SENTENCE.
//
// Reported as "a selected contour stopped showing its elevation". The number
// was never missing: updateSelBar still computed it and still wrote it into
// #selInfo. It was CLIPPED. " · EL <z>" was the last token of the string in
// <span class="sel-txt">, and .sel-txt is the ONLY shrinkable child of that
// pill (overflow:hidden; text-overflow:ellipsis). Three flex:none controls
// landed on the same pill on 2026-08-30/31 - the family <select>, the "in
// list" button and the per-line colour swatch, 248.9 px between them - while
// .canvas-status stayed capped at a fraction of the canvas column. On a
// 1097 px window .sel-txt got 95 px for a 299 px string, so the tail went
// behind the ellipsis and the tail was the elevation.
//
// Measured on Oncor Cloudcrest, engine page index 3 = printed sheet C-04,
// contour chain 192, whose sheet prints 545 in the break of that dashed
// contour: DOM text "… · 62 points · EL 545", rendered as "…278 LF · 6…".
// Clipped at 1097 / 1280 / 1370 px, visible from ~1400 px up.
//
// WHAT IS PINNED HERE
//
//   1. THE STRING NO LONGER CARRIES THE NUMBER, and the chip does. Evaluated
//      for real against a fake DOM, because "is EL inside the shrinkable
//      span or outside it" is the entire bug and a source grep for "EL " is
//      satisfied by the broken version.
//   2. NOTHING RENDERS WHEN THERE IS NO ELEVATION. A non-contour selection
//      must not grow an empty pill.
//   3. THE CHIP CANNOT BE ELLIPSIZED. flex:none in CSS, and .sel-txt keeps
//      the ellipsis it is supposed to have - the point is which child gets
//      to shrink, so both halves are asserted.
//   4. ensureElev CARRIES THE GEN/JOB/PAGE GUARD that loadResult and poll
//      already carry. Without it a page switch mid-fetch leaves the previous
//      page's elevations in state.elevMap, and chain ids collide numerically
//      across pages - so a contour on the new sheet gets labelled with the
//      old sheet's elevation. A wrong number, not a missing one, and this
//      codebase's worst shape. Evaluated, not grepped.
//   5. THE FULL SENTENCE IS RECOVERABLE ON HOVER for whatever else clips.
//
// webui/app.js is not a module and touches the DOM at load, so the
// behavioural suites eval the extracted functions against a hand-built stub
// DOM - the same technique as MULTISELECT / LINE-FAMILY / EW-BUSY-STATE.
//
// Dependency-free:  node tests/test_sel_elevation.js

"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "webui", "app.js"), "utf8");
const CSS = fs.readFileSync(path.join(ROOT, "webui", "style.css"), "utf8");

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

// --- the smallest DOM updateSelBar can run against -------------------------
function elem(tag) {
  return {
    tagName: tag, className: "", textContent: "", title: "", type: "",
    hidden: false, disabled: false, style: {}, children: [],
    appendChild(c) { this.children.push(c); return c; },
    setAttribute() {}, querySelector() { return null; },
    get _text() {
      return this.textContent
        + this.children.map(c => c._text !== undefined ? c._text : "").join("");
    },
  };
}
function byClass(node, cls) {
  return node.children.filter(c => (c.className || "").split(" ").indexOf(cls) >= 0);
}

function renderBar(opts) {
  const els = {};
  for (const id of ["splitBtn", "extendBtn", "sepBtn", "cutSpanBtn",
                    "drawBtn", "removeBtn", "selInfo"]) els[id] = elem("div");
  const state = {
    result: { styles: [{ style_id: 7, suggested_label: "dash1 d18.0 g51.7" }] },
    chainLabels: new Map(), labels: new Map(),
    selPt: null, selected: null,
    elevMap: opts.elevMap,
  };
  const ch = { chain_id: 192, style_id: 7, class: "dash1",
               points: new Array(62).fill([0, 0]) };
  const scope = {
    $: (id) => els[id],
    state,
    document: { createElement: elem },
    ensureElev: () => {},
    chainById: () => ch,
    chainLenPt: () => 278,
    fmtQty: (v) => v + " LF",
    wzChainFrac: () => 1,
    wzActive: () => false,
    chainCountedPt: () => 0,
    familySelect: () => { const e = elem("select"); e.className = "fam-sel"; return e; },
    familySwitch: () => {}, famNewFromSelection: () => {},
    revealStyleRow: () => {},
    chainColorInfo: () => ({ src: "engine", css: "#888" }),
    colorSrcLabel: () => "x", colorPopForChain: () => {},
  };
  const names = Object.keys(scope);
  new Function(...names, fnSrc("updateSelBar") + "\nreturn updateSelBar;")
    (...names.map(n => scope[n]))(ch);
  return els.selInfo;
}

// ---------------------------------------------------------------------------
console.log("1. the elevation is a chip, not the tail of the shrinkable string");
// ---------------------------------------------------------------------------
{
  const info = renderBar({ elevMap: new Map([[192, 545]]) });
  const txt = byClass(info, "sel-txt")[0];
  const chip = byClass(info, "sel-el")[0];

  check(!!txt, "the pill still has its .sel-txt sentence");
  check(!!chip, "the pill has a dedicated .sel-el chip");
  eq(chip && chip.textContent, "EL 545", "the chip carries the elevation");
  check(txt.textContent.indexOf("EL") < 0,
    "the elevation is NOT inside .sel-txt - THE REPORTED BUG: that span is "
    + "the only child that can shrink, so its tail is what the ellipsis eats");
  check(txt.textContent.indexOf("278 LF") >= 0 && txt.textContent.indexOf("62 points") >= 0,
    "the rest of the sentence is unchanged");
  check(info._text.indexOf("EL 545") >= 0,
    "and the pill as a whole still reads out the elevation");
  // the chip must be a SIBLING of the shrinkable span, never nested in it
  check(byClass(info, "sel-el").length === 1 && txt.children.length === 0,
    "the chip is a sibling of .sel-txt, not a child of it");
}

// ---------------------------------------------------------------------------
console.log("2. no elevation, no chip (not an empty box)");
// ---------------------------------------------------------------------------
for (const [name, map] of [
  ["a line the sheet never labelled", new Map([[999, 12]])],
  ["an empty elevation map", new Map()],
  ["the map still loading (null)", null],
  ["the map never requested (undefined)", undefined],
]) {
  const info = renderBar({ elevMap: map });
  eq(byClass(info, "sel-el").length, 0, name + ": no chip is appended");
}
{
  // z present but null - the server does emit null z on spot grades, and a
  // "EL null" chip would be worse than none
  const info = renderBar({ elevMap: new Map([[192, null]]) });
  eq(byClass(info, "sel-el").length, 0, "a null elevation renders no chip");
}
{
  // 0 is a real elevation. It is falsy; the guard must be a null/undefined
  // test, not truthiness (CLAUDE.md §5: "0.0 is not None").
  const info = renderBar({ elevMap: new Map([[192, 0]]) });
  const chip = byClass(info, "sel-el")[0];
  check(!!chip, "elevation 0 still renders - falsy is not missing");
  eq(chip && chip.textContent, "EL 0", "...and reads EL 0");
}

// ---------------------------------------------------------------------------
console.log("3. the chip cannot be ellipsized; .sel-txt still can");
// ---------------------------------------------------------------------------
const selEl = (CSS.match(/\n\.sel-el \{[^}]*\}/) || [""])[0];
check(/flex:\s*none/.test(selEl), ".sel-el is flex:none, so flexbox cannot shrink it");
check(/white-space:\s*nowrap/.test(selEl), ".sel-el never wraps");
check(!/text-overflow/.test(selEl), ".sel-el has no ellipsis of its own");
const selTxt = (CSS.match(/\n\.sel-txt \{[^}]*\}/) || [""])[0];
check(/text-overflow:\s*ellipsis/.test(selTxt),
  ".sel-txt keeps its ellipsis - the point is WHICH child gives way, not that none does");
check(/#selInfo \.fam-sel \{[^}]*max-width:\s*130px/.test(CSS),
  "the family select is narrowed on the selection pill, giving the sentence room back");
check(/\.fam-sel \{[^}]*max-width:\s*180px/.test(CSS),
  "...and the multi-bar's own family select is untouched at 180px");
{
  const cs = (CSS.match(/\n\.canvas-status \{[^}]*\}/) || [""])[0];
  const m = cs.match(/max-width:\s*(\d+)%/);
  check(!!m && +m[1] > 70,
    "the pill container is wider than the 70% that starved it  (now " + (m && m[1]) + "%)");
  check(/flex-wrap:\s*wrap/.test(cs),
    "and it wraps, so a Ctrl+click multi-bar sharing the row cannot squeeze "
    + ".sel-txt to zero width");
}

// ---------------------------------------------------------------------------
console.log("4. the whole sentence is recoverable on hover");
// ---------------------------------------------------------------------------
{
  const info = renderBar({ elevMap: new Map([[192, 545]]) });
  const txt = byClass(info, "sel-txt")[0];
  eq(txt.title, txt.textContent,
    "whatever DOES clip (a long family label, the point count) is on the title");
  const chip = byClass(info, "sel-el")[0];
  check(chip.title && /read off the sheet/.test(chip.title),
    "the chip says where the number came from - the sheet's own printed labels");
}

// ---------------------------------------------------------------------------
console.log("5. ensureElev refuses to write into another page");
// ---------------------------------------------------------------------------
function runEnsure(mid) {
  const state = { elevMap: undefined, gen: 1, job: "J", page: 3, selected: null };
  const body = { suggestions: [{ chain_id: 192, z: 545 }] };
  const scope = {
    state,
    fetch: async () => { if (mid) mid(state); return { ok: true, json: async () => body }; },
    updateSelBar: () => {},
    chainById: () => null,
  };
  const names = Object.keys(scope);
  const fn = new Function(...names, fnSrc("ensureElev") + "\nreturn ensureElev;")
    (...names.map(n => scope[n]));
  return fn().then(() => state);
}
runEnsure(null).then(st => {
  check(st.elevMap instanceof Map && st.elevMap.get(192) === 545,
    "the happy path still builds the map");
  return runEnsure(s => { s.page = 2; });
}).then(st => {
  check(!(st.elevMap instanceof Map),
    "a PAGE switch mid-fetch: page 3's elevations are NOT written onto page 2 "
    + "(chain ids collide across pages, so this silently mislabels a line)");
  return runEnsure(s => { s.gen++; });
}).then(st => {
  check(!(st.elevMap instanceof Map), "a generation bump mid-fetch is dropped too");
  return runEnsure(s => { s.job = "K"; });
}).then(st => {
  check(!(st.elevMap instanceof Map), "and a JOB switch mid-fetch");
  // the same three-part guard loadResult and poll already carry
  check(/gen !== state\.gen \|\| job !== state\.job \|\| page !== state\.page/
        .test(fnSrc("ensureElev")),
    "the guard tests all three of gen, job and page, like loadResult and poll");
  if (fails) { console.error("\n" + fails + " check(s) failed"); process.exit(1); }
  console.log("\nall selection-elevation checks passed");
}).catch(e => {
  console.error("  FAIL: ensureElev suite threw " + (e && e.stack || e));
  process.exit(1);
});
