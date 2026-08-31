# The Training Ledger

Every operator correction in the review UI is a labeled training example:
the engine said X, a human changed it to Y, with the context the engine
itself had when it said X. Until 2026-08-30 those corrections vanished
into UI state. The ledger makes them durable, structured, and
training-ready — before any model exists. **The ledger is the asset;
models come later.**

Code: `takeoff_engine/ledger.py` (writer + semantic differ), hooks in
`server.py` (search "training-ledger hooks"), `tools/ledger_backfill.py`,
`tools/ledger_export.py`, `tests/test_ledger.py`.

## Where it lives, and the two rules

- **Local-only.** Append-only JSONL under `out/ledger/` beside the rest
  of this service's artifacts (`TAKEOFF_LEDGER_DIR` overrides). One file
  per month: `events-YYYY-MM.jsonl`, UTF-8, LF line endings on every
  platform. Nothing transmits an event anywhere; client plan data never
  leaves the box. Events carry job ids, page indices, chain features and
  operator numbers — no account names, no file contents.
- **Write-only with respect to the pipeline.** Nothing in the detection
  or calculation path ever READS the ledger: deleting `out/ledger/`
  changes no number any endpoint returns. Every hook is best-effort —
  `ledger.record()` catches everything and logs once, so a ledger
  failure can cost an event, never a request. The only readers are
  `GET /api/ledger/stats` and the `tools/ledger_*` scripts, which sit
  outside the pipeline.

## Schema (version 1)

One JSON object per line:

| key | meaning |
|---|---|
| `ts_iso` | local time the decision was recorded (`YYYY-MM-DDTHH:MM:SS`); backfilled events use the source file's mtime |
| `event` | event type, catalog below |
| `job` | job id (the registration in `registry.json`) |
| `pdf_sha1` | sha1 of the source PDF — the stable identity of the drawing; job ids are per-registration |
| `page_index` | engine page index (0-based; printed sheet number is in the drawing, not here); `null` for job-level events |
| `engine_sig` | `detect_page.engine_sig()` at record time — which detector produced the features being corrected |
| `schema_version` | `1` |
| `before` | what stood before the decision (engine suggestion, prior row, prior pick); `null` when nothing did |
| `after` | what the human left in force; `null` for deletions/erasures |
| `context` | what a model needs to learn the decision — per-chain engine features (`context.chain`), per-style features (`context.style`), changed-key lists |
| `ui_source` | `"webui"` for live capture, `"backfill"` for imported history |
| `dedupe` | backfill only: sha1 of the semantic payload, so a re-run imports nothing new |

Per-chain features in `context.chain` are **copied from the cached
`p<N>_result.json`, never recomputed**: `class, style_id, layer, color,
width, length_pt, ink_pt, gap_pt, pickup_pt, n_dashes, dash_signature,
template, seg_counts, n_points`.

## Event catalog

Real lines produced by the shipped code (long arrays elided with `…`).

### Labels — the flywheel core (approve hook)

`style_label` — engine's suggested label vs. the label the human exported
under. One per exported style, per approve.

```json
{"ts_iso": "2026-08-30T20:39:32", "event": "style_label", "job": "d6c45228002c", "pdf_sha1": null, "page_index": 2, "engine_sig": "f74c853f3270c297", "schema_version": 1, "before": {"suggested_label": "dash2 d6.1 g3.0"}, "after": {"label": "PROPOSED 8\" SANITARY SEWER"}, "context": {"style_id": 7, "style": {"suggested_label": "dash2 d6.1 g3.0", "class": "dash2", "signature": "d6.1 g3.0", "color": [0.0, 0.0, 0.0], "width": 0.72, "layer": "C-SSWR", "length_pt": 4310.2, "n": 18, "texture": false}}, "ui_source": "webui"}
```

`chain_relabel` — "separate from group": one chain pulled out of its
style's label onto its own.

```json
{"ts_iso": "2026-08-30T20:39:32", "event": "chain_relabel", "job": "d6c45228002c", "pdf_sha1": null, "page_index": 2, "engine_sig": "f74c853f3270c297", "schema_version": 1, "before": {"label": "PROPOSED 8\" SANITARY SEWER"}, "after": {"label": "SEWER LATERAL"}, "context": {"chain_id": 41, "chain": {"class": "dash2", "style_id": 7, "layer": "C-SSWR", "color": [0.0, 0.0, 0.0], "width": 0.72, "length_pt": 412.6, "ink_pt": 300.1, "gap_pt": 0.0, "pickup_pt": 0.0, "n_dashes": 34, "dash_signature": "d6.1 g3.0", "n_points": 2}}, "ui_source": "webui"}
```

`chain_excluded` — the reviewer erased this chain from the export: a
junk/not-this-label judgment with the chain's full engine features.
Capped at 2000 per approve (a mass-erase is one gesture, not thousands of
judgments); `approve_export.context.n_excluded` always carries the true
count.

```json
{"ts_iso": "2026-08-30T20:39:32", "event": "chain_excluded", "job": "d6c45228002c", "pdf_sha1": null, "page_index": 2, "engine_sig": "f74c853f3270c297", "schema_version": 1, "before": {"label": "PROPOSED 8\" SANITARY SEWER"}, "after": null, "context": {"chain_id": 42, "chain": {"class": "dash2", "style_id": 7, "layer": "C-SSWR", "color": [0.0, 0.0, 0.0], "width": 0.72, "length_pt": 16.2, "ink_pt": 9.0, "gap_pt": 0.0, "pickup_pt": 0.0, "n_dashes": 2, "dash_signature": "d6.1 g3.0", "n_points": 2}}, "ui_source": "webui"}
```

`approve_export` — one per approve: the final itemized counts, overrides
and scale a human signed off on (this line is a real backfilled one from
the Belle Farms job).

```json
{"ts_iso": "2026-08-21T16:56:27", "event": "approve_export", "job": "0ae37bd300ea", "pdf_sha1": null, "page_index": 0, "engine_sig": "f74c853f3270c297", "schema_version": 1, "before": null, "after": {"n_elements": 467, "items": [{"label": "solid solid", "count": 301, "length_ft": 3859.8, "unit_price": 12.5, "extended": 48247.65}, …], "overrides": [], "scale": {"pixelsPerUnit": 75.0, "unit": "ft", "name": "1/4\" - 1'-0\" (auto, text)"}, "work_area": null}, "context": {"source_pdf_name": "Belle Farms Structural Plans.pdf", "labels": […], "image_dpi": 300}, "ui_source": "backfill", "dedupe": "…"}
```

### Scale (approve `_page_scale` hook)

`scale_set` — a human overruled the engine's reading; `before` is what
the engine read, `after` is the pick (real backfilled line — Liberty
Park p6):

```json
{"ts_iso": "2026-08-30T19:42:34", "event": "scale_set", "job": "b85e2a38dc52", "pdf_sha1": "c5607dabf22f0635f767e7ab954ac10e0183cf44", "page_index": 6, "engine_sig": "f74c853f3270c297", "schema_version": 1, "before": null, "after": {"ft_per_paper_inch": 20.0, "text": "1\" = 20'", "set_by": "reviewer", "set_at": "2026-08-30T19:42:34"}, "context": {"engine_reading_is_current_not_original": false}, "ui_source": "backfill", "dedupe": "6a71b240c0849d4fdbb01b0729cac8d2c38c82d6"}
```

`scale_pick_retired` — the reviewer went back to the engine's own
reading; as much a label as the overrule was.

```json
{"ts_iso": "2026-08-30T20:39:32", "event": "scale_pick_retired", "job": "d6c45228002c", "pdf_sha1": null, "page_index": 2, "engine_sig": "f74c853f3270c297", "schema_version": 1, "before": {"ft_per_paper_inch": 20.0, "text": "1\" = 20'", "set_by": "reviewer", "set_at": "2026-08-30T21:02:11"}, "after": {"ft_per_paper_inch": 30.0, "set_by": "auto"}, "context": {"engine_text": "1\" = 30'", "engine_source": "text"}, "ui_source": "webui"}
```

### Calculator sidecar (calcstate hook — old vs. new diffed per key)

`ew_row_add` / `ew_row_edit` / `ew_row_delete` — one contour-elevation
row changed, keyed by `chain_id`, with the chain's engine features. The
z-labeler's raw material.

```json
{"ts_iso": "2026-08-30T20:39:32", "event": "ew_row_edit", "job": "d6c45228002c", "pdf_sha1": null, "page_index": 2, "engine_sig": "f74c853f3270c297", "schema_version": 1, "before": {"chain_id": 41, "z": 424.0, "surface": "existing", "width": 0.72, "dist": null, "manual": false}, "after": {"chain_id": 41, "z": 426.0, "surface": "existing", "width": 0.72, "dist": null, "manual": false}, "context": {"chain_id": 41, "changed": ["z"], "chain": {"class": "dash2", "style_id": 7, "layer": "C-SSWR", "color": [0.0, 0.0, 0.0], "width": 0.72, "length_pt": 412.6, "ink_pt": 300.1, "gap_pt": 0.0, "pickup_pt": 0.0, "n_dashes": 34, "dash_signature": "d6.1 g3.0", "n_points": 2}}, "ui_source": "webui"}
```

`ew_rows_snapshot` — first save of a page only: the rows are mostly
engine-seeded suggestions, not human labels, so they summarise in one
event (manual rows still get their own `ew_row_add` each — those ARE
operator additions).

```json
{"ts_iso": "2026-08-30T20:36:11", "event": "ew_rows_snapshot", "job": "7168ef02465d", "pdf_sha1": "ad83b9bd9c79284f01428485f34c933f917db8ff", "page_index": 2, "engine_sig": "f74c853f3270c297", "schema_version": 1, "before": null, "after": {"n_rows": 17, "n_manual": 0, "n_with_z": 17, "by_surface": {"existing": 9, "proposed": 8}, "layers": {"existing": ["Topsoil"], "proposed": []}, "settings": {"spotOn": {"FG": true, "ME": true, "EG": true}, "spotSide": "proposed", "spotDatum": null, "areaSf": null, "added": true}}, "context": {}, "ui_source": "backfill", "dedupe": "6eb3a19fb47247a13ce390d6540a68d2e53d160f"}
```

`ew_layers_set` — layer stacks changed. `ew_settings_edit` — spot
toggles/side/datum/area changed (`context.changed` names the keys).

```json
{"ts_iso": "2026-08-30T20:39:32", "event": "ew_layers_set", "job": "d6c45228002c", "pdf_sha1": null, "page_index": 2, "engine_sig": "f74c853f3270c297", "schema_version": 1, "before": {"existing": [], "proposed": []}, "after": {"existing": [{"name": "Topsoil", "thickness_in": 6}], "proposed": []}, "context": {}, "ui_source": "webui"}
```
```json
{"ts_iso": "2026-08-30T20:39:32", "event": "ew_settings_edit", "job": "d6c45228002c", "pdf_sha1": null, "page_index": 2, "engine_sig": "f74c853f3270c297", "schema_version": 1, "before": {"spotOn": {}, "spotSide": null, "spotDatum": null, "areaSf": null, "added": false}, "after": {"spotOn": {}, "spotSide": null, "spotDatum": 100.0, "areaSf": null, "added": false}, "context": {"changed": ["spotDatum"]}, "ui_source": "webui"}
```

`boundary_set` / `boundary_cleared` — the limit of work: either a picked
seed chain or the operator's own drawn polygon (real backfilled line —
the Stice hand-drawn boundary):

```json
{"ts_iso": "2026-08-30T16:32:31", "event": "boundary_set", "job": "89d282191aad", "pdf_sha1": "d59be9ead752ad0d7aa15be238bb6c167a1186a5", "page_index": 0, "engine_sig": "f74c853f3270c297", "schema_version": 1, "before": null, "after": {"pts": [[2429.5, 439.5], [2682.6, 1180.7], [2425.9, 1929.2], …]}, "context": {}, "ui_source": "backfill", "dedupe": "f18900b1316ad7604f3c617af6dc495e1e779a51"}
```

`trench_set` / `trench_cleared` — pipe OD, depths, clearance rules (real
backfilled line):

```json
{"ts_iso": "2026-08-30T15:35:51", "event": "trench_set", "job": "7168ef02465d", "pdf_sha1": "ad83b9bd9c79284f01428485f34c933f917db8ff", "page_index": 3, "engine_sig": "f74c853f3270c297", "schema_version": 1, "before": null, "after": {"style_id": 175, "od_in": 6, "d0_ft": 2, "d1_ft": 8, "rules": [{"to_ft": 2, "clr_in": 6}, {"to_ft": 4, "clr_in": 12}, {"to_ft": 99, "clr_in": 18}]}, "context": {}, "ui_source": "backfill", "dedupe": "fc8c8d4717a458932328a0a55756a146a27ce2a0"}
```

`structure_add` / `structure_edit` / `structure_delete` — building
outlines, diffed by name when names are unique on both sides;
`structure_set` (both whole lists) when they are not;
`structure_defaults_edit` when only the depth/layback/footing defaults
moved.

```json
{"ts_iso": "2026-08-30T19:41:52", "event": "structure_add", "job": "b85e2a38dc52", "pdf_sha1": "c5607dabf22f0635f767e7ab954ac10e0183cf44", "page_index": 15, "engine_sig": "f74c853f3270c297", "schema_version": 1, "before": null, "after": {"name": "Structure 1", "pts": [[664.2, 478.2], …], "source": "drawn", "chain_id": null, "gap_pt": 0, "depth_ft": 8, "layback_ft": 4, "footing_ft": 0}, "context": {}, "ui_source": "backfill", "dedupe": "…"}
```

`workzones_set` — work-area quantity-mask boxes (real backfilled line):

```json
{"ts_iso": "2026-08-30T15:35:51", "event": "workzones_set", "job": "7168ef02465d", "pdf_sha1": "ad83b9bd9c79284f01428485f34c933f917db8ff", "page_index": 3, "engine_sig": "f74c853f3270c297", "schema_version": 1, "before": null, "after": [[38.9, 34.7, 1979.1, 2000.7]], "context": {"n_zones": 1}, "ui_source": "backfill", "dedupe": "0ebd9a2b0eb7d72de1667e63dcd330749ad68f37"}
```

`check_done` / `check_undone` — review-queue check-offs ("I looked at
this"), ids only:

```json
{"ts_iso": "2026-08-30T20:39:32", "event": "check_done", "job": "d6c45228002c", "pdf_sha1": null, "page_index": 2, "engine_sig": "f74c853f3270c297", "schema_version": 1, "before": null, "after": {"id": "scale"}, "context": {}, "ui_source": "webui"}
```

### Calculations the operator ran

`earthwork_calc` — one per Calculate press: the configuration's shape
and the volumes the operator was shown (the row-level decisions behind
it are the calcstate events above).

```json
{"ts_iso": "2026-08-30T20:39:32", "event": "earthwork_calc", "job": "d6c45228002c", "pdf_sha1": null, "page_index": 2, "engine_sig": "f74c853f3270c297", "schema_version": 1, "before": null, "after": {"cut_yd3": 13677.0, "fill_yd3": 820.4, "net_yd3": 12856.6, "area_sf": 180422.0, "cell_ft": 2.0, "existing_offset_ft": 0.5, "proposed_offset_ft": 0.0}, "context": {"n_existing": 1, "n_proposed": 1, "n_existing_points": 0, "n_proposed_points": 0, "n_existing_layers": 0, "n_proposed_layers": 0, "strip_area_sf": null, "cut_reuse_pct": 100.0, "has_boundary": false}, "ui_source": "webui"}
```

`structure_calc` — server-side cross-check of the structure calculator:

```json
{"ts_iso": "2026-08-30T20:39:32", "event": "structure_calc", "job": "d6c45228002c", "pdf_sha1": null, "page_index": 2, "engine_sig": "f74c853f3270c297", "schema_version": 1, "before": null, "after": {"totals": {"mass_cy": 329.6, "struct_cy": 118.4, "backfill_cy": 118.4, "slab_sf": 1112.5}, "n_structures": 1}, "context": {"structures": [{"name": "Structure 1", "n_points": 4, "depth_ft": 8, "layback_ft": 4, "footing_ft": 0}]}, "ui_source": "webui"}
```

### Provenance boundaries

`job_reset` — everything derived was thrown away; later events for this
job refer to a fresh detection. `job_deleted` — the job's events end
here and the source went away.

```json
{"ts_iso": "2026-08-30T20:39:32", "event": "job_reset", "job": "d6c45228002c", "pdf_sha1": null, "page_index": null, "engine_sig": "f74c853f3270c297", "schema_version": 1, "before": null, "after": {"counts": {"approved": 1, "report": 0, "detection": 3, "render": 6, "other": 2}, "removed": 12}, "context": null, "ui_source": "webui"}
```
```json
{"ts_iso": "2026-08-30T20:39:32", "event": "job_deleted", "job": "d6c45228002c", "pdf_sha1": null, "page_index": null, "engine_sig": "f74c853f3270c297", "schema_version": 1, "before": null, "after": {"files_removed": 12, "pdf_removed": true}, "context": null, "ui_source": "webui"}
```

## Tools

```bash
# stats without opening files (also GET /api/ledger/stats on the service)
python -c "from takeoff_engine import ledger; print(ledger.stats())"

# import pre-ledger history from the job store (idempotent - run any time)
python tools/ledger_backfill.py --jobs-dir "C:/Users/kobys/takeoff-jobs"

# flatten for training: dotted columns, one row per event
python tools/ledger_export.py --format csv --event chain_excluded --out junk.csv
python tools/ledger_export.py --format jsonl --event style_label
```

Backfill sources: `p<N>_calcstate.json` (through the same semantic
differ the live hook uses), `p<N>_scale.json` (reviewer picks),
`p<N>_elements.json` (approved exports). The original review UI's
label/price/trade memory is **client-side localStorage only**
(`webui/app.js`, `MEM_V`) and never reached the server — it is declared
not-importable rather than faked.

## How this feeds a model later

The features already captured line up with the first three trainable
tasks:

1. **Junk filter.** `chain_excluded` (positive: erased) vs. chains that
   survived into `approve_export` (negative) — with `context.chain`
   (class, width, layer, length_pt, ink_pt, n_dashes, dash_signature,
   n_points) as the feature vector the engine already computes for every
   chain. This is a binary classifier on features that exist today.
2. **Family/label classifier.** `style_label` pairs the engine's
   geometric suggestion (`before.suggested_label`, `context.style`) with
   the human trade label (`after.label`); `chain_relabel` adds the
   harder chain-level cases. Normalizing labels into a trade vocabulary
   is the main data-cleaning step (the legend-sheet endpoint's names are
   a starting vocabulary).
3. **Z-labeler.** `ew_row_add`/`ew_row_edit` pair a contour chain's
   features with the elevation a human confirmed or corrected, and
   `changed: ["z"]` isolates true corrections from confirmations.
   `spotDatum` edits mark sheets where labels needed a datum shift.

Every event carries `engine_sig`, so training can exclude (or bucket)
examples whose features came from a detector that has since changed, and
`pdf_sha1` lets the same drawing's labels be joined across
re-registrations.
