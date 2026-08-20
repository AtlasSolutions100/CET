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

from .chain import _classify_cadence, _weight_class

# legend geometry (pt): how far below LEGEND to look, label row grouping,
# and the sample strip to the left of each label
REGION_H = 420.0
REGION_W = 520.0
ROW_TOL = 7.0
SAMPLE_W = 240.0
SAMPLE_H = 7.0


def read_legend(words: list, chains: list, units: list | None = None) -> dict:
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
            if sample is None and units is not None:
                # swatches are tiny and often fail to chain (pattern-filled
                # bars, touching marks); the RAW strip marks still spell the
                # cadence out - read it directly and join to a style by
                # measured geometry below
                sample = _sample_from_units(units, x0 - SAMPLE_W, x0 - 4.0, cy)
            if sample is None:
                continue
            entries.append({"label": label, **sample})

    # inline "SWATCH = NAME" definitions: sheets without a LEGEND box
    # define a symbol in place ("### = SHEAR WALL", Belle Structural p2).
    # Anchor on an '=' word; the NAME is the word run to its right, the
    # sample is the geometry strip to its left. Guards, both measured:
    #  - a scale note ('1" = 20'') has TEXT in the left strip and a
    #    numeric right side - rejected by the no-words-left test and the
    #    mostly-alpha label test
    #  - a title-block '=' with no same-row words yields no label
    for w in words:
        if str(w[4]).strip() != "=":
            continue
        ex0, ex1 = w[0], w[2]
        ecy = (w[1] + w[3]) / 2
        eh = max(w[3] - w[1], 6.0)
        # the swatch of a '= NAME' definition hugs the '=': a tight strip
        # keeps distant room labels (Belle: 'HALL' 220pt left) from
        # vetoing the row, and keeps unrelated plan geometry out of the
        # sample. A scale note's '1"' sits 5-30pt left - still caught.
        strip_x0, strip_x1 = ex0 - 110.0, ex0 - 4.0
        if any(ww[2] > strip_x0 and ww[0] < strip_x1
               and abs((ww[1] + ww[3]) / 2 - ecy) <= eh
               for ww in words if ww is not w):
            continue
        right = sorted((ww for ww in words
                        if abs((ww[1] + ww[3]) / 2 - ecy) <= eh
                        and ww[0] >= ex1 - 1.0 and ww[0] - ex1 <= 60.0),
                       key=lambda ww: ww[0])
        run = []
        cur_x = ex1
        for ww in right:
            if run and ww[0] - cur_x > 24.0:
                break
            run.append(ww)
            cur_x = ww[2]
        label = " ".join(str(ww[4]).strip() for ww in run).strip()
        alpha = sum(ch.isalpha() for ch in label)
        if not (3 <= len(label) <= 60) or alpha < 3 or alpha < len(label) * 0.5:
            continue
        sample = _sample_in_strip(chains, strip_x0, strip_x1, ecy)
        if sample is None and units is not None:
            sample = _sample_from_units(units, strip_x0, strip_x1, ecy)
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
    # unit-derived samples have no chained style: join by measured geometry
    # (class family + weight + colour + dash length within tolerance)
    reps: dict = {}
    for c in chains:
        r = reps.setdefault(c.style_id, c)
        if c.length > r.length:
            reps[c.style_id] = c
    for e in entries:
        if e.get("sample_style") is not None:
            continue
        best = None
        for sid, r in reps.items():
            if not r.klass.startswith("dash") or r.klass != e["klass"]:
                continue
            if _weight_class(r.width) != e["weight"]:
                continue
            if e["color"] and r.color and \
                    max(abs(a - b) for a, b in zip(e["color"], r.color)) > 0.2:
                continue
            rd = (r.ink or r.length) / max(r.n_dashes, 1)
            lo, hi = sorted([e["avg_dash"], rd])
            if hi > 1.9 * lo + 3.0:
                continue
            cand = sum(c2.length for c2 in chains if c2.style_id == sid)
            if best is None or cand > best[1]:
                best = (sid, cand)
        if best is None:
            # SECOND TIER: bold dashed lines often chain as individual
            # SOLID bars (each long dash = one solid chain), so the dashed
            # legend entry finds no dashed style. Match a solid style whose
            # typical mark length fits the swatch's LONGEST bar, with
            # matching colour and near weight - the sheet's own legend
            # doing the matching, not a stored template.
            want = e.get("max_dash") or e["avg_dash"]
            for sid, r in reps.items():
                if r.klass != "solid":
                    continue
                if abs(_weight_class(r.width) - e["weight"]) > 1:
                    continue
                if e["color"] and r.color and \
                        max(abs(a - b) for a, b in zip(e["color"], r.color)) > 0.2:
                    continue
                sib = [c for c in chains if c.style_id == sid]
                if not (2 <= len(sib) <= 150):
                    continue
                med = float(np.median([c.length for c in sib]))
                lo, hi = sorted([want, med])
                if hi > 1.9 * lo + 3.0:
                    continue
                cand = sum(c.length for c in sib)
                if best is None or cand > best[1]:
                    best = (sid, cand)
        if best is not None:
            e["sample_style"] = best[0]
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
        if e["sample_style"] is not None:
            style_labels.setdefault(e["sample_style"], e["label"])
        # compound swatch: label the OTHER distinctive styles drawn in the
        # same sample (hatch + centerline = one symbol). Same distinctive
        # gate as above so a generic thin black solid never gets smeared.
        for sid in e.get("co_styles", []):
            r = reps.get(sid)
            if r is None:
                continue
            d2 = (r.klass.startswith("dash")
                  or (r.color and max(r.color) - min(r.color) > 0.15)
                  or (r.color and min(r.color) > 0.35)
                  or _weight_class(r.width) >= 2)
            if d2 and by_style_count[sid] <= 150:
                style_labels.setdefault(sid, e["label"])
    return {"entries": entries, "style_labels": style_labels}


def read_legend_sheet(words: list, chains: list) -> list:
    """Read a DEDICATED legend sheet (e.g. "C1.1 LEGEND & NOTES").

    Different problem from an inline legend box: here the legend is a tall
    column running most of the sheet height with dozens of rows, often with
    separate PROPOSED and EXISTING sample columns per label. So this does
    not anchor on the word "LEGEND" (which also appears in notes, and whose
    420pt neighbourhood misses most of the column). It anchors on the
    structure instead: many label rows, stacked vertically, each with a flat
    horizontal sample bar in a left-aligned strip beside it.

    Returns fingerprints for cross-sheet matching - the style ids here are
    meaningless on other sheets, so what transfers is (class, colour,
    weight, cadence).
    """
    rows = defaultdict(list)
    for w in words:
        t = str(w[4]).strip()
        if not t:
            continue
        rows[round(((w[1] + w[3]) / 2) / ROW_TOL)].append(w)

    cands = []
    for _, ws in sorted(rows.items()):
        ws.sort(key=lambda w: w[0])
        kept = []
        for w in ws:
            t = str(w[4]).strip()
            dup = any(str(k[4]).strip().upper() == t.upper()
                      and min(w[2], k[2]) - max(w[0], k[0]) > 0.5 * (w[2] - w[0])
                      for k in kept)
            if not dup:
                kept.append(w)
        # A legend sheet is laid out in COLUMNS - notes on the left, legend
        # on the right - so a page-wide row mixes them. Split the row where
        # a wide horizontal gap separates columns, or the "label" becomes a
        # note sentence and the sample strip is searched hundreds of pt away
        # from the actual legend.
        runs, run = [], [kept[0]]
        for prev, w in zip(kept, kept[1:]):
            if w[0] - prev[2] > 34.0:
                runs.append(run)
                run = [w]
            else:
                run.append(w)
        runs.append(run)

        for ri, rw in enumerate(runs):
            label = " ".join(str(w[4]).strip() for w in rw).strip()
            if not (3 <= len(label) <= 48):
                continue
            if not any(ch.isalpha() for ch in label):
                continue
            x0 = rw[0][0]
            x1 = rw[-1][2]
            cy = float(np.mean([(w[1] + w[3]) / 2 for w in rw]))
            def _wordy(lo, hi):
                # a sample cell holds at most a short inline token (- TV -);
                # several words there means prose (an abbreviations table's
                # definition column), never a line sample
                n = 0
                for ww in words:
                    wx, wy = (ww[0] + ww[2]) / 2, (ww[1] + ww[3]) / 2
                    if lo <= wx <= hi and abs(wy - cy) <= ROW_TOL:
                        n += 1
                return n > 2
            found = None
            for strip_w in (SAMPLE_W, SAMPLE_W * 0.45):
                if _wordy(x0 - strip_w, x0 - 4.0):
                    continue
                found = _sample_in_strip(chains, x0 - strip_w, x0 - 4.0, cy,
                                         min_span=30.0)
                if found is not None:
                    break
            if found is None:
                # TABLE legends (DESCRIPTION | EXISTING | PROPOSED) put the
                # sample to the RIGHT of the label; bound the strip by the
                # next run on the row so a second table column's label can
                # never be read as this row's sample
                lim = runs[ri + 1][0][0] - 6.0 if ri + 1 < len(runs)                     else x1 + SAMPLE_W
                hi = min(x1 + SAMPLE_W, lim)
                if hi - x1 >= 24.0 and not _wordy(x1 + 4.0, hi):
                    found = _sample_in_strip(chains, x1 + 4.0, hi, cy,
                                             min_span=min(30.0, 0.5 * (hi - x1)))
            if found is not None:
                cands.append({"label": label, "x0": x0, "cy": cy, **found})

    if len(cands) < 8:
        return []  # a handful of bar-beside-text rows is a table, not a legend

    # a legend column is left-aligned: keep every label-x cluster with
    # enough rows to be a real column (multi-column TABLE legends have
    # several), so stray bar-beside-text rows elsewhere cannot join in
    keep, used = [], set()
    for c in cands:
        if id(c) in used:
            continue
        near = [d for d in cands if abs(d["x0"] - c["x0"]) <= 26.0]
        if len(near) >= 8:
            for d in near:
                if id(d) not in used:
                    used.add(id(d))
                    keep.append(d)
    if len(keep) < 8:
        return []
    out, seen = [], set()
    for c in sorted(keep, key=lambda c: c["cy"]):
        key = (c["label"].upper(), round(c["cy"] / 4))
        if key in seen:
            continue
        seen.add(key)
        out.append(c)
    return out


# Cross-sheet AUTO-LABELLING BY GEOMETRY WAS TRIED AND REJECTED.
# Matching a plan style to a legend row on (class, weight, colour, cadence)
# looks reasonable and is wrong often enough to be dangerous. Scored against
# the CAD layer names as ground truth it put "STORM SEWER" on P1-FENCE and
# "SANITARY SEWER" on the water, gas, firewater and storm-swale runs - the
# legend holds exactly one dash-text row, so every dash-text style on the
# plan matched it. Tightening to rows with a legend-unique fingerprint made
# it worse (18 labels, ~10 wrong), because legend-side uniqueness does not
# make the plan's line that feature.
#
# What separates GAS LINE from WATER LINE is the letter printed inline, and
# an exploded glyph does not yield the letter. So the legend sheet is used as
# a VOCABULARY the reviewer picks from (read_legend_sheet above), never as an
# automatic label - a confident wrong trade name on billable footage is the
# one failure the estimator cannot catch by eye.


def _sample_from_units(units: list, x0: float, x1: float, cy: float):
    """Cadence of a legend swatch read straight from its raw marks."""
    strip = [u for u in units
             if x0 < float(u.pts[:, 0].mean()) < x1
             and abs(float(u.pts[:, 1].mean()) - cy) <= SAMPLE_H
             and u.length >= 1.0 and not u.closed]
    if len(strip) < 3:
        return None
    strip.sort(key=lambda u: float(u.pts[:, 0].min()))
    lens = [float(u.length) for u in strip]
    gaps = []
    for a, b in zip(strip, strip[1:]):
        gaps.append(max(float(b.pts[:, 0].min() - a.pts[:, 0].max()), 0.0))
    span = float(strip[-1].pts[:, 0].max() - strip[0].pts[:, 0].min())
    if span < 30.0:
        return None
    klass, _sig = _classify_cadence(lens, [g for g in gaps if g > 0.5] or gaps)
    if not klass.startswith("dash"):
        # several distinct marks with real gaps IS a dash pattern even if
        # the classifier defaults solid on tiny samples
        klass = "dash2" if len(set(round(v / 4) for v in lens)) >= 2 else "dash1"
    wmax = max((u.width or 0.0) for u in strip)
    col = strip[int(np.argmax([u.length for u in strip]))].color
    return {
        "klass": klass,
        "color": col,
        "weight": _weight_class(wmax),
        "avg_dash": float(np.median(lens)),
        "max_dash": float(max(lens)),
        "sample_style": None,
    }


def _sample_in_strip(chains: list, x0: float, x1: float, cy: float,
                     min_span: float | None = None):
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
    # A swatch bar is judged by its own plausible size, not by the strip's
    # width: legends that park labels far from the bars (Oncor p4) make the
    # strip wide, and 0.45x of wide rejected every genuine 38-98pt sample.
    need = min_span if min_span is not None else min(0.45 * (x1 - x0), 34.0)
    hits = []
    for cs in by_style.values():
        allx = np.concatenate([np.asarray(c.pts)[:, 0] for c in cs])
        if float(allx.max() - allx.min()) < need:
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
        # a compound swatch draws its symbol with several pens (Belle's
        # shear wall: hatch ticks + a native-dashed centerline). Every
        # qualifying style in the strip belongs to the definition, not
        # just the longest bar - the caller labels the distinctive ones.
        "co_styles": sorted({c.style_id for c in hits} - {rep.style_id}),
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
