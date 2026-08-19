"""Corpus regression harness: the standing quality gate, made cheap.

Every engine change reruns the same five-sheet gate. Two costs dominate:
stroke extraction (deterministic per file+page+mtime, so cache it) and the
sheets themselves (independent, so run them in parallel). Detection code
changes constantly, extraction rarely - the cache keys on the PDF only.

Usage:  python -m takeoff_engine.regress            # gate corpus
        python -m takeoff_engine.regress --no-cache # force fresh extract
"""

import argparse
import hashlib
import os
import pickle
import time
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

CACHE = Path(__file__).parent.parent / "out" / "cache"
CORPUS = [
    ("../TakeoffPro AI/Plans/C4.0-SITE-GRADING-PLAN-Rev.1.pdf", 0),
    ("../TakeoffPro AI/Plans/C8.0-STORM-LAYOUT-Rev.1.pdf", 0),
    ("../TakeoffPro AI/Plans/C3.0-Site-Plan-Rev.1.pdf", 0),
    ("../TakeoffPro AI/Plans/C9.0-ROAD-LAYOUT-Rev.1.pdf", 0),
    ("../TakeoffPro AI/Plans/Belle Farms Structural Plans.pdf", 0),
    ("../TakeoffPro AI/Oncor Cloudcrest Substation Civils - 20251212.pdf_safe.pdf", 2),
    ("../TakeoffPro AI/Oncor Cloudcrest Substation Civils - 20251212.pdf_safe.pdf", 3),
]


def cached_extract(pdf: str, page_no: int, use_cache: bool = True):
    """Stroke units + words for a page, cached on (path, page, mtime)."""
    import pymupdf

    from .extract import extract_strokes, page_words

    pdf = str((Path(__file__).parent.parent / pdf).resolve()) \
        if not os.path.isabs(pdf) else pdf
    # key on the EXTRACTOR's mtime too: cached units must not outlive the
    # code that produced them (the cache would otherwise serve pre-fix
    # geometry and the gate would silently test stale extraction)
    ex_src = Path(__file__).parent / "extract.py"
    key = hashlib.sha1(
        f"{pdf}|{page_no}|{os.path.getmtime(pdf)}|{os.path.getmtime(ex_src)}"
        .encode()).hexdigest()
    f = CACHE / f"{key}.pkl"
    if use_cache and f.exists():
        with open(f, "rb") as fh:
            return pickle.load(fh)
    doc = pymupdf.open(pdf)
    page = doc[page_no]
    units = extract_strokes(page)
    words = page_words(page)
    doc.close()
    if use_cache:
        CACHE.mkdir(parents=True, exist_ok=True)
        with open(f, "wb") as fh:
            pickle.dump((units, words), fh, protocol=5)
    return units, words


def _run_sheet(args):
    pdf, page_no, use_cache = args
    import numpy as np

    from .chain import build_chains, _sample_polyline
    from .eval_layers import class_metrics, phantom_span_audit

    t0 = time.time()
    units, words = cached_extract(pdf, page_no, use_cache)
    t1 = time.time()
    chains = build_chains(units, words=words)
    t2 = time.time()
    m = class_metrics(chains, units)
    a = phantom_span_audit(chains, units)

    def spikes(c):
        p = np.asarray(c.pts)
        n = 0
        for i in range(1, len(p) - 1):
            v1, v2 = p[i] - p[i - 1], p[i + 1] - p[i]
            la, lb = np.hypot(*v1), np.hypot(*v2)
            if la > 1 and lb > 1 and (v1 / la) @ (v2 / lb) < -0.8 \
                    and min(la, lb) > 15:
                n += 1
        return n

    return {
        "sheet": f"{Path(pdf).name[:26]} p{page_no}",
        "extract_s": round(t1 - t0, 1),
        "build_s": round(t2 - t1, 1),
        "chains": len(chains),
        "phantom": len(a["bad"]),
        "spikes": sum(spikes(c) for c in chains if c.klass != "annotation"),
        "precision": {k: round(v["precision"], 4)
                      for k, v in m["per_class"].items()
                      if v["n"] and v["precision"] is not None},
        "truth": {lay.split("|")[-1]: round(v["class_acc"], 4)
                  for lay, v in m["truth_layers"].items()},
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-cache", action="store_true")
    ap.add_argument("--serial", action="store_true")
    args = ap.parse_args()
    t0 = time.time()
    jobs = [(p, n, not args.no_cache) for p, n in CORPUS]
    if args.serial:
        results = [_run_sheet(j) for j in jobs]
    else:
        with ProcessPoolExecutor(max_workers=min(len(jobs), os.cpu_count() or 4)) as ex:
            results = list(ex.map(_run_sheet, jobs))
    accs = []
    for r in results:
        pr = " ".join(f"{k}={v:.1%}" for k, v in r["precision"].items())
        print(f"{r['sheet']:32} extract={r['extract_s']:5.1f}s build={r['build_s']:5.1f}s "
              f"chains={r['chains']:4} phantom={r['phantom']} spikes={r['spikes']:2}  {pr}")
        accs += list(r["truth"].values())
    if accs:
        print(f"\nmean truth class accuracy: {sum(accs)/len(accs):.1%} "
              f"| total phantom: {sum(r['phantom'] for r in results)} "
              f"| wall time: {time.time()-t0:.0f}s")


if __name__ == "__main__":
    main()
