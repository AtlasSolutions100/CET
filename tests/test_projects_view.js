// The MY PROJECTS landing page's pure presentation logic, pinned.
//
// Only the block between the PROJECTS-PURE markers is evaluated (app.js is
// not a module and touches the DOM at load) - same technique as
// test_trench_math.js. Structure checks at the bottom pin the view's
// contract with index.html: the view exists inside <main>, the brand block
// carries the Projects link, and the workbench columns it hides are the
// three the CSS names.
//
// Dependency-free:  node tests/test_projects_view.js

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

const a = appSrc.indexOf("// PROJECTS-PURE-BEGIN");
const b = appSrc.indexOf("// PROJECTS-PURE-END");
check(a >= 0 && b > a, "PROJECTS-PURE markers present in webui/app.js");
const P = new Function(appSrc.slice(a, b) +
  " return { projMetaLine, projAgo, projShowsSharedBadge, projCountLine,"
  + " projMatches, projFilter, projSort, projReachLine, PROJ_SORTS };")();

// ---- the card's meta line -----------------------------------------------
check(P.projMetaLine(12, 5, 0) === "12 pages · 5 detected",
  "meta: partial detection counts");
check(P.projMetaLine(12, 12, 0) === "12 pages · all detected",
  "meta: full detection says so");
check(P.projMetaLine(12, 14, 0) === "12 pages · all detected",
  "meta: over-count (stale extra results) still reads all detected");
check(P.projMetaLine(3, 0, 0) === "3 pages · not detected",
  "meta: zero detection says not detected");
check(P.projMetaLine(1, 1, 0) === "1 page · all detected",
  "meta: singular page");
check(P.projMetaLine(48, 12, 3) === "48 pages · 12 detected · 3 approved",
  "meta: approved pages appear when present");
check(P.projMetaLine(48, 12, 0) === "48 pages · 12 detected",
  "meta: zero approved stays silent");
check(P.projMetaLine(0, 0, 0) === "0 pages · not detected",
  "meta: a zero-page row cannot claim all detected");

// ---- relative time -------------------------------------------------------
const NOW = 1_700_000_000;
check(P.projAgo(NOW, NOW - 30) === "just now", "ago: <90s is just now");
check(P.projAgo(NOW, NOW - 600) === "10 min ago", "ago: minutes");
check(P.projAgo(NOW, NOW - 7200) === "2 h ago", "ago: hours");
check(P.projAgo(NOW, NOW - 86400 * 3) === "3 d ago", "ago: days");
check(/^\d{4}-\d{2}-\d{2}$/.test(P.projAgo(NOW, NOW - 86400 * 90)),
  "ago: old sets show a date, not a huge day count");
check(P.projAgo(NOW, NOW + 500) === "just now",
  "ago: clock skew never shows a negative age");

// ---- shared badge rule -----------------------------------------------------
check(P.projShowsSharedBadge(
  [{ mine: true, shared: false }, { mine: false, shared: true }]) === true,
  "badge: mixed list labels the shared rows");
check(P.projShowsSharedBadge(
  [{ mine: false, shared: true }, { mine: false, shared: true }]) === false,
  "badge: all-shared list (single-password box) shows no labels");
check(P.projShowsSharedBadge(
  [{ mine: true, shared: false }]) === false,
  "badge: all-mine list shows no labels");
check(P.projShowsSharedBadge([]) === false, "badge: empty list");

// ---- count line: the cap is never silent ------------------------------------
check(P.projCountLine(0, 0) === "", "count: empty list says nothing");
check(P.projCountLine(7, 7) === "7", "count: uncapped shows the count");
check(P.projCountLine(200, 320) === "showing 200 of 320",
  "count: a capped list SAYS it is capped");

// ---- search: matching --------------------------------------------------------
{
  const r = { name: "Oncor Cloudcrest Substation Civils - 20251212.pdf" };
  check(P.projMatches(r, "") === true, "search: empty query matches everything");
  check(P.projMatches(r, "   ") === true, "search: blank query matches everything");
  check(P.projMatches(r, "oncor") === true, "search: case-insensitive");
  check(P.projMatches(r, "CLOUDCREST") === true, "search: upper-case query");
  check(P.projMatches(r, "crest") === true, "search: mid-word substring");
  check(P.projMatches(r, "oncor civils") === true,
    "search: every word must appear, order-independent");
  check(P.projMatches(r, "oncor barn") === false,
    "search: one missing word is no match");
  check(P.projMatches({ name: null }, "x") === false,
    "search: a nameless row never matches a real query");
  check(P.projFilter([r, { name: "stice.pdf" }], "stice").length === 1,
    "filter: keeps only matching rows");
  check(P.projFilter(null, "x").length === 0, "filter: no rows in, none out");
}

// ---- sort: every mode is total and deterministic -----------------------------
{
  const rows = [
    { name: "Oncor", when: 100, pages: 9, detected: 2 },
    { name: "belle", when: 300, pages: 3, detected: 2 },
    { name: "Kayden", when: 200, pages: 48, detected: 1 },
  ];
  check(P.projSort(rows, "when").map(r => r.when).join(",") === "300,200,100",
    "sort: last activity is newest first");
  check(P.projSort(rows, "name").map(r => r.name).join(",") === "belle,Kayden,Oncor",
    "sort: name is case-insensitive A-Z");
  check(P.projSort(rows, "pages").map(r => r.pages).join(",") === "48,9,3",
    "sort: pages is most first");
  check(P.projSort(rows, "detected").map(r => r.when).join(",") === "300,100,200",
    "sort: detected ties break on last activity, not input order");
  check(P.projSort(rows, "nonsense").map(r => r.when).join(",") === "300,200,100",
    "sort: an unknown mode falls back to last activity");
  check(P.projSort(rows, "when") !== rows, "sort: returns a copy, never in place");
  check(rows[0].name === "Oncor", "sort: the cached row order is untouched");
  check(P.PROJ_SORTS.length === 4, "sort: four modes offered");
}

// ---- the reach line: the search box may never overstate what it searched -----
// /api/projects replies with out[:200] plus the true total, so whenever
// total > loaded the browser is filtering a subset and MUST say so.
{
  check(P.projReachLine(0, 0, 0, "") === "",
    "reach: an empty server says nothing");
  const un = P.projReachLine(7, 7, 7, "");
  check(un.includes("All 7 plans") && un.includes("reach all of them"),
    "reach: uncapped list claims full reach");
  const cap = P.projReachLine(200, 200, 420, "");
  check(cap.includes("Newest 200 of 420") && cap.includes("not the other 220"),
    "reach: a capped list names the rows search CANNOT reach");
  const capQ = P.projReachLine(3, 200, 420, "onc");
  check(capQ.includes("3 of 200 match")
    && capQ.includes("searched the newest 200 of 420")
    && capQ.includes("may still be on the server"),
    "reach: a query over a capped list says a miss is not proof of absence");
  const unQ = P.projReachLine(1, 7, 7, "onc");
  check(unQ.includes("1 of 7 match") && unQ.includes("searched all 7 plans"),
    "reach: a query over an uncapped list claims full reach");
  check(P.projReachLine(1, 1, 1, "").includes("All 1 plan on this server"),
    "reach: singular plan reads 'plan', not 'plans'");
  check(P.projReachLine(5, 5, 5, "  ") === P.projReachLine(5, 5, 5, ""),
    "reach: a whitespace-only query is not a query");
}

// ---- structure -------------------------------------------------------------
check(/<main>[\s\S]*id="projectsView"/.test(htmlSrc),
  "#projectsView lives inside <main>");
check(htmlSrc.indexOf('id="projectsView"') < htmlSrc.indexOf('id="pageStrip"'),
  "#projectsView sits before the workbench columns");
const brand = htmlSrc.slice(htmlSrc.indexOf('class="brand"'),
                            htmlSrc.indexOf("</div>", htmlSrc.indexOf('class="brand"')));
check(brand.includes('id="projectsLink"'),
  "the Projects link rides the brand block");
check(cssSrc.includes("main.pv-open #pageStrip")
  && cssSrc.includes("main.pv-open #sidebar")
  && cssSrc.includes("main.pv-open #stage"),
  "the CSS toggle hides exactly the three workbench columns");
for (const id of ["pvGrid", "pvEmpty", "pvBack", "pvCount",
                  "pvSearch", "pvSort", "pvReach"]) {
  check(htmlSrc.includes(`id="${id}"`), `#${id} exists in index.html`);
}
// the sort <select> offers exactly the modes PROJ_SORTS knows how to apply -
// an option with no comparator would silently fall back to last activity
for (const m of P.PROJ_SORTS)
  check(htmlSrc.includes(`<option value="${m}"`),
    `#pvSort offers the "${m}" mode`);
check((htmlSrc.match(/<option value="[a-z]+"/g) || []).length
  === P.PROJ_SORTS.length,
  "#pvSort offers no mode PROJ_SORTS cannot sort");
// search and sort are re-renders over the cached rows, never a refetch: a
// fetch on either control would re-hit /api/projects on every keystroke
const paint = appSrc.slice(appSrc.indexOf("function pvPaint()"),
                           appSrc.indexOf("function pvCard("));
check(!paint.includes("fetch("),
  "pvPaint filters the cached rows and never refetches");
check(appSrc.includes('$("pvSearch").addEventListener("input", pvPaint)'),
  "the search box repaints on every keystroke");
check(appSrc.includes('$("pvSort").addEventListener("change", pvPaint)'),
  "the sort control repaints on change");
// delete moved behind the overflow menu, but the confirm flow did not change
check(appSrc.includes("pvCloseMenus(); pvRemove(r);"),
  "the overflow menu's delete still calls pvRemove");
check(appSrc.includes('confirm("Remove \\"" + r.name + "\\" from this server?'),
  "pvRemove keeps #docRemoveBtn's confirm wording");
check(!appSrc.includes('x.className = "pv-x"'),
  "the always-armed card ✕ is gone (delete is behind the ⋯ menu)");
// the empty state's promised wording is in the renderer
check(appSrc.includes("No plans yet — drop a PDF anywhere or use Upload."),
  "empty state wording present");
// opening a card goes through the same reopen route the recents select uses
check(appSrc.includes("/api/job/${r.job_id}/open"),
  "cards open through the recents' own /open route");

if (failures) { console.error(`\n${failures} FAILURE(S)`); process.exit(1); }
console.log("\nall projects view checks passed");
