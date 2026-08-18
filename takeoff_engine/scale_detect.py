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
    return list(found.values())


def _choose(cands: list[ScaleCandidate]) -> ScaleCandidate | None:
    if not cands:
        return None
    # keyword-adjacent first, then most repeated, then largest paper scale
    # (the main plan is usually the coarsest-precision, most repeated note)
    return sorted(cands, key=lambda c: (-c.near_scale_keyword, -c.count))[0]


def detect_scale(page: pymupdf.Page, ocr_if_needed: bool = True) -> ScaleResult:
    text = page.get_text()
    cands = _scan(text)
    nts = bool(_NTS.search(text))
    if cands:
        return ScaleResult(_choose(cands), cands, nts, "text")

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
        except Exception:
            pass

    return ScaleResult(None, [], nts, "")
