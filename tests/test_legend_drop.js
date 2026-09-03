// DRAG AND DROP THE LEGEND SHEET.
//
// From the 2026-09-02 screen share. The legend control was a prompt() reading
// "Legend sheet PDF path (blank = search this document):" and the owner's
// business partner could not work out what to put in it: "what do I put here
// to actually tell it it's this page?"
//
// Three things were wrong with it, and all three are the same thing - a
// browser prompt cannot take a FILE:
//
//   * A filesystem path is a thing only the owner, at his own laptop, can
//     supply. On the hosted box server.py's _client_pdf refuses client paths
//     outright (HOSTED), so for everyone else there was no way in at all.
//   * It never said what a legend sheet IS, what reading one does, or - the
//     part the owner cannot check for himself - that it changes no quantity.
//   * "blank = search this document" hid a real action inside an empty field.
//
// What this suite pins:
//   1. the prompt is gone, and the modal says all three of those things;
//   2. drag-and-drop is REAL - dragover is prevented (or the browser navigates
//      away to the PDF), the drop reads files off the DataTransfer, and the
//      zone answers the drag;
//   3. the typed path still works, and "search this document" is its own
//      button;
//   4. BOTH routes end in the same tail, and the server reads both through
//      one scan, so the two can never report a legend differently;
//   5. an empty read replaces nothing - the bug that silently emptied a
//      loaded vocabulary;
//   6. nothing here labels anything or moves a quantity.
//
// Dependency-free:  node tests/test_legend_drop.js

"use strict";
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(
  path.join(__dirname, "..", "webui", "app.js"), "utf8");
const htmlSrc = fs.readFileSync(
  path.join(__dirname, "..", "webui", "index.html"), "utf8");
const cssSrc = fs.readFileSync(
  path.join(__dirname, "..", "webui", "style.css"), "utf8");
const srvSrc = fs.readFileSync(
  path.join(__dirname, "..", "server.py"), "utf8");

let failures = 0;
function check(cond, msg) {
  if (!cond) { failures++; console.error("FAIL:", msg); }
  else console.log("ok:", msg);
}

const A = src.indexOf("// LEGEND-DROP ===");
const B = src.indexOf("// LEGEND-DROP-END");
check(A >= 0 && B > A, "LEGEND-DROP block present in webui/app.js");
if (A < 0 || B <= A) process.exit(1);
const block = src.slice(A, B);
// the bans below are about CODE - the block's own comments quote the prompt
// they replaced, and would trip every one of them
const code = block.replace(/^\s*\/\/.*$/gm, "");

// =========================================================================
// 1. THE PROMPT IS GONE, AND THE CONTROL SAYS WHAT IT WANTS
// =========================================================================
check(!/prompt\("Legend sheet PDF path/.test(src),
  "the prompt() that asked for a filesystem path is gone");
check(!/prompt\(/.test(code), "...and the block does not open one of its own");
check(/\$\("legendBtn"\)\.onclick = legendModalOpen;/.test(src),
  "the Legend sheet tool opens the modal");
check(/id="legendModal"/.test(htmlSrc), "#legendModal exists");
check(/<div class="lg-card" role="dialog" aria-modal="true" aria-labelledby="lgTitle">/
  .test(htmlSrc), "it is a labelled, modal dialog");
{
  const i = htmlSrc.indexOf('id="legendModal"');
  const card = htmlSrc.slice(i, htmlSrc.indexOf("<datalist", i));
  // WHAT IT IS
  check(/names the line types/.test(card),
    "the modal says what a legend sheet is");
  check(/C1\.1 LEGEND &amp; NOTES/.test(card),
    "...with the example sheet name the operator will recognise");
  // WHAT READING ONE DOES
  check(/fills the name box on\s+every style row/.test(card.replace(/\s+/g, " ").replace(/ /g, " ")) ||
        /fills the name box on every style row/.test(card.replace(/\s+/g, " ")),
    "...what reading one actually does");
  // AND WHAT IT DOES NOT DO
  check(/changes no\s+quantity and applies no label by itself/
    .test(card.replace(/\s+/g, " ")) ||
        /changes no quantity and applies no label by itself/
    .test(card.replace(/\s+/g, " ")),
    "...and that it changes no quantity and labels nothing");
  // the drop zone is the primary route and says so in its own words
  check(/Drop a legend PDF here/.test(card), "the drop zone names the gesture");
  check(/choose a file/.test(card), "...and offers the picker behind it");
  check(/one PDF, the sheet with the legend on it/.test(card),
    "...and says exactly which page to give it");
  // the two other routes, each visible rather than hidden in a blank field
  check(/A path on this machine/.test(card), "the typed path is labelled");
  check(/Search this document instead/.test(card),
    "\"blank = search this document\" is now its own button");
}

// =========================================================================
// 2. THE DROP IS REAL
// =========================================================================
check(/for \(const ev of \["dragenter", "dragover"\]\)/.test(block),
  "both dragenter and dragover are handled");
{
  const i = block.indexOf('for (const ev of ["dragenter", "dragover"])');
  const body = block.slice(i, block.indexOf('for (const ev of ["dragleave"', i));
  check(/e\.preventDefault\(\)/.test(body),
    "dragover is prevented - without it the browser navigates away to the PDF");
  check(/dropEffect = "copy"/.test(body), "...and advertises a copy");
  check(/classList\.add\("over"\)/.test(body), "...and the zone answers the drag");
}
{
  const i = block.indexOf('$("lgDrop").addEventListener("drop"');
  const body = block.slice(i, block.indexOf("});", i));
  check(/e\.preventDefault\(\); e\.stopPropagation\(\);/.test(body),
    "the drop is prevented too");
  check(/classList\.remove\("over"\)/.test(body), "...the drag paint is cleared");
  check(/e\.dataTransfer && e\.dataTransfer\.files/.test(body),
    "...and the files come off the DataTransfer");
  check(/if \(!fs\.length\) return legendMsg\("nothing was dropped", "err"\)/.test(body),
    "a drag carrying no file says so instead of failing silently");
  check(/if \(fs\.length > 1\)/.test(body),
    "...and several files says which one it took");
}
check(/for \(const ev of \["dragleave", "dragend"\]\)/.test(block),
  "dragging back out clears the paint");
check(/\.lg-drop\.over \{[^}]*border-color: var\(--t-accent\)/.test(cssSrc),
  "the over state is visible in CSS");
// the picker behind the zone, reachable by mouse AND by keyboard
check(/\$\("lgDrop"\)\.onclick = \(\) => \$\("lgFile"\)\.click\(\);/.test(block),
  "clicking the zone opens the file picker");
check(/e\.key === "Enter" \|\| e\.key === " "/.test(block),
  "...and so does Enter or Space on it");
check(/tabindex="0" role="button"/.test(htmlSrc), "...because the zone is focusable");
check(/\$\("lgFile"\)\.value = "";/.test(block),
  "the input is cleared after a pick, so the SAME file can be chosen twice");
check(/accept="application\/pdf,\.pdf"/.test(htmlSrc), "the picker filters to PDFs");
// a non-PDF is refused in words, before it reaches the server
check(/is not a PDF — a legend sheet has to be a PDF/.test(block),
  "a dropped non-PDF is refused with a sentence, not a parser error");

// =========================================================================
// 3. THE TYPED PATH IS KEPT
// =========================================================================
check(/\$\("lgPathGo"\)\.onclick/.test(block), "the typed path has a Read it button");
check(/\$\("lgPathIn"\)\.onkeydown = \(e\) => \{ if \(e\.key === "Enter"\)/.test(block),
  "...and Enter in the field does the same");
check(/\$\("legendPath"\)\.value = p;/.test(block),
  "...and the path is remembered, as it was before");
check(/\$\("lgSearch"\)\.onclick = \(\) => \{ \$\("legendPath"\)\.value = ""; loadLegendVocab\(""\); \};/
  .test(block), "\"search this document\" calls the same loader with no path");
check(/\$\("lgPathIn"\)\.value = \$\("legendPath"\)\.value/.test(block),
  "reopening the modal shows the path last used");
// Esc closes it, like the other modal in this app
check(/e\.key === "Escape" && !\$\("legendModal"\)\.hidden/.test(block),
  "Esc closes the modal");

// =========================================================================
// 4. ONE TAIL IN THE CLIENT, ONE SCAN IN THE SERVER
// =========================================================================
{
  const i = src.indexOf("async function legendReadFile(file)");
  const body = src.slice(i, src.indexOf("\n}\n", i));
  check(/legend-sheet-upload/.test(body), "the drop route posts to the upload endpoint");
  check(/new FormData\(\)/.test(body) && /fd\.append\("file", file, file\.name\)/.test(body),
    "...as multipart");
  check(/legendApply\(j, file\.name\)/.test(body), "...and ends in legendApply");
}
{
  const i = src.indexOf("async function loadLegendVocab(path)");
  const body = src.slice(i, src.indexOf("\n}\n", i));
  check(/legendApply\(await r\.json\(\), whose\)/.test(body),
    "the typed-path route ends in the SAME legendApply");
  check(/j && j\.detail/.test(body),
    "...and both routes surface the server's own reason on a failure");
}
// server: one scan, two doors
check(/def _legend_names\(src: Path\) -> dict:/.test(srvSrc),
  "server.py has one legend scan, lifted out of the endpoint");
{
  const i = srvSrc.indexOf('@app.post("/api/job/{job_id}/legend-sheet")');
  const body = srvSrc.slice(i, srvSrc.indexOf("@app.post", i + 10));
  check(/return JSONResponse\(_legend_names\(src\)\)/.test(body),
    "the typed-path endpoint calls it");
  check(/_client_pdf\(body\.path\)/.test(body),
    "...and still confines a client path to PLAN_ROOTS");
}
{
  const i = srvSrc.indexOf('@app.post("/api/job/{job_id}/legend-sheet-upload")');
  check(i >= 0, "the upload endpoint exists");
  const body = srvSrc.slice(i, srvSrc.indexOf("@app.get", i));
  check(/out = _legend_names\(dest\)/.test(body), "...and calls the same scan");
  check(/raw\[:5\] != b"%PDF-"/.test(body),
    "...refuses anything that is not a PDF, by its magic bytes");
  check(/if not raw:/.test(body), "...refuses an empty file");
  check(/LEGEND_UPLOAD_MAX/.test(body) && /LEGEND_UPLOAD_MAX = 64 \* 1024 \* 1024/
    .test(srvSrc), "...and caps the size");
  check(/hashlib\.sha256\(raw\)\.hexdigest\(\)\[:12\]/.test(body),
    "named by content, like /api/upload, so the same legend twice is one file");
  check(!/_register\(/.test(body),
    "...and it is NOT registered as a job - a legend is a vocabulary, not a plan");
  check(/out\["source"\] = stem/.test(body),
    "the reply names the operator's own file, not our path on disk");
  check(/JOBS\.get\(job_id\) or _404\(\)/.test(body),
    "...and it is still scoped to a real job");
}

// =========================================================================
// 5. AN EMPTY READ REPLACES NOTHING
// =========================================================================
{
  const i = src.indexOf("function legendApply(j, whose)");
  const body = src.slice(i, src.indexOf("\n}\n", i));
  const iGuard = body.indexOf("if (!names.length)");
  const iAssign = body.indexOf("state.legendNames = names");
  check(iGuard >= 0 && iAssign > iGuard,
    "the empty-read guard comes BEFORE the vocabulary is replaced");
  check(/return legendMsg\(`no legend rows found in \$\{whose\}`/.test(body),
    "...and it returns with a message instead");
  check(/names you already loaded are/.test(body),
    "...saying the names already loaded are still there");
  check(!/state\.legendNames = j\.names \|\| \[\]/.test(src),
    "the unconditional assignment that emptied them is gone");
  check(/dl\.innerHTML = ""/.test(body) && body.indexOf('dl.innerHTML = ""') > iGuard,
    "the datalist is only cleared once there is something to put in it");
}

// =========================================================================
// 6. IT LABELS NOTHING AND MOVES NO NUMBER
// =========================================================================
for (const banned of ["state.labels.set", "setInclude(", "state.include",
                      "memSave(", "calcStateDirty", "renderItemized"]) {
  check(!code.includes(banned),
    `the legend block never touches ${banned}`);
}
check(/Nothing was labelled and no quantity changed\./.test(src),
  "and the status line it writes says so out loud");

console.log(failures ? `\n${failures} FAILED` : "\nall legend-drop checks passed");
process.exit(failures ? 1 : 0);
