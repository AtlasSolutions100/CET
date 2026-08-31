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
  " return { projMetaLine, projAgo, projShowsSharedBadge, projCountLine };")();

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
for (const id of ["pvGrid", "pvEmpty", "pvBack", "pvCount"]) {
  check(htmlSrc.includes(`id="${id}"`), `#${id} exists in index.html`);
}
// the empty state's promised wording is in the renderer
check(appSrc.includes("No plans yet — drop a PDF anywhere or use Upload."),
  "empty state wording present");
// opening a card goes through the same reopen route the recents select uses
check(appSrc.includes("/api/job/${r.job_id}/open"),
  "cards open through the recents' own /open route");

if (failures) { console.error(`\n${failures} FAILURE(S)`); process.exit(1); }
console.log("\nall projects view checks passed");
