// Cut/fill accuracy wave (2026-08-31): the two things an operator must
// never be unable to tell apart.
//
//  A. WHICH SURFACE produced the number. The linear TIN and the clamped
//     smooth model differ by hundreds of CY on the same rows (Oncor C-04
//     measured: cut 2,006.8 linear vs 1,425.4 clamped, identical inputs),
//     and on a sparse sheet by ~325,000 CY (Stice p0). A volume that does
//     not name its interpolant cannot be checked, so the model, its source
//     and the measurement behind an automatic choice ride beside the
//     number AND onto the printed report.
//  B. WHICH ELEVATIONS WERE INFERRED. Interval-infill rows are worked out
//     by counting unlabelled contours between two labelled ones; nobody
//     printed them. They arrive on SKIP, wear a badge, carry the sentence
//     naming the two contours they were counted between, and survive a
//     save/reload still saying so - the same discipline that keeps a
//     deleted junk row deleted (test_ew_removed_guard.js).
//
// Source-level, like test_ew_removed_guard.js and test_spot_datum_guard.js:
// no DOM, no server.
//
//     node tests/test_ew_inferred_disclosure.js
const fs = require("fs");
const path = require("path");
const R = (...p) => fs.readFileSync(path.join(__dirname, "..", ...p), "utf8");
const js = R("webui", "app.js");
const html = R("webui", "index.html");
const css = R("webui", "style.css");
const py = R("takeoff_engine", "earthwork.py");
const srv = R("server.py");

let fails = 0;
const check = (ok, msg) => {
  if (ok) console.log("ok: " + msg);
  else { fails++; console.error("FAIL: " + msg); }
};

// ---- A. the surface model is chosen, sent, and disclosed ---------------
check(/id="ewModelSel"/.test(html), "the panel has a surface-model picker");
for (const m of ["auto", "linear", "clamped_ct"])
  check(html.includes(`<option value="${m}"`),
    `the picker offers the "${m}" model`);
check(/surface_model: \(\$\("ewModelSel"\) && \$\("ewModelSel"\)\.value\) \|\| "auto"/
  .test(js), "ewBody sends the chosen model on every calculate");
check(/surface_model: str = "auto"/.test(srv),
  "EarthworkBody defaults the model to auto");
check(/surface_model=body\.surface_model/.test(srv),
  "the earthwork route passes the model through to cut_fill");
check(/def ewModelNameShim/.test(js) === false
  && /function ewModelName\(m\)/.test(js),
  "one place names the models for the UI (ewModelName)");
// the basis line beside the number names the model AND the measurement
check(/ew-basis-model/.test(js) && /ew-basis-model/.test(css),
  "the basis block has a model line, styled");
check(/j\.surface_model_source/.test(js) && /j\.surface_model_why/.test(js),
  "the basis line prints the model's source and reason");
check(/label_band_ft/.test(js),
  "the basis line prints the measured label sparsity");
// ...and it reaches the PRINTED report, not just the panel
const notes = js.slice(js.indexOf("function ewApproveNotes()"),
                       js.indexOf("function renderEwBalance"));
check(/Surface between the contours/.test(notes),
  "the approve notes carry the surface model onto the report");
check(/ewInferredAccepted\(\)/.test(notes),
  "the approve notes count the inferred elevations actually accepted");

// ---- B. an inferred elevation can never pass for a printed one ---------
check(/row\.inferred = true;/.test(js) && /row\.surface = null;/.test(js),
  "an inferred suggestion arrives on SKIP, contributing no volume");
check(/elevation INFERRED, not printed/.test(js),
  "the row's meta line says the elevation is inferred");
check(/ew-inf-tag/.test(js) && /ew-inf-tag/.test(css),
  "the row wears an 'inferred' badge, styled");
check(/ew-inf-why/.test(js) && /ew-inf-why/.test(css),
  "the row shows the sentence naming the two contours it was counted between");
// provenance survives the round trip - without this the badge and the
// report's inferred-count line vanish on the next visit
check(/inferred: true,\s*\n\s*inferred_why: r\.inferredWhy \|\| ""/.test(js),
  "calcStatePayload persists the inferred flag and its reason");
check(/if \(r\.inferred\) \{\s*\n\s*row\.inferred = true;/.test(js),
  "restore re-applies the inferred flag to a live row");
check(/inferredWhy: r\.inferred_why \|\| ""/.test(js),
  "restore re-applies it to a re-added row too");
// only ACCEPTED inferred rows are disclosed as being in the volume
check(/r\.inferred && isFinite\(r\.z\)\s*\n?\s*&& \(r\.surface === "existing" \|\| r\.surface === "proposed"\)/
  .test(js),
  "ewInferredAccepted counts only rows the operator put on a surface");

// ---- the engine side of the same two contracts -------------------------
check(/"surface_model": model,/.test(py) && /"surface_model_source": source,/.test(py)
  && /"surface_model_why": why,/.test(py),
  "cut_fill names its model on EVERY answer, including the linear default");
check(/SURFACE_MODELS = \("auto", "linear", "clamped_ct"\)/.test(py),
  "the engine's model list is explicit");
check(/if model_req not in SURFACE_MODELS/.test(py),
  "an unknown model is refused, never silently defaulted");
// the refusal rule is the load-bearing part of the infill
check(/if len\(run\) != abs\(rs\) - 1:/.test(py),
  "infill assigns only when the crossed sibling count is dz/interval - 1");
check(/def contour_interval/.test(py) && /note_ft/.test(py),
  "the interval is read from the sheet's note or its labels, never invented");
check(/"inferred": True/.test(py),
  "every infill row is flagged inferred at the source");
check(/"surface": None, "split_by": "interval-infill"/.test(srv),
  "the server hands infill rows over unassigned to a surface");

if (fails) { console.error(fails + " check(s) failed"); process.exit(1); }
console.log("all ew inferred/disclosure checks passed");
