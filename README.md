# CET — general-construction takeoff (this repo)

**What this is.** A fork of the CORE Takeoff detection engine
(`Takeoff Automation/detection-engine`, branch `dev` at 8fb1fdb, forked
2026-09-08) that ships as its own product for the *building* side of a bid:
symbol counts (fixtures, grid bubbles), door and window marks against the
schedule, callouts, legend sheets, and - the first thing to build here - the
**flooring calculator** (room areas by floor type plus wall length, with the
room boundary bridged across doorways). The excavation product stays in the
original repo; the two share the detection engine and nothing else.

**How the split works.** `TAKEOFF_PRODUCT=construction` (the default in
`run-service.sh` here) makes `/api/config` say so, and `webui/app.js`
`applyProduct` hides the excavation calculators - Earthwork, Trench,
Structure - from the Tools menu and names the product CET. The code for
those panels is still in the tree on purpose: the regress gates and the
shared detection path do not fork, and a change to `chain.py` here should
be able to land there. Delete nothing that the gates hash.

**Its own everything.** Port **8300**, job store `C:/Users/kobys/cet-jobs`,
its own `.venv` (built with `uv venv .venv --python 3.12`), no git remote
yet (create the GitHub repo and `git remote add origin ...` when ready; the
excavation remote was deliberately removed so a stray push cannot land
there). `.env` was copied from the engine: the same UI password and LLM
keys.

**Run.** `bash run-service.sh` then http://localhost:8300 (any username,
the UI password from `.env`). `python -m takeoff_engine.regress --check
--require` before committing anything that touches detection.

**Roadmap (from the 2026-09 meeting; see the memory note "flooring
calculator ask").**
1. Flooring calculator - room polygons from wall lines, doorway bridging,
   floor-type from the finish schedule / legend, area by type + wall LF.
2. Door / window schedule: mark counts on the plan reconciled against the
   schedule table (`marks.py` reads schedules already; the reconciliation
   view is the new part).
3. Symbol counting as a first-class panel with per-sheet and whole-job
   rollups (exists under Tools -> Count / Whole job; needs the same
   evidence discipline as the excavation panels).
4. Pricing memory and calculators per the boss roadmap.

Everything below this line is the engine's own contract and still binds.

---

# Takeoff Detection Engine

Line detection, dash-pattern classification, and style discovery for civil
construction plan PDFs. This is the engine behind milestones 1–4 (single /
double / triple dashed and solid line detection + vectorization); it feeds
detected polylines to the takeoff web app for classify-and-approve review.

## How it works

```
PDF page
  └─ classify_page.py   vector / raster / hybrid  (route at the front door)
  └─ extract.py         stroke units: connected polylines + color/width/dash
  │                     attrs; splits closed marker glyphs (arrowheads,
  │                     tick boxes) out of self-intersecting strokes
  └─ chain.py           the core:
        1. group strokes by visual style (color, width)
        2. drop stipple-texture dots (crowding test)
        3. link dash fragments end-to-end: KDTree pair search, direction
           continuity, mutual-best greedy matching (crossing lines can't
           steal each other's dashes); touching endpoints always join
        4. walk links into ordered chains, read the dash/gap cadence
        5. classify: solid / dash1 / dash2 / dash3 (+ dash-text via
           inline-label bridging, e.g. "-- SD --")
        6. prune junk: hatch fields (parallel-neighbor test), exploded
           text glyphs (extent / wiggle / gap-chaos / cadence-periodicity)
        7. group chains into line styles (class + color + width +
           quantized signature) for the classify/approve UI
  └─ overlay.py         debug/demo overlays, chains colored by class
```

Key insight the whole design leans on: CAD plot drivers explode dashed
lines into hundreds of independent tiny strokes and the dash pattern only
survives as geometry. Rebuilding the line and *reading the cadence off the
rebuilt chain* is what makes classification format-independent. Line types
are open-ended per PDF: the engine discovers pattern groups (styles), it
does not hardcode four classes.

## Run

```bash
pip install -r requirements.txt
python -m takeoff_engine.cli "path/to/plan.pdf" --page 0 --out out
python -m takeoff_engine.batch "path/to/plans-dir" --out out/batch
python3 -m uvicorn server:app --port 8100   # review UI at localhost:8100
```

Service environment (all optional): `TAKEOFF_UI_PASSWORD` (HTTP Basic on every
request), `TAKEOFF_PLAN_ROOTS` (os.pathsep-separated directories that
`/api/open-path`, `/api/legend-sheet` and `/api/samples` may touch; default =
`../TakeoffPro AI`, `../client_meet`, `out/jobs`), `TAKEOFF_HOSTED=1` (refuse
client paths entirely - uploads only - and hide the samples list; set this on
any shared/hosted deployment).

`server.py` + `webui/` is the classify-and-approve product loop: open a
plan, Detect, review discovered styles (isolate/relabel/include), Approve
-> elements JSON in TakeoffDraft2 format. See INTEGRATION.md for the
app-side import wiring.

Per page this produces `*.json` (chains with class, style id, signature,
polyline points in PDF pt coordinates), `*_all.png` and `*_dashed.png`
overlays. Batch mode adds `summary.csv`.

## State (2026-08-17)

Working on real vector sheets from the sample corpus:

| Sheet | Paths | Time | Notes |
|---|---|---|---|
| Belle Farms structural | 7.7k | ~2s | footing dashes, grid centerlines, dash-text |
| C4.0 grading plan | 143k | ~16s | contours, arrow-decorated flow lines, hatch pruned |
| Oncor substation C-03 | 55k | ~96s | setback/easement dashes, property lines |

Coordinate-space contract (learned the hard way): `get_drawings()` returns
RAW unrotated page coordinates, while `get_text()` and `get_pixmap()` are
rotation-aware. On a page with `/Rotate` (very common for CAD landscape
plots) the raw geometry looks like a rotated/mirrored "phantom copy".
`extract_strokes` clips in raw space, then maps everything through
`page.rotation_matrix`, so all engine output is in rendered/display space
and registers exactly with rasterizations and the text layer.

Extraction also honors clip viewports (paper-space scissors - drops/trims
never-rendered xref geometry), skips hidden OCG layers, and carries the CAD
layer name (e.g. `C-PRO-WATER MAIN`, `P2-STORM-SWALE`) onto every stroke,
chain, and style - when present it both separates chaining groups and gives
the classify/approve UI human-meaningful default labels.

Measured accuracy (layer-based eval, `eval_layers.py`): on C4.0, using the
PDF's own CAD layers as ground truth, ink-weighted **recall 93.3% / purity
92.5%** across line layers. Strong layers (concrete, parking, walks,
contours, pipes) sit at 96-100%. Known depressors of the aggregate:
- Fence-style layers count their X/marker decoration as "missed" ink
  (~22% of fence ink) although the line itself is fully chained - metric
  artifact, not a detection gap.
- Some layers are hatch strips not named `*HATCH*` (e.g. BLDG-OVERHANG):
  the junk pruner correctly drops them but the eval counts them as lines.
- Text/label layers leak some glyph chains (P6-TEXT) - the remaining
  junk-chain source.

Batch health: 81 pages across the Plans corpus, zero errors, routing
48 vector / 8 hybrid / 25 raster, median vector page 7.4s.

## Raster & hybrid pipelines (raster.py)

Raster pages: render -> ink mask -> Zhang-Suen thinning -> split skeleton
at junctions -> trace arms -> polylines with measured width (distance
transform) and quantized color. Output is ordinary StrokeUnits, so ALL
downstream machinery (chaining, cadence, styles, junk pruning, eval) is
shared with the vector path. Junction arms end at the junction centroid;
the matcher's touching-link direction tiebreak reassembles straight-through
lines at crossings.

Hybrid pages: vector strokes via the vector path + in-place tracing of
each embedded image XObject (no full-page re-render, so vector content is
never double-counted). Photo underlays (aerials) are detected by tonal
profile (ink/midtone fractions) and skipped.

The raster path also runs text handling (text_detect.py): CC-based glyph
detection masks annotation text BEFORE thinning (dashes are told apart
from glyphs by fill ratio + aspect), tesseract OCR provides real word
strings (enables dash-text bridging with labels like "SD"), pseudo-word
row boxes cover what OCR misses, and skew beyond 0.2 degrees is corrected
with the inverse transform applied to output geometry so overlays still
register.

Controlled benchmark - Belle Farms rasterized at 250dpi, scored as
GEOMETRIC COVERAGE of the sheet's own vector-truth chains (fraction of
each vector chain within 2.5pt of a raster chain, length-weighted):
solid 69%, dash1 73%, dash2 84%, dash3 86%, dash-text 35%, total 72%.
(Naive ink-length ratios understate the tracer: CAD overdraws strokes
that the skeleton correctly merges.) Class agreement on covered geometry
is ~46% - chaining decisions differ between the two paths; this is the
main raster gap after coverage itself. ~48s for a 9000x6000px sheet
including OCR.

Known issues / next:
- Raster: no OCR -> no dash-text bridging on scans; no deskew yet (true
  skewed scans will need it plus a shared transform for overlays);
  solid-line fragmentation repair would lift the 41%.
- Purity on multi-style layers (O-PIPE 57%) partly reflects genuinely
  different pipe styles sharing a layer; needs eyes before tuning.
- Oncor-class pages (50k+ paths, huge dot groups) run 90s+; per-group
  parallelism is the obvious lever.

## Scale auto-detection (scale_detect.py)

Reads the sheet's scale note - text layer first, OCR fallback (CAD exports
often explode the note into strokes). Handles architectural (1/4" - 1'-0")
and civil (1" = 20') notations plus OCR mutilations (doubled separators,
eaten quote marks - the relaxed pattern only applies anchored to the
literal SCALE keyword). Reports all candidates + NTS presence for the
reviewer. Corpus test: 6/7 sheets correct (miss: Oncor's graphic-bar-only
"GRAPHIC SCALE 50'" - measuring bar geometry is future work).

The approve export carries the scale; TakeoffDraft2's import endpoint
auto-calibrates uncalibrated pages with it. Verified: Belle Farms end to
end with zero manual calibration reproduces the manually-calibrated
quantities exactly (footings 1,059.3 LF both ways).

## Milestone metrics (accuracy sprint, 2026-08-17 evening)

Per-class scoring in `eval_layers.py` (`class_metrics`): precision via
annotation-layer test, classification accuracy + decoration-aware coverage
on hand-asserted truth layers. `milestone_report.py` builds the evidence
pack (out/milestone/): per-sheet dashed overlays + scores.

Current corpus numbers (5 sheets, 2 firms):
- dashed precision (ink-weighted): 99.8-100% on every sheet
- truth-layer classification accuracy: 100% on contours, lots, water,
  swale, pvmt centerline; fence 94.6% (X-marks inject stray lengths);
  firewater "36%" is a truth-map artifact (the layer genuinely mixes two
  local patterns; both are found, coverage 100%)
- coverage: 97-100% everywhere except fence 83% (X-decoration chaining)

What made the jump: annotation-layer demotion (dash1 precision 93.7->100),
DOT_LEN 1.0->2.5 (dash-dot dots pass the matcher), clipped-end-dash
trimming + 18% minor-class floor (dash1/dash2 boundary stability),
dash-text now requires a REPEATED short token at cadence frequency (a
contour crossing labels stays dash1), text-box chain demotion on unlayered
pages, and OCR gated to sparse-text pages WITHOUT layers (layer names beat
OCR; mixing them only added noise).

## Tuning constants

All in `chain.py` with rationale comments: `DASH_MAX_LEN`, `GAP_ABS_MAX`
(+ per-group adaptive radius), `ANG_TOL_DEG`, `MIN_DASHES`, junk-pruning
thresholds (`MIN_EXTENT`, `MAX_WIGGLE`, `HATCH_RADIUS`). Change them against
the batch summary, not one sheet.
