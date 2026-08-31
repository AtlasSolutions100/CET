// Rich hover demos on the toolkit rail (TIPVID, end of webui/app.js).
//
// Three kinds of check, matching the feature's three claims:
//
//   1. ASSETS - webui/tooldemos/manifest.json points every entry at a real
//      webm under the byte budget (250 KB per clip, 2.5 MB total: the clips
//      are committed, so the budget is a hard line), and every referenced
//      button id is a real toolkit button in index.html.
//
//   2. LOGIC - the pure block between the TIPVID-PURE markers (manifest
//      lookup + popover placement math). app.js is not a module and touches
//      the DOM at load, so only the marked block is evaluated - same
//      technique as test_tools_menu.js.
//
//   3. CONTRACT - the runtime wiring keeps its promises as written text:
//      600ms hover-intent delay, pointer-events:none popover (a hint, never
//      a click target), a prefers-reduced-motion branch, video bytes only
//      on open (preload none, src set at open), the armed-tool gate, and
//      NATIVE TITLES UNTOUCHED - all 13 toolkit buttons still carry their
//      title attribute, which stays the accessible description and the
//      whole behaviour for buttons without a clip.
//
// Dependency-free:  node tests/test_tooldemo_tips.js

"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const appSrc = fs.readFileSync(path.join(ROOT, "webui", "app.js"), "utf8");
const cssSrc = fs.readFileSync(path.join(ROOT, "webui", "style.css"), "utf8");
const htmlSrc = fs.readFileSync(path.join(ROOT, "webui", "index.html"), "utf8");
const DEMOS = path.join(ROOT, "webui", "tooldemos");
const manifest = JSON.parse(
  fs.readFileSync(path.join(DEMOS, "manifest.json"), "utf8"));

let failures = 0;
function check(cond, msg) {
  if (!cond) { failures++; console.error("FAIL:", msg); }
  else console.log("ok:", msg);
}

// the full rail, in DOM order - the 13 buttons the feature must not touch
const RAIL = ["measureBtn", "splitBtn", "extendBtn", "cutSpanBtn", "drawBtn",
              "reclassBtn", "mergeBtn", "sepBtn", "removeBtn", "wzBtn",
              "wzClearBtn", "faithfulBtn", "kbdBtn"];
// the ten demo-able tools that must carry a clip
const WANT_CLIPS = ["measureBtn", "splitBtn", "extendBtn", "cutSpanBtn",
                    "drawBtn", "reclassBtn", "mergeBtn", "sepBtn",
                    "removeBtn", "wzBtn"];

// ---- 1. assets: manifest rows -> real files, under budget -------------------
const PER_CLIP = 250 * 1024;
const TOTAL = 2.5 * 1024 * 1024;
let sum = 0;
check(WANT_CLIPS.every((id) => id in manifest),
  "all ten demo-able tools have a manifest entry");
for (const [id, ent] of Object.entries(manifest)) {
  check(typeof ent.file === "string" && /\.webm$/.test(ent.file),
    `${id}: entry names a .webm file`);
  const p = path.join(DEMOS, ent.file);
  const exists = fs.existsSync(p);
  check(exists, `${id}: ${ent.file} exists in webui/tooldemos`);
  if (exists) {
    const bytes = fs.statSync(p).size;
    sum += bytes;
    check(bytes > 0 && bytes <= PER_CLIP,
      `${id}: ${ent.file} is ${bytes} bytes (<= ${PER_CLIP})`);
  }
  check(typeof ent.caption === "string" && ent.caption.length > 0,
    `${id}: caption present`);
  check("key" in ent, `${id}: key present (null allowed)`);
  check(htmlSrc.includes(`id="${id}"`),
    `${id}: referenced button id exists in index.html`);
  check(RAIL.includes(id), `${id}: is a toolkit rail button`);
}
check(sum <= TOTAL, `all clips together are ${sum} bytes (<= ${TOTAL})`);
for (const id of ["faithfulBtn", "kbdBtn", "wzClearBtn"])
  check(!(id in manifest), `${id}: no clip - native title behaviour only`);

// ---- 2. the pure block -------------------------------------------------------
const a = appSrc.indexOf("// TIPVID-PURE-BEGIN");
const b = appSrc.indexOf("// TIPVID-PURE-END");
check(a >= 0 && b > a, "TIPVID-PURE markers present in webui/app.js");
const T = new Function(appSrc.slice(a, b) +
  " return { TIPVID_HOVER_DELAY_MS, tipvidEntry, tipvidPos };")();

check(T.TIPVID_HOVER_DELAY_MS === 600,
  "hover-intent delay is 600ms (the Photoshop pattern)");

// lookup: only own string-file rows count; anything else is "no clip"
check(T.tipvidEntry(manifest, "measureBtn") !== null,
  "tipvidEntry finds a real row");
check(T.tipvidEntry(manifest, "faithfulBtn") === null,
  "tipvidEntry: no row -> null");
check(T.tipvidEntry(null, "measureBtn") === null,
  "tipvidEntry: no manifest (fetch failed) -> null");
check(T.tipvidEntry(manifest, "toString") === null,
  "tipvidEntry: prototype names are not rows");
check(T.tipvidEntry({ x: { caption: "no file" } }, "x") === null,
  "tipvidEntry: a row without a file string is not a clip");

// placement: right of the rail, centred, clamped, flipping when cramped
{
  const btn = { left: 12, right: 54, top: 300, height: 30 };
  const pop = { w: 316, h: 380 };
  const p = T.tipvidPos(btn, pop, 1600, 900, 10);
  check(p.x === 64, "popover opens right of the button (+gap)");
  check(p.y === 315 - 190, "popover is vertically centred on the button");
}
{
  // button near the bottom edge: y clamps inside the viewport
  const p = T.tipvidPos({ left: 12, right: 54, top: 860, height: 30 },
                        { w: 316, h: 380 }, 1600, 900, 10);
  check(p.y === 900 - 380 - 4, "bottom clamp keeps the popover on screen");
}
{
  // button near the top edge: y clamps to the top margin
  const p = T.tipvidPos({ left: 12, right: 54, top: 4, height: 30 },
                        { w: 316, h: 380 }, 1600, 900, 10);
  check(p.y === 4, "top clamp keeps the popover on screen");
}
{
  // viewport too narrow on the right: flip to the left of the rail
  const p = T.tipvidPos({ left: 500, right: 542, top: 300, height: 30 },
                        { w: 316, h: 380 }, 600, 900, 10);
  check(p.x === 500 - 10 - 316, "flips left when the right side cannot fit");
}
{
  // nowhere fits: never goes negative
  const p = T.tipvidPos({ left: 12, right: 54, top: 300, height: 30 },
                        { w: 700, h: 380 }, 600, 900, 10);
  check(p.x === 4, "cramped fallback clamps to the viewport edge");
}

// ---- 3. the runtime contract, as written text --------------------------------
const tipBlock = appSrc.slice(b);
check(cssSrc.includes("#tipvid") &&
  /#tipvid\s*{[^}]*pointer-events:\s*none/.test(cssSrc),
  "popover is pointer-events:none - a hint, never a click target");
check(tipBlock.includes("prefers-reduced-motion"),
  "reduced-motion branch present (paused first frame, no loop)");
check(/preload\s*=\s*"none"/.test(tipBlock),
  "video preload=none - zero clip bytes until a popover opens");
check(tipBlock.includes('vid.muted = true') && tipBlock.includes('vid.loop = true'),
  "clip is muted and loops");
check(tipBlock.includes("if (state.tool) return;"),
  "never opens while a canvas tool is armed mid-gesture");
check(tipBlock.includes('addEventListener("pointerleave", closeTip)')
  && tipBlock.includes('addEventListener("pointerdown", closeTip)'),
  "instant close on leave and on click");
check(tipBlock.includes('e.key === "Escape"') && tipBlock.includes("closeTip"),
  "Esc closes the popover");
check(tipBlock.includes('btn.getAttribute("title")'),
  "popover text is the button's own title, read verbatim at open");

// native titles untouched: every rail button still carries a real title
const btnRe = (id) =>
  new RegExp(`<button[^>]*id="${id}"[^>]*title="([^"]{10,})"[^>]*>`);
for (const id of RAIL) {
  const m = htmlSrc.match(btnRe(id));
  check(!!m, `#${id} keeps its native title attribute`);
}
check(RAIL.length === 13, "the rail is the full 13-button toolkit");
// and the toolkit block itself references no tooldemos markup - the popover
// is built by app.js only, so a JS failure leaves plain buttons untouched
const tkStart = htmlSrc.indexOf('<div class="toolkit">');
const tkEnd = htmlSrc.indexOf("</div>", htmlSrc.indexOf('id="kbdBtn"'));
check(tkStart >= 0 && !htmlSrc.slice(tkStart, tkEnd).includes("tooldemo"),
  "index.html toolkit markup untouched (no popover markup baked in)");

if (failures) { console.error(`\n${failures} FAILURE(S)`); process.exit(1); }
console.log("\nall tooldemo tip checks passed");
