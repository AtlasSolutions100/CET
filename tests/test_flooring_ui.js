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
const names = ["flWallLf", "flCeiling", "flWallSf", "flTotals", "flTransitions", "flItems", "flRoomLine"];
const bodies = names.map(grab);
check(bodies.every(Boolean), "helpers exist: " + names.join(", "));
const P = new Function(
  "const FL_UNASSIGNED = " + grabConst("FL_UNASSIGNED") + ";\n"
  + "const FL_DOOR_HT_FT = " + grabConst("FL_DOOR_HT_FT") + ";\n"
  + "const flFmt = " + grabConst("flFmt") + ";\n"
  + "const flFtIn = (ft) => { const f = Math.floor(ft), i = Math.round((ft - f) * 12 * 8) / 8; return f + \"'-\" + i + '\"'; };\n"
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

console.log("ceiling height -> wall area");
const flx = { default_ceiling_ft: null, result: { scale: { ft_per_paper_inch: 4 } } };
const rm = { name: "BED #2", area_sf: 135.5, perim_lf: 48, openings_lf: 2.67, doors: 1, ceiling_ft: 9.094, ceiling_by: "sheet", type: 0 };
check(P.flCeiling(rm, flx).ft === 9.094 && P.flCeiling(rm, flx).by === "sheet", "a room's own note is the height, marked from the sheet");
check(P.flCeiling({ perim_lf: 40 }, flx) === null, "no note and no default: no height");
check(P.flCeiling({ perim_lf: 40 }, { default_ceiling_ft: 9 }).by === "default", "the panel default fills a room with no note, marked default");
check(P.flCeiling({ perim_lf: 40, ceiling_ft: 10, ceiling_by: "typed" }, { default_ceiling_ft: 9 }).ft === 10, "a typed height wins over the default");
const wa = P.flWallSf(rm, flx);
check(wa && Math.abs(wa.gross - 48 * 9.094) < 0.01, "wall area gross = perimeter x height (48 x 9'-1 1/8\")");
check(wa && Math.abs(wa.doors - 2.67 * 6.667) < 0.01 && Math.abs(wa.net - (wa.gross - wa.doors)) < 1e-9,
      "door openings come out at door height (6'-8\"), not floor to ceiling - the wall over the door is wall");
check(P.flWallSf({ perim_lf: 40 }, flx) === null && P.flWallSf({ perim_lf: null, ceiling_ft: 9 }, flx) === null,
      "no height or no scale: no wall area, never 0");
check(P.flWallSf({ perim_lf: 40, openings_lf: 3, ceiling_ft: 6 }, flx).doors === 18, "a ceiling lower than a door: the opening is capped at the ceiling");
const lineC = P.flRoomLine(rm, flx);
check(/wall area 419 SF at 9'-1/.test(lineC) && /from the sheet/.test(lineC), "room line says the wall area, the height and its source: " + lineC);
check(/no height read, type one/.test(P.flRoomLine({ area_sf: 100, perim_lf: 40, ceiling_text: "VAULTED CEILING" }, flx)),
      "a vaulted note with no height asks for one instead of guessing");

console.log("waste, transitions, details");
const types2 = [{ name: "Carpet", color: "#4e9af1", sf_price: 3.25, lf_price: 0, waste_pct: 10 },
                { name: "Tile", color: "#4fc27a", sf_price: 0, lf_price: 0, waste_pct: 0 }];
const B1 = { x0: 100, y0: 200, x1: 100, y1: 254, r: 54 };       // a 3'-0" door at 1/4"
const B2 = { x0: 300, y0: 200, x1: 300, y1: 236, r: 36 };       // a 2'-0" door
const rooms2 = [
  { name: "HALL", area_sf: 200, perim_lf: 60, openings_lf: 5, doors: 2, type: 0, bridges: [B1, B2], ceiling_ft: 9, ceiling_by: "sheet" },
  { name: "BATH", area_sf: 50, perim_lf: 30, openings_lf: 3, doors: 1, type: 1, bridges: [{ x0: 100, y0: 254, x1: 100, y1: 200, r: 54 }] },
  { name: "BED", area_sf: 150, perim_lf: 50, openings_lf: 2, doors: 1, type: 0, bridges: [B2] },
];
const tr = P.flTransitions(rooms2, types2);
check(tr.transitions.length === 1 && tr.transitions[0].ta === 0 && tr.transitions[0].tb === 1 && tr.transitions[0].width_pt === 54,
      "HALL/BATH share one door and differ in type: ONE transition, the door's width (bridge matched end-for-end)");
check(tr.open === 0, "HALL/BED share the other door but are both Carpet: no transition, no open doorway");
const tr2 = P.flTransitions([rooms2[0]], types2);
check(tr2.transitions.length === 0 && tr2.open === 2, "a picked room's doorways to unpicked rooms are counted as open, not as transitions");
check(P.flTransitions([{ type: null, bridges: [B1] }, { type: 1, bridges: [B1] }], types2).transitions.length === 0,
      "an untyped room makes no transition");
const items2 = P.flItems(types2, rooms2, flx);
const lab = items2.map(it => it.label);
check(lab[0] === "Flooring — Carpet" && items2[0].qty === 350 && items2[0].details.length === 2
      && items2[0].details[0].name === "HALL" && items2[0].details[0].qty === 200 && items2[0].details[0].unit === "SF",
      "the flooring row carries its rooms as details: " + JSON.stringify(items2[0].details));
check(lab[1] === "Waste — Carpet (10%)" && items2[1].qty === 35 && items2[1].unit_price === 3.25,
      "10% waste is its own row at the type's $/SF, the measured row untouched: " + lab[1] + " " + items2[1].qty);
check(lab[2] === "Base/molding — Carpet" && items2[2].qty === 103 && items2[2].details[0].note === "2 doors out",
      "base row details name the doors taken out: " + JSON.stringify(items2[2].details[0]));
check(!lab.some(l => /Waste — Tile/.test(l)), "no waste row for a type with 0%");
const wallRow = items2.find(it => /^Wall area/.test(it.label));
check(wallRow && Math.abs(wallRow.qty - (60 * 9 - 5 * 6.667)) < 0.06 && wallRow.details.length === 1 && /from the sheet/.test(wallRow.details[0].note),
      "one wall-area row for the rooms that have a height, with each room's basis: " + JSON.stringify(wallRow && wallRow.details));
const trRow = items2.find(it => /^Transition strips/.test(it.label));
check(trRow && trRow.label === "Transition strips — Carpet / Tile" && trRow.qty === 1 && trRow.unit === "EA"
      && /HALL ↔ BATH/.test(trRow.details[0].name) && /3'-0"/.test(trRow.details[0].note),
      "transition strips: one EA row per type pair, each door named with its width: " + JSON.stringify(trRow && trRow.details));
check(lab.join("|") === "Flooring — Carpet|Waste — Carpet (10%)|Base/molding — Carpet|Flooring — Tile|Base/molding — Tile|Wall area — perimeter × ceiling|Transition strips — Carpet / Tile",
      "row order: per type (floor, waste, base), then wall area, then transitions: " + lab.join("|"));
const LRX = new Function("return " + grabConst("FL_LABEL_RX") + ";")();
check(lab.every(l => LRX.test(l)) && LRX.test("Walls — interior (centreline)") && !LRX.test("Mass Excavation"),
      "FL_LABEL_RX owns every row kind the panel writes, so re-apply replaces them all");

console.log("walls by type, from source");
const wc = grab("flWallClassOf");
check(wc && /shear/.test(wc) && /ext\(erior\)\?/.test(wc) && /wall \(unclassified\)/.test(wc), "class by layer / legend name: shear, exterior, interior, unclassified");
const WC = new Function("const FL_WALL_CLASSES = " + grabConst("FL_WALL_CLASSES") + ";\n" + wc + "\nreturn flWallClassOf;")();
check(WC({ style_id: 1, layer: "A-Exterior Wall Line" }, {}) === "exterior", "A-Exterior Wall Line -> exterior");
check(WC({ style_id: 2, layer: "A-wall" }, {}) === "interior", "A-wall on a layered sheet -> interior");
check(WC({ style_id: 3, layer: "", suggested_label: "SHEAR WALL (legend)" }, {}) === "shear", "a SHEAR WALL legend label -> shear");
check(WC({ style_id: 4, layer: "", suggested_label: "solid solid" }, {}) === "wall (unclassified)", "a heavy unnamed solid -> unclassified, never guessed");
check(WC({ style_id: 4, layer: "", suggested_label: "solid solid" }, { wallClass: { 4: "exterior" } }) === "exterior", "the operator's class wins");
check(WC({ style_id: 5, layer: "A-Wall Hatch" }, {}) === "not a wall" && WC({ style_id: 6, layer: "A-Flooring" }, {}) === "not a wall",
      "the hatch between a wall's faces and the flooring boundaries enclose rooms but are not wall lines");
const fsrc = grab("flFaceShare");
const FS = new Function(fsrc + "\nreturn flFaceShare;")();
const twoFace = [{ points: [[0, 0], [200, 0]] }, { points: [[0, 6], [200, 6]] }, { points: [[300, 0], [300, 100]] }, { points: [[306, 0], [306, 100]] }];
check(FS(twoFace).share > 0.99, "two parallel lines 6 pt apart: every segment has a partner (drawn as two faces)");
check(FS([{ points: [[0, 0], [200, 0]] }, { points: [[0, 40], [200, 40]] }]).share === 0, "lines 40 pt apart are not a wall's two faces");
const wr = grab("flWallRows");
check(wr && /centreline/.test(wr) && /faces per wall/.test(wr), "centreline rows say the line footage and the faces they divided by");
const ap2 = grab("flApplyItems");
check(ap2 && /if \(fl\.wallRows\) for \(const it of flWallRows\(fl\)\)/.test(ap2), "centreline rows reach the takeoff only when ticked");
const rf2 = grab("renderFl");
check(rf2 && /"Walls by type"/.test(rf2) && /"Label wall lines by type"/.test(rf2) && /add centreline wall LF rows/.test(rf2),
      "the panel has the walls block, the relabel button and the centreline checkbox");
check(rf2 && /classify the \$\{flWallStyles\(fl\)\.length\} wall line types/.test(rf2) && /fl\.wallClass\[s\.style_id\] = sel\.value/.test(rf2),
      "one class select per wall line type, folded under the table");
check(rf2 && /waste %/.test(rf2) && /num\("waste_pct"\)/.test(rf2), "the types table has a waste % column");
check(rf2 && /ceiling height for rooms with no note/.test(rf2) && /fl-clg/.test(rf2), "a default ceiling input, and a per-room height box");
check(rf2 && /transition/.test(rf2) && /doorway.*to rooms not picked yet/.test(rf2), "the result line counts transitions and open doorways");
const lw = grab("flLabelWalls");
check(lw && /state\.labels\.set\(s\.style_id, name\)/.test(lw) && /memSave\(s\)/.test(lw), "relabelling goes through the label map and memSave, the style row's own path");

console.log("persistence of the new fields");
const sp = grab("flSavePayload");
check(sp && /waste_pct/.test(sp) && /ceiling_ft/.test(sp) && /ceiling_by/.test(sp) && /bridges/.test(sp)
      && /default_ceiling_ft/.test(sp) && /wallClass/.test(sp) && /wallFaces/.test(sp) && /wallRows/.test(sp),
      "the sidecar carries waste, ceilings, bridges, the default height and the wall classing");
const sv = grab("flApplySaved");
check(sv && /sv\.default_ceiling_ft/.test(sv) && /sv\.wallClass/.test(sv) && /r\.bridges/.test(sv) && /ceiling_by === "typed"/.test(sv),
      "...and restores them, a typed height staying typed");
const pk = grab("flPickAt");
check(pk && /j\.ceiling/.test(pk) && /bridges: \(j\.bridges_used \|\| \[\]\)/.test(pk), "a pick keeps the ceiling note and the door bridges the server used");
console.log("details reach the panel, the CSV and the payload");
check(/details: Array\.isArray\(it\.details\) \? it\.details : null/.test(SRC), "computeTakeoffRows carries details on calculator rows");
check(!!grab("detailNote") && /box\.appendChild\(detailNote\(it\)\)/.test(SRC), "the itemized panel prints a detail note under the row");
check(/`  part: \$\{dt\.name\}`/.test(SRC) && /`part of \$\{it\.label\}`/.test(SRC), "the CSV lists each part under its row, named as part of it");

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
