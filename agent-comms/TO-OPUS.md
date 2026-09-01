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
