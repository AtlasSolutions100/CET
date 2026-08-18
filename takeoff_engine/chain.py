"""Dash chaining and line-style classification.

CAD plot drivers explode dashed lines into hundreds of independent tiny
strokes; the dash pattern only exists as geometry. This module rebuilds the
lines: group strokes by visual style, link dash fragments end-to-end by
proximity + direction continuity (mutual-best matching so crossing lines
don't capture each other's dashes), then read the dash/gap cadence off each
rebuilt chain as its classification signature.

Classes emitted:
  solid       continuous linework
  dash1       uniform repeating dash
  dash2       two dash-length cadence (incl. dash-dot)
  dash3       three-or-more dash-length cadence
  dash-text   dashed line interrupted by inline labels (e.g. "SD")
"""

from collections import Counter, defaultdict
from dataclasses import dataclass, field

import numpy as np

from .extract import StrokeUnit

# A stroke at least this long (pt) that isn't part of a dash cadence is a
# solid line in its own right.
SOLID_MIN_LEN = 30.0
# Strokes up to this long can participate in dash chaining. Long-dash
# utility patterns run 30-60pt per dash, so this must sit well above them;
# solid polyline fragments that enter chaining are rejected downstream by
# the gap-median check (touching segments have no real gaps).
DASH_MAX_LEN = 80.0
# Hard ceiling on the gap between consecutive dashes of one line. Long-dash
# utility patterns leave ~45-50pt between dashes (often with a chevron or
# marker symbol sitting in the gap); the per-group adaptive radius keeps
# dense small-dash groups (contours) well below this.
GAP_ABS_MAX = 64.0
# Angular tolerance (deg) between a dash's outward direction and the gap
# vector to its neighbour. Generous enough to follow curved dashed contours.
ANG_TOL_DEG = 32.0
# A chain must have at least this many dashes to classify as a dashed line;
# below this, short strokes are symbol fragments, not linework.
MIN_DASHES = 4
# Strokes shorter than this are dots (their own direction is meaningless -
# a 2pt dot's chord heading is plot-driver noise, so angle checks must not
# apply; dash-dot patterns lose their dots without this).
DOT_LEN = 2.5


@dataclass
class LineChain:
    chain_id: int
    pts: np.ndarray  # (N,2) polyline in page pt coordinates
    klass: str
    color: tuple
    width: float
    length: float
    n_dashes: int
    dash_signature: str  # e.g. "d5.2 g3.1" or "d12 d3 g4" per repeating unit
    label_texts: list = field(default_factory=list)
    style_id: int = -1
    layer: str = ""
    ink: float = 0.0  # stroke length excluding gaps; 0 -> use length

    def to_dict(self) -> dict:
        return {
            "chain_id": self.chain_id,
            "class": self.klass,
            "color": self.color,
            "width": self.width,
            "layer": self.layer,
            "length_pt": round(self.length, 2),
            "n_dashes": self.n_dashes,
            "dash_signature": self.dash_signature,
            "label_texts": self.label_texts,
            "style_id": self.style_id,
            "ink_pt": round(self.ink or self.length, 2),
            "points": [[round(float(x), 2), round(float(y), 2)] for x, y in self.pts],
        }


def _style_key(u: StrokeUnit) -> tuple:
    color = tuple(round(c, 2) for c in u.color) if u.color else None
    # CAD layer name, when preserved, is the strongest style separator the
    # file offers: it keeps e.g. water-main dashes from chaining into
    # same-colored storm-swale dashes
    return (color, round(u.width or 0.0, 1), u.layer)


def _out_dir(u: StrokeUnit, end: int, lookback: float = 6.0) -> np.ndarray:
    """Unit vector pointing outward from the stroke at the given endpoint.

    Measured over a lookback arc rather than the final micro-segment:
    plotted dashes often end in sub-point hooks or merged marker strokes
    whose last vertex points anywhere, while the direction a few points
    into the stroke is the true heading.
    """
    pts = u.pts if end == 1 else u.pts[::-1]
    tip = pts[-1]
    lb = min(lookback, max(u.length * 0.6, 1e-3))
    acc = 0.0
    anchor = pts[0]
    for k in range(len(pts) - 1, 0, -1):
        step = float(np.hypot(*(pts[k] - pts[k - 1])))
        acc += step
        if acc >= lb:
            anchor = pts[k - 1]
            break
    v = tip - anchor
    n = np.hypot(*v)
    return v / n if n > 1e-9 else np.array([1.0, 0.0])


def _match_links(units: list, idxs: list, gap_max: float, ang_tol_deg: float) -> list:
    """Greedy mutual-exclusive endpoint matching, vectorized over all
    endpoint pairs within gap_max. Returns accepted links
    (ui, end_i, uj, end_j). Each endpoint joins at most one link."""
    if len(idxs) < 2:
        return []
    from scipy.spatial import cKDTree

    n = len(idxs)
    # endpoint arrays: 2 rows per unit (end 0, end 1)
    pos = np.empty((2 * n, 2))
    odir = np.empty((2 * n, 2))
    ulen = np.empty(2 * n)
    for k, i in enumerate(idxs):
        u = units[i]
        pos[2 * k] = u.pts[0]
        pos[2 * k + 1] = u.pts[-1]
        odir[2 * k] = _out_dir(u, 0)
        odir[2 * k + 1] = _out_dir(u, 1)
        ulen[2 * k] = ulen[2 * k + 1] = u.length

    tree = cKDTree(pos)
    pairs = tree.query_pairs(gap_max, output_type="ndarray")
    if len(pairs) == 0:
        return []
    a, b = pairs[:, 0], pairs[:, 1]
    same_unit = (a // 2) == (b // 2)
    a, b = a[~same_unit], b[~same_unit]

    g = pos[b] - pos[a]
    dist = np.hypot(g[:, 0], g[:, 1])
    # dynamic gap first - it needs no geometry math and cheaply shrinks the
    # arrays every later step runs on (dot fields produce millions of pairs)
    local_max = np.minimum(gap_max, np.maximum(10.0, 3.0 * np.maximum(ulen[a], ulen[b])))
    keep = dist <= local_max
    a, b, g, dist = a[keep], b[keep], g[keep], dist[keep]
    if len(a) == 0:
        return []

    # touching endpoints (dist ~ 0) are continuous geometry split across
    # path objects - always a valid join, no direction test possible
    touching = dist < 0.5
    cos_tol = np.cos(np.deg2rad(ang_tol_deg))
    with np.errstate(invalid="ignore", divide="ignore"):
        gu = g / np.maximum(dist, 1e-9)[:, None]
    dot_a = np.einsum("ij,ij->i", odir[a], gu)
    dot_b = np.einsum("ij,ij->i", odir[b], -gu)
    a_is_dot = ulen[a] < DOT_LEN
    b_is_dot = ulen[b] < DOT_LEN
    ok = touching | a_is_dot | (dot_a >= cos_tol)
    ok &= touching | b_is_dot | (dot_b >= cos_tol)

    # touching pairs skip the angle FILTER but keep a small direction
    # tiebreak: at a raster crossing four arm tips meet at one junction
    # point with equal (often zero) distances, and the straight-through
    # pairing must outrank the 90-degree one. The gap vector is degenerate
    # at dist 0, so compare the arms' outward tangents directly - a true
    # continuation has opposite outward directions (dot = -1).
    tang = np.einsum("ij,ij->i", odir[a], odir[b])
    a, b, dist, tang = a[ok], b[ok], dist[ok], tang[ok]
    quiet = touching[ok] | a_is_dot[ok]
    quiet_b = touching[ok] | b_is_dot[ok]
    tie = (1.0 + tang) * 0.3
    score = dist + np.where(quiet, tie, (1.0 - dot_a[ok]) * 10.0) \
                 + np.where(quiet_b, 0.0, (1.0 - dot_b[ok]) * 10.0)

    # greedy mutual matching only ever accepts a pair that is near-best for
    # both endpoints; keeping each endpoint's top few candidates shrinks the
    # python accept-loop from millions to thousands
    def _topk(ids, k=4):
        order = np.lexsort((score, ids))
        ids_sorted = ids[order]
        first = np.searchsorted(ids_sorted, ids_sorted, side="left")
        mask = np.empty(len(ids), dtype=bool)
        mask[order] = (np.arange(len(ids)) - first) < k
        return mask

    keep2 = _topk(a) & _topk(b)
    a, b, score = a[keep2], b[keep2], score[keep2]

    order = np.argsort(score)
    used = np.zeros(2 * n, dtype=bool)
    links = []
    idx_arr = np.asarray(idxs)
    for k in order:
        ea, eb = a[k], b[k]
        if used[ea] or used[eb]:
            continue
        used[ea] = used[eb] = True
        links.append(
            (int(idx_arr[ea // 2]), int(ea % 2), int(idx_arr[eb // 2]), int(eb % 2))
        )
    return links


def _walk_chains(units: list, idxs: list, links: list) -> list:
    """Turn endpoint links into ordered unit sequences (paths/cycles)."""
    nbr = {}
    for i, iend, j, jend in links:
        nbr[(i, iend)] = (j, jend)
        nbr[(j, jend)] = (i, iend)

    linked = set(i for i, _, j, _ in links) | set(j for _, _, j, _ in links)
    chains = []
    visited = set()

    def walk(start_unit, enter_end):
        """Follow links from a unit entered at enter_end; returns ordered
        [(unit_idx, entered_end), ...]."""
        seq = []
        cur, ent = start_unit, enter_end
        while cur is not None and cur not in visited:
            visited.add(cur)
            seq.append((cur, ent))
            exit_end = 1 - ent
            nxt = nbr.get((cur, exit_end))
            if nxt is None:
                break
            cur, ent = nxt
        return seq

    # paths first: start from units with a free endpoint
    for i in idxs:
        if i in visited or i not in linked:
            continue
        free_end = None
        for end in (0, 1):
            if (i, end) not in nbr:
                free_end = end
                break
        if free_end is not None:
            chains.append(walk(i, free_end))
    # remaining linked units are cycles
    for i in idxs:
        if i not in visited and i in linked:
            chains.append(walk(i, 0))
    return chains


def _chain_geometry(units: list, seq: list):
    """Concatenate stroke points along the chain, orienting each stroke by
    its entry end. Returns (pts, dash_lengths, gap_lengths)."""
    pts_parts = []
    dash_lengths = []
    gaps = []
    prev_exit = None
    for unit_idx, ent in seq:
        u = units[unit_idx]
        p = u.pts if ent == 0 else u.pts[::-1]
        if prev_exit is not None:
            gaps.append(float(np.hypot(*(p[0] - prev_exit))))
        pts_parts.append(p)
        dash_lengths.append(u.length)
        prev_exit = p[-1]
    pts = np.vstack(pts_parts)
    return pts, dash_lengths, gaps


def _cluster_1d(values: list, rel=1.55, abs_tol=1.2) -> list:
    """Cluster sorted 1-D lengths; new cluster when the jump is both
    relatively and absolutely significant. Returns list of (mean, count)."""
    if not values:
        return []
    vs = sorted(values)
    clusters = [[vs[0]]]
    for v in vs[1:]:
        m = float(np.mean(clusters[-1]))
        if v > m * rel and v - m > abs_tol:
            clusters.append([v])
        else:
            clusters[-1].append(v)
    return [(float(np.mean(c)), len(c)) for c in clusters]


def _classify_cadence(dash_lengths: list, gaps: list) -> tuple:
    """Return (klass, signature) from a chain's dash length sequence."""
    # clipped end-dashes (a dash cut short where the line terminates) are
    # measurement artifacts, not pattern classes - trim before clustering
    if len(dash_lengths) >= 4:
        med = float(np.median(dash_lengths))
        core = list(dash_lengths)
        if core[0] < 0.6 * med:
            core = core[1:]
        if core and core[-1] < 0.6 * med:
            core = core[:-1]
        dash_lengths = core or dash_lengths
    clusters = _cluster_1d(dash_lengths)
    total = len(dash_lengths)
    # a minor length class must be a real part of the cadence, not a few
    # stray decoration strokes that chained in
    sig_clusters = [(m, n) for m, n in clusters if n / total >= 0.18]
    if not sig_clusters:
        sig_clusters = clusters
    n_classes = len(sig_clusters)
    if n_classes <= 1:
        klass = "dash1"
    elif n_classes == 2:
        klass = "dash2"
    else:
        klass = "dash3"
    gap_med = float(np.median(gaps)) if gaps else 0.0
    sig = " ".join(f"d{m:.1f}" for m, _ in sig_clusters) + f" g{gap_med:.1f}"
    return klass, sig


def build_chains(units: list[StrokeUnit], words: list | None = None) -> list[LineChain]:
    """Main entry: stroke units -> classified line chains.

    words: optional page text words as (x0, y0, x1, y1, text) tuples for
    dash-text-dash bridging.
    """
    by_style = defaultdict(list)
    for idx, u in enumerate(units):
        # near-white strokes are invisible on paper: masking/whiteout, not
        # linework
        if u.color and min(u.color) > 0.92:
            continue
        by_style[_style_key(u)].append(idx)

    chains: list[LineChain] = []
    cid = 0

    for (color, width, layer), idxs in by_style.items():
        idxs = _dedup_twins(units, idxs)
        native_dashed = [i for i in idxs if units[i].dashes and units[i].dashes != "[] 0"]
        plain = [i for i in idxs if i not in set(native_dashed)]

        # 1) natively dashed paths: the dash array is authoritative
        for i in native_dashed:
            u = units[i]
            klass, sig = _classify_native(u.dashes)
            chains.append(
                LineChain(cid, u.pts, klass, color, width, u.length, 0, sig, layer=layer)
            )
            cid += 1

        dash_cand = [i for i in plain if units[i].length <= DASH_MAX_LEN and not units[i].closed]
        solid_cand = [i for i in plain if units[i].length > DASH_MAX_LEN or units[i].closed]

        # stipple textures: fields of thousands of dots (concrete/gravel
        # fill). A dot on a dotted LINE has ~2 close neighbours (prev/next);
        # a texture dot is crowded on all sides. Dropping crowded dots
        # before matching keeps the pair explosion out of the greedy loop.
        dots = [i for i in dash_cand if units[i].length < 2.0]
        if len(dots) > 200:
            from scipy.spatial import cKDTree

            centers = np.array([(units[i].pts[0] + units[i].pts[-1]) / 2 for i in dots])
            counts = cKDTree(centers).query_ball_point(centers, 6.0, return_length=True)
            crowded = {i for i, cnt in zip(dots, counts) if cnt > 5}
            dash_cand = [i for i in dash_cand if i not in crowded]

        # 2) chain the dash candidates. Search radius adapts to the group's
        # typical dash size: contour dashes (~5pt) don't need a 36pt net,
        # and the tighter radius keeps the pair count tractable on sheets
        # with 100k+ dashes.
        if dash_cand:
            med_len = float(np.median([units[i].length for i in dash_cand]))
            gap_max = float(min(GAP_ABS_MAX, max(12.0, 4.0 * med_len)))
        else:
            gap_max = GAP_ABS_MAX
        links = _match_links(units, dash_cand, gap_max, ANG_TOL_DEG)
        seqs = _walk_chains(units, dash_cand, links)
        seqs = _split_irregular_gaps(units, seqs)
        chained_units = set()
        cand_chains = []
        frag_seqs = []
        # on a named, non-textural CAD layer, symbol/text contamination is
        # minimal (text sits on TEXT/LBL layers), so even a 2-dash run is
        # credible linework - building overhangs are many short dashed edges
        lay_up = layer.upper() if layer else ""
        named_line_layer = bool(layer) and not any(
            h in lay_up for h in ("TEXT", "LBL", "HATCH")
        )
        group_min = 2 if named_line_layer else MIN_DASHES
        for seq in seqs:
            if len(seq) < group_min:
                continue
            if len(seq) < MIN_DASHES and not named_line_layer:
                frag_seqs.append(seq)
                continue
            pts, dls, gaps = _chain_geometry(units, seq)
            length = float(sum(dls) + sum(gaps))
            if not gaps or float(np.median(gaps)) < 0.5:
                # touching segments: continuous geometry split across path
                # objects (arrow-decorated flow lines, split polylines) -
                # merge as one solid line
                klass, sig = "solid", "solid"
            else:
                klass, sig = _classify_cadence(dls, gaps)
            cand_chains.append((seq, LineChain(cid, pts, klass, color, width, length, len(seq), sig, layer=layer, ink=float(sum(dls))), gaps))
            cid += 1

        group_lcs = []
        min_extent = 20.0 if named_line_layer else MIN_EXTENT
        for seq, lc, _gaps in _prune_junk(cand_chains, units, dash_cand,
                                          min_extent=min_extent):
            chained_units.update(i for i, _ in seq)
            group_lcs.append((lc, [units[i].length for i, _ in seq]))

        # rescue pass: a 2-3 dash run is unclassifiable alone (MIN_DASHES
        # guards against symbol fragments), but when its cadence matches a
        # style already established in this group - short dashed edges of a
        # building overhang, stub ends of utility runs - the longer chains
        # vouch for it
        templates = [
            (float(np.median(dls)), _tpl_gap(lc))
            for lc, dls in group_lcs
            if lc.klass.startswith("dash") and lc.n_dashes >= 6
        ]
        for seq in frag_seqs:
            if not templates:
                break
            pts, dls, gaps = _chain_geometry(units, seq)
            if not gaps:
                continue
            dl_med, gap_med = float(np.median(dls)), float(np.median(gaps))
            if gap_med < 0.5:
                continue  # touching fragments belong to the compound pass
            for tdl, tgap in templates:
                if abs(dl_med - tdl) <= max(0.3 * tdl, 1.5) \
                        and abs(gap_med - tgap) <= max(0.4 * tgap, 1.5):
                    length = float(sum(dls) + sum(gaps))
                    klass, sig = _classify_cadence(dls, gaps)
                    group_lcs.append((
                        LineChain(cid, pts, klass, color, width, length,
                                  len(seq), sig, layer=layer, ink=float(sum(dls))),
                        dls,
                    ))
                    cid += 1
                    chained_units.update(i for i, _ in seq)
                    break

        # 3) leftovers: long strokes are solid candidates, stray dots may be
        # part of compound patterns
        solid_pool = solid_cand + [
            i for i in dash_cand
            if i not in chained_units and units[i].length > SOLID_MIN_LEN
        ]
        solid_pool = [i for i in solid_pool if units[i].length >= SOLID_MIN_LEN]
        stray_dots = [
            i for i in dash_cand
            if i not in chained_units and units[i].length < 2.0
        ]

        # 4) compound merge: long-dash patterns (dashes beyond DASH_MAX_LEN
        # stranded as solids), dash-dot-dot property lines, chains broken by
        # junk. Joins collinear continuations of chains/solids/dots and
        # re-reads the cadence off the merged result.
        merged, cid = _compound_merge(
            group_lcs, solid_pool, stray_dots, units, color, width, layer, cid
        )
        chains.extend(merged)

    chains = _stitch_across_styles(chains)

    if words:
        chains = _bridge_text(chains, words)

    # chains on annotation layers (hatch fills, text, labels) are real
    # geometry but not takeoff linework; demote so they can't pollute the
    # dashed/solid classes - the review UI shows them as their own group
    for c in chains:
        lay = (c.layer or "").upper()
        if lay and any(h in lay for h in ("TEXT", "-LBL", "HATCH")):
            # firms put real linework on "TEXT" layers (IMEG's drainage
            # boundaries live on P6-TEXT-STORM). A long structured chain is
            # linework wherever it lives; only short/scribbly geometry on
            # annotation layers is actually annotation.
            bbox = c.pts.max(axis=0) - c.pts.min(axis=0)
            if float(np.hypot(*bbox)) < 300.0:
                c.klass = "annotation"

    # pages without layer info can't use the demotion above; there, chains
    # living inside text boxes are exploded-glyph junk
    if words:
        _demote_text_chains(chains, words)

    _assign_styles(chains)
    return chains


def _demote_text_chains(chains: list, words: list, frac: float = 0.6) -> None:
    """Demote un-layered dashed chains whose geometry mostly lies inside
    word boxes: exploded text traced into chains. Judged purely by in-box
    fraction - a real line passing through a label scores low, while a
    text-plus-leader tangle scores high no matter how far it sprawls."""
    from scipy.spatial import cKDTree

    boxes = [w for w in words if 0 < len(str(w[4]).strip()) <= 24]
    if not boxes:
        return
    centers = np.array([[(w[0] + w[2]) / 2, (w[1] + w[3]) / 2] for w in boxes])
    half = np.array([[(w[2] - w[0]) / 2 + 1.5, (w[3] - w[1]) / 2 + 1.5]
                     for w in boxes])
    tree = cKDTree(centers)
    rad = float(np.hypot(*half.max(axis=0))) + 1.0

    for c in chains:
        if c.layer or c.klass in ("annotation", "solid"):
            continue
        samples, _ = _sample_polyline(np.asarray(c.pts), step=6.0, max_n=60)
        if len(samples) == 0:
            continue
        inside = 0
        for p in samples:
            for j in tree.query_ball_point(p, rad):
                if (abs(p[0] - centers[j][0]) <= half[j][0]
                        and abs(p[1] - centers[j][1]) <= half[j][1]):
                    inside += 1
                    break
        if inside / len(samples) >= frac:
            c.klass = "annotation"


def _tpl_gap(lc) -> float:
    """Median gap of a chain, recovered from its signature ('... g9.0')."""
    try:
        return float(lc.dash_signature.rsplit("g", 1)[1])
    except (IndexError, ValueError):
        return 0.0


def _dedup_twins(units: list, idxs: list) -> list:
    """CAD simulates bold lines by drawing each stroke TWICE, offset by a
    fraction of a point. The twin's endpoints sit ~0.5pt from the
    original's, so the matcher links twins to each other instead of
    chaining along the line - Oncor's dash-dot-dot property ring dies this
    way. Keep one of each near-identical pair."""
    if len(idxs) < 2:
        return idxs
    from scipy.spatial import cKDTree

    mids = np.array([(units[i].pts[0] + units[i].pts[-1]) / 2 for i in idxs])
    tree = cKDTree(mids)
    pairs = tree.query_pairs(2.6, output_type="ndarray")
    if len(pairs) == 0:
        return idxs
    drop = set()
    for a, b in pairs:
        if a in drop or b in drop:
            continue
        ua, ub = units[idxs[a]], units[idxs[b]]
        if abs(ua.length - ub.length) > max(0.6, 0.08 * max(ua.length, ub.length)):
            continue
        da, db = ua.direction(), ub.direction()
        if abs(float(da @ db)) < 0.996:  # within ~5 degrees (either sense)
            continue
        # both endpoints must coincide (same or reversed order): a twin is
        # the SAME stroke drawn again, not merely a nearby parallel one
        d_same = max(float(np.hypot(*(ua.pts[0] - ub.pts[0]))),
                     float(np.hypot(*(ua.pts[-1] - ub.pts[-1]))))
        d_rev = max(float(np.hypot(*(ua.pts[0] - ub.pts[-1]))),
                    float(np.hypot(*(ua.pts[-1] - ub.pts[0]))))
        if min(d_same, d_rev) > 2.4:
            continue
        drop.add(b)
    return [i for k, i in enumerate(idxs) if k not in drop]


def _stitch_across_styles(chains: list) -> list:
    """Rejoin a line that the drawing itself splits into slightly different
    colors/opacities (screened halves, faded plots): per-style grouping
    breaks it into chains that end nose-to-nose. Stitch only when the join
    is unambiguous - endpoints nearly touching, tangents collinear, same
    weight class, same class family - so unrelated features can't fuse."""
    cands = [c for c in chains
             if c.klass not in ("annotation",) and len(c.pts) >= 2]
    if len(cands) < 2:
        return chains
    links = _match_links(cands, list(range(len(cands))), 12.0, 22.0)
    ok_links = []
    for i, iend, j, jend in links:
        a, b = cands[i], cands[j]
        both_dash = a.klass.startswith("dash") and b.klass.startswith("dash")
        both_solid = a.klass == "solid" and b.klass == "solid"
        if not (both_dash or both_solid):
            continue
        if _weight_class(a.width) != _weight_class(b.width):
            continue
        ok_links.append((i, iend, j, jend))
    if not ok_links:
        return chains
    consumed = set()
    out = []
    for seq in _walk_chains(cands, list(range(len(cands))), ok_links):
        if len(seq) < 2:
            continue
        pts, member_lens, gaps = _chain_geometry(cands, seq)
        base = max((cands[k] for k, _ in seq), key=lambda c: c.length)
        base.pts = pts
        base.length = float(sum(member_lens) + sum(gaps))
        base.ink = float(sum((cands[k].ink or cands[k].length) for k, _ in seq))
        base.n_dashes = sum(cands[k].n_dashes for k, _ in seq)
        for k, _ in seq:
            if cands[k] is not base:
                consumed.add(id(cands[k]))
        out.append(base)
    return [c for c in chains if id(c) not in consumed]


def _split_irregular_gaps(units: list, seqs: list) -> list:
    """A dash pattern repeats like a metronome. A single gap far larger
    than the chain's own median is not part of the pattern - it is a false
    bridge onto text, a leader, or another line, and it overstates footage.
    Split there; legitimate joins across text come back later through the
    (word-verified) dash-text bridge."""
    out = []
    for seq in seqs:
        if len(seq) < 4:
            out.append(seq)
            continue
        _, _, gaps = _chain_geometry(units, seq)
        med = float(np.median(gaps)) if gaps else 0.0
        limit = max(2.5 * med, med + 18.0)
        cur = [seq[0]]
        for k, g in enumerate(gaps):
            if g > limit:
                out.append(cur)
                cur = []
            cur.append(seq[k + 1])
        out.append(cur)
    return [q for q in out if q]


def _compound_merge(group_lcs, solid_pool, stray_dots, units, color, width,
                    layer, cid):
    """Second-pass merge within one style group.

    First-pass chaining caps dash length at DASH_MAX_LEN, so patterns with
    longer dashes (heavy property lines run 100-250pt per dash) arrive here
    as stranded solids, and their separator dots arrive unchained. This pass
    links chains, open solids, and stray dots that continue each other
    collinearly, then classifies the merged cadence.

    Guard rails: a merged component only stands if it contains a dot or an
    already-dashed member, or - for pure solid+solid merges - if its gaps
    repeat like a metronome. Curbs broken at driveways have irregular gaps
    and stay separate solids.

    Returns (all chains to emit for this group, next cid).
    """
    pseudos = []
    meta = []  # ("chain", (LineChain, dls)) | ("solid", i) | ("dot", i)
    closed_solids = []
    for lc, dls in group_lcs:
        pseudos.append(lc)
        meta.append(("chain", (lc, dls)))
    for i in solid_pool:
        if units[i].closed:
            closed_solids.append(i)  # closed shapes never continue a line
        else:
            pseudos.append(units[i])
            meta.append(("solid", i))
    for i in stray_dots:
        pseudos.append(units[i])
        meta.append(("dot", i))

    out = []
    consumed = set()
    if len(pseudos) >= 2:
        links = _match_links(pseudos, list(range(len(pseudos))), GAP_ABS_MAX, 20.0)
        for seq in _walk_chains(pseudos, list(range(len(pseudos))), links):
            if len(seq) < 2:
                continue
            kinds = [meta[k][0] for k, _ in seq]
            has_dot = "dot" in kinds
            has_dashed = any(
                meta[k][0] == "chain" and meta[k][1][0].klass.startswith("dash")
                for k, _ in seq
            )
            pts, member_lens, gaps = _chain_geometry(pseudos, seq)
            total_len = float(sum(member_lens) + sum(gaps))
            # a solid can only extend a dashed chain if it is plausibly one
            # of the pattern's own long dashes - not a curb that happens to
            # line up with a contour
            chain_dash_max = max(
                (max(m[1][1]) for k, _ in seq if (m := meta[k])[0] == "chain" and m[1][1]),
                default=None,
            )
            solid_max = max(
                (units[m[1]].length for k, _ in seq if (m := meta[k])[0] == "solid"),
                default=None,
            )
            if chain_dash_max is not None and solid_max is not None \
                    and solid_max > 1.5 * chain_dash_max + 20.0:
                continue
            if not (has_dot or has_dashed):
                g = np.asarray(gaps)
                # tiny collinear breaks are fragmentation (raster junction
                # splits, text collisions), not a dash pattern - repair them
                tiny_repair = len(g) >= 1 and float(np.median(g)) <= 6.0
                # otherwise pure solids merge only on a strictly regular
                # cadence (a real long-dash line)
                regular = len(g) >= 2 and g.mean() >= 2.0 \
                    and g.std() / max(g.mean(), 1e-6) <= 0.35 \
                    and float(np.median(g)) <= 30.0
                if not (tiny_repair or regular):
                    continue
                if tiny_repair and not regular:
                    # merged geometry, but it is a continuous line, not a
                    # cadence
                    pts_len = float(sum(member_lens) + sum(gaps))
                    out.append(LineChain(cid, pts, "solid", color, width,
                                         pts_len, len(seq), "solid",
                                         layer=layer,
                                         ink=float(sum(member_lens))))
                    cid += 1
                    consumed.update(k for k, _ in seq)
                    continue
            if total_len < 60.0:
                continue
            # cadence from member dash data: chains contribute their dash
            # lengths, solids and dots their own length
            dls = []
            n_dashes = 0
            for k, _ in seq:
                kind, payload = meta[k]
                if kind == "chain":
                    dls.extend(payload[1])
                    n_dashes += payload[0].n_dashes
                else:
                    dls.append(units[payload].length)
                    n_dashes += 1
            klass, sig = _classify_cadence(dls, [g for g in gaps if g > 0.5] or gaps)
            out.append(LineChain(cid, pts, klass, color, width, total_len,
                                 n_dashes, sig, layer=layer,
                                 ink=float(sum(member_lens))))
            cid += 1
            consumed.update(k for k, _ in seq)

    # unconsumed members pass through unchanged
    for k, (kind, payload) in enumerate(meta):
        if k in consumed:
            continue
        if kind == "chain":
            out.append(payload[0])
        elif kind == "solid":
            i = payload
            out.append(LineChain(cid, units[i].pts, "solid", color, width,
                                 units[i].length, 1, "solid", layer=layer))
            cid += 1
        # unconsumed stray dots stay dropped (symbol specks)
    for i in closed_solids:
        out.append(LineChain(cid, units[i].pts, "solid", color, width,
                             units[i].length, 1, "solid", layer=layer))
        cid += 1
    return out, cid


# --- junk pruning: hatch fields and exploded text glyphs ------------------

# A chain spanning less than this (bbox diagonal, pt) is a symbol/glyph
# cluster, not a line feature.
MIN_EXTENT = 36.0
# length/extent above this means the chain folds back on itself (text
# scribble); real dashed lines, even curved contours, stay well below.
MAX_WIGGLE = 3.5
# Radius (pt) for the parallel-neighbor hatch test. Hatch tick spacing is
# typically 3-6pt; parallel *line* features (ditch double-dash, contours)
# almost always sit further apart.
HATCH_RADIUS = 5.5


def _prune_junk(cand_chains: list, units: list, dash_cand: list,
                min_extent: float = MIN_EXTENT) -> list:
    """Filter candidate dashed chains that are actually hatching or exploded
    text. Returns the surviving (seq, LineChain) pairs."""
    if not cand_chains:
        return []
    from scipy.spatial import cKDTree

    centers = np.array([(units[i].pts[0] + units[i].pts[-1]) / 2 for i in dash_cand])
    dirs = np.array([units[i].direction() for i in dash_cand])
    row_of = {i: k for k, i in enumerate(dash_cand)}
    tree = cKDTree(centers)

    kept = []
    for seq, lc, gaps in cand_chains:
        bbox = lc.pts.max(axis=0) - lc.pts.min(axis=0)
        extent = float(np.hypot(*bbox))
        if extent < min_extent:
            continue
        wiggle = lc.length / max(extent, 1e-6)
        if wiggle > MAX_WIGGLE or (extent < 80.0 and wiggle > 2.2):
            continue

        # exploded text: a real dash pattern repeats like a metronome
        # (consistent gaps, smooth heading); glyph-stroke chains have
        # chaotic gaps AND sharp heading swings between strokes.
        if len(gaps) >= 2:
            g = np.asarray(gaps)
            gap_cv = float(g.std() / max(g.mean(), 1e-6))
            heads = []
            for i, ent in seq:
                u = units[i]
                d = u.direction() if ent == 0 else -u.direction()
                heads.append(d)
            heads = np.asarray(heads)
            dots = np.einsum("ij,ij->i", heads[:-1], heads[1:]).clip(-1, 1)
            mean_turn = float(np.degrees(np.arccos(dots)).mean())
            if gap_cv > 0.85 and mean_turn > 30.0:
                continue
            # a SHORT chain that keeps changing heading is a glyph tangle
            # or leader scribble, never a line: real short dash runs are
            # straight. (Long chains may curve - contours - so this only
            # applies to small-n chains.)
            if len(seq) <= 7 and mean_turn > 32.0:
                continue

        # multi-length cadences must actually repeat - but the repeat
        # PERIOD is not the number of length classes: dash-dot-dot has two
        # classes and period three (long, short, short). Try small periods
        # and accept the best.
        dls = [units[i].length for i, _ in seq]
        if len(dls) >= 6:
            sig_clusters = [(m, cnt) for m, cnt in _cluster_1d(dls)
                            if cnt / len(dls) >= 0.12]
            if len(sig_clusters) >= 2:
                means = np.array([m for m, _ in sig_clusters])
                ids = np.argmin(np.abs(np.asarray(dls)[:, None] - means[None, :]), axis=1)
                best = 0.0
                for q in (2, 3, 4):
                    if len(ids) > q:
                        best = max(best, float((ids[:-q] == ids[q:]).mean()))
                if best < 0.55:
                    continue

        member = set(row_of[i] for i, _ in seq)
        samples, sdirs = _sample_polyline(lc.pts, step=15.0, max_n=60)
        if len(samples) == 0:
            continue
        near = tree.query_ball_point(samples, HATCH_RADIUS)
        n_left = n_right = n_cross = 0
        n_s = len(samples)
        for s in range(n_s):
            left = right = cross = False
            d = sdirs[s]
            for r in near[s]:
                if r in member:
                    continue
                dot = abs(float(d @ dirs[r]))
                if dot > 0.87:
                    rel = centers[r] - samples[s]
                    if d[0] * rel[1] - d[1] * rel[0] > 0:
                        left = True
                    else:
                        right = True
                elif dot < 0.5:
                    cross = True
            n_left += left
            n_right += right
            n_cross += cross
        # hatch field: parallel strokes hugging the chain on BOTH sides
        # (a lone parallel partner - e.g. a double-line ditch - is fine),
        # or dense crossing strokes (crosshatch).
        if min(n_left, n_right) / n_s > 0.35 or n_cross / n_s > 0.5:
            continue
        kept.append((seq, lc, gaps))
    return kept


def _sample_polyline(pts: np.ndarray, step: float, max_n: int):
    """Evenly spaced samples along a polyline with local directions."""
    d = np.diff(pts, axis=0)
    seg = np.hypot(d[:, 0], d[:, 1])
    cum = np.concatenate([[0.0], np.cumsum(seg)])
    total = cum[-1]
    if total < 1e-6:
        return np.empty((0, 2)), np.empty((0, 2))
    n = int(min(max_n, max(3, total // step)))
    at = np.linspace(0, total, n)
    xs = np.interp(at, cum, pts[:, 0])
    ys = np.interp(at, cum, pts[:, 1])
    samples = np.column_stack([xs, ys])
    grad = np.gradient(samples, axis=0)
    norms = np.hypot(grad[:, 0], grad[:, 1])
    norms[norms < 1e-9] = 1.0
    return samples, grad / norms[:, None]


def _classify_native(dash_str: str) -> tuple:
    """Classify a PDF dash array like '[ 6 3 1 3 ] 0'."""
    try:
        inner = dash_str[dash_str.index("[") + 1 : dash_str.index("]")]
        arr = [float(x) for x in inner.split()]
    except (ValueError, IndexError):
        arr = []
    if not arr:
        return "solid", "solid"
    dashes = arr[0::2]
    n = len(set(round(d, 1) for d in dashes if d > 0))
    klass = {0: "dash1", 1: "dash1", 2: "dash2"}.get(n, "dash3")
    sig = "native " + " ".join(f"{x:g}" for x in arr)
    return klass, sig


def _bridge_text(chains: list, words: list) -> list:
    """Merge dashed chains separated by an inline text label (e.g. - SD -).

    Indexed: chain endpoints go into a KDTree, and only chain pairs that
    both have an endpoint near the same short word are corridor-tested.
    """
    from scipy.spatial import cKDTree

    TEXT_GAP_MAX = 90.0
    words = [w for w in words if 0 < len(str(w[4]).strip()) <= 6]
    if not words:
        return chains
    wc = np.array([[(w[0] + w[2]) / 2, (w[1] + w[3]) / 2] for w in words])

    merged_away = set()
    # iterate to closure: A + B may then bridge to C
    changed = True
    while changed:
        changed = False
        dashed = [c for c in chains
                  if c.klass.startswith("dash") and c.chain_id not in merged_away]
        if len(dashed) < 2:
            break
        eps = np.array([c.pts[e] for c in dashed for e in (0, -1)])
        tree = cKDTree(eps)
        near_word = tree.query_ball_point(wc, TEXT_GAP_MAX)
        for w_idx, ep_idxs in enumerate(near_word):
            chain_set = {}
            for k in ep_idxs:
                c = dashed[k // 2]
                if c.chain_id not in merged_away:
                    chain_set[c.chain_id] = c
            cs = list(chain_set.values())
            for ai in range(len(cs)):
                a = cs[ai]
                if a.chain_id in merged_away:
                    continue
                for bi in range(ai + 1, len(cs)):
                    b = cs[bi]
                    if b.chain_id in merged_away:
                        continue
                    if a.color != b.color or abs(a.width - b.width) > 0.15 \
                            or a.layer != b.layer:
                        continue
                    # only bridge lines of the SAME pattern: avg dash
                    # lengths must be comparable, or the "bridge" is a jump
                    # onto an unrelated feature that happens to sit past a
                    # word
                    da_len = (a.ink or a.length) / max(a.n_dashes, 1)
                    db_len = (b.ink or b.length) / max(b.n_dashes, 1)
                    if max(da_len, db_len) > 1.8 * min(da_len, db_len) + 3.0:
                        continue
                    hit = _text_between(a, b, [words[w_idx]], TEXT_GAP_MAX)
                    if hit is None:
                        continue
                    text, a_end, b_end = hit
                    _merge_into(a, b, a_end, b_end, text)
                    merged_away.add(b.chain_id)
                    changed = True
        if changed:
            continue
    out = [c for c in chains if c.chain_id not in merged_away]
    for c in out:
        if not (c.label_texts and c.klass.startswith("dash")):
            continue
        # a TRUE dash-text pattern repeats the same short token inline
        # (- SD - SD -). A line that merely crosses one or two arbitrary
        # labels keeps its base pattern class - the bridge just joins it.
        toks = [t.upper() for t in c.label_texts]
        top, n_top = Counter(toks).most_common(1)[0]
        # cadence test: the token must recur as part of the repeating
        # pattern (at least every ~400pt), not just appear where the line
        # happens to cross stray annotations
        if n_top >= 3 and len(top) <= 4 and c.length / n_top <= 400.0:
            c.klass = "dash-text"
    return out


def _text_between(a, b, words, gap_max):
    """If a word sits in the corridor between an endpoint of a and an
    endpoint of b, return (text, a_end, b_end)."""
    best = None
    for a_end, pa in ((0, a.pts[0]), (1, a.pts[-1])):
        for b_end, pb in ((0, b.pts[0]), (1, b.pts[-1])):
            g = pb - pa
            dist = float(np.hypot(*g))
            if dist < 4.0 or dist > gap_max:
                continue
            # endpoints must face each other along their line directions
            da = a.pts[-1] - a.pts[0] if a_end == 1 else a.pts[0] - a.pts[-1]
            na = np.hypot(*da)
            if na > 1e-9 and float(np.dot(da / na, g / dist)) < 0.71:
                continue
            for w in words:
                cx, cy = (w[0] + w[2]) / 2, (w[1] + w[3]) / 2
                h = max(w[3] - w[1], 4.0)
                # project word center on the gap segment
                t = ((cx - pa[0]) * g[0] + (cy - pa[1]) * g[1]) / (dist * dist)
                if t < -0.1 or t > 1.1:
                    continue
                px, py = pa[0] + t * g[0], pa[1] + t * g[1]
                off = float(np.hypot(cx - px, cy - py))
                if off <= 1.6 * h:
                    cand = (dist, str(w[4]).strip(), a_end, b_end)
                    if best is None or cand[0] < best[0]:
                        best = cand
    if best is None:
        return None
    return best[1], best[2], best[3]


def _merge_into(a, b, a_end, b_end, text):
    a_pts = a.pts if a_end == 1 else a.pts[::-1]
    b_pts = b.pts if b_end == 0 else b.pts[::-1]
    a.pts = np.vstack([a_pts, b_pts])
    a.length += b.length + float(np.hypot(*(b_pts[0] - a_pts[-1])))
    a.ink = (a.ink or 0.0) + (b.ink or b.length)
    a.n_dashes += b.n_dashes
    if text:
        a.label_texts.append(text)  # duplicates kept: repetition is signal
    a.label_texts.extend(b.label_texts)


def _assign_styles(chains: list) -> None:
    """Group chains into user-facing line styles: same class + color + weight
    class + similar signature -> one style id, ready for the classify/approve
    UI. Buckets are deliberately coarse: the reviewer wants 'storm drain
    dashed' once, not five widths of it - and exact width/signature stay on
    every chain for anyone who needs them."""
    styles = {}
    for c in chains:
        key = (c.klass, c.color, _weight_class(c.width), c.layer,
               _sig_bucket(c.dash_signature))
        if key not in styles:
            styles[key] = len(styles)
        c.style_id = styles[key]

    # roll one-off short chains into a per-class misc bucket: 58 singleton
    # styles is review noise, and a lone 100pt oddball is something the
    # reviewer excludes anyway
    by_style = defaultdict(list)
    for c in chains:
        by_style[c.style_id].append(c)
    misc_ids: dict = {}
    next_id = len(styles)
    for sid, cs in by_style.items():
        if len(cs) == 1 and cs[0].length < 250.0 and not cs[0].layer:
            mkey = (cs[0].klass, _weight_class(cs[0].width))
            if mkey not in misc_ids:
                misc_ids[mkey] = next_id
                next_id += 1
            cs[0].style_id = misc_ids[mkey]
            cs[0].dash_signature = "misc"


def _weight_class(w: float) -> int:
    """hairline / light / medium / heavy / extra - the distinctions a legend
    actually draws (thin vs thick dashes), robust to plot-driver jitter."""
    for i, limit in enumerate((0.35, 0.75, 1.5, 2.6)):
        if w <= limit:
            return i
    return 4


def _sig_bucket(sig: str) -> str:
    """Quantize a signature onto a geometric grid so near-identical
    cadences share a style: ~30% relative bins, so a 5pt dash groups at
    +/-1pt and a 170pt dash at +/-40pt."""
    parts = []
    for tok in sig.split():
        if tok[0] in "dg":
            try:
                v = float(tok[1:])
                if v < 1.0:
                    parts.append(f"{tok[0]}0")
                else:
                    q = round(np.log(v) / np.log(1.32))
                    parts.append(f"{tok[0]}{1.32 ** q:.0f}")
            except ValueError:
                parts.append(tok)
        else:
            parts.append(tok)
    return " ".join(parts)
