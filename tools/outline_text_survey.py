"""FABLE-002 step 1: measure how much of the corpus has text drawn as outlines.

A drafter can plot text as filled glyph PATHS instead of text runs; then
get_text() returns almost nothing, scale_detect has no caption to parse, and
the sheet cannot be priced. This survey measures how widespread that is,
BEFORE any engine change (CLAUDE.md section 6: corpus number first).

Two stages:

  Stage A (cheap, every page): text-layer size, vector path count, and a
  count of small filled multi-item paths ("glyph-like": bbox diagonal <= 15
  pt, filled, >= 2 items — drawn letters look like this, though hatching
  also does, so it separates "drawn text present" from "genuinely sparse
  page", not outline from text).

  Stage B (the product-relevant failure, on the affected set + a control
  sample): run scale_detect.detect_scale() and count pages with zero
  candidates. The affected set is plan-like pages with a thin text layer:
      paths >= PLAN_PATHS (real linework) and text < THIN_TEXT chars.
  Calibration on known pages (2026-09-01): outline-text sheets measured
  434-1,978 chars (RC Ontario p0/p7, Hurricane p2, Bryce p2, Oncrest C4.0
  p0); text-layer sheets measured 2,866-34,368 (Home 2 Suites p0, Stice
  p0). THIN_TEXT=2500 splits them.

Usage:
    python tools/outline_text_survey.py --out out/outline_survey.json
    python tools/outline_text_survey.py --out ... --stage-b        # adds detect_scale
"""

from __future__ import annotations

import argparse
import json
import math
import os
import random
import sys
import time
from pathlib import Path

import pymupdf

REPO = Path(__file__).resolve().parent.parent
_candidates = [
    Path(os.environ["TAKEOFF_WORKSPACE"]) if "TAKEOFF_WORKSPACE" in os.environ else None,
    REPO.parent,
    Path(r"C:/Users/kobys/OneDrive/Desktop/past/P/Takeoff Automation"),
]
WORKSPACE = next(p for p in _candidates
                 if p is not None and (p / "TakeoffPro AI").exists())

ROOTS = [
    WORKSPACE / "TakeoffPro AI" / "Plans",
    WORKSPACE / "TakeoffPro AI" / "Plans 2",
    WORKSPACE / "TakeoffPro AI" / "Ryno Construction",
    WORKSPACE / "client_meet",
]
EXCLUDE_NAMES = {"C4.0-SITE-GRADING-PLAN-Rev.1 (1).pdf"}

PLAN_PATHS = 5000   # at least this many vector paths = a real drawing sheet
THIN_TEXT = 2500    # fewer text chars than this on a plan sheet = thin layer
GLYPHLIKE_MIN = 500  # this many glyph-like fills = text is DRAWN, not absent
CONTROL_N = 40      # text-rich plan pages sampled for the stage-B control


def page_stats(page):
    text = " ".join(page.get_text().split())
    n_text = len(text)
    if n_text > 8000:               # unmistakably text-rich; skip the path walk
        return n_text, None, None
    paths = page.get_cdrawings()
    glyph = 0
    for p in paths:
        r = p.get("rect")
        if r is None:
            continue
        diag = math.hypot(r[2] - r[0], r[3] - r[1])
        if diag <= 15.0 and p.get("type") in ("f", "fs") and len(p.get("items", [])) >= 2:
            glyph += 1
    return n_text, len(paths), glyph


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--stage-b", action="store_true")
    args = ap.parse_args()

    t0 = time.time()
    rows = []
    for root in ROOTS:
        if not root.exists():
            print(f"MISSING ROOT: {root}", file=sys.stderr)
            continue
        for pdf in sorted(root.rglob("*.pdf")):
            if pdf.name in EXCLUDE_NAMES:
                continue
            try:
                doc = pymupdf.open(pdf)
            except Exception as e:
                rows.append({"pdf": str(pdf), "page": None,
                             "error": f"{type(e).__name__}: {e}"})
                continue
            with doc:
                for i in range(doc.page_count):
                    try:
                        n_text, n_paths, n_glyph = page_stats(doc[i])
                    except Exception as e:
                        rows.append({"pdf": str(pdf), "page": i,
                                     "error": f"{type(e).__name__}: {e}"})
                        continue
                    rows.append({"pdf": str(pdf), "page": i, "text": n_text,
                                 "paths": n_paths, "glyphlike": n_glyph})
    print(f"stage A: {len(rows)} pages in {time.time()-t0:.0f}s")

    def is_plan(r):
        return r.get("paths") is not None and r["paths"] >= PLAN_PATHS

    plan = [r for r in rows if is_plan(r)]
    affected = [r for r in plan if r["text"] < THIN_TEXT]
    drawn_text = [r for r in affected if (r["glyphlike"] or 0) >= GLYPHLIKE_MIN]
    raster = [r for r in rows if r.get("paths") == 0 and r.get("text", 1) < 20]

    summary = {
        "generated": time.strftime("%Y-%m-%d %H:%M"),
        "thresholds": {"PLAN_PATHS": PLAN_PATHS, "THIN_TEXT": THIN_TEXT,
                       "GLYPHLIKE_MIN": GLYPHLIKE_MIN},
        "pages_total": len(rows),
        "pages_plan_like": len(plan),
        "pages_plan_thin_text": len(affected),
        "pages_plan_thin_text_with_drawn_text": len(drawn_text),
        "pages_raster_no_vector": len(raster),
        "docs_affected": sorted({Path(r["pdf"]).name for r in affected}),
        "docs_raster": sorted({Path(r["pdf"]).name for r in raster}),
    }

    if args.stage_b:
        sys.path.insert(0, str(REPO))
        from takeoff_engine import scale_detect as sd

        def scale_ok(r):
            doc = pymupdf.open(r["pdf"])
            try:
                res = sd.detect_scale(doc[r["page"]])
                cands = getattr(res, "candidates", None) or []
                best = getattr(res, "best", None)
                return {"candidates": len(cands),
                        "best": getattr(best, "text", None) if best else None}
            except Exception as e:
                return {"error": f"{type(e).__name__}: {e}"}
            finally:
                doc.close()

        tb = time.time()
        for r in affected:
            r["scale"] = scale_ok(r)
        rich = [r for r in plan if r["text"] >= THIN_TEXT]
        random.seed(2026)
        control = random.sample(rich, min(CONTROL_N, len(rich)))
        for r in control:
            r["scale"] = scale_ok(r)
        aff_fail = [r for r in affected
                    if r.get("scale", {}).get("candidates") == 0]
        ctl_fail = [r for r in control
                    if r.get("scale", {}).get("candidates") == 0]
        summary["stage_b"] = {
            "affected_pages_scale_zero": len(aff_fail),
            "affected_pages_total": len(affected),
            "control_pages_scale_zero": len(ctl_fail),
            "control_pages_total": len(control),
            "control_pages": [{"pdf": Path(r["pdf"]).name, "page": r["page"],
                               "scale": r["scale"]} for r in control],
            "elapsed_s": round(time.time() - tb),
        }

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps({"summary": summary, "pages": rows}, indent=1),
                        encoding="utf-8")
    print(json.dumps(summary, indent=1)[:4000])
    print("wrote", args.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
