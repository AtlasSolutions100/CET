"""Layer-based evaluation: score detection against the PDF's own CAD layers.

When a plan PDF preserves OCG layer names, every stroke's layer is free
ground truth for two things hand labels would otherwise provide:

  recall  - how much of a layer's stroke ink ended up in emitted chains
            (dropped ink = pruned as junk, stray fragments, or lost)
  purity  - how much of a layer's chained ink lands in its dominant
            (class, signature-bucket) style. A real line layer (water main,
            easement) should resolve to ONE style; low purity means the
            cadence classifier is splitting or mixing it.

Hatch/label layers are marked textural - low recall there is the junk
pruner doing its job, not a failure.

Usage:
  python -m takeoff_engine.eval_layers <pdf> [--page N]
"""

import argparse
from collections import defaultdict

import pymupdf

from .chain import build_chains, _sig_bucket
from .extract import extract_strokes

TEXTURAL_HINTS = ("HATCH", "-LBL", "TEXT")


def is_textural(layer: str) -> bool:
    """Textural = annotation/hatch decoration. Judged on the LEAF layer
    name: 'X-CORR|O-ALIGN-LOVES CL' is a road corridor xref carrying a REAL
    centerline, while 'P1-PVMT-CORR' (leaf ends in -CORR) is corridor
    surface texture."""
    leaf = (layer or "").split("|")[-1].upper()
    return any(h in leaf for h in TEXTURAL_HINTS) or leaf.endswith("-CORR")


def eval_page(page: pymupdf.Page):
    units = extract_strokes(page)
    chains = build_chains(units, words=page.get_text("words"))

    per_layer = defaultdict(lambda: {"unit_ink": 0.0, "chain_ink": 0.0,
                                     "styles": defaultdict(float), "n_chains": 0})
    for u in units:
        if u.color and min(u.color) > 0.92:
            continue  # invisible whiteout, excluded from scoring like in build
        per_layer[u.layer]["unit_ink"] += u.length

    for c in chains:
        s = per_layer[c.layer]
        ink = getattr(c, "ink", None) or c.length
        s["chain_ink"] += ink
        s["n_chains"] += 1
        s["styles"][(c.klass, _sig_bucket(c.dash_signature))] += ink

    rows = []
    for layer, s in per_layer.items():
        if s["unit_ink"] < 50:
            continue
        recall = min(s["chain_ink"] / s["unit_ink"], 1.0) if s["unit_ink"] else 0.0
        if s["styles"]:
            (dom_class, dom_sig), dom_ink = max(s["styles"].items(), key=lambda kv: kv[1])
            purity = dom_ink / max(s["chain_ink"], 1e-9)
        else:
            dom_class, dom_sig, purity = "-", "-", 0.0
        rows.append({
            "layer": layer or "(none)",
            "textural": is_textural(layer),
            "unit_ink": s["unit_ink"],
            "recall": recall,
            "purity": min(purity, 1.0),
            "n_chains": s["n_chains"],
            "dom": f"{dom_class} {dom_sig}",
        })
    rows.sort(key=lambda r: -r["unit_ink"])
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pdf")
    ap.add_argument("--page", type=int, default=0)
    args = ap.parse_args()

    doc = pymupdf.open(args.pdf)
    rows = eval_page(doc[args.page])
    line_rows = [r for r in rows if not r["textural"]]
    if line_rows:
        tot = sum(r["unit_ink"] for r in line_rows)
        w_recall = sum(r["recall"] * r["unit_ink"] for r in line_rows) / tot
        w_purity = sum(r["purity"] * r["unit_ink"] for r in line_rows) / tot
        print(f"LINE LAYERS ink-weighted: recall={w_recall:.1%} purity={w_purity:.1%}\n")
    print(f"{'layer':46} {'ink':>8} {'recall':>7} {'purity':>7} {'n':>5}  dominant")
    for r in rows:
        tag = " [tex]" if r["textural"] else ""
        print(f"{r['layer'][:46]:46} {r['unit_ink']:8.0f} {r['recall']:7.1%} "
              f"{r['purity']:7.1%} {r['n_chains']:5}  {r['dom'][:38]}{tag}")


if __name__ == "__main__":
    main()


# --- per-class milestone metrics -------------------------------------------

# Layers whose true line class is unambiguous (asserted from the legend /
# drawing conventions). Used to score classification accuracy.
TRUTH_CLASSES = {
    "O-SURFACE-EXISTING COMBINED": "dash1",
    "24007215.01-X-SITE|E3-LOTS": "dash1",
    "24007215.01-X-SITE|P1-FENCE": "dash1",
    # utility runs carry a repeating inline mark in every gap - verified by
    # rendering each one: water "- W -", firewater "- FW -", storm swale a
    # flow chevron "- > -" (see _mark_glyph_text_chains for why letters and
    # symbols share one class)
    "24007215.01-X-SITE|P2-WATER-LINE": "dash-text",
    "24007215.01-X-SITE|P2-STORM-SWALE": "dash-text",
    "24007215.01-X-SITE|P2-FIREWATER-LINE": "dash-text",
    "24007215.01-X-SITE|P1-PVMT-CL": "dash2",
}

DASH_CLASSES = ("dash1", "dash2", "dash3", "dash-text")


def class_metrics(chains, units) -> dict:
    """Milestone-facing numbers.

    precision proxy (layered PDFs): a dashed chain living on a textural
    layer (TEXT/LBL/HATCH names) is a false detection - real dashed lines
    do not live on annotation layers.

    classification accuracy: ink on TRUTH_CLASSES layers classified as the
    asserted class.
    """
    per_class = {}
    for klass in DASH_CLASSES + ("solid",):
        cs = [c for c in chains if c.klass == klass]
        total = sum(c.ink or c.length for c in cs)
        # junk = dashed ink on annotation layers, EXCEPT long structured
        # chains - firms draw real boundaries on "TEXT" layers (C8.0 basin
        # boundary on P6-TEXT-STORM), and those are intentional keeps that
        # mirror the engine's own demotion gate
        import numpy as _np
        junk = sum(
            (c.ink or c.length) for c in cs
            if is_textural(c.layer)
            and float(_np.hypot(*(c.pts.max(axis=0) - c.pts.min(axis=0)))) < 300.0
        )
        per_class[klass] = {
            "ink": total,
            "junk_ink": junk,
            "precision": (total - junk) / total if total else None,
            "n": len(cs),
        }

    truth = {}
    for lay, want in TRUTH_CLASSES.items():
        cs = [c for c in chains if c.layer == lay]
        if not cs:
            continue
        total = sum(c.ink or c.length for c in cs)
        good = sum((c.ink or c.length) for c in cs if c.klass == want)
        # ink recall against the layer's raw stroke ink
        lay_units = [u for u in units
                     if u.layer == lay and not (u.color and min(u.color) > 0.92)]
        lay_ink = sum(u.length for u in lay_units)
        truth[lay] = {
            "want": want, "class_acc": good / total if total else None,
            "recall": min(total / lay_ink, 1.0) if lay_ink else None,
            "coverage": _coverage(lay_units, cs),
        }
    return {"per_class": per_class, "truth_layers": truth}


def _coverage(lay_units, chains, tol: float = 3.0):
    """Decoration-aware recall: fraction of the layer's stroke ink whose
    units sit on (within tol of) an emitted chain. Fence X-marks and swale
    arrowheads live ON their line, so a found line covers them - unlike raw
    ink recall, which punishes every decorative stroke as 'missed'."""
    import numpy as np
    from scipy.spatial import cKDTree

    from .chain import _sample_polyline

    if not lay_units or not chains:
        return None
    samples = []
    for c in chains:
        s, _ = _sample_polyline(np.asarray(c.pts), step=2.0, max_n=100000)
        if len(s):
            samples.append(s)
    if not samples:
        return 0.0
    tree = cKDTree(np.vstack(samples))
    covered = total = 0.0
    for u in lay_units:
        # a decoration counts as covered when any part of it touches the
        # emitted chain: fence X's drawn as offset halves have midpoints
        # ~half a leg off the centerline, but an endpoint at the X center
        # sits ON the line
        probes = (u.pts[len(u.pts) // 2], u.pts[0], u.pts[-1])
        d = min(tree.query(p, distance_upper_bound=tol)[0] for p in probes)
        total += u.length
        if np.isfinite(d):
            covered += u.length
    return covered / total if total else None


def print_class_metrics(m: dict) -> None:
    print(f"\n{'class':10} {'chains':>7} {'ink':>9} {'precision':>10}")
    for k, s in m["per_class"].items():
        p = f"{s['precision']:.1%}" if s["precision"] is not None else "-"
        print(f"{k:10} {s['n']:7} {s['ink']:9.0f} {p:>10}")
    if m["truth_layers"]:
        print(f"\n{'truth layer':46} {'want':7} {'class-acc':>10} {'recall':>8} {'coverage':>9}")
        for lay, s in m["truth_layers"].items():
            cov = f"{s['coverage']:.1%}" if s.get("coverage") is not None else "-"
            print(f"{lay[:46]:46} {s['want']:7} {s['class_acc']:10.1%} {s['recall']:8.1%} {cov:>9}")
