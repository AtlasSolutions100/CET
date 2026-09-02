# SPEC — outline-text reader (branch `feat/outline-reader`, base dev @ 998bf35)

> **Judge's pass (2026-09-02, verdict on 0f6b0ce: buildable, severity serious).**
> Revised in place, one commit. What changed, by the judge's problem list:
> 1. **§6.2 / §7.4 / §7.5 — bar corroboration must be independent of the caption's source.** A ladder read by the same lane (same cluster ids, or Lane B at all) corroborates nothing; the psm-6 pixel zoom is *forced* when the caption is non-native, and a lane-supplied ladder no longer suppresses it (the `if not rows` skip at :1592).
> 2. **§5.4 — mark attachment rewritten.** Promotion needs inter-glyph-gap placement, a local tiny-path density test and decimal-place consistency; the page-level "> 5,000 tiny paths → always ambiguous" cut is removed because by the analyzer's own count it sat below RC Ontario p0/p7, H2S C3/C2, Loves Lane, C8.0, GAOA and C2.1 (S-tiny).
> 3. **§4.3 step 5 / §4.4 — a Lane A digit cluster is promotable only after an independent reader confirms its label** (gap-OCR pixel reads, or native-covered occurrences); the document-consistency check counts only witnesses that do not come from the same clusters.
> 4. **§6.2 suggest_elevations — outline-inline vs gap-OCR disagreement emits neither as a value** (`how="conflict"`); the `how == "inline"` branch and the `> 0.5` write threshold at earthwork.py:1429-1470 are named as the reason a 0.25 row would otherwise win silently.
> 5. **§3.1 / §5.3a — Lane B gets a per-page Tesseract call budget** (S-tess: 72–85 ms per call, 3–6 min per page unbudgeted), numeric-first ordering, one dpi for alphabetic crops, and a cache `page_words(page)` hits without editing call sites. Call-site census re-measured: **19** builders (the draft said 16 and listed 14).
> 6. **§7.3 site 1 — `read_text_layer` gets a merged text that preserves `get_text()` newlines.** Feeding `_row_text(page_lines(page))` sets `wrapped = False` everywhere (scale_detect.py:455) and disables the join-artefact refusal that fixed sundale 90→30 and harbison 180→60 at 998bf35. The ":2093 row rescan" citation was wrong (a comment); the rescan is inside `read_text_layer` at :1985.
> 7. **§3.3 — `'?'` pseudo-words change chain geometry** (`_bridge_text` takes words of len ≤ 6, `_demote_text_chains` len ≤ 24); stated as a measured change with its own stage-2 report (§10.13) and a ≥ 3-glyph floor, not "consumers tolerate them".
> 8. **§2.1 / §4.1 — the L4 glyph filter is transcribed in full** (H_MIN 1.0, dashed paths excluded, w ≤ 6 h, filled needs ≥ 2 items); sub-1-pt paths are marks, not glyphs — the draft said the opposite while quoting counts made with the floor.
> 9. **§7.5 / §10.15 — the population of OCR-`single` picks cannot be read from the survey** (records carry `{best, candidates}`, no `source`; re-checked).
> 10. §8.1 gate, §9 stage tests and §10.12–10.18 updated to match.

Status: design phase, no engine code changed. Every number below is either
quoted from one of the five understand-phase lenses (`out_understand.json`,
scratch input, not committed — cited as **L1..L5**), taken from the tree at
998bf35 (cited as `file:line`), or measured by a throwaway script under the
session scratchpad (cited as **S-…**). Anything not measured is marked
**UNMEASURED**. File:line references in the lenses that predate the
`feat/scale-bar-contradiction` merge are restated here at 998bf35 (the lens
number in parentheses where it differs).

Lens key:
- **L1** text-ingress-map (every path text reaches the engine by)
- **L2** minimal synthetic outline sheet (`outline_synth.pdf` / `outline_small.pdf`, scratch)
- **L3** the DEM-truth outline sheet `dem_hurricane_bench_a_pad_2ft_outline.pdf` vs its real-text twin
- **L4** corpus character, 28 pages / 22 drafter families
- **L5** the existing OCR caption rescue and graphic bar reader

Scratch measurements this document adds:
- **S-survey** `scratchpad/survey_calc.py` over `C:\Users\kobys\takeoff-fable2\out\outline_survey_final.json` (6,966 pages, survey of 2026-09-01 02:58)
- **S-dem** `scratchpad/dem_census.py` over the DEM outline PDF
- **S-tess** `scratchpad/judge_tess_time.py` (the judge's script, re-run here): one DEM outline glyph crop, 10 `image_to_string` calls each — 600 dpi psm 7 **81 ms**, psm 8 **72 ms**; 900 dpi psm 7 **85 ms**, psm 8 **76 ms** per call (the judge measured 71–73 ms)
- **S-census** `grep -n "page_words(\|page_lines("` over the tree at 998bf35: 19 builder sites (§3.1)
- **S-tiny** `corpus-character/results.json` key `tiny_marks_on_page` (the L4 analyzer's own count of paths < 1 pt tall), per page (§5.4 rule 4)

What the reader is for: the owner's target is that estimators auto-calculate
within 5–15% and fix the rest by hand. Today outline text makes
`detect_scale` return no `best` on **296 of 529 plan-like thin-text pages
(56.0%)** and zero candidates on 271/529 (51.2%), against 9/40 on the
real-text control set (S-survey; "plan-like" = ≥5,000 paths, "thin-text" =
<2,500 `get_text()` chars, the survey's own thresholds). Home 2 Suites C3
plan-area spot recall is **0 of 178** (agent-comms/TO-FABLE.md:604, the
brief's figure; the 2 spots found are legend sample rows, L1). All eleven
public CEQA truth records carry
`engine_comparability.usable_as_tuning_target_today: false`, and every one
of them names outline lettering as the reason.

---

## 1. Scope and non-goals

**Scope.** A words provider in `takeoff_engine/extract.py` that recovers
text drawn as vector glyphs on vector plan sheets and emits it in the same
display-space tuple `(x0, y0, x1, y1, text, …)` that `page_words()` /
`page_lines()` emit today, so that chain (`_bridge_text` / `_demote_text_chains`
/ `_attach_inline_labels`, chain.py:1021/1080/1083), legend
(`read_legend` :90, `read_legend_sheet` :627), spots (`read_spot_grades`
earthwork.py:2566), inline contour labels (`suggest_elevations` :1256) and
scale (`detect_scale` scale_detect.py:2013 and its row/bar readers) receive
it with no per-consumer code (L1 finding 7: one injection point serves all
four, plus callouts server.py:5046, mark schedule :5152 and symbol count for
free). Two recognition lanes, routed per page by a measured classification:
Lane A reads stroked SHX-style glyphs from the vectors (68% of word clusters
on the sampled vector sheets, L4), Lane B renders filled "staircase" glyph
paths alone and OCRs the clean render (32%). Every reading carries
provenance, confidence and evidence in trailing tuple slots, unread glyph
clusters are emitted as `'?'` pseudo-words, and any reading that fails the
evidence rules of §6 reaches consumers as a *candidate*, never a value
(CLAUDE.md §5 shape 4). Stage 1 also ships four consumer fixes (§7) that
are independent of the lanes and are measured to cost rows today.

**Non-goals.** No general font recognition, handwriting, or raster-page text:
raster-underlay sheets (image coverage ≥ ~0.30, L4 finding 2) and scanned
pages (`PageClass.kind == "raster"`) are ABSTAINED on, and stay on the
existing raster path (raster.py:509, 200 dpi, `'?'` pseudo rows). No change
to chain geometry, `cut_fill`, or the earthwork grid arithmetic. Title-block
text is real text on every sampled sheet and is not a target (Home 2 Suites
C3: 479 native words, all in the right 40% of the sheet, L1). **What stays
on Tesseract:** `earthwork.gap_label_elevations` (earthwork.py:1677 — the
chain-guided deskewed patch reader, psm 7/8 with a digit whitelist at :1615;
it reads 30/30 outline contour labels on the DEM sheet once the legend
exclusion is lifted, L3, and it is a pixel reader, not a words consumer);
the graphic-bar caption zoom `_ocr_zoom` (scale_detect.py:1366, moved to
psm 6 in §7.4); the caption-window rescue `_ocr_caption_rescue`
(:1470 region, stays psm 11 in stage 1); the 600-dpi mark-schedule OSD path
(server.py:5152-5170); and Lane B's own per-crop OCR, which is Tesseract on
a linework-free render at ≥600 dpi. Full-page 150-dpi psm 11 OCR
(`text_detect.ocr_words`, text_detect.py:89, capped at 6,500 px = 180 dpi on
a 36-in sheet, L2 finding 8) is kept only as the last lane behind native
text and the two outline lanes; it is never the sole source of a promoted
value (§6).

---

## 2. Page classification BEFORE reading

Measured on 28 pages / 22 families (L4, `corpus-character/results.json`,
signal names below are that file's keys). All signals are computed from
`page.get_drawings()` plus `page.get_text()` and are cheap (v4 analyzer:
~90 s for 28 pages including 600-dpi crops, L4 numbers[18]).

### 2.1 Signals

| signal | definition | measured spread |
|---|---|---|
| `stroked_glyphs` | `'s'` paths with `width ≤ 1.6` (STROKE_W_MAX), segment rect ≤ 40 pt (SEG_MAX) and **no dash array**; segments whose 0.3-pt-padded rects touch (GLYPH_JOIN) are one glyph; kept when 1.0 ≤ h ≤ 40 (H_MIN/H_MAX) and w ≤ 6 h in display space (`analyze.py:39-42, 185-200`) | RC Ontario p0 10,455; stroked pages 13/28, mixed 6/28 |
| `filled_glyphs` | `'f'`/`'fs'` paths, non-white fill, 1.0 ≤ h ≤ 40, 0.05 h ≤ w ≤ 6 h, ≥ 2 items (`analyze.py:180`) | H2S C3 1,016 filled words vs 23 stroked |
| stroked:filled word ratio | words built from each glyph kind | stroked ≥3× filled → "stroked"; filled ≥3× stroked → "filled"; else "mixed" (L4 NOTES convention) |
| `filled_axis_aligned_edge_frac` + dominant edge length | share of `'l'` items in filled glyph paths that are horizontal/vertical; mode of their length | **staircase**: H2S 73% with 238,749 of 366,373 items at exactly 0.24 pt (=1/300 in); Town Pump E1.1 75%, 141,317 at 0.24 pt; GAOA L-01 61%, 110,290 at 0.12 pt (=1/600 in). Stroked pages 20–46%. DEM outline sheet 23% with 8,626 `'c'` items (S-dem) |
| `filled_fragments_per_glyph_p50` | filled paths per printed glyph | staircase 2 (outer + counters as separate even-odd paths, L1 finding 6); TrueType 1 |
| bezier items | `'c'` items in glyph paths | **0 on every corpus page** (L4 numbers[3]); 8,626 on the DEM outline sheet (S-dem) |
| `image_area_frac` | image bboxes / page area (`PageClass.image_coverage`, classify_page.py:41) | Grey Bear 0.53, Helena 0.50, Gardiner 0.39, East Gallatin 0.30, White Sulfer p465 0.19; text-bearing vector pages 0.00–0.07 |
| plan-area native richness | fraction of glyph-sized clusters **in the plan area** whose box is covered by a native `get_text('words')` box | H2S C3: 0 of 966 plan words native although `text_chars` = 2,915 (L1 finding 2); real-text control sheet 257 words / 1,441 chars, all native (L3) |
| `words_coinciding_with_real_text` | glyph clusters that overlap a native word box | RC p0 17 of 1,802; Town Pump civil C4.00 10% of 84 (its "glyphs" are symbols and its text is real: 7,365 chars, L4 finding 2) |
| height mode | per-document mode of glyph height, pt | quantised per drafter: RC 7.2 (4,911 paths exactly 7.2 pt), Hurricane/Bozeman/Loves Lane/Approved 5.76, TP mech 6.0, Wells Built 6.75, Malta 9.0 / 4.1, C2.1 4.8, remayihave 4.32, GCHC 4.5, H2S 6.48, GAOA 11.5 (L4 finding 3) |
| `/Rotate` | `page.rotation` | 270 on 13 of 28 pages; 87% of clusters read horizontally in **display** space (L4 numbers[9]) |
| tiny paths | paths < 1 pt tall | 636 (Gardiner) to 70,428 (Town Pump landscape); Hurricane p10 22,809 — dotted hatch, contaminates mark attachment (§5.5) |

### 2.2 Routing table

| class | test | lane | notes |
|---|---|---|---|
| **raster-underlay** | `image_area_frac ≥ 0.30` | **ABSTAIN** (emit no outline words, `coverage.reason = "raster-underlay"`) | 0 of 5 crops are text on Town Pump civil, East Gallatin, Gardiner, White Sulfer; 1–3 of 5 on Grey Bear/Helena (L4). Their text is pixels; the raster lane owns them. The 0.30 cut is the lowest measured underlay page (East Gallatin); the highest text-bearing vector page is 0.07 — **UNMEASURED** between 0.07 and 0.19 (White Sulfer p465, 19%, is itself a non-text page). |
| **scan** | `PageClass.kind == "raster"` | ABSTAIN | already routed to raster.py |
| **native-rich plan** | plan-area native richness ≥ 0.9 **and** ≥ 20 plan-area native words | ABSTAIN (`reason = "native"`) | the reader must be a no-op on real-text sheets — the no-regression rule of §8.4. The 0.9 threshold is **UNMEASURED**; the DEM control sheet and the 5 milestone sheets are the calibration set. |
| **too few clusters** | < 20 plan-area glyph clusters | ABSTAIN (`reason = "sparse"`) | Grey Bear 11 words, Helena 14 — both underlay anyway. Threshold **UNMEASURED**. |
| **stroked** | stroked ≥ 3× filled | Lane A | 13/28 pages; RC Ontario, Hurricane, Loves Lane, GCHC, C2.1, Wells Built, remayihave, Malta Cu1.01, TP mech, White Sulfer |
| **filled-staircase** | filled ≥ 3× stroked **and** axis-aligned ≥ 0.60 **and** dominant edge ∈ {0.24, 0.12} pt (±0.01) | Lane B | 5/28: H2S C3 + C2, TP E1.1, GAOA L-01, Gardiner p298 (underlay, abstains first) |
| **filled TrueType** | filled ≥ 3× stroked, not staircase (curves present or axis-aligned < 0.60) | Lane B | rare in the corpus (Helena, Grey Bear title text); **the DEM outline sheet is this class** (S-dem: 113 black filled paths, one path per *string*, curves) |
| **mixed** | neither ratio ≥ 3 | both lanes, each on its own path subset; words are assembled after both | 6/28: Bozeman, TP arch, Malta Cg1.01, Helena, Approved Construction Set |

Classification is recorded on the returned layer (`TextLayer.page_class`)
and in `PageClass` (new field `plan_text_coverage`, §7.2) so that a
consumer, a test and the UI can all see *why* a page has no outline words.

---

## 3. The words provider

### 3.1 Signatures (extract.py)

```python
@dataclass
class TextLayer:
    words: list            # display-space tuples, §3.2
    lines: list            # (x0, y0, x1, y1, text) rows, display space
    page_class: str        # "stroked" | "filled-staircase" | "filled-truetype" | "mixed" | "native" | "raster-underlay" | "scan" | "sparse"
    coverage: dict         # {"plan": {"clusters": M, "read": N, "unread": M-N}, "title": {...}, "reason": str|None}
    lanes_run: tuple       # subset of ("A", "B", "ocr")

def page_text(page, *, lanes=("A", "B"), ocr=False, cache=None) -> TextLayer:
    """Native text layer first, then outline lanes on the glyph clusters the
    native layer does not cover, then (ocr=True only) full-page Tesseract on
    whatever is still unread. Never drops a native word; never re-reads a
    cluster a native word box covers."""

def page_words(page) -> list:   # signature unchanged
    return page_text(page).words

def page_lines(page) -> list:   # signature unchanged
    return page_text(page).lines
```

`page_words` and `page_lines` keep their signatures; every one of the **19**
builder sites at 998bf35 (S-census: detect_page.py:242; server.py:2325/2326
(spots route), :3257 (legend), :4451/4457 (suggest), :5046 (callouts),
:5152 (mark schedule), :5251 (symbol count); batch.py:74; cli.py:32;
eval_layers.py:233/296; milestone_report.py:32; profile.py:449;
regress.py:115; sweep.py:57; scale_detect.py:849/2023) therefore receives
outline words without editing. (The first draft said 16 and listed 14;
detect_page.py:302 is a gate, not a builder.)

**Cache — a key the call sites hit without editing.** The `cache` kwarg
above is unreachable from `page_words(page)`, so it cannot be the
mechanism. `page_text` memoises on `(page.parent.name or id(page.parent),
page.number, page.rotation)` in a module-level LRU of 64 `TextLayer`s
(a reopened document gets a new identity; the LRU bound is the eviction).
A suggest job on the server today builds the tuple four times (:4451/4457,
scale's :2023, chain's detect_page.py:242) and would run Lane B four times
without it. Measurement for stage 2: `TextLayer` computations per
`/earthwork/suggest` job on the DEM outline sheet, **4 → 1**.

### 3.2 Tuple shape — byte-compatible

Native `get_text("words")` words are 8-tuples
`(x0, y0, x1, y1, text, block_no, line_no, word_no)`; `page_words` keeps
`w[4:]` verbatim (extract.py:82), and **`scale_detect.py:626` groups words by
`(w[5], w[6])`** to assemble rows. Outline words therefore must fill those
slots with values that group correctly and never collide with native
blocks:

```
w[0:4]  x0, y0, x1, y1          display space (§3.4)
w[4]    text                    str; '?' for an unread cluster (§3.3)
w[5]    block_no                outline: -(1 + row_id)   (negative: never a native block)
w[6]    line_no                 outline: 0
w[7]    word_no                 outline: index within the row
w[8]    source                  "text" | "outline-A" | "outline-B" | "ocr"
w[9]    conf                    float 0..1 (native words: 1.0)
w[10]   evidence                dict, lane-specific (§6.1); {} for native
```

Native words are emitted **unchanged** (length 8) so a real-text sheet's
`page_words` output is byte-identical to today; only outline/OCR words carry
`w[8:]`. Every consumer reads `w[4]` and at most `w[5:7]` (grep at 998bf35:
the only `w[5]`/`w[6]` reader is scale_detect.py:626; nothing reads `w[7]`
or beyond). A helper `extract.word_meta(w) -> (source, conf, evidence)`
returns `("text", 1.0, {})` for short tuples so consumers never index past
the end.

### 3.3 The `'?'` pseudo-word convention

An unread cluster (unlabelled Lane A cluster, Lane B dpi disagreement,
mark-ambiguous string, cluster on which the lane abstained) is emitted as
`(x0, y0, x1, y1, '?', block, 0, k, source, 0.0, {"reason": ...})`. This is
exactly what `text_detect.merge_words` already does for glyph rows OCR could
not read (text_detect.py:117-131), and the raster path already feeds such
pseudo-words into chaining (raster.py:509), so consumers tolerate them: no
regex in `suggest_elevations` (:1281), `read_spot_grades` (`_SPOT_TAG`
:2426, `_FULL_ELEV` :2432), `_scan` or `read_legend` matches `'?'`.
Their purpose is *coverage*: a ranker can count how many clusters in its
window were not read (§6.2). Mark-ambiguous strings are a special case:
the pseudo-word carries the alternatives in `evidence["candidates"]`
(e.g. `["89.38", "8938"]`) and text `'?'`.

**Pseudo-words change chain geometry; that is a measured change, not a
free pass.** `_bridge_text` (chain.py:3230) takes every word with
`0 < len(text) <= 6` as a bridge anchor and `_demote_text_chains`
(chain.py:1739) every word box with `len <= 24`; a `'?'` qualifies for
both, so "no regex matches `'?'`" only covers the regex-consuming readers.
On an outline page the effect is the intended one — a `'?'` box over a
stroked-glyph cluster is exactly the box `_demote_text_chains` needs to
demote exploded text, and raster.py:509 relies on the same thing — but it
means stage 2 (no recognition) already moves chain counts on every
stroked page of the fast corpus, and a `'?'` over a *single* stray stroke
would bridge two unrelated dashed chains across 90 pt. Rules: (1) a
pseudo-word is emitted only for clusters of **≥ 3 glyphs** (singletons and
pairs are not text evidence; Hurricane p2 has 7,984 singleton glyphs, L4);
(2) §8.4 rule 2 (gate-baseline unchanged) holds on real-text pages, where
the provider is a no-op; on outline pages stage 2 reports the chains /
precision / truth-class delta from `'?'` boxes alone, before any
recognition (§10.13), and that delta is accepted or refused on its own
evidence rather than assumed harmless.

### 3.4 Coordinate space — the trap

`get_drawings()` is **raw, unrotated**; the words tuple and `get_pixmap()`
are **display** space (CLAUDE.md §5; extract.py:58-83 maps native words
through `page.rotation_matrix`). The provider maps every glyph segment
end-point through `page.rotation_matrix` *first* and builds boxes in
display space. Two measured defects that any box built the other way
reproduces (L4 finding 8):

1. **Never use `Rect | Rect`.** pymupdf 1.28.2 ignores an empty operand:
   `Rect(6,5,14,5) | Rect(10,5,10,15) == Rect(6,5,14,5)`. Every axis-aligned
   single stroke is an empty rect, so `T`, `I`, `H`, `E` vanished
   (`CENTER` → `CEN`, `DESIGN` → `DES G`). Boxes are `min`/`max` over the
   mapped end points of every segment.
2. **Never apply a height floor in raw space.** On /Rotate 270 pages a
   lone-stroke `I` and every staircase `N` stem is *wide* and 0 pt tall in
   raw space (`INSULATION` → `NSULAT ON`). Height, gap and row tests run
   after the mapping.
3. **A grid cell is not a proximity test.** A 20-pt pre-filter cell split
   `GRADE` → `GRAD`, `TELEPHONE` → `TELEPH`. Neighbour search pads the query
   rect by the allowed gap (cKDTree / padded index rects), per CLAUDE.md §5
   shape 1.

---

## 4. Lane A — stroked glyphs from vectors

Applies to `page_class ∈ {stroked, mixed}` on the `'s'` subset. Facts the
lane is built on (L4): every glyph is a set of flattened polylines (0 bezier
items on any sampled page), width 0.7–1.0 pt (RC 0.72 / 0.42 / 0.84, L1
numbers[12]), 4–16 segments per glyph (p50), and on RC Ontario each stroke
is its own 1-item path (an `H` is three paths). Inter-glyph gap p50 is
0.17–0.28 × height: digits are cleanly separable. Linework crosses 4–44% of
plan-area word boxes but the *paths* are separable from it by type and
width, which is why this lane reads vectors, not pixels.

### 4.1 Glyph assembly

1. Candidates: the L4 analyzer's filter, transcribed in full because every
   count in §2 was made with it (`analyze.py:39-42, 185-200`): `'s'` paths
   with `width ≤ 1.6` pt, segment rect ≤ 40 pt on both axes, and **no dash
   array** (a dashed path is linework whatever its size); after joining, a
   glyph is kept when `1.0 ≤ h ≤ 40` pt and `w ≤ 6 h` in display space.
   Sub-1-pt paths are therefore *not* glyphs — they are the marks of §5.4,
   attached to words after assembly. (The first draft said "shorter glyphs
   are kept", which contradicts the counts it quotes.) Exclude paths whose
   layer is a known linework layer when layers exist (`has_layers`,
   detect_page.py:243 — layered pages skip OCR today for the same reason).
2. Segments whose end-point boxes, padded 0.3 pt, touch → one glyph
   (union-find over a cKDTree with query radius = pad; the union order is
   sorted, as chain.py:1830 does, so the result is deterministic).
3. Height per glyph = mapped box height. Per-document **height modes** are
   the peaks of the histogram of glyph heights across all pages of the
   document (RC: 4,911 at exactly 7.2 pt, next bin 136). A glyph is
   *normal* if within ±10% of a mode; glyphs between 1 pt and the smallest
   mode (`-`, `'`, lone `I` crossbars) are kept and flagged `short`; paths
   under 1 pt are marks (§5.4), not glyphs; taller ones (>1.5× the
   largest mode) are not text (Bozeman `NORTH` is a double-contour bold
   outline, L4 finding 7 — a different class, left unread).

### 4.2 Word assembly (gap-walk, not a bucket)

Sort glyphs by display x within rows; two glyphs are row-aligned if their
boxes overlap ≥ 40% vertically; consecutive row-aligned glyphs join into a
word while the gap ≤ **0.7 h** (L4 NOTES convention; measured intra-word gap
p50 0.17–0.28 h, so the 0.2 h figure in the brief is the *typical* gap and
0.7 h is the cut ≈ 2.5× above it). **UNMEASURED:** the inter-*word*
gap distribution — the one number that fixes the cut (§10.1). Rotated
labels: rows are also built along the glyph's principal axis when a run of
≥3 glyphs shares a non-horizontal baseline (13% of clusters are
non-horizontal in display space, L4 numbers[9]); the DEM outline sheet's
contour labels are rotated (L3 finding 0) and gap-OCR exists for that
case — Lane A must at least *box* them so they count in coverage.
Clusters > 80 glyphs (note blocks, 0–4 per page) are boxed as one `'?'`
region and not read (L4 finding 8 residual). The pairwise pass is over
1,000–8,000 glyphs per page (7,984 singleton glyphs on Hurricane p2):
pad index rects by the allowed gap and cap per-cell work (L4 implication 6).

### 4.3 Per-document template clustering, then labelling

Recognition is unsupervised first, named second, because a glyph seen once
repeats hundreds of times on a sheet and thousands across a document
(RC p0 alone: 10,455 stroked glyphs):

1. **Normalise** each glyph: translate to its box origin, scale by the
   document height mode it matched, resample each polyline to fixed arc
   step; signature = (stroke count, normalised end points).
2. **Cluster** by chamfer distance on a 32×32 rasterisation of the
   normalised strokes (threshold **UNMEASURED**, §10.2); a cluster with
   < 3 members is not labelled (it becomes `'?'`), mirroring
   `_glyph_blobs`' ≥3-repeat rule (chain.py:1780).
3. **Label** each cluster once: render *k* exemplars (k = min(5, n)) clean
   at 600 dpi and OCR each as a single character (psm 10); the cluster
   label is the majority string, `agreement = votes/k`. Alternative:
   match against a stroke-font reference (SHX romans simplex) — not in the
   tree, §10.8. Expected distinct clusters per document ≈ 36–70
   (alphanumerics × case, plus punctuation) — **UNMEASURED**.
4. **Confidence is per cluster**, not per glyph: `conf = agreement ×
   f(n)`, and every word inherits the minimum conf of its glyphs plus the
   list of cluster ids in `evidence`.
5. **A digit cluster is promotable only once an independent reader
   confirms its label.** Exemplar OCR at two dpis is the same recogniser
   on the same strokes (§4.4 check 1). A cluster's label is *confirmed*
   when either (a) ≥ K words containing the cluster are read by
   `gap_label_elevations` (earthwork.py:1677 — pixel psm 7/8 with the
   digit whitelist at :1615; 30/30 on the DEM sheet, L3) and every such
   read agrees with the label at that character position (K = 3,
   **UNMEASURED**, §10.16), or (b) the cluster's glyphs occur under a
   native word box somewhere in the document
   (`words_coinciding_with_real_text`: RC p0 17 of 1,802 — rare, L4) and
   the native character agrees. Until confirmed, `conf` is capped at 0.79
   (below the §6.2 value threshold) and `evidence["label_confirmed_by"]`
   is `None`, so every digit string built from an unconfirmed cluster
   reaches consumers as a candidate. Alphabetic clusters (legend labels,
   headings) are exempt: their consumers rank and never promote.

### 4.4 What a wrong label looks like, and how it is caught

A mislabelled cluster is wrong *everywhere it occurs* on the document: a
`3`-cluster labelled `8` turns every 3 on the sheet into an 8, silently,
with high agreement if the exemplars mislead Tesseract the same way
(L5 finding 4: 8→0 and 8→2 confusions are a function of render dpi and
window, reproduced at 600 dpi). Catches, in order of strength:

1. **Two-render agreement per cluster** (600 vs 900 dpi psm-10
   exemplars): disagreement → cluster conf 0 → `'?'`. This catches
   dpi-dependent confusions (L5: 8→0 at 600 dpi and not at 150/300) and
   nothing else — it is the *same recogniser on the same strokes*, so a
   font-stable mislabel passes it. It is a filter, not a confirmation.
2. **Topology for digits**: a stroked `8` closes two loops, `0` one,
   `3`/`5`/`2` none. Count closed loops in the cluster's normalised
   polylines; a label whose loop count contradicts its glyph refutes the
   label. **UNMEASURED** on stroked fonts (§10.3); not relied on until it
   is.
3. **Document consistency, with independent witnesses only**: a cluster
   label that pushes > 25% of the digit-string words containing it out of
   the sheet's level set is refuted — but the level set must be witnessed
   by ≥ 6 values that do **not** contain the cluster (gap-OCR reads,
   native values, or Lane A words built only from *confirmed* clusters).
   On an outline-only page every Lane A witness comes from the same
   clusters: `3→5` turns 3380..3400 into 5580..5600 with the contour
   interval intact and passes a same-source test, which is what the first
   draft's version of this check was. The 25-ft anchor / 100-ft band
   rules at earthwork.py:1399-1425 are the consumer-side version and have
   the same blind spot when fed only Lane A values.
4. **Confirmation by an independent reader** (§4.3 step 5) is the only
   catch that *promotes*; 1–3 only refuse. A label nothing refutes and
   nothing confirms stays a candidate.
5. **Never a single source for a value**: §6.

---

## 5. Lane B — filled staircase glyphs

Applies to `page_class ∈ {filled-staircase, filled-truetype, mixed}` on the
filled subset. Filled-staircase text *is* raster text auto-traced into
vectors (L4 finding 1b): glyph boxes touch (gap p50 0.00–0.05 h; 36–48% of
words have overlapping neighbour boxes on H2S), glyphs arrive as 2 fragments
(outer contour + counters, even-odd), 21–41 segments each. Path-bbox
segmentation cannot separate them; a render can.

### 5.1 Render glyph paths ALONE

Build a scratch pymupdf page of the same size, draw only the selected
filled paths in black on white using each path's own fill rule
(`even_odd=True` on H2S so counters stay open), rotated into display
orientation, and render the region at **≥ 600 dpi** — at 5.76 pt a glyph is
48 px tall at 600 dpi and 24 px at 300 (L4 finding 3). This is exactly what
lens 4's `crops/` are, and it removes the 55–100% linework crossing that
defeats page-render OCR (H2S 55–65%, TP E1.1 100%). Render per word region,
never the whole page: the 6,500-px cap in `ocr_words` (text_detect.py:95)
means 180 dpi maximum on a 2,592-pt sheet (L2 numbers[18]).

### 5.2 Connected-component segmentation

Glyph blobs = connected components of the render (8-connectivity), merged
with any component whose box lies inside another's (counters). Words by the
same gap-walk as §4.2 on component boxes; for staircase text the join cut
must tolerate gap 0 (touching), so words are split only at gaps > 0.35 h
(**UNMEASURED**; H2S/TP E1.1 intra-word p50 is 0.00–0.05 h) or at a row
break.

### 5.3 OCR per word crop, fixed psm, two-dpi agreement

Each word crop (component union + 3 px margin, deskewed by the row axis) is
OCR'd with **psm 7** (one text line), fallback **psm 8** (one word) — the
same pair `_ocr_digit_string` uses (earthwork.py:1607-1622) because psm 7
clips a leading digit on C-04 (803/804 read only under psm 8). No
whitelist on the generic pass (a whitelist was measured not to work in
marks.py:685); a second, digit-whitelisted pass runs only on crops whose
first read is ≥ 70% digits, and both must agree. **Two-dpi agreement**: the
crop is read at 600 and 900 dpi; the value is emitted only when the two
strings are identical; otherwise `'?'` with both strings in
`evidence["candidates"]`. Motivation (L5 finding 4): Hurricane C.3.1
`2,862` reads 2,862 at 150 and 300 dpi but `2,062` at 600; Bryce `4,859`
reads `4,259` at 150 and nothing at 300 — substitutions inside a token that
no post-OCR rule can see. L2 numbers[9] is the floor this lane must beat:
per-label crops with psm 7 read 25/30 at 300 dpi versus 21/30 full page;
its 2 residual wrongs (`.3480`, `3388.507`) were line stubs inside the crop
margin, which a glyph-only render does not contain.

### 5.3a Runtime budget — Lane B is Tesseract-bound

Measured (S-tess): one `image_to_string` call on a 600- or 900-dpi word
crop costs **72–85 ms** whatever the psm — the cost is per call, not per
pixel. Home 2 Suites C3 p0 has 966 plan-area word clusters (L4): psm 7 at
two dpis alone is ~1,930 calls ≈ 2.5 min, and with psm 8 fallbacks and the
digit-whitelist second pass 2,500–4,500 calls ≈ **3–6 min per page**,
against the existing ~5 s detect path (L3 numbers[10]) and
`gap_label_elevations`' own cap of `_OCR_BUDGET = 1400` calls
(earthwork.py:1571, ~1.7–2 min worst case). Unbudgeted, and built four
times per suggest job (§3.1), the lane is unusable. Rules:

1. **Per-page call budget** `LANE_B_CALL_BUDGET = 400` (~30–35 s;
   **UNMEASURED**, §10.14), counted in Tesseract calls like `_OCR_BUDGET`.
   Clusters the budget does not reach are emitted as `'?'` with
   `reason = "budget"`, and `coverage["budget_exhausted"]` carries the
   count so "N of M read" stays honest.
2. **Numeric-first ordering**: (i) the bar-ladder window (`_bar_heads`
   region, ≤ 12 crops), (ii) plan-area clusters that are digit-shaped
   (2–7 components, each of width 0.35–0.8 h, no ascender/descender
   variance — a geometric test, free), (iii) title/legend-area alphabetic
   clusters, (iv) the rest. Spots, contour labels and the bar are what
   the owner's 5–15% depends on; legend words have a ranker.
3. **Second dpi only where it buys a value**: the 900-dpi read runs only
   on crops whose 600-dpi string is ≥ 70% digits or that lie in the bar
   window; alphabetic crops get one read and are candidates (their
   consumers rank). This halves the alphabetic cost and keeps the two-dpi
   rule exactly where §6.2 needs it.
4. **One build per job**: the §3.1 cache.

### 5.4 Sub-1-pt mark attachment — `'89.38'` vs `'8938'`

Decimal points, periods, commas and i-dots are < 1 pt paths and **every**
truth crop that prints one lost it to the 1-pt height floor (0/6 present,
L4 numbers[14]: GCHC `4108.`, Loves Lane `.02 FG`, H2S `89.38 EOA` read as
`89 38`, Wells Built `48"O.C.`, GAOA `GRASS SEED,`, C2.1 `utilities`). A
spot elevation with its point dropped is 100× wrong. Rule:

1. **Attach** any path < 1 pt tall within 0.5 h of a word box whose
   centre lies in the baseline band `[baseline − 0.15 h, baseline + 0.15
   h]` (period, comma, decimal) or above the x-height (i-dot), and render
   it with the word in §5.1 so the OCR sees it. Attachment alone proves
   nothing: H2S C3 has 5,160 fill-only 0.5–0.7 × 1.0 pt stipple dots (L1
   finding 6), and a stipple or dotted-hatch dot under the gap between
   `4` and `8` renders with `3480`, reads `34.80` at both dpis with high
   confidence and no `'?'` nearby, passes `_SPOT_VALUE`
   (`^\d{1,4}(\.\d{1,2})?$`, earthwork.py:2431) and turns a 3,480 ft
   spot into a ~46 ft datum error after resolution. `.3480` / `3480.`
   are caught by the anchored regexes; `34.80` is not.
2. **Promote** to a value only when all of:
   - (a) *placement*: the mark's x lies in an inter-glyph gap — between
     two adjacent component boxes of the word, not inside one — and that
     gap is 0.2–0.45 h wide, a period advance (Arial's is ≈ 0.28 em;
     **UNMEASURED** on staircase fonts, §10.17). A mark under a glyph box
     or in a gap of ordinary width is a stray;
   - (b) *local density*: no second, unattached tiny path within 3 h of
     the word box. A stipple field, dotted hatch or a leader's dots trip
     this; an isolated decimal point does not;
   - (c) *both dpi reads* contain `.` at the same character index;
   - (d) *decimal-place consistency*: the value's decimal count equals
     the mode across the sheet's other promoted numeric words (spots are
     printed to one precision per sheet); with fewer than 5 such words the
     value is a candidate.
3. Otherwise — mark attached but no `.`, `.` with no mark, or any of
   (a)–(d) unmet — the word is emitted as `'?'` with
   `evidence["candidates"] = ["89.38", "8938"]` and `evidence["mark_at"]`,
   **never promoted**. `read_spot_grades` and `suggest_elevations` then
   see no token; the UI offers both.
4. **No page-level tiny-path cut.** The first draft made attachment
   always-ambiguous on pages with > 5,000 tiny paths. By the analyzer's
   own count (S-tiny, `tiny_marks_on_page`) that line sits *below* RC
   Ontario p0 **5,581** and p7 **5,390**, H2S C3 6,074 and C2 5,782, Loves
   Lane C4.0 8,322, C8.0 8,775, GAOA L-01 8,955 and C2.1 17,991 — it made
   `633.60` (§8.2, §10.8) and every decimal on the flagship stroked family
   permanently unpromotable, pre-answering §10.12 at 100%, and it did not
   separate those pages from the hatch pages it was written for
   (Hurricane p10 22,809; Malta Cg1.01 29,911; TP landscape 70,428).
   Rule 2(b) measures locally what the page count tried to measure
   globally (1,444 of 1,466 Hurricane p10 words have an adjacent tiny
   path, L4 — on that page 2(b) fails almost everywhere, which is the
   right answer there); §10.12 measures how many words pass it per family.

---

## 6. Evidence and abstention rules (CLAUDE.md §5 shape 4)

The principle, measured live three times: a ranker only sees the candidates
a reader recovered and cannot know what it dropped. RC Ontario p0 OCR
recovered one caption (the INDEX MAP's `1"=200'`) and `detect_scale`
promoted it as `source='ocr'`, `n_cands=1` (L1 numbers[1]); RC p10 ships
best = 10 from a DETAIL 1 caption where the sheet bar says 20 (2× length,
4× area, L5 numbers[11]); Hurricane C.3.5's only surviving candidate is the
key map's 300 against printed 40/10/300 (L5 finding 2). "The single
surviving value" is not "the single printed value".

### 6.1 What travels with every reading (`w[10]`)

| lane | evidence keys |
|---|---|
| outline-A | `cluster_ids`, `cluster_n_min`, `agreement_min`, `height_pt`, `mode_pt`, `n_strokes`, `rotated`, `crossed_by_linework` |
| outline-B | `dpi_reads` (`{"600": s1, "900": s2}`), `cc_count`, `glyph_count`, `mark_attached`, `mark_at`, `candidates`, `crossed_by_linework` |
| ocr | `dpi`, `psm`, `tess_conf` |
| `'?'` | `reason` ∈ {`unlabelled-cluster`, `dpi-disagree`, `mark-ambiguous`, `note-block`, `lane-abstained`} plus the lane keys above |

The `TextLayer.coverage` dict carries `clusters / read / unread` per region
(plan, title) and per lane, and is serialised into the page result so the
UI can say "N of M plan-area labels read".

### 6.2 When a reading is a candidate, not a value

A word with `source != "text"` is a **value** only if all of:
`conf ≥ 0.8` (**UNMEASURED**, §8.1 tunes it), no `'?'` in the consumer's
own window, not mark-ambiguous, two-render agreement present. Otherwise the
consumer treats it as a candidate. Per consumer, what exists today and what
changes:

**`detect_scale` (scale_detect.py:2013-2130).** Today the text path
`read_text_layer` → `_rank` (:816) promotes a lone value as `"single"`;
the OCR path at :2100-2102 does the same for OCR (`ScaleResult(best, cands,
nts, "ocr", pick)`), and only the caption rescue abstains (:2072-2095,
`why="abstained-ocr"`). `_corroborate` (:1870) is additive and never changes
`best`. **Change:** a `best` whose winning candidate's words are all
`source != "text"` is promoted only when a bar reading **independent of the
caption's source** agrees within `BAR_AGREE_PCT` (2.0, :1867); otherwise
`best=None`, `candidates` kept, `pick={"why": "abstained-outline",
"coverage": …}`. The same rule applies to today's OCR `"single"` (§7.5).
Refused readings go in `pick["values_refused"]` so C.3.5's 40 and 10 are
visible beside 300 (L5 implication 4).

*Independence, stated exactly* — the judge's construction, which the first
draft's rule promoted: Lane A mislabels the `2` cluster as `4` (one
cluster, every occurrence, 5/5 at both dpis — L5's 8→0 is dpi-dependent;
a font-stable confusion is not). The caption `1"=20'` reads 40; the ladder
`0 20 40 80` reads `0 40 80 160`; tick spacing 36/36/72 pt stays
consistent with the labels because the rate guard (`pred = v0 + (x −
x0)(v1 − v0)/(x1 − x0)`, :1680-1690) derives the rate from the same
labels; bar = 40 ft/in agrees with the caption within 2%; best promoted
2× wrong, 4× on area. Worse, `graphic_scale_bar` zooms only when `not
rows` (:1592), so a consistent wrong ladder from the lane suppresses the
one independent read. Rules:

1. A corroborating bar row is independent of a caption only if its
   labels come from (i) native text (`source == "text"`), or (ii) the
   psm-6 pixel zoom `_ocr_zoom(page, window, psm=6)` (§7.4), or (iii)
   drawn tick geometry (`_page_ticks`) plus one endpoint label from
   (i)/(ii). Rows built from outline words that share **any** cluster id
   with the caption's words (`evidence["cluster_ids"]`), or from Lane B
   words at all when the caption is Lane B (same recogniser on the same
   render), corroborate nothing. `graphic_scale_bar` gains
   `independent_of: set[cluster_id] | "lane-B" | None`, and `_corroborate`
   records `bar_source` on the result.
2. Whenever the caption's words are non-native, the psm-6 zoom on the bar
   window is **forced** regardless of whether lane rows exist — this
   replaces `if not rows` for that case (§7.4). A lane ladder may still be
   *shown* in `candidates`, never *counted* as agreement.
3. The DEM outline sheet's gate (§8.1: `agrees True`) is met by (iii): its
   tick strokes are drawn and the zoomed `0 20 40 80` supplies the
   endpoints. Which of (i)–(iii) each of the 17 L5 bar pages needs is
   §10.18 — that count, not "7 of 17", is the yield stage 1b/1c can claim
   under this rule.

**`read_spot_grades` (earthwork.py:2566).** Reads `w[4]` only; pass A over
`lines`, pass B over `words`; datum consensus needs two contour labels in
one hundreds band; discloses `legend_excluded` and `z_missing` in
`datum_info` (:2837-2839). **Change:** each spot dict gains `source` and
`conf` from `word_meta`; a mark-ambiguous value is not paired (it is `'?'`)
but is returned in a new `datum_info["ambiguous"]` list with its
candidates and position; `datum_info["unread_clusters"]` = plan-area `'?'`
count so the UI can show "3 of ~130 read" honestly (sundale record).

**`suggest_elevations` (earthwork.py:1256).** Regex at :1281 over `w[4]`;
source ranking in the `dist` slot (inline perp < gap-ocr 0.5 < radius).
**Change:** an outline inline token ranks *between* a native inline token
and gap-ocr (dist slot 0.25, `how="inline-outline"`) so a native glyph
still outranks it — but the gap-OCR merge at earthwork.py:1429-1470 must
learn the new kind, because as written it lets a wrong outline read win
silently: the gap-ocr write requires `seen[cid][0] > 0.5` (0.25 is not),
and the disagreement branch is `elif how.get(cid) == "inline"`, so a row
at 0.25 with `how="inline-outline"` is never compared and gap-ocr is never
written. L2 measured a crop read of `3388.50` as `5388.50`; if Lane B
agreed with itself at two dpis, that value would displace gap-OCR's
correct 3388.50 with no disclosure. The reasoning inside that branch
("native glyphs are exact; a raster re-read cannot beat them") does not
transfer: an outline read *is* a raster re-read. Rules:

- outline-inline and gap-ocr present for the same chain and **agreeing**
  (|Δ| ≤ 0.01): keep inline-outline at 0.25 with
  `evidence["corroborated_by"] = "gap-ocr"`;
- present and **disagreeing**: emit **neither** as a value; the row goes
  to `candidates` with `how="conflict"` and both values, and the chain is
  counted in `datum_info["conflicts"]`;
- gap-ocr **absent**: inline-outline stays a row at 0.25 only if the word
  is a *value* under §6.2 (Lane A: confirmed cluster; Lane B: two-dpi
  agreement, no mark ambiguity); otherwise it is a candidate.

Mark-ambiguous tokens are never `cands`; rows gain `source`/`conf`. The
early return at :1286 is fixed in §7.1 regardless.

**`read_legend` / `_assign_label` (legend_detect.py:69-84).** Explicit
ranking already: an unusable label never wins. **Change:** `_is_usable_label`
refuses a label containing `'?'`; the LEGEND heading test at :101 sees
outline words automatically.

**`graphic_scale_bar` (scale_detect.py:1539).** Consumes label rows; an
outline-read tick ladder (`0 20 40 80` on the DEM sheet, unread today,
L3 finding 3) feeds the existing ≥3-label / tick-snap / rate guards
unchanged **as a candidate ladder** — it can supply a `graphic-bar`
reading when no caption exists, but it never corroborates a caption from
the same lane (rule 1 above), and its presence no longer skips the pixel
zoom (§7.4). Bar labels are digits ≤ 3 chars — Lane A/B's easiest case,
and also the case where a font-stable cluster mislabel is invisible to
the rate guard.

---

## 7. Consumer fixes that ship WITH stage 1, regardless of the lanes

### 7.1 `earthwork.py:1286` early return before the `gap_z` merge at :1399

`if not cands: return []` fires when the page has no native numeric token,
*before* `if gap_z:` at :1399 is reached. Measured: the DEM outline sheet's
server route paid 15.0 s of gap-OCR for 17 chain elevations, **17/17 correct
against the control's inline truth, and served 0 rows**; with the gate
opened by a dummy off-page token, 17 gap-ocr rows, all correct; with the
legend exclusion also lifted, 30 chains, 30/30 in the level set, 29/29
checkable agree (L3 findings 1, 5). The minimal synthetic: 3 gap reads →
0 rows; same call with one irrelevant native word → 3 rows (L2
numbers[15]). CEQA pizzuto-20216, balazs-30446 and york-drive records name
this gate as the reason they yield 0 rows. **Fix:** `if not cands and not
gap_z: return []`; the anchor and native-band gates at :1408-1425 already
handle an empty native population (`len(native_vals) >= 3` is False, the
25-ft anchor uses gap values). This moves `earthwork_sig` (§8.4) and must be
re-accepted in the same commit.

### 7.2 The `text_chars < 1500` gate → a plan-area coverage measure

Sites: `classify_page.py:207` (`text_chars=len(page.get_text())`),
`detect_page.py:244` (`pc.text_chars < 1500 and not has_layers`, chaining
OCR at :254, 150 dpi), `detect_page.py:303` (`pc.text_chars < 1500 and
pc.kind != "raster"`, legend OCR at :309), `milestone_report.py:33`
(`len(page.get_text()) < 1500 and not any(u.layer …)`, OCR at :38).
Measured on Home 2 Suites C3 p0: `text_chars = 2915` from 479 words whose
x-centre deciles are 1586..2525 pt on a 2592-pt sheet (199 at x > 0.85 W),
`has_layers = False` (52,362 units, all layer `''`), so **both gates
evaluate False and the canonical outline-text page gets no OCR at all**
(L1 finding 2). The title block masks an empty plan area. **Fix:** add
`PageClass.plan_text_coverage` = fraction of glyph-sized path clusters in
the plan area (page minus the denser of the right 15% / bottom 12% strip,
L4's convention) covered by a native word box; gate on
`plan_text_coverage < 0.5` (**UNMEASURED** threshold; H2S ≈ 0.0, RC ≈ 0.01,
DEM control ≈ 1.0). `text_chars` stays in `PageClass` for the UI.

### 7.3 The raw `get_text()` bypasses (at 998bf35)

Text that never passes through the words tuple; each must read the merged
layer (or be declared exempt). L1 counted seven; the list at 998bf35:

| # | site | today | change |
|---|---|---|---|
| 1 | `scale_detect.py:2019-2020` (L1: 1670/1672) `text = page.get_text()`, `_NTS.search(text)` | first `_scan` and NTS on raw text; the row rescan `_scan(_row_text(words))` is inside `read_text_layer` at :1985 (the first draft cited :2093, which is a comment) | `read_text_layer` gets **`merged_text = page.get_text() + "\n" + "\n".join(outline rows)`** — one line per outline row, native text untouched; `_NTS` over the same string. **Not** `_row_text(page_lines(page))`: `_scan` decides `wrapped = "\n" in text[a:m.start("feet")]` (:455) and `read_text_layer` (:1945-1953) refuses a caption only when it is wrapped *and* its value is a bar tick label — the join-artefact rule that fixed sundale 90→30 and harbison 180→60 at 998bf35. `_row_text` returns one `' '.join` string with `\|` separators and no newline, so feeding it as `text` sets `wrapped = False` everywhere and re-opens both. An outline caption whose number sits on its own row gets the same protection native text has. Test: `detect_scale(...).to_dict()` on sundale p1 and harbison p0 (`tests/baselines/sundale-road-30366_p1.json` pattern) byte-identical after site 1. |
| 2 | `classify_page.py:207` `text_chars` | the wrong quantity | keep, add `plan_text_coverage` (§7.2) |
| 3 | `detect_page.py:244` chaining-OCR gate | `text_chars < 1500` | `plan_text_coverage < 0.5` |
| 4 | `detect_page.py:303` legend-OCR gate | same | same |
| 5 | `milestone_report.py:33` | same, duplicated | same |
| 6 | `server.py:2324` (L1: 2219) `has_nts = _NTS.search(pg.get_text())` (spots route) | raw | `_NTS` over merged rows |
| 7 | `server.py:3253-3255` (L1: 3017) `if "LEGEND" not in pg.get_text()[:4000].upper(): continue` | a legend sheet whose LEGEND heading is outlined is never scanned; the 200-dpi retry at :3260-3275 sits *inside* the gate | test the merged words (`read_legend`'s own test at legend_detect.py:101 already does) |
| exempt | `detect_page.py:94` `read_sheet_number` spans | title-block real text | stays raw |
| exempt | `areas.py:282` SF-label spans | real text on sampled sheets | stays raw; revisit if an outline SF label is ever measured |
| exempt | `server.py:2104` sheet index listing, `:4173` AI-assist context | informational | stay raw |

Also: `extract.py:302-303` drops every path with no `'s'` in its type, so a
fill-only outline font never reaches `units` (L1 finding 4). The words
provider reads `get_drawings()` itself and is unaffected; no change to
`extract_strokes`.

### 7.4 psm 6 in the bar zoom, and the retry running on a FAILED row

`_ocr_zoom` (scale_detect.py:1366) calls `ocr_words` which hard-codes
`--psm 11` (text_detect.py:99). Measured on RC Ontario p7 (bar 144.0 pt,
ticks at 2393.8/2429.8/2465.8/2537.8 = 5/5/10 ft, printed `0 5 10 20`):
psm 11 returns `2`, `99`, `9`, `6`, `4`, `4` → rows of 1–2 labels, refused
by the ≥3-label guard; **psm 6 returns `0 5 10 20` (conf 78/64/64/97)
centred on the ticks** (L5 finding 5). Prototype with only the psm changed
and every guard untouched: RC p5 (10 ft/in), p6/p7/p8 (10), p10 (20),
Hurricane p2 and p6 (40.0167) become guarded tick-measured readings —
**7 of 17 pages, versus 0 under psm 11** (L5 numbers[8]); Hurricane C.3.5's
bar (40.0) is the evidence that refutes its lone 300 candidate. **Fix:**
`ocr_words(img, px_to_pt, min_conf, psm=11)` gains a `psm` parameter;
`graphic_scale_bar` calls `_ocr_zoom(page, region, psm=6)`. The caption
rescue's `_ocr_zoom` stays psm 11 in stage 1 because psm 6 also reads the
caption under the bar (`20�`/`10�`) and would feed `_scan` new candidates —
gate corpus-wide first (CLAUDE.md §6).

The retry gate at :1592 is `if not rows and ocr_retry`: on RC p3 the 150-dpi
pass returns a 3-label row `10 0 4` (printed 0 10 20 40; 20→0, 40→4), which
satisfies "rows exist", so the zoom never runs and the corrupt row then
fails the rate check → None (L5 numbers[9]; same shape on p0). **Fix:** run
the zoom when (a) the 150-dpi rows exist but every one is refused by the
guards, or (b) every row is built from non-native words (`source !=
"text"`) — a lane-supplied ladder must not suppress the independent pixel
read (§6.2 independence rule 2) — and prefer the zoomed ladder when it
passes. `_ocr_zoom` gains the `psm` parameter; the caller passes 6.

### 7.5 OCR `"single"` promotion requires bar agreement

`scale_detect.py:2100-2102` promotes an OCR `_rank` result as `best`. Live
wrong picks on dev: RC p10 best = 10 (`1" = 10' WHEN PRINTED AT FULL SIZE`
on DETAIL 1) where the bar and caption say 20; RC p0 best = 200 from the
INDEX MAP (right by coincidence — its bar is also 200) (L5 findings 8, L1
numbers[1]). **Fix:** an OCR-sourced pick becomes `best` only when
`graphic_scale_bar` (with §7.4) agrees within `BAR_AGREE_PCT`; otherwise
return `ScaleResult(None, cands, nts, "ocr", pick={"why":
"abstained-ocr-single", …})` — the shape the rescue already uses at
:2085-2091. `tests/test_scale_ocr_rescue.py` and
`tests/test_scale_bar_contradiction.py` are the existing fixtures to extend.
The bar that agrees must be independent of the OCR caption's source
(§6.2 rule 1 — for a psm-11 caption that means native ladder labels, the
psm-6 zoom, or tick geometry with a zoomed endpoint). How many pages this
turns into abstentions is **UNMEASURED**: the survey records carry `{best,
candidates}` per page and no `source` (re-checked), so the population of
OCR-`single` picks cannot be read from it (§10.15).

### 7.6 Legend-family exclusion must be visible (fence, not fix)

On the DEM outline sheet the OCR'd legend reads 9/9 rows correctly, but
style 8 (grey 0.55, 0.4 pt dash1, **14 existing-contour chains**) is matched
to `GRADING NOTES` → role `noncontour` → 14 chains excluded, which is why
gap-OCR found 17 chains instead of 30 (label regions 114 vs 240; L3
finding 4). The control sheet matches the same style to `3420 PROPOSED
CONTOUR` (wrong the other way). `families_excluded` is already returned
(server.py:4705); stage 1 makes the UI show it and refuses a `noncontour`
verdict on a family whose chains look like contours (≥ 10 chains, dashed
grey, no legend row within the style's own colour) — the reader is not the
fix for this and must not be blamed for its rows.

---

## 8. Truth and gates

### 8.1 Exact-truth regression: the DEM outline sheet

`C:\Users\kobys\takeoff-demtruth\out\dem_truth\dem_hurricane_bench_a_pad_2ft_outline.pdf`
(sha256 `1b5dd5d1…fcfc1`, record
`ground-truth/dem_hurricane_bench_a_pad_2ft_outline.json`, worktree
feat/dem-truth @ 6c57a33). Text layer 0 chars / 0 words / 0 fonts; 10,287
drawings = f 136 / s 10,145 / fs 6; **113 black filled glyph-string paths
with 8,626 `'c'` + 2,040 `'l'` items, one path per string, 23% axis-aligned**
(S-dem) → class `filled-truetype` → **Lane B only; this sheet does not
exercise Lane A** (L2 finding 9 already asked for a stroked variant, §10.10).
Counts that must hold, with today's values (L3):

| item | truth | today (outline) | control (real text) | gate |
|---|---|---|---|---|
| spots FG 3401.60 at the 4 pad corners | 4 | 0 served (reader has no non-native source) | 4/4, legend_excluded 1 | **4/4**, 0 wrong |
| contour rows (chain-level truths = control's inline pairings) | 35 | 0 served (17 read and discarded at :1286) | 52 rows = 35 inline + 17 radius | stage 1: ≥ 17/35 all correct; lanes: **35/35**, 0 wrong |
| gap-OCR chains with legend exclusion lifted | 30 | 30/30 in level set, 29/29 agree | 33, one 8→9 misread | unchanged |
| scale | 40 ft/in, bar ticks 0/20/40/80 | best 40.0 `source=ocr`, 2 candidates, **bar None, agrees None** | `source=text`, bar 40.0, agrees True | **best 40.0 with `bar_ft_per_paper_inch` 40.0 and `agrees True`**, the bar read by drawn ticks + zoomed endpoints (§6.2 rule 1 iii), `bar_source != "outline-B"` |
| legend rows | 9 | 9/9 via OCR | 26 entries for 13 rows (doubled) | 9/9, no duplicates |
| inline labels rendered | 98 (79 existing + 19 proposed) | whole-page Tesseract 1/98 at 150 and 300 dpi | — | coverage: 98/98 *boxed* (as words or `'?'`) |
| cut / fill / net (exact raster truth) | 3256.7 / 3157.3 / −99.4 CY | not computable (0 rows) | — | a `compare: "tolerance"` entry in the earthwork manifest (§8.4), tolerance_pct 15 (the owner's band) |

Every figure here bounds corpus behaviour from *above* (Arial 7–10 pt,
horizontal caption, no clutter, no raster) and is the known-truth
regression, not the target (L3 implication 5).

### 8.2 Per-drafter-family recall table (28 corpus pages)

From `corpus-character/results.json` (28 pages) and `truth/truth.json` (15
eyeball-truth crops), reported **per family, never corpus-wide** (failures
cluster by drafter, L4 implication 5). Columns: family, page, class,
plan-area clusters (`words_in_plan_area`), read as values, read as `'?'`,
wrong against the truth crop, sub-1-pt marks recovered / printed. The 15
truth words that must read exactly (mark-ambiguous → candidates count as
read only if the printed string is among them):

| family | page | class | h pt | rot | truth as printed |
|---|---|---|---|---|---|
| RC Ontario | p0 | stroked | 7.2 | 0 | `CENTER` |
| Hurricane | p10 | stroked | 5.73 | 0 | `WATERLINE` |
| Bozeman Yards | p3 | stroked | 5.76 | 270 | `LUMINAIRE` |
| TownPump arch | p0 | stroked | 6.6 | 0 | `160'` |
| TownPump mech | p0 | stroked (two stroke widths) | 6.0 | 0 | `GROMMET` |
| TownPump elec | p0 | filled-staircase | 6.0 | 0 | `22` (in a hexagon tag) |
| Malta civil Cg1.01 | p0 | stroked | 9.36 | 270 | `EXISTING` |
| GAOA Star Meadow | p0 | filled-staircase (0.12 pt) | 11.52 | 0 | `GRASS SEED,` |
| Loves Lane C4.0 | p0 | stroked | 5.76 | 270 | `.02 FG` |
| GCHC | p0 | stroked | 4.5 | 0 | `4108.` |
| Wells Built | p12 | stroked | 6.3 | 270 | `48"O.C.` |
| Home 2 Suites C3 | p0 | filled-staircase | 6.48 | 270 | `89.38 EOA` |
| C2.1 Grading Rev0 | p0 | stroked italic lowercase | 4.8 | 0 | `utilities` |
| Helena Gipsy | p0 | filled TrueType, underlay | 4.54 | 90 | `3/10/2025` — **must ABSTAIN (underlay)** |
| Grey Bear | p0 | filled TrueType, underlay | 7.5 | 270 | `Scale:` — **must ABSTAIN (underlay)** |

Plus the page-level spot recall on Home 2 Suites C3 p0: denominator 178
(brief; **no hand truth map exists yet**, L1 implication — §10.6), floor
today 0, Tesseract-300 token floor 123 tokens at conf ≥ 85 (a token count,
not a spot count).

### 8.3 Acceptance test: the eleven CEQA records

`C:\Users\kobys\takeoff-ceqa\ground-truth\earthwork_ceqa_*.json` (11
records; PDFs under `C:\Users\kobys\takeoff-plans\public-ceqa`). All 11
carry `engine_comparability.usable_as_tuning_target_today: false`; five
(balazs-30446, harbison-canyon-21316, pizzuto-20216, sundale-road-30366,
york-drive-mup21008) also carry `scoreable_today: "no"`; the other six
(bradley-apts, montiel, pasqual-heights, ridgeway-drive, san-luis-rey,
south-village) state the same verdict in `why` without the flag. Printed
quantities (cut / fill CY unless noted): balazs 1,700 / 4,100; bradley
7,500 excavation; harbison 12,700 cut; montiel 96 / 16,019; pasqual
74,791 / 74,893; pizzuto 1,207; ridgeway 2,700; san-luis-rey 2.88 ac
disturbed (area, not volume); south-village 12,115; sundale 13,000 /
13,000; york 8,100. Acceptance = re-run the service on each record's
grading page and flip `usable_as_tuning_target_today` (and
`scoreable_today`) to true where: rows > 0 on both surfaces, spot recall
disclosed with its denominator, scale promoted only with bar agreement
(sundale reads 90 vs printed 30 today; harbison 180 vs 60 — both fixed by
`feat/scale-bar-contradiction`, already in 998bf35), and the engine's
cut/fill against the printed number recorded in the record. Montiel draws
no proposed contours (pad elevations only) and san-luis-rey prints an area:
those two flip only if spot-only surfaces are in scope — expected
**≤ 9 of 11** flip from this reader alone.

### 8.4 The earthwork regress gate must not move on real-text sheets

`tests/test_earthwork_regress.py` **does not exist at 998bf35**; it lives
in the `takeoff-ewgate` worktree (c198690) with
`tests/baselines/earthwork_manifest.json` (cases `oncor_c04`,
`oncor_c04_server`, `stice_p0`, all `compare: "recipe"`). Its rule:
`cut_yd3 / fill_yd3 / net_yd3` compared **exactly as floats** to the
committed baseline over frozen fixture rows, plus `earthwork_sig` (hash of
earthwork.py's import closure) — a code change that moves no volume still
fails as "re-baseline or explain". The reader's no-regression rule, stated
exactly:

1. On the DEM **control** sheet (real text) and the 5-sheet milestone
   corpus, `page_words(page)` must equal today's native list element for
   element (length-8 tuples, same order) and `TextLayer.page_class` must be
   `"native"`; `detect_scale(page).to_dict()`, the `/earthwork/suggest`
   row set (control: 52 rows) and `read_spot_grades` (control: 4/4) must be
   byte-identical before and after.
2. `gate-baseline.json` (`tests/test_gate.py`, `regress._check`) must not
   move: chain counts, precision, truth-class accuracy on the fast corpus.
3. The ewgate recipe cases pass unchanged except `earthwork_sig`, which
   the §7.1 commit re-accepts with `--accept` and a message naming :1286.
4. The DEM outline sheet is added to the manifest as a `tolerance` entry
   (cut 3256.7 / fill 3157.3 / net −99.4, `tolerance_pct` 15), SKIPPED
   with a printed reason where the PDF is absent, and `EARTHWORK_REQUIRE=1`
   on this machine.

---

## 9. Build order — each stage shippable alone with its test

| stage | what | test | expected win (measured basis) | what would prove it did not |
|---|---|---|---|---|
| **0** | Frozen fixtures: `page_words` + `get_drawings` census + truth for the DEM outline sheet, DEM control, H2S C3 p0, RC p0/p7, Hurricane p2/p6 as `tests/baselines/outline_*.json` (the pattern of `tests/baselines/sundale-road-30366_p1.json`); the per-family table harness | runs green with 0 outline words | none — measurement only | — |
| **1a** | §7.1 `:1286` gate | DEM outline suggest rows 0 → ≥ 17, all in level set; CEQA pizzuto/york rows > 0 | 17/17 correct rows recovered on the DEM sheet (L3) | rows still 0, or any control row changes |
| **1b** | §7.4 psm 6 bar zoom (`_ocr_zoom(..., psm=6)`) + zoom on refused rows + zoom forced when every row is non-native | RC p5/6/7/8/10, Hurricane p2/p6 return tick-measured bars; RC p3 20 ft/in; sundale p1 / harbison p0 unchanged | 7 of 17 measured pages (L5) — re-counted under the independence rule in §10.18 | fewer than 7, or a new bar reading on a control page that disagrees with its caption |
| **1c** | §7.5 OCR-single needs **independent** bar agreement (§6.2 rule 1); `values_refused`; `bar_source` | RC p10 → abstained with [10] and bar 20; C.3.5 → candidates [300], refused [40, 10], bar 40.0 | removes the two live 2×/7.5× promotions (L5) | any real-text control page loses its `best` |
| **1d** | §7.2 `plan_text_coverage` gate + §7.3 sites 1 (newline-preserving merged text), 6, 7 | H2S C3 p0 gets chaining/legend OCR; sheet-count of pages whose gates flip reported for the 529 thin pages; sundale p1 / harbison p0 `detect_scale` byte-identical | H2S: 2915 chars, 0 plan text, gates False today (L1) | a layered or real-text page starts OCR'ing (report the count, per CLAUDE.md "say what you skipped"); sundale or harbison regains its welded 90 / 180 |
| **2** | Provider skeleton: classification, glyph clustering, `'?'` pseudo-words (≥ 3-glyph clusters only), coverage dict, `w[8:]`, the §3.1 cache, abstention plumbing in the four consumers — **no recognition yet** | DEM outline: 98/98 labels + 4 spots + bar ladder *boxed*; underlay pages abstain; §8.4 rule 1 holds; `TextLayer` builds per suggest job 4 → 1; chain delta from `'?'` boxes reported per page class (§10.13) | scale "single" picks on outline pages become `abstained-outline` with coverage shown; count on the 529 thin pages | control sheets emit any outline word, or any chain delta on a real-text page |
| **3** | Lane B (filled) with marks, under `LANE_B_CALL_BUDGET` (§5.3a) and §5.4 rules 2(a)–(d) | DEM outline 4/4 spots, 35/35 rows, bar ticks read → agrees True via tick geometry + zoomed endpoints; H2S C3 `89.38 EOA`, TP E1.1 `22`, GAOA `GRASS SEED,`; H2S C3 p0 wall time reported at budget 400 and unbounded (§10.14) | H2S spot recall 0/178 → target ≥ 83/178 (the brief's Tesseract-300 figure as the floor to beat) | any confident-wrong promotion on the DEM sheet (0 allowed); > 60 s per page on H2S C3 p0 at budget 400; a stipple-adjacent `3480` promoted as `34.80` |
| **4** | Lane A (stroked), digit clusters confirmed by gap-OCR before any promotion (§4.3 step 5) | the 10 stroked truth words; RC p0/p7 caption + bar ladder (bar via native/zoomed labels, not the lane's own ladder); per-family table; `633.60` promoted, not merely offered | 68% of corpus word clusters; RC Ontario 14/14 pages from 0 candidates | cluster labelling disagreement > 20% on RC (§10.2); any digit cluster confirmed to a wrong label (§10.16) |
| **5** | Consumer surfacing: candidates in the spot/row/scale UI, `datum_info["ambiguous"]`, coverage chip | UI tests in the `tests/test_*.js` style | operators see "N of M read" instead of a green chip | — |
| **6** | §7.6 legend-family fence | DEM outline 30 chains reach gap-OCR (label regions 240) | 17 → 30 chains (L3) | control's 52 rows change |

Stage order is by measured yield per line of code: 1a is one condition and
recovers 17 rows; 1b is one keyword argument plus a retry condition and
recovers up to 7 bar readings.

**The three numbers stage 1 (1a–1d, no lane) is expected to move:**

1. DEM outline sheet `/earthwork/suggest` rows: **0 → ≥ 17** (17/17 correct
   gap-OCR reads served today as 0 rows, L3) — §7.1.
2. Tick-measured graphic-bar readings on the 17 L5 bar pages: **0 → 7**
   under psm 11 → psm 6 with the retry-on-refusal (RC p5/6/7/8/10,
   Hurricane p2/p6; RC p3 becomes 20 ft/in) — §7.4; §10.18 re-counts under
   independence.
3. Live wrong scale promotions on dev: **2 → 0** (RC p10 best 10 where the
   sheet says 20; Hurricane C.3.5 best 300 where the bar says 40) — both
   become abstentions with `values_refused` — §7.5.

What stage 1 does *not* move: the 296/529 plan-like pages with no `best`
(S-survey) — that is the lanes' number (stages 3–4), and stage 1 is
allowed to raise the abstention count on those pages, never to lower it.

---

## 10. Open questions and the one measurement that settles each

1. **Word-break gap for stroked fonts.** Intra-word gap p50 is 0.17–0.28 h;
   the inter-word gap is UNMEASURED. Measure: histogram of consecutive
   row-aligned glyph gaps / h on RC p0 and Hurricane p2 against the 15
   truth boxes; place the cut at the valley.
2. **Distinct clusters per document (Lane A).** Run the §4.3 clustering on
   RC p0's 10,455 glyphs; count clusters with n ≥ 3 and the fraction of
   glyphs in them. A count near 40–70 means the lane is viable; hundreds
   means the normalisation is wrong.
3. **Digit topology on stroked fonts.** Count closed loops on RC's `0`,
   `8`, `3`, `5` exemplars; if `8` does not reliably close two loops the
   §4.4 check is dropped.
4. **`plan_text_coverage` threshold.** Compute it on the 40 survey control
   pages and the 529 affected pages; report the two distributions and the
   count that flips at 0.5.
5. **Does masking linework help crop OCR?** L2 said "not measured yet".
   Re-run the small synthetic p1 (21/30 at 300 dpi full page, 25/30 crops)
   with stroked paths removed from the render.
6. **Home 2 Suites spot truth map.** 178 is the brief's count; make the
   hand truth (`ground-truth/Home_2_Suites_C3_p0.json`) before stage 3
   claims a recall.
7. **Two-dpi agreement rate on staircase text.** Lane B on H2S C3 at
   600 vs 900 dpi: fraction agreeing, and whether the disagreements are
   the printed 8/0/3/5 confusables.
8. **Cluster labelling method.** OCR-of-exemplar (§4.3) vs SHX reference
   matching: measure both on RC p0 against the `CENTER`/`633.60` truth and
   the bar ladder; pick by agreement and cost.
9. **Runtime on hatch pages.** Time the glyph assembly on Hurricane p10
   (22,809 tiny paths) and TP landscape (70,428); the budget is the
   existing ~5 s detect path per page (L3 numbers[10]).
10. **A stroked variant of the DEM sheet does not exist.** Build it
    (per-glyph flattened polylines, 5.76 pt, rotated labels, ARCH D) so
    Lane A has an exact-truth regression; L2 implication 4 lists the
    parameters.
11. **Rotated labels in Lane B.** The DEM sheet's 98 labels are rotated
    along contours; measure how many the CC + row-axis deskew boxes and
    reads, versus the chain-guided gap reader's 30/30.
12. **Mark-attachment promotion rate per family.** On RC p7 (377 of 948
    plan words with an adjacent tiny path), GCHC (117/183) and H2S C3 p0
    (5,160 stipple dots): how many attached marks pass §5.4 rule 2(a)
    placement and 2(b) density, i.e. how many spot values the reader can
    *promote* rather than offer. If RC p7 comes out near 0% the 3 h
    density radius is wrong, not the family.
13. **Chain delta from `'?'` boxes alone.** Stage 2 emits pseudo-words
    with no recognition; run `regress` on the fast corpus with and without
    them and report chains / precision / truth-class per page class
    (§3.3). Real-text pages must show zero delta; an outline page's delta
    is accepted only with the before/after chain overlay on a live :8100
    screenshot.
14. **Lane B call budget.** Time Lane B on H2S C3 p0 (966 clusters)
    unbounded and at `LANE_B_CALL_BUDGET = 400`; report calls, seconds,
    clusters read, and which of the 178 spots fall outside the
    numeric-first order. The budget is right when spot recall at 400 is
    within 5 points of unbounded recall (S-tess: 72–85 ms per call, so
    unbounded is 3–6 min).
15. **How many pages does §7.5 turn into abstentions?** The survey
    (`outline_survey_final.json`) records `{best, candidates}` and no
    `source`; re-run `detect_scale` on the 529 thin pages recording
    `source` and `pick["why"]`, count pages whose `best` is an OCR single
    today, and for each whether an independent bar (§6.2 rule 1) agrees.
16. **Cluster confirmation K.** On RC p7, for each digit cluster count the
    gap-OCR reads of words containing it that agree at that character
    position; report the distribution and pick K as the smallest value at
    which no cluster on RC p0/p7 is confirmed to a wrong label (`633.60`,
    the bar ladder `0 5 10 20` and `CENTER` as truth).
17. **Period advance and decimal-place mode.** Measure the inter-glyph gap
    around printed decimal points on the 6 mark-bearing truth crops (L4
    numbers[14]) and the decimal-count distribution of spot values per
    sheet (H2S C3, RC p7, GCHC); the 0.2–0.45 h window and the "≥ 5 words"
    floor of §5.4 rule 2 are set from them.
18. **Independence in practice.** On the 17 L5 bar pages and the DEM
    sheet: how many bars have a native ladder, how many need the forced
    psm-6 zoom, and how many are read by tick geometry plus one endpoint
    (§6.2 rule 1 iii). The count reaching `agrees True` under the
    independence rule is the real stage-1b/1c yield; "7 of 17" was
    measured without it.
