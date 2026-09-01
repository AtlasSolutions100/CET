// THE EARTHWORK PANEL'S THIRD STATE.
//
// `state.ew` was two-valued doing a three-valued job. null meant BOTH "no
// detect / panel never opened" AND "the /earthwork/suggest fetch is in
// flight" - and that fetch is 94 s cold on Belle Farms Upper Parcel ROAD
// GRADING 1 of 2 p0 and 204 s on Oncor Cloudcrest engine page index 3 =
// printed C-04 (measured 2026-08-31, ~99% of it one pytesseract loop in
// takeoff_engine.earthwork.gap_label_elevations). So every `if (!state.ew)`
// guard answered "you never opened the panel" to an operator who was
// staring at the open panel, and six of them said it out loud.
//
// WHAT IS PINNED HERE, AND WHY EACH ONE
//
//   1. ewNotReady, BEHAVIOURALLY. Four distinct states, four distinct
//      sentences: loading / failed / no-detect / not-opened. This is the
//      whole fix in one function, so it is evaluated for real (its own
//      source, its own constants) rather than grepped. A regression that
//      collapses two of the four branches back into one message is exactly
//      the bug, and only a behavioural test sees it.
//
//   2. SINGLE FLIGHT, BEHAVIOURALLY. Two callers reach ewEnsure - the
//      EARTHWORK button and gzRestoreCompute, which runs unprompted on any
//      page with saved zones - and over a 94-204 s window they overlapped
//      routinely. Two concurrent suggests meant the LOSER hit `state.ew`
//      already set, returned false, and its caller printed "run Detect
//      first" over the winner's freshly rendered rows. One fetch, every
//      caller a winner. Counted, not grepped.
//
//   3. THE FETCH IS WRAPPED. It had no try/catch: a dropped connection
//      rejected uncaught and left the panel on a hint that never changed -
//      pixel-identical to the busy state. Source scan, because the failure
//      is structural (a later reader "simplifying" the wrapper away).
//
//   3b. SINGLE FLIGHT ACROSS BOTH FEATURES, added 2026-08-31. The token in
//      (2) only covered the earthwork panel's own callers. ensureElev - the
//      selection pill's elevation chip - called fetch() itself and bypassed
//      it, so clicking a contour and then pressing EARTHWORK fired the same
//      94-204 s endpoint TWICE for one page: two GETs, one click apart, in
//      the server log. suggestOnce() is now the shared token, keyed on
//      gen|job|page, and it is a single-flight guard and NOT a result
//      cache - re-running Detect replaces every chain object without
//      bumping state.gen, so a kept payload would hand the new detection
//      the old detection's chain ids. Counted, not grepped.
//
//   4. THE SIX SITES THAT LIED now route through the helper, and the pure
//      RENDER functions deliberately do not - they run on every repaint and
//      would spray the status bar.
//
//   5. THE GEN GUARDS SURVIVED the refactor. A suggest started on page A
//      must not resolve into page B. That check predates this fix and the
//      fix must not have eaten it.
//
//   6. THE BUSY LINE IS WHERE THE EYE IS. The in-panel hint renders into
//      #ewRows at the bottom of a long panel - measured 53 px below the
//      bottom of #sideScroll on the frame the panel opens. So the status
//      bar carries the sentence too, like every other long operation in
//      this file, and BOTH are cleared when the data lands (the stale red
//      line used to still be on the bar 102 s later, panel fully loaded).
//
// webui/app.js is not a module and touches the DOM at load, so suites 1 and
// 2 eval only the extracted functions, the same technique as MULTISELECT /
// LINE-FAMILY / TRENCH-MATH. Everything else reads source as text.
//
// Dependency-free:  node tests/test_ew_busy_state.js

"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "webui", "app.js"), "utf8");
const HTML = fs.readFileSync(path.join(ROOT, "webui", "index.html"), "utf8");
const CSS = fs.readFileSync(path.join(ROOT, "webui", "style.css"), "utf8");

let fails = 0;
const check = (ok, msg) => {
  if (ok) console.log("  ok: " + msg);
  else { fails++; console.error("  FAIL: " + msg); }
};
const eq = (got, want, msg) => check(got === want, msg + "  (got " + JSON.stringify(got) + ")");

// Pull one top-level `function NAME(...)` out of the source by brace match.
// Every function taken this way is checked below to contain no brace inside
// a string literal, which is the only case this would get wrong.
function fnSrc(name) {
  const i = SRC.indexOf("\nfunction " + name + "(");
  const j = i < 0 ? SRC.indexOf("\nasync function " + name + "(") : i;
  if (j < 0) throw new Error("function not found in app.js: " + name);
  let d = 0;
  for (let k = SRC.indexOf("{", j); k < SRC.length; k++) {
    if (SRC[k] === "{") d++;
    else if (SRC[k] === "}" && --d === 0) return SRC.slice(j + 1, k + 1);
  }
  throw new Error("unbalanced braces reading " + name);
}

// referenced from more than one stage below, so module scope, not stage3's
const fetchSrc = fnSrc("ewFetchSuggest");
const onceSrc = fnSrc("suggestOnce");

// ---------------------------------------------------------------------------
console.log("1. ewNotReady: four states, four sentences");
// ---------------------------------------------------------------------------
const constBlock = (SRC.match(
  /const EW_SUGGEST_WAIT = [\s\S]*?\nconst EW_SUGGEST_FAIL = [^\n]*;/) || [])[0];
check(!!constBlock, "the wait/busy/fail sentences are declared as named constants");

const mk = new Function("state", "setStatus",
  constBlock + "\n" + fnSrc("ewNotReady")
  + "\nreturn { ewNotReady, BUSY: EW_SUGGEST_BUSY, FAIL: EW_SUGGEST_FAIL, WAIT: EW_SUGGEST_WAIT };");

function run(st) {
  const said = [];
  const api = mk(st, (t, cls) => said.push({ t: t, cls: cls }));
  const blocked = api.ewNotReady("the contour list");
  return { blocked: blocked, said: said, api: api };
}

// (a) data present -> the guard lets the click through and says nothing
{
  const r = run({ ew: { rows: [] }, ewLoading: null, ewFailed: false, result: {} });
  eq(r.blocked, false, "data loaded: the guard does not block");
  eq(r.said.length, 0, "data loaded: the guard stays silent");
}
// (b) IN FLIGHT - the reported bug. Must NOT claim the panel is unopened.
{
  const r = run({ ew: null, ewLoading: Promise.resolve(true), ewFailed: false, result: {} });
  eq(r.blocked, true, "in flight: the guard blocks");
  eq(r.said.length, 1, "in flight: exactly one message");
  eq(r.said[0].cls, "busy", "in flight: it is a BUSY message, not an error");
  check(/reading/i.test(r.said[0].t), "in flight: it says the sheet is being read");
  check(!/run Detect first/i.test(r.said[0].t),
    "in flight: it does NOT say 'run Detect first' - THE REPORTED LIE");
  check(!/press EARTHWORK\)/i.test(r.said[0].t),
    "in flight: it does NOT tell him to open the panel he already opened");
  check(r.said[0].t.indexOf("the contour list") >= 0,
    "in flight: it names what the click was for");
}
// (c) the read failed - a fourth state the old code could not express at all
{
  const r = run({ ew: null, ewLoading: null, ewFailed: true, result: {} });
  eq(r.blocked, true, "failed: the guard blocks");
  eq(r.said[0].cls, "err", "failed: it is an error");
  check(/retry|again/i.test(r.said[0].t), "failed: it offers a retry");
  check(!/run Detect first/i.test(r.said[0].t), "failed: it does not blame Detect");
}
// (d) no detection at all - the ONLY case the old sentence described
{
  const r = run({ ew: null, ewLoading: null, ewFailed: false, result: null });
  eq(r.blocked, true, "no detect: the guard blocks");
  eq(r.said[0].t, "run Detect first", "no detect: THIS is where that sentence belongs");
  eq(r.said[0].cls, "err", "no detect: it is an error");
}
// (e) detected, panel never opened
{
  const r = run({ ew: null, ewLoading: null, ewFailed: false, result: {} });
  eq(r.blocked, true, "never opened: the guard blocks");
  check(/EARTHWORK/.test(r.said[0].t), "never opened: it names the button to press");
  check(!/run Detect first/i.test(r.said[0].t),
    "never opened: detect HAS run, so it must not say otherwise");
}
// the four sentences must actually differ from each other
{
  const states = [
    { ew: null, ewLoading: Promise.resolve(1), ewFailed: false, result: {} },
    { ew: null, ewLoading: null, ewFailed: true, result: {} },
    { ew: null, ewLoading: null, ewFailed: false, result: null },
    { ew: null, ewLoading: null, ewFailed: false, result: {} },
  ];
  const texts = states.map(s => run(s).said[0].t);
  eq(new Set(texts).size, 4, "all four states produce four DIFFERENT sentences");
}
// the promised duration is honest about the measured range (94 s / 204 s)
{
  const api = mk({ ew: {} }, () => {});
  check(!/\b3 minutes\b/.test(api.WAIT),
    "the wait sentence does not quote a figure the OCR budget can invalidate");
  check(api.BUSY.indexOf(api.WAIT) >= 0, "the busy sentence carries the wait sentence");
}
// the rationale comment directly above the constant is the handoff to
// whoever next re-tunes the OCR budget; without it the sentence rots silently
{
  const at = SRC.indexOf("const EW_SUGGEST_WAIT");
  const preamble = SRC.slice(Math.max(0, at - 1200), at);
  check(/RE-MEASURE|re-measure/i.test(preamble),
    "the duration constant carries a re-measure instruction for whoever moves the OCR budget");
  check(/MEASURED/.test(preamble) && /gap_label_elevations/.test(preamble),
    "...and names the measurement and the loop it is measuring");
}

// ---------------------------------------------------------------------------
console.log("2. ewEnsure: single flight");
// ---------------------------------------------------------------------------
{
  const ensureSrc = fnSrc("ewEnsure");
  let calls = 0;
  let release;
  const gate = new Promise(res => { release = res; });
  const st = { ew: null, ewLoading: null, ewFailed: false, gen: 1 };
  const ewFetchSuggest = async () => { calls++; await gate; st.ew = { rows: [] }; return true; };
  const ewEnsure = new Function("state", "ewFetchSuggest",
    ensureSrc + "\nreturn ewEnsure;")(st, ewFetchSuggest);

  const a = ewEnsure();          // the EARTHWORK button
  const b = ewEnsure();          // the frustration double-press
  const c = ewEnsure();          // gzRestoreCompute, unprompted
  check(!!st.ewLoading, "while the suggest is in flight, state.ewLoading is truthy");
  eq(calls, 1, "three overlapping callers issue exactly ONE fetch");

  release();
  Promise.all([a, b, c]).then(rs => {
    eq(rs.filter(Boolean).length, 3, "every overlapping caller is told it succeeded");
    check(!st.ewLoading, "the in-flight flag is cleared once the fetch lands");
    return ewEnsure();
  }).then(r => {
    eq(r, true, "a later call short-circuits on the loaded data");
    eq(calls, 1, "and issues no second fetch");
    stage3();
  }).catch(e => { fails++; console.error("  FAIL: single-flight suite threw " + e); stage3(); });
}

function stage3() {
// -------------------------------------------------------------------------
console.log("3. the fetch is wrapped, and failure is a state");
// -------------------------------------------------------------------------
check(/try \{[\s\S]*suggestOnce\(\)/.test(fetchSrc),
  "ewFetchSuggest wraps its request in try - a dropped one used to reject uncaught");
check(/catch\s*\([\s\S]*state\.ewFailed = true/.test(fetchSrc),
  "a dropped or non-ok request records ewFailed instead of hanging on the hint");
check(/if \(!r\.ok\) throw/.test(onceSrc),
  "an HTTP error takes the same path as a dropped connection");
check(/ewFailed: false/.test(SRC) || /state\.ewFailed = false/.test(SRC),
  "a retry clears the previous failure");
check(/state\.ewLoading === p\) state\.ewLoading = null/.test(fnSrc("ewEnsure")),
  "the in-flight flag is cleared in a finally, and only by the flight that set it");

// -------------------------------------------------------------------------
console.log("3b. ONE suggest in flight per page, across BOTH features");
// -------------------------------------------------------------------------
// state.ewLoading only ever covered the earthwork panel's own callers.
// ensureElev - the selection pill's elevation chip - called fetch() itself
// and bypassed it, so clicking a contour and then pressing EARTHWORK fired
// the SAME 94-204 s endpoint twice: two GETs for the same page, one click
// apart, in the server log. suggestOnce is the shared token.
{
  let fetches = 0;
  let release;
  const gate = new Promise(res => { release = res; });
  const st = { gen: 4, job: "J", page: 3, suggestReq: null };
  const body = { suggestions: [{ chain_id: 1, z: 10, how: "radius", dist: 1 }] };
  const scope = {
    state: st,
    fetch: async () => { fetches++; await gate;
                         return { ok: true, json: async () => body }; },
  };
  const names = Object.keys(scope);
  const suggestOnce = new Function(...names, onceSrc + "\nreturn suggestOnce;")
    (...names.map(n => scope[n]));

  const a = suggestOnce();          // the elevation chip
  const b = suggestOnce();          // EARTHWORK, one click later
  const c = suggestOnce();          // gzRestoreCompute, unprompted
  eq(fetches, 1, "three callers on one page issue exactly ONE GET");
  check(a === b && b === c, "...they are handed the same promise");
  check(!!st.suggestReq, "the token is parked on state while it is in flight");

  // a request started on page 3 must never be handed to a caller on page 2
  st.page = 2;
  const d = suggestOnce();
  eq(fetches, 2, "a caller on ANOTHER page gets its own request");
  check(d !== a, "...not the one belonging to the page it switched away from");
  st.page = 3;

  release();
  Promise.all([a, d]).then(() => {
    check(st.suggestReq === null,
      "the token is dropped once the request settles - it is a single-flight "
      + "guard, NOT a result cache: re-running Detect replaces every chain "
      + "object without bumping state.gen, and a kept payload would hand the "
      + "new detection the old detection's chain ids");
    return null;
  }).then(() => {
    // a REJECTED request must not be parked either
    let n = 0;
    const st2 = { gen: 1, job: "J", page: 0, suggestReq: null };
    const bad = new Function("state", "fetch", onceSrc + "\nreturn suggestOnce;")
      (st2, async () => { n++; return { ok: false, status: 500 }; });
    return bad().then(() => { fails++; console.error("  FAIL: a 500 should reject"); },
      () => {
        check(st2.suggestReq === null, "a FAILED request is not parked either");
        return bad().catch(() => {});
      }).then(() => eq(n, 2, "...so the operator can ask again"));
  }).then(stage4, e => {
    // the SECOND handler, not .catch: a throw inside stage4 must not make
    // this run stage4 a second time
    fails++; console.error("  FAIL: single-flight suite threw " + e); stage4();
  });
}
}

function stage4() {

// -------------------------------------------------------------------------
console.log("4. every site that lied now routes through the guard");
// -------------------------------------------------------------------------
const speaks = [
  ['$("ewAddRow").onclick', /\$\("ewAddRow"\)\.onclick = \(\) => \{\s*if \(ewNotReady\(/],
  ['$("ewStrip").onclick', /\$\("ewStrip"\)\.onclick = \(\) => \{\s*if \(ewNotReady\(/],
  ['$("ewAddEx").onclick', /\$\("ewAddEx"\)\.onclick = \(\) => \{\s*if \(ewNotReady\(/],
  ['$("ewAddPr").onclick', /\$\("ewAddPr"\)\.onclick = \(\) => \{\s*if \(ewNotReady\(/],
  ['$("ewCalc").onclick', /\$\("ewCalc"\)\.onclick = async \(\) => \{\s*if \(ewNotReady\(/],
  ['$("ewAdd").onclick', /\$\("ewAdd"\)\.onclick = \(\) => \{\s*if \(ewNotReady\(/],
  ['$("ewMap").onchange', /\$\("ewMap"\)\.onchange[\s\S]{0,200}?if \(ewNotReady\(/],
  ['$("gzDraw").onclick', /\$\("gzDraw"\)\.onclick[\s\S]{0,200}?if \(ewNotReady\(/],
  ['$("gzBox").onclick', /\$\("gzBox"\)\.onclick[\s\S]{0,200}?if \(ewNotReady\(/],
  ["gzModalOpen", /function gzModalOpen\([^)]*\) \{\s*if \(ewNotReady\(/],
];
for (const [name, re] of speaks) check(re.test(SRC), name + " speaks through ewNotReady");

check(!/setStatus\("open the EARTHWORK panel data first/.test(SRC),
  "the old 'open the EARTHWORK panel data first' string is gone from every site");
check(!/for \(const z of state\.gzones\) z\.err = "run Detect first"/.test(SRC),
  "a restored grading zone no longer blames Detect for an elevation read");

// The pure render functions must stay silent - they run on every repaint.
for (const name of ["renderEwLayers", "renderEwArea", "renderEwSpots"]) {
  const s = fnSrc(name);
  check(s.indexOf("ewNotReady") < 0, name + " stays a silent early return (it is not a click)");
}

// -------------------------------------------------------------------------
console.log("5. the page-generation guards survived the refactor");
// -------------------------------------------------------------------------
check(/gen !== state\.gen \|\| state\.ew\) return false/.test(fetchSrc),
  "a suggest that resolves after a page switch still refuses to write");
check(/const p = ewFetchSuggest\(state\.gen\)/.test(fnSrc("ewEnsure")),
  "the flight carries the generation it was started on");
check(/gen !== state\.gen\) return;/.test(fnSrc("gzRestoreCompute")),
  "gzRestoreCompute still drops out on a page switch");
check(/state\.ew = null; state\.ewLoading = null; state\.ewFailed = false;/.test(SRC),
  "loadResult clears all three earthwork flags together");

// -------------------------------------------------------------------------
console.log("6. the busy line is where the operator is looking");
// -------------------------------------------------------------------------
const btn = (SRC.match(/\$\("ewBtn"\)\.onclick = async \(\) => \{[\s\S]*?\n\};/) || [""])[0];
check(/setStatus\(EW_SUGGEST_BUSY, "busy"\)/.test(btn),
  "pressing EARTHWORK writes a busy line to the status bar BEFORE awaiting");
check(btn.indexOf("setStatus(EW_SUGGEST_BUSY") < btn.indexOf("await ewEnsure()"),
  "...before, not after - the await is 94-204 s wide");
check(/ewBusyPut\(EW_SUGGEST_BUSY/.test(btn), "and an in-panel line above the fold");
check(/ewBusyPut\(""\);\s*\n\s*setStatus\(""\);/.test(btn),
  "both lines are cleared when the data lands - the stale red line used to survive it");
check(/if \(gen !== state\.gen\) return;/.test(btn),
  "a page switch during the wait leaves the new page's status bar alone");
check(/EW_SUGGEST_BUSY[\s\S]{0,120}grading zones will recompute/.test(fnSrc("gzRestoreCompute")),
  "the unprompted restore path announces its own 94-204 s fetch");
check(/id="ewBusy"/.test(HTML), "#ewBusy exists in the markup");
check(HTML.indexOf('id="ewBusy"') < HTML.indexOf('id="ewHint"'),
  "#ewBusy sits above #ewHint, i.e. directly under the panel head and above the fold");
check(HTML.indexOf('id="ewBusy"') < HTML.indexOf('id="ewRows"'),
  "...and far above #ewRows, where the old hint rendered off screen");
check(/\.ew-busy \{/.test(CSS), ".ew-busy is styled");

if (fails) { console.error("\n" + fails + " check(s) failed"); process.exit(1); }
console.log("\nall earthwork busy-state checks passed");
}
