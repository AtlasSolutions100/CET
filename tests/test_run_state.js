// A DETECTION IN PROGRESS, PINNED.
//
// From the 2026-09-02 screen share, the owner's business partner driving the
// app: "I liked how before it said detecting it. It's super unnoticeable. You
// should make it blink back and forth every second or something." He pressed
// Detect and could not tell whether anything was happening. The owner's own
// answer in the moment: "I'll make it green."
//
// Four surfaces reported the same run and this suite pins that they now agree:
//
//   1. LOGIC - runStateOf() is the single decision. Two claims matter most:
//
//      * RUNNING BEATS A STALE RESULT. renderSheetHead used to read
//        `state.result ? "detected" : running ? "detecting…"`, so pressing
//        Detect on a sheet that ALREADY had a result left the header chip
//        saying "detected" in corroborated green while the status bar said
//        "detecting…". That is the case this test would have caught: one run,
//        two surfaces, opposite answers.
//      * A RUN ON ANOTHER PAGE (Detect all) says so, rather than claiming the
//        sheet on screen is being detected.
//
//   2. WIRING - the pill exists in the markup, every surface is repainted
//      from the one reading, and the four animations share one cadence
//      variable so they cannot drift apart.
//
//   3. REDUCED MOTION - every animation is switched off, and the lit state is
//      kept. A viewer who asked the OS for no animation must not be the one
//      person who cannot tell a run is happening.
//
// webui/app.js is not a module and touches the DOM at load, so this evals
// ONLY the marked RUN-STATE block - same technique as test_tools_menu.
//
// Dependency-free:  node tests/test_run_state.js

"use strict";
const fs = require("fs");
const path = require("path");

const appSrc = fs.readFileSync(
  path.join(__dirname, "..", "webui", "app.js"), "utf8");
const htmlSrc = fs.readFileSync(
  path.join(__dirname, "..", "webui", "index.html"), "utf8");
const cssSrc = fs.readFileSync(
  path.join(__dirname, "..", "webui", "style.css"), "utf8");

let failures = 0;
function check(cond, msg) {
  if (!cond) { failures++; console.error("FAIL:", msg); }
  else console.log("ok:", msg);
}

// ---- the pure block ---------------------------------------------------------
const a = appSrc.indexOf("// RUN-STATE-BEGIN");
const b = appSrc.indexOf("// RUN-STATE-END");
check(a >= 0 && b > a, "RUN-STATE markers present in webui/app.js");
if (a < 0 || b <= a) process.exit(1);
const R = new Function(appSrc.slice(a, b) +
  " return { runStateOf, RUN_BLINK_MS };")();

// =============================================================================
// 1. RUNNING BEATS A STALE RESULT  - the disagreement this item was about
// =============================================================================
{
  const s = R.runStateOf("running", 0, /* hasResult */ true);
  check(s.busy === true, "re-detect of a detected sheet: busy");
  check(s.mine === true, "re-detect: the run is on THIS page");
  check(s.chip === "detecting…",
    `re-detect: the header chip says detecting, not "detected" (got "${s.chip}")`);
  check(s.chipCls === "run",
    `re-detect: the chip wears the run class, never "ok" (got "${s.chipCls}")`);
  check(s.btn === "Detecting…", "re-detect: the Detect button says so");
  check(s.flag === "DETECTING THIS SHEET", "re-detect: the canvas pill names this sheet");
}

// =============================================================================
// 2. THE OTHER FOUR STATES
// =============================================================================
{
  const s = R.runStateOf("running", 0, false);
  check(s.chip === "detecting…" && s.chipCls === "run",
    "first detect of an undetected sheet: same chip, same class");
}
{
  const s = R.runStateOf("done", 0, true);
  check(s.busy === false && s.chip === "detected" && s.chipCls === "ok",
    "finished: not busy, detected, corroborated green");
  check(s.flag === "" && s.btn === "Detect lines",
    "finished: no pill, the button goes back to its verb");
}
{
  const s = R.runStateOf("error", 0, false);
  check(s.chip === "detect failed" && s.chipCls === "warn" && s.busy === false,
    "a failed run says failed, in warn, and is not busy");
}
{
  const s = R.runStateOf("idle", 0, false);
  check(s.chip === "not detected" && s.chipCls === "" && s.busy === false,
    "an untouched sheet: not detected, no colour");
}
// an error on a page that HAS a result: the failure outranks the stale result,
// the same way a run does - the operator must not read green after a failure
{
  const s = R.runStateOf("error", 0, true);
  check(s.chip === "detect failed" && s.chipCls === "warn",
    "a failed re-detect does not fall back to the old result's green");
}

// =============================================================================
// 3. DETECT ALL - a run on a page that is NOT on screen
// =============================================================================
{
  const s = R.runStateOf("done", 3, true);
  check(s.busy === true, "3 other pages running: the app is busy");
  check(s.mine === false, "...but not THIS page");
  check(s.chip === "detected",
    "...so this sheet's own chip still tells the truth about this sheet");
  check(s.flag === "DETECTING 3 OTHER PAGES",
    `...and the pill says which (got "${s.flag}")`);
  check(s.btn === "Detect lines",
    "...and Detect is not claimed by someone else's run");
}
{
  const s = R.runStateOf("idle", 1, false);
  check(s.flag === "DETECTING 1 OTHER PAGE", "one other page: singular");
}
{
  // this page AND others: this page wins the wording, because that is the one
  // the pill is sitting on top of
  const s = R.runStateOf("running", 2, false);
  check(s.mine === true && s.flag === "DETECTING THIS SHEET",
    "this page running wins the pill over other pages running");
}

// =============================================================================
// 4. WIRING - the four surfaces are painted from the one reading
// =============================================================================
check(/id="runFlag"/.test(htmlSrc), "#runFlag pill exists in index.html");
check(/id="runFlagTxt"/.test(htmlSrc), "#runFlagTxt is its text slot");
check(/<div id="runFlag"[^>]*role="status"[^>]*aria-live="polite"/.test(htmlSrc),
  "the pill is an aria-live status region, so it is announced too");
{
  const i = htmlSrc.indexOf('id="runFlag"');
  const stage = htmlSrc.indexOf('<section id="stage">');
  const mini = htmlSrc.indexOf('id="miniLegend"');
  check(stage >= 0 && i > stage && i < mini,
    "the pill lives inside #stage, over the sheet - not in the chrome");
}
check(/function runFlagSync\(\)/.test(appSrc), "runFlagSync() exists");
check(/function runStateNow\(\)/.test(appSrc), "runStateNow() reads the live state");
// every surface, from the one reading
{
  const i = appSrc.indexOf("function runFlagSync()");
  const body = appSrc.slice(i, appSrc.indexOf("\n}", i));
  check(/runStateNow\(\)/.test(body), "runFlagSync takes ONE reading");
  check(/\$\("runFlag"\)/.test(body), "...paints the canvas pill");
  check(/\$\("detectBtn"\)/.test(body), "...paints the Detect button");
  check(/classList\.toggle\("running", rs\.mine\)/.test(body),
    "...and the button's running class comes from that reading");
  check(/aria-busy/.test(body), "...with aria-busy on the button");
  check(/run-busy/.test(body), "...and a body class the CSS can hang off");
}
// the header chip is no longer worked out locally
check(!/state\.result \? "detected"\s*\n?\s*:\s*\(state\.pageStatus/.test(appSrc),
  "renderSheetHead no longer decides the run chip for itself");
check(/const rs = runStateNow\(\);\s*\n\s*meta\.append\(chip\(rs\.chip, rs\.chipCls\)\)/
  .test(appSrc), "the header chip comes from runStateOf");
// repainted on every beat that can change it
check(/if \(p === state\.page\) renderSheetHead\(\);[\s\S]{0,320}runFlagSync\(\)/
  .test(appSrc), "setPageStatus repaints the flag - including for OTHER pages");
check(/renderSheetFacts\(\);[\s\S]{0,300}runFlagSync\(\);/.test(appSrc),
  "renderSheetHead repaints it before its own early return");
// the run is painted BEFORE the POST, which is the slow part
{
  const i = appSrc.indexOf('$("detectBtn").onclick');
  const body = appSrc.slice(i, appSrc.indexOf("\n};", i));
  const iRun = body.indexOf('setPageStatus(state.page, "running")');
  const iPost = body.indexOf("await fetch(");
  check(iRun >= 0 && iPost > iRun,
    "Detect paints the run BEFORE awaiting the server, not after");
}

// =============================================================================
// 5. ONE CADENCE, AND REDUCED MOTION
// =============================================================================
check(/--run-blink:\s*1000ms/.test(cssSrc),
  "--run-blink is the 1s cadence the partner asked for");
check(R.RUN_BLINK_MS === 1000,
  "app.js names the same number, so the two cannot drift");
for (const sel of [".run-flag", ".status.busy", ".sh-chip.run", "#detectBtn.running"]) {
  const m = cssSrc.match(new RegExp(sel.replace(/[.#]/g, "\\$&") +
    "\\s*{[^}]*animation:[^;}]*var\\(--run-blink\\)"));
  check(!!m, `${sel} blinks on the shared cadence`);
}
check(/\.thumb-badge\.running\s*{\s*animation:\s*pulse var\(--run-blink\)/.test(cssSrc),
  ".thumb-badge.running is retimed onto the same cadence");
check(/\.run-flag[^{]*{[^}]*pointer-events:\s*none/.test(cssSrc),
  "the pill never blocks a click on the sheet under it");
{
  // the reduced-motion block turns every one of them off
  const i = cssSrc.lastIndexOf("@media (prefers-reduced-motion: reduce)");
  check(i >= 0, "there is a reduced-motion block after the run styles");
  const blk = cssSrc.slice(i, cssSrc.indexOf("}\n", cssSrc.indexOf("animation: none", i)));
  for (const sel of [".run-flag", ".status.busy", ".sh-chip.run",
                     "#detectBtn.running", ".thumb-badge.running"])
    check(blk.includes(sel), `reduced motion switches off ${sel}`);
  check(/animation:\s*none/.test(blk), "...by dropping the animation, not the colour");
  check(!/\.run-flag\s*{[^}]*display:\s*none/.test(blk),
    "...and it never hides the pill: no-animation must still mean visible");
}
// the run colour is the accent, not the warn amber - "I'll make it green"
check(/\.run-flag[^{]*{[^}]*background:\s*var\(--t-accent\)/.test(cssSrc),
  "the pill is the accent green");
check(/\.sh-chip\.run[^{]*{[^}]*background:\s*var\(--t-accent\)/.test(cssSrc),
  "the header chip is the same green");

console.log(failures ? `\n${failures} FAILED` : "\nall run-state checks passed");
process.exit(failures ? 1 : 0);
