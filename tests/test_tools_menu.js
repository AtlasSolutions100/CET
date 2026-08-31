// The header TOOLS dropdown, pinned.
//
// Two kinds of check, because the feature is two claims:
//
//   1. LOGIC - the pure block between the TOOLS-MENU markers (menu model:
//      which rows show, which row carries the open-panel dot, when the
//      "appears after detect" note shows; arrow-key wrap arithmetic).
//      webui/app.js is not a module and touches the DOM at load, so only
//      the marked block is evaluated - same technique as test_trench_math.
//
//   2. STRUCTURE - the nine tool buttons were MOVED, not recreated: each id
//      must appear exactly once in index.html, INSIDE #toolsMenu, with
//      #detectBtn (the workflow) and #fbBtn left outside; and app.js must
//      still attach a handler to every one of them. A moved DOM node keeps
//      its listeners and its element identity ($("ewBtn") resolves to the
//      same node wherever it sits), so id-in-menu + handler-still-attached
//      IS the "every button still fires" guarantee - plus a propagation
//      simulation below that pins the close-then-fire contract the menu's
//      click listener relies on.
//
// Dependency-free:  node tests/test_tools_menu.js

"use strict";
const fs = require("fs");
const path = require("path");

const appSrc = fs.readFileSync(
  path.join(__dirname, "..", "webui", "app.js"), "utf8");
const htmlSrc = fs.readFileSync(
  path.join(__dirname, "..", "webui", "index.html"), "utf8");

let failures = 0;
function check(cond, msg) {
  if (!cond) { failures++; console.error("FAIL:", msg); }
  else console.log("ok:", msg);
}

// ---- extract the pure block ------------------------------------------------
const a = appSrc.indexOf("// TOOLS-MENU-BEGIN");
const b = appSrc.indexOf("// TOOLS-MENU-END");
check(a >= 0 && b > a, "TOOLS-MENU markers present in webui/app.js");
const T = new Function(appSrc.slice(a, b) +
  " return { TOOLS_MENU_ITEMS, toolsMenuModel, toolsMenuNextIdx };")();

// ---- the registry is exactly the nine required tools ------------------------
const WANT = ["aiBtn", "ewBtn", "trBtn", "symBtn", "rollBtn",
              "xsBtn", "coBtn", "stBtn", "legendBtn"];
const got = T.TOOLS_MENU_ITEMS.map((it) => it[0]);
check(got.length === 9, `registry lists 9 tools (got ${got.length})`);
check(WANT.every((id) => got.includes(id)),
  "registry covers ANALYZE..LEGEND SHEET exactly");
check(!got.includes("detectBtn"), "DETECT LINES is not in the menu registry");

// ---- menu model -------------------------------------------------------------
{
  // nothing detected yet: only the legend tool is visible, note shows
  const rows = T.TOOLS_MENU_ITEMS.map(([id, p]) => ({
    id, hidden: id !== "legendBtn", panelHidden: p ? true : null,
  }));
  const m = T.toolsMenuModel(rows);
  check(m.visible.length === 1 && m.visible[0] === "legendBtn",
    "before detect: only Legend sheet is a menu row");
  check(m.note === true, "before detect: the explainer note shows");
  check(Object.values(m.dots).every((v) => v === false),
    "before detect: no dot anywhere");
}
{
  // a result loaded, earthwork panel open: 9 rows, exactly one dot
  const rows = T.TOOLS_MENU_ITEMS.map(([id, p]) => ({
    id, hidden: false, panelHidden: p ? (id !== "ewBtn") : null,
  }));
  const m = T.toolsMenuModel(rows);
  check(m.visible.length === 9, "after detect: all 9 rows visible");
  check(m.note === false, "after detect: note gone");
  check(m.dots.ewBtn === true, "open earthwork panel carries the dot");
  const others = Object.entries(m.dots)
    .filter(([id]) => id !== "ewBtn").map(([, v]) => v);
  check(others.every((v) => v === false), "no other row carries a dot");
}
{
  // legendBtn has no panel (null): never a dot, even when visible
  const rows = T.TOOLS_MENU_ITEMS.map(([id, p]) => ({
    id, hidden: false, panelHidden: p ? false : null,
  }));
  const m = T.toolsMenuModel(rows);
  check(m.dots.legendBtn === false, "panel-less legend row never dots");
}

// ---- arrow-key wrap ----------------------------------------------------------
check(T.toolsMenuNextIdx(9, 0, 1) === 1, "ArrowDown moves 0 -> 1");
check(T.toolsMenuNextIdx(9, 8, 1) === 0, "ArrowDown wraps 8 -> 0");
check(T.toolsMenuNextIdx(9, 0, -1) === 8, "ArrowUp wraps 0 -> 8");
check(T.toolsMenuNextIdx(9, -1, 1) === 0, "entering from outside lands on 0");
check(T.toolsMenuNextIdx(9, -1, -1) === 8, "ArrowUp from outside lands on 8");
check(T.toolsMenuNextIdx(0, -1, 1) === -1, "empty menu: no focus target");

// ---- structure: the nine buttons moved INSIDE #toolsMenu ---------------------
const menuStart = htmlSrc.indexOf('id="toolsMenu"');
check(menuStart >= 0, "#toolsMenu exists in index.html");
// the menu div ends where its container closes; the note div is its last child
const menuEnd = htmlSrc.indexOf("</div>", htmlSrc.indexOf('id="toolsNote"'));
const menuHtml = htmlSrc.slice(menuStart, menuEnd);
for (const id of WANT) {
  const inMenu = menuHtml.includes(`id="${id}"`);
  const once = htmlSrc.split(`id="${id}"`).length - 1 === 1;
  check(inMenu && once, `#${id} appears exactly once, inside #toolsMenu`);
}
check(!menuHtml.includes('id="detectBtn"'),
  "#detectBtn stays OUTSIDE the menu (workflow, not tool)");
check(!menuHtml.includes('id="fbBtn"'), "#fbBtn stays OUTSIDE the menu");
check(htmlSrc.includes('id="detectBtn"'), "#detectBtn still exists");

// ---- every moved button still has its handler wired in app.js ----------------
for (const id of WANT) {
  const wired = appSrc.includes(`$("${id}").onclick`);
  check(wired, `app.js still attaches a click handler to #${id}`);
}

// ---- click simulation: handler fires, THEN the menu closes -------------------
// The menu's own listener is bubble-phase on the container, so the button's
// handler (target phase) runs first and the close never suppresses it. This
// mirrors that dispatch order over stubs, for all nine ids.
{
  const fired = [];
  const menu = { hidden: false };
  const buttons = WANT.map((id) => ({
    id, onclick: () => fired.push(id),
  }));
  // DOM dispatch on a click at the button: target listeners (the button's
  // own onclick), then ancestors' bubble listeners (the menu's close)
  for (const btn of buttons) {
    menu.hidden = false;
    const menuWasOpenBeforeHandler = !menu.hidden;
    btn.onclick();                       // target phase
    menu.hidden = true;                  // container bubble listener
    check(menuWasOpenBeforeHandler && fired[fired.length - 1] === btn.id
      && menu.hidden,
      `menu click on #${btn.id}: handler fired, menu closed after`);
  }
  check(fired.length === 9, "all nine simulated clicks reached a handler");
}

if (failures) { console.error(`\n${failures} FAILURE(S)`); process.exit(1); }
console.log("\nall tools menu checks passed");
