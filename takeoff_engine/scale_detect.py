"""Automatic scale detection from plan sheets.

Reads scale notations like:
    SCALE: 1" = 20'        (civil)
    Scale: 1/4" - 1'-0"    (architectural; separators vary: = - :)
    1" = 50'  /  3/32" = 1'-0"

Sources, in order:
  1. the PDF text layer,
  2. OCR of the rendered page (CAD exports often explode the scale note
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

# 1/4" = 1'-0"   |   1" = 20'   |   1"= 50'   | separators = - :
_PAT = re.compile(
    r"""(?P<paper>\d+(?:/\d+)?)\s*["”″]\s*
        (?:[=:\-]\s*){1,2}          # OCR sometimes doubles the separator
        (?P<feet>\d+)\s*['’′]
        (?:\s*-\s*(?P<inches>\d+)\s*["”″])?""",
    re.X,
)
_NTS = re.compile(r"(?i)\bN\.?\s*T\.?\s*S\.?\b|NOT\s+TO\s+SCALE")

# OCR often loses the inch/foot marks completely ("SCALE: 1 = = 20").
# Units are then implied by convention (paper inches = real feet), but only
# trust that when anchored right after the SCALE keyword.
_PAT_KEYWORD = re.compile(
    r"""(?i)scale\s*[:=]?\s*
        (?P<paper>\d+(?:/\d+)?)?\s*["”″]?\s*   # OCR may eat the 1"
        (?:[=:\-]\s*){0,2}                      # ... or the separator
        (?P<feet>\d+)\s*['’′]?
        (?:\s*-\s*(?P<inches>\d+)\s*["”″]?)?""",
    re.X,
)

# OCR word order can put the ratio BEFORE the keyword ('1" 10' SCALE:' on
# the C4.x grading plans): same relaxed body, keyword trailing. Degree
# signs stand in for foot marks in OCR output, so they count as ticks.
_PAT_KEYWORD_PRE = re.compile(
    r"""(?i)(?P<paper>\d+(?:/\d+)?)\s*["”″]\s*
        (?:[=:\-]\s*){0,2}
        (?P<feet>\d+)\s*['’′°º]?\s*
        (?:-\s*(?P<inches>\d+)\s*["”″]?\s*)?
        scale\b""",
    re.X,
)


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
    source: str = ""  # "text" | "ocr"

    def to_dict(self) -> dict | None:
        if not self.best:
            return None
        return {
            **self.best.to_dict(),
            "source": self.source,
            "has_nts": self.has_nts,
            "candidates": [c.to_dict() for c in self.candidates],
        }


def _frac(s: str) -> float:
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
        # plausible drawing scales: 1/8"=1' (8) up to 1"=200'
        if not (0.5 <= fpi <= 400):
            return
        key = (round(fpi, 4), near)
        if key in found:
            found[key].count += 1
        else:
            found[key] = ScaleCandidate(m.group(0).strip(), fpi, near)

    for m in _PAT.finditer(text):
        ctx = text[max(0, m.start() - 30): m.start()]
        add(m, bool(re.search(r"(?i)scale", ctx)))
    for m in _PAT_KEYWORD.finditer(text):
        add(m, True)
    for m in _PAT_KEYWORD_PRE.finditer(text):
        add(m, True)
    return list(found.values())


def _choose(cands: list[ScaleCandidate]) -> ScaleCandidate | None:
    if not cands:
        return None
    # keyword-adjacent first, then most repeated, then largest paper scale
    # (the main plan is usually the coarsest-precision, most repeated note)
    return sorted(cands, key=lambda c: (-c.near_scale_keyword, -c.count))[0]


_TICK = re.compile(r"^(\d{1,4})\s*[\'’]?$")


def graphic_scale_bar(words: list) -> ScaleCandidate | None:
    """Measure a GRAPHIC SCALE bar - the drawn ruler with tick labels.

    Some sheets state no ratio anywhere; they print a bar labelled 0 / 50' /
    100' and expect you to measure it. That leaves quantities stuck in points
    with no way to price them, so read it directly: find the numeric tick
    labels sitting on one horizontal line near the words GRAPHIC SCALE and
    divide feet by the paper distance between the first and last.

    Label boxes are used at their CENTRE, since a tick label is centred on
    the tick it marks.
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
        # the ticks of one bar share a row
        rows: dict = {}
        for v, cx, cy in ticks:
            rows.setdefault(round(cy / 9), []).append((v, cx))
        for _, row in sorted(rows.items(), key=lambda kv: -len(kv[1])):
            if len(row) < 3:
                continue
            row.sort(key=lambda t: t[1])
            (v0, x0), (v1, x1) = row[0], row[-1]
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


def detect_scale(page: pymupdf.Page, ocr_if_needed: bool = True) -> ScaleResult:
    text = page.get_text()
    cands = _scan(text)
    nts = bool(_NTS.search(text))
    if cands:
        return ScaleResult(_choose(cands), cands, nts, "text")

    # No stated ratio: try the drawn GRAPHIC SCALE bar off the text layer
    # before paying for OCR. Its tick labels ("0", "50'", "100'") are real
    # text on most CAD sheets, and OCR mangles them ("100'" -> "00").
    try:
        from .extract import page_words

        bar = graphic_scale_bar(page_words(page))
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
            # rebuild rough lines: sort by (row bucket, x) and join
            words.sort(key=lambda w: (round(w[1] / 8), w[0]))
            ocr_text = " ".join(w[4] for w in words)
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
