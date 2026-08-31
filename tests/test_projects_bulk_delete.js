// MULTI-SELECT + BULK DELETE on the Projects page: the selection model and
// the confirm's aggregate arithmetic, pinned.
//
// Only the block between the PROJECTS-PURE markers is evaluated (app.js is
// not a module and touches the DOM at load) - same technique as
// test_projects_view.js. `LF` is declared at the top of app.js, outside the
// block, so it is supplied here.
//
// The load-bearing assertion in this file is CONFIRM PARITY: called with one
// row, pvBulkConfirm returns the EXACT sentence the ⋯ menu has always shown,
// character for character against a literal copy of it. That is what makes
// "one deletion vocabulary, not two" a fact rather than an intention - if
// anyone reflows the single-delete wording without reflowing the aggregate,
// this fails.
//
// Dependency-free:  node tests/test_projects_bulk_delete.js

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
function eq(got, want, msg) {
  if (got !== want) {
    failures++;
    console.error("FAIL:", msg);
    console.error("   want: " + JSON.stringify(want));
    console.error("   got : " + JSON.stringify(got));
  } else console.log("ok:", msg);
}

const a = appSrc.indexOf("// PROJECTS-PURE-BEGIN");
const b = appSrc.indexOf("// PROJECTS-PURE-END");
check(a >= 0 && b > a, "PROJECTS-PURE markers present in webui/app.js");
const P = new Function(
  "const LF = String.fromCharCode(10);\n" + appSrc.slice(a, b)
  + " return { pvSelectable, pvSelToggle, pvSelRange, pvSelResolve,"
  + " pvSelPrune, pvSelSplit, pvBulkStats, pvBulkScopeLine, pvBulkConfirm,"
  + " pvBulkReport, pvDupeNotes, PV_CONFIRM_NAMES };")();

// ---- fixtures -------------------------------------------------------------
// Shaped like /api/projects rows: the fields a card and a confirm read.
const row = (id, over) => Object.assign({
  job_id: id, name: id + ".pdf", pages: 10, detected: 4, approved: 0,
  when: 1_700_000_000, demo: false, deletable: true,
}, over || {});

const MINE = [
  row("a", { name: "Oncor Cloudcrest Substation Civils - 20251212.pdf",
             pages: 12, detected: 12, approved: 3, when: 1_700_000_900 }),
  row("b", { name: "Oncor Cloudcrest Substation Civils - 20251212.pdf",
             pages: 12, detected: 0, approved: 0, when: 1_700_000_800 }),
  row("c", { name: "Belle Farms Structural.pdf", pages: 48, detected: 6,
             approved: 1 }),
  row("d", { name: "GCHC stair set.pdf", pages: 4, detected: 4 }),
  // not this account's to delete: registered before logins were switched on
  row("e", { name: "Someone else.pdf", pages: 6, detected: 2,
             deletable: false }),
];
const DEMO = row("z", { name: "Demo plan.pdf", demo: true, deletable: false });

// ---- what may be PICKED vs what may be DELETED ---------------------------
// The two eligibilities are different questions and the whole design turns on
// not conflating them.
check(P.pvSelectable(MINE[0]), "selectable: an ordinary own row");
check(P.pvSelectable(MINE[4]),
  "selectable: a row the account may NOT delete is still selectable — it is "
  + "excluded at the action and counted, not hidden from the gesture");
check(!P.pvSelectable(DEMO), "selectable: a demo row never is");
check(!P.pvSelectable(null) && !P.pvSelectable({}),
  "selectable: null / a row with no job_id are not");

// ---- Ctrl/Cmd+click toggle ------------------------------------------------
{
  const s = new Set();
  eq(P.pvSelToggle(s, MINE[0]), "added", "toggle: first click adds");
  eq(s.size, 1, "toggle: set holds one");
  eq(P.pvSelToggle(s, MINE[0]), "removed", "toggle: second click removes");
  eq(s.size, 0, "toggle: set is empty again");
  eq(P.pvSelToggle(s, DEMO), "blocked", "toggle: a demo row is blocked");
  eq(s.size, 0, "toggle: a blocked row is NOT added");
}

// ---- Shift+click range ----------------------------------------------------
{
  const s = new Set();
  const r = P.pvSelRange(s, MINE, "a", "c");
  eq(r.added, 3, "range: a..c adds three");
  eq(r.spanned, 3, "range: spans three cards");
  check(s.has("a") && s.has("b") && s.has("c"), "range: the right three");
  check(!s.has("d") && !s.has("e"), "range: nothing outside the run");
}
{
  const s = new Set();
  const r = P.pvSelRange(s, MINE, "c", "a");
  eq(r.added, 3, "range: works backwards (anchor after target)");
}
{
  // range only ever ADDS - it must not clear rows off the top of a grid the
  // operator cannot see the end of
  const s = new Set(["a", "b"]);
  const r = P.pvSelRange(s, MINE, "a", "c");
  eq(r.added, 1, "range: only the not-yet-selected are counted as added");
  eq(s.size, 3, "range: never removes an already-selected row");
}
{
  const s = new Set();
  const withDemo = [MINE[0], DEMO, MINE[1]];
  const r = P.pvSelRange(s, withDemo, "a", "b");
  eq(r.spanned, 3, "range: a demo inside the span is spanned");
  eq(r.blocked, 1, "range: ...and reported as blocked, not silently swallowed");
  eq(r.added, 2, "range: ...and only the two selectable rows are added");
  check(!s.has("z"), "range: the demo row is not in the set");
}
{
  const s = new Set();
  const r = P.pvSelRange(s, MINE, "nope", "c");
  eq(r.spanned, 0, "range: a missing anchor spans nothing");
  eq(s.size, 0, "range: ...and changes nothing");
}

// ---- resolve / prune ------------------------------------------------------
{
  const s = new Set(["c", "a"]);
  const got = P.pvSelResolve(s, MINE).map(r => r.job_id);
  eq(got.join(","), "a,c",
    "resolve: DISPLAY order, not Set-insertion order — a bulk action must "
    + "walk the grid deterministically");
}
{
  const s = new Set(["a", "gone"]);
  const got = P.pvSelPrune(s, MINE);
  eq(got.size, 1, "prune: an id with no row left is dropped");
  check(got.has("a") && !got.has("gone"), "prune: keeps the live one");
  eq(s.size, 2, "prune: returns a new Set, does not mutate the old one");
}
eq(P.pvSelResolve(new Set(["gone"]), MINE).length, 0,
  "resolve: a deleted row simply stops resolving — nothing stale is acted on");

// ---- the deletable rule ---------------------------------------------------
{
  const picked = P.pvSelResolve(new Set(["a", "c", "e"]), MINE);
  const { go, blocked } = P.pvSelSplit(picked);
  eq(go.length, 2, "split: two of the three are deletable");
  eq(blocked.length, 1, "split: the third is held back");
  eq(blocked[0].job_id, "e", "split: the right one is held back");
}

// ---- the confirm's aggregate arithmetic -----------------------------------
{
  const s = P.pvBulkStats(P.pvSelResolve(new Set(["a", "b", "c"]), MINE));
  eq(s.projects, 3, "stats: project count");
  eq(s.pages, 72, "stats: pages summed (12 + 12 + 48)");
  eq(s.detected, 18, "stats: detected summed (12 + 0 + 6)");
  eq(s.approved, 4, "stats: approved exports summed (3 + 0 + 1)");
  eq(s.names[0], MINE[0].name, "stats: names are in display order");
}
{
  // a stale extra result can push detected past pages; the confirm must not
  // print "14 of 12 page(s) already detected"
  const s = P.pvBulkStats([row("x", { pages: 12, detected: 14 })]);
  eq(s.detected, 12, "stats: detected is clamped to the page count it is "
    + "quoted against");
}
eq(P.pvBulkStats([]).pages, 0, "stats: an empty selection sums to zero");

// ---- CONFIRM PARITY: one row must read exactly as it always has ----------
{
  const r = MINE[2];   // Belle Farms Structural.pdf, 6 of 48, 1 approved
  // a LITERAL copy of the sentence pvRemove shipped before this change
  const shipped =
    "Remove \"" + r.name + "\" from this server?\n\n"
    + "This permanently deletes the uploaded PDF and everything detected from "
    + "it — " + r.detected + " of " + r.pages + " page(s) already "
    + "detected, plus any approved exports and report for it.\n\n"
    + "This cannot be undone.";
  eq(P.pvBulkConfirm([r], []), shipped,
    "CONFIRM PARITY: pvBulkConfirm([row], []) is character-for-character the "
    + "single-delete sentence — one deletion vocabulary, not two");
}
eq(P.pvBulkConfirm([], []), "",
  "confirm: nothing to delete produces no dialog text");

// ---- the aggregate confirm ------------------------------------------------
{
  const picked = P.pvSelResolve(new Set(["a", "b", "c", "e"]), MINE);
  const { go, blocked } = P.pvSelSplit(picked);
  const t = P.pvBulkConfirm(go, blocked);
  check(t.startsWith("Remove 3 projects from this server?"),
    "confirm: counts the projects it will actually delete, not the selection");
  check(t.includes("18 of 72 page(s) already detected"),
    "confirm: states the aggregate detected/pages, in the single delete's "
    + "own words");
  check(t.includes("(4 approved page(s))"),
    "confirm: states how many approved exports are about to go");
  check(t.includes("• " + MINE[0].name),
    "confirm: names the files so a mistake is recognisable before it is made");
  check(t.includes("1 selected project is not yours to delete"),
    "confirm: SAYS the excluded count rather than silently dropping it");
  check(t.includes("it stays on this server, untouched"),
    "confirm: ...and says what happens to it");
  check(t.trimEnd().endsWith("This cannot be undone."),
    "confirm: closes on the single delete's own final line");
}
{
  // more names than the cap: the rest are counted, never dropped in silence
  const many = [];
  for (let i = 0; i < 9; i++) many.push(row("m" + i, { name: "plan" + i }));
  const t = P.pvBulkConfirm(many, []);
  eq((t.match(/•/g) || []).length, P.PV_CONFIRM_NAMES,
    "confirm: prints PV_CONFIRM_NAMES names");
  check(t.includes("…and " + (9 - P.PV_CONFIRM_NAMES) + " more."),
    "confirm: and counts the rest instead of hiding them");
}
{
  const t = P.pvBulkConfirm(P.pvSelResolve(new Set(["b", "d"]), MINE), []);
  check(!t.includes("approved page(s)"),
    "confirm: stays silent about approved exports when there are none");
}

// ---- UNDO MUST NOT BE IMPLIED --------------------------------------------
// This is a server-side permanent deletion. Every confirm this builder can
// produce has to say so and must never hint at a way back.
{
  const cases = [
    P.pvBulkConfirm([MINE[0]], []),
    P.pvBulkConfirm(P.pvSelSplit(MINE).go, P.pvSelSplit(MINE).blocked),
  ];
  for (let i = 0; i < cases.length; i++) {
    check(cases[i].includes("This cannot be undone."),
      "no-undo: case " + i + " states it cannot be undone");
    check(!/Ctrl\+Z|undo (it|them|this)|restore|recover|trash|bin/i
            .test(cases[i]),
      "no-undo: case " + i + " offers no way back");
  }
}

// ---- PARTIAL FAILURE IS THE NORMAL CASE ----------------------------------
{
  const t = P.pvBulkReport([
    { name: "a", ok: true }, { name: "b", ok: true }, { name: "c", ok: true },
  ], 0);
  eq(t, "removed 3 projects — permanently", "report: all succeeded");
}
eq(P.pvBulkReport([{ name: "a", ok: true }], 0),
  "removed 1 project — permanently", "report: one succeeded, singular");
{
  const t = P.pvBulkReport([
    { name: "a", ok: true },
    { name: "b", ok: false, why: "unknown job" },
    { name: "c", ok: false, why: "unknown job" },
    { name: "d", ok: false, why: "the server did not answer" },
  ], 3);
  check(t.startsWith("removed 1 of 4 — 3 failed"),
    "report: says how many actually went and how many did not");
  check(t.includes("2 × unknown job"),
    "report: groups repeated reasons with a count");
  check(t.includes("the server did not answer"),
    "report: names every distinct reason");
  check(t.includes("the 3 still selected can be retried in one click"),
    "report: offers the retry when the rows really are still selected");
  check(!/^removed 4/.test(t),
    "report: NEVER reports success for a request that errored");
}
// THE HONESTY RULE THIS SIGNATURE EXISTS FOR. Measured live on 2026-09-01:
// a row that fails with "unknown job" is a row the server no longer has, so
// the refetch prunes it out of the selection and there is nothing left to
// retry. The report is written AFTER that prune and must not promise one.
{
  const t = P.pvBulkReport([
    { name: "a", ok: true },
    { name: "b", ok: false, why: "unknown job" },
  ], 0);
  check(!/still selected|retried/.test(t),
    "report: with nothing left selected it offers NO retry");
  check(t.includes("no longer in the list, so there is nothing here to retry"),
    "report: ...and says why instead of going quiet");
  check(t.startsWith("removed 1 of 2 — 1 failed (unknown job)"),
    "report: the counts are unaffected by the retry clause");
}
{
  const t = P.pvBulkReport([
    { name: "a", ok: false, why: "HTTP 403" },
    { name: "b", ok: false, why: "HTTP 403" },
  ], 2);
  check(t.startsWith("removed none of 2 —"),
    "report: an all-failed run says removed NONE, not 'removed'");
}
{
  const t = P.pvBulkReport([{ name: "a", ok: false }], 1);
  check(t.includes("no reason given"),
    "report: a failure with no detail still reports as a failure");
  check(t.includes("the one still selected can be retried in one click"),
    "report: singular failure reads correctly");
}
eq(P.pvBulkReport([], 0), "nothing to remove", "report: an empty run says so");

// ---- the bar's readout ----------------------------------------------------
{
  const s = P.pvBulkStats(P.pvSelResolve(new Set(["a", "c"]), MINE));
  eq(P.pvBulkScopeLine(s, 0), "2 projects · 60 pages · 18 detected · 4 approved",
    "scope line: what is selected");
  check(P.pvBulkScopeLine(s, 2).endsWith("· 2 not yours to delete"),
    "scope line: the excluded count is on the bar, not only in the confirm");
  eq(P.pvBulkScopeLine(P.pvBulkStats([row("q", { pages: 1, detected: 0 })]), 0),
    "1 project · 1 page · 0 detected", "scope line: singulars");
}

// ---- duplicate spotting: evidence, never a decision ----------------------
{
  const notes = P.pvDupeNotes(MINE);
  eq(notes.size, 2, "dupes: only the two Oncor rows are in a group");
  eq(notes.get("a"), "1 of 2 with this name and page count",
    "dupes: newest is 1 of N, so the liveliest copy is the obvious keeper");
  eq(notes.get("b"), "2 of 2 with this name and page count", "dupes: the older");
  check(!notes.has("c") && !notes.has("d"),
    "dupes: a name held once carries no note");
}
{
  // same name, DIFFERENT page count = a different revision, not a duplicate
  const notes = P.pvDupeNotes([
    row("p", { name: "Same.pdf", pages: 10 }),
    row("q", { name: "Same.pdf", pages: 11 }),
  ]);
  eq(notes.size, 0,
    "dupes: same name but a different page count is NOT called a duplicate");
}
check(!P.pvDupeNotes([DEMO, Object.assign({}, DEMO, { job_id: "z2" })]).size,
  "dupes: demo rows are never grouped — nothing there is bulk-deletable");

// ---- structure: the wiring this pure block is useless without ------------
const between = (src, from, to) => {
  const i = src.indexOf(from);
  const j = i < 0 ? -1 : src.indexOf(to, i);
  return i < 0 || j < 0 ? "" : src.slice(i, j);
};

check(/id="pvSelBar"/.test(htmlSrc),
  "markup: #pvSelBar exists for the selection bar");
check(htmlSrc.indexOf("id=\"pvSelBar\"") < htmlSrc.indexOf("id=\"pvGrid\""),
  "markup: the bar is ABOVE the grid, in the flow — it never covers a card");
check(/\.pv-card\.pv-picked/.test(cssSrc),
  "style: a picked card has a rule of its own");
check(/\.pv-selbar/.test(cssSrc), "style: the bar has a rule of its own");
check(!/\.pv-picked[^{]*\{[^}]*#[0-9a-fA-F]{3}/.test(cssSrc),
  "style: the selection styles use var(--t-*) tokens, not raw hex");

// pvCard must tag ONLY a selectable row, because the presence of data-job is
// what makes the demo tab unselectable no matter what the tab split does.
check(/if \(pvSelectable\(r\)\) card\.dataset\.job = r\.job_id;/.test(appSrc),
  "wiring: pvCard tags a card with data-job only when pvSelectable(r)");
// the single-delete path must go through the shared builder, or parity above
// is testing a function nothing calls
check(/if \(!confirm\(pvBulkConfirm\(\[r\], \[\]\)\)\) return;/.test(appSrc),
  "wiring: pvRemove asks with pvBulkConfirm — one confirm builder");
check(/pvSelSync\(\);/.test(between(appSrc, "function pvPaint()", "\nfunction pvSyncTabs")),
  "wiring: pvPaint re-syncs the selection layer after it repaints the grid");

// THE BULK PATH MUST NOT TOUCH UNDO. Server-side deletion has no captureUndo
// behind it and must not acquire one by copy-paste.
const bulk = between(appSrc, "async function pvBulkDelete()",
                     "// =============== end MULTI-SELECT");
check(bulk.length > 0, "wiring: pvBulkDelete is present");
check(!/captureUndo|pushUndo|state\.undo/.test(bulk),
  "no-undo: the bulk delete records no undo entry");
check(/pvDeleteOne\(r\)/.test(bulk),
  "wiring: the bulk loop reuses pvDeleteOne — one deletion path, not two");
check(/pvSel = failed;/.test(bulk),
  "wiring: failures stay selected so a retry is one click");
check(/pvBulkReport\(results, canRetry\)/.test(bulk),
  "wiring: the outcome is built from the RESULTS, never from the intent");
// the retry count is measured over rows that were ATTEMPTED and FAILED, not
// over the whole surviving selection - the blocked rows stay selected but
// retrying one just fails again, so counting them would overstate the offer
check(/retryable\.add\(r\.job_id\)/.test(bulk)
      && /for \(const id of retryable\) if \(pvSel\.has\(id\)\) canRetry\+\+;/
           .test(bulk),
  "wiring: the retry count counts attempted-and-failed rows only, not the "
  + "not-yours-to-delete rows that also stay selected");
// the report has to be written after the refetch has pruned the set, or the
// retry it offers can already be gone
check(bulk.indexOf("await loadProjects()")
        < bulk.indexOf("pvBulkReport(results, canRetry)"),
  "wiring: the refetch is awaited BEFORE the outcome sentence is written");

console.log(failures ? "\n" + failures + " FAILURE(S)" : "\nall green");
process.exit(failures ? 1 : 0);
