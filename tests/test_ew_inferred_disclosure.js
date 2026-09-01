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
const eq2 = (got, want, msg) =>
  check(got === want, msg + "  (got " + JSON.stringify(got) + ")");

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
check(/ewAcceptedSplit\(\)/.test(notes) && /ewBasisNote\(acc\)/.test(notes),
  "the approve notes account for every accepted elevation by mechanism");

// ---- B. an inferred elevation can never pass for a printed one ---------
check(/row\.inferred = true;/.test(js) && /row\.surface = null;/.test(js),
  "an inferred suggestion arrives on SKIP, contributing no volume");
check(/elevation INFERRED, not printed/.test(js),
  "the row's meta line says the elevation is inferred");
check(/function ewRowSource\(row\)/.test(js) && /function ewRowInferred\(row\)/.test(js),
  "one function decides a row's badge and one words its source line");
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
// ---- C. the printed report's own basis sentence -------------------------
// THE DEFECT. ewInferredAccepted() counted `r.inferred`, which the server
// sets on interval-infill rows ALONE. `inherited` rows - 26 of C-04's 150,
// with no label printed on those lines at all - never carry it. The note
// then read "35 of the contour elevations in this volume were INFERRED ...
// not read from a printed label", which says nothing about the other 115
// and implies every one of them WAS label-backed. On the document an
// estimator bids from, that silently reclassified 26 unlabelled contours as
// printed. Evaluated against real row sets, not grepped.
{
  const fnSrc = (name) => {
    let j = js.indexOf("\nfunction " + name + "(");
    if (j < 0) throw new Error("not found: " + name);
    let d = 0;
    for (let k = js.indexOf("{", j); k < js.length; k++) {
      if (js[k] === "{") d++;
      else if (js[k] === "}" && --d === 0) return js.slice(j + 1, k + 1);
    }
    throw new Error("unbalanced braces reading " + name);
  };
  const provBlock = js.slice(js.indexOf("const ELEV_PROV = {"),
                             js.indexOf("\nfunction elevProvenance(how) {"));
  const build = (rows) => {
    const state = { ew: { rows } };
    const src = fnSrc("elevRadiusMark") + "\n" + provBlock
      + fnSrc("elevProvenance") + "\n"
      + fnSrc("ewAcceptedSplit") + "\n" + fnSrc("ewInferredAccepted") + "\n"
      + fnSrc("ewBasisNote")
      + "\nreturn { ewAcceptedSplit, ewInferredAccepted, ewBasisNote };";
    return new Function("state", "APPROVE_NOTE_MAX", src)(state, 400);
  };
  const row = (how, extra) => Object.assign(
    { chain_id: 1, z: 100, width: 1, surface: "existing", how }, extra || {});

  // the C-04 mix, every row accepted onto a surface
  const rows = [];
  for (let i = 0; i < 69; i++) rows.push(row("gap-ocr"));
  for (let i = 0; i < 20; i++) rows.push(row("radius", { dist: 2.7 }));
  for (let i = 0; i < 26; i++) rows.push(row("inherited", { dist: 999 }));
  for (let i = 0; i < 35; i++)
    rows.push(row("interval-infill", { inferred: true }));
  const api = build(rows);
  const a = api.ewAcceptedSplit();
  check(a.total === 150 && a.printed === 69 && a.nearby === 20
        && a.inherited === 26 && a.infill === 35,
    "the split accounts for all 150 accepted rows by mechanism  (got "
    + JSON.stringify(a) + ")");
  check(api.ewInferredAccepted() === 61,
    "61 accepted elevations are printed nowhere - not the 35 the old count "
    + "reported  (got " + api.ewInferredAccepted() + ")");
  const note = api.ewBasisNote(a)[0];
  check(/26/.test(note) && /carried along the contour/.test(note),
    "the report's own sentence discloses the 26 welded elevations");
  check(/35/.test(note) && /counted between/.test(note),
    "...and the 35 counted ones");
  check(/61 are printed NOWHERE/.test(note),
    "...and states the total that is printed nowhere, so the remainder "
    + "cannot be read as label-backed");
  check(note.length <= 400,
    "the note fits approve()'s 400-char per-note cap  (" + note.length + ")");

  // rows on SKIP or with no elevation contribute nothing and are not
  // disclosed as if they did
  const skipped = build([row("inherited", { surface: null }),
                         row("interval-infill", { z: NaN, inferred: true }),
                         row("gap-ocr")]);
  check(skipped.ewAcceptedSplit().total === 1
        && skipped.ewInferredAccepted() === 0,
    "a row left on SKIP, or with no elevation typed, is not counted");

  // an all-printed sheet gets no caveat at all
  check(build([row("inline"), row("inline")]).ewBasisNote(
          build([row("inline"), row("inline")]).ewAcceptedSplit()).length === 0,
    "a volume built only from in-break labels carries no inferred note");

  // a row the operator typed is its own bucket, and it is not "printed"
  const man = build([row("gap-ocr"),
                     row(null, { manual: true })]);
  check(man.ewAcceptedSplit().manual === 1
        && man.ewAcceptedSplit().printed === 1,
    "a hand-typed elevation is neither printed nor inferred by us");
  check(/typed in by the reviewer/.test(man.ewBasisNote(man.ewAcceptedSplit())[0]),
    "...and the report says so");

  // an unrecognised reader ABSTAINS into its own bucket rather than
  // defaulting into the printed majority
  const unk = build([row("some-new-reader-v3")]);
  check(unk.ewAcceptedSplit().unknown === 1
        && unk.ewAcceptedSplit().printed === 0,
    "a `how` the UI has not been taught is never counted as printed");
}

// ---- B2. the 999 sentinel is never rendered as a measurement -----------
// takeoff_engine.earthwork stores 999.0 in the `dist` slot to mean "no
// label on this chain at all". The panel printed "chain 87 - w 0.2 - label
// 999pt away" for 26 of C-04's 150 rows while the selection chip, one
// screen away, called the SAME row inferred - and the panel is the screen
// carrying the EXIST / PROP buttons that feed the volume.
{
  const fnSrc = (name) => {
    let j = js.indexOf("\nfunction " + name + "(");
    if (j < 0) throw new Error("not found: " + name);
    let d = 0;
    for (let k = js.indexOf("{", j); k < js.length; k++) {
      if (js[k] === "{") d++;
      else if (js[k] === "}" && --d === 0) return js.slice(j + 1, k + 1);
    }
    throw new Error("unbalanced braces reading " + name);
  };
  const provBlock = js.slice(js.indexOf("const ELEV_PROV = {"),
                             js.indexOf("\nfunction elevProvenance(how) {"));
  const src = fnSrc("elevRadiusMark") + "\n" + provBlock
    + fnSrc("elevProvenance") + "\n"
    + js.slice(js.indexOf("const EW_DIST_INHERITED ="),
               js.indexOf("\nfunction renderEw() {"))
    + "\nreturn { ewRowSource, ewRowInferred, EW_DIST_INHERITED };";
  const api = new Function(src)();
  eq2(api.EW_DIST_INHERITED, 999, "the sentinel is a named constant");

  const inh = { chain_id: 87, width: 0.2, how: "inherited", dist: 999 };
  check(!/999/.test(api.ewRowSource(inh)),
    "an inherited row NEVER prints 999 - THE FIXED DEFECT: a sentinel "
    + "rendered as a measurement");
  check(!/pt away/.test(api.ewRowSource(inh)),
    "...and claims no distance at all, because no label exists to measure");
  check(/NO label on this line/.test(api.ewRowSource(inh)),
    "...it says what is actually true of the line");
  check(api.ewRowInferred(inh) === true,
    "and the panel badges it inferred, agreeing with the selection chip - "
    + "the server's `inferred` flag never covered this mechanism");

  const inf = { chain_id: 5, width: 1, how: "interval-infill", inferred: true };
  check(api.ewRowInferred(inf) === true, "an infilled row is still inferred");
  const rad = { chain_id: 168, width: 0.2, how: "radius", dist: 2.7, tag: "BW" };
  check(api.ewRowInferred(rad) === false,
    "a nearby printed number is not an inference");
  check(/2\.7 pt away/.test(api.ewRowSource(rad)) && /BW/.test(api.ewRowSource(rad)),
    "...and the panel row shows the same distance and tag the chip does");
  check(/may not be this line/.test(api.ewRowSource(rad)),
    "...and says the attribution is not the sheet's");
  const man = { chain_id: 9, width: 1, manual: true };
  check(api.ewRowInferred(man) === false && /typed in by you/.test(api.ewRowSource(man)),
    "a hand-typed row is neither printed nor inferred");
  const bare = { chain_id: 3, width: 1, dist: 999 };
  check(!/999/.test(api.ewRowSource(bare)),
    "a row with NO provenance abstains rather than printing its dist slot");
}

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
