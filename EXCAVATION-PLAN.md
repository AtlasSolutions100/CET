# CORE Takeoff — the excavation plan

Handoff for the next long build session. Written 2026-08-28 on branch
`provenance-and-gate`. Read `FINDINGS-2026-08-27.md` first for the state of the
tree and the traps; this file is the *direction*.

---

## 0. The decision

**The product is excavation takeoff.** Most clients and every high-paying
client are excavation/sitework contractors.

This is a **product focus decision, not an architecture one.** One engine, one
buyer. Do NOT fork the engine by trade — that was considered and rejected: the
hard problems (paper space vs model space, xref layers, welded gaps, detail
blocks) are CAD/PDF facts, not trade facts, and forking multiplies the
verification cost, which is already the bottleneck.

An excavator's bid is roughly **40% volume, 60% linear and count**:

```
cut / fill                      CY      \
topsoil strip & respread        CY/SF    |  volume - the least built part
over-excavation                 CY       |  of the engine today
haul off / import               CY, loads/
---------------------------------------------
trench, BY DEPTH BAND           LF      \
pipe by size and material       LF       |  linear - where the engine
structures (MH, inlets)         EA       |  is already strong
erosion control                 LF/EA    |
aggregate / base                CY/SF/TON/
```

So the linear engine stays central. Excavation *adds* a volume path on top; it
does not replace what exists.

---

## 1. Competitive position — measured, not assumed

Verified live on 2026-08-28 in Kreo, on `260603 Thielen Biggerstaff
Residence.pdf` (which is also in our corpus, with ground-truth files).

**Kreo's entire AUTO MEASURE capability:**

```
Rooms and Areas · Doors · Windows · Wall Internal Finishes
Wall External Finishes · GIA · GEA · NIA · Walls · Walls 2.0
```

Every primitive is architectural. GIA/GEA/NIA are gross/net internal area —
commercial building metrics.

**The decisive test.** Kreo correctly classifies page 5 as
`A0.5 TOPOGRAPHIC SURVEY` → category *"Civil Engineering Blueprints"*. Its
classifier is right. Its AI Scope Builder, run on that correctly-identified
topographic survey, produced ~400 line items:

* wall assemblies W1–W4, P1–P3 down to `Sealant at Sill and Top Plates`
* roof assemblies R1–R3, `Glu-Lam Purlin`, `Structural Purlin`
* a 60+ entry window schedule and a door schedule
* MEP down to `Toto Smart Toilet`, `Savaria Vuelift Octagonal Glass Elevator`,
  `Tesla Powerwall`

Searched for excavation: **cut/fill, topsoil, over-excavation, haul, trench,
storm/sanitary pipe, manholes, inlets, erosion control, aggregate — all
absent.** Not one earthwork item in four hundred.

The finding is not "Kreo got it wrong." It is **"Kreo's model of construction
does not contain excavation."**

| | does it do excavation? |
|---|---|
| **Kreo** — AI auto-detect, architectural | **no** |
| **Bluebeam (+Max/Claude MCP)** — you hand-draw every measurement | manual only |
| **Agtek / InSite / Carlson** — real incumbents | yes; desktop, expensive, CAD-heavy |

**Our asset:** automatic civil linework detection from vector PDFs — traced,
classified, layered, scaled. Bluebeam makes you draw every line. Kreo
automates only building elements. Nobody in the AI-takeoff wave is in this
vertical.

### What to steal from Kreo (they are ahead here)

1. **Assemblies / Items** — a structured cost database (Properties → Items →
   Assemblies). Ours is a flat `priceKey` map with a known case bug.
2. **Plan Zones** — region definition. Validates the boundary-box idea.
3. **Compare Pages** — revision diff. Excavators get addenda constantly.
4. **Sheet auto-classification** with sensible categories.
5. **Create report** as a first-class action.

---

## 2. The division of labour — AI vs software

The question "are we using enough AI?" has a precise answer, and it is not
"more AI everywhere."

**The line: software measures, AI reads and reconciles.**

Evidence, from the Contractor OS benchmark (44 questions, one set of
drawings): raster images **86%** accurate at 104k tokens; split + vector text
**98%** at 66k; structured object database **100%** at 1.4k. And explicitly:
*counting from vector data is 100% accurate; asking a model to measure a
length is where accuracy breaks*, because it must infer scale, crop a region
and estimate.

So:

| SOFTWARE (deterministic, gated, verifiable) | AI (judgement over context) |
|---|---|
| trace geometry, chain strokes | name a line from its inline label |
| measure length, area, volume | map legend rows to styles |
| build the TIN, difference surfaces | read rim/invert off a profile |
| count instances | decide which sheets are in scope |
| apply a scale | cross-reference plan ↔ profile ↔ schedule |
| everything with one right answer | **flag contradictions between sheets** |

**AI must never produce a quantity.** It may produce a *name*, a *pairing*, a
*classification*, or a *flag*. Every number comes from the measured geometry.

That line is also what makes 98% defensible: the measured half is gated by
`regress.py`, and the judged half is always presented as a suggestion the
operator confirms — the pattern `ScaleResult.candidates` and the AI panel
already use ("AI suggests measuring this (not applied)").

### Where we are under-using AI today

Currently AI is **one multimodal shot per page** that classifies styles and
reads sheet metadata (`server.py:2519`, sends a base64 JPEG + prompt).
Under-used for:

* **naming** — 43 inline utility codes are now captured on Oncor C-04 and
  nothing uses them (`inline_labels`, committed `6262daf`)
* **legend mapping** — currently a 7.0 pt row-bucket with no column split,
  which is putting general notes on billable footage (defect B5)
* **profile reading** — rim/invert extraction, the highest-value unbuilt thing
* **cross-sheet reconciliation** — the trust feature (see §4)
* **sheet triage** — which of 73 pages matter to this trade

---

## 3. Cut/fill and reading topos — what it actually takes

This is the biggest gap and the highest-dollar number an excavator buys.
**Be honest: this is the least-built, least-verified path in the codebase.**
Zero of 33 ground-truth files assert a volume. `earthwork.py` is not in
`_ENGINE_FILES`. `cut_fill()` has no outlier rejection. A live datum bug puts
171 of 171 spot grades exactly 100 ft low.

### The pipeline required

```
1  detect contour linework                        HAVE (chain.py)
2  attach an elevation to each contour            PARTIAL (gap_label_elevations,
                                                  read_spot_grades) - and A1
                                                  is broken here
3  attach spot elevations                         PARTIAL
4  build a SURFACE (TIN) from 2 + 3               HAVE (LinearNDInterpolator)
5  build a SECOND surface                         MISSING  <-- the big one
6  difference the two over a boundary             MISSING
7  adjust: strip depth, shrink/swell, over-ex     MISSING
```

**Step 5 is the architectural blocker.** Cut/fill is `proposed − existing`.
Existing comes from the topographic survey sheet; proposed comes from the
grading plan. **They are different pages.** The engine currently thinks in
pages; cut/fill requires thinking in *surfaces that span pages*.

That is the same requirement as the object-keyed database in §6 — a surface,
like a manhole, is an object that appears on several sheets. Building one
gets the other.

### Conventions needed — AMENDED 2026-08-30 by Koby

> "I think you can invent these for this demo state, just do some research and
> do most common based on material type or whatever it may vary on and then
> have them overridable." — Koby, 2026-08-30

The rule is now RESEARCH + CITE + DEFAULT + OVERRIDE: pull the industry-common
value with a named source, seed it as an editable default, and show the source
in the UI tooltip. Never bake an uncited number into a computation silently.
A research agent is collecting the table (strip depth, shrink/swell by
material, bank/loose/compacted, over-ex pairing) with citations.

Original list (now to be researched rather than blocked on):

* typical topsoil strip depth (commonly 4–8 in, varies by spec)
* shrink/swell factors by material
* whether their bids separate over-excavation
* whether volumes are bid bank / loose / compacted

CLAUDE.md §4 is binding: state the convention in one sentence and say where it
came from. Koby is not an estimator and cannot catch a fabricated convention.

---

## 4. The first feature to build: structure schedule by depth

**This is the killer feature and it is specified by a real practitioner.**

Source: Griffin Furlong, PE, "Bluebeam Max Just Changed The Engineering
Industry" (video transcript, 2026). He did this by hand-prompting generic
Claude for ~15 minutes and got 99.99% correct — one rim elevation off by 0.01.
Nobody has productised it.

The method, in his words:

```
depth = rim elevation − LOWEST invert          (multiple inverts: always lowest)
manholes are priced BY DEPTH BRACKET           (0–6 ft, 6–8 ft, ...)
DROP MANHOLES are a separate pay item          (different bid line entirely)
a manhole appearing on two adjacent sheets     must not be double-counted
```

Convention source: a practicing civil engineer describing Pasco County FL bid
schedules. **Confirm with Koby's excavators before building to it.**

### The trust feature inside it

His run caught **MH-36 reading rim 50.12 on sheet 24 and 50.60 on sheet 27** —
the drawings disagreed with themselves — and flagged it for field verification
rather than silently picking one.

That is the sellable moment. Not *"we counted your manholes"* but **"your
drawings contradict each other on sheet 24 versus 27."** No competitor offers
it, and it is exactly what our provenance/abstain architecture is built for.

`profile.py` (29 KB, never audited, not in `_ENGINE_FILES`) is suddenly the
most strategically important file in the repo — it is where rim and invert
elevations would come from.

---

## 5. What "98% in all areas" has to mean

Today's 98.0% is **mean truth-class accuracy on linework classification**,
over 10 sheets, against hand-asserted CAD-layer truth. It says nothing about
volumes, counts or depths. Do not quote it as a product-wide figure.

A defensible 98% needs a metric and a ground truth **per deliverable**:

| deliverable | metric | ground truth | exists? |
|---|---|---|---|
| linework class | truth-class accuracy | 33 hand-asserted files | **yes**, gated |
| over-capture | welded/pickup fraction | self-evident (blank paper) | **yes**, gated `ed9f025` |
| structure count | count vs schedule | the sheet's own schedule | no — buildable |
| structure depth | ft vs rim−invert | the profile's own text | no — buildable, self-evident |
| trench length by band | LF per band | derived from the above | no |
| **cut / fill volume** | CY vs hand calc or survey | **nothing anywhere** | **no — expensive** |
| pipe by size | LF per size | layer names + inline labels | partial |

Two of those are **self-evident** — the sheet proves them, so no external
truth is needed (a rim elevation is printed on the drawing; blank paper is
self-evidently not pipe). Prioritise those. Volume is the one that genuinely
needs external truth and it is the expensive one.

**Real bids exist in the corpus and are the scoring material for the money
path:**

```
client_meet/beaumont/Bid sheet,Exclusions,ect.pdf
TakeoffPro AI/Plans/USDA Bid Tab.xlsx
TakeoffPro AI/Plans/Livingston USDA bid 1_9_2026.xlsx
TakeoffPro AI/Plans/Whats missing from bid.docx
```

Caveat: a bid is **not** ground truth. It contains judgement, allowances,
exclusions and contingency, and its scope is a subset of the drawing — the
repo already records 697,036 ft detected against a 7,248 LF bid scope, a 96x
mismatch that is mostly scope, not error. Use a bid as a **once-a-milestone
reality check**, not as a gate.

---

## 6. Architecture — object-keyed, with provenance

Three independent sources converged on this: Koby's own instinct, the
independent audit's structural themes, and the Contractor OS benchmark.

**Today the pipeline destroys information early and irreversibly.** Prune
stages delete, top-k prefilters drop, caps bind — and until last night none of
it was recorded. Later stages see only survivors.

**Target: keep the ledger, not the residency.** Do not keep 61,378 raw ops
resident to produce 589 chains — that makes the payload and renderer worse.
Keep a *record* of every removal (count, reason, region) in the result;
geometry retrievable on demand. Landed for three stages already (`ff6b445`).

### The four roles of text — do not collapse these

Conflating "defines" with "names" is what put
`"2. PROPOSED CONTOURS ARE AT 1 FT INTERVALS. (legend)"` on 5,042.6 ft of
billable footage in a delivered export.

| role | example | what it should do |
|---|---|---|
| **names** a line | `EX-SS` inline in the gaps | highest-authority name |
| **defines** a symbol | a legend row | a vocabulary to match against, ranked |
| **scopes** geometry | `NTS`, a detail title, `SEPARATE PERMIT` | decides whether it counts at all |
| **quantifies** | `220 LF`, a spot elevation | a cross-check on the measured number |

### Replayability — the commercial argument

Reviewer decisions are bound to `chain_id`, a bare counter that renumbers on
any `chain.py` change. `includeKey` is scoped to page + `engine_sig`, so an
engine improvement invalidates include ticks. **Today, improving the engine
destroys in-progress customer work.**

Note the codebase already got the important half right: `labelKey` is
`docKey() + styleFp(st)` — doc-wide, keyed on a style fingerprint, with a
comment saying "that is the capability; do not scope this one to a page." So
**labels survive**. Extend that pattern; do not rebuild it.

A decision log of *semantic* operations ("this run is EX-SS", "exclude
everything inside this boundary", "this leader implies a manhole at its tip")
replays across a re-detect. That converts a better engine from a threat into
an upgrade, and it is what makes a takeoff auditable two years later.

**Known bug in the same area:** `earthwork.py:546` binds cached gap
elevations by `cid` with a distance stamp of 0.5, so after a renumber they
attach to the wrong chains *with high authority*. `cx, cy` are carried but
never used to re-match by position.

---

## 7. Presentation — how it gets sold as excavation software

The UI presents up to 280 undifferentiated style rows and has no opinion about
which matter. An excavator needs perhaps 15 numbers.

1. **Organise the panel around a bid schedule, not a style list.** ~15 line
   items with quantities, not 280 rows. The style list becomes the drill-down.
2. **A confidence-ranked review queue.** Show the 12 things the engine is
   least sure about; present the rest as decided. This is the real 20-hours →
   2-hours lever — if you hand an operator 280 rows to skim, you have moved
   the work, not removed it.
3. **Plan-area boundary (Koby's idea, validated by Kreo's Plan Zones).** One
   drag excludes title block, legend, north arrow and NTS detail blocks. On
   Kayden C5.1 that is 11,808 LF of junk removed in one gesture — and it
   solves the detail-block problem that three automatic detectors failed at.
   Implement as a **quantity mask, not a detection mask**: detect everything,
   let the box decide what counts. Reversible, no recompute, legend and scale
   still readable.
4. **Sheet triage.** 48-page set, the operator knows in 30 seconds which 12
   matter.
5. **Set-level decisions.** Today `includeKey` re-asks per page; excluding the
   title block on sheet 1 should hold for sheets 2–48.
6. **Every quantity states what it is made of.** Shipped for welded gap
   (`f2f7276`); extend to scale source, engine build, and who approved.
7. **A report an estimator can hand to a GC.** Kreo has "Create report" as a
   first-class action; ours is buried.

### Presentational proof for sales

Run our engine and Kreo on **the same page of the same PDF** (Thielen
Biggerstaff p5) and put the two outputs side by side. One returns a window
schedule with zero quantities; the other returns a topo takeoff. That single
comparison is the pitch.

---

## 8. Carried-forward defect list

Ordered for **excavation**, because volume scales with the SQUARE of linear
scale — a 2x scale error is a 4x volume error.

| # | defect | self-evident? | status |
|---|---|---|---|
| A1 | `read_spot_datum` takes the FIRST match, cannot tell a datum from a worked example. Locks onto `EXAMPLE: TOP OF PATIO @ 7605.25'` while the sheet's own contours read 7720–7735. 171/171 grades exactly 100 ft low, `unresolved: 0`, under a green banner. **Live in production.** | **yes** — the sheet contradicts itself | open |
| A5 | earthwork routes call `_page_scale(...)` with no `sent`; the only writer of `p<N>_scale.json` is inside the *approve* route (`server.py:1505`). So a typed scale correction only reaches a volume if you already approved. Dev has 0 sidecars, prod has 1. | **yes** | open |
| A2 | `scale_detect.py:130` admits `:`, so `SCALE 1:100` → 100 ft/in instead of 8.33 (12x). The app's own UI parses it correctly at `app.js:1424` — the engine disagrees with itself. | **yes** | open |
| B5 | legend 7.0 pt row bucket with no column split puts general notes on billable footage — verified in a delivered export | **yes** | open |
| — | `earthwork.py:546` binds cached elevations by renumbered `chain_id` at distance 0.5 | **yes** | open |
| B2 | page total built from a minority of priced rows ("$48,247.65" covering 1 of 37) | **yes** | open |
| B3 | symbol/mark caps truncate then report `pages_pending: []` | **yes** | open |
| B4 | CSV puts an EA row's footage under a `feet` column beside a `$/ft` rate | **yes** | open |
| — | known double-count, `chain.py:860-937` — now measurable via `pickup_pt` | **yes** | open |

**None of these need ground truth.** The sheet, or the code's own
self-contradiction, proves each one. Fix them before building new measurement.

---

## 9. Non-negotiables for the next session

* **`python -m takeoff_engine.regress --check` after every engine change.**
  It exits 1 on regression. Baseline in `gate-baseline.json`. Tests in
  `tests/test_gate.py` (`python tests/test_gate.py`).
* **Recall does not gate, deliberately** — it clamps at 1.0 so duplicated ink
  raises it. Gate on `welded_frac`/`pickup_frac` instead. If you ever make
  recall a gate, you pin the double-count in place forever.
* **Live UI pass with an ANNOTATED capture** for anything an operator sees.
  Overlay maths must apply `IMG_DPI / 72 = 1.80556`. Take a second screenshot
  after a DOM change; the first catches the pre-paint frame.
* **Never write `state.view` to navigate.** Scroll and drag.
* **No accuracy figure without ground-truth source, expected and detected.**
* **Page numbering:** engine 0-based index AND the sheet number *printed in
  the title block* — not index+1.
* **Never invent an estimating convention.** Cite it or ask.
* **Production is `v1.6.2` and untouched.** Nothing ships without Koby.

---

## 10. Suggested order

1. **A1, A5, A2** — the scale/elevation cluster. Self-evident, contained,
   and they are what excavation depends on. A2 under the gate.
2. **The AI bake-off harness** (§11) — decide the offline model with numbers.
3. **Structure schedule by depth** (§4) — the killer feature.
4. **Cross-sheet reconciliation** — the trust feature, falls out of 3.
5. **Plan-area boundary mask** (§7.3) — cheap, high value, solves the
   detail-block problem three detectors failed at.
6. **Two-surface cut/fill** (§3 step 5) — the big one; needs the object model.

---

## 11. The offline-AI bake-off (specced, not built)

`analyze` is **multimodal today** — `server.py:2519` sends a base64 JPEG plus
the prompt. Going offline therefore needs a *vision* model, which is heavy:
production is 31 GB / 8 cores / **no GPU**, and a VLM there would take minutes
per page with worse quality, because these models downsample and drawings are
detail-dense.

**Change the task before changing the model.** The image is in that prompt
because there was nothing better at the time. There is now: vector text,
styles, layers, legend rows, provenance, drop ledger. A text-only prompt over
structured input probably does the job better *and* runs fine on 8 CPU cores —
which is exactly the 86% → 98% → 100% progression in the Contractor OS
benchmark.

Provider plumbing already exists: xAI → Groq → Anthropic at `server.py:2448`,
with the Groq path OpenAI-compatible. **Ollama exposes an OpenAI-compatible
endpoint, so this is a base-URL + model-name change, not a rewrite.**

The harness should score, on the same ~20 pages, against the same rubric:

```
baseline   Anthropic multimodal (today)
B          Qwen2.5-VL 7B, local, multimodal
C          Llama 3.2 Vision 11B, local
D          Qwen2.5 14B TEXT-ONLY over structured input   <-- the interesting one
```

**Claim wording matters legally** — there is a published Privacy Policy.
Today, page images go to a third-party AI provider and the policy must say so.
With Ollama on the VPS the honest claim is *"your drawings are never sent to
an AI provider"* — **not** "never leave our infrastructure," because Hostinger
still holds the disk. Only self-hosted hardware (e.g. an M4 Mac Mini, which
runs a 7–11B VLM at usable speed) supports the stronger sentence.

---

## 12. Sources for the conventions cited here

* Griffin Furlong PE — *"Bluebeam Max Just Changed The Engineering Industry"*:
  depth = rim − lowest invert; depth brackets; drop manholes as a separate pay
  item; cross-sheet double-count risk; the MH-36 rim disagreement.
* Griffin Furlong PE — *"Cleanest Way to Do Quantity Takeoffs in Bluebeam"*:
  the subject field drives legend grouping; **mixing `feet` with `feet-inches`
  splits a legend row in two** (same class of bug as our CSV EA/feet column);
  colour-by-size; per-sheet quantities with a summary on the cover.
* Contractor OS — *"How to Get AI to Read Construction Drawings"*: object-keyed
  database over page-keyed; reliability stored per measurement; counting from
  vector is exact while scaled measuring is where accuracy breaks;
  86% / 98% / 100% at 104k / 66k / 1.4k tokens.
* **US survey foot is a red herring for scaled PDF takeoff** — it differs from
  the international foot by exactly 2 ppm (0.3048 m vs 1200/3937 m). On
  150,000 ft that is 0.3 ft; on 10,000 CY, 0.06 CY. It matters for state-plane
  coordinates in the millions of feet, not here. If a number differs
  materially, USFT is not the cause — but the app should still **declare its
  convention**, because an estimator currently cannot tell a bug from a
  method difference.

---

## 13. What the clients actually asked for

Nine feedback items to 2026-08-28. This is the highest-authority input in this
document — it is the buyers, in their own words, and it **independently
confirms most of the plan above while adding two features nobody had thought
of.**

### Scale is the number one pain: 3 of 9 items

> **BLOCKED** — jeff.ecifoundations@gmail.com, Thomas_Lot-121 p17, scale 1/4" = 1'
> *"The scale is not working. The selected line should be 24' but is showing
> 9'. I wonder if you can make it so that the scale can be entered manually
> based on a selected line."*

**NEW FEATURE — calibrate scale from a line of known length.** Every
competitor has this (Bluebeam, Kreo, PlanSwift). We do not. The operator draws
across something whose dimension they know, types the number, and the page
scale is derived. Most-requested missing capability, and it is small.

Note: production carries exactly one scale sidecar - engine index 16 = printed
page 17, this exact sheet - written at 17:03:54, six minutes after this
feedback. **He wanted to calibrate from geometry and had to guess a fraction
instead.**

> **BLOCKED** — klayton@minersunderground.com, a bridge/span sheet, no scale
> *"I do not have a scale on the sheets, however there are station numbers on
> the sheet that tell the footage. It gets hung up on no scale legend."*

**NEW FEATURE — derive scale from stationing.** Civil plans print stations
(10+00, 11+00 ...) along the alignment, 100 ft apart by convention. That is a
ruler printed on every plan-and-profile sheet. Find two station labels, measure
the point distance, divide. Needs no legend, no scale bar, no caption.

*Convention, general civil practice: a station is 100 ft, written STA 12+50
meaning 1,250 ft along the alignment. **Confirm with Koby's excavators before
building.*** No competitor derives scale this way because it is civil-specific.

With the three engine scale defects (A1, A2, A5), scale is unambiguously first.

### Depth banding — confirmed by the client, in his own words

> **jpierce@piercesitework.com**, Kayden Springs p40
> *"I need it to separate the vertical and horizontal scale for the profile
> view of the sewer line. Calculating the sewer quantities it needs to be put
> into 2' depth increments. For example 6'-8' deep, 8'-10' deep, etc."*

Two independent sources now confirm depth-band pricing: Griffin Furlong PE
(manholes by bracket) and Pierce (trench in **2-foot** increments). Build to
2 ft and make it configurable.

**AND THIS REFRAMES THE DUAL-SCALE FEATURE.** #5 was built to satisfy this
request. It was the wrong mechanism: it rescaled the *whole page*, destroying
18,904 ft to buy 1.6 ft (see 0c01c80), and **it still would not have given him
depth bands.** He does not want the page rescaled. He wants:

```
read the profile  ->  ground elevation and invert along the pipe
                  ->  depth = ground - invert, sampled along the run
                  ->  band it: 0-2, 2-4, 4-6, 6-8, 8-10 ...
                  ->  report LF per band, per pipe size
```

That is profile.py plus banding, and it is the same machinery as the manhole
depth schedule in section 4. **Build that, not a page rescale.**

### Structures — confirmed

> **jpierce**, Kayden p39, category missed-lines
> *"The software missed the manhole. See the legend on the right to see an
> example of the manhole symbol."*

Note the method he expects: **match the legend's symbol.** The legend defines
the symbol; find its instances. That is the "defines a symbol" role doing real
work.

### Pipe by size — confirmed

> **jpierce**, Kayden p39, category wrong-quantity
> *"Combined the 8" and 12" sewer line into one item. It would be preferable if
> it was separated into two different line items."*

Only ~9% of pipe styles carry the size in the CAD layer name, so this needs the
inline-label capture (6262daf) plus nearby-text association.

### Sheet management — confirmed

> **christian@radiantaisoftware.com**
> *"I want to be able to reorganize the pages on the left so that the ones I
> work on show up first, also if I could custom name them, that would be
> great."*

### Already shipped

> **zach@winkelmansitework.com** — crosshair cursor on tool select. Done.

### What the feedback does NOT say

Nobody asked for cut/fill. That is not evidence it does not matter - it is
evidence they have not tried, because the app cannot do it and the scale is
broken underneath it. But note that **every single thing they DID ask for is
achievable without the two-surface work.**

---

## 14. Revised order, after the client feedback

1. **Scale, all five parts** — the #1 client pain, the foundation of every
   quantity, and volume moves with its square:
   * A1 datum (self-evident, live in production)
   * A2 1:100 misparse (self-evident, under the gate)
   * A5 earthwork never sees a corrected scale (self-evident)
   * **calibrate from a known line** (client-blocked, small)
   * **derive from stationing** (client-blocked, civil differentiator)
2. **Profile reading -> depth** — rim/invert/ground elevation. Unlocks Pierce's
   2-ft trench bands AND Griffin's manhole depth brackets from one build.
3. **Structures from the legend symbol** — Pierce's missed manhole.
4. **Pipe by size** — inline labels plus nearby text.
5. **Sheet triage and reordering** — cheap presentation win.
6. **Plan-area boundary mask** — solves the detail-block problem three
   automatic detectors failed at.
7. **Two-surface cut/fill** — the big one; needs the object model and ground
   truth that does not exist yet.

Items 1-5 are all things a paying client explicitly asked for, and none require
the volume architecture. Fastest route to "this software does my job."

---

## 15. Independent excavation audit — 13 agents, adversarially refuted

Run 2026-08-28. Six diagnoses, each attacked by a refuter. **Five of the six
were refuted in some material way; one survived intact.** Every number below
was re-verified on disk by the refuters. Read this before building anything.

### The ranked list

| # | item | effort | self-evident? |
|---|---|---|---|
| 1 | **Repaint the stale-volume warning when the scale changes.** `renderEwStale()` has ONE call site (`app.js:5852`, inside Calculate). Every scale change goes through `scaleRepaint()` (`:1657`), which never calls it — so Calculate → fix the scale → the stale CY re-render as priced rows **with no banner at all**. | 1 line | yes |
| 2 | **Stop a second pipe run deleting the first.** `app.js:6239` filters `state.extraItems` by label prefix with **no style check**, so a job with sanitary + storm + water + force main holds one of four at a time. Estimate #853's nine per-LF utility lines total **$224,200**. | 1 line | yes |
| 3 | **The datum abstain rule.** See §8 A1. **BUILD THIS FIRST.** | M | yes |
| 4 | **Make `cut_fill` disclose, and refuse crossing contours.** Accepting ONE engine-suggested row that is actually a 10-inch water main moves cut/fill **+$81,438 (+41.9%)**. One contour label off by an index step: **+$132,767 (+68.4%)**. 20% of the counted area sits more than 50 ft from any data point; the biggest triangle spans 412.8 ft of ground as one flat plane. A crossing-contour check costs 0.16–0.56 s and fires **0 times** on clean data. | M | yes |
| 5 | **Give the trench tool a consent gate.** Earthwork and structures both require an explicit Add; trench writes priced rows the moment you press Calculate. The app's own comment states the rule it breaks. | hours | yes |
| 6 | **Two trench arithmetic guards.** 100 LF at 1.0 ft deep returns dig 5.6 CY and **bedding 7.6 CY** — 137% of the hole it is supposed to sit inside. And 4.00 ft → 4.01 ft moves excavation **+40.3%**, because the bedding-width table is a step function on instantaneous depth. | hours | yes |
| 7 | **Let the volume routes READ a typed scale without writing it.** Honest incidence: **0 of 114 pages have a scale sidecar and 0 of 16 approvals produced one** — this is insurance, not a live wound. | S | yes |
| 8 | **Calculators above the style list, and scroll to the panel you opened.** 12,220 style rows across 114 results (median 73, p90 212, **max 462**). There are exactly two `scrollIntoView` calls in 8,999 lines and neither is a panel handler. **LIVE** | M | yes |
| 9 | **Make the limit of work a real boundary.** Barn C3.0's own `BG-Limit of disturbance` layer is **10 chains, none of them closed**; the longest is 361 ft with its two ends **342.9 ft apart**. The picker takes exactly one chain and joins its ends silently, giving 4,730 SF against this estimator's own `Clear & Grub 224,058 SF`. A **20–100× under-read**, returned as a normal success. **LIVE** | M | yes |
| 10 | **Un-weld the topsoil strip from cut/fill.** `server.py:2924` raises HTTP 400 the moment `cut_fill` errors, so a clearing or erosion-control sheet with no proposed contours yields **0 CY** for an item that is pure area × depth. #853's topsoil family is **$88,815**. | M | thickness needs Beaumont |
| 11 | **Persist what was typed into a calculator.** `state.ew`, `ewBound`, `tr`, `st` and `excluded` are all nulled in `loadResult`, so the takeoff still says "Site Cut 13,677 CY" while the panel behind it is empty. Nothing reaches the server, so a second seat sees none of it. | M | yes |
| 12 | **Read the sheet number off the title block.** `app.js:1040`, `app.js:536` and `server.py:2033` all print index+1, and grep finds zero occurrences of `sheet_number` anywhere in the engine. On this plan set the number is the largest glyph in a fixed cell (36.7 pt) and resolves cleanly on all 15 pages. Roughly six lines. | ~1 day | yes |
| 13 | **Cross-page cut/fill.** Barn's existing contours are on engine index 9 = printed **C4.0**; the proposed surface is on index 2 = **C3.0**. Unblocks **$500,833 (26.2% of #853)**. **C3.0 is 1"=30 ft and C4.0 is 1"=10 ft — 3× linear becomes 9× on cubic yards.** Any cross-sheet surface must print both scales and both page indices on the row. | L | HIGH RISK |
| 14 | **Map drafter vocabulary to bid lines, and total across sheets.** #853's single `Perimeter Drain 3,395 LF @ $31` is drawn as 2,733.5 LF on C4.3 alone — 80.5% of the bid quantity from one of four sheets — split across **11 styles under two spellings, including the drafter's own typo `FOTER`**. The plans say FOUNDATION DRAIN; the bid says Perimeter Drain. On C4.0, 38.8% of the footage has **no name at all**. | L | yes |

### DO NOT BUILD — this list saves more time than the build order

* **Feeding the drawn boundary polygon into the topsoil strip area.** It makes
  the only quantity with ground truth *worse*: 12,180 CY against #853's 5,730
  (2.13×), versus today's 2.05×.
* **Contour-elevation recovery on C3.0.** The premise ("0 of 225 labelled") is
  false — the proposed surface builds today from 7 labelled chains.
* **Trench depth derived from INV/RIM — until item 3 lands.** 664 of 811 spot
  grades (81.9%) come back with the hundreds unresolved, and `read_spot_datum`
  returns 7600 on some sheets and 7700 on others *within the same set*. Wiring
  invert depth now means differencing truncated elevations into a priced
  quantity. **This is the hardest sequencing constraint in the whole set.**
* **Over-excavation rows into `material_balance` as scoped.** The proposed
  labels fail `EW_ITEM_RE`, which is used as a *remove* filter immediately
  before re-pushing — so every Calculate **appends another copy** and the bid
  quantity multiplies. Worth $188,700 (9.9%) of #853; it deserves a real
  design.
* **Inverting the scope filter to hide "unknown" rows by default.** The repo
  already records 138.8k ft — 78% of a sheet — vanishing through that filter's
  own put-back path, found only by driving the live app.
* **"Fixing" the `/structure` mixed exponent.** Not a defect: footprint area
  scales with the square of the scale and perimeter scales linearly, because
  that is what those shapes are.
* **Vertical scale for profile sheets.** Already built, measured and withdrawn
  in `0c01c80`. Leave it.

### Cannot be verified without a live UI pass — must stay serial

Items **8, 9, the UI half of 3, the banner behaviour in 1 and 7, and any
drawn-boundary work in 10.**

One dev service on :8128 and one job store: two agents driving the same page
overwrite each other's state, and items 3, 9 and 10 each change a stored
quantity, so each needs its own before/after run on the same page.

**None of the six diagnoses did a live pass.** All are source plus cached
results. Per §9, none of them is "verified" yet.

### What the audit could not see

* Every corpus scan quoted is **text-layer only** — which is all the engine can
  see either. A datum note that is rastered or exploded to vector strokes is
  invisible to both. Counts are floors, not censuses.
* **113 of the 114 cached results came from superseded engine builds** (four
  distinct `engine_sig` values plus 50 carrying none).
* **There is no ground truth for any Barn civil sheet.** The 8,224.9 CY /
  9,366.5 CY baseline is a stable reference point for measuring deltas, **not**
  an accuracy claim.
* **No cubic yard in the audit came from a live `cut_fill` run.** The
  phantom-volume figures are geometric upper bounds.
* **Estimate #853 is one job** — a sample, not a rate.

---

## 16. Where the audit and the client feedback disagree

The audit ran **without** the client feedback CSV. One of its DO-NOT-BUILD
entries is now partly answered:

> *"Trench depth bands with edges you pick — there is no source for a band
> edge, not on a sheet, not in a legend, not in #853, not in the transcripts.
> The 0-6/6-10 split in circulation came from a prompt."*

**That was correct when written, and it is now resolved.** There is a source,
and it is the buyer:

> jpierce@piercesitework.com, 2026-08-27: *"it needs to be put into 2 ft depth
> increments. For example 6-8 ft deep, 8-10 ft deep, etc."*

He specified the edges in writing. **Build the band table with 2 ft edges,
configurable.** Griffin Furlong's 0-6 / 6-8 brackets are a second source, for
manholes specifically; where the two conflict, Pierce wins — he is the one
paying.

**The audit's sequencing constraint still binds absolutely:** do not derive
depth from INV/RIM until item 3 has landed. Knowing the band edges does not
make truncated elevations safe to difference.

Merged instruction: **build the band table now against typed depths; wire it to
profile-derived depths only after item 3.**

---

## 17. FINAL merged order

```
0.  ROTATE the xAI and Groq keys, move .env out of OneDrive   (not a feature)

1.  Audit items 1 and 2            two one-line fixes, first hour of day one
2.  AUDIT ITEM 3 - datum abstain   the one thing, if only one thing
3.  Scale, the client-blocked half:
      - calibrate from a line of known length      (jeff, BLOCKED)
      - derive scale from station numbers          (klayton, BLOCKED)
      - A2  the 1:100 misparse                     (under the gate)
      - A5 / audit 7  volume routes read a typed scale
4.  Audit items 5, 6               trench consent gate + arithmetic guards
5.  Audit item 12                  sheet number off the title block
6.  Audit items 8, 9               SERIAL, live pass required
7.  Trench depth bands             2 ft edges from Pierce, typed depths only
8.  Profile reading, rim/invert    ONLY after item 3
9.  Structures from legend symbol  (jpierce, the missed manhole)
10. Pipe by size                   inline labels plus nearby text
11. Audit items 4, 10, 11, 14
12. Audit item 13                  cross-page cut/fill, HIGH RISK, 9x on CY
```

**The one thing, if only one thing: the datum abstain rule.**

It is the only defect on the list that fires with **no operator action** — open
the earthwork panel on Barn C3.3 and 51 spot points that are 100 ft too low are
already ticked on. It is the only one where the app asserts the wrong number is
the drafter's own statement, in a green banner, and then *hides* the override
box precisely because everything falsely resolved. It is completely
self-evident from the sheet, which prints its own contours at 7720-7735 beside
spot grades at 7605-7635. It was the only diagnosis of six to survive
adversarial review with root cause, mechanism, blast radius and fix intact. And
it cannot regress detection: `earthwork.py` is absent from `_ENGINE_FILES`, so
`engine_sig` does not move and no cached page invalidates.

The trade is **173 confidently-wrong elevations for 173 honestly-blank ones** —
the direction this codebase already chose the last time it faced the question.

---

## 18. Build ledger — overnight session 2026-08-30 (Fable)

Committed on `provenance-and-gate`, dev-only, live-verified each:

| commit | what | evidence |
|---|---|---|
| 9f12e2b | stale-volume banner on scale change; second pipe system no longer deletes the first | live: banner at 30→60 typed scale ("expect 4.0×"), both trench systems coexist, recalc replaces |
| 5390b3f | datum abstain rule: band strength decides, conflict always surfaces, typed datum outranks all | 173 grades corrected (C3.3 7705–7735, was 100 ft low), C3.1's 272 preserved; tests 7/7 |
| 32ce71d | legend vocabulary guards (definition rows, 95% strip locality, stipple refusal, column split, colon captions) + calibrate-scale-from-known-line (Jeff, was BLOCKED) | C3.0: BOW/FIN/RIM/DRAINAGE thefts dead, real EXISTING CONTOUR matched; corpus 0 bad-shaped; calibration live-verified with the STOP cross-check catching a bogus value |
| 9fab065 | continuation extension: a broken line keeps its name (joints + sparse-pickup cadence kinship) | 224 (5,976 ft) recovered; 7900 index row restored; all 7 C3.0 contour families named |

### Follow-ups surfaced by measurement

* **Per-chain rescue**: 35,182 pt corpus-wide of unlabeled chains geometrically
  CONTINUE a labeled family but sit inside pools too large/mixed to extend
  wholesale (C3.0's 174-chain solid pool etc.). The honest treatment is
  chain-level relabeling — `chain_labels` already exists in the approve flow —
  offered as a suggestion, never automatic. Needs a design pass.
* **Klayton's station-scale feature: BLOCKED on his actual file.** The PVP pdf
  is not on this machine; his visible sheet family (klayton.pdf, 174-page Zayo
  set) has NO text layer and zero station tokens even under OCR at 200 dpi,
  while its title block prints `SCALE: 1"=50'` (OCR-reachable). Chase the file;
  do not build against nothing.

## 19. Parallel-builders integration — same night, second wave

Five workflow agents (worktrees `wf_42f2a5c9-0c3-*`) built in parallel;
integrated SERIALLY onto main, each landing re-gated (`regress --check`
PASSED every time) and live-verified on :8128 with annotated captures.

| commit | builder task | headline measurement |
|---|---|---|
| 43cba20 | A2: unit-free `1:100` = ratio (8.333), thousands separators, `_RATIO_FPI_MAX` | 6,947-page A/B: only 3 pages move, both corrections verified against the sheets' own ink (soil-map bar to 0.02%; NTS fabrication gone) |
| 33fecaf | printed sheet number read live off the title block | Barn 15/15, Oncor 9/9, Kayden 43/48 + 5 truthful abstains; chip "C3.1 (page 4 of 15)"; my own audit map corrected at idx12 = C4.3 (render-proven) |
| 9f4b2ec | trench consent gate + 6a/6b guards + Pierce depth bands | bedding 137%→86.9% of dig with structural invariant; sloped-run integral exact to 1e-6; bands 30/15 LF hand-checked live |
| df4e28d | calcstate persistence (`p<N>_calcstate.json`, GET/POST route) | full-reload restore of datum/trench inputs live-proven; results never staged; stale choices counted out loud |
| becd81c | earthwork defaults: research + cite + default + override | strip 8 in (local #853 prior 8.29), 5 material presets w/ cited factors, default stays 1.0 per #853 |

### Decisions I made overnight that need Koby's eyes

1. **Trench model overruled** (9f4b2ec): the builder's band-by-band
   cross-section met the audit's continuity bound but models a hole narrower
   above than below — physically impossible, reads LOW into a bid. Restored
   FULL BOTTOM WIDTH per depth class; the +40% step crossing a rule edge is
   now INTENTIONAL (a depth class is a price step — same shape as Pierce's
   2-ft bands). One clearance in every rule row = no steps. Tests pin both
   sides.
2. **Restored "added" = standing consent** (df4e28d): a fresh seat pressing
   Calculate re-enters previously-consented rows without a new Add click.
   One-line change if per-seat re-consent is wanted.
3. **Job reset sweeps calcstate sidecars with the caches** — operator work
   classified as cache in that dialog. Follow-up.
4. **Over-excavation pairing** (equal dig/backfill CY, #853's three exact
   pairs) is recorded in the research but NOT yet a UI feature.

### Structures-from-legend-symbol: measured findings (2026-08-30, withdrawn)

Three versions built and A/B'd on Kayden C5.1; all failed the honesty bar
(commit 40987e4 carries the full record). The load-bearing facts for the
next attempt:

* The corpus HAS the test case: Kayden p38/p39 legends define EXISTING/
  PROPOSED FIRE HYDRANT, GATE VALVE, SANITARY SEWER MANHOLE; the SSMH row
  matches no line style today (invisible to the takeoff) - Pierce's exact
  miss.
* Vector congruence keys fail two ways: single-unit keys collide with text
  (882 letter glyphs named as a note row) and with line markers (the 12
  "W" bubbles riding the waterline); composed-glyph verification finds
  zero real sets because the legend draws its symbol at a different
  size/block than the plan instances (manhole anchor 4x on plan, companion
  circle never co-located; 1 of 3 hydrants verified).
* A point-symbol legend row legitimately holds a pipe stub - open ink is a
  RANKER between claimant rows, never a veto.
* The raster-template route was TRIED the same night (masked matching,
  per-unit templates, ink veto): killed by its own eyeball check. The
  strip render shows the truth the vectors hid - the SSMH "symbol" is a
  FILLED DOT sitting ON the sewer line, and the big unit I was anchoring
  on is the flow ARROWHEAD (out/verify/2026-08-30/symbol-raster/). Two
  raster traps for the record: extract_strokes output is ALREADY display
  space (mapping through rotation_matrix again lands crops at negative
  y), and TM_CCOEFF_NORMED scores an exact 1.0 all down the sheet border.
* THE DESIGN THAT FITS THE DATA (no raster needed): a utility structure
  is a dot/small glyph ON its line family. Count closed units of the
  dot's size whose center lies ON (within ~2 pt of) a chain of the
  MATCHED line style - "PROPOSED SANITARY SEWER MAIN" chains are already
  detected and legend-named, so manholes = dots riding those chains, and
  the MANHOLE legend row supplies the label. Same shape for valves on
  water mains. Bounded, vector-only, style-scoped so text dots and other
  families cannot leak in. Estimated S-M; needs the usual corpus A/B.
* Measured blocker for dot-on-line (same night): on Kayden p38 the
  "PROPOSED SANITARY SEWER MAIN" legend row matches style 79 = 2 chains /
  235 pt - the legend's own sample, not the plan network - and "EXISTING
  SANITARY SEWER MAIN" matches nothing. The Kayden document family has
  never had the legend-matching tuning the Barn family got (the sheet has
  71 round-dot candidates waiting). So the structure counter's real
  prerequisite is a Kayden-corpus legend tuning session, then dots-on-
  chains is a small addition on top.

## 20. Per-chain orphan rescue - design (from the 35,182 pt measurement)

The continuation extension (9fab065) names whole FAMILIES; it refuses
pools too big or mixed to extend wholesale (C3.0's 174-chain generic-solid
pool). Inside those pools, 35,182 pt corpus-wide of individual chains
geometrically CONTINUE a labeled family: ends within 12 pt of a labeled
chain's end, tangents opposed, colors within 0.15.

Design (suggestion-only, operator-consented - same consent shape as every
calculator):

1. Engine (detect-time, cheap): for each unlabeled chain in a pool the
   family extension REFUSED, if it has >= 1 qualifying end-joint to a
   LABELED chain, stamp `continues: {style_id, joint_pt, dot}` on the
   chain JSON. No label moves; provenance only. Gate impact: none - no
   labels, classes or geometry change.
2. UI: the style row gains "N nearby fragments look like continuations
   (X ft) - review". Clicking isolates them on canvas EXACTLY like the
   existing sid-isolation, each with an accept/reject pair. Accept =
   chain-level relabel through the EXISTING chain_labels approve path
   (already in the approve flow); reject stamps a refusal so it never
   re-suggests.
3. Ranking honesty: suggestions ordered by joint quality (distance, dot),
   never auto-accepted, and the style row's own footage NEVER includes
   suggested fragments until accepted - the number the geometry produced
   stays the number.
4. Measurement bar before shipping: on Barn C3.0 count accepted-vs-
   rejected in a manual pass; if acceptance under review is < 80%,
   tighten the joint test before offering it to a client seat.

Estimated M. Depends on nothing above; collides with nothing tonight.

## 21. End-of-night integration smoke (2026-08-30 ~05:00)

Full battery green on ONE tree: gate 15/15, datum 7/7, scale-parse 19/19,
sheet-no OK, calcstate 7/7, trench 33/33, regress --check PASSED.

Live smoke on :8128, Barn C3.1 re-detected under sig adc16fb036da5c3e
(marks.py IS in _ENGINE_FILES - the B3 commit text wrongly said the sig
would not move; it moved and every cache honestly invalidated, correction
recorded here): chip "C3.1 (page 4 of 15)"; scale chip with drawn-bar
cross-check; datum-conflict banner + amber box; trench panel opens at
112 px / earthwork at 200 px from a deep style-list scroll; 6 material
presets; v111 served.

### What is NOT done, and why (for the morning read)
* Cross-page cut/fill: HIGH RISK by its own audit line; needs the joint
  session Koby asked for. Not touched.
* Engineer's-Excel ingest + 3% rule: blocked on a real sample file
  (chasing Sal's exports / Pierce's engineer sheets beats inventing a
  schema).
* Structures counter: measured prerequisite is Kayden-family legend
  tuning (section 19-20 records the three withdrawn attempts and the
  dot-on-line design that fits the data).
* NO PROD PUSH - everything above is dev :8128 only, per the standing
  instruction; joint verification first.

### Kayden token route, sized (2026-08-30 05:30, not built)

Kayden's 8"SS / 8"W / WS line tokens are EXPLODED STROKE GLYPHS - the
text layer prints exactly one word containing "SS" on p38 (the prose word
CROSSING). The regex extension (4f08363) therefore feeds only text-token
families (Oncor's EX-SS/EX-W/OHE). To read Kayden's:

* the machinery exists at chain.py:1039 - _glyph_blobs clusters exploded
  glyph strokes, _mark_glyph_text_chains already classifies dash-text
  lines by blobs riding their gaps (same layer/colour/weight rule);
* what is missing: blob clusters -> render crop -> tesseract single-line
  read -> token -> inline_labels. The codebase carries an explicit
  DECIDED-NOT-TO-DO: "we cannot OCR an exploded glyph reliably" - so this
  ships ONLY behind a measured corpus A/B of token read accuracy, and
  misreads must abstain (an invented 8"W on a sewer main prices the wrong
  trench). Estimated M-L. It unlocks BOTH the Kayden legend matching
  (line identity = weight + token there) and the pipe-size split item.

### Fresh-sheet crawls at close (03:30-04:00)

* ellis p42 (structural S1.02): exposed the worker-death-masking pair,
  fixed + verified (fea150a); sheet-no reader's third document family.
* BelleFarms Road p0 (heavy topo): NO new defect. The LIDAR EG family's
  three-way split is CORRECT ink (index contours 0.7 grey vs intermediate
  0.8); tally honest (254.0k ft, 1.2% welded); multi-scale banner refuses
  to guess among the sheet's 3 printed scales; drops disclosed. One
  measured tuning candidate: the sparse-pickup kinship ratio tolerance
  (0.15) misses style 4's 4.385 - widening it is a corpus study, not an
  overnight edit (chain.py section-6 discipline).

### Overnight total: 24 commits, 83864a1 -> HEAD, all dev-only, all gated.

## 22. Kreo-parity wave (2026-08-30 morning) - five builders integrated

Koby asked "what about the kreo implements?" - answer: built. Five
parallel workflow agents, integrated serially, every landing gated +
tested + live-verified with annotated captures, dev :8128 only.

| commit | Kreo capability | headline |
|---|---|---|
| 2fcb4f9 | Plan Zones -> WORK AREA quantity mask | one drag removes 28.9-31.4k LF of title-block/legend/detail junk from every number on Kayden C5.1; whole-sheet box = bitwise no-op (proven); disclosure everywhere; caught+fixed a page-switch zone leak live |
| 4451878 | confidence review queue "CHECK THESE (N)" | Barn C3.1: 209 rows -> 12 doubts led by the datum conflict; C3.0: 280 -> 5; Kayden: 0 (clean reads clean); clicks GO to the thing |
| 163ab26 | bid-schedule view | 93 takeoff rows -> 10 bid buckets reconciling to the tally exactly; UNASSIGNED stays honest amber |
| 462badc | sheet triage | ellis: 54 mixed sheets -> the 4 civils glow, 50 dim (never hidden); evidence in every tooltip; fixed a gen-token bug that discarded every triage reply |
| 78dd1ab | set-level decisions | hand tick carries across sheets on the collision-free styleFp; builder MEASURED the spec's key at 25x over the honesty ceiling and narrowed accordingly; page always outranks set |

Still open from the Kreo lists, and why:
* Compare Pages (revision diff) - real engine work, own session.
* Assemblies/Items cost DB - Koby's pricing-memory roadmap item; schema
  decisions are his.
* The sales side-by-side (our engine vs Kreo on Thielen p5) - needs ten
  joint minutes; Kreo login is live in the browser.

Closing battery on the combined tree: 12 suites green + regress --check
GATE PASSED.

## 23. The how-to video series (2026-08-30 morning)

Four captioned, edited mp4s delivered to Koby, all recorded by driving the
LIVE dev app through its own UI (Playwright + injected cursor/captions;
rig committed at tools/howto/, takes under out/howto/):

* V1 A Regular Takeoff (Belle Farms Structural, 1:32)
* V2 Cut & Fill Corrected (Stice Coral Mountain, 2:12) - THE demo: the
  sheet's own printed table (cut 2,236,137 / fill 1,631,080) as the
  scoreboard; naive run reproduces the meeting's 2.13M/2.70M on camera;
  operator recipe (3 rows out, strays cleared, tract-ring limit of work)
  lands 1.69M/1.16M; the ~25% surface-fidelity residual is CAPTIONED,
  not hidden. Recipe + iteration log: out/verify/2026-08-30/stice-recipe/.
* V3 Counting Windows & Doors (Aqua Vista scan, 1:05) - W1R exact vs
  Bill's tally, W1L shows its honest CHECK chip.
* V4 The Full Takeoff (Barn, 2:15) - queue, datum, work area, bid view,
  stitched limit of work, trench bands, approve.

Engine fixes the video work surfaced, both landed: the fresh-open datum
was a typed zero (isFinite(null), 7ccae92) and PE pad elevations were
invisible + 3-digit sites could never print in full (5ffe5b2; Stice goes
0 -> 191 resolved pad grades). Surface-fidelity (~25% under-read inside
the ring on Stice) is the next measured engineering target.

## 24. Boundary drawing + cut/fill visibility + V5 (2026-08-30 afternoon)

Koby's feedback on V2 ("they don't have a full square, it has odd cuts")
became two tools (4a254c6) and the capstone video:

* DRAW IT: hand-drawn polygon limit of work (Jason's editable-boundary
  requirement, F145); persists by its own points; live SF while drawing.
* Map legend + peak depths: cut_fill returns max_cut_ft/max_fill_ft; the
  overlay carries a readable ramp legend. The peaks caught the phantom
  z=655 row on their FIRST live use (deepest fill 199 ft on 96 ft of
  relief).
* V5 "Automate 80%, Finish 20%" (2m39s, delivered): peaks flag -> 3-row
  fix -> 14-corner drawn boundary along the real tract cuts -> map ->
  hand-added contour -> bid view -> cited market price -> export, with
  the detected/corrected/manual split in the closing caption. The PE
  pad fix is in the on-camera math (191 proposed spot grades).

Bounded-with-everything Stice landing: cut 1,562,526 / fill 1,200,501 CY
vs the sheet's own table 2,236,137 / 1,631,080. Residual = surface
fidelity; the measured next target is elevation assignment for UNLABELED
intermediate contours (the sheet draws them, the surface never sees
them) - that, not the boundary, closes the gap.
