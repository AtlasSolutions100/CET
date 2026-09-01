# Inbox: OPUS → FABLE

Append-only. OPUS writes here; FABLE reads. Newest at the bottom.

---

## 2026-08-31 — FABLE-001 — Harvest printed earthwork tables into ground truth

**Status:** assigned, not started. This is the critical path — four other
phases are blocked behind it.

### Why this task exists

Our cut/fill model runs **9–12% low against every ground truth we have**,
consistently, never high. We have a strong hypothesis for why (below), but we
cannot confirm a fix, and cannot honestly claim any accuracy number, because
**the project contains exactly one printed volume table to check against.**
The 33 files in `ground-truth/` are door arcs, window tags, highlighter marks
and shear walls — not one grading sheet, not one volume.

So every accuracy claim we make right now is unfalsifiable. That is the
problem you are solving. You are not improving the calculation; you are
building the only thing that can tell us whether an improvement is real.

For context on what comes after, read `../PLAN-2026-08-31.md` §3.

### What to do

Find every sheet in the corpus that prints its own earthwork quantities —
tables titled along the lines of ESTIMATED EARTHWORK QUANTITIES, EARTHWORK
SUMMARY, CUT/FILL SUMMARY, GRADING QUANTITIES — and capture each as a
ground-truth record.

Corpus roots:
- `../TakeoffPro AI/Plans`, `../TakeoffPro AI/Plans 2` — ours
- `../client_meet/` and `../TakeoffPro AI/Ryno Construction/` — **client work**,
  see the split below
- Note `C4.0-SITE-GRADING-PLAN-Rev.1 (1).pdf` is a duplicate; exclude it.

The one table we already have is on the Stice sheet (Coral Mountain grading,
`client_meet/beaumont`): RAW QUANTITIES row, **cut 2,236,137 CY / fill
1,631,080 CY**. Use it to check your extractor gets the same numbers before
you trust it anywhere else.

### Where the records go — read this twice

`ground-truth/` **is committed to GitHub.** A client's bid quantities must
never be pushed there.

- Sheets from `TakeoffPro AI/Plans` and `Plans 2` → `ground-truth/`, committed.
- Anything from `client_meet/` or `Ryno Construction/` →
  `out/ground-truth-private/` , which is gitignored under `out/`. Same format,
  never committed. Verify with `git check-ignore` that the path really is
  ignored before you write a client number into it.

### Format

Read an existing `ground-truth/<sheet>_p<N>.json` first and match its shape
rather than inventing one. Beyond whatever that convention needs, each record
must carry:

- the sheet, the **engine page index**, and the printed sheet number (they
  differ — engine index 3 = printed sheet 4 on most sets)
- the quantities **exactly as printed**, with their units, and which row they
  came from — a RAW row and an adjusted row are different numbers and mixing
  them is a silent error
- the **verbatim text** of the table, so a human can check the extraction
  without reopening the PDF
- any assumption the sheet states: datum, strip depth, shrink/swell factors,
  over-excavation, limits of work
- `"source": "printed on the sheet"` — and if you ever infer or compute
  anything, mark it as inferred. Never blend the two in one field.

### How to read it

Prefer the PDF's own word positions (`get_text` with positions) over OCR, and
say which you used per record. If a sheet is a scan and only OCR works, say
so and flag the record as lower confidence — a misread digit in ground truth
is worse than a missing record, because everything downstream inherits it.

Watch for the trap this codebase has been bitten by repeatedly: a row-grouping
bucket is not a proximity test. `round(y / TOL)` answers "which bin", not "are
these on the same row", and two cells 6.8 pt apart land in different bins
whenever an edge falls between them. That exact shape lost a $31/ft footer
drain its name once already. Sort and walk with a gap test. See `CLAUDE.md` §5.

### Definition of done

- **Five or more** records, or a written statement of how many exist in the
  corpus if there are fewer, with the search you ran to establish that.
- Your extractor reproduces the Stice numbers exactly.
- A short `ground-truth/README-earthwork.md` saying what a record means, and
  stating plainly that a printed table is **another engineer's estimate, not
  truth** — they chose a datum, a strip depth and a limits-of-work boundary we
  cannot see, and two competent estimators routinely differ by 5–15%. We are
  measuring agreement with a professional, not correctness.
- Battery still green; `python -m takeoff_engine.regress --check` passes;
  `engine_sig` must NOT move — you should be touching nothing in
  `_ENGINE_FILES`. If it moves, stop and report.

### Out of scope — do not do these

- Do not change the cut/fill calculation. Not one line of `earthwork.py`
  maths. Measurement only, this round.
- Do not touch `webui/*` or `server.py` — OPUS owns those and is editing them
  right now.
- Do not implement the contour-band method. It was measured and rejected:
  −25.99% / −30.36% against the Stice table where the shipped model is
  −9.86% / −9.01%.

### Branch and reporting

Work on `feat/fable-groundtruth`, cut from `dev`. Commit there; do not merge,
do not push to `main`.

Report into `TO-OPUS.md`: how many tables you found, how many you could read
and how, the ones you could not and why, anything about the corpus that
surprised you, and anything in this brief you think is wrong. OPUS will
review the diff and re-run your extractor rather than taking the report at
face value — that is the arrangement, not distrust.


---

## 2026-09-01 00:10 — OPUS — READ BEFORE YOUR NEXT EDIT: your workspace moved

You ran `git checkout feat/fable-groundtruth` inside
`detection-engine/`. That directory is a **shared working
tree** — my background workflows are running adversarial tests against it and
committing to `dev` from it, so switching its branch pointed all of that at
your branch. A fix of mine committing in the next few minutes would have
landed on `feat/fable-groundtruth` and nobody would have noticed for hours.

Not your fault. The brief told you to work on a branch and never said where,
which is my omission; the protocol now says it explicitly.

**Nothing of yours was lost** — you had not written anything yet.

WHAT I DID:
  * put `detection-engine/` back on `dev`
  * created you a worktree at **`C:/Users/kobys/takeoff-fable`**, already on
    `feat/fable-groundtruth`

WHAT YOU DO NOW:
  * `cd C:/Users/kobys/takeoff-fable` and work there for FABLE-001. Confirm
    with `git branch --show-current` before you edit anything.
  * There is **no `.venv`** in a worktree. Use the absolute path:
    `C:/Users/kobys/OneDrive/Desktop/past/P/Takeoff Automation/detection-engine/.venv/Scripts/python.exe`
  * The plan and this protocol are committed to `dev`, so `git merge dev` or
    just read them from the main checkout — do not copy them around.
  * Never `git checkout` in `detection-engine/` again. If you
    need a different base, make another worktree.

Everything else in FABLE-001 stands unchanged.

---

## 2026-09-01 00:20 — OPUS — housekeeping, and a caution on your stage-1 count

**One file of yours was left in the shared checkout** — `out/earthwork_loose_scan.txt`,
written 00:07:40, just before you relocated. I moved it to
`C:/Users/kobys/takeoff-fable/out/` rather than deleting it; it is 92 KB of
real work. Nothing else was left anywhere: the main checkout is clean of both
tracked and untracked files, `dev` has none of your commits, the owner's job
store at `C:/Users/kobys/takeoff-jobs` was never written to, and you left no
server running. Good cleanup — this was the one straggler and it predates the
move.

**Now the caution, because it affects your definition of done.** Your loose
scan surfaces only two candidate quantity tables in the non-client corpus:

    TakeoffPro AI/Plans/RC Ontario.pdf p0        "ESTIMATED EARTHWORK QUANTITIES"
    TakeoffPro AI/Plans 2/2026.02.13_Civil Design_HURRICANE STORAGE UNITS.pdf p2

Do **not** conclude from that the corpus holds only two. A drafted table's
title and its numbers are frequently separate text runs, and the phrase you
are grepping for may never appear contiguously in the extracted text even when
it is plainly printed on the sheet — the same non-contiguity that makes the
legend reader hard. Your current scan is also very noisy in the other
direction: most of its hits are Division 31 specification-manual headings,
which are prose about earthwork, not quantities.

So before reporting a count, try at least one structurally different search —
for instance, look for the *numbers*: a page carrying two or more large CY
values near each other, or the words CUT and FILL within a short vertical
distance of a numeral. Say which searches you ran either way. "Five or more
records" was my target, not a fact about the corpus; if the honest answer is
two, that is a finding and I want it stated plainly rather than padded.

If it does turn out to be two or three, say so and stop — do not go looking in
`client_meet/` to make the number bigger. Those exist and are usable, but they
go in `out/ground-truth-private/`, and the thinness of the *shareable* corpus
is itself something the owner needs to know.
