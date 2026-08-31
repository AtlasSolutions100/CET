// The "0.0 is not None" trap, JavaScript edition (CLAUDE.md section 5):
// isFinite(null) === true, so a bare isFinite on the typed spot datum made
// the fresh-open default (null) act as a TYPED DATUM OF ZERO - every
// truncated spot elevation served raw 29-49 ft values with the resolved
// 7,7xx destroyed, and Calculate fed those into the TIN. Caught live on
// Barn C3.1, 2026-08-30. This test pins the guard at the SOURCE level:
// every spotDatum authority test must use Number.isFinite (null-safe),
// never bare isFinite.
"use strict";
const fs = require("fs");
const path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "webui", "app.js"), "utf8");

let failures = 0;
function check(cond, msg) {
  if (!cond) { failures++; console.error("FAIL:", msg); }
  else console.log("ok:", msg);
}

// the mechanism itself, so nobody "simplifies" the guard away
check(isFinite(null) === true && Number.isFinite(null) === false,
      "the trap is real: isFinite(null) coerces, Number.isFinite does not");

// every line that tests spotDatum (or the base derived from it) for
// finiteness must be null-safe
const offenders = src.split("\n")
  .map((ln, i) => [i + 1, ln])
  .filter(([, ln]) => /(?<!Number\.)isFinite\(\s*(state\.ew\.spotDatum|base)\b/.test(ln));
check(offenders.length === 0,
      "no bare isFinite() on spotDatum/base (offenders: "
      + JSON.stringify(offenders.map(o => o[0])) + ")");

// the fresh-open default must resolve base to NaN, not 0
check(/const base = Number\.isFinite\(state\.ew\.spotDatum\)/.test(src),
      "ewActiveSpots derives base through Number.isFinite");

if (failures) { console.error(`\n${failures} FAILURE(S)`); process.exit(1); }
console.log("\nall spot-datum guard checks passed");
