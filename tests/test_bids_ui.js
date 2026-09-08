// OPEN BIDS - the landing page's third tab (2026-09-07).
//
// Bid Sniper (OptionallyWorking/bid_sniper, :8200) finds open Utah civil
// solicitations with thin fields and holds their plan sets. This tab lists
// them inside the engine and one button - Start takeoff - has the sniper
// fetch the drawings and the engine pull them in as a project of the person
// who clicked. The pure text helpers, the tab plumbing and the card's
// non-negotiables are pinned here; the fetch itself is proved live.
//
// What must stay true, and why:
//   * PROJ_TABS is demo, mine, bids - bids LAST, because the tab is hidden
//     on any box without a sniper and a hidden tab in the middle would leave
//     a hole in the arrow-key cycle.
//   * a bid card is NOT selectable (no data-job) and NOT openable by clicking
//     its body: starting a takeoff downloads a plan set and makes a project,
//     which a stray click on a grid must never do.
//   * the plans line says what Start will have to do BEFORE the press.
//   * the empty tab names the reason - off, not answering, or nothing found.
//   * the project card prints where a pulled plan came from; an upload
//     prints nothing.
//   * index.html carries the tab, hidden by default, and the cache-buster
//     moved so a browser that has app.js?v=160 does not run the old code
//     against the new HTML.
//
// Dependency-free:  node tests/test_bids_ui.js
"use strict";
const fs = require("fs");
const path = require("path");
const SRC = fs.readFileSync(
  path.join(__dirname, "..", "webui", "app.js"), "utf8");
const HTML = fs.readFileSync(
  path.join(__dirname, "..", "webui", "index.html"), "utf8");
const CSS = fs.readFileSync(
  path.join(__dirname, "..", "webui", "style.css"), "utf8");

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

// ---- the pure helpers, evaluated ------------------------------------------
console.log("helpers");
const names = ["projTabNoun", "projReachLine", "bidClosesText", "bidMetaLine",
               "bidPlansLine", "bidCompText", "bidActionText", "bidReachLine",
               "projEmptyBids"];
const bodies = names.map(grab);
check(bodies.every(Boolean), "every helper exists: " + names.join(", "));
const P = new Function(
  "const PROJ_TABS = " + grabConst("PROJ_TABS") + ";\n"
  + bodies.join("\n") + "\nreturn { PROJ_TABS, "
  + names.join(", ") + " };")();

check(P.PROJ_TABS.join(",") === "demo,mine,bids", "PROJ_TABS: demo, mine, bids - bids last");
check(P.projTabNoun("bids").many === "open bids", "the reach line calls them open bids");

const NOW = Date.UTC(2026, 8, 7, 12, 0, 0);          // 2026-09-07 12:00
const iso = (d) => new Date(NOW + d * 86400000).toISOString().replace(/Z$/, "");
check(P.bidClosesText(null, NOW) === "no close date read", "closes: undated says so");
check(/^closes in 5 days \(/.test(P.bidClosesText(iso(5), NOW)), "closes: in 5 days");
check(/^closes today \(/.test(P.bidClosesText(iso(0.2), NOW)), "closes: today");
check(/^closes tomorrow \(/.test(P.bidClosesText(iso(1.2), NOW)), "closes: tomorrow");
check(/^closed /.test(P.bidClosesText(iso(-1), NOW)), "closes: closed");
check(P.bidClosesText("garbage", NOW) === "no close date read", "closes: junk is undated, not NaN");

check(P.bidMetaLine({ agency: "CITIES - Lehi City", due: iso(3) }, NOW).startsWith("Lehi City · closes in 3 days"),
      "meta: the portal's ALL-CAPS category prefix is dropped from the agency");
check(P.bidMetaLine({ agency: null, due: null }, NOW) === "no close date read",
      "meta: no agency means just the date phrase, no stray separator");

check(P.bidPlansLine({ docs_local: 2, docs_listed: 1 }) === "plans on hand · opens at once",
      "plans: on disk = at once");
check(P.bidPlansLine({ docs_local: 0, docs_listed: 1 }).includes("Start downloads them"),
      "plans: on the portal = Start downloads");
check(P.bidPlansLine({ docs_local: 0, docs_listed: 0 }).includes("upload the set yourself"),
      "plans: nothing listed says the operator has to fetch it");

check(P.bidCompText({ competition: null }) === "competitors: none read yet", "competition: none read");
check(P.bidCompText({ competition: 0 }) === "competitors: 0", "competition: zero is a count, not 'none read'");
check(P.bidCompText({ competition: 4 }) === "competitors: 4", "competition: 4");

check(P.bidActionText({ takeoff_job: "abc", job_here: true }) === "Open takeoff", "action: job here = Open");
check(P.bidActionText({ takeoff_job: "abc", job_here: false }) === "Start takeoff",
      "action: a job that is not on this box (or not mine) = Start, not a dead Open");
check(P.bidActionText({}) === "Start takeoff", "action: nothing = Start");

check(P.projEmptyBids({ enabled: false }).includes("BID_SNIPER_URL"), "empty: off names the setting");
check(P.projEmptyBids({ enabled: true, ok: false, url: "http://127.0.0.1:8200", error: "ConnectError: x" })
        .includes("not answering at http://127.0.0.1:8200"), "empty: down names the address");
check(P.projEmptyBids({ enabled: true, ok: false, url: "http://127.0.0.1:8200", error: "ConnectError: x" })
        .includes("(ConnectError: x)"), "empty: down carries the error");
check(P.projEmptyBids({ enabled: true, ok: true }).includes("no open bids"), "empty: nothing found says so");

const reach = P.bidReachLine({ url: "http://127.0.0.1:8200" }, 3, 3, "");
check(reach.includes("from Bid Sniper at http://127.0.0.1:8200"), "reach: says where the rows came from");
check(reach.includes("Start takeoff pulls the plan set"), "reach: says what the button does");

// ---- the card's non-negotiables, from source ------------------------------
console.log("card");
const card = grab("pvBidCard");
check(!!card, "pvBidCard exists");
check(card && !/dataset\.job/.test(card), "a bid card is NOT selectable (no data-job)");
check(card && !/card\.onclick/.test(card), "a bid card body has NO click handler");
check(card && /pvPullBid\(b, go, card\)/.test(card), "the button is what starts the pull");
check(card && /pvOpenJob\(\{ job_id: b\.takeoff_job \}\)/.test(card),
      "...or opens the job already here");
check(card && /target = "_blank"/.test(card) && /rel = "noopener"/.test(card),
      "the portal link opens in a new tab without an opener");
const pull = grab("pvPullBid");
check(!!pull, "pvPullBid exists");
check(pull && /"\/api\/bids\/" \+ encodeURIComponent\(b\.id\) \+ "\/pull"/.test(pull),
      "the pull POSTs to /api/bids/{id}/pull with the id encoded (ids carry colons)");
check(pull && /method: "POST"/.test(pull), "...as a POST");
check(pull && /applyOpened\(j\)/.test(pull), "success goes through the same applyOpened as an upload");
check(pull && /btn\.disabled = false/.test(pull), "failure re-arms the button");
check(pull && /j\.detail/.test(pull), "failure prints the server's own words");

// ---- the project card says where a pulled plan came from --------------------
const pc = grab("pvCard");
check(pc && /r\.bid/.test(pc) && /"from bid: "/.test(pc), "pvCard prints 'from bid:' for a pulled plan");
check(pc && /if \(r\.bid && \(r\.bid\.title \|\| r\.bid\.agency\)\)/.test(pc),
      "...and only when the row carries one (an upload prints nothing)");

// ---- pvPaint routes the third population ------------------------------------
console.log("plumbing");
const paint = grab("pvPaint");
check(paint && /pvTab === "bids" \? bidRows/.test(paint), "pvPaint: bids rows on the bids tab");
check(paint && /pvTab === "bids" \? projFilter\(rows, q\)/.test(paint),
      "pvPaint: bids keep the server's order (no projSort)");
check(paint && /pvBidCard\(b, nowMs\)/.test(paint), "pvPaint: bid cards on the bids tab");
check(paint && /projEmptyBids\(pvBidsInfo\)/.test(paint), "pvPaint: the empty bids tab explains itself");
const load = grab("loadProjects");
check(load && /fetch\("\/api\/bids"\)/.test(load), "loadProjects fetches /api/bids");
check(load && /\$\("pvTabBids"\)\.hidden = !pvBidsInfo\.enabled/.test(load),
      "the tab is hidden unless the server says the feature is on");
const sync = grab("pvSyncTabs");
check(sync && /set\(\$\("pvTabBids"\), pvTab === "bids"\)/.test(sync), "pvSyncTabs lights the bids tab");
check(/const PV_TAB_IDS = \{ demo: "pvTabDemo", mine: "pvTabMine", bids: "pvTabBids" \}/.test(SRC),
      "the tab strip is wired from PROJ_TABS, not two hard-coded ids");
check(/\/\^#job=\(\[0-9a-f\]\{6,32\}\)\$\/\.exec\(BOOT_HASH/.test(SRC),
      "#job=<id> at boot opens that job (what the sniper's dashboard links to)");

// ---- index.html and style.css -----------------------------------------------
console.log("html/css");
check(/id="pvTabBids" class="pv-tab" role="tab" aria-selected="false"[\s\S]{0,80}hidden/.test(HTML),
      "index.html: the bids tab exists and starts hidden");
check(/id="pvTabBidsN" class="pv-tabn"/.test(HTML), "index.html: the bids tab has a live count");
const v = /app\.js\?v=(\d+)/.exec(HTML);
check(v && Number(v[1]) >= 161, "index.html: cache-buster moved past 160 (got " + (v && v[1]) + ")");
check(/\.pv-card\.pv-bid \{ cursor: default; \}/.test(CSS), "style.css: a bid card does not look clickable");
check(/\.pv-bid-note \{/.test(CSS) && /\.pv-bid-act \{/.test(CSS), "style.css: the note and action rows are styled");

console.log(fails ? "\n" + fails + " FAILURE(S)" : "\nall green");
process.exit(fails ? 1 : 0);
