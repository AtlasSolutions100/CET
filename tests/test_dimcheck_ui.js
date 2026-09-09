// DIMENSION-STRING SCALE CHECK in the review UI (CET, 2026-09-08).
//
// The engine pairs every printed "20'-6\"" with its extension lines and
// says what scale the sheet is drawn at (result.dimension_check). Belle
// A1.00: caption 4 ft/in, drawn bar agrees, six of seven dimensions measure
// 8 - every square foot 4x low, and no caption reader could see it. Pinned
// here:
//   * confDimCheck compares the implied value against the scale in force
//     RIGHT NOW (a reviewer's pick re-runs it), within 2.5%
//   * the header chip: green only on agreement, red with the gap when the
//     dimensions contradict, amber when nothing is in force or the sheet's
//     dimensions disagree with each other; a "use" button only when it
//     would change something
//   * the banner sentence for each of those, and a scale adopted from the
//     dimensions wears its own amber wording (not "you typed")
//   * the overlay toggle is its own function (per-page state, one writer)
//     and pageReset clears it; drawDimCheck draws each sample's ends
//   * a result with no check asks the server once and repaints
//   * from_dimensions is cleared by a later typed scale
//
// Dependency-free:  node tests/test_dimcheck_ui.js
"use strict";
const fs = require("fs");
const path = require("path");
const SRC = fs.readFileSync(path.join(__dirname, "..", "webui", "app.js"), "utf8");
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

console.log("pure: the comparison");
const names = ["confDimCheck", "dimCheckChipText"];
const bodies = names.map(grab);
check(bodies.every(Boolean), "helpers exist: " + names.join(", "));
const mk = (result) => new Function(
  "const state = { result: " + JSON.stringify(result) + " };\n"
  + "const DIM_AGREE_PCT = " + grabConst("DIM_AGREE_PCT") + ";\n"
  + "const confFt = " + grab("confFt").replace(/^function confFt/, "function") + ";\n"
  + bodies.join("\n") + "\nreturn { confDimCheck, dimCheckChipText };")();
const dc8 = { n_printed: 7, n_measured: 7, n_agree: 6, implied_ft_per_paper_inch: 8.059, why: "dominant",
              clusters: [{ ft_per_paper_inch: 8.059, n: 6 }, { ft_per_paper_inch: 21.6, n: 1 }], samples: [] };
let u = mk({ scale: { ft_per_paper_inch: 4.0, text: "1/4\" = 1'-0\"" }, dimension_check: dc8 });
let d = u.confDimCheck();
check(d && d.implied === 8.059 && d.cmp && d.cmp.agrees === false && Math.abs(d.cmp.deltaPct - 101.5) < 0.1,
      "Belle: 8.06 against 4 in force = contradiction, 101% apart");
check(d && Math.abs(d.cmp.ratioLen - 2.015) < 0.01 && Math.abs(d.cmp.ratioArea - 4.06) < 0.01, "lengths 2x, areas 4x");
check(/6 dimensions say 1 in = 8\.06 ft · 101\.5% apart — CHECK/.test(u.dimCheckChipText(d)), "chip: the count, the reading and the gap: " + u.dimCheckChipText(d));
u = mk({ scale: { ft_per_paper_inch: 8.0, text: "1/8\" = 1'-0\"" }, dimension_check: dc8 });
d = u.confDimCheck();
check(d.cmp.agrees === true && u.dimCheckChipText(d) === "✓ 6 dimensions agree", "the reviewer picks 8: the same check now agrees (re-run against the scale in force)");
u = mk({ scale: null, dimension_check: dc8 });
d = u.confDimCheck();
check(d && d.cmp === null && u.dimCheckChipText(d) === "6 dimensions say 1 in = 8.06 ft", "no scale in force: the reading is offered, nothing compared");
u = mk({ scale: { ft_per_paper_inch: 4 }, dimension_check: { n_printed: 9, n_measured: 8, n_agree: 4, implied_ft_per_paper_inch: null, why: "split",
                                                            clusters: [{ ft_per_paper_inch: 4, n: 4 }, { ft_per_paper_inch: 8, n: 4 }] } });
d = u.confDimCheck();
check(d && d.implied === null && /dimensions disagree: 4 at 4 ft\/in, 4 at 8 ft\/in/.test(u.dimCheckChipText(d)), "a split sheet: the chip names both clusters");
u = mk({ scale: { ft_per_paper_inch: 4 }, dimension_check: { n_printed: 0 } });
check(u.confDimCheck() === null, "no printed dimensions: no check, no chip");
u = mk({ scale: { ft_per_paper_inch: 4 }, dimension_check: null });
check(u.confDimCheck() === null, "a scan (null check): nothing");
u = mk({ scale: { ft_per_paper_inch: 4 }, dimension_check: { n_printed: 5, n_measured: 2, n_agree: 2, implied_ft_per_paper_inch: null, why: "too-few", clusters: [{ ft_per_paper_inch: 4, n: 2 }] } });
check(/2 measured, no single reading/.test(u.dimCheckChipText(u.confDimCheck())), "too few: says so, states nothing");

console.log("header chip and use button, from source");
const head = grab("renderSheetHead");
check(head && /dimCheckEnsure\(\);/.test(head) && /dimCheckChipText\(d\)/.test(head), "the header asks for the check and paints the chip");
check(head && /const cls = !d\.implied \? "warn" : !d\.cmp \? "warn" : d\.cmp\.agrees \? "ok" : "bad";/.test(head),
      "colour rule: green only on agreement, red on contradiction, amber otherwise");
check(head && /c\.onclick = dimCheckToggle;/.test(head) && !/state\.dimShow = /.test(head), "the chip toggles the overlay through a named helper; the painter writes no state");
check(head && /d\.implied && \(!sc \|\| \(d\.cmp && !d\.cmp\.agrees\)\) && !\(sc && sc\.from_dimensions\)/.test(head),
      "the use button appears only when nothing is in force or the dimensions contradict it, and not once adopted");
check(head && /b\.onclick = scaleFromDimensions;/.test(head), "...and it adopts through scaleFromDimensions");
check(head && /FROM THE SHEET'S DIMENSIONS/.test(head) && /sc\.from_dimensions/.test(head), "an adopted reading wears its own amber chip");
const sfd = grab("scaleFromDimensions");
check(sfd && /applyTypedScale\(d\.implied, text\)/.test(sfd) && /from_dimensions = true/.test(sfd),
      "adoption goes through applyTypedScale (undo, sidecar, export all record a reviewer decision) and flags from_dimensions");
const sto = grab("scaleTypedObj");
check(sto && /from_dimensions: false/.test(sto), "a later typed number clears from_dimensions");
const toggle = grab("dimCheckToggle");
check(toggle && /state\.dimShow = !state\.dimShow/.test(toggle), "the toggle flips state.dimShow");
check(/state\.dimShow = false;\s*\/\/ the dimension-span overlay is per sheet/.test(SRC), "pageReset clears the overlay flag");
const ens = grab("dimCheckEnsure");
check(ens && /res\.dimension_check !== undefined \|\| res\._dimFetching/.test(ens) && /\/dimcheck`, \{ method: "POST" \}/.test(ens),
      "a result without the key asks POST .../dimcheck once");
check(ens && /if \(state\.result === res\)/.test(ens) && /scaleRepaint\(\)/.test(ens), "...and repaints only if that result is still the one on screen");

console.log("banner, from source");
const cl = grab("confLines");
check(cl && /Checked against the sheet's own dimensions/.test(cl) && /say\("ok"/.test(cl), "green sentence on agreement");
check(cl && /The sheet's own dimensions contradict the scale/.test(cl) && /every square foot by/.test(cl),
      "red sentence names the ratio on lengths and areas");
check(cl && /Scale set from the sheet's own dimensions/.test(cl) && /sc\.from_dimensions\)/.test(cl),
      "an adopted reading gets its own amber sentence, before the typed branch");
check(cl && cl.indexOf("sc.from_dimensions") < cl.indexOf("sc.typed_by_reviewer"), "...and it is tested before typed_by_reviewer (typed sets the same flags)");
check(cl && /dimensions do not agree with each other/.test(cl), "a split sheet is said in words");
check(cl && /Nothing is in force yet/.test(cl) && /adopts that reading/.test(cl), "no scale: the sentence points at the use button");

console.log("overlay");
const dr = grab("drawDimCheck");
check(dr && /if \(!state\.dimShow \|\| !state\.result\) return;/.test(dr), "draws only when toggled on");
check(dr && /s\.ends/.test(dr) && /DIM_AGREE_PCT/.test(dr) && /#1f9d55/.test(dr) && /#e0304e/.test(dr),
      "each sample's measured span, green when it agrees with the scale in force, red otherwise");
check(/drawFlooring\(ctx, k\);\n  drawDimCheck\(ctx, k\);/.test(SRC), "drawn after the flooring overlay");
check(/\.dim-chip \{/.test(CSS) && /\.dim-use \{/.test(CSS), "style.css: the chip and the button");

console.log(fails ? "\n" + fails + " FAILURE(S)" : "\nall green");
process.exit(fails ? 1 : 0);
