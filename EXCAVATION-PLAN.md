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

### Conventions needed (do NOT invent these — get them from Koby or a source)

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
