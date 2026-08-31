// Operator line colours: the resolution order, the reserved-colour check,
// and the two invariants this feature is only safe because of.
//
// The owner asked for this (2026-08-31): "lets also add the ability to change
// lines colors, whether if its by family/style or when you select a line ...
// it should be a recorded decision but it shouldnt be undoable and it should
// override or add to a family color swatch". Three of the four suites below
// exist because of one clause each of that sentence.
//
// WHY EACH TEST IS HERE
//
//   1. THE styleFp INVARIANT. Colour in this app is EVIDENCE, not decoration.
//      styleFp() is the cross-sheet family identity key and it contains
//      rawColor(st.color); it keys the set-level include/exclude decisions
//      (docKey + "::setinc::" + styleFp) that hold across every sheet of a
//      48-sheet set, and chain.py grouped these chains by colour in the
//      first place. So a recolour that WROTE st.color would silently void
//      the operator's decisions on every other sheet of the set and destroy
//      a measurement, with no symptom on the sheet in front of him. This
//      suite fails if a future edit ever makes the override layer write
//      through to the engine's value.
//
//   2. NOT UNDOABLE. Colour belongs with the app's other DECISIONS - a
//      family's name, its price, its trade, its include tick - none of which
//      are on the undo stack. If a colour change sat on that stack it would
//      swallow an undo the operator meant for a line edit, and Ctrl+Z has to
//      stay about geometry. The check is deliberately a SOURCE scan rather
//      than a behavioural one: the failure mode is a later reader
//      "helpfully" adding the captureUndo call that looks missing, and only
//      the source can catch that.
//
//   3. THE RESOLUTION ORDER, per-chain > per-family > convention > engine,
//      and the reserved-colour proximity check. Both are pure and both are
//      the kind of rule that is quietly reordered by a refactor.
//
// webui/app.js is not a module and touches the DOM at load, so this evals
// ONLY the marked pure blocks - COLOR-RULES for the colour rules, and
// SET-DECISIONS for styleFp, which is the thing test 1 is about.
//
// Dependency-free, like the other suites:  node tests/test_line_colors.js

"use strict";
const fs = require("fs");
const path = require("path");

const SRC = fs.readFileSync(
  path.join(__dirname, "..", "webui", "app.js"), "utf8");

function block(name, exportsExpr) {
  const a = SRC.indexOf("// " + name + "-BEGIN");
  const b = SRC.indexOf("// " + name + "-END");
  if (a < 0 || b < 0 || b <= a) {
    console.error("FAIL: " + name + " markers not found in webui/app.js");
    process.exit(1);
  }
  return new Function(SRC.slice(a, b) + "\n  return " + exportsExpr + ";")();
}

const C = block("COLOR-RULES", `{ RESERVED_COLORS, COLOR_PALETTE, COLOR_NEAR,
  colorNorm, colorRgb, colorDist, colorNearReserved, colorResolve,
  colorSrcLabel }`);
const S = block("SET-DECISIONS", "{ weightClass, rawColor, styleFp }");

let failures = 0;
function check(cond, msg) {
  if (!cond) { failures++; console.error("FAIL:", msg); }
  else console.log("ok:", msg);
}
function eq(got, want, msg) {
  check(got === want, msg + `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);
}

// ======================= 1. colorNorm, the front door =====================
eq(C.colorNorm("#E03131"), "#e03131", "colorNorm lower-cases a 6-digit hex");
eq(C.colorNorm("e03131"), "#e03131", "colorNorm accepts a bare hex");
eq(C.colorNorm(" #ffe066 "), "#ffe066", "colorNorm trims");
eq(C.colorNorm("#f00"), "#ff0000", "colorNorm expands the 3-digit short form");
eq(C.colorNorm("red"), null, "colorNorm refuses a colour NAME");
eq(C.colorNorm("#ff00cc; drop"), null, "colorNorm refuses trailing junk");
eq(C.colorNorm(""), null, "colorNorm refuses empty");
eq(C.colorNorm(null), null, "colorNorm refuses null");
eq(C.colorNorm(0x112233), null, "colorNorm refuses a number");

// ======================= 2. THE RESOLUTION ORDER ==========================
// per-chain > per-family > convention > engine. Every rank is exercised
// present AND absent, because the bug this pins is a rank silently skipped.
const R = C.colorResolve;
{
  const all = { line: "#111111", family: "#222222", convention: "#333333",
                engine: "#444444" };
  eq(R(all).css, "#111111", "per-LINE beats everything");
  eq(R(all).src, "line", "...and says so");

  const noLine = { ...all, line: null };
  eq(R(noLine).css, "#222222", "per-FAMILY beats the convention and the engine");
  eq(R(noLine).src, "family", "...and says so");

  const noFam = { ...noLine, family: null };
  eq(R(noFam).css, "#333333", "the CONVENTION beats the engine");
  eq(R(noFam).src, "convention", "...and says so");

  const engineOnly = { ...noFam, convention: null };
  eq(R(engineOnly).css, "#444444", "the ENGINE is what you get when nobody decided");
  eq(R(engineOnly).src, "engine", "...and says so");

  eq(R({}).css, null, "nothing at all resolves to nothing, not to a guess");
  eq(R({}).src, "engine", "...still attributed to the engine rank");
}
// A rank holding a value that is NOT a colour must be SKIPPED, not honoured
// and not fatal: a hand-edited convention CSV is a real source of "reddish".
eq(R({ line: "reddish", family: "#222222", engine: "#444444" }).css, "#222222",
   "an unparseable per-line value falls through to the family");
eq(R({ line: "", family: "", convention: "#333333", engine: "#444444" }).css,
   "#333333", "empty strings at two ranks fall through to the convention");
// ...and the ranks normalise on the way out, so a caller never has to
eq(R({ family: "#ABC" }).css, "#aabbcc", "a resolved colour comes back normalised");
eq(C.colorSrcLabel("engine"), "",
   "the engine rank is not a DECISION and has no operator-facing name");
check(C.colorSrcLabel("convention").length > 0,
      "every decision rank does have one");

// ======================= 3. RESERVED-COLOUR PROXIMITY =====================
// The canvas already speaks in colour. A family painted near the selection
// magenta makes every line of it look selected; near the measure blue it
// looks like a tool is running on it; near the earthwork map's cut/fill tints
// it reads as excavation or embankment. The check REPORTS, it never refuses -
// it is the operator's sheet.
check(C.RESERVED_COLORS.length === 4,
      "four reserved colours, the ones that paint over ordinary linework");
for (const r of C.RESERVED_COLORS) {
  check(C.colorNorm(r.hex) === r.hex, `reserved ${r.hex} is a normalised hex`);
  check(!!r.name && !!r.why, `reserved ${r.hex} says what it is and why it clashes`);
  const hit = C.colorNearReserved(r.hex);
  check(hit && hit.hex === r.hex && hit.dist === 0,
        `a pick OF ${r.hex} itself is flagged, distance 0`);
}
// the case the owner will actually hit
{
  const hit = C.colorNearReserved("#ff33cc");
  check(hit && hit.hex === "#ff00cc",
        "a near-miss on the selection magenta is flagged as the selection highlight");
  check(!!hit.why, "...with the reason, so the warning is actionable");
}
eq(C.colorNearReserved("#2f9e44"), null,
   "a plain green is not flagged against anything");
// It reports; it does not refuse. Nothing here can return a "rejected" verdict
// - the only two answers are a hit object and null.
{
  const hit = C.colorNearReserved("#ff00cc");
  check(hit && typeof hit === "object" && !("refused" in hit) && !("ok" in hit),
        "the check has no refusal channel at all — by construction it can only warn");
}
// injectable, so the RULE is pinned without pinning this file's palette
{
  const fake = [{ hex: "#000000", name: "x", why: "y" }];
  check(C.colorNearReserved("#010101", fake, 50) !== null,
        "a custom reserved list and threshold are honoured");
  eq(C.colorNearReserved("#010101", fake, 1), null,
     "...and a tighter threshold stops flagging it");
}
// distance behaves like a distance
eq(C.colorDist("#123456", "#123456"), 0, "a colour is zero from itself");
check(Math.abs(C.colorDist("#123456", "#654321")
             - C.colorDist("#654321", "#123456")) < 1e-9,
      "colorDist is symmetric");
eq(C.colorDist("#123456", "nonsense"), Infinity,
   "an unparseable colour is infinitely far, so it can never be 'near' anything");

// ======================= 4. THE CURATED PALETTE ===========================
// Two properties, both measured rather than asserted by eye: nothing in the
// palette trips the app's own reserved warning, and no two swatches read as
// the same colour. The numbers in the app.js comment are pinned here.
{
  let minRes = Infinity, minPair = Infinity, worst = "";
  for (const p of C.COLOR_PALETTE) {
    check(C.colorNorm(p.hex) === p.hex, `palette ${p.hex} is a normalised hex`);
    check(!!p.name && !!p.hint, `palette ${p.hex} names itself and suggests a use`);
    for (const r of C.RESERVED_COLORS)
      minRes = Math.min(minRes, C.colorDist(p.hex, r.hex));
  }
  for (let i = 0; i < C.COLOR_PALETTE.length; i++)
    for (let j = i + 1; j < C.COLOR_PALETTE.length; j++) {
      const d = C.colorDist(C.COLOR_PALETTE[i].hex, C.COLOR_PALETTE[j].hex);
      if (d < minPair) { minPair = d; worst = C.COLOR_PALETTE[i].hex + "/" + C.COLOR_PALETTE[j].hex; }
    }
  check(minRes > C.COLOR_NEAR,
        `no palette entry trips the reserved warning (min clearance `
        + `${minRes.toFixed(0)} vs threshold ${C.COLOR_NEAR})`);
  check(minRes >= 130, `...and the measured clearance is still 134 (${minRes.toFixed(0)})`);
  check(minPair >= 60,
        `no two palette swatches read as one colour (min ${minPair.toFixed(0)}, ${worst})`);
  // the two the owner named must be reachable in one click
  check(C.COLOR_PALETTE.some(p => /red/i.test(p.name)),
        'the owner\'s "red for like a fiber line" is on the palette');
  check(C.COLOR_PALETTE.some(p => /light yellow/i.test(p.name)),
        'the owner\'s "light yellow for existing contour" is on the palette');
}

// ============ 5. THE styleFp INVARIANT — recolouring is not a rename ======
// See the header. This is the trap the whole design is shaped around.
{
  const st = { style_id: 7, class: "dash1", width: 0.72,
               color: [0, 0, 0], signature: "d18.0 g9.0", layer: "C-COMM" };
  const before = S.styleFp(st);
  const rawBefore = S.rawColor(st.color);

  // the override layer, as the app holds it: a map beside the style row,
  // NEVER a write into it
  const famColor = new Map();
  famColor.set(st.style_id, "#e03131");         // "red for like a fiber line"
  const lineColor = new Map();
  lineColor.set(41, "#ffe066");

  // what the renderer resolves...
  eq(C.colorResolve({ family: famColor.get(st.style_id),
                      engine: "rgb(0,0,0)" }).css, "#e03131",
     "the family now RESOLVES to the colour the operator picked");
  // ...and what the identity key still says
  eq(S.styleFp(st), before,
     "recolouring a family does NOT change its styleFp — set-level "
     + "include/exclude decisions on the other 47 sheets survive");
  eq(S.rawColor(st.color), rawBefore,
     "the engine's measured colour is byte-identical after the recolour");
  eq(JSON.stringify(st.color), "[0,0,0]",
     "st.color itself was never written to");
  check(before.includes(rawBefore),
        "sanity: the fingerprint really does contain the colour, so the "
        + "test above is testing something");

  // and the same for one line
  const ch = { chain_id: 41, style_id: 7, color: [0, 0, 0] };
  eq(C.colorResolve({ line: lineColor.get(ch.chain_id),
                      family: famColor.get(st.style_id),
                      engine: "rgb(0,0,0)" }).css, "#ffe066",
     "a per-line colour overrides its family for that one line");
  eq(JSON.stringify(ch.color), "[0,0,0]",
     "...and ch.color was never written to either");
  eq(S.styleFp(st), before, "...and the family's fingerprint is still unmoved");
}

// ============ 6. NOT UNDOABLE — the source scan ===========================
// A behavioural test cannot catch the failure this guards, because the
// failure is a future reader ADDING the call that looks missing. So read the
// source.
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
const COLOR_WRITERS = ["setFamColor", "famColorReset", "setLineColor",
                       "lineColorReset", "setColorConvention",
                       "clearColorConvention"];
for (const nm of COLOR_WRITERS) {
  const body = fnBody(nm);
  check(body !== null, `${nm}() exists in webui/app.js`);
  if (body === null) continue;
  check(!/captureUndo/.test(body),
        `${nm}() does NOT call captureUndo — colour is a decision, and `
        + "Ctrl+Z must stay about geometry");
  check(!/undoPush|undoCapture|undoDoc/.test(body),
        `${nm}() does not reach the undo stack by any other name`);
}
// ...and the colour maps are not smuggled in through the style-region
// snapshot either. UNDO_SMAPS is the fixed-order list of per-style Maps that
// travel with an undo entry; famColor / lineColor must not be on it.
{
  const m = /const UNDO_SMAPS = \[([^\]]*)\]/.exec(SRC);
  check(!!m, "UNDO_SMAPS is still declared where this test can read it");
  if (m) {
    check(!/famColor|lineColor/.test(m[1]),
          "UNDO_SMAPS does not carry the colour maps — an undo cannot "
          + "restore or destroy a colour decision");
    check(/labels/.test(m[1]) && /include/.test(m[1]),
          "sanity: UNDO_SMAPS still carries the maps it is supposed to");
  }
}
// The popover's two entry points must not capture undo either - they are the
// only other place a colour is written from.
for (const nm of ["colorPopForStyle", "colorPopForChain"]) {
  const body = fnBody(nm);
  check(body !== null, `${nm}() exists`);
  if (body) check(!/captureUndo/.test(body),
                  `${nm}() does not capture undo`);
}

// ============ 7. the writers keep the ENGINE value =======================
// A source scan again, and for the same reason: the tempting "simplification"
// is to write the chosen colour into st.color so every existing reader picks
// it up for free. That is exactly the change that voids the set-level
// decisions. Nothing in the colour writers may assign to .color.
for (const nm of COLOR_WRITERS) {
  const body = fnBody(nm);
  if (!body) continue;
  check(!/\.color\s*=/.test(body),
        `${nm}() never assigns to .color — the engine's measurement is `
        + "left exactly as measured");
}

console.log(failures ? `\n${failures} FAILURE(S)` : "\nall line-colour checks passed");
process.exit(failures ? 1 : 0);
