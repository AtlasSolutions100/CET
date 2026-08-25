"""Corpus regression harness: the standing quality gate, made cheap.

Every engine change reruns the same five-sheet gate. Two costs dominate:
stroke extraction (deterministic per file+page+mtime, so cache it) and the
sheets themselves (independent, so run them in parallel). Detection code
changes constantly, extraction rarely - the cache keys on the PDF only.

Usage:  python -m takeoff_engine.regress            # fast gate (10 sheets)
        python -m takeoff_engine.regress --full     # + wide layer sweep
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

# Beaumont Excavating's own sheets - a live client, and the only layered
# ground truth in the corpus that is not the one Loves Lane civil project.
# Three of the seven sheets above (Belle Farms p0, Oncor p2, Oncor p3) carry
# NO CAD layers at all, so they can never score a layer metric; these can.
# Picked for layer breadth per second: Guide Civil p3 = printed C3.0, 55
# linework layers; Barn Landscaping p5 = printed L200 layout, 115 layers;
# Barn Landscaping p6 = printed L100 tree plan, contour-heavy and only ~3 s.
CORPUS_BEAUMONT = [
    ("../client_meet/beaumont/SWR_Guide_Residence_-_Civil_5.8.26.pdf", 3),
    ("../client_meet/beaumont/SWR_Barn_Residence_-_Landscaping_4.7.26.pdf", 5),
    ("../client_meet/beaumont/SWR_Barn_Residence_-_Landscaping_4.7.26.pdf", 6),
]

# --full only. Same measurement, more sheets and more layer families, at
# roughly triple the wall time - run it before a release or after a chain.py
# constant moves, not on every edit.
CORPUS_FULL_EXTRA = [
    ("../client_meet/beaumont/SWR_Guide_Residence_-_Civil_5.8.26.pdf", 2),
    ("../client_meet/beaumont/SWR_Barn_Residence_-_Landscaping_4.7.26.pdf", 11),
    ("../client_meet/beaumont/SWR_Barn_Residence_-_Civil_4.7.26.pdf", 6),
    ("../client_meet/beaumont/SWR_Barn_Residence_-_Civil_4.7.26.pdf", 13),
    ("../client_meet/beaumont/SWR_Barn_Residence_-_Civil_4.7.26.pdf", 14),
    ("../client_meet/beaumont/SWR_Barn_Residence_-_Structural_4.7.26.pdf", 3),
    ("../client_meet/beaumont/260603 Thielen Biggerstaff Residence.pdf", 10),
]


def corpus_root() -> Path:
    """Directory that holds the plan corpus ('TakeoffPro AI').

    CORPUS entries are written relative to the checkout, which is right for
    a normal clone and wrong inside a git worktree (.claude/worktrees/<name>):
    there the same '..' lands on .claude/worktrees/TakeoffPro AI and every
    sheet dies with a FileNotFoundError buried in a ProcessPool traceback,
    which reads like a corpus problem rather than a path problem. So the gate
    could not be run from a worktree at all - exactly where it is most wanted.
    Walking up for the corpus directory is the same fix bench.corpus_root()
    already uses, and it is a no-op in a normal clone.
    """
    base = Path(__file__).resolve().parent.parent
    for up in [base, *base.parents]:
        if (up / "TakeoffPro AI").is_dir():
            return up
    raise SystemExit(
        f"regress: could not locate the 'TakeoffPro AI' corpus root above\n"
        f"  {base}\n"
        f"The gate needs the plan corpus checked out beside the repo.")


def corpus_path(rel: str) -> str:
    """Absolute path for one CORPUS entry, resolved against corpus_root()."""
    if os.path.isabs(rel):
        return rel
    p = (corpus_root() / rel.replace("../", "", 1)).resolve()
    if not p.exists():
        raise SystemExit(f"regress: corpus sheet not found at\n  {p}\n"
                         f"  (CORPUS entry {rel!r})")
    return str(p)


def cached_extract(pdf: str, page_no: int, use_cache: bool = True):
    """Stroke units + words for a page, cached on (path, page, mtime)."""
    import pymupdf

    from .extract import extract_strokes, page_words

    pdf = corpus_path(pdf)
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
    from .eval_layers import (class_metrics, derived_layer_metrics,
                              phantom_span_audit)

    t0 = time.time()
    units, words = cached_extract(pdf, page_no, use_cache)
    t1 = time.time()
    chains = build_chains(units, words=words)
    t2 = time.time()
    m = class_metrics(chains, units)
    d = derived_layer_metrics(chains, units)
    a = phantom_span_audit(chains, units)

    # reversal points the SOURCE strokes already contain (zigzag
    # shading bands, conveyance arrows): a chain tracing one faithfully
    # is not a bad weld, so those vertices are exempt
    _src_rev = []
    for _u in units:
        _p = np.asarray(_u.pts)
        for _i in range(1, len(_p) - 1):
            _v1, _v2 = _p[_i] - _p[_i - 1], _p[_i + 1] - _p[_i]
            _la, _lb = np.hypot(*_v1), np.hypot(*_v2)
            if _la > 1 and _lb > 1 and (_v1 / _la) @ (_v2 / _lb) < -0.8 \
                    and min(_la, _lb) > 15:
                _src_rev.append(_p[_i])
    if _src_rev:
        from scipy.spatial import cKDTree as _KD
        _rev_tree = _KD(np.asarray(_src_rev))
    else:
        _rev_tree = None

    def spikes(c):
        p = np.asarray(c.pts)
        n = 0
        for i in range(1, len(p) - 1):
            v1, v2 = p[i] - p[i - 1], p[i + 1] - p[i]
            la, lb = np.hypot(*v1), np.hypot(*v2)
            if la > 1 and lb > 1 and (v1 / la) @ (v2 / lb) < -0.8 \
                    and min(la, lb) > 15:
                if _rev_tree is not None and np.isfinite(
                        _rev_tree.query(p[i], distance_upper_bound=1.5)[0]):
                    continue
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
        # class_metrics has always computed these two next to class_acc and
        # the gate has always thrown them away, so a change could gut recall
        # and the headline would not move. Carried, not computed here.
        "truth_recall": {lay.split("|")[-1]: v["recall"]
                         for lay, v in m["truth_layers"].items()
                         if v["recall"] is not None},
        "truth_cov": {lay.split("|")[-1]: v["coverage"]
                      for lay, v in m["truth_layers"].items()
                      if v["coverage"] is not None},
        "truth_ink": {lay.split("|")[-1]: sum(
                          u.length for u in units
                          if u.layer == lay
                          and not getattr(u, "_absorbed", False)
                          and not (u.color and min(u.color) > 0.92
                                   and not getattr(u, "on_fill", False)))
                      for lay in m["truth_layers"]},
        # name-derived truth over EVERY layer on the sheet, not the seven
        # hand-asserted ones. rows dropped: only the summary crosses the
        # process boundary, the misses list is what a human acts on.
        "roles": d["roles"],
        "lost": [{k: r[k] for k in ("layer", "unit_ink", "recall",
                                    "coverage", "coverage_any", "n_chains")}
                 for r in d["lost"][:8]],
        "misfiled": [{k: r[k] for k in ("layer", "unit_ink", "recall",
                                        "coverage", "coverage_any",
                                        "n_chains")}
                     for r in d["misfiled"][:8]],
        "n_lost": len(d["lost"]),
        "n_misfiled": len(d["misfiled"]),
    }


def _wmean(pairs):
    """Ink-weighted mean of (value, ink) pairs; None when there is no ink."""
    tot = sum(w for _, w in pairs)
    return (sum(v * w for v, w in pairs) / tot) if tot else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-cache", action="store_true")
    ap.add_argument("--serial", action="store_true")
    ap.add_argument("--full", action="store_true",
                    help="add the wide layer sweep (slower, more sheets)")
    args = ap.parse_args()
    t0 = time.time()
    corpus = CORPUS + CORPUS_BEAUMONT + (CORPUS_FULL_EXTRA if args.full else [])
    # resolve every sheet BEFORE forking: a missing file must say so in one
    # clear line, not as a FileNotFoundError inside a ProcessPool traceback
    for p, _ in corpus:
        corpus_path(p)
    jobs = [(p, n, not args.no_cache) for p, n in corpus]
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

    # --- hand truth map: the two numbers class_metrics already had --------
    rec = [(v, r["truth_ink"].get(k, 0.0))
           for r in results for k, v in r["truth_recall"].items()]
    cov = [(v, r["truth_ink"].get(k, 0.0))
           for r in results for k, v in r["truth_cov"].items()]
    if accs:
        n_sheets = sum(1 for r in results if r["truth"])
        print(f"hand truth map (TRUTH_CLASSES): {len(accs)} layer instances on "
              f"{n_sheets} of {len(results)} sheets")
        # both means, because they answer different questions and differ by
        # several points: the plain mean matches how class-acc is headlined
        # above, the ink-weighted one is what an estimator actually loses.
        print(f"   plain mean       recall {sum(v for v, _ in rec)/len(rec):6.1%}"
              f"  coverage {sum(v for v, _ in cov)/len(cov):6.1%}")
        print(f"   ink-weighted     recall {_wmean(rec):6.1%}"
              f"  coverage {_wmean(cov):6.1%}")

    # --- derived truth map: role read off the CAD layer name -------------
    print("\nDERIVED LAYER TRUTH  (expectation from the layer NAME - "
          "eval_layers.layer_role)")
    print("  cov = own-layer coverage; any = covered by ANY chain on the "
          "sheet.")
    print("  cov < any means the ink WAS traced by a chain that kept a "
          "different layer.")
    print(f"{'sheet':32} {'linework':>31}   {'symbol':>8}   "
          f"{'annotation':>8}  lost misfiled")
    print(f"{'':32} {'n':>3} {'cov':>8} {'any':>8} {'rec':>8}   {'cov':>8}   "
          f"{'cov':>8}")
    agg = {k: [] for k in ("linework", "symbol", "annotation")}
    agg_any, agg_rec = [], []
    n_lost = n_misfiled = 0
    for r in results:
        cells = []
        for role in ("linework", "symbol", "annotation"):
            s = r["roles"][role]
            if s["coverage"] is not None:
                agg[role].append((s["coverage"], s["ink"]))
                if role == "linework":
                    agg_rec.append((s["recall"], s["ink"]))
                    agg_any.append((s["coverage_any"], s["ink"]))
            cells.append(s)
        lw, sy, an = cells
        n_lost += r["n_lost"]
        n_misfiled += r["n_misfiled"]

        def _p(v):
            return f"{v:8.1%}" if v is not None else f"{'-':>8}"
        print(f"{r['sheet']:32} {lw['n']:3} {_p(lw['coverage'])} "
              f"{_p(lw['coverage_any'])} {_p(lw['recall'])}"
              f"   {_p(sy['coverage'])}   {_p(an['coverage'])}"
              f"  {r['n_lost']:4} {r['n_misfiled']:8}")
    wl, ws, wa = (_wmean(agg[k]) for k in ("linework", "symbol", "annotation"))
    wlr, wla = _wmean(agg_rec), _wmean(agg_any)

    def _q(v):
        return f"{v:.1%}" if v is not None else "-"
    n_inst = sum(r["roles"]["linework"]["n"] for r in results)
    n_sh = sum(1 for r in results if r["roles"]["linework"]["n"])
    print(f"\nlinework  traced by SOMETHING {_q(wla)}   traced and correctly "
          f"attributed {_q(wl)}   raw ink recall {_q(wlr)}")
    print(f"          ink-weighted over {n_inst} layer instances on {n_sh} of "
          f"{len(results)} sheets. The gap between the first two is "
          f"attribution,\n          not detection - and the first is an upper "
          f"bound, since an unrelated chain within 3 pt also satisfies it.")
    print(f"symbol    coverage {_q(ws)}        "
          f"| annotation coverage {_q(wa)}  "
          f"(annotation SHOULD be low - that is the junk pruner working)")
    # what the recall denominator is made of. CAD plots some text as vector
    # outlines, and that ink can never become a chain, so a recall figure
    # read without this share is pessimistic in a way nothing reveals.
    lwi = sum(r["roles"]["linework"]["ink"] for r in results)
    lwg = sum(r["roles"]["linework"]["glyph_ink"] for r in results)
    if lwi:
        print(f"          of the linework denominator, {lwg/lwi:.1%} is vector "
              f"letter outlines (eval_layers.is_letterform) - mostly the "
              f"inline\n          marks of dash-text utility runs, which "
              f"coverage credits and raw recall does not")

    for kind, n in (("lost", n_lost), ("misfiled", n_misfiled)):
        if not n:
            continue
        what = ("traced by NOTHING - a real hole in the takeoff"
                if kind == "lost"
                else "traced, but the chain kept another layer")
        print(f"\n{kind.upper()} ({n} linework layers under 50% own-layer "
              f"coverage): {what}")
        allm = [(r["sheet"], m) for r in results for m in r[kind]]
        allm.sort(key=lambda sm: -sm[1]["unit_ink"])
        for sheet, m in allm[:12]:
            print(f"   {sheet[:26]:26} {m['layer'][:32]:32} "
                  f"ink={m['unit_ink']:8.0f} rec={m['recall']:6.1%} "
                  f"cov={(m['coverage'] or 0.0):6.1%} "
                  f"any={(m['coverage_any'] or 0.0):6.1%} "
                  f"chains={m['n_chains']}")


if __name__ == "__main__":
    main()
