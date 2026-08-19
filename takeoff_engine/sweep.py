"""Broad-corpus sweep: run the whole pipeline over MANY documents and pages
and record every anomaly, so fixes come from data across the variety of
PDFs the product will actually meet - not from one test sheet.

Per page it records: page kind, timing, chain/style counts, class mix,
phantom-span flags, backtracking spikes, scale detection (found? how?),
legend reading (rows found / labels applied), unchained-ink ratio, and any
exception or timeout. Output: a findings table (JSON + markdown).

Usage: python -m takeoff_engine.sweep [--max-pages N] [--out FILE]
"""

import argparse
import json
import signal
import time
import traceback
from pathlib import Path

ROOT = Path(__file__).parent.parent
SAMPLES = (ROOT / ".." / "TakeoffPro AI").resolve()


class PageTimeout(Exception):
    pass


def _alarm(_s, _f):
    raise PageTimeout()


def audit_page(pdf: Path, page_no: int, budget_s: int = 240) -> dict:
    import numpy as np
    import pymupdf

    from .chain import build_chains, _sample_polyline
    from .classify_page import classify_page
    from .eval_layers import class_metrics, phantom_span_audit
    from .extract import extract_strokes, page_words
    from .legend_detect import read_legend
    from .scale_detect import detect_scale

    row = {"pdf": pdf.name[:44], "page": page_no + 1}
    signal.signal(signal.SIGALRM, _alarm)
    signal.alarm(budget_s)
    t0 = time.time()
    try:
        doc = pymupdf.open(pdf)
        pg = doc[page_no]
        pc = classify_page(pg)
        row["kind"] = pc.kind
        if pc.kind == "raster":
            # raster path is a separate pipeline; sweep only notes it
            row["note"] = "raster page - skipped in this sweep"
            return row
        units = extract_strokes(pg)
        words = page_words(pg)
        row["units"] = len(units)
        chains = build_chains(units, words=words)
        keep = [c for c in chains if c.klass != "annotation"]
        row["chains"] = len(keep)
        row["classes"] = {}
        for c in keep:
            row["classes"][c.klass] = row["classes"].get(c.klass, 0) + 1

        a = phantom_span_audit(chains, units)
        row["phantom"] = len(a["bad"])

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
        row["spikes"] = int(sum(spikes(c) for c in keep))

        sc = detect_scale(pg)
        row["scale"] = sc.best.text[:36] if sc.best else None
        row["scale_src"] = getattr(sc, "source", "") or None

        lg = read_legend(words, chains)
        row["legend_rows"] = len(lg["entries"])
        row["legend_applied"] = len(lg["style_labels"])

        # unchained ink: how much visible stroke never reached any chain
        vis = [u for u in units
               if not (u.color and min(u.color) > 0.92
                       and not getattr(u, "on_fill", False))]
        chain_ink = sum((c.ink or c.length) for c in chains)
        unit_ink = sum(u.length for u in vis)
        row["ink_captured"] = round(min(chain_ink / unit_ink, 1.0), 3) \
            if unit_ink else None
        m = class_metrics(chains, units)
        junk = {k: round(v["precision"], 3) for k, v in m["per_class"].items()
                if v["n"] and v["precision"] is not None and v["precision"] < 0.999}
        if junk:
            row["precision_below_100"] = junk
    except PageTimeout:
        row["error"] = f"TIMEOUT >{budget_s}s"
    except Exception as e:
        row["error"] = f"{type(e).__name__}: {e}"[:160]
        row["trace"] = traceback.format_exc().splitlines()[-2][:160]
    finally:
        signal.alarm(0)
        row["secs"] = round(time.time() - t0, 1)
    return row


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--max-pages", type=int, default=4)
    ap.add_argument("--out", default=str(ROOT / "out" / "sweep_findings"))
    args = ap.parse_args()

    pdfs = sorted((SAMPLES / "Plans").glob("*.pdf"))
    pdfs += sorted((SAMPLES / "Ryno Construction").glob("*.pdf"))[:3]
    pdfs += [p for p in SAMPLES.glob("*.pdf")]
    seen, ordered = set(), []
    for p in pdfs:
        if p.name not in seen and p.stat().st_size > 50_000:
            seen.add(p.name)
            ordered.append(p)

    import pymupdf
    rows = []
    for pdf in ordered:
        try:
            n = pymupdf.open(pdf).page_count
        except Exception as e:
            rows.append({"pdf": pdf.name[:44], "page": 0,
                         "error": f"OPEN FAILED: {e}"[:120]})
            continue
        for pno in range(min(n, args.max_pages)):
            row = audit_page(pdf, pno)
            rows.append(row)
            flag = row.get("error") or (
                f"ph={row.get('phantom')} sp={row.get('spikes')}"
                if row.get("phantom") or row.get("spikes") else "ok")
            print(f"[{len(rows):3}] {row['pdf'][:36]:38} p{row['page']} "
                  f"{row.get('kind','?'):7} {row.get('secs','')}s  {flag}",
                  flush=True)
    Path(args.out + ".json").write_text(json.dumps(rows, indent=1))
    print(f"\nwrote {args.out}.json ({len(rows)} pages)")


if __name__ == "__main__":
    main()
