"""Legend reader: let the sheet label its own line styles.

Many sheets carry a LEGEND box pairing a short line sample with a name
("PROPERTY LINE", "PROPOSED CL", "EDGE OF PAVEMENT"). Reading it turns
style labeling from a human chore into sheet-provided ground truth:

  1. locate the word LEGEND (text layer or the words list passed in),
  2. collect label rows beneath it (words grouped into lines),
  3. for each row, the line SAMPLE is the linework in the strip just left
     of the label text,
  4. characterize the sample (color, weight, class, avg dash length) and
     match it against the sheet's detected styles.

Output maps style_id -> legend label, used to pre-fill suggested labels.
"""

from collections import defaultdict

import numpy as np

from .chain import _weight_class

# legend geometry (pt): how far below LEGEND to look, label row grouping,
# and the sample strip to the left of each label
REGION_H = 420.0
REGION_W = 520.0
ROW_TOL = 7.0
SAMPLE_W = 240.0
SAMPLE_H = 7.0


def read_legend(words: list, chains: list) -> dict:
    """Returns {"entries": [...], "style_labels": {style_id: label}}."""
    seen = set()
    deduped = []
    for w in words:
        key = (str(w[4]).strip().upper(), round(w[0] / 6), round(w[1] / 6))
        if key in seen:
            continue
        seen.add(key)
        deduped.append(w)
    words = deduped
    legend_words = [w for w in words if str(w[4]).strip().upper() == "LEGEND"]
    entries = []
    style_labels: dict = {}

    for lw in legend_words:
        lx, ly = lw[0], lw[3]
        region = [w for w in words
                  if ly - 6 <= w[1] <= ly + REGION_H
                  and lx - REGION_W * 0.55 <= w[0] <= lx + REGION_W
                  and str(w[4]).strip().upper() != "LEGEND"]
        # group words into rows
        rows = defaultdict(list)
        for w in region:
            cy = (w[1] + w[3]) / 2
            key = round(cy / ROW_TOL)
            rows[key].append(w)
        for _, ws in sorted(rows.items()):
            ws.sort(key=lambda w: w[0])
            # text layer + OCR both contribute the same words at slightly
            # different boxes; drop x-overlapping repeats of the same text
            kept = []
            for w in ws:
                t = str(w[4]).strip()
                dup = any(str(k[4]).strip().upper() == t.upper()
                          and min(w[2], k[2]) - max(w[0], k[0])
                          > 0.5 * (w[2] - w[0])
                          for k in kept)
                if not dup:
                    kept.append(w)
            ws = kept
            # OCR sometimes reads the tail of the sample symbol as a stray
            # short token ("Ct 8' MASONRY WALL"); legend labels are caps, so
            # drop leading short tokens containing lowercase letters
            while ws and len(str(ws[0][4]).strip()) <= 3 \
                    and any(ch.islower() for ch in str(ws[0][4])):
                ws = ws[1:]
            if not ws:
                continue
            label = " ".join(str(w[4]).strip() for w in ws).strip()
            if not (3 <= len(label) <= 60):
                continue
            x0 = ws[0][0]
            cy = float(np.mean([(w[1] + w[3]) / 2 for w in ws]))
            sample = _sample_in_strip(chains, x0 - SAMPLE_W, x0 - 4.0, cy)
            if sample is None:
                continue
            entries.append({"label": label, **sample})

    if not entries:
        return {"entries": [], "style_labels": {}}

    # the sample IS a chain of some style; the join is exact - label that
    # style and nothing else. But only when the style is DISTINCTIVE: a
    # legend sample landing in the generic black-solid bucket would smear
    # its label over every plain solid on the sheet (Oncor masonry wall
    # labeled 118 unrelated lines). Dashed cadences, non-black colors, and
    # heavy weights identify a real style; plain thin solids do not.
    by_style_count: dict = defaultdict(int)
    for c in chains:
        by_style_count[c.style_id] += 1
    for e in entries:
        distinctive = (
            e["klass"].startswith("dash")
            or (e["color"] and max(e["color"]) - min(e["color"]) > 0.15)
            or (e["color"] and min(e["color"]) > 0.35)
            or e["weight"] >= 2
        )
        if not distinctive and by_style_count[e["sample_style"]] > 8:
            continue  # generic bucket: an honest miss beats a smear
        if not e["klass"].startswith("dash") \
                and by_style_count[e["sample_style"]] > 25:
            continue  # solid bucket too big to be one legend feature
        style_labels.setdefault(e["sample_style"], e["label"])
    return {"entries": entries, "style_labels": style_labels}


def _sample_in_strip(chains: list, x0: float, x1: float, cy: float):
    """Characterize the linework inside the legend row's sample strip.
    A legend sample is a HORIZONTAL bar spanning most of the strip -
    leader lines and stray marks near note text don't qualify."""
    cands = []
    for c in chains:
        pts = np.asarray(c.pts)
        m = (pts[:, 0] >= x0) & (pts[:, 0] <= x1) \
            & (np.abs(pts[:, 1] - cy) <= SAMPLE_H)
        if m.mean() < 0.6 or m.sum() < 2:
            continue
        rise = float(pts[:, 1].max() - pts[:, 1].min())
        if rise > 8.0:
            continue
        cands.append(c)
    if not cands:
        return None
    # a sample bar may be broken into several same-style pieces (e.g. a
    # "PL" symbol interrupting the bar): span is judged per STYLE over the
    # union of its pieces, not per chain
    by_style = defaultdict(list)
    for c in cands:
        by_style[c.style_id].append(c)
    hits = []
    for cs in by_style.values():
        allx = np.concatenate([np.asarray(c.pts)[:, 0] for c in cs])
        if float(allx.max() - allx.min()) < 0.45 * (x1 - x0):
            continue
        hits.extend(cs)
    if not hits:
        return None
    rep = max(hits, key=lambda c: c.length)
    return {
        "klass": rep.klass,
        "color": rep.color,
        "weight": _weight_class(rep.width),
        "avg_dash": (rep.ink or rep.length) / max(rep.n_dashes, 1),
        "sample_style": rep.style_id,
    }


def _style_matches(entry: dict, rep) -> bool:
    if entry["klass"] != rep.klass:
        return False
    if entry["weight"] != _weight_class(rep.width):
        return False
    ec, rc = entry["color"], rep.color
    if (ec is None) != (rc is None):
        return False
    if ec and max(abs(a - b) for a, b in zip(ec, rc)) > 0.15:
        return False
    if rep.klass.startswith("dash"):
        ad = (rep.ink or rep.length) / max(rep.n_dashes, 1)
        lo, hi = sorted([entry["avg_dash"], ad])
        if hi > 1.9 * lo + 3.0:
            return False
    return True
