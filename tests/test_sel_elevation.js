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
//   6. THE CHIP SAYS WHERE THE NUMBER CAME FROM, AND SAYS IT HONESTLY.
//      Until 2026-08-31 the chip's tooltip read "read off the sheet's own
//      printed labels" for EVERY elevation, and an earlier version of this
//      file asserted that sentence was present - so the suite pinned a
//      claim that is false for a large minority of the rows.
//
//      Measured against the live service, Oncor Cloudcrest engine page
//      index 3 = printed sheet C-04 (GET /earthwork/suggest, 2026-08-31):
//      150 suggestions, how = 69 gap-ocr + 20 radius + 26 inherited +
//      35 interval-infill. 61 of 150 - 40.7% - carry an elevation that is
//      printed NOWHERE on the sheet: `inherited` was carried across an
//      end-to-end weld from another chain, `interval-infill` was counted
//      between two labelled contours.
//
//      So this suite asserts the DISTINCTION, in both directions and in the
//      chip's own visible text (not only its tooltip): printed says
//      printed, inferred says inferred, and a `how` the UI does not
//      recognise abstains instead of guessing either way. A test that only
//      fails when somebody deletes a fixed sentence is worse than no test.
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

// The provenance table and its lookup, lifted whole: updateSelBar calls
// elevProvenance, and the point of this suite is what that table decides.
const PROV_SRC = (function () {
  const a = SRC.indexOf("const ELEV_PROV = {");
  if (a < 0) throw new Error("ELEV_PROV not found in app.js");
  const f = SRC.indexOf("\nfunction elevProvenance(how) {", a);
  if (f < 0) throw new Error("elevProvenance not found in app.js");
  return SRC.slice(a, f) + fnSrc("elevProvenance")
       + "\n" + fnSrc("elevProvenanceDetail");
})();
const elevProvenance = new Function(PROV_SRC + "\nreturn elevProvenance;")();

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
  new Function(...names,
    PROV_SRC + "\n" + fnSrc("updateSelBar") + "\nreturn updateSelBar;")
    (...names.map(n => scope[n]))(ch);
  return els.selInfo;
}
// the shape ensureElev actually stores: never a bare number
const ELEV = (z, how, src, dist) =>
  new Map([[192, { z, how, src: src || "", dist: dist === undefined ? null : dist }]]);

// ---------------------------------------------------------------------------
console.log("1. the elevation is a chip, not the tail of the shrinkable string");
// ---------------------------------------------------------------------------
{
  const info = renderBar({ elevMap: ELEV(545, "gap-ocr") });
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
  ["a line the sheet never labelled",
   new Map([[999, { z: 12, how: "radius" }]])],
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
  const info = renderBar({ elevMap: ELEV(null, "radius") });
  eq(byClass(info, "sel-el").length, 0, "a null elevation renders no chip");
}
{
  // 0 is a real elevation. It is falsy; the guard must be a null/undefined
  // test, not truthiness (CLAUDE.md §5: "0.0 is not None").
  const info = renderBar({ elevMap: ELEV(0, "radius") });
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
  const info = renderBar({ elevMap: ELEV(545, "gap-ocr") });
  const txt = byClass(info, "sel-txt")[0];
  eq(txt.title, txt.textContent,
    "whatever DOES clip (a long family label, the point count) is on the title");
}

// ---------------------------------------------------------------------------
console.log("5. the chip says where the number came from - printed vs not");
// ---------------------------------------------------------------------------
// The five `how` values /earthwork/suggest emits, and what each one means.
// Counts are the live C-04 read (150 rows) recorded in the header.
const PRINTED = ["radius", "inline", "gap-ocr"];
const NOT_PRINTED = ["inherited", "interval-infill"];
for (const how of PRINTED) {
  const p = elevProvenance(how);
  eq(p.kind, "printed", how + " is a label the sheet actually prints");
  eq(p.tag, "", how + ": nothing is added to the number - it IS the sheet's");
  const chip = byClass(renderBar({ elevMap: ELEV(545, how) }), "sel-el")[0];
  eq(chip && chip.textContent, "EL 545", how + ": the chip reads the number");
  check(!/inferred|unknown/.test(chip.className),
    how + ": and carries no inferred/unknown class");
}
for (const how of NOT_PRINTED) {
  const p = elevProvenance(how);
  eq(p.kind, "inferred", how + " is NOT printed anywhere on the sheet");
  const chip = byClass(renderBar({ elevMap: ELEV(580, how) }), "sel-el")[0];
  check(chip && /inferred/.test(chip.textContent),
    how + ": the word is in the CHIP TEXT, where the number is - not only "
    + "in a tooltip nobody opens");
  eq(chip && chip.textContent, "EL 580 · inferred", how + ": exact chip text");
  check(/\binferred\b/.test(chip.className),
    how + ": ...and a class, so the tell survives greyscale (dashed border)");
  check(/NOT printed/.test(chip.title),
    how + ": the tooltip states it plainly too");
  check(!/read off (the )?(sheet|a label)/i.test(chip.title),
    how + ": and it must NOT claim the sheet printed it - THE FIXED DEFECT");
}
{
  // the two mechanisms are genuinely different and the tooltip must not
  // blur them: a weld that joined the wrong two objects is a different
  // failure from a miscount, and only one of them has a server sentence
  const a = elevProvenance("inherited").why;
  const b = elevProvenance("interval-infill").why;
  check(a !== b, "the two inferred mechanisms explain themselves differently");
  check(/join/i.test(a), "inherited says the value was carried across a join");
  check(/counted between/i.test(b), "interval-infill says it was counted");
  // the server's own sentence names the two labelled contours; it rides
  // through so the check can be made without opening the earthwork panel
  const chip = byClass(renderBar({
    elevMap: ELEV(580, "interval-infill",
      "counted between labelled 579 (line 140) and 583 (line 282)"),
  }), "sel-el")[0];
  check(/line 140/.test(chip.title) && /line 282/.test(chip.title),
    "the server's src sentence rides along in the tooltip");
}
{
  // "printed" is a claim about the NUMBER, never about whose number it is.
  // Measured on C-04 chain 168: the nearest printed value 2.7 pt away is
  // "551.2 BW" - a bottom-of-wall spot grade the sheet really does print,
  // matched to a contour by proximity alone. So a radius hit carries its
  // distance and says the ownership is the reader's assumption.
  // GLOSSARY: BW = bottom of wall; a spot height, not a contour label.
  const chip = byClass(renderBar({ elevMap: ELEV(551.2, "radius", "", 2.7) }),
                       "sel-el")[0];
  check(/2\.7 pt/.test(chip.title),
    "a radius match reports how far away the printed number actually was");
  check(/takes it to be|assum/i.test(chip.title),
    "...and calls the ownership an assumption, not a reading");
  const far = byClass(renderBar({ elevMap: ELEV(551.2, "radius", "", null) }),
                      "sel-el")[0];
  check(!/pt from this line/.test(far.title),
    "with no distance recorded it invents none");
}
{
  // ABSTAIN. A `how` this UI has not been taught must not be guessed either
  // way - not "printed" (the old lie) and not "inferred" (a new one).
  for (const [name, map] of [
    ["an unrecognised how", ELEV(545, "some-new-reader")],
    ["no how at all", ELEV(545, undefined)],
    ["a bare number, the pre-fix shape", new Map([[192, 545]])],
  ]) {
    const chip = byClass(renderBar({ elevMap: map }), "sel-el")[0];
    check(!!chip, name + ": the number is still shown");
    eq(chip.textContent, "EL 545 · source unknown",
      name + ": ...and the chip says it does not know where it came from");
    check(!/read off/i.test(chip.title) && !/NOT printed/.test(chip.title),
      name + ": the tooltip claims neither printed nor inferred");
  }
  eq(elevProvenance("some-new-reader").kind, "unknown",
    "an unknown reader tag resolves to the abstain row");
}
{
  // the honest vocabulary is the one the app already uses one screen away:
  // the earthwork panel's per-row badge. One word for one distinction.
  check(/ew-inf-tag/.test(SRC) && /"inferred"/.test(SRC),
    "the earthwork row badge still exists - the chip reuses its word");
  check(/\.sel-el\.inferred \{[^}]*border-style:\s*dashed/.test(CSS),
    "the inferred chip is dashed, like the earthwork panel's inferred input");
  check(/\.sel-el\.unknown \{[^}]*border-style:\s*dashed/.test(CSS),
    "and so is the abstain chip");
}

// ---------------------------------------------------------------------------
console.log("6. ensureElev refuses to write into another page");
// ---------------------------------------------------------------------------
function runEnsure(mid) {
  const state = { elevMap: undefined, gen: 1, job: "J", page: 3, selected: null };
  const body = { suggestions: [
    { chain_id: 192, z: 545, how: "gap-ocr" },
    { chain_id: 95, z: 580, how: "interval-infill", inferred: true,
      src: "counted between labelled 579 and 583" },
  ] };
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
  const got = st.elevMap instanceof Map ? st.elevMap.get(192) : null;
  check(got && got.z === 545, "the happy path still builds the map");
  check(got && got.how === "gap-ocr",
    "and it keeps `how` alongside the number - an elevation with no "
    + "provenance is what let the chip claim every one of them was printed");
  const inf = st.elevMap.get(95);
  check(inf && inf.how === "interval-infill" && /579/.test(inf.src),
    "...and the server's src sentence for an infilled row");
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
