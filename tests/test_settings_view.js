// The PRICING SETTINGS page's pure book/CSV logic, pinned.
//
// Only the block between the SETTINGS-PURE markers is evaluated (app.js is
// not a module and touches the DOM at load) - same technique as
// test_projects_view.js. Structure checks at the bottom pin the view's
// contract with index.html: the view exists inside <main>, the brand block
// carries the Pricing link, the CSS toggle hides the same three workbench
// columns the projects view does, and the key swallow includes Ctrl+Z/Y.
//
// Dependency-free:  node tests/test_settings_view.js

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

const a = appSrc.indexOf("// SETTINGS-PURE-BEGIN");
const b = appSrc.indexOf("// SETTINGS-PURE-END");
check(a >= 0 && b > a, "SETTINGS-PURE markers present in webui/app.js");
const S = new Function(appSrc.slice(a, b) +
  " return { svBookRows, svSplitCsvLine, svCsvField, svSerializeCSV,"
  + " svParseCSV, svImportPlan, svPreviewLine };")();

// ---- the book: stored keys merged with the live takeoff --------------------
{
  const rows = S.svBookRows(
    ["Silt Fence", "Water Main"],                       // stored prices
    [{ label: "Silt Fence", unit: "ft" },               // live rows
     { label: "Curb", unit: "ft" },
     { label: "Manholes", unit: "EA" }]);
  check(rows.length === 4, "book: stored + live dedupes to the union");
  const byLab = Object.fromEntries(rows.map(r => [r.label, r]));
  check(byLab["Silt Fence"].inUse && byLab["Silt Fence"].stored,
    "book: a label both stored and on the sheet carries both flags");
  check(byLab["Silt Fence"].unit === "ft",
    "book: the unit comes from the live row when known");
  check(byLab["Water Main"].inUse === false
    && byLab["Water Main"].stored === true
    && byLab["Water Main"].unit === "",
    "book: stored-only label has no unit and is not in use");
  check(byLab["Curb"].stored === false && byLab["Curb"].inUse === true,
    "book: live unpriced label is in-use, not stored");
  check(rows.map(r => r.label).join("|") === "Curb|Manholes|Silt Fence|Water Main",
    "book: rows sort case-insensitively by label");
}
{
  const rows = S.svBookRows(["b"], [{ label: "A", unit: "ft" },
                                    { label: "A", unit: "" }]);
  check(rows.length === 2 && rows[0].label === "A" && rows[0].unit === "ft",
    "book: duplicate live labels collapse and keep the known unit");
  check(S.svBookRows([], []).length === 0, "book: empty in, empty out");
}

// ---- CSV round trip ---------------------------------------------------------
{
  const rows = [
    { label: "Silt Fence", unit: "ft", price: 4.5 },
    { label: 'Pipe, 12" RCP', unit: "ft", price: 62 },  // comma AND quote
    { label: "Manholes", unit: "EA", price: 5200 },
  ];
  const csv = S.svSerializeCSV(rows);
  check(csv.startsWith("label,unit,price\n"), "csv: header row present");
  const back = S.svParseCSV(csv);
  check(back.bad.length === 0, "csv: round trip has no unparseable lines");
  check(back.rows.length === 3
    && back.rows[1].label === 'Pipe, 12" RCP'
    && back.rows[1].price === 62
    && back.rows[0].unit === "ft",
    "csv: labels with commas and quotes survive the round trip");
}

// ---- CSV parse: forgiving where safe, listed where not ----------------------
{
  // Excel quotes a currency cell ("$1,250.50"); the parser strips $ and the
  // thousands separators. Unquoted it would honestly be four fields.
  const r = S.svParseCSV('label,unit,price\nCurb,ft,"$1,250.50"\nGrate,EA,80\n');
  check(r.rows.length === 2 && r.rows[0].price === 1250.5,
    "csv: quoted $ and thousands separators in the price are accepted");
}
{
  const r = S.svParseCSV("Curb,12.5\n");
  check(r.rows.length === 1 && r.rows[0].label === "Curb"
    && r.rows[0].unit === "" && r.rows[0].price === 12.5,
    "csv: two-field label,price rows are accepted with a blank unit");
}
{
  const text = [
    "label,unit,price",
    "Good Row,ft,10",
    "No Price Here,ft,abc",       // bad price
    ",ft,5",                      // empty label
    "Too,many,fields,here,9",     // wrong field count
    '"Unclosed quote,ft,2',       // unclosed quote
    "Zero,ft,0",                  // not > 0
  ].join("\n");
  const r = S.svParseCSV(text);
  check(r.rows.length === 1 && r.rows[0].label === "Good Row",
    "csv: only the good row parses");
  check(r.bad.length === 5, "csv: every bad line is listed, none dropped");
  check(r.bad.every(x => x.line >= 3 && x.text && x.reason),
    "csv: bad lines carry 1-based line number, text and reason");
  check(r.bad.some(x => x.reason === "unclosed quote"),
    "csv: an unclosed quote is named, not guessed at");
}
{
  const r = S.svParseCSV("");
  check(r.rows.length === 0 && r.bad.length === 0, "csv: empty text is empty");
}

// ---- dry-run plan ------------------------------------------------------------
{
  const plan = S.svImportPlan(
    [{ label: "A", unit: "", price: 1 },
     { label: "B", unit: "", price: 2 },
     { label: "B", unit: "", price: 3 },   // duplicate: last one wins, once
     { label: "C", unit: "", price: 4 }],
    ["B", "Z"]);
  check(plan.adds.length === 2 && plan.overwrites.length === 1,
    "plan: new vs overwrite counted against the stored labels");
  check(plan.overwrites[0].price === 3,
    "plan: duplicate labels in the file collapse to the last occurrence");
}
check(S.svPreviewLine(12, 3, 2) === "12 new, 3 overwrite, 2 unparseable — shown below",
  "plan: the preview line says it shows the unparseable lines");
check(S.svPreviewLine(12, 3, 0) === "12 new, 3 overwrite, 0 unparseable",
  "plan: nothing unparseable, nothing promised");

// ---- structure -----------------------------------------------------------
check(/<main>[\s\S]*id="settingsView"/.test(htmlSrc),
  "#settingsView lives inside <main>");
const brand = htmlSrc.slice(htmlSrc.indexOf('class="brand"'),
                            htmlSrc.indexOf("</div>", htmlSrc.indexOf('class="brand"')));
check(brand.includes('id="settingsLink"'),
  "the Pricing link rides the brand block");
check(brand.includes('id="projectsLink"'),
  "…next to the Projects link that was already there");
check(!htmlSrc.slice(htmlSrc.indexOf('id="toolsMenu"'),
                     htmlSrc.indexOf("</div>", htmlSrc.indexOf('id="toolsMenu"')))
  .includes("settingsLink"),
  "no settings row inside the Tools dropdown (tools are sheet tools)");
check(cssSrc.includes("main.sv-open #pageStrip")
  && cssSrc.includes("main.sv-open #sidebar")
  && cssSrc.includes("main.sv-open #stage"),
  "the CSS toggle hides exactly the three workbench columns");
for (const id of ["svBack", "svBookNote", "svBookTable", "svAddLabel",
                  "svAddPrice", "svAddBtn", "svMatBox", "svExportBtn",
                  "svImportBtn", "svImportFile", "svImportPreview", "svFoot"]) {
  check(htmlSrc.includes(`id="${id}"`), `#${id} exists in index.html`);
}

// the swallow block: the projects view's list, Ctrl+Z/Y included
const sv = appSrc.slice(appSrc.indexOf("SV_SWALLOW_KEYS"),
                        appSrc.indexOf("end PRICING SETTINGS"));
check(sv.includes('"Delete"') && sv.includes('"Backspace"'),
  "swallow: Delete and Backspace are swallowed while Settings is up");
check(/e\.key\.toLowerCase\(\) === "z"/.test(sv)
  && /e\.key\.toLowerCase\(\) === "y"/.test(sv),
  "swallow: Ctrl+Z and Ctrl+Y never reach the hidden sheet");
check(sv.includes('e.key === "Escape"'),
  "swallow: Esc is handled (back to the sheet, or to Projects)");

// the settings page writes through the SAME key scheme the itemized panel
// uses - priceKey - and never invents a second one
const svAll = appSrc.slice(appSrc.indexOf("PRICING SETTINGS: the price book page"));
check(svAll.includes("priceKey(") && !/"price:"\s*\+/.test(svAll),
  "store: settings goes through priceKey(), no hand-built price: keys");
// persistence honesty: the footer says where prices actually live
check(appSrc.includes("Prices live in this browser"),
  "footer: names the browser as where prices live");
// the two views are exclusive, both ways
check(/if \(on && svIsOpen\(\)\) svHide\(\);/.test(appSrc),
  "exclusive: opening Projects closes Settings");
check(/if \(on && pvIsOpen\(\)\) showProjects\(false\);/.test(appSrc),
  "exclusive: opening Settings closes Projects");

if (failures) { console.error(`\n${failures} FAILURE(S)`); process.exit(1); }
console.log("\nall settings view checks passed");
