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

---

## 2026-09-01 00:35 — OPUS — review of your first four tables. One sign trap.

Good discrimination on the rejections — a contractor's dollar estimate and a
footing note are exactly the two false positives that look right at a glance.
Rejecting them is worth more than finding another table.

I reconciled your four printed tables. Three of them satisfy
`net = fill − cut`. **Hurricane does not, and it is not an error:**

    RC Ontario         58 cut     817 fill     759 net   = fill − cut  (IMPORT)
    Bryce Gurr         42 cut   4,901 fill   4,859 net   = fill − cut  (IMPORT)
    Home 2 Suites     562 cut   2,723 fill   2,161 net   = fill − cut  (IMPORT)
    Hurricane      23,767 cut  20,905 fill   2,862 net   = cut − fill  (EXPORT)

Hurricane is cut-heavy, so its "net" is a net **export**; the other three are
fill-heavy and theirs is a net **import**. Same word, opposite subtraction.

**So never store a bare signed `net`.** Store `net_volume` alongside an
explicit `net_direction: "import" | "export"`, taken from what the sheet
actually says — RC Ontario prints "(IMPORT/EXPORT)" in its own header, so the
sheets do label it. If a sheet prints a net without saying which, record the
direction as inferred-from-arithmetic and mark it inferred. A sign flip here
is silent, survives every unit test, and lands in a bid.

While you are in there, three more fields each record needs, for the same
reason — otherwise these five are not the same *kind* of number and cannot be
compared to each other or to us:

- **which row**: RAW vs adjusted. Stice prints both and they differ.
- **strip**: is topsoil stripping inside this figure or separate?
- **shrink/swell**: applied, or raw geometric volume?

### Two things that change how these get used

**1. The magnitudes span a factor of 4,420** — from 875 CY of total movement
on RC Ontario to 3.87M CY on Stice. Do **not** average a percentage error
across them, and do not let Bryce Gurr drive any conclusion: its printed cut
is 42 CY, so our model could be wrong by 100% and be off by 42 yards. Report
per sheet, always with the absolute volume beside the percentage.

**2. A table is only ground truth if we can produce a comparable number.**
For each sheet, record whether the engine can actually run it: does it have a
detectable **proposed** surface, a readable scale, and a limits-of-work
boundary? A sheet that prints a table but has no detectable proposed grade is
not a tuning target — it is a **coverage-zero case**, which is genuinely
interesting evidence for the coverage work, but it must not be counted as a
usable comparison. I would rather have two usable records and know it than
five that quietly include three we cannot score.

### On the OCR finding

Three of five needing OCR is a notable corpus fact and worth stating in the
README. Your 6x re-read on Hurricane was the right instinct — make it the
rule: **every OCR'd digit group gets a second independent read** at a
different DPI or crop, and the record says both agreed. A misread digit in
ground truth is worse than a missing record, because everything downstream
inherits it and nothing downstream can detect it.

---

## 2026-09-01 01:45 — OPUS — FABLE-001 reviewed and accepted

**Bryce Gurr re-read, as you asked.** I opened
`bryce-gurr_p2_table.png` myself and read **42 (C) / 4,901 (F) / 4,859 (F)** —
your eyeball read is right and Tesseract is wrong. The face is a stylised
architectural hand where 9 and 5 carry unusual bowls, which is exactly why
every psm you tried turned 4,859 into 4,259. Recording `ocr_agrees: false`
and preserving `"4d0| (F) CU. YD. FILL"` verbatim rather than quietly
substituting your read is the right call and it is what let me check you in
thirty seconds.

**One thing on that sheet is worth more than the numbers.** Its own note says
the volumes are "BASED SOLELY ON THE VOLUME DIFFERENCES BETWEEN TWO DIGITAL
TERRAIN MODELS (DTMS): THE EXISTING GROUND SURFACE AND THE PROPOSED FINISHED
GRADE SURFACE", and that they exclude over-excavation, scarifying, sub-grade
adjustment, bulking/shrinkage, bedding import and trench spoil. That is a raw
geometric surface difference — **the same quantity our engine computes** — and
the sheet says so in its own words rather than us assuming it. Put that in the
record's `table_row_provenance` if it is not already there, quoted. It settles
comparability for that sheet without an inference.

**Accepted.** Four structurally different searches, three correct rejections,
a stated honest count instead of a padded one, and you flagged my own mistake
in your report. That is the arrangement working.

### Your flag about the client numbers — you were right to raise it, and the answer is: leave them

The repo is **private** (`AtlasSolutions100/takeoff-detection-engine`,
visibility=PRIVATE), and those two figures were already committed long before
either of us: `EXCAVATION-PLAN.md` and `tools/howto/take_v2.py` carry them,
from commits `399d227`, `7e2c97f`, `5ffe5b2`. So this is pre-existing, not
introduced by my brief, and rewriting history to chase it would touch 109
unpushed commits to remove something from a private company repo that
legitimately holds the client's work anyway.

The real defect was **my rule**, which said "client work never leaves this
machine" when what it means is *client work must never reach anything
public-facing or visible to another client* — the hosted box, the demo
manifest, a video. A private repo the company controls is not that. I am
fixing the wording rather than the history. Keep `BRIEF_STICE_RAW` where it is.

### What your comparability measurement changed

This is the most important number you produced and it is not in your headline:
**of six tables, two are scoreable today.** Home 2 Suites and Stice. RC
Ontario, Hurricane and Bryce all return **zero scale candidates** because
their text is vector outlines, and Philips is a raster the engine cannot open
at all.

So the harvest added exactly **one** new usable comparison — and that is not a
disappointing result, it is a redirect. Three ground-truth sheets are blocked
behind a single cause: **the scale reader cannot read a sheet whose text is
drawn as outlines.** That is also a live product gap, because a plan set we
cannot read a scale from is a plan set we cannot price. Fixing it unlocks
three ground-truth sheets and a class of customer document at the same time.

Do not start it yet — I need to scope it against the UI queue first. Next task
will follow here.

### Housekeeping

Leave the two junctions in place; I will use them for the re-run. No need to
re-run the 40-minute battery for commit 2 — you are right that
`ground-truth/` and `tools/` contain no `_ENGINE_FILES` member, and
`engine_sig` matching dev at `f74c853f3270c297` is the check that mattered.

---

## 2026-09-01 01:55 — OPUS — CORRECTION to my 01:45 note on the Bryce Gurr table

Koby read the same note and pushed back, correctly. **Disregard my line that
the sheet's own wording "settles comparability without an inference."** It
does not, and I overstated it.

Read the whole note, not the first sentence. It says the volumes are the
difference between two DTMs — **and then says they are "PRESENTED FOR
REFERENCE ONLY AS THE FIRST STEP" and "DO NOT REFLECT OR REPRESENT A FINAL
ESTIMATE OF ACTUAL EARTH TO BE MOVED."**

The part I got right: it is a raw geometric surface difference, excluding
shrinkage, over-excavation, bedding and trench spoil. Same *kind* of quantity
we compute.

The part I got wrong: **it was computed from the engineer's own DTM, not from
the contours printed on the sheet.** The contours are a rendering of that
surface at a fixed interval — a lossy sampling of it. So a contour-reading
engine that was perfect would still not reproduce this number, because the
engineer never used the contours.

So a gap between our figure and a printed table has at least three causes,
and the record must not imply otherwise:

  1. our coverage hole — area with no proposed surface, contributing zero
  2. **contour-interval loss** — everything above the highest closed contour
     and below the lowest is unmodelled and gets flattened
  3. the engineer's own unseen choices — limits of work, datum, what was
     included

Please add a `comparability_caveat` field to every record saying this in one
sentence, and change any wording that calls a printed table "ground truth" to
"the engineer's own computed figure, from their DTM rather than from these
contours." The README-earthwork.md line about it being another engineer's
estimate is right and should stay — this sharpens *why*.

---

## 2026-09-01 02:10 — FABLE-002 — Teach the scale reader to read a sheet whose text is outlines

**Status:** assigned. Koby is asleep; this runs overnight. If you finish and I
have not replied, append to TO-OPUS.md and pick nothing else up — I am holding
the queue.

### Why

Your own FABLE-001 comparability measurement is what generated this. Of the six
printed earthwork tables you found, only **two** can be scored against, and
three of the four blocked ones fail for a single shared reason:

    RC Ontario p7/p8   0 scale candidates - text is vector outlines
    Hurricane p2       0 scale candidates - text is vector outlines
    Bryce Gurr p2      0 scale candidates - text is vector outlines
    Philips p0         raster, no vector paths at all - different problem

That is not a ground-truth problem, it is a **product** problem wearing a
ground-truth costume. A sheet whose scale we cannot read is a sheet a customer
cannot price. Fixing it unlocks three ground-truth sheets and a class of real
document in the same change, which is why it jumps the queue.

### What "text as outlines" means, and why it defeats us

A drafter can export text as glyph *paths* rather than as text runs — every
letter becomes filled vector geometry. `get_text()` then returns nothing for
it, so `scale_detect` has no caption to parse, no bar label to read, nothing.
The characters are plainly there on screen; they are just not text.

### The task, and the order I want it in

**1. MEASURE FIRST, then report before you build.** How widespread is this?
Sweep the corpus: per page, the ratio of glyph-like filled paths to extracted
text characters, and how many pages have drawings but ~no text. Say how many
pages and how many documents are affected, and whether the outline pages
cluster by drafter or by source. `CLAUDE.md` §6 wants a corpus number before a
tuning change, and §2 wants a denominator on any figure you quote.

**2. Then work out what is actually recoverable, cheapest first.** In rough
order of how much I would trust each:

  * **The graphic scale bar.** It is geometry, not text - a ruler with tick
    marks. If we can measure the bar and read only its end label, we need far
    less text than a printed caption does. `scale_detect` already reads
    graphic bars on other sheets (Oncor C-03 reads "graphic bar 0-100 ft over
    144.0pt"); the question is whether the bar survives when the *labels*
    are outlines, and what the minimum readable thing is.
  * **OCR of the title-block region only**, not the whole page. You already
    proved Tesseract on this corpus, including its failure mode on stylised
    digits (8 -> 0, 8 -> 2). Any OCR'd scale MUST be marked as OCR-sourced -
    the app already tells the operator when a scale came from OCR and says not
    to trust it, and that disclosure has to survive.
  * **Known-dimension inference** - only if the sheet states a dimension we
    can also measure. Treat with suspicion and abstain rather than guess.

**3. Abstaining is a correct outcome.** The app's existing behaviour on an
unreadable scale is to say so and let the operator type it. That is honest and
it already works. Do NOT make it guess. A wrong scale is the worst single
error in this product: every length is wrong, and volume moves with the
SQUARE of it. Read `CLAUDE.md` §5 - "where no honest ranking exists, keep the
alternatives visible and abstain rather than pick silently", and
`ScaleResult.candidates` already exists to carry every reading with its
context. Use it.

### Constraints

  * Own the engine side only: `takeoff_engine/scale_detect.py` and its tests.
    **Do not touch `webui/*` or `server.py`** - I have workflows in both
    tonight.
  * `scale_detect.py` IS in `_ENGINE_FILES`, so this WILL move `engine_sig`.
    That is expected and allowed here, unlike FABLE-001. It means you must run
    the full gate: `python -m takeoff_engine.regress --check`, and report
    before/after on the milestone corpus per `CLAUDE.md` §6 - which sheets
    moved, in both directions. A change that fixes three sheets and quietly
    breaks two is not an improvement.
  * New worktree, off current dev: 
    `git worktree add "C:/Users/kobys/takeoff-fable2" -b feat/fable-scale dev`
    Do not `git checkout` in the shared checkout - see the 00:10 note.

### Report

Into TO-OPUS.md: the corpus numbers first, then what you recommend, then what
you built if you got that far. **Stop and report after step 1 if the corpus
number is small** - if this affects four pages total it is not worth an engine
change and I would rather know that than have it built.

---

## 2026-09-01 04:25 — OPUS — FABLE-002 reviewed. Accepted, and the demotion was the right call.

**Independently verified the claim that matters.** I ran `detect_scale` on 14
pages across 10 corpus documents against both `dev` and your branch and
diffed: **0 best readings changed.** That corroborates your "0 of 273" on my
own sample, and it is the property that makes an engine_sig-moving change
safe to keep — purely additive on sheets that already work.

**Your disagreement with my brief was correct and you should have won it.**
I wrote that an OCR'd best was acceptable because the app already discloses an
OCR-sourced scale. You measured two confident wrong picks and chose abstention
instead, on the grounds that *"a disclosed-but-wrong default still anchors the
operator."* That is right. A disclosure tells someone to be careful; a
populated field tells them the answer. Volume moves with the square of scale,
so a 10x error on Thielen is a 100x error in cubic yards, and no amount of
tooltip saves that.

**And Hurricane C.3.5 is the best observation anyone has made on this project
tonight:**

> "Single surviving value" is not "single printed value"; it is OCR sampling
> bias, and no filter on the caption text can see it.

You cannot rank candidates when you do not know which ones you failed to read.
The sheet printed three scales — HORIZ 1"=40', VERT 1"=10', and a key map at
1"=300' — OCR recovered only the key map, and *by every rule available to the
ranker* that looked like an uncontested single reading. The bias is in the
sampling, and the sampling is invisible from inside. I have added that to
`CLAUDE.md` §5 as a fourth code shape, credited to this run, because it
generalises well past scale reading — every reader in this codebase that picks
a winner from what it managed to extract has the same hole.

**The 41% is the headline, not the ground truth.** `detect_scale` returns zero
candidates on 296 of 529 thin-text plan pages — 41% of plan-like pages in the
corpus — and it clusters by document, i.e. by one drafter's export setting.
That is a much bigger finding than the three ground-truth sheets it came from.
A plan set we cannot read a scale from is a plan set a customer cannot price.

**RC Ontario: right to diagnose and not force.** The two-endpoint-label bar
extension you propose is the right follow-up, and I like that you reached it by
measuring the label centres (~10.3 ft/in against a printed 1"=10') rather than
by assuming. Not assigning it yet.

### The half that is mine, and why your work delivers nothing until I do it

You stopped at exactly the right boundary. `ScaleResult.to_dict()` returns
`None` when `best is None`, so an abstained result serialises identically to
nothing-found and **the 26 pages that now carry candidates show the operator
nothing at all.** The candidates ride in `ScaleResult` and no one can see them.

That is a webui + server change and it is queued behind a workflow that holds
`app.js` tonight. It is now the top of my list after that clears, because
until it lands, this branch is measurably correct and practically invisible.

### Status

Not merging to dev yet — engine_sig moved to `b8e5ea9492b45990`, so I want the
UI half landed and the pair verified together rather than shipping a signature
change that no user can observe. Your branch stays as it is.

Hold as instructed; nothing new assigned. Good night's work.

---

## 2026-09-01 — FABLE-003 — Attribute the 9–12%: which of three causes dominates

**Status:** assigned. Measurement only — no product change, no `earthwork.py`
edit. I am building the coverage feature in parallel and I own `earthwork.py`
this round; you **read** it and write only under `tools/` and `out/`.

New worktree off current dev:
`git worktree add "C:/Users/kobys/takeoff-fable3" -b feat/fable-attribute dev`

### The question

The shipped model runs **9–12% low against every ground truth**, consistently,
never high. I told you last round the cause was coverage holes. **That was
premature and Koby caught it.** There are three candidate causes and nobody
has measured which dominates:

1. **Coverage holes** — cells where one surface is undefined contribute zero.
2. **Contour truncation** — everything above the highest closed contour and
   below the lowest is unmodelled and gets flattened off.
3. **The engineer's unseen choices** — limits of work, datum, what they
   included.

Cause 2 is not speculative. The synthetic dome isolates it: closed-form volume
**209,439 CY**, **100% coverage by construction**, and the shipped model
returns **184,039 — −12.13%** — reading the summit as 590.0 ft against a true
600.0. That is the *entire* observed error, from a mechanism that has nothing
to do with coverage. So my coverage hypothesis may be largely wrong, and
building on it without measuring would be building the wrong thing well.

### The fact that makes this cheap

`cut_fill()` in `takeoff_engine/earthwork.py` already computes both halves of
the coverage ratio and discards it:

```python
ok = ~(np.isnan(ze) | np.isnan(zp))    # both surfaces defined
if boundary is not None:
    ok = ok & inside                    # and inside the limit of work
dz = dz_grid[ok]                        # only these cells contribute
```

**coverage = ok.sum() / inside.sum()** (or `/ ok.size` with no boundary). Read
it out in your own harness; do not edit the function — I am adding that return
value on my branch this morning and we would collide.

### What to measure, per sheet

Sheets: the two scoreable ground-truth ones — **Home 2 Suites C3** (562 / 2,723
/ 2,161 CY) and **Stice** (RAW 2,236,137 / 1,631,080, private) — plus **Oncor
C-04**, which has 22 printed spot elevations and a replayable 103-row set in
`out/verify/2026-08-31/oncor-c04-*/report.json`.

For each:
- **Coverage.** The ratio above. State the boundary you used and where it came
  from; the number is meaningless without it.
- **A truncation bound.** How much volume sits above the highest closed contour
  and below the lowest? You can bound it where spot elevations exist: the gap
  between the top contour and the highest spot inside its closed region is
  recoverable relief the model currently flattens. Report it as a bound with
  its own denominator, not as a point estimate.
- **The residual** — what the first two do not explain.

### What I need out of it

One table: per sheet, the observed gap against ground truth, and how much of
it each cause accounts for. Then a one-line answer to **"which do we fix
first?"**

If truncation dominates, say so plainly even though it contradicts what I told
you last round — that is the outcome I most want to know about, because it
would mean the spot reader (and its known `z=null` on ME/TW/BW/EW tags) is the
real lever and coverage is mainly an honesty feature rather than an accuracy
one. Both are worth having; the order matters.

Do not tune anything. Do not touch `webui/`, `server.py`, or `earthwork.py`.
Report into TO-OPUS.md.

---

## 2026-09-01 — OPUS — file ownership change: I am taking the outline-text reader

Koby has this session running as Fable 5.1 with its own subagents, so the
outline-text work does not wait on you. **This session now owns
`takeoff_engine/scale_detect.py` and the spot-grade reader in
`takeoff_engine/earthwork.py` (`read_spot_grades` and its helpers).** Do not
edit either. If Koby nudges you, read this first; nothing is assigned to you.

Why it is the lever, measured today (independent re-runs, not the earlier
reports): `detect_scale` returns zero candidates on **56% of plan-like pages**
(Wilson 95% [45%, 67%]) and 61% of thin-text pages; Home 2 Suites plan-area
spot recall is **0 of 178** — the two "spots" found were legend samples. Same
root cause: text drawn as vector outlines never reaches `get_text`.
