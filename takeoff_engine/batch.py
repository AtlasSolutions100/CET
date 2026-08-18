"""Batch runner: classify + detect across many PDFs/pages, write a summary
CSV alongside per-page JSON/overlays. This is the eval-corpus workhorse.

Usage:
  python -m takeoff_engine.batch <pdf-or-dir> [more...] [--out DIR]
      [--max-pages N] [--no-overlays]
"""

import argparse
import csv
import json
import time
from collections import Counter
from pathlib import Path

import pymupdf

from .chain import build_chains
from .classify_page import classify_page
from .extract import extract_strokes
from .overlay import render_overlay


def iter_pdfs(paths):
    for p in paths:
        p = Path(p)
        if p.is_dir():
            yield from sorted(p.rglob("*.pdf"))
        elif p.suffix.lower() == ".pdf":
            yield p


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("paths", nargs="+")
    ap.add_argument("--out", default="out/batch")
    ap.add_argument("--max-pages", type=int, default=10)
    ap.add_argument("--no-overlays", action="store_true")
    ap.add_argument("--dpi", type=int, default=150)
    args = ap.parse_args()

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    rows = []

    for pdf in iter_pdfs(args.paths):
        try:
            doc = pymupdf.open(pdf)
        except Exception as e:
            print(f"SKIP {pdf}: {e}")
            continue
        stem = pdf.stem[:40].replace(" ", "_")
        for pno in range(min(doc.page_count, args.max_pages)):
            page = doc[pno]
            t0 = time.time()
            pc = classify_page(page)
            row = {
                "file": pdf.name, "page": pno, "kind": pc.kind,
                "paths": pc.path_count, "img_cov": pc.image_coverage,
            }
            if True:
                try:
                    if pc.kind == "raster":
                        from .raster import extract_raster_units

                        units = extract_raster_units(page)
                        chains = build_chains(units)
                    else:
                        units = extract_strokes(page)
                        if pc.kind == "hybrid":
                            from .raster import extract_hybrid_image_units

                            units.extend(extract_hybrid_image_units(page))
                        chains = build_chains(units, words=page.get_text("words"))
                    counts = Counter(c.klass for c in chains)
                    row.update({
                        "units": len(units), "chains": len(chains),
                        "solid": counts.get("solid", 0),
                        "dash1": counts.get("dash1", 0),
                        "dash2": counts.get("dash2", 0),
                        "dash3": counts.get("dash3", 0),
                        "dash_text": counts.get("dash-text", 0),
                        "styles": len({c.style_id for c in chains}),
                    })
                    base = f"{stem}_p{pno}"
                    (out_dir / f"{base}.json").write_text(json.dumps({
                        "page": pc.to_dict(),
                        "chains": [c.to_dict() for c in chains],
                    }))
                    if not args.no_overlays:
                        render_overlay(page, chains, dpi=args.dpi).save(
                            out_dir / f"{base}_all.png")
                        render_overlay(
                            page, chains, dpi=args.dpi,
                            classes={"dash1", "dash2", "dash3", "dash-text"},
                        ).save(out_dir / f"{base}_dashed.png")
                except Exception as e:
                    row["error"] = str(e)[:120]
            row["elapsed_s"] = round(time.time() - t0, 1)
            rows.append(row)
            print(row)
        doc.close()

    fields = ["file", "page", "kind", "paths", "img_cov", "units", "chains",
              "solid", "dash1", "dash2", "dash3", "dash_text", "styles",
              "elapsed_s", "error"]
    with open(out_dir / "summary.csv", "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        w.writerows(rows)
    print(f"\n{len(rows)} pages -> {out_dir}/summary.csv")


if __name__ == "__main__":
    main()
