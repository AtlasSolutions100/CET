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
_NUM = r"""(?:1[-\s]1/2|\d+/\d+|\d+)"""

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

    def to_dict(self) -> dict:
        return {
            "text": self.text,
            "ft_per_paper_inch": self.ft_per_paper_inch,
            "near_scale_keyword": self.near_scale_keyword,
            "count": self.count,
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


def _choose(cands: list[ScaleCandidate]) -> ScaleCandidate | None:
    if not cands:
        return None
    # keyword-adjacent first, then most repeated, then largest paper scale
    # (the main plan is usually the coarsest-precision, most repeated note)
    return sorted(cands, key=lambda c: (-c.near_scale_keyword, -c.count))[0]


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


# The row-join sorts every word on the sheet into 8pt horizontal bands, so
# with no gap test it welds text from opposite ends of a 42-inch sheet into
# one "line" - which is how both keyword misreads were manufactured. On Barn
# Civil p1 the bar caption "GRAPHIC SCALE" (x=810..897pt) and an unrelated
# 5'-2" dimension callout (x=1341pt) shared a band and joined as
# `SCALE 5'-2"`.
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


def _row_text(words: list) -> str:
    """Join word boxes into rough lines: sort by (row bucket, x).

    A "|" marks a column gap INSIDE a band - two words on the same row
    bucket that are nowhere near each other. "|" is not a scale separator
    and \\s* cannot cross it, so no pattern matches over a break, while the
    30-character keyword lookback in _scan still sees a caption sitting on
    the near side of one.

    The wrap from the end of one band to the start of the next is left
    joined on purpose. Sorting by (bucket, x) scrambles a caption whose
    words straddle a bucket edge - Thielen p57 OCR puts "SCALE:" 2.4pt
    below its own "1/8"" and the two land in buckets 200 and 199, so the
    join emits `1/8" 1'-0" SCALE: =`. Recovering that is exactly what
    _PAT_KEYWORD_PRE is for, and breaking on the wrap would take it away.
    """
    words = sorted(words, key=lambda w: (round(w[1] / 8), w[0]))
    out: list[str] = []
    prev = None  # (row bucket, x1, height)
    for w in words:
        row = round(float(w[1]) / 8)
        h = max(float(w[3]) - float(w[1]), 1.0)
        if prev is not None and prev[0] == row:
            cap = max(_ROW_GAP_MIN, _ROW_GAP_HEIGHTS * max(prev[2], h))
            if float(w[0]) - prev[1] > cap:
                out.append("|")
        out.append(str(w[4]))
        prev = (row, float(w[2]), h)
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
                 corroborate: bool = True) -> ScaleResult:
    text = page.get_text()
    cands = _scan(text)
    nts = bool(_NTS.search(text))
    if cands:
        res = ScaleResult(_choose(cands), cands, nts, "text")
        if corroborate:
            try:
                from .extract import page_words
                res = _corroborate(res, page_words(page))
            except Exception:
                pass
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
            res = ScaleResult(_choose(cands), cands, nts, "text")
            return _corroborate(res, words) if corroborate else res

        # No stated ratio: try the drawn GRAPHIC SCALE bar off the text layer
        # before paying for OCR. Its tick labels ("0", "50'", "100'") are
        # real text on most CAD sheets, and OCR mangles them ("100'" -> "00").
        bar = graphic_scale_bar(words)
        if bar:
            return ScaleResult(bar, [bar], nts, "graphic-bar")
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
                return ScaleResult(_choose(cands), cands, nts, "ocr")
            bar = graphic_scale_bar(words)
            if bar:
                return ScaleResult(bar, [bar], nts, "graphic-bar")
        except Exception:
            pass

    return ScaleResult(None, [], nts, "")
