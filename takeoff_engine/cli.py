"""CLI: run detection on a PDF page and emit JSON + overlay PNG.

Usage:
  python -m takeoff_engine.cli <pdf> [--page N] [--out DIR] [--dpi 150]
"""

import argparse
import json
import time
from collections import Counter
from pathlib import Path

import pymupdf

from .chain import build_chains
from .classify_page import classify_page
from .extract import extract_strokes
from .overlay import render_overlay


def run_page(doc: pymupdf.Document, page_no: int, out_dir: Path, dpi: int, stem: str):
    page = doc[page_no]
    t0 = time.time()
    pc = classify_page(page)
    if pc.kind == "raster":
        from .raster import extract_raster_units

        words = []
        units = extract_raster_units(page, words_out=words)
    else:
        units = extract_strokes(page)
        words = page.get_text("words")
        if pc.kind == "hybrid":
            from .raster import extract_hybrid_image_units

            units.extend(extract_hybrid_image_units(page))
    chains = build_chains(units, words=words)
    dt = time.time() - t0

    counts = Counter(c.klass for c in chains)
    print(
        f"page {page_no}: {pc.kind} paths={pc.path_count} units={len(units)} "
        f"chains={len(chains)} {dict(counts)} in {dt:.1f}s"
    )

    out_dir.mkdir(parents=True, exist_ok=True)
    base = f"{stem}_p{page_no}"

    result = {
        "page": pc.to_dict(),
        "elapsed_s": round(dt, 2),
        "class_counts": dict(counts),
        "chains": [c.to_dict() for c in chains],
    }
    (out_dir / f"{base}.json").write_text(json.dumps(result))

    # full overlay + dashed-only overlay (the milestone deliverable view)
    render_overlay(page, chains, dpi=dpi).save(out_dir / f"{base}_all.png")
    render_overlay(
        page, chains, dpi=dpi,
        classes={"dash1", "dash2", "dash3", "dash-text"},
    ).save(out_dir / f"{base}_dashed.png")
    return result


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pdf")
    ap.add_argument("--page", type=int, default=0)
    ap.add_argument("--out", default="out")
    ap.add_argument("--dpi", type=int, default=150)
    args = ap.parse_args()

    doc = pymupdf.open(args.pdf)
    stem = Path(args.pdf).stem[:40].replace(" ", "_")
    run_page(doc, args.page, Path(args.out), args.dpi, stem)


if __name__ == "__main__":
    main()
