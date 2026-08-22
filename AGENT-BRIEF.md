# AGENT-BRIEF.md — how to think before you change anything

**Read `CLAUDE.md` first.** That file is the working contract: how to verify, how to
report, what not to assume. This file is the layer above it — *how to widen a problem
before you solve it*, so we stop fixing the same idea four separate times.

Paste this into any agent brief, or point at the path. It applies to the lead session too.

---

## 0. What we are actually building

An estimator opens a PDF and redraws every line by hand to get quantities. We are
removing that.

**The bar, in the owner's words:** do what we can **98–100% accurately**; put
disclaimers, checks and safeguards on what we are not confident in; let the human do the
rest manually. It is fine if they still draw or calculate some of it, **as long as the
complete takeoff costs them at least 90% less time.**

Which gives one non-negotiable:

> **Never trade "I don't know, ask the human" for a confident wrong number.**

That is not a slogan. It has already happened: a datum guess turned 136 unresolved spot
grades into **272 confidently resolved grades, every one exactly 200.00 ft high**, on a
grading sheet where 7905.25 looks precisely as plausible as 7705.25. The unresolved state
was the *better* product. A wrong number with no symptom is the most expensive thing this
engine can produce, because it reaches a bid.

Rank harm in this order when you decide what to work on:

1. a wrong quantity that reaches a bid **with no visible symptom**
2. a wrong quantity an alert reviewer would probably catch
3. a missing capability that forces manual work
4. throughput

---

## 1. Before you fix: widen the question

Do this **before** writing code, and put the answers in your report. Most of it is
grep-and-measure, not thinking hard.

1. **Does the document already assert the answer?** See §2. Check this first, always.
2. **Is this defect an instance of a shape?** See §3. If yes, find the other instances.
3. **Does the same bug exist elsewhere?** Grep the pattern, not the symptom. One fixed
   site and five live ones is a worse outcome than it looks, because the fix reads as done.
4. **Which document families does my fix apply to — and which does it silently no-op on?**
   A rule tuned to one drafter's conventions that does nothing elsewhere is *the* failure
   mode here. Confirmed instance: `_SHEET_LAYER` matches the token `TTLB` but not `TTBL`,
   and 42 chains sit on `_IA-Ttbl`. Assume there are more; look for yours.
   Corpus families: Beaumont civil / landscaping / structural, Thielen residential,
   Loves Lane civil, Oncor substation, Belle Farms, Bill's window-door-storefront set,
   GCHC stairs, and the wider `../TakeoffPro AI/` plan corpus.
5. **What is my discriminating margin, and is it thinner than the noise?** If a threshold
   sits between a real case at 2.84 and a false one at 3.25, you are not measuring a
   distinction — you are memorising the corpus. **Stop and find a different signal.**
   Adding one more gate to a stack of five makes it worse, not better.
6. **Is the constant absolute where the thing it measures is not?** A 3.0 pt tolerance
   applied to arcs of radius 8–55 pt gives a big door the same slack as a small one.
7. **What does this cost when it is wrong?** Silent deletion is worse than visible noise.
   Phantom door openings do not just add clutter — they drive `splitAtOpenings`, which
   **deletes whole runs from the takeoff with no symptom**.

If a fix passes all seven, it is probably the right shape. If it fails 5 or 6, the answer
is a different signal, not a better number.

---

## 2. The design principle: the document asserts, we infer only as fallback

> **Prefer what the document says about itself over what we infer from its geometry.**

Drafters write the answer down. Layer names, legend notes, schedule tables, dimension
strings, printed area tags, title-block fields, the drawn scale bar. Read those first.
Geometric inference is the fallback for when the document is silent — never the default.

This was learned four separate times before it was written down once:

| defect | the inference | what the document already said |
|---|---|---|
| spot grades +200 ft | consensus guess at the datum | the legend printed `EXAMPLE: TOP OF PATIO @ 7705.25'` |
| scale 3× / 4× wrong | count the captions, most frequent wins | the drawn dimensions measure 36.00 / 72.00 / 108.00 pt |
| legend row shipped as `> > >` | the glyph nearest the swatch | the CAD layer read `SE-P-FND DRN`, and the description was already parsed |
| doors: 5 geometric gates | fit a circle, apply tolerances | the arc sits on layer `A-DOOR` |

**Caveat you must respect:** layer availability is wildly uneven — roughly **23.2% of
emitted chains have no CAD layer at all**, and three of the ten gate sheets have none
whatsoever. So layer-first means *layer first, geometry as fallback*, never layer-only.
Say which branch fired.

**Circularity trap:** if the detector reads a signal, you cannot score it against ground
truth derived from that same signal. Truth must come from a different source — eye
verification at high zoom, a printed schedule count, a printed dimension, or the client's
own estimate.

---

## 3. The three defect shapes that keep coming back

Do not reintroduce these, and when you find one, check whether the fix generalises.

**A — a proximity test written as a bucket.** `round(coord / TOL)` answers "which bin",
not "are these within TOL of each other". Two items 6.8 pt apart land in different bins if
a bin edge falls between them. That exact case shipped the sheet's most valuable item
(1,449.6 ft of perimeter drain at $31/ft) labelled `> > >`. Fix: sort and walk with a gap
test, or use a radius test for dedup. **A bucket used as a *fingerprint* for counting is
legitimate** — classify each site with evidence, don't convert mechanically.

**B — first-writer-wins.** `dict.setdefault(k, v)` keeps whatever arrived first and
silently discards the rest, with no ranking and no record. The correct drain description
was computed and then lost to a chevron that got there first. Any either/or choice needs
an explicit ranking; keeping the alternatives visible (as `ScaleResult.candidates` does)
beats picking silently.

**C — `0.0` is not `None`.** `x.ink or x.length` treats *measured zero* as *unmeasured*.
Acting on that assumption deleted 80% of every sheet's chains in one attempted fix —
**1,157 of one sheet's 1,429 chains carry `.ink == 0.0` while being ordinary solid lines.**

---

## 4. Prove it on the live app

Engine JSON and overlay PNGs are inputs to a diagnosis, never proof. `CLAUDE.md §1` is
binding; this is the operational recipe.

**The loop:** open the PDF in the app → Detect → read the panels → inspect the canvas →
screenshot the full view **and** a ≥400% crop of the exact region → crop the same region
from the source PDF → put them side by side → **annotate before sending**. Circle every
defect found, and sparingly mark regions checked and clean. Write the set to
`out/verify/<YYYY-MM-DD>/<topic>/` with a `VERIFY.md` naming sheet, page index, region and
what was compared. A raw capture is a working file; the annotated comparison is the
deliverable.

**Verification is a crawl, not a glance.** Isolate the style under test with the app's own
filters, then zoom and pan across the whole region comparing render to original for
completeness *and* placement.

Working recipes, learned the hard way:

- **Restate page numbers both ways** — "engine page index 29 = printed sheet 30".
- Compositor screenshots need `resize_window` first, or the viewport is 0-wide.
- To capture a DOM panel: clone the node and copy the **full computed `cssText`**
  recursively, dropping any declaration containing `url(` (it taints the canvas), then
  render through an SVG `foreignObject`. Copying a hand-picked property list instead loses
  flex layout and produces a capture that **misrepresents the app** — which is worse than
  no capture. Copy `input` values with `setAttribute("value", …)`.
- To blow up a panel for a real screenshot: clone it into a fixed overlay inside the same
  document so the app's own CSS still applies, and scale the wrapper.
- Beaumont PDFs are `/Rotate 270`. `get_drawings()` is unrotated; `get_text()` and
  `get_pixmap(clip=)` are rotation-aware; **`Shape.draw_*` takes UNROTATED space**, so an
  annotation ring must go through `page.derotation_matrix` or it lands in the wrong place.
  Use `takeoff_engine.extract.page_words()`.
- Detect results cache on `(job, page, engine_sig)`. Change an engine module and cached
  results are stale — delete `out/jobs/<job>/p<N>_result.json` and re-detect, or you are
  reading an old screen. The service must also be **restarted** to load changed modules.
- **After drawing an annotation, read the image back.** Circles and captions land wrong
  often enough that this is not optional.

**If the browser and the engine JSON disagree, the browser is the truth and the gap is a
bug to file.**

---

## 5. Measure it wide

- **The gate:** `python -m takeoff_engine.regress`. Expected — chains
  1429/573/749/713/350/314/589/886/2096/927, spikes 1/1/1/1/0/1/0/0/2/0, phantom 0 on the
  first seven and **19 on SWR Guide Civil p3** (known open), mean truth 98.0%, per-class
  precision 100%. Run it **before** committing. Never re-pin a baseline to make a change
  pass; a moved number is a diagnosis you have not done yet.
- **`regress` does not exercise scale at all.** Any scale change ships with a **208-page
  before/after corpus diff**. That has caught three over-reaching fixes the gate could not
  see. Diff **candidates**, not just the chosen value — the chosen-value diff hides
  everything a filter was silently eating.
- **`build_chains` mutates its input stroke units.** Deep-copy per ablation arm, or
  snapshot and replay. Skipping this produced 800–7,000 pt of phantom drift per sheet.
- **OCR is nondeterministic between runs.** Pin words once and reuse across arms.
- Report **gained** and **changed** separately. A gained reading usually needs no review;
  a changed one always does — inspect it by eye and justify it individually.
- Report which sheets moved in **both** directions.
- A template measured from one chain is a sample, not a convention. Say how many
  independent instances agreed.

---

## 6. Report it honestly

- **No number without its ground-truth source, expected value and detected value.** A
  percentage with no denominator is a failed report. When a metric looks perfect, say what
  it cannot see.
- **Say what you did NOT fix**, with numbers. "Still open: 147 chains / 302,300 pt on 75 of
  196 sheets" is worth more than any summary sentence.
- **Name the convention.** The owner is not a construction estimator and cannot catch a
  fabricated industry convention. State it in one plain sentence with its provenance —
  *this sheet's legend* / *general CAD practice* / *inference* — and label inferences.
  If you don't know what a term conventionally means, **say you don't know.**
- **A known defect at merge names its follow-up in the same breath.** If nobody is on it,
  it is not "documented", it is **deferred** — use that word.
- Append one line to `FINDINGS-<date>.md` or the commit message that a fresh session with
  none of your context could pick up.

---

## 7. Never

- **Never tune anything to hit a target number.** When comparing against a client estimate
  or a truth file, that is a *measurement*, not a goal. Selecting layers, filtering chains
  or choosing a scale because the total gets closer is fitting to the answer, and it
  launders overfitting as validation.
- **Never turn an unknown into a guess.** Refusing with a reason is a feature.
- **Never add another gate to a tolerance stack that has run out of margin.** Find a
  different signal.
- **Never blanket-kill `python.exe`.** Port 8100 is the owner's live service. Start your
  own above 8200 and kill **only by PID**
  (`Get-NetTCPConnection -LocalPort N` → `Stop-Process -Id`). One agent killed everything
  and took out two siblings' services.
- **Never claim a fix works from an overlay PNG** — it is generated by the code under test.
- Never land a fix inside a diagnose-only turn, even if the fix is right.

---

## 8. Environment

- `.venv` at the repo root, Python 3.12. **Worktrees have no `.venv`** — use
  `<repo>\.venv\Scripts\python.exe`.
- `export PYTHONPATH="$PWD"`, `PYTHONIOENCODING=utf-8`,
  `PATH="$PATH:/c/Program Files/Tesseract-OCR"`.
- `127.0.0.1`, never `localhost`. Git Bash has no `pkill`.
- **Line endings: `server.py` is CRLF. Every `takeoff_engine/*.py` and all of `webui/` is
  LF.** Check with `file` before and after; a whole-file rewrite that flips them is a
  silent 1900-line diff.
- Corpus: `../client_meet/beaumont`, `../client_meet/Bill`, `../TakeoffPro AI/Plans`,
  `Plans 2`, `Ryno Construction`. Exclude `C4.0-SITE-GRADING-PLAN-Rev.1 (1).pdf` — it is a
  duplicate.
- Ground truth lives in `ground-truth/<sheet>_p<N>.json`. No file means **no score** —
  propose counts for a human to confirm rather than inventing one.
- Work in a worktree, report a `.patch`, confirm `git apply --3way --check` is clean, and
  **do not commit**. The lead applies after gating. Do not push.
