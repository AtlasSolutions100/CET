// FLOORING: rooms by floor type (CET, 2026-09-08).
//
// The pure half is evaluated - totals per type, the takeoff rows, the room
// line - and the panel's non-negotiables are pinned from source:
//   * a room with no floor type is NEVER silently outside the takeoff: it
//     is its own "unassigned" row in the totals and the panel says so
//   * base footage is the ring LESS the door openings on it
//   * one SF row and one LF row per type, only for types that have rooms,
//     with a unit price only when one was typed
//   * the pick sends the VISIBLE styles (the role assignment) and the
//     hand-drawn closures; a failed pick prints the server's own sentence
//   * closures, rooms and types persist under the additive "fl" key and
//     restore before anything renders (calcFlApplied mirrors calcStApplied)
//   * the tool ids are in POINT_TOOLS / POLY_DRAW_TOOLS, the button is in
//     the Tools menu, the overlay is drawn after the structure overlay
//
// Dependency-free:  node tests/test_flooring_ui.js
"use strict";
const fs = require("fs");
const path = require("path");
const SRC = fs.readFileSync(path.join(__dirname, "..", "webui", "app.js"), "utf8");
const HTML = fs.readFileSync(path.join(__dirname, "..", "webui", "index.html"), "utf8");
const CSS = fs.readFileSync(path.join(__dirname, "..", "webui", "style.css"), "utf8");

let fails = 0;
function check(cond, msg) {
  console.log((cond ? "  ok   " : "  FAIL ") + msg);
  if (!cond) fails++;
}
function grab(name) {
  const start = SRC.indexOf("function " + name + "(");
  if (start < 0) return null;
  let depth = 0;
  for (let j = SRC.indexOf("{", start); j < SRC.length; j++) {
    if (SRC[j] === "{") depth++;
    else if (SRC[j] === "}" && --depth === 0) return SRC.slice(start, j + 1);
  }
  return null;
}
function grabConst(name) {
  const m = new RegExp("const " + name + " = ([^;]+);").exec(SRC);
  return m ? m[1] : null;
}

console.log("pure");
const names = ["flWallLf", "flTotals", "flItems", "flRoomLine"];
const bodies = names.map(grab);
check(bodies.every(Boolean), "helpers exist: " + names.join(", "));
const P = new Function(
  "const FL_UNASSIGNED = " + grabConst("FL_UNASSIGNED") + ";\n"
  + "const flFmt = " + grabConst("flFmt") + ";\n"
  + bodies.join("\n") + "\nreturn { " + names.join(", ") + " };")();

const types = [{ name: "Carpet", color: "#4e9af1", sf_price: 3.25, lf_price: 1.8 },
               { name: "Tile", color: "#4fc27a", sf_price: 0, lf_price: 0 }];
const rooms = [
  { name: "OFFICE", area_sf: 100, perim_lf: 40, openings_lf: 3, holes_sf: 0, doors: 1, type: 0 },
  { name: "HALL", area_sf: 200, perim_lf: 60, openings_lf: 9, holes_sf: 4, doors: 3, type: 0 },
  { name: "BATH", area_sf: 50, perim_lf: 30, openings_lf: 3, holes_sf: 0, doors: 1, type: 1 },
  { name: "closet", area_sf: 12, perim_lf: 14, openings_lf: 0, holes_sf: 0, doors: 0, type: null },
];
check(P.flWallLf(rooms[0]) === 37, "base = ring less openings (40 - 3)");
check(P.flWallLf({ perim_lf: null }) === null, "no scale: base is null, not 0");
check(P.flWallLf({ perim_lf: 2, openings_lf: 9 }) === 0, "openings cannot make the base negative");
const tot = P.flTotals(types, rooms);
check(tot.length === 3 && tot[2].i === -1 && tot[2].rooms === 1 && tot[2].sf === 12,
      "an untyped room is its own 'unassigned' row, never dropped");
check(tot[0].sf === 300 && tot[0].lf === 88 && tot[0].rooms === 2, "Carpet: 300 SF, 88 LF, 2 rooms");
check(tot[1].sf === 50 && tot[1].lf === 27, "Tile: 50 SF, 27 LF");
check(P.flTotals(types, []).length === 2, "no rooms: no unassigned row");
const items = P.flItems(types, rooms);
check(items.length === 4, "one SF row and one LF row per type with rooms (4)");
check(items[0].label === "Flooring — Carpet" && items[0].qty === 300 && items[0].unit === "SF" && items[0].unit_price === 3.25,
      "Flooring — Carpet 300 SF @ 3.25");
check(items[1].label === "Base/molding — Carpet" && items[1].qty === 88 && items[1].unit === "LF" && items[1].unit_price === 1.8,
      "Base/molding — Carpet 88 LF @ 1.80");
check(!("unit_price" in items[2]) && !("unit_price" in items[3]), "no price typed = no unit_price on the row");
check(!items.some(it => /unassigned/i.test(it.label)), "the unassigned row never reaches the takeoff");
check(P.flItems([{ name: "Carpet", sf_price: 0, lf_price: 0 }], [{ area_sf: 0, perim_lf: 0, type: 0 }]).length === 0,
      "a type whose rooms measure nothing adds no rows");
const line = P.flRoomLine(rooms[1]);
check(line.startsWith("200 SF · walls 51 LF (3 doors, −9 LF)"), "room line: SF, base, doors and their footage: " + line);
check(line.includes("4 SF inside it not counted"), "room line: holes are said, not hidden");
check(P.flRoomLine({ area_sf: 26.4, perim_lf: 27.1, openings_lf: 1.5, doors: 1, closures: 2 }).includes("2 gaps closed by hand"),
      "room line: hand-closed gaps are said");
check(P.flRoomLine({ area_sf: 80, perim_lf: 36, source: "drawn" }).includes("outline drawn by hand"), "room line: a drawn outline says so");
check(P.flRoomLine({ area_sf: null, area_pt2: 1234 }).startsWith("no scale set"), "room line: no scale = pt only");

console.log("panel, from source");
const pick = grab("flPickAt");
check(pick && /styles: flVisibleStyles\(\), closures: fl\.closures/.test(pick), "the pick sends visible styles and closures");
check(pick && /setStatus\(j\.why, "err"\)/.test(pick), "a failed pick prints the server's own sentence");
check(pick && /if \(fl\.busy\) return;/.test(pick), "no double pick while one is in flight");
const vis = grab("flVisibleStyles");
check(vis && /famShown\(id\)/.test(vis), "visible = famShown, the canvas's own answer");
const close = grab("flCloseClick");
check(close && /fl\.closures\.push\(seg\)/.test(close) && /state\.tool = "fl-pick"/.test(close),
      "close a gap: two clicks make a closure and hand the tool back to Pick");
const fin = grab("flFinishDraw");
check(fin && /source: "drawn"/.test(fin) && /stPolyArea\(pts\)/.test(fin), "draw outline: shoelace area, marked drawn");
const apply = grab("flApplyItems");
check(apply && /filter\(it => !FL_LABEL_RX\.test\(it\.label\)\)/.test(apply), "re-apply replaces only its own rows");
check(apply && /store\.setItem\(priceKey\(it\.label\), String\(it\.unit_price\)\)/.test(apply),
      "a typed $/SF or $/LF is written to the price book, which is what the export prices from");
check(apply && /calcStateDirty\(\)/.test(apply), "...and marks the sidecar dirty");
const saved = grab("flApplySaved");
check(saved && /if \(state\.calcFlApplied \|\| !state\.calcSavedLoaded\) return;/.test(saved), "restore runs once, after the sidecar answered");
check(saved && /sv\.closures/.test(saved) && /sv\.types/.test(saved) && /sv\.rooms/.test(saved), "restore brings back types, rooms and closures");
check(/out\.fl = flSavePayload\(fl\);/.test(SRC) && /else if \(saved\.fl\) out\.fl = saved\.fl;/.test(SRC),
      "calcstate carries fl, and keeps a saved fl when the panel was never opened");
check(/state\.calcStApplied = false;\n  state\.calcFlApplied = false;/.test(SRC), "calcFlApplied resets where calcStApplied does");
check(/stApplySaved\(\);\n  flApplySaved\(\);/.test(SRC), "flApplySaved runs where stApplySaved runs");
check(/"gz-draw", "gz-box", "fl-pick", "fl-draw", "fl-close",/.test(SRC), "the three tools are POINT_TOOLS");
check(/POLY_DRAW_TOOLS = new Set\(\[.*"fl-draw"\]\)/.test(SRC), "fl-draw is a polygon tool (close-snap)");
check(/\["flBtn", "flPanel"\],\n  \["stBtn", "stPanel"\]/.test(SRC), "Flooring sits in the Tools menu before Structure");
check(/drawStructural\(ctx, k\);\n  drawFlooring\(ctx, k\);/.test(SRC), "the flooring overlay is drawn after the structure overlay");
const dr = grab("drawFlooring");
check(dr && /FL_UNASSIGNED/.test(dr) && /ctx\.fill\(\)/.test(dr), "rooms are filled in their type's colour, grey when untyped");
check(dr && /FL_CLOSE_COLOR/.test(dr), "closures are drawn on the sheet");
const rf = grab("renderFl");
check(rf && /fl-unassigned/.test(rf) && /not in the takeoff/.test(rf), "the panel says when rooms have no type");
check(rf && /"Pick rooms"/.test(rf) && /"Close a gap"/.test(rf) && /"Draw outline"/.test(rf), "three mode buttons");
check(rf && /NO SCALE SET/.test(rf), "the panel says when there is no scale");

console.log("walls only");
const Wf = new Function(grab("flWallStyleIds") + "\nreturn flWallStyleIds;")();
const layered = [
  { style_id: 1, layer: "A-wall", class: "solid", width: 0.7, n: 42 },
  { style_id: 2, layer: "A-Flooring", class: "solid", width: 0.8, n: 58 },
  { style_id: 3, layer: "A-Exterior Wall Line", class: "solid", width: 0.4, n: 9 },
  { style_id: 4, layer: "A-Wall Hatch", class: "solid", width: 2.6, n: 47 },
  { style_id: 5, layer: "A-Door", class: "dash1", width: 0.7, n: 15 },
  { style_id: 6, layer: "A-Door-Window", class: "solid", width: 2.2, n: 2 },
  { style_id: 7, layer: "A-Dim", class: "solid", width: 0.4, n: 60 },
  { style_id: 8, layer: "I-Furn", class: "solid", width: 0.7, n: 32 },
];
let wl = Wf(layered);
check(wl.by === "layer name" && wl.ids.join(",") === "1,2,3,4",
      "with CAD layers: wall, flooring, exterior and wall hatch are in; door, door-window, dim, furniture are out");
const unnamed = [
  { style_id: 17, layer: "", class: "solid", width: 3.2, n: 48 },
  { style_id: 0, layer: "", class: "solid", width: 1.5, n: 38 },
  { style_id: 33, layer: "", class: "dash1", width: 0.8, n: 10, suggested_label: "SHEAR WALL (legend)" },
  { style_id: 26, layer: "", class: "solid", width: 0.2, n: 13 },
  { style_id: 31, layer: "", class: "solid", width: 1.9, n: 1 },
  { style_id: 14, layer: "", class: "dash1", width: 3.2, n: 7 },
];
wl = Wf(unnamed);
check(wl.by === "line weight" && wl.ids.join(",") === "17,0,33",
      "without layers: heavy solids with 3+ lines and a WALL legend label; thin solids, singletons and dashes are out");
check(Wf([]).ids.length === 0, "no styles: nothing kept");
const rfw = grab("renderFl");
check(rfw && /"Show walls only"/.test(rfw) && /flShowWallsOnly\(\)/.test(rfw), "the panel has the Show walls only button");
const swo = grab("flShowWallsOnly");
check(swo && /setFamVis\(s\.style_id, keep\.has\(s\.style_id\)\)/.test(swo), "it sets visibility through setFamVis, the checkboxes' own path");
check(swo && /chosen by \$\{by\}/.test(swo), "and says which rule chose");

console.log("html/css");
check(/id="flBtn" hidden/.test(HTML), "index.html: the Tools button, hidden until a sheet is open");
check(/id="flPanel" class="ew-panel" hidden/.test(HTML), "index.html: the panel");
for (const id of ["flHead", "flClose", "flHint", "flTypes", "flBody", "flRows", "flActions", "flResult"])
  check(new RegExp('id="' + id + '"').test(HTML), "index.html: #" + id);
const v = /app\.js\?v=(\d+)/.exec(HTML);
check(v && Number(v[1]) >= 166, "index.html: cache-buster moved (got " + (v && v[1]) + ")");
check(/\.fl-types-tbl \{/.test(CSS) && /\.fl-swatch \{/.test(CSS) && /\.fl-row-top \{/.test(CSS), "style.css: the panel's rules");

console.log(fails ? "\n" + fails + " FAILURE(S)" : "\nall green");
process.exit(fails ? 1 : 0);
