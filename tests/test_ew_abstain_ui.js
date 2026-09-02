// AN ABSTAIN MUST LEAVE NOTHING BEHIND, AND A DROP MUST BE VISIBLE.
//
// THE DEFECT (measured 2026-09-02, live on :9855 against the DEM-truth
// outline sheet). Two halves, both in webui/app.js:
//
//  1. The 400 handler was one line:
//         $("ewResult").textContent = e.detail || ("failed (" + r.status + ")");
//         return;
//     Everything the PREVIOUS Calculate had painted stayed on screen beside
//     that sentence - the per-layer slabs in #ewLayerOut, the basis block,
//     the material balance - state.ew.result kept the superseded numbers,
//     and if the operator had pressed "Add to takeoff" those cubic yards
//     were still in state.extraItems and would still price, export and
//     print. A refusal that leaves a number on screen is not an abstain.
//     It was also about to render "[object Object]": the route's refusal
//     detail is now a structured object (message / code / surface / basis).
//
//  2. /earthwork/suggest has reported suggestions_dropped since the route
//     was written and NO SCREEN EVER RENDERED IT (grep across the repo:
//     two hits, both in server.py). With the ladder gate live an OCR-only
//     sheet whose reads do not step like contours now yields ZERO rows, and
//     the panel's empty state would have said "We found no contour
//     elevations on this sheet" - the one thing the reader knows is false.
//
//     node tests/test_ew_abstain_ui.js
"use strict";
const fs = require("fs");
const path = require("path");
const SRC = fs.readFileSync(path.join(__dirname, "..", "webui", "app.js"), "utf8");
const HTML = fs.readFileSync(path.join(__dirname, "..", "webui", "index.html"), "utf8");
const CSS = fs.readFileSync(path.join(__dirname, "..", "webui", "style.css"), "utf8");

let fails = 0;
const check = (ok, msg) => {
  if (ok) console.log("ok: " + msg);
  else { fails++; console.error("FAIL: " + msg); }
};
const eq = (got, want, msg) =>
  check(got === want, msg + " (got " + JSON.stringify(got) + ")");

function fnSrc(name) {
  const j = SRC.indexOf("function " + name + "(");
  if (j < 0) throw new Error("no function " + name);
  let d = 0;
  for (let k = SRC.indexOf("{", j); k < SRC.length; k++) {
    if (SRC[k] === "{") d++;
    else if (SRC[k] === "}" && --d === 0) return SRC.slice(j, k + 1);
  }
  throw new Error("unbalanced braces reading " + name);
}

// ---------------------------------------------------------------------------
// A DOM small enough to be honest about: the elements ewRefused touches.
// ---------------------------------------------------------------------------
function mkEl(id) {
  const el = {
    id: id, innerHTML: "", _text: "", hidden: false, children: [],
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
      toggle(c, on) { on ? this._s.add(c) : this._s.delete(c); },
      contains(c) { return this._s.has(c); },
    },
    appendChild(c) { this.children.push(c); return c; },
    get textContent() {
      return this._text + this.children.map(c => c.textContent).join("");
    },
    set textContent(v) { this._text = v; this.children = []; },
  };
  return el;
}

// THE 4010783 HANDLER, VERBATIM, so this file fails on BEHAVIOUR there and
// not on a stack trace: `git archive 4010783 | tar -x` has no ewRefused, and
// "the function is missing" proves only that the function is new. What has
// to fail is what the operator saw.
const OLD_HANDLER =
  'function ewRefused(detail, status) {\n'
  + '  $("ewResult").textContent = detail || ("failed (" + status + ")");\n'
  + '}';
const HAS_NEW = /function ewRefused\(/.test(SRC);
check(HAS_NEW,
  "webui/app.js has an ewRefused() that renders the abstain "
  + "(4010783 wrote e.detail straight into #ewResult and returned)");

function run(detail, opts) {
  opts = opts || {};
  const els = {};
  for (const id of ["ewResult", "ewLayerOut"]) els[id] = mkEl(id);
  const calls = [];
  const state = {
    ew: { result: { cut_yd3: 17997.6, fill_yd3: 1.0 }, added: !!opts.added,
          rows: [] },
    extraItems: [{ label: "Site Fill", qty: 17998, unit: "CY" },
                 { label: "Concrete", qty: 12, unit: "CY" }],
  };
  const said = [];
  const f = new Function(
    "$", "state", "document", "ewClearItems", "renderEwBasis",
    "renderEwBalance", "renderEwTake", "renderItemized", "setStatus",
    (HAS_NEW ? fnSrc("ewRefused") : OLD_HANDLER)
    + "\nreturn ewRefused;");
  const doc = {
    createElement(tag) { const e = mkEl(tag); e.tag = tag; return e; },
    createTextNode(t) { return { textContent: t, children: [] }; },
  };
  const ewClearItems = () => {
    calls.push("ewClearItems");
    state.extraItems = state.extraItems.filter(
      it => !/^(Site Cut|Site Fill|Strip Topsoil|Remove |Rough Place |Place |Export |Import Structural$)/.test(it.label));
  };
  f((id) => els[id], state, doc, ewClearItems,
    (j) => calls.push("renderEwBasis:" + JSON.stringify(j)),
    (j) => calls.push("renderEwBalance:" + JSON.stringify(j)),
    () => calls.push("renderEwTake"),
    () => calls.push("renderItemized"),
    (t, cls) => said.push({ t, cls }))(detail, 400);
  return { els, state, calls, said };
}

// ---------------------------------------------------------------------------
console.log("1. the structured refusal renders as words, not [object Object]");
// ---------------------------------------------------------------------------
const DETAIL = {
  message: "the existing surface carries only ONE elevation (324 ft) across "
    + "1 contour and 0 spot grades.",
  code: "surface_no_relief",
  surface: { name: "existing", n_contours: 1, n_spots: 0,
             distinct_elevations: 1, z_min_ft: 324, z_max_ft: 324 },
  basis: {
    existing: { name: "existing", n_contours: 1, n_spots: 0,
                distinct_elevations: 1, z_min_ft: 324, z_max_ft: 324 },
    proposed: { name: "proposed", n_contours: 1, n_spots: 0,
                distinct_elevations: 1, z_min_ft: 826, z_max_ft: 826 },
    ranges_overlap: false, range_gap_ft: 502,
  },
};
{
  const r = run(DETAIL);
  const txt = r.els.ewResult.textContent;
  check(!/\[object Object\]/.test(txt),
    "the object detail is never stringified into the panel");
  check(/No volume published/.test(txt), "it leads with the abstain");
  check(/only ONE elevation \(324 ft\)/.test(txt),
    "it carries the server's own sentence verbatim");
  check(r.els.ewResult.classList.contains("ew-refused"),
    "the result block is marked .ew-refused");
  const html = r.els.ewResult.children.map(c => c.innerHTML || "").join(" ");
  check(/<b>existing<\/b>/.test(html) && /<b>proposed<\/b>/.test(html),
    "BOTH surfaces are named, not only the one that tripped the guard");
  check(/324/.test(html) && /826/.test(html),
    "...with what each one actually held");
  eq(r.said.length, 1, "the status bar says it once");
  eq((r.said[0] || {}).cls, "err", "...as an error");
}

// ---------------------------------------------------------------------------
console.log("2. nothing from the previous calculation survives");
// ---------------------------------------------------------------------------
{
  const r = run(DETAIL, { added: true });
  eq(r.state.ew.result, null, "state.ew.result is cleared");
  eq(r.state.ew.added, false, "the takeoff consent is withdrawn");
  eq(r.els.ewLayerOut.innerHTML, "", "the per-layer slabs are cleared");
  check(r.calls.includes("renderEwBasis:null"),
    "the basis block is re-rendered with no result");
  check(r.calls.includes("renderEwBalance:null"),
    "the material balance is re-rendered with no result");
  check(r.calls.includes("renderItemized"), "the itemised takeoff re-renders");
  eq(r.state.extraItems.length, 1,
    "the earthwork lines are OUT of the priced takeoff");
  eq(r.state.extraItems[0].label, "Concrete",
    "...and nothing else was touched");
  check(/removed from the takeoff/.test(r.els.ewResult.textContent),
    "and the removal is stated, not silent");
}
{
  const r = run(DETAIL, { added: false });
  check(!/removed from the takeoff/.test(r.els.ewResult.textContent),
    "nothing is claimed removed when nothing had been added");
}

// ---------------------------------------------------------------------------
console.log("3. a plain-string 400 still renders (the route's other errors)");
// ---------------------------------------------------------------------------
{
  const r = run("no scale on this page - type one into the scale box");
  check(/no scale on this page/.test(r.els.ewResult.textContent),
    "a string detail is shown as-is");
  check(/No volume published/.test(r.els.ewResult.textContent),
    "...under the same headline");
}
{
  const r = run(undefined);
  check(/failed \(400\)/.test(r.els.ewResult.textContent),
    "a body with no detail at all still says something");
}

// ---------------------------------------------------------------------------
console.log("4. the caller hands the object over, and clears the class again");
// ---------------------------------------------------------------------------
const calc = SRC.slice(SRC.indexOf('$("ewCalc").onclick'),
                       SRC.indexOf("// AN ABSTAIN MUST LEAVE NOTHING BEHIND"));
check(/ewRefused\(e\.detail, r\.status\)/.test(calc),
  "the !r.ok branch calls ewRefused with the whole detail");
check(!/\$\("ewResult"\)\.textContent = e\.detail/.test(calc),
  "the old one-line handler is gone");
check(/classList\.remove\("ew-refused"\)/.test(calc),
  "a successful Calculate takes the refusal styling back off");

// ---------------------------------------------------------------------------
console.log("5. suggestions_dropped finally reaches a screen");
// ---------------------------------------------------------------------------
check(/id="ewDropped"/.test(HTML), "index.html has the #ewDropped slot");
check(/\.ew-dropped\s*\{/.test(CSS), "style.css styles it");
const HAS_DROP = /function renderEwDropped\(/.test(SRC);
check(HAS_DROP, "webui/app.js has a renderEwDropped() at all");
const drop = HAS_DROP ? fnSrc("renderEwDropped")
  : "function renderEwDropped() { /* 4010783: no screen renders suggestions_dropped */ }";
check(/state\.ew && state\.ew\.dropped/.test(drop),
  "renderEwDropped reads the count off the panel state");
check(/lad\.verdict\.why/.test(drop),
  "...and prints the ladder verdict's own sentence when that is the reason");
check(/renderEwDropped\(\);/.test(fnSrc("renderEw")),
  "renderEw calls it, so it repaints with the rows");
check(/dropped: j\.suggestions_dropped \|\| 0/.test(SRC),
  "the suggest payload's count is stored on state.ew");
check(/ladder: j\.ocr_ladder \|\| null/.test(SRC),
  "so is the ladder verdict");

{
  // executed, on the live shape the route returns for the crafted P2 body
  const els = { ewDropped: mkEl("ewDropped") };
  const state = { ew: { dropped: 3, ladder: {
    applied: true, dropped: 3, kept: 0,
    verdict: { laddered: false, testable: true, interval_ft: 116,
               repeats: 1, n_gaps: 2, share: 0.5,
               why: "these 3 elevations do not step like contours: the "
                  + "commonest gap between adjacent values is 116 ft and it "
                  + "occurs 1 time in 2 (50%)." } } } };
  new Function("$", "state", "esc", drop + "\nreturn renderEwDropped;")(
    (id) => els[id], state, (s) => String(s))();
  const box = els.ewDropped;
  check(box.hidden === false, "3 dropped rows: the block is shown");
  check(/3 candidate rows/.test(box.innerHTML),
    "it says how many were read and thrown away");
  check(/do not step like contours/.test(box.innerHTML),
    "it says WHY, in the reader's own words");
  check(/Add contour/.test(box.innerHTML),
    "and how to disagree with it");
}
{
  const els = { ewDropped: mkEl("ewDropped") };
  new Function("$", "state", "esc", drop + "\nreturn renderEwDropped;")(
    (id) => els[id], { ew: { dropped: 0, ladder: null } }, (s) => String(s))();
  check(els.ewDropped.hidden === true,
    "nothing dropped: the block stays out of the way");
}

console.log(fails ? "\n" + fails + " FAILED" : "\nall checks passed");
process.exit(fails ? 1 : 0);
