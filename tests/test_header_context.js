// THE MASTHEAD carries document context only while a document is on screen
// (CET, 2026-09-09). Two defects Koby saw: the Tools menu showing with no
// project open, and the last project's name / sheet picker / Detect stuck
// in the header after going back to Projects. Pinned from source:
//   * headerSync() sets header.no-doc from state.job and header.view-open
//     from the two full-screen views, and nothing else touches the four
//     elements' own `hidden` bookkeeping
//   * every entrance calls it: applyOpened, showProjects, showSettings, svHide
//   * the markup starts with no-doc, and style.css hides the four on the
//     classes (Tools on no-doc; name, picker, Detect and Tools on view-open)
//
// Dependency-free:  node tests/test_header_context.js
"use strict";
const fs = require("fs");
const path = require("path");
const R = (...p) => fs.readFileSync(path.join(__dirname, "..", ...p), "utf8");
const SRC = R("webui", "app.js");
const HTML = R("webui", "index.html");
const CSS = R("webui", "style.css");

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

const hs = grab("headerSync");
check(!!hs, "headerSync exists");
check(hs && /classList\.toggle\("no-doc", !state\.job\)/.test(hs), "no-doc follows state.job");
check(hs && /classList\.toggle\("view-open", pvIsOpen\(\) \|\| svIsOpen\(\)\)/.test(hs), "view-open follows the two full-screen views");
check(hs && !/\.hidden\s*=/.test(hs), "it never writes an element's hidden flag - which sheet is open is not its business");
for (const fn of ["applyOpened", "showProjects", "showSettings", "svHide"]) {
  const b = grab(fn);
  check(b && /headerSync\(\);/.test(b), fn + " calls headerSync");
}
check(/<header class="no-doc">/.test(HTML), "index.html: the header starts with no document");
check(/header\.no-doc #toolsWrap,/.test(CSS) && /header\.view-open #toolsWrap \{ display: none !important; \}/.test(CSS),
      "style.css: Tools is hidden with no document and while a full-screen view is up");
check(/header\.view-open #docName, header\.view-open #pageSel,/.test(CSS) && /header\.view-open #detectBtn/.test(CSS),
      "style.css: the name, the sheet picker and Detect are hidden while a full-screen view is up");

console.log(fails ? "\n" + fails + " FAILURE(S)" : "\nall green");
process.exit(fails ? 1 : 0);
