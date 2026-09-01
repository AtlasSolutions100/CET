"""Milestone evidence pack: run detection across a sheet list, score with
the layer-based metrics, and emit overlays + a markdown report the client
can accept milestones against.

Usage: python -m takeoff_engine.milestone_report
"""

from pathlib import Path

import numpy as np
import pymupdf

from .chain import build_chains
from .eval_layers import class_metrics
from .extract import extract_strokes, page_words
from .overlay import render_overlay
from .scale_detect import detect_scale
from .text_detect import ocr_words

SHEETS = [
    ("../TakeoffPro AI/Plans/C4.0-SITE-GRADING-PLAN-Rev.1.pdf", 0),
    ("../TakeoffPro AI/Plans/C8.0-STORM-LAYOUT-Rev.1.pdf", 0),
    ("../TakeoffPro AI/Plans/C3.0-Site-Plan-Rev.1.pdf", 0),
    ("../TakeoffPro AI/Plans/C9.0-ROAD-LAYOUT-Rev.1.pdf", 0),
    ("../TakeoffPro AI/Plans/Belle Farms Structural Plans.pdf", 0),
]

DASHED = {"dash1", "dash2", "dash3", "dash-text"}


def words_for(page, units):
    words = list(page_words(page))
    if len(page.get_text()) < 1500 and not any(u.layer for u in units[:300]):
        pix = page.get_pixmap(matrix=pymupdf.Matrix(150 / 72, 150 / 72),
                              colorspace="rgb")
        img = np.frombuffer(pix.samples, dtype=np.uint8).reshape(
            pix.height, pix.width, 3)
        words += ocr_words(img, px_to_pt=72.0 / 150)
    return words


def main():
    out = Path("out/milestone")
    out.mkdir(parents=True, exist_ok=True)
    lines = ["# Dashed-line detection - milestone evidence",
             "",
             "Per sheet: dashed-class precision (fraction of detected dash ink NOT",
             "on annotation layers), and per truth-layer classification accuracy +",
             "coverage (fraction of the layer's ink lying on a detected line).",
             ""]
    for f, pno in SHEETS:
        doc = pymupdf.open(f)
        page = doc[pno]
        units = extract_strokes(page)
        chains = build_chains(units, words=words_for(page, units))
        sc = detect_scale(page).to_dict()
        stem = Path(f).stem[:34].replace(" ", "_")
        render_overlay(page, chains, dpi=140, classes=DASHED).save(
            out / f"{stem}_dashed.png")
        render_overlay(page, chains, dpi=140, mode="style").save(
            out / f"{stem}_detected.png")

        m = class_metrics(chains, units)
        n_dash = sum(m["per_class"][k]["n"] for k in DASHED if k in m["per_class"])
        ink = sum(m["per_class"][k]["ink"] for k in DASHED if k in m["per_class"])
        prec = [m["per_class"][k]["precision"] for k in DASHED
                if k in m["per_class"] and m["per_class"][k]["precision"] is not None
                and m["per_class"][k]["ink"] > 0]
        w_prec = (sum(m["per_class"][k]["precision"] * m["per_class"][k]["ink"]
                      for k in DASHED if k in m["per_class"]
                      and m["per_class"][k]["precision"] is not None) / ink
                  ) if ink else None

        lines.append(f"## {Path(f).name} (page {pno + 1})")
        lines.append("")
        # An ABSTAINED reading (best is None, candidates survived) serialises
        # as a dict with `abstained` and a None `text` - truthy, but not a
        # scale. Say what it is instead of printing "None [ocr]": these are
        # readings a person has to choose between, and this report must not
        # imply the engine settled it.
        if sc and sc.get("abstained"):
            _vals = ", ".join(
                f"{c['text']} = {c['ft_per_paper_inch']:g} ft/in"
                for c in sc.get("candidates") or [])
            _sc_line = (f"NOT SET - {len(sc.get('candidates') or [])} "
                        f"unpromoted reading(s) [{sc['source']}]: {_vals}")
        elif sc:
            _sc_line = sc['text'] + ' [' + sc['source'] + ']'
        else:
            _sc_line = 'not found (manual 2-click fallback)'
        lines.append(f"- scale: {_sc_line}")
        lines.append(f"- dashed lines detected: {n_dash} chains, {ink:,.0f} pt ink")
        if w_prec is not None:
            lines.append(f"- dashed precision (ink-weighted): {w_prec:.1%}")
        if m["truth_layers"]:
            lines.append("")
            lines.append("| truth layer | expected | class accuracy | coverage |")
            lines.append("|---|---|---|---|")
            for lay, s in m["truth_layers"].items():
                cov = f"{s['coverage']:.1%}" if s.get("coverage") is not None else "-"
                lines.append(f"| {lay.split('|')[-1]} | {s['want']} | "
                             f"{s['class_acc']:.1%} | {cov} |")
        lines.append(f"")
        lines.append(f"![dashed overlay]({stem}_dashed.png)")
        lines.append("")
        lines.append(f"Faithful view (source colors, detected linework only):")
        lines.append(f"![detected]({stem}_detected.png)")
        lines.append("")
        print(f"{Path(f).name}: {n_dash} dashed chains, "
              f"precision {w_prec:.1%}" if w_prec is not None else f"{Path(f).name}: no dashed")
    (out / "REPORT.md").write_text("\n".join(lines))
    print(f"\nreport: {out}/REPORT.md")


if __name__ == "__main__":
    main()
