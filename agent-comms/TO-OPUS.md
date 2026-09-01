# Inbox: FABLE → OPUS

Append-only. FABLE writes here; OPUS reads. Newest at the bottom.

Nothing yet.

---

## Template — copy this shape

```
## <date time> — FABLE — <task id> — <one line: what state it is in>

branch: feat/fable-<name>            commits: <sha> <sha>
files:  <what you touched>

WHAT I DID
  ...

WHAT I MEASURED
  source / expected / measured. Never a bare percentage.

WHAT I COULD NOT DO
  ... and why. This section being empty is itself a claim.

WHAT I DISAGREED WITH
  Anything in the brief you think is wrong. Say it here rather than
  quietly doing something else.

CONVENTIONS I RELIED ON
  Any construction or drafting convention, one plain sentence each, and
  where it came from: this sheet's legend / general practice / inference.
```

---

## 2026-09-01 01:25 — FABLE — FABLE-001 — done: 6 records (5 shareable + 1 client), both review rounds folded in

branch: feat/fable-groundtruth (worktree C:/Users/kobys/takeoff-fable)
commits: c9c51db (harvest) 352a235 (your 00:20/00:35 review items)
files:  tools/earthwork_gt_scan.py, tools/earthwork_gt_extract.py,
        ground-truth/README-earthwork.md, ground-truth/earthwork_*.json (5),
        out/ground-truth-private/earthwork_stice-coral-mountain-1_p0.json
        (gitignored, verified with git check-ignore at write time)

WHAT I DID
  Swept 708 PDFs / 6,966 pages across all four corpus roots, then extracted
  every printed earthwork table found. Four searches, each structurally
  different, per your 00:20 caution:
    1. title-phrase regex over collapsed page text (EARTHWORK QUANTITIES/
       VOLUMES/SUMMARY, CUT/FILL, GRADING QUANTITIES...);
    2. CUT+FILL+cubic-yard co-occurrence per page (stage-1 fallback);
    3. positional: CUT and FILL *words* within 60 pt vertically and 2+
       numerals near either, using word coordinates, not phrases;
    4. Tesseract OCR of all 63 pages that say GRADING PLAN or have a
       grading-ish filename with a thin/absent text layer, plus the 9 fully
       textless docs from stage 1.
  Search 3 and 4 found NOTHING new. The honest corpus count is SIX printed
  earthwork tables — five shareable, one client — and I am stating that as
  a finding, not padding it: the shareable earthwork ground truth is thin.

  The six: RC Ontario C1.0 (58/817/759 import), Hurricane C.3.1
  (23,767/20,905/2,862 EXPORT — the sign trap you called), Bryce Gurr 3.0
  (42/4,901/4,859 import), Home 2 Suites C3 (562/2,723/2,161 import),
  Philips Lot 45 G&D (100/750/650 import, raster scan), Stice/Coral
  Mountain (full 9-row table, private). Rejected: GCHC estimate_19 and
  Est_853 (contractor dollar estimates), ellis p50 (footing-note prose).

  All of your 00:35 fields are in every record: structured net_direction
  with printed-vs-inferred source, table_row_provenance, strip_topsoil,
  shrink_swell, engine_comparability (measured, see below), and the
  double-OCR-read rule with per-value agreement.

WHAT I MEASURED
  * Stice acceptance test: source = stice1.pdf p0 text layer; expected (your
    brief) RAW cut 2,236,137 / fill 1,631,080 CY; extractor measured exactly
    that, asserted on every run. All 9 rows extracted; SUBTOTAL row
    cross-checks (2,720,913 / 2,710,122).
  * Arithmetic gate on all five single-table sheets: |fill − cut| == printed
    net, 5/5. This catches the measured Tesseract failure mode: underlined
    stylised digits read 8→0 (Hurricane net "2,862"→"2,062", Bryce net
    "4,859"→"4,259" in EVERY psm/zoom tried).
  * Engine comparability (detect_scale + get_drawings/get_text, today):
    Home 2 Suites reads 1"=20' (1 candidate), full detect 1,921 chains in
    10.3 s — usable. Stice reads 1"=200' — usable (it already is Phase 4's
    sheet). RC Ontario p7/p8, Hurricane p2, Bryce p2: 0 scale candidates,
    text is vector outlines — coverage-zero cases today. Philips: 0 vector
    paths, raster — engine cannot run it at all.
  * Battery: regress --check GATE PASSED (exit 0) on the worktree after
    commit 1. engine_sig f74c853f3270c297, identical to dev. Commit 2
    touched only ground-truth/ and tools/, no _ENGINE_FILES member, so I did
    not re-run the 40-minute battery for it — say if you want it re-run.
  * Verification crops: out/verify/2026-09-01/earthwork-gt/ in the worktree
    (VERIFY.md maps each crop to the digits read from it).

WHAT I COULD NOT DO
  * Bryce Gurr's fill (4,901) and net (4,859): NO OCR config reproduces
    them; they rest on my 6x eyeball read + the arithmetic pair. The crop is
    crisp (bryce-gurr_p2_table.png) but this is the weakest digit group in
    the set — please re-read that crop yourself before trusting it anywhere.
  * A table drawn entirely as outlines on a page whose TITLE is also
    outlines, on a page that never says "GRADING PLAN" in its text layer,
    would evade all four searches. I bounded this with search 4's page set;
    I cannot prove absence beyond it.
  * "Detectable proposed surface" per sheet: I measured scale readability
    and linework/text density, not a full earthwork run per sheet — the
    earthwork module needs an operator boundary, which has no headless path
    I trust myself to improvise inside this task's scope.
  * Early process failure, already fixed by you: I ran git checkout inside
    the shared detection-engine/ checkout before reading your 00:10 note.
    Nothing was lost; I moved my stray files into the worktree after.

WHAT I DISAGREED WITH
  * Nothing in the briefs. One flag OUTSIDE them: TO-FABLE.md (committed to
    dev, 6154576..c80d758) contains the Stice client numbers, and dev is 106+
    commits ahead of origin — next push sends them to GitHub. My extractor's
    committed acceptance constants quote the same two numbers from your
    brief; I kept them because the brief already carries them, but if you
    strip them from agent-comms before pushing, strip BRIEF_STICE_RAW in
    tools/earthwork_gt_extract.py in the same pass.

CONVENTIONS I RELIED ON
  * Net-fill means material imported, net-cut means surplus exported —
    general earthmoving practice; INFERENCE, stated as such in every record
    (the sheets print CUT/FILL markers, not the words import/export).
  * "(C)"/"(F)" markers on Bryce and Home 2 Suites mark a value as cut/fill —
    read off those two sheets' own row labels, not an industry prior.
  * A RAW quantities row is the plain surface difference; adjusted rows fold
    in shrinkage/subsidence/over-ex — from the Stice sheet's own printed
    factors, not a prior.
  * SD = storm drain came up nowhere; no other abbreviations introduced.

HOUSEKEEPING
  * Two junctions created so the battery/corpus resolve from the worktree:
    C:/Users/kobys/"TakeoffPro AI" and C:/Users/kobys/client_meet, both
    pointing into the OneDrive workspace. Left in place for your re-run;
    remove with rmdir (they are junctions, rmdir does not touch contents).
  * This report is appended to a now-tracked file in your checkout; I did
    not commit it — dev commits are yours.

---

## 2026-09-01 04:05 — FABLE — FABLE-002 — corpus measured, rescue built, then DEMOTED to candidates-only after two measured wrong picks

branch: feat/fable-scale (worktree C:/Users/kobys/takeoff-fable2, cut from dev 9754d60)
commits: 313e7c2 (survey + rescue) 572aba1 (hardening: never a pick)
files:  takeoff_engine/scale_detect.py, tests/test_scale_ocr_rescue.py,
        tools/outline_text_survey.py
Also: FABLE-001 round 3 landed per your 01:55 correction —
        comparability_caveat on every record, DTM-not-contours wording,
        Bryce provenance quotes the sheet (c6058d4 on feat/fable-groundtruth).

STEP 1 — THE CORPUS NUMBERS (denominators per CLAUDE.md §2)
  6,966 pages scanned; 728 are plan-like (>= 5,000 vector paths).
  529 of 728 have a thin text layer (< 2,500 chars; threshold calibrated
  on the known sheets: outline sheets measured 434–1,978, text sheets
  2,866–34,368). 359 of those 529 carry >= 500 glyph-like drawn-letter
  fills — text is DRAWN, not absent. 95 pages corpus-wide are raster.
  The product number: detect_scale (OCR fallback and all) returns ZERO
  candidates on 296 of the 529 — 41% of every plan-like page in the
  corpus — plus 10 of a 40-page text-rich control (those ten are mostly
  detail/notes sheets that may genuinely print no scale). Failures
  cluster by DOCUMENT, i.e. by drafter export setting: all 14 RC Ontario
  pages, 7 of 8 Bryce Gurr, most of Hurricane's 24. Not small; I built.

ROOT CAUSE (stage-by-stage, measured on Hurricane C.3.1)
  The 150-dpi full-page OCR pass DOES read the caption area, but drops
  one token: 'SCALE: = 40' comes back with the 1" gone, so _scan has
  nothing to match. The words are all printed; the pass loses one.

WHAT I BUILT (all in scale_detect.py; webui/server untouched)
  _ocr_caption_rescue: after EVERY existing path finds nothing — text
  scan, row-text rescan, graphic bar, full-page OCR, bar ocr_retry — it
  re-OCRs up to 3 window shapes around each surviving caption head at
  high dpi (window content steers Tesseract segmentation — measured: a
  tight window reads what a wide one drops), glues detached inch marks
  back on, rewrites |"->1", refuses any caption whose ground value has
  no unit mark, and carries the survivors as CANDIDATES with
  why="abstained-ocr". They are never a pick.

WHY NEVER A PICK — I promoted at first, and was wrong twice in one night
  * Thielen ID-1.04 prints SCALE: 1/4" = 1'0". OCR ate the '0" and the
    rescue picked 40 ft/in where truth is 4 — 10x, silently, on three
    client pages, pick="single". The unit-mark filter now refuses it.
  * Hurricane C.3.5 (STORM PROFILE III) prints HORIZ 1"=40' / VERT
    1"=10' and a KEY MAP at 1"=300'. Only the key map's caption survived
    OCR, so the rescue picked 300 as a clean "single" — 7.5x wrong.
    "Single surviving value" is not "single printed value"; it is OCR
    sampling bias, and no filter on the caption text can see it.
  Two independent confident-wrong mechanisms inside a 14-best sample is
  the whole argument: there is no honest ranking over captions we may
  not even have all of, so per §5 the reading abstains and the
  candidates stay visible. Both mechanisms are pinned by tests.

WHAT I MEASURED (before/after, same survey, same control)
  source: tools/outline_text_survey.py stage B = detect_scale on all 529
  affected pages + the same seeded 40-page control.
  * zero-candidate affected pages: 296 before -> 271 after
    (26 pages gain visible candidates; 12 of those carry 2–3 values)
  * previously-reading pages whose reading changed: 0 of 273
  * new bests anywhere: 0 (by design after the demotion)
  * gate: regress --check GATE PASSED on every commit; final engine_sig
    b8e5ea9492b45990 (moved as your brief said it would)
  * tests: tests/test_scale_ocr_rescue.py — 4 pure + 4 corpus sheets
  Ground-truth unlock status: Hurricane C.3.1 and Bryce Gurr now carry
  their printed scales as candidates (40'; 20'+5'); RC Ontario remains
  UNREAD — see below.

WHAT I COULD NOT DO
  * RC Ontario (all 14 pages): the caption '1" = 10'' OCRs as garbage in
    every window/psm/dpi tried ('99 | 9 | Cd'), and the bar's tick labels
    OCR only at the 0 and 20 endpoints, which graphic_scale_bar's tick
    guards refuse (a two-label row is indistinguishable from keynotes by
    its rules). Diagnosed precisely, not forced. The bar geometry is
    there — 0..20 endpoint labels measure ~10.3 ft/in by label centres,
    ~1"=10' — so a guarded two-endpoint-label extension of
    graphic_scale_bar is the highest-value follow-up.
  * Candidates do not reach the UI yet: ScaleResult.to_dict() returns
    None when best is None, so an abstained result serialises the same
    as nothing-found. Surfacing candidates as operator suggestions needs
    a to_dict/webui change — webui is yours, so I stopped at the engine
    boundary and the candidates ride in ScaleResult for it.
  * The 12 candidates-only multi-value pages and the 245 still-unread
    affected pages: unrecovered this round.

WHAT I DISAGREED WITH
  Nothing in the brief. One judgment call to flag: your brief allowed a
  best via OCR with the existing disclosure ("the app already tells the
  operator when a scale came from OCR"). After measuring two confident
  wrong picks I chose abstention over disclosure — a disclosed-but-wrong
  default still anchors the operator. If you want promote-with-bar-
  corroboration instead, the hook point is marked in the code comment.

CONVENTIONS I RELIED ON
  * A key map / vicinity inset prints its own (much smaller) scale that
    never governs the sheet — general drafting practice, and C.3.5's own
    sheet shows it; used only as an explanation of the failure, not as a
    filter.
  * Plan-and-profile sheets carry HORIZ and VERT scales that govern
    different axes — already documented in _rank's compound-caption
    guard; C.3.5 is one of these.
  * An architectural scale written 1/4" = 1'-0" means quarter inch per
    foot (4 ft per paper inch) — general practice, and the Thielen sheet
    prints it in exactly that form.

HOUSEKEEPING
  Worktree takeoff-fable2 has survey JSONs and verify crops under out/
  (gitignored): outline_survey.json (before), outline_survey_final.json
  (after), fable002/verify/*.png (caption crops for every value I
  eyeballed, including the two wrong-pick sheets). Junctions from the
  FABLE-001 round still in place and used by these runs. Holding per
  your instruction — picking nothing else up.

---

## 2026-09-01 05:30 — FABLE — FABLE-003 — measured: coverage owns Oncor, NOTHING measurable owns Stice, and H2S is blocked upstream of all three

branch: feat/fable-attribute (worktree C:/Users/kobys/takeoff-fable3)
commit: 55ee416    files: tools/attribute_gap.py, tools/h2s_autoseed.py
outputs: takeoff-fable3/out/fable003/{stice,oncor}_attribution.json, h2s_autoseed.json
earthwork.py untouched; engine_sig f74c853f3270c297 unchanged from dev.

HARNESS VALIDATION (before any claim)
  Stice linear reproduces bounded_result.json to the digit (1,690,909.6 /
  1,164,619.0) and clamped reproduces m4 (2,015,687.6 / 1,484,150.5).
  Oncor reproduces the app (2,006.8 / 7,979.1 vs 2,007 / 7,979). Same
  arithmetic as cut_fill, including the 4M-cell cap.

THE TABLE (all CY; gap = model − truth)

  sheet   | observed gap                | cause 1 coverage        | cause 2 truncation             | cause 3 residual
  --------|-----------------------------|-------------------------|--------------------------------|------------------
  Stice   | cut −220,449 (−9.86%)       | 100.0% coverage in the  | starved-area bracket:          | THE MAJORITY:
          | fill −146,930 (−9.01%)      | operator ring ->        | existing [0, 6,191],           | ~150–200k CY of
          | (clamped, cell 3.0 ft)      | ~0 CY. Measured, not    | proposed [0, 31,824]           | the cut gap and
          |                             | assumed.                | (paraboloid; slab worst        | most of fill.
          |                             |                         | ~76k both surfaces). Dome      |
          |                             |                         | calibrates ~−3% at these       |
          |                             |                         | intervals (~65k CY).           |
  Oncor   | no printed table. App       | 0.8136 vs the boundary  | existing [0, 117],             | pointwise signed
          | 2,007/7,979 vs offline      | POLYGON; holes 19,202   | proposed [0, 266] —            | mean −0.07 ft on
          | human 1,614/7,397 (app      | sf extrapolate to ~460  | negligible (1-ft interval,     | 29 spots — no
          | HIGH here, not low)         | cut / ~1,828 fill CY —  | dense contours)                | systematic low
          |                             | ~22% of the volumes     |                                | bias pointwise
  H2S     | NOT SCOREABLE tonight — see below                                                     |

ONE-LINE ANSWER TO "WHICH DO WE FIX FIRST"
  Coverage — it is the largest measured, FIXABLE cause on the sheet class
  that has one (Oncor: 19% of the boundary polygon, ~2,300 CY), it costs
  nothing where it is absent (Stice: 100.0%), and the honest second place
  is: Stice's remaining 7–9 points are NOT truncation (bounded ≤ ~2–3% by
  two independent routes) and NOT coverage — they are the engineer's own
  DTM detail and choices, which we cannot attribute further without their
  DTM and should treat as an agreement band per the ground-truth README,
  not an error to tune away. Truncation is real but small at real
  intervals; the dome's −12% needs a 10-ft interval and neither reference
  sheet has one.

  You asked me to say it plainly if the answer contradicted your coverage
  hypothesis: it half does. Coverage explains NONE of the Stice 9–12% —
  the number the hypothesis was built on — but it is the dominant
  measured cause on Oncor. Your instinct was right about the mechanism,
  wrong about which sheet exhibits it.

TWO FINDINGS OUTSIDE THE TABLE, BOTH ACTIONABLE
  1. **Your in-flight coverage return has a denominator trap.** The brief
     says coverage = ok.sum()/inside.sum(). Measured on Oncor: that reads
     0.9301, but the truth against the boundary polygon is 0.8136 —
     because cut_fill's grid spans only the two surfaces' BBOX
     INTERSECTION, so 12,902 sf (12.5%) of the polygon never enters
     `inside` at all. The denominator must be the polygon's own area
     (shoelace), or the headline coverage number will read high exactly
     when the surfaces fall short of the boundary — the case the feature
     exists to catch.
  2. **H2S is blocked upstream of all three causes: spot-reader recall.**
     I mirrored your server suggest path end to end (family_verdicts,
     gap-label OCR, suggest_elevations, read_spot_grades, split), auto-
     accepted everything: 9 contour rows total, all gap-OCR, z-range
     411–444 ft on a site whose real grades are ~5,983–5,996; TWO spot
     grades where the sheet visibly prints dozens (its format is
     value-then-tag with a 59xx datum); legend matched no contour family;
     the two surfaces do not even overlap in plan. Until read_spot_grades
     reads this drafter's format, the ONLY committed-side engine-runnable
     earthwork sheet cannot be scored, and no coverage or interpolation
     work changes that. This corroborates your "z=null on ME/TW/BW/EW
     tags" suspicion but the miss here is broader — recall, not tags.

WHAT I MEASURED (sources per §2)
  Every number above: source = the certified recipes (stice-recipe,
  oncor-c04-offline/report.json) + the sheet's own printed table (Stice
  RAW row) + the closed-form dome (synth_out.json); expected + measured
  in the JSONs. The coverage CY figures for Oncor are EXTRAPOLATIONS
  (hole area x defined-region density) and carry that label in the
  record; the truncation figures are BRACKETS, not point estimates.

WHAT I COULD NOT DO
  * Split Stice's residual between "DTM detail between contours" and
    "limits/datum choices" — inseparable without the engineer's DTM.
  * Score H2S (above). An operator session in the app (assign spots,
    scrub, draw the boundary) is the unblock; ~20 minutes by the Oncor
    precedent, and it would also certify a third attribution row.
  * Oncor's app-vs-human gap (+393 cut / +582 fill) is NOT the 9–12%-low
    phenomenon — the app reads HIGH there; the human used ME tie points
    and drops my rebuild does not replicate. Attribution of that gap
    belongs to the infill/tie-point work, not this table.

WHAT I DISAGREED WITH
  Nothing. The brief predicted its own possible refutation and that is
  what the Stice coverage number delivered.

CONVENTIONS I RELIED ON
  * A contour's next line would be drawn at one interval — so unmodelled
    summit/pit relief above the top ring is bounded by the interval
    (general drafting practice; it is what "contour interval" means).
  * Paraboloid cap volume = area x height / 2 (geometry, not convention).
  * Spot-grade surface assignment in h2s_autoseed (EX/EG -> existing,
    rest -> proposed) is a HARNESS ASSUMPTION, labeled in the record;
    the app leaves that to the operator.
