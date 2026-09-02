// THE DISJOINT-RANGE CAUTION HAS TO REACH PAPER, NOT ONLY THE SCREEN.
//
// THE DEFECT. surface_basis.caution appeared at exactly one site in
// webui/app.js - the on-screen basis block in renderEwBasis. ewApproveNotes
// and ewBasisNote, which build the approve note and the printed report,
// never read it. So the one shape the volume floor deliberately declines to
// REFUSE - "the two surfaces do not overlap in elevation ... check the rows
// before pricing" - was on screen and nowhere on paper, while the comment
// directly above that render said screen and paper cannot drift apart. The
// estimator who prices the job reads the report.
//
// THE FIX. One function, ewCautionText, read by both sites, so the words
// are identical by construction and a trim applied for `approve`'s 400-char
// per-note cap is applied to both.
//
//     node tests/test_ew_caution_paper.js
"use strict";
const fs = require("fs");
const path = require("path");
const SRC = fs.readFileSync(path.join(__dirname, "..", "webui", "app.js"), "utf8");

let fails = 0;
const check = (ok, msg) => {
  if (ok) console.log("ok: " + msg);
  else { fails++; console.error("FAIL: " + msg); }
};
const eq = (got, want, msg) =>
  check(got === want, msg + " (got " + JSON.stringify(got) + ")");

function fnSrc(name) {
  let j = SRC.indexOf("function " + name + "(");
  if (j < 0) return null;
  if (SRC.slice(j - 6, j) === "async ") j -= 6;
  let d = 0;
  for (let k = SRC.indexOf("{", j); k < SRC.length; k++) {
    if (SRC[k] === "{") d++;
    else if (SRC[k] === "}" && --d === 0) return SRC.slice(j, k + 1);
  }
  return null;
}

// the server's own sentence, verbatim from a live 400 on :9904
const CAUTION =
  "the two surfaces do not overlap in elevation: existing runs 324-324 ft "
  + "and proposed 826-826 ft, a 502 ft gap that no contour on either surface "
  + "crosses, so every cell is cut (or filled) by at least that much. That "
  + "is normal on a raised pad or a deep excavation and WRONG when a row was "
  + "assigned to the wrong surface or a digit was misread - check the rows "
  + "before pricing.";

const RESULT = {
  surface_model: "linear", surface_model_source: "auto (measured)",
  surface_model_why: "labels are dense", label_band_ft: 2.0,
  existing_contours: 7, proposed_contours: 4, area_sf: 57652,
  cell_ft: 2.0, cut_yd3: 1838.4, fill_yd3: 4697.1,
  surface_basis: { existing: {}, proposed: {}, ranges_overlap: false,
                   range_gap_ft: 502.0, caution: CAUTION },
};

// ---------------------------------------------------------------------------
console.log("1. there is ONE source of the words");
// ---------------------------------------------------------------------------
const HAS = !!fnSrc("ewCautionText");
check(HAS, "webui/app.js has an ewCautionText()");
const NOTES = fnSrc("ewApproveNotes") || "";
const BASIS = fnSrc("renderEwBasis") || "";
check(/ewCautionText\(/.test(NOTES),
  "ewApproveNotes reads it - before this fix the approve note and the "
  + "printed report never saw surface_basis.caution at all");
check(/ewCautionText\(/.test(BASIS), "renderEwBasis reads the same function");
check(!/surface_basis\s*&&\s*\w*\.?\s*caution/.test(BASIS)
      || /ewCautionText/.test(BASIS),
  "...and no longer reaches into surface_basis.caution on its own");
// the count of CODE sites that touch the raw field: only the shared helper
// (the comment above ewCautionText names it too, and a comment is evidence,
// not a reader)
const CODE = SRC.replace(/^\s*\/\/.*$/gm, "");
const rawHits = (CODE.match(/\.caution/g) || []).length;
eq(rawHits, 1, "`.caution` is read at exactly one site in app.js now");

// ---------------------------------------------------------------------------
console.log("2. the same words reach the report");
// ---------------------------------------------------------------------------
const APPROVE_NOTE_MAX = 400;
const APPROVE_NOTES_MAX = 6;
const mk = (extra) => new Function(
  "state", "APPROVE_NOTE_MAX", "APPROVE_NOTES_MAX", "ewModelName",
  "ewAcceptedSplit", "ewBasisNote",
  (fnSrc("ewCautionText") || "function ewCautionText() { return ''; }")
  + "\n" + (SRC.match(/^const EW_CAUTION_HEAD = .*$/m) || [""])[0]
  + "\n" + (fnSrc("ewApproveNotes") || "function ewApproveNotes() { return []; }")
  + "\nreturn { ewApproveNotes, ewCautionText };")(
  { ew: { added: true, result: extra, rows: [] } },
  APPROVE_NOTE_MAX, APPROVE_NOTES_MAX,
  (m) => String(m),
  () => ({ total: 21, printed: 17, nearby: 0, nearbyTagged: 0, infill: 4,
           inherited: 0, manual: 0, unknown: 0, machine: 17 }),
  () => ["a machine-read note"]);

{
  const api = mk(RESULT);
  const notes = api.ewApproveNotes();
  const hit = notes.filter(n => /do not overlap in elevation/.test(n));
  eq(hit.length, 1, "exactly one approve note carries the caution");
  check(/^Check these rows\. /.test(hit[0]),
    "...under the same headline the screen uses");
  check(/502 ft gap/.test(hit[0]),
    "...with the measured gap the engine reported");
  check(notes.length <= APPROVE_NOTES_MAX,
    "the note list still fits what `approve` keeps (" + notes.length
    + " of " + APPROVE_NOTES_MAX + ")");
  check(notes.indexOf(hit[0]) === 1,
    "and it is SECOND, not last - it is the only line saying the number "
    + "may be wrong, and the server keeps six");
  for (const n of notes)
    check(n.length <= APPROVE_NOTE_MAX,
      "every note is inside the 400-char cap (" + n.length + ")");
}
{
  // an overlapping pair carries no caution and no extra note
  const clean = JSON.parse(JSON.stringify(RESULT));
  clean.surface_basis = { existing: {}, proposed: {}, ranges_overlap: true,
                          range_gap_ft: 0.0, caution: null };
  const api = mk(clean);
  eq(api.ewCautionText(clean), "", "an overlapping pair produces no caution");
  check(!api.ewApproveNotes().some(n => /Check these rows/.test(n)),
    "...and nothing is claimed on the report");
}

// ---------------------------------------------------------------------------
console.log("3. the trim is applied ONCE, so screen and paper cannot differ");
// ---------------------------------------------------------------------------
{
  const api = mk(RESULT);
  const short = api.ewCautionText(RESULT);
  check(short.length + "Check these rows. ".length <= APPROVE_NOTE_MAX,
    "the caution + headline fits the per-note cap (" + short.length + ")");
  // a long caution loses the closing generic clause WHOLE, not mid-sentence
  const longOne = JSON.parse(JSON.stringify(RESULT));
  longOne.surface_basis.caution = CAUTION.replace(
    "existing runs 324-324 ft",
    "existing runs 324.0000-324.0000 ft and a great deal of additional "
    + "explanatory text that pushes this sentence past the four hundred "
    + "character cap the approve route applies to every note it keeps");
  const cut = api.ewCautionText(longOne);
  check(cut.length + "Check these rows. ".length <= APPROVE_NOTE_MAX,
    "an over-long caution is trimmed to fit (" + cut.length + ")");
  check(!/That is normal on/.test(cut),
    "...by dropping the closing clause whole, not by cutting a sentence");
  check(/do not overlap in elevation/.test(cut),
    "...and what remains is still the finding");
}

console.log(fails ? "\n" + fails + " FAILED" : "\nall checks passed");
process.exit(fails ? 1 : 0);
