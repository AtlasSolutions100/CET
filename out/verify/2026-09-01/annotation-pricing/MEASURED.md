# Defect 0 — annotation priced as pipe: measured impact and the matcher

Measured 2026-09-01 against **116 cached detections** in the real job store
(read-only). Authorised by Koby: *"Its okay if it resets or changes current
files, clients and staff are aware that we may reset everything."*

## What changes

| | |
|---|---|
| sheets whose totals change | **63 of 116 — 54%** |
| runs that stop counting | ~~2,126~~ **1,582 families** |
| linework that stops counting | ~~394,566 pt~~ **347,440 pt** |

> **Corrected 2026-09-01 04:50.** The figures above the strikethrough
> were my pre-build estimate from a draft matcher. Re-measured against
> the matcher that actually shipped: **63 of 116 sheets (54%), 1,582
> families, 347,440 pt** — independently re-derived by an adversary to
> the digit. The sheet count did not move; the other two did, because
> the shipped matcher is narrower than my draft. Quote the shipped
> numbers, not these.

Biggest movers, all defensible as annotation:

| counted pt | runs | layer |
|---|---|---|
| 56,929 | 295 | `TXT-PS` |
| 41,094 | 82 | `TXT-NOTES` |
| 26,270 | 16 | `G-TTLB` — title block |
| 22,042 | 150 | `00-NOTES` |
| 21,204 | 29 | `BG-ANNO-SYMB` |
| 19,108 | 56 | `TXT-COVER` |
| 15,660 | 122 | `DETAIL-DIM` — dimension lines |
| 15,487 | 8 | `0046599.02TTLBLK|TITLEBLOCK - SHEET` |

## THE MATCHER MUST BE TOKEN-BASED, NOT SUBSTRING

This is the whole point and it was nearly got wrong. A naive substring test
for `DIM` matches **`SE-P-SEDIMENT LOG`** — se-**DIM**-ent — which is real
erosion-control linework, 37 runs, and it would have silently stopped being
counted. That is precisely the defect being fixed, reintroduced by the fix.

Equally, a plain token test misses `0046599.02TTLBLK|G-TBLK-LOGO` and
`TBLK_SHEET`, which genuinely are title blocks, because the drawing number is
fused onto the token.

So: split on `[-_|.\s/]`, then a token matches if it **equals** a marker, or
**ends with** one of the unambiguous multi-letter markers.

```python
EXACT  = ("TEXT TEXTS TXT ANNO ANNOT ANNOTATION ANNOTATIONS LEADER LEADERS "
          "LABEL LABELS CALLOUT CALLOUTS NOTE NOTES DIM DIMS DIMEN DIMENSION "
          "DIMENSIONS TTLB TTLBLK TBLK TITLEBLOCK TITLE KEYNOTE KEYNOTES")
SUFFIX = "TTLBLK TBLK TITLEBLOCK KEYNOTE KEYNOTES"

def is_annotation_layer(name):
    for t in re.split(r"[-_|.\s/]+", str(name)):
        if t and (t.upper() in EXACT.split() or
                  any(t.upper().endswith(s) for s in SUFFIX.split())):
            return True
    return False
```

### Test fixtures, taken from the real corpus — not invented

MUST match: `00-NOTES`, `P6-TEXT-STORM-C8.0`, `G-ANNO-TTLB-THIN`,
`BG-ANNO-SYMB`, `SP-TEXT-DIM`, `TXT-NOTES`, `TXT-PS`, `DETAIL-DIM`, `G-TTLB`,
`0046599.02TTLBLK|G-TBLK-LOGO`, `TBLK_SHEET`, `TITLEBLOCK-SHEET`

MUST NOT match: **`SE-P-SEDIMENT LOG`**

## The two halves of the fix

1. **Default off** (`webui/app.js` ~968). Today a style defaults off when it is
   white, textured, or `class === "annotation"`. Leaders and note boxes are
   straight strokes, so the classifier correctly calls them `solid`/`dash1`
   and they default **on**. Extend the test to an annotation-named CAD layer.
   This is what removes the footage from the tally.

2. **Rank `tradeFor`** (`webui/app.js` ~7372). It matches `STORM` inside
   `P6-TEXT-STORM-C8.0` and never consults the `TEXT` in the same string. Test
   the annotation markers FIRST and return early. This is the `CLAUDE.md` §5
   "first-writer-wins discards the right answer" shape: an either/or with no
   explicit ranking. Belt and braces — if an operator deliberately ticks an
   annotation layer on, it still must not be filed as pipe.

Neither half touches `_ENGINE_FILES`; `engine_sig` must not move.

---

## REVISED 2026-09-01 02:40 — Koby's refinement: a "Suggested disables" group

> "even something like putting them in a tab like 'suggested disables' when
> our confidence is high but not too high that something is a waste of
> measurement can move it there"

This is better than the silent default-off above, and the measurement is what
shows why. **Every one of the 2,126 runs is a case where two signals
disagree**: the CAD layer name says annotation, and the engine measured the
geometry as `solid`/`dash1` linework. That is not high confidence. Flipping
394,566 pt out of the tally with no explanation would be making an engine
judgement invisible — the same failure as silently counting it, in the other
direction.

### The tiers, which the evidence hands us

| signals | confidence | behaviour |
|---|---|---|
| `class == "annotation"` AND name says annotation | high | default off — **unchanged**, this is today's behaviour |
| **name says annotation, geometry says linework** | **medium — the disagreement** | **Suggested disables: unticked, visible, explained** |
| neither | — | counted, as now |

### How it should look

A **group in the line-styles list**, not a new panel. That reuses machinery
that already exists and is already correct:

- the group tick, including the partial-selection restore built on
  2026-08-31 — tick, untick, tick again gives back the operator's own subset
- hover-to-highlight, so hovering the group paints exactly what would stop
  being counted, on the sheet
- the same swatch, count and measured-length columns as any other row

The group header carries the stakes: how many families, how much footage, and
the priced delta if a rate is set. The operator should be able to see what
accepting the suggestion costs them before accepting it.

Each row says **why** it is suggested, in the app's own disclosure voice —
something like *"the drafter's layer name says TEXT; the engine measured this
as solid linework. Counted as 2,974 ft if you tick it."* No jargon, and the
number stays visible so nothing is hidden by the suggestion.

### A cheap signal that would sharpen the tier

Where the runs SIT on the sheet. Title-block and notes linework clusters in a
border or a corner; real plan linework is distributed across the drawing area.
That is a cheap geometric corroboration and it would let the top tier
(`G-TTLB`, `TITLEBLOCK-SHEET`) be genuinely high confidence rather than
name-only. Worth measuring before relying on it — do not assume it.

### Why this is also the safer change

It touches 54% of sheets. A visible, one-click-reversible suggestion is
recoverable by the operator; a silent default is only recoverable by someone
who notices. And an operator ticking a suggestion back ON is a training
signal we would otherwise never see.
