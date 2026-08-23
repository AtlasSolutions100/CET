"""Automatic scale detection from plan sheets.

Reads scale notations like:
    SCALE: 1" = 20'        (civil)
    Scale: 1/4" - 1'-0"    (architectural; separators vary: = - :)
    1" = 50'  /  3/32" = 1'-0"
    1 inch = 10 ft.  /  1 INCH = 20 FEET   (spelled-out units)

Sources, in order:
  1. the PDF text layer (as get_text() emits it, then re-assembled from
     row-sorted words - AutoCAD scale-bar blocks store the ratio's number
     as a separate attribute, so get_text() prints "1 inch =      ft." and
     drops the "10" among the tick labels),
  2. the drawn GRAPHIC SCALE bar,
  3. OCR of the rendered page (CAD exports often explode the scale note
     into strokes - C4.0's "SCALE: 1\" = 20'" has no text layer at all).

Returns ALL candidates with context, plus a chosen best (keyword-adjacent
beats bare matches). "NOT TO SCALE"/"N.T.S." presence is reported too -
sheets routinely mix a scaled plan with NTS details, so the reviewer sees
what was found rather than silently trusting one number.
"""

import re
from dataclasses import dataclass, field

import numpy as np
import pymupdf

# Unit marks. Tick marks (" ') are the common form; sheets also spell the
# units out ("1 inch = 10 ft.", "1 INCH = 20 FEET"). A spelled-out unit must
# end the word (no letter after it) so "in" is not the start of "inside"
# and "ft" not of "ftg"; the tick forms keep matching whatever follows.
_IN = r"""(?:["”″]|(?:inch(?:es)?|in)\.?(?![a-z]))"""
_FT = r"""(?:['’′]|(?:feet|ft)\.?(?![a-z]))"""

# The paper term of a ratio. Architectural scales coarser than one inch to
# the foot are written as MIXED numbers - 1-1/2" = 1'-0", 1 1/2" = 1'-0" -
# and a bare `\d+(?:/\d+)?` cannot hold one: it matched only the "1/2" and
# reported 2.0 ft/in where the truth is 0.667, a 3x error on length and 9x
# on area. Found on three sheets independently by the 201-sheet audit
# (Barn Structural S6-0.0, Guide Structural S6-0.0, Barn Landscaping L801),
# and confirmed against drawn geometry: L801 detail 2's printed 6" dimension
# spans exactly 54.000 pt, i.e. 0.75 paper inches, which is 0.667 ft/in.
# Alternation order matters - mixed, then fraction, then integer - or `\d+`
# would swallow the "1" of "1/2" and stop.
#
# The mixed form is deliberately restricted to ONE AND A HALF. A general
# `\d+[-\s]\d+/\d+` regressed two pages in the 208-page sweep, because the
# space-separated form is ambiguous: `A5.20 1 1/2" = 1'-0"` is a real scale,
# but `SWR - GR 1 3/4" = 1'-0"` is the 3/4" scale with a detail reference in
# front of it, and `2 3/4" 1 3/4" 1/2"` is a row of dimensions. Read greedily
# those became 1.75 and 2.75 paper inches.
#
# CONVENTION, and the reason the restriction is safe: an architect's scale
# rule carries fixed graduations - 3/32, 1/8, 3/16, 1/4, 3/8, 1/2, 3/4, 1,
# 1-1/2 and 3 inches to the foot - and 1-1/2 is the only one of them that is
# a mixed number. Source: every scale caption in the Beaumont and Thielen
# sets is drawn from that set; 1-3/4 and 2-3/4 appear in the corpus only as
# dimensions. Labelled an INFERENCE for other drawing standards. If a real
# mixed scale outside 1-1/2 ever turns up, widen this with its sheet as
# evidence rather than by generalising the pattern.
#
# The mixed number's joiner is SPACE, TAB or HYPHEN - deliberately not `\s`,
# which matches a NEWLINE. get_text() separates lines with newlines, so with
# `\s` a whole number ending one line welds onto a fraction starting the
# next: Barn Structural engine page index 25 = printed sheet S5.1 prints
# `PROJECT #24004520.01` in the title block directly above `1/2" = 1'-0"`,
# and the weld read `1\n1/2" = 1'-0"` as 1-1/2" = 0.6667 ft/in - a scale the
# sheet does not print, and since 36f3dd5 a clickable picker option that
# divides every length on the page by three. A caption's own paper term
# never wraps (it is one token in one title bar), so nothing real is lost
# by refusing the line break; the 208-page sweep confirms exactly one
# candidate-set change from this line, that page, that value.
_NUM = r"""(?:1[ \t-]1/2|\d+/\d+|\d+)"""

# OCR does not always give the inch mark back as an inch mark. Tesseract
# reads Beaumont's structural title blocks - SCALE: 1/4"=1'-0" - as
# `1/4�=1'-0"`, mangling the double prime into U+FFFD. The pattern then
# cannot advance past that character and the whole caption is missed, which
# is why all 37 Barn Structural and 17 Guide Structural pages reported no
# scale even though OCR had read the text correctly at every dpi tried
# (150/300/450 all produce `SCALE: 1/4�=1'-0"`).
#
# One stray non-word character is therefore allowed where a unit mark
# belongs. It is captured into its OWN group and is deliberately NOT counted
# as evidence by the F92 shape guard: a caption still has to carry a real
# paper term plus either a genuine inch mark or a separator. Here `1/4` and
# `=` supply both, so the match is legitimate on its own merits.
_NOISE = r"""(?P<noise>[^\w\s=:\-])?"""

# 1/4" = 1'-0"   |   1" = 20'   |   1"= 50'   |   1 inch = 10 ft.
# separators = - :  (required here - no keyword to vouch for the match)
_PAT = re.compile(
    rf"""(?P<paper>{_NUM})\s*{_IN}\s*
        (?:[=:\-]\s*){{1,2}}          # OCR sometimes doubles the separator
        (?P<feet>\d+)\s*{_FT}
        (?:\s*-\s*(?P<inches>\d+)\s*{_IN})?""",
    re.X | re.I,
)
_NTS = re.compile(r"(?i)\bN\.?\s*T\.?\s*S\.?\b|NOT\s+TO\s+SCALE")

# OCR often loses the inch/foot marks completely ("SCALE: 1 = = 20").
# Units are then implied by convention (paper inches = real feet), but only
# trust that when anchored right after the SCALE keyword.
# Every part but <feet> is optional, so the word SCALE followed by any bare
# integer also matches - and a keyword hit outranks everything in _choose.
# The separator and the unit marks are captured so that case can be told
# apart and rejected: see the guard in _scan.
_PAT_KEYWORD = re.compile(
    rf"""(?i)scale\s*(?P<kwsep>[:=])?\s*
        (?P<paper>{_NUM})?\s*(?P<inmark>{_IN})?\s*   # OCR may eat the 1"
        {_NOISE}\s*                                        # ... or mangle it
        (?P<sep>(?:[=:\-]\s*){{0,2}})                      # ... or the separator
        (?P<feet>\d+)\s*(?P<ftmark>{_FT})?
        (?:\s*-\s*(?P<inches>\d+)\s*{_IN}?)?""",
    re.X,
)

# OCR word order can put the ratio BEFORE the keyword ('1" 10' SCALE:' on
# the C4.x grading plans): same relaxed body, keyword trailing. Degree
# signs stand in for foot marks in OCR output, so they count as ticks.
# That form carries no separator, so one cannot be required here - instead
# <sep>/<gmark> are captured and checked in _scan: with no separator the
# ground term must declare its own foot mark, or the two numbers are merely
# adjacent rather than related.
_PAT_KEYWORD_PRE = re.compile(
    rf"""(?i)(?P<paper>{_NUM})\s*{_IN}
        (?P<sep>\s*(?:[=:\-]\s*){{0,2}})
        (?P<feet>\d+)\s*(?P<gmark>{_FT}|[°º])?\s*
        (?:-\s*(?P<inches>\d+)\s*{_IN}?\s*)?
        scale\b""",
    re.X,
)

# An '=' or ':' actually relating the two sides of a match. Used to gate the
# feet-and-inches ground form, which is otherwise a dimension callout.
_REL = re.compile(r"[=:]")


@dataclass
class ScaleCandidate:
    text: str
    ft_per_paper_inch: float
    near_scale_keyword: bool
    count: int = 1
    # What this reading GOVERNS: the linework sitting above the title bars
    # that print it, in pt and as a share of everything assigned on the
    # sheet (see _rank). None = not measured - single candidate, ranking
    # skipped, or ranking failed. 0.0 is a MEASURED zero (a caption whose
    # detail has no linework), so test `is None`, never truthiness.
    # `sites` is how many printed caption locations were found for it.
    governs_pt: float | None = None
    governs_pct: float | None = None
    sites: int = 0

    def to_dict(self) -> dict:
        return {
            "text": self.text,
            "ft_per_paper_inch": self.ft_per_paper_inch,
            "near_scale_keyword": self.near_scale_keyword,
            "count": self.count,
            "governs_pt":
                None if self.governs_pt is None else round(self.governs_pt, 1),
            "governs_pct":
                None if self.governs_pct is None else round(self.governs_pct, 1),
            "sites": self.sites,
        }


@dataclass
class ScaleResult:
    best: ScaleCandidate | None
    candidates: list = field(default_factory=list)
    has_nts: bool = False
    source: str = ""  # "text" | "ocr" | "graphic-bar"
    # Independent second opinion from the drawn GRAPHIC SCALE bar, whose tick
    # spacing is geometry rather than text. A wrong scale is the most
    # expensive silent failure this engine has - 14 corpus pages were wrong
    # and every one reached the UI as a confident green chip (F92) - and on
    # the sheets that carry both readings the two agree everywhere except
    # exactly where the bug was. Cross-checking is therefore the cheapest
    # detector of the whole failure class, and it costs nothing when there
    # is no bar. This NEVER changes which scale is chosen; it only records
    # whether a second source backs it.
    bar_ft_per_paper_inch: float | None = None
    agrees: bool | None = None      # None = no bar to compare against
    # Why `best` is best, stated by the engine instead of replayed from the
    # candidate list by a reader who has to guess (the banner's
    # scalePickWhy() replays _choose's old branches; against this module it
    # lands on its honest "unknown" arm until it is taught to read this).
    # `pick["why"]` is one of:
    #   "single"    one distinct value - nothing to rank
    #   "governs"   ranked by the linework each printed caption governs;
    #               the winner leads strictly (see `margin`)
    #   "unranked"  several values and no ranking could be made - `reason`
    #               says why; `best` is then the old keyword-then-count
    #               order and must be presented as UNCHECKED, not explained
    #   "bar"       the drawn graphic bar - no printed caption at all
    # Alongside: the winner's governed share, the runner-up and its share,
    # their ratio, how much linework had no caption beneath it, how much
    # was excluded as sheet furniture, and which measure was used ("paths"
    # = raw page geometry; "chains" = the caller's own live chains).
    pick: dict = field(default_factory=dict)

    @property
    def delta_pct(self) -> float | None:
        if not self.best or self.bar_ft_per_paper_inch in (None, 0):
            return None
        a = self.best.ft_per_paper_inch
        if not a:
            return None
        return abs(a - self.bar_ft_per_paper_inch) / self.bar_ft_per_paper_inch * 100.0

    def to_dict(self) -> dict | None:
        if not self.best:
            return None
        d = self.delta_pct
        return {
            **self.best.to_dict(),
            "source": self.source,
            "has_nts": self.has_nts,
            "candidates": [c.to_dict() for c in self.candidates],
            "bar_ft_per_paper_inch": self.bar_ft_per_paper_inch,
            "agrees": self.agrees,
            "delta_pct": None if d is None else round(d, 1),
            "pick": dict(self.pick),
        }


def _frac(s: str) -> float:
    """A scale's paper term: "3", "1/2", or the mixed "1-1/2" / "1 1/2"."""
    s = s.strip()
    m = re.fullmatch(r"(\d+)[-\s](\d+)/(\d+)", s)
    if m:
        return float(m.group(1)) + float(m.group(2)) / float(m.group(3))
    if "/" in s:
        a, b = s.split("/")
        return float(a) / float(b)
    return float(s)


def _scan(text: str) -> list[ScaleCandidate]:
    found: dict[tuple, ScaleCandidate] = {}

    def add(m: re.Match, near: bool):
        paper = _frac(m.group("paper") or "1")
        if paper <= 0 or paper > 12:
            return
        feet = float(m.group("feet")) + (float(m.group("inches") or 0)) / 12.0
        if feet <= 0:
            return
        fpi = feet / paper
        # Plausible drawing scales: 1/8"=1' (8) up to 1"=200'.
        #
        # The 0.5 floor was discarding a real and frequently printed scale.
        # Barn Landscaping L804 prints `SCALE: 3" = 1'-0"` FOUR times - more
        # often than any other caption on that sheet - and 3 paper inches to
        # the foot is 0.3333 ft/in, so every one was thrown away and the
        # engine settled on the 3/4" detail scale instead.
        #
        # The floor cannot simply be lowered, because a dimension string
        # computes to the same number: `6" - 2'` on Thielen p18 is also
        # 0.3333, and `6" - 1'` and `8" - 1'` sit below it. What separates
        # them is the RELATION - a scale says "=" or ":" between its two
        # sides, a dimension callout is joined by a hyphen. So the floor
        # relaxes only for a reading that states one.
        #
        # CONVENTION: 3" = 1'-0" is the LARGEST scale on an architect's rule
        # (3/32, 1/8, 3/16, 1/4, 3/8, 1/2, 3/4, 1, 1-1/2, 3 inches to the
        # foot), and 3 paper inches to the foot is exactly 1/3 ft/in - so 0.33
        # is the floor, sitting just under it. Source: 3" is also the largest
        # caption printed anywhere in the Beaumont or Thielen sets. Anything
        # larger is half- or full-size shop detailing and stays rejected until
        # a sheet shows otherwise. INFERENCE for other drawing standards.
        #
        # Confirmed against drawn geometry, not the caption: on Barn
        # Landscaping L804 detail 9 the three stacked dimensions measure
        # tick-to-tick 36.00 / 72.00 / 108.00 pt for 2" / 4" / 6", which is
        # 18.000 pt per real inch on all three - exactly 3" = 1'-0".
        floor = 0.33 if _REL.search(m.group(0)) else 0.5
        if not (floor <= fpi <= 400):
            return
        key = (round(fpi, 4), near)
        if key in found:
            found[key].count += 1
        else:
            found[key] = ScaleCandidate(m.group(0).strip(), fpi, near)

    def compound_needs_relation(m: re.Match) -> bool:
        """Reject a feet-and-inches ground term with nothing relating it.

        N'-M" is how a dimension callout is written, so on its own it is a
        length. It is also the right-hand side of an architectural scale,
        but there the two sides are related in one of two visible ways:

          * an explicit '=' or ':' BETWEEN them (<sep>, not the keyword's
            own colon in "SCALE:") - 1/4" = 1'-0", 3/16" = 1'-0",
            1" = 16'-0"; or
          * the ground side is exactly 1'-0", which is what the notation
            means - "an eighth of an inch to the foot". CONVENTION, from
            these sheets: every architectural caption in the Beaumont sets
            is written X" = 1'-0", i.e. the ground side is one foot. OCR
            drops the '=' often enough (Thielen p57/p58 read
            '1/8" 1'-0" SCALE:') that the form has to survive without it.

        Anything else - 5'-2", 11'-3 1/2" - is a callout, not a ratio.
        """
        if not m.group("inches"):
            return False
        sep = m.group("sep") or ""
        if _REL.search(sep):
            return False
        return not (int(m.group("feet")) == 1 and int(m.group("inches")) == 0)

    for m in _PAT.finditer(text):
        ctx = text[max(0, m.start() - 30): m.start()]
        add(m, bool(re.search(r"(?i)scale", ctx)))
    for m in _PAT_KEYWORD.finditer(text):
        # A scale is a RATIO, so BOTH of its sides have to be on the page.
        # Every part of this pattern but <feet> is optional, so without a
        # shape test it reduces to "the word SCALE followed by a number" -
        # and a keyword hit outranks everything in _choose. Two live cases:
        # Guide C3.0 (engine page index 2) row-joined to "... SCALE 2% 2% W
        # CONSTRUCTION ..." and read 1" = 2 ft over the sheet's own "1 inch
        # = 10 ft." (5x on every length, 25x on every area and volume);
        # Barn Civil (engine page index 1) row-joined the bar caption to a
        # 5'-2" dimension callout and read 1" = 5.17 ft over "1 inch = 20
        # ft.". Requiring any ONE token is not enough - the second case
        # carries a foot mark, but it belongs to the dimension, not to a
        # ratio. Require the LEFT side (<paper>) plus something joining it
        # to the right side: its own inch mark, or a separator. The OCR
        # case this pattern exists for ("SCALE: 1 = = 20") has both.
        # <kwsep> is the keyword's own colon in "SCALE:", not a relation
        # between two sides, so it is not evidence on its own.
        if not (m.group("paper")
                and (m.group("inmark") or (m.group("sep") or "").strip())):
            continue
        if compound_needs_relation(m):
            continue
        add(m, True)
    for m in _PAT_KEYWORD_PRE.finditer(text):
        # No separator between the sides -> the ground term has to declare
        # its own unit, else these are two unrelated numbers that only
        # happen to sit beside the word SCALE ('3/8" 6 SCALE', Guide Civil
        # engine page index 6, from OCR).
        if not ((m.group("sep") or "").strip() or m.group("gmark")):
            continue
        if compound_needs_relation(m):
            continue
        add(m, True)
    return list(found.values())


# ---------------------------------------------------------------------------
# Which of several printed scales governs the drawing
# ---------------------------------------------------------------------------
# A sheet that carries a plan and its details prints one caption per drawing,
# and the choice used to be "keyword-adjacent, then most repeated". On a
# detail sheet that runs exactly backwards: many small details, one big
# plan, so caption count is INVERSELY related to how much drawing a scale
# governs. Audit RC-2, root of eight findings; live regression F113: 08e818d
# made `3" = 1'-0"` readable and count promptly handed Barn Landscaping L804
# (engine page index 29 = printed sheet 30) to it over the `3/4"` scale.
#
# So rank by WHAT EACH CAPTION GOVERNS. The document asserts the binding:
# every multi-scale sheet in the corpus prints a detail's caption in a TITLE
# BAR beneath the detail - bubble number, title, `SCALE: ...`, and a
# horizontal rule - and the drawing is the linework above that rule. Three
# independent drafters agree (SWR landscaping/structural, Thielen): all 104
# caption sites on the corpus' 16 multi-candidate pages sit on such a rule
# (per-page counts in the sweep's sites/rules fields, 2026-08-22 choose
# sweep). Measured rule-to-caption gaps: 7.1 pt on L804, 3.2 on Guide
# Structural S6-0.0, 1.0 on Thielen A1.2; the next horizontal stroke above
# a caption is the detail's own linework, 20+ pt up. CONVENTION, from these
# sheets: the title bar sits BELOW its drawing. Labelled an INFERENCE for
# drafters outside the corpus; where it fails to locate a caption the sheet
# reports "unranked" rather than a wrong answer.
#
# Assignment, per stroke unit: the caption beneath it (rule y >= centre y)
# with the least cost, cost = vertical gap to the rule + horizontal excess
# outside the rule's x-span. Nothing is bucketed; a unit with no caption
# beneath it is UNASSIGNED and reported as such. The measure is
# extract_strokes' own units - the geometry the chain stage prices, before
# chaining - minus whiteout and HATCH-layer strokes (the chain stage's own
# two cheapest demotions). That is a PROXY for the live chains: checked
# against build_chains' live chains under the same assignment on 15 of the
# corpus' 16 multi-candidate pages (the 16th, Barn Structural engine p1,
# is OCR-sourced and was not cross-checked): same winner on 15 of 15,
# winner's share within 8.5 points everywhere (worst: Thielen p8, 73.6%
# raw vs 65.1% chains; see chains_vs_paths.log in
# out/verify/2026-08-22/choose/work/). A caller that already built the
# page's chains can pass them to detect_scale(linework=...) and the
# ranking uses those instead.
#
# What this does NOT do: apply different scales to different regions of one
# sheet. That is per-viewport scaling and a separate design. This picks one
# default, and states why - including the margin, because on a sheet of ten
# details the "winner" can govern under 40% of the linework and the reader
# deserves to know how thin that is.

# How far above a caption's top edge its title-bar rule may sit (measured:
# 7.1 / 3.2 / 1.0 pt across the three drafters), and how far below (the
# rule never sits below the caption on any corpus sheet; 2 pt of slop).
_RULE_ABOVE = 12.0
_RULE_BELOW = 2.0
# The shortest horizontal stroke read as a rule candidate. Thielen draws
# the narrowest title bars in the corpus; its shortest rule measures
# 100.7 pt (A1.2). Text underlines in note blocks are shorter than 60.
_RULE_MIN_PT = 60.0
# A straight stroke spanning at least this fraction of the page in one
# axis, sitting in the outer quarter of the page on the other axis, with
# every caption on the interior side, cuts a SHEET-FURNITURE strip off the
# drawing area (the title-block column: logo, consultant list, revision
# grid). The far side is not counted at all - neither governed nor
# unassigned. Both conditions are load-bearing: the SWR template's divider
# at x = 2736 of 3024 spans 0.93 of the page height and its strip holds
# 24,111 pt of exploded logo and consultant text (L804, measured), which
# would otherwise be assigned to whatever detail column sits nearest - on
# L804 that flips the sheet to `3"`, the exact wrong answer this ranking
# exists to prevent; but a long drawn line in the MIDDLE of a sheet - a
# road centreline, a property line - must never cut, so the strip must hug
# an edge. chain.py's _demote_sheet_furniture solves the same problem by
# layer name + edge position; the L804 title block carries NO layer name
# (463 unnamed units), so geometry has to carry it here.
_DIVIDER_FRAC = 0.8
_EDGE_STRIP = 0.25
# Two leaders closer than this fraction of all assigned linework are a
# TIE: the sheet does not have a single governing scale that this measure
# can name, and saying so beats picking by 0.4% of a proxy. This is a
# numerical-equality guard, not a tuned threshold - the closest real
# margin in the corpus is 1.16x (L804), more than thirty times wider.
_TIE_FRAC = 0.005


def _text_lines(words: list) -> list[list]:
    """Word boxes grouped into printed lines, each sorted left to right.

    Text-layer words carry mupdf's own (block, line) ids - the drafter's
    line breaks - and those are used as they stand (the document asserts,
    we do not re-infer). OCR words are 5-tuples with no ids, so they are
    walked by vertical overlap and the height-keyed column gap already
    measured for _row_text. Sweep LEFT TO RIGHT, not top to bottom: OCR
    puts "SCALE:" a point or two below its own ratio often enough that a
    top-down walk reaches the ratio first, opens a row, and then cannot
    accept a word to its left.
    """
    if words and len(words[0]) >= 7:
        grp: dict = {}
        for w in words:
            grp.setdefault((w[5], w[6]), []).append(w)
        return [sorted(v, key=lambda w: float(w[0])) for v in grp.values()]
    rows: list[list] = []
    for w in sorted(words, key=lambda w: (float(w[0]), float(w[1]))):
        if not str(w[4]).strip():
            continue
        best, best_ov = None, 0.0
        for r in rows:
            p = r[-1]
            h = min(float(p[3]) - float(p[1]), float(w[3]) - float(w[1]))
            ov = min(float(p[3]), float(w[3])) - max(float(p[1]), float(w[1]))
            gap = float(w[0]) - float(p[2])
            if ov > 0.5 * max(h, 1.0) and ov > best_ov and -2.0 <= gap <= max(
                    _ROW_GAP_MIN, _ROW_GAP_HEIGHTS * max(h, 1.0)):
                best, best_ov = r, ov
        if best is None:
            rows.append([w])
        else:
            best.append(w)
    return rows


def _caption_sites(words: list, hlines: list) -> list[dict]:
    """Every printed scale caption, where it sits, and its title-bar rule.

    One site per (printed line, scale value). `rule` is the LONGEST
    horizontal stroke in the band just above the caption that starts at or
    left of the caption's left edge and is at least as wide as the caption
    - an explicit ranking, not first-found. None when the caption has no
    rule; the caption's own box then stands in for it.

    `compound` marks the sites of a line that yielded MORE THAN ONE distinct
    value. Those sites are all given the identical box and rule - they are
    the same printed characters - so nothing downstream can tell them apart
    and the assignment in `_governance` cannot honestly be made. See _rank,
    which refuses to rank such a page. A line printing the SAME value twice
    is not compound: the set below collapses it to one site.
    """
    out = []
    for L in _text_lines(words):
        txt = " ".join(str(w[4]) for w in L)
        cs = _scan(txt)
        if not cs:
            continue
        x0 = min(float(w[0]) for w in L)
        y0 = min(float(w[1]) for w in L)
        x1 = max(float(w[2]) for w in L)
        y1 = max(float(w[3]) for w in L)
        rule = None
        for idx, (hx0, hx1, hy) in hlines:
            if (y0 - _RULE_ABOVE <= hy <= y1 + _RULE_BELOW
                    and hx0 - 4.0 <= x0 <= hx1
                    and hx1 - hx0 >= x1 - x0
                    and (rule is None or hx1 - hx0 > rule[1] - rule[0])):
                rule = (hx0, hx1, hy, idx)
        vals = sorted({round(c.ft_per_paper_inch, 4) for c in cs})
        for v in vals:
            out.append({"fpi": v, "text": txt, "box": (x0, y0, x1, y1),
                        "rule": rule, "compound": len(vals) > 1})
    return out


def _page_linework(page: pymupdf.Page) -> tuple[list, list, list]:
    """The page's stroked linework, read through extract_strokes itself
    so clip regions, hidden OCG layers, rotation and thin-rect centrelines
    are handled by the ONE implementation that already handles them.

    Returns (paths, hlines, dividers):
      paths    [(length, cx, cy), ...] one entry per stroke unit that is
               not whiteout and not on a HATCH layer (the chain stage's own
               two cheapest demotions, same tests), minus the page frame;
               (cx, cy) is the unit's bbox centre.
      hlines   [(path index, (x0, x1, y)), ...] horizontal strokes >=
               _RULE_MIN_PT - the title-bar rule candidates.
      dividers [("v", x, path index) | ("h", y, path index), ...] straight
               strokes spanning >= _DIVIDER_FRAC of the page in one axis.
    """
    from .extract import extract_strokes

    W, H = float(page.rect.width), float(page.rect.height)
    paths: list = []
    hlines: list = []
    dividers: list = []
    for u in extract_strokes(page):
        if u.color and min(u.color) > 0.92 and not u.on_fill:
            continue                    # whiteout (chain.py's skip, verbatim)
        lay = (u.layer or "").upper()
        if "HATCH" in lay and "NO HATCH" not in lay and "NOHATCH" not in lay:
            continue                    # hatch decoration (chain.py's test)
        if len(u.pts) < 2 or u.length <= 0.0:
            continue
        mn = u.pts.min(axis=0)
        mx = u.pts.max(axis=0)
        w, h = float(mx[0] - mn[0]), float(mx[1] - mn[1])
        if w >= _DIVIDER_FRAC * W and h >= _DIVIDER_FRAC * H:
            continue                    # the page frame (finding #10)
        idx = len(paths)
        paths.append((float(u.length),
                      float(mn[0] + mx[0]) / 2.0, float(mn[1] + mx[1]) / 2.0))
        # "Straight" tolerances are sliver widths, not hairlines: a rule or
        # a divider is routinely PLOTTED as a thin filled box, and
        # extract_strokes collapses those to centrelines that keep a little
        # width (the SWR divider at x=2736 is a 4.5 pt sliver whose
        # centreline units carry 2.3-4.5 pt of bbox width; a 0.6 pt test
        # missed all three and the title block silently rejoined the
        # drawing). 4 pt for a rule, 6 for a divider - both far under the
        # 12 pt of _RULE_ABOVE headroom and the quarter-page edge strip
        # that consume them.
        if h <= 4.0 and w >= _RULE_MIN_PT:
            hlines.append((idx, (float(mn[0]), float(mx[0]),
                                 float(mn[1] + mx[1]) / 2.0)))
            if w >= _DIVIDER_FRAC * W:
                dividers.append(("h", float(mn[1] + mx[1]) / 2.0, idx))
        elif w <= 6.0 and h >= _DIVIDER_FRAC * H:
            dividers.append(("v", float(mn[0] + mx[0]) / 2.0, idx))
    return paths, hlines, dividers


def _chain_linework(chains) -> list:
    """(length, cx, cy) per LIVE chain, for a caller that already built
    them: objects with .pts/.length/.klass, or plain (length, cx, cy)
    triples. Annotation chains are the chain stage's own junk verdict and
    stay out of the measure."""
    out = []
    for c in chains:
        if isinstance(c, (tuple, list)) and len(c) == 3:
            out.append((float(c[0]), float(c[1]), float(c[2])))
            continue
        if getattr(c, "klass", None) == "annotation":
            continue
        pts = np.asarray(getattr(c, "pts", ()), dtype=float)
        if len(pts) < 2:
            continue
        mn, mx = pts.min(axis=0), pts.max(axis=0)
        out.append((float(getattr(c, "length", 0.0)),
                    float(mn[0] + mx[0]) / 2.0, float(mn[1] + mx[1]) / 2.0))
    return out


def _governance(sites: list, paths: list, dividers: list, skip: set,
                page_wh: tuple) -> tuple[dict, float, float]:
    """Linework governed per scale value.

    Returns ({fpi: pt}, unassigned pt, furniture pt). A divider whose far
    side is an edge strip holding no caption brackets the drawing area;
    paths beyond it are sheet furniture and count toward neither share nor
    denominator. Paths in `skip` - the title-bar rules and the dividers
    themselves - are not counted either: a rule is one per caption, and
    counting it would be the caption-count bias coming back in through the
    geometry (531 pt per caption on the SWR template).
    """
    W, H = page_wh
    far: list = []
    for kind, pos, _ in dividers:
        ext = W if kind == "v" else H
        j = 0 if kind == "v" else 1
        lo = min(s["box"][j] for s in sites)
        hi = max(s["box"][j + 2] for s in sites)
        if pos >= (1.0 - _EDGE_STRIP) * ext and hi < pos:
            far.append((kind, pos, +1))     # strip beyond pos is furniture
        elif pos <= _EDGE_STRIP * ext and lo > pos:
            far.append((kind, pos, -1))
    tot: dict = {}
    unassigned = 0.0
    furniture = 0.0
    for i, (L, cx, cy) in enumerate(paths):
        if i in skip:
            continue
        if any((cx if kind == "v" else cy) * sgn > pos * sgn
               for kind, pos, sgn in far):
            furniture += L
            continue
        best, bc = None, None
        for s in sites:
            if s["rule"]:
                rx0, rx1, ry = s["rule"][0], s["rule"][1], s["rule"][2]
            else:
                rx0, _, rx1, ry = s["box"]
            if ry < cy - _RULE_BELOW:
                continue           # caption sits above this: not its drawing
            cost = (ry - cy) + max(0.0, rx0 - cx, cx - rx1)
            if bc is None or cost < bc:
                best, bc = s, cost
        if best is None:
            unassigned += L
        else:
            tot[best["fpi"]] = tot.get(best["fpi"], 0.0) + L
    return tot, unassigned, furniture


def _rank(cands: list[ScaleCandidate], page: pymupdf.Page | None = None,
          words: list | None = None, linework=None
          ) -> tuple[ScaleCandidate | None, dict]:
    """The default scale for the sheet, and why.

    One distinct value: it wins, why="single". Several: each is scored by
    the linework above whose title bars it is printed (see the section
    comment) and the strict leader wins, why="governs", with the margin
    stated. When that cannot be done - no geometry, one printed line
    carrying two scales, a value whose caption cannot be located, nothing
    assigned, or two leaders too close to call - the old keyword-then-count
    order stands in and why="unranked" with the reason, so a reader knows
    the pick is UNCHECKED rather than explained.
    """
    if not cands:
        return None, {}
    order = sorted(cands, key=lambda c: (-c.near_scale_keyword, -c.count))
    values = sorted({round(c.ft_per_paper_inch, 4) for c in cands})
    if len(values) == 1:
        return order[0], {"why": "single"}

    def rep(v):   # the reading standing for a value: keyword first, then count
        return next(c for c in order if round(c.ft_per_paper_inch, 4) == v)

    def unranked(reason):
        return order[0], {"why": "unranked", "reason": reason,
                          "values": values}

    if page is None and linework is None:
        return unranked("no geometry")
    try:
        if words is None:
            from .extract import page_words
            words = page_words(page)
        if page is not None:
            paths, hlines, dividers = _page_linework(page)
            page_wh = (float(page.rect.width), float(page.rect.height))
        else:
            paths, hlines, dividers = [], [], []
            page_wh = (0.0, 0.0)
        measure = "paths"
        if linework is not None:
            # the caller's live chains replace the raw units; the title-bar
            # rules and dividers are still read off the page for placement
            paths = _chain_linework(linework)
            measure = "chains"
        sites = _caption_sites(words, hlines)
    except Exception as e:  # noqa: BLE001 - ranking must never take the reading down
        return unranked(f"geometry failed: {type(e).__name__}")
    for c in cands:
        c.sites = sum(1 for s in sites
                      if s["fpi"] == round(c.ft_per_paper_inch, 4))
    # A plan-and-profile sheet prints BOTH its scales on ONE printed line:
    #   PROFILE 1"=80' (HOR), 1"=20' (VERT)
    #     Belle Farms Upper Parcel ROAD GRADING 1 of 2.pdf engine page index 0
    #   H: 1" = 20';  V: 1" = 5'
    #     East Gallatain River sheet C101, engine page index 3 of both
    #     Plans/Plans.pdf and Addenda/Addenda/1.pdf - the same drawing twice
    # `_caption_sites` makes one site per (line, value), so those two get an
    # IDENTICAL box and rule, and `_governance`'s strict `cost < bc` then
    # hands the WHOLE line's ink to whichever value it visits first - the
    # smaller, since the sites are emitted sorted. Defect shape B,
    # first-writer-wins, inside the new ranker: the runner-up gets a literal
    # zero, so the near-tie guard cannot fire either (East Gallatain C101
    # reported `governs 100.0%` with `runner_up_pct 0.0` while taking the
    # profile's VERTICAL exaggeration as the sheet scale - 4x wrong on every
    # length, 16x on every area, and `agrees` null because the sheet draws
    # no bar).
    #
    # There is no honest split. The compound line's drawing is a PROFILE: a
    # graph whose X axis is at one scale and whose Y axis is at another, so
    # its ink is governed by both at once and by neither alone. Halving it,
    # or reading the (HOR)/(VERT) markers to pick a side, would turn an
    # unknown into a guess and still report `governs`. So the whole page is
    # unrankable: the old keyword-then-count order stands in and is flagged
    # UNCHECKED. That is a lost ranking, never a wrong number.
    #
    # Whole page, not just the compound site: once a line's ink has gone
    # somewhere arbitrary, every share on the sheet is fiction even when the
    # winner happens to survive. Belle Farms 2 of 2 engine page index 0 is
    # exactly that - it still reads 60.0, but on a reported 71.4/28.6 whose
    # 28.6 belongs to 20' and 80' jointly. Measured before this guard:
    # 1 of 2 p0 flipped 60.0 -> 20.0 (3x wrong, no symptom); 2 of 2 p0 held
    # by luck. Verified against the drawn geometry on 1 of 2 p0: the plan's
    # own unlabelled bar spans 143.96 pt for its 0-120' ticks = 60.02 ft/in,
    # while the profile's axes measure 1890.11 pt / 2100 ft = 79.995 (HOR)
    # and 540.12 pt / 150 ft = 19.996 (VERT).
    #
    # Tested before `missing`: an unattributable line is the stronger
    # statement - the attribution itself is unsafe, not merely incomplete.
    if any(s["compound"] for s in sites):
        return unranked("compound caption")
    missing = [v for v in values if not any(s["fpi"] == v for s in sites)]
    if missing:
        return unranked(f"no caption located for {missing}")
    skip = set()
    if measure == "paths":
        skip = {s["rule"][3] for s in sites if s["rule"]}
        skip |= {d[2] for d in dividers}
    tot, unassigned, furniture = _governance(sites, paths, dividers, skip,
                                             page_wh)
    assigned = sum(tot.values())
    if assigned <= 0.0:
        return unranked("no linework beneath any caption")
    for c in cands:
        v = round(c.ft_per_paper_inch, 4)
        c.governs_pt = tot.get(v, 0.0)
        c.governs_pct = 100.0 * c.governs_pt / assigned
    ranked = sorted(values, key=lambda v: -tot.get(v, 0.0))
    top, second = tot.get(ranked[0], 0.0), tot.get(ranked[1], 0.0)
    denom = assigned + unassigned
    info = {
        "values": values,
        "measure": measure,
        "governs_pct": round(100.0 * top / assigned, 1),
        "runner_up": ranked[1],
        "runner_up_pct": round(100.0 * second / assigned, 1),
        "margin": None if second <= 0.0 else round(top / second, 2),
        "unassigned_pct":
            0.0 if denom <= 0.0 else round(100.0 * unassigned / denom, 1),
        "furniture_pct": 0.0 if furniture <= 0.0 else round(
            100.0 * furniture / (denom + furniture), 1),
        "sites": len(sites),
        "rules": sum(1 for s in sites if s["rule"]),
    }
    if top - second <= _TIE_FRAC * assigned:
        info.update(why="unranked", reason="tie")
        return order[0], info
    info["why"] = "governs"
    return rep(ranked[0]), info


def _choose(cands: list[ScaleCandidate]) -> ScaleCandidate | None:
    """The geometry-free pick: keyword-adjacent first, then most repeated.
    Kept for callers with no page in hand; detect_scale ranks through
    _rank, which falls back to exactly this order when it cannot rank."""
    return _rank(cands)[0]


_TICK = re.compile(r"^(\d{1,4})\s*[\'’]?$")


def _zero_anchored_span(row: list) -> tuple | None:
    """(zero tick, far tick) for a label row sorted by x, or None.

    From each "0" label (leftmost first) walk right, then left, keeping
    labels while their values strictly increase: "10 | 0 | 5 10 20 40"
    yields 0..40, the pre-zero 10 is never visited. The walk also stops at
    a second bar's zero ("0 50 100  0 20 40" -> 0..100).
    """
    zeros = [i for i, (v, _x) in enumerate(row) if v == 0]
    for zi in zeros:
        for side in (row[zi + 1:], row[:zi][::-1]):
            last, best = 0.0, None
            for v, x in side:
                if v <= last:
                    break
                last, best = v, (v, x)
            if best is not None and abs(best[1] - row[zi][1]) > 4:
                return row[zi], best
    return None


def graphic_scale_bar(words: list) -> ScaleCandidate | None:
    """Measure a GRAPHIC SCALE bar - the drawn ruler with tick labels.

    Some sheets state no ratio anywhere; they print a bar labelled 0 / 50' /
    100' and expect you to measure it. That leaves quantities stuck in points
    with no way to price them, so read it directly: find the numeric tick
    labels sitting on one horizontal line near the words GRAPHIC SCALE and
    divide feet by the paper distance between the first and last.

    Label boxes are used at their CENTRE, since a tick label is centred on
    the tick it marks.

    Civil bars are often laid out "10 | 0 | 5 10 20 40": one unit of the
    scale is drawn to the LEFT of zero as a finer subdivision. The bar's
    span is zero to the largest label on one side of it; the pre-zero
    label must not widen it (10..40 over the full width would read 6 ft/in
    on a 10 ft/in bar). So when a "0" tick is on the row, anchor there and
    walk outward while the labels keep increasing. Without a zero tick the
    span is still leftmost-to-rightmost label.
    """
    ws = [w for w in words if str(w[4]).strip()]
    heads = [w for w in ws if str(w[4]).strip().upper().startswith("GRAPHIC")]
    for h in heads:
        hy = (h[1] + h[3]) / 2
        hx = (h[0] + h[2]) / 2
        near = [w for w in ws
                if abs(((w[1] + w[3]) / 2) - hy) < 90
                and abs(((w[0] + w[2]) / 2) - hx) < 320]
        ticks = []
        for w in near:
            m = _TICK.match(str(w[4]).strip())
            if m:
                ticks.append((float(m.group(1)),
                              (w[0] + w[2]) / 2, (w[1] + w[3]) / 2))
        if len(ticks) < 3:
            continue
        # The ticks of one bar share a row. Cluster on the vertical gap
        # between neighbours rather than fixed buckets: a "0" glyph box
        # centres ~0.7pt below its "10"/"40" neighbours, and round(cy / 9)
        # splits them whenever that straddles a bucket edge (Barn p4/p11).
        ticks.sort(key=lambda t: t[2])
        rows: list = []
        for v, cx, cy in ticks:
            if rows and cy - rows[-1][-1][2] < 4.5:
                rows[-1].append((v, cx, cy))
            else:
                rows.append([(v, cx, cy)])
        for row in sorted(rows, key=len, reverse=True):
            row = [(v, cx) for v, cx, _cy in row]
            if len(row) < 3:
                continue
            row.sort(key=lambda t: t[1])
            span = _zero_anchored_span(row) or (row[0], row[-1])
            (v0, x0), (v1, x1) = span
            dft, dpt = abs(v1 - v0), abs(x1 - x0)
            if dft <= 0 or dpt <= 4:
                continue
            ft_per_inch = 72.0 * dft / dpt
            if not (1.0 <= ft_per_inch <= 600.0):
                continue
            # Engineering scales are round numbers; measuring label centres
            # lands a hair off (50.06). Snap only when the reading is already
            # within 2.5% of a standard, so a genuinely odd bar is reported
            # as measured rather than forced onto a value it is not.
            for std in (10, 20, 30, 40, 50, 60, 80, 100, 200):
                if abs(ft_per_inch - std) <= 0.025 * std:
                    ft_per_inch = float(std)
                    break
            return ScaleCandidate(
                text=f'graphic bar {v0:g}-{v1:g} ft over {dpt:.1f}pt '
                     f'(1" = {ft_per_inch:.0f}\')',
                ft_per_paper_inch=ft_per_inch,
                near_scale_keyword=True)
    return None


# How far apart two words can sit and still read as one line. The
# row-join used to weld text from opposite ends of a 42-inch sheet into one
# "line" - which is how both keyword misreads were manufactured. On Barn
# Civil p1 the bar caption "GRAPHIC SCALE" (x=810..897pt) and an unrelated
# 5'-2" dimension callout (x=1341pt) shared a row and joined as
# `SCALE 5'-2"`. This cap now decides row MEMBERSHIP in _row_text rather
# than marking a gap after the fact, so a hole this wide starts another row
# instead of being papered over with a "|"; the measurements behind the
# number are unchanged.
#
# Keyed to glyph height, because OCR word boxes and title text are sized
# very differently from body text. Measured across the corpus:
#   widest gap INSIDE a real caption   23.5pt at 9.1pt glyphs  = 2.6x
#     (C9.0 OCR "SCALE: 1" 20'" - the hole where OCR dropped the '=')
#   narrowest FALSE weld              424.8pt at 12.6pt glyphs = 34x
#     (Barn Civil p1 "1 inch = 20 ft." -> "STBK", and 444pt for the 5'-2")
# 6x sits between the two with 2.3x headroom over the widest real caption
# gap. An earlier 2.5x missed C9.0's caption by 0.7pt and cost it its scale.
_ROW_GAP_MIN = 24.0      # pt, floor for small text
_ROW_GAP_HEIGHTS = 6.0   # x the taller of the two neighbouring words


# Whether two words sit on the same printed line is a PROXIMITY question -
# do these two boxes touch the same strip of paper - and it used to be
# answered with a fixed grid, `round(y0 / 8)`. A grid answers a different
# question. Two words 1.5pt apart land in different 8pt bins whenever a bin
# edge falls between them, and the caption is then emitted with a hole in
# it. Measured on Guide Civil engine page index 8 (printed sheet 9): '20'
# sits at y0=1245.47 (bin 156) while '1', 'inch', '=' and 'ft.' sit at
# y0=1243.93 (bin 155), so the join emitted `1 inch = ft.` and the '20'
# surfaced 40 words later. Thielen engine page indices 11 and 12 lose their
# '=' to the same edge, 1.9pt low.
#
# Replacing the grid with a vertical proximity test alone is NOT enough, and
# the corpus says so. A 42-inch sheet carries several columns, so two
# unrelated printed lines two feet apart routinely overlap in y - and any
# rule that groups on y alone puts them in one row, where the second line's
# box then defines the band and evicts the first line's own '='. Measured:
# a "keep the band all the words share" walk drops `1 inch = 10 ft.` on
# C4 GRADING PLAN p0 (welded to `PAID BY HURRICANE CITY PUBLIC WORKS`,
# 250pt to its left, whose box ends 0.0pt above the '=') and on Hurricane
# Storage p3, and C4 p0 then falls through to the graphic bar and reports
# 6.008 ft/in against the sheet's own 10 - a wrong number where there was a
# right one. Nearest-neighbour walks fail the other way: "new row when the
# y gap exceeds half a glyph height" chains rows up to 448pt tall and
# destroys the Barn Civil p1 and Guide Civil p2 captions.
#
# So the row is assembled in BOTH dimensions, which is what "the same
# printed line" actually means: sweep the words left to right, and a word
# joins the open line it overlaps most in y, provided that line's right edge
# is within the column gap above. Both tolerances come from the geometry -
# the boxes' own overlap, and the height-keyed gap that was already measured
# for the "|" guard. Nothing is bucketed and no new constant is introduced.
#
# Scored against mupdf's own line ids over the 208-page client_meet corpus
# (60,110 printed lines that are horizontal in display space), printed lines
# split across more than one row: 8pt grid 948 (1.577%), y-only band 716
# (1.191%), this 594 (0.988%); worst number of printed lines welded into one
# row: 90 / 37 / 34. Grouping cost for all 208 pages: 0.07s / 0.14s / 3.6s.


def _row_text(words: list) -> str:
    """Join word boxes into printed lines: rows top to bottom, words left to right.

    A "|" separates two rows that are NOT one line continuing into the next:
    same band, different column (the Barn Civil p1 case - the bar caption
    "GRAPHIC SCALE" at x=810..897pt and a 5'-2" dimension callout at
    x=1341pt), or any other pair that is not stacked-and-aligned. "|" is not
    a scale separator and \\s* cannot cross it, so no pattern matches over a
    break, while the 30-character keyword lookback in _scan still sees a
    caption sitting on the near side of one.

    The wrap into the line printed directly BELOW is left joined, so a
    caption whose keyword and ratio are on two lines still reads, and
    _PAT_KEYWORD_PRE still recovers OCR that reports one ratio-first
    ('1" 10' SCALE:' on the C4.x grading plans).
    """
    rows: list[list] = []
    live: list[list] = []          # [band_lo, band_hi, x_right, h_max, words]
    for w in sorted(words, key=lambda w: float(w[0])):
        if not str(w[4]).strip():
            continue
        x0, y0 = float(w[0]), float(w[1])
        x1 = max(float(w[2]), x0)
        y1 = max(float(w[3]), y0 + 1.0)   # a degenerate box still owns a band
        h = y1 - y0
        best, best_ov, still = None, 0.0, []
        for r in live:
            # Out of reach to the right: this word cannot belong to that
            # line, and neither can any later one (the sweep only moves
            # right), so drop it from the open set.
            if x0 - r[2] > max(_ROW_GAP_MIN, _ROW_GAP_HEIGHTS * max(r[3], h)):
                continue
            still.append(r)
            ov = min(r[1], y1) - max(r[0], y0)
            if ov > best_ov:
                best, best_ov = r, ov
        live = still
        if best is None:
            best = [y0, y1, x1, h, []]
            live.append(best)
            rows.append(best)
        else:
            best[0] = max(best[0], y0)     # the band the line's words share
            best[1] = min(best[1], y1)
            best[2] = max(best[2], x1)
            best[3] = max(best[3], h)
        best[4].append(w)

    def extent(r):
        ws = r[4]
        return (min(float(w[1]) for w in ws),
                max(max(float(w[3]), float(w[1]) + 1.0) for w in ws),
                min(float(w[0]) for w in ws),
                max(float(w[2]) for w in ws))

    out: list[str] = []
    prev = None
    for r in sorted(rows, key=lambda r: (min(float(w[1]) for w in r[4]),
                                         min(float(w[0]) for w in r[4]))):
        lo, hi, xa, xb = extent(r)
        if prev is not None:
            below = min(prev[1], hi) <= max(prev[0], lo)     # stacked, not beside
            under = min(prev[3], xb) > max(prev[2], xa)      # same column
            if not (below and under):
                out.append("|")
        out.extend(str(w[4]) for w in r[4])
        prev = (lo, hi, xa, xb)
    return " ".join(out)


# Two independent readings within this much of each other corroborate. The
# bar is read off tick geometry and its labels, so a percent or two of slack
# is normal; the errors this catches were 3% (a welded pipe callout) up to
# 387% (a dimension read as a caption), so the threshold is not delicate.
BAR_AGREE_PCT = 2.0


def _corroborate(res: ScaleResult, words: list) -> ScaleResult:
    """Attach the graphic bar's opinion to an already-chosen text reading.

    Purely additive - `res.best` is never replaced. If the two disagree the
    UI says so and the estimator calibrates, which is the whole point: every
    one of F92's 14 wrong pages reached the screen as a confident green chip.
    """
    if not res.best:
        return res
    try:
        bar = graphic_scale_bar(words)
    except Exception:
        return res
    if not bar or not bar.ft_per_paper_inch:
        return res
    res.bar_ft_per_paper_inch = bar.ft_per_paper_inch
    d = res.delta_pct
    res.agrees = (d is not None and d <= BAR_AGREE_PCT)
    return res


def detect_scale(page: pymupdf.Page, ocr_if_needed: bool = True,
                 corroborate: bool = True, linework=None) -> ScaleResult:
    """Read the sheet's scale. `linework` - the page's already-built chains,
    when the caller has them - replaces the raw-geometry proxy that ranks
    several printed scales by what each governs (see _rank); it never
    changes which captions are found."""
    text = page.get_text()
    cands = _scan(text)
    nts = bool(_NTS.search(text))
    if cands:
        try:
            from .extract import page_words
            words = page_words(page)
        except Exception:
            words = None
        best, pick = _rank(cands, page, words, linework)
        res = ScaleResult(best, cands, nts, "text", pick=pick)
        if corroborate and words is not None:
            res = _corroborate(res, words)
        return res

    try:
        from .extract import page_words

        words = page_words(page)
        # Same text layer, re-assembled by row. AutoCAD scale-bar blocks keep
        # the ratio's number as its own attribute text, so get_text() emits
        # "1 inch =         ft." and prints the "10" elsewhere; sorting the
        # words by (row, x) puts it back: "1 inch = 10 ft.".
        cands = _scan(_row_text(words))
        if cands:
            best, pick = _rank(cands, page, words, linework)
            res = ScaleResult(best, cands, nts, "text", pick=pick)
            return _corroborate(res, words) if corroborate else res

        # No stated ratio: try the drawn GRAPHIC SCALE bar off the text layer
        # before paying for OCR. Its tick labels ("0", "50'", "100'") are
        # real text on most CAD sheets, and OCR mangles them ("100'" -> "00").
        bar = graphic_scale_bar(words)
        if bar:
            return ScaleResult(bar, [bar], nts, "graphic-bar",
                               pick={"why": "bar"})
    except Exception:
        pass

    if ocr_if_needed:
        try:
            from .text_detect import ocr_words

            dpi = 150
            pix = page.get_pixmap(matrix=pymupdf.Matrix(dpi / 72, dpi / 72),
                                  colorspace="rgb")
            img = np.frombuffer(pix.samples, dtype=np.uint8).reshape(
                pix.height, pix.width, 3)
            words = ocr_words(img, px_to_pt=72.0 / dpi, min_conf=35)
            ocr_text = _row_text(words)
            cands = _scan(ocr_text)
            nts = nts or bool(_NTS.search(ocr_text))
            if cands:
                best, pick = _rank(cands, page, words, linework)
                return ScaleResult(best, cands, nts, "ocr", pick=pick)
            bar = graphic_scale_bar(words)
            if bar:
                return ScaleResult(bar, [bar], nts, "graphic-bar",
                                   pick={"why": "bar"})
        except Exception:
            pass

    return ScaleResult(None, [], nts, "")
