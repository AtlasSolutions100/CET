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

import re
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
    template: list = None  # one period as [dash, gap, dash, gap, ...] -
                           # the RENDERABLE truth. The signature compresses
                           # to length-classes (d9 d45 g9), which cannot say
                           # long+TWO shorts vs long+one short; drawing from
                           # it renders the wrong pattern.

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
            "template": [round(float(v), 2) for v in self.template]
            if self.template else None,
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

    # stable sort: equal-score candidates accept in pair-index order, never
    # in whatever tie order the sort algorithm happens to emit
    order = np.argsort(score, kind="stable")
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


def _dash_template(dls: list, gaps: list) -> list | None:
    """One period of the pattern as [dash, gap, dash, gap, ...].

    Finds the smallest repeat period (1..4 marks) in the ORDERED dash
    sequence, then medians each position over its repeats. Returns None
    when nothing periodic emerges (solids, irregular chains)."""
    if not dls or not gaps or len(dls) < 4:
        return None
    d = np.asarray(dls[1:-1] if len(dls) >= 6 else dls, dtype=float)
    g = np.asarray(gaps, dtype=float)
    if len(d) < 4:
        return None
    for q in (1, 2, 3, 4):
        if len(d) < 2 * q:
            break
        ok = True
        for off in range(q):
            col = d[off::q]
            if len(col) < 2:
                ok = False
                break
            m = float(np.median(col))
            if m > 0 and float(np.abs(col - m).mean()) > max(0.35 * m, 2.5):
                ok = False
                break
        if not ok:
            continue
        out = []
        for off in range(q):
            out.append(float(np.median(d[off::q])))
            gc = g[off::q]
            out.append(float(np.median(gc)) if len(gc) else float(np.median(g)))
        if all(v > 0.2 for v in out):
            return [round(v, 2) for v in out]
    return None


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


# CAD layer-name tokens that mark annotation content (text, labels,
# leaders, dimensions). Token-bounded so xref prefixes and words like
# SEDIMENT can't match; tested against the LEAF layer name only, because
# xref path prefixes (e.g. "SITE-NOTES|P1-FENCE") describe the source
# drawing, not the stroke. Convention: content-based layer naming is
# standard CAD practice (AIA-style *-ANNO-*/-TEXT); audited across the
# Plans corpus 2026-08-19: all 61 matching leaf names were genuinely
# annotation layers.
_ANNO_LAYER = re.compile(
    r"(?:^|[^A-Za-z0-9])(TEXT|TXT|LBL|ANNO|NOTES?|CALLOUT|LDR|LEADER|DIMS?)"
    r"(?=[^A-Za-z0-9]|$)", re.I)


def _leader_annotation_units(units: list) -> set:
    """Indices of leader/callout strokes on annotation-named layers.

    A leader is a straight or gently arced stroke that anchors at its
    label text. On these CAD exports the text is exploded to vector
    outlines on the SAME layer, so the anchor test is geometric: >=3
    glyph-like units within 18pt of either endpoint.

    Why unit-level, pre-chain: the post-chain demotion below caps at a
    300pt bbox to protect real linework that firms park on TEXT layers
    (IMEG's drainage boundary on P6-TEXT-STORM). Leaders defeat that cap
    by CHAINING to each other and to glyphs at callout hubs until the
    tangle spans the sheet. Removing the leader units before pooling
    breaks the tangles at their connectors.

    Every constant measured 2026-08-19 on GCHC North / C4.1 / C6.0
    (leader layers) vs C8.0/C8.1 P6-TEXT-STORM (boundary linework on a
    TEXT layer, the keep case):
      - glyph unit: bbox diag <=15, len <=40, folded (len/diag >=1.25)
        or tiny (diag <=6) or closed - _glyph_blobs lineage
      - leader shape: 15 <= len <= 600; straight (len/chord <= 1.10,
        <=5 vertices) or arc (1.10 < len/chord <= 1.60)
      - anchor: >=3 same-layer glyphs within 18pt of an endpoint.
        Same-layer tree, NOT a cross-layer union: union costs 8/244
        false demotions on the C8.0 boundary (other layers' station
        text near the path); same-layer scores 0/244 there while
        catching 203/205 (GCHC C-TOPO-TEXT), 405/433 + 5/5 arcs
        (C4.1 O-SURFACE-LBL-FG), 27/33 (C6.0 PIPE-LBL).
    """
    by_layer = defaultdict(list)
    for i, u in enumerate(units):
        leaf = (u.layer or "").split("|")[-1]
        if leaf and _ANNO_LAYER.search(leaf):
            by_layer[u.layer].append(i)
    if not by_layer:
        return set()
    from scipy.spatial import cKDTree

    leaders: set = set()
    for lay in sorted(by_layer):
        idxs = by_layer[lay]
        glyph_pts = []
        for i in idxs:
            u = units[i]
            bb = u.pts.max(axis=0) - u.pts.min(axis=0)
            diag = float(np.hypot(*bb))
            fold = u.length / diag if diag > 1e-6 else 9.9
            if diag <= 15.0 and u.length <= 40.0 and (
                    fold >= 1.25 or diag <= 6.0 or u.closed):
                glyph_pts.append((u.pts[0] + u.pts[-1]) / 2)
        if len(glyph_pts) < 3:
            continue
        tree = cKDTree(np.asarray(glyph_pts))
        for i in idxs:
            u = units[i]
            if u.closed or len(u.pts) < 2 or not (15.0 <= u.length <= 600.0):
                continue
            chord = float(np.hypot(*(u.pts[-1] - u.pts[0])))
            if chord < 1e-6:
                continue
            r = u.length / chord
            if not ((r <= 1.10 and len(u.pts) <= 5) or r <= 1.60):
                continue
            for e in (u.pts[0], u.pts[-1]):
                if len(tree.query_ball_point(e, 18.0)) >= 3:
                    leaders.add(i)
                    break
    return leaders


def build_chains(units: list[StrokeUnit], words: list | None = None) -> list[LineChain]:
    """Main entry: stroke units -> classified line chains.

    words: optional page text words as (x0, y0, x1, y1, text) tuples for
    dash-text-dash bridging.
    """
    units = list(units)  # local copy: X-mark repair appends synthetic units
    units = _merge_twin_strokes(units)
    leader_idx = _leader_annotation_units(units)
    by_style = defaultdict(list)
    for idx, u in enumerate(units):
        if idx in leader_idx:
            continue  # emitted as annotation chains after the style loop
        # near-white strokes are invisible on paper: masking/whiteout, not
        # linework
        if u.color and min(u.color) > 0.92 and not getattr(u, 'on_fill', False):
            continue
        by_style[_style_key(u)].append(idx)

    chains: list[LineChain] = []
    cid = 0
    glyph_blobs: list = []

    for (color, width, layer), idxs in by_style.items():
        # twin removal happens globally in _merge_twin_strokes above; the
        # old per-group _dedup_twins pass is a strict subset of it and was
        # 17s of a 25s build on textured sheets
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
        _glyphs, _blobs = _glyph_blobs(units, dash_cand)
        if _glyphs:
            dash_cand = [i for i in dash_cand if i not in _glyphs]
            glyph_blobs.extend(_blobs)
        dash_cand = _strip_x_marks(units, dash_cand)
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
            lc_new = LineChain(cid, pts, klass, color, width, length,
                               len(seq), sig, layer=layer,
                               ink=float(sum(dls)))
            lc_new.template = _dash_template(dls, gaps)
            cand_chains.append((seq, lc_new, gaps))
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
        _pickup_end_marks(merged, units, dash_cand, chained_units)
        chains.extend(merged)

    chains = _stitch_across_styles(chains)
    chains = _join_chain_ends(chains)

    if words:
        chains = _bridge_text(chains, words)

    # leader/callout strokes pulled out before pooling: emit them as their
    # own annotation chains so the reviewer can still toggle them visible.
    # One chain per stroke - chaining leaders together is exactly the weld
    # this exists to prevent.
    for i in sorted(leader_idx):
        u = units[i]
        chains.append(LineChain(cid, u.pts, "annotation", u.color, u.width,
                                u.length, 0, "leader", layer=u.layer))
        cid += 1

    # structural grid lines (centerline dashes anchored at lettered grid
    # bubbles) are annotation, not takeoff linework
    _grid_annotation(chains, units)

    # exploded-glyph labels drawn inline (no text layer to bridge across)
    _mark_glyph_text_chains(chains, glyph_blobs)

    # chains on annotation layers (hatch fills, text, labels) are real
    # geometry but not takeoff linework; demote so they can't pollute the
    # dashed/solid classes - the review UI shows them as their own group
    for c in chains:
        lay = (c.layer or "").upper()
        if not lay:
            continue
        # "E1-MISC (NO HATCH)" is a layer for geometry that is explicitly
        # NOT hatch - a plain substring test demotes real linework on it
        is_hatch = "HATCH" in lay and "NO HATCH" not in lay \
            and "NOHATCH" not in lay
        if is_hatch:
            # a HATCH layer is decoration at ANY size. Solid hatch is often
            # exported as a triangulated mesh of hairline closed triangles,
            # and those tile an area, so the mesh spans hundreds of pt and
            # escapes the size gate below - emitting fill as solid linework
            # with wholly phantom footage.
            c.klass = "annotation"
        elif any(h in lay for h in ("TEXT", "-LBL")) \
                or lay.split("|")[-1].endswith("-CORR"):
            # leaf -CORR = corridor surface texture (the xref PREFIX X-CORR
            # carries real centerlines, hence the leaf test - same rule the
            # metric uses in eval_layers.is_textural)
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


def _grid_annotation(chains: list, units: list) -> None:
    """Structural grid lines -> annotation.

    A grid axis is a long straight dashed centerline that TERMINATES at a
    lettered grid bubble (small perfect circle with a glyph inside). Grid
    ink was landing in wall-family style pools and getting boxed as
    objects (Belle Structural p2, grid D boxed as a shear wall).

    Measured on Belle Structural p2 (2026-08-19): bubbles are perfect
    circles (len/(pi*d) = 1.00) of uniform d 26.9-28.7 pt, >=40 per
    sheet, mid-sheet as well as margins (multiple sub-plans per sheet,
    so no margin gate). Grid chain fragments run straight (lateral
    wander <= 5 pt) but len/chord reads 1.27 because dash-dot paths
    zigzag, so straightness is tested laterally.

    The keep-case is a dashed utility run THROUGH a lettered manhole
    circle (sewer/storm sheets): the pipe CONTINUES collinearly beyond
    the circle, a grid line does not - the terminal test below. A
    line-end cleanout with a lettered circle would still demote its last
    segment; accepted, reviewer-recoverable.
    """
    dash_chains = [c for c in chains
                   if c.klass.startswith("dash") and c.klass != "dash-text"
                   and len(c.pts) >= 2 and c.length >= 80.0]
    if not dash_chains:
        return
    # candidate bubbles: closed, near-circular, uniform-size, glyph inside
    cand = []
    for u in units:
        if not u.closed or len(u.pts) < 6:
            continue
        bb = u.pts.max(axis=0) - u.pts.min(axis=0)
        if not (14.0 <= max(bb) <= 60.0):
            continue
        if min(bb) < 0.75 * max(bb):
            continue
        d_avg = float((bb[0] + bb[1]) / 2)
        circ = u.length / (np.pi * d_avg) if d_avg > 0 else 0.0
        if not (0.85 <= circ <= 1.20):
            continue
        cand.append(((u.pts.min(axis=0) + u.pts.max(axis=0)) / 2, d_avg / 2))
    if len(cand) < 3:
        return
    # uniform size: the dominant radius class (drafting templates repeat)
    rs = sorted(r for _, r in cand)
    med_r = rs[len(rs) // 2]
    bubbles = [(c, r) for c, r in cand if abs(r - med_r) <= 0.12 * med_r]
    if len(bubbles) < 3:
        return
    from scipy.spatial import cKDTree
    mids = np.array([(u.pts[0] + u.pts[-1]) / 2 for u in units])
    mtree = cKDTree(mids)
    glyph_bubbles = []
    for c, r in bubbles:
        # a grid bubble carries a letter/number: geometry strictly inside.
        # The bubble's own midpoint sits ON the rim (closed loop: first
        # point), i.e. at distance r > 0.8r, so any hit is glyph ink.
        # >=1, not >=2: twin-merge fuses a letter's double-drawn contours
        # into one unit, and single-stroke letters (I, 1, L) are one unit
        # to begin with - measured on Belle p2, bubble D failed at >=2.
        if len(mtree.query_ball_point(c, r * 0.8)) >= 1:
            glyph_bubbles.append((c, r))
    if len(glyph_bubbles) < 3:
        return
    # endpoints of ALL dash chains, for the terminal (through-line) test
    ends, dirs = [], []
    for c in dash_chains:
        for e, inner in ((c.pts[0], c.pts[1]), (c.pts[-1], c.pts[-2])):
            v = np.asarray(e, float) - np.asarray(inner, float)
            n = float(np.hypot(*v))
            ends.append(np.asarray(e, float))
            dirs.append(v / n if n > 1e-9 else np.array([0.0, 0.0]))
    etree = cKDTree(np.array(ends))

    def lateral_ok(c):
        a, b = c.pts[0], c.pts[-1]
        v = np.asarray(b, float) - np.asarray(a, float)
        n = float(np.hypot(*v))
        if n < 60.0:
            return None
        u_ = v / n
        rel = c.pts - a
        lat = np.abs(rel[:, 0] * u_[1] - rel[:, 1] * u_[0])
        return u_ if float(np.percentile(lat, 90)) <= 3.0 else None

    axes = []
    for c in dash_chains:
        u_ = lateral_ok(c)
        if u_ is None:
            continue
        for e, outd in ((c.pts[0], -u_), (c.pts[-1], u_)):
            for (bc, br) in glyph_bubbles:
                tv = bc - e
                dist = float(np.hypot(*tv))
                if not (0.4 * br <= dist <= 2.6 * br):
                    continue
                if float(np.dot(outd, tv / (dist or 1.0))) < 0.85:
                    continue
                # terminal: nothing collinear continues beyond the bubble
                beyond = bc + outd * (br + 20.0)
                through = False
                for k in etree.query_ball_point(beyond, 45.0):
                    if abs(float(np.dot(dirs[k], outd))) > 0.9:
                        through = True
                        break
                if through:
                    continue
                axes.append((bc, outd, c.color, _weight_class(c.width)))
                c.klass = "annotation"
                c.dash_signature = "grid"
                break
            if c.klass == "annotation":
                break
    # bubbles that never anchor a terminal chain still mark grid axes:
    # mid-sheet bubbles sit ON their line (it continues both ways), which
    # the terminal test rightly refuses. The grid-vs-manhole discriminator
    # is ALIGNMENT: grid bubbles come in rows/columns (>=3 collinear) and
    # their lines run PERPENDICULAR to the set (letters across the top,
    # lines dropping down). A lettered manhole run is collinear WITH its
    # pipe, so the perpendicular gate blocks it.
    if len(glyph_bubbles) >= 3:
        # the grid PEN is whatever the terminal-anchored chains are drawn
        # with. A wall centerline lying exactly on a bubble row (Belle p2:
        # red shear centerline on grid row 3) passes the geometric tests,
        # so when terminal anchors exist, perpendicular-set anchoring is
        # restricted to their pen family.
        tpens = [(acol, awt) for _, _, acol, awt in axes]
        def _pen_ok(c):
            if not tpens:
                return True
            for acol, awt in tpens:
                if _weight_class(c.width) != awt:
                    continue
                if acol and c.color and max(abs(a - b) for a, b in
                                            zip(acol, c.color)) > 0.2:
                    continue
                return True
            return False
        centers = np.array([bc for bc, _, _, _ in glyph_bubbles] if False else [bc for bc, _ in glyph_bubbles])
        for c in dash_chains:
            if c.klass == "annotation" or not _pen_ok(c):
                continue
            a, b = np.asarray(c.pts[0], float), np.asarray(c.pts[-1], float)
            v = b - a
            n = float(np.hypot(*v))
            if n < 60.0:
                continue
            u_ = v / n
            rel_all = np.asarray(c.pts, float) - a
            if float(np.percentile(
                    np.abs(rel_all[:, 0] * u_[1] - rel_all[:, 1] * u_[0]),
                    90)) > 3.0:
                continue
            relc = centers - a
            lat_c = np.abs(relc[:, 0] * u_[1] - relc[:, 1] * u_[0])
            for bi in np.nonzero(lat_c <= 3.0)[0]:
                bc = centers[bi]
                # the bubble's aligned set: >=2 OTHER bubbles collinear
                # with it in a direction perpendicular to this chain
                dd = centers - bc
                dist = np.hypot(dd[:, 0], dd[:, 1])
                # strictly collinear on the perpendicular line: offset
                # ALONG the chain <= 3pt. Parallel utilities with
                # structures at the same station could still fake a set
                # of 3; accepted residual, regress (C8.0 storm) guards it.
                along = np.abs(dd[:, 0] * u_[0] + dd[:, 1] * u_[1])
                mates = (dist > 1.0) & (along <= 3.0)
                if int(mates.sum()) >= 2:
                    axes.append((bc, u_, c.color, _weight_class(c.width)))
                    c.klass = "annotation"
                    c.dash_signature = "grid"
                    break
    if not axes:
        return
    # expand along each axis: the same grid line continues as separate
    # chain fragments across the plan - collinear, tiny lateral offset.
    # Short stubs (a grid dash crossing one room) fail the 60pt chord
    # gate above, so the expansion tests EVERY point against the axis
    # line instead: all points within 3pt AND chord direction collinear.
    # The direction guard keeps same-cadence wall hatches that happen to
    # sit on a grid line from being swallowed (their ticks run diagonal).
    for c in dash_chains:
        if c.klass == "annotation":
            continue
        a, b = np.asarray(c.pts[0], float), np.asarray(c.pts[-1], float)
        v = b - a
        n = float(np.hypot(*v))
        if n < 20.0:
            continue
        u_ = v / n
        for bc, ad, acol, awt in axes:
            if abs(float(np.dot(u_, ad))) < 0.98:
                continue
            # same pen as the anchoring grid chain: a shear-wall
            # centerline ON a grid row is collinear but differently drawn
            if _weight_class(c.width) != awt:
                continue
            if acol and c.color and max(abs(a - b) for a, b in zip(acol, c.color)) > 0.2:
                continue
            rel = np.asarray(c.pts, float) - bc
            lat = np.abs(rel[:, 0] * ad[1] - rel[:, 1] * ad[0])
            if float(lat.max()) <= 3.0:
                c.klass = "annotation"
                c.dash_signature = "grid"
                break
    # the bubbles themselves (circle + tick glyphs) chained from the same
    # pens: demote chains living inside an armed bubble
    btree = cKDTree(np.array([bc for bc, _ in glyph_bubbles]))
    rmax = max(br for _, br in glyph_bubbles)
    for c in chains:
        if c.klass == "annotation" or len(c.pts) < 2:
            continue
        m = (np.asarray(c.pts[0], float) + np.asarray(c.pts[-1], float)) / 2
        bb = c.pts.max(axis=0) - c.pts.min(axis=0)
        # the bubble circle's own bbox diagonal is hypot(2r,2r) = 2.83r -
        # a 2.6r cap excluded exactly the circles it exists to demote
        if float(np.hypot(*bb)) > 3.05 * rmax:
            continue
        for k in btree.query_ball_point(m, rmax * 1.4):
            bc, br = glyph_bubbles[k]
            if np.all(np.abs(np.asarray(c.pts, float) - bc).max(axis=0) <= br * 1.45):
                c.klass = "annotation"
                c.dash_signature = "grid"
                break


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


def _glyph_blobs(units: list, idxs: list) -> tuple:
    """Exploded inline text labels (- FW - FW -, - SD - SD -).

    CAD explodes annotation text into vector strokes, so on these pages
    there is no text-layer word to bridge across: the letters land in the
    dash pool and get chained AS dashes (a 'W' becomes a 23pt 'dash', and
    the real line's class is read off letterforms). The giveaway is that a
    letter stroke is a FOLDED path inside a small box - its path length far
    exceeds its bounding diagonal - which no real dash ever is.

    Returns (glyph_indices, blobs) where each blob is (cx, cy, token).
    """
    from scipy.spatial import cKDTree

    seeds = []
    for i in idxs:
        u = units[i]
        if len(u.pts) < 3 or not (2.0 <= u.length <= 40.0):
            continue
        bb = u.pts.max(axis=0) - u.pts.min(axis=0)
        diag = float(np.hypot(*bb))
        if diag > 15.0 or diag <= 0:
            continue
        if diag / u.length > 0.78:  # nearly straight = a dash, not a letter
            continue
        seeds.append(i)
    if len(seeds) < 3:
        return set(), []

    # group letter strokes into label blobs, absorbing short straight
    # strokes nearby (the 'I' of a word, the crossbar of an 'F')
    short = [i for i in idxs
             if i not in set(seeds) and units[i].length <= 9.0]
    centers = np.array([units[i].pts.mean(axis=0) for i in seeds])
    tree = cKDTree(centers)
    parent = list(range(len(seeds)))

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    # sorted: query_pairs returns a python set; union order must not follow
    # its hash-dependent iteration order
    for a, b in sorted(tree.query_pairs(9.0)):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb
    groups = defaultdict(list)
    for k, i in enumerate(seeds):
        groups[find(k)].append(i)

    short_c = np.array([units[i].pts.mean(axis=0) for i in short]) \
        if short else np.empty((0, 2))
    short_tree = cKDTree(short_c) if len(short_c) else None

    blobs, glyphs = [], set()
    raw = []
    for members in groups.values():
        pts = np.vstack([units[i].pts for i in members])
        lo, hi = pts.min(axis=0), pts.max(axis=0)
        if float(np.hypot(*(hi - lo))) > 20.0:
            continue  # too big to be an inline label
        mem = list(members)
        if short_tree is not None:
            c = (lo + hi) / 2.0
            for k in short_tree.query_ball_point(c, 10.0):
                mem.append(short[k])
        pts = np.vstack([units[i].pts for i in mem])
        lo, hi = pts.min(axis=0), pts.max(axis=0)
        size = float(np.hypot(*(hi - lo)))
        if size > 22.0:
            continue
        raw.append((mem, (lo + hi) / 2.0, size, len(mem)))
    if len(raw) < 3:
        return set(), []

    # a real inline label REPEATS: same stroke count, same size. A one-off
    # folded blob is an arrowhead or a symbol, and stripping it here would
    # be guesswork
    sig = Counter((n, round(size / 3.0)) for _, _, size, n in raw)
    common = {k for k, v in sig.items() if v >= 3}
    if not common:
        return set(), []
    for mem, ctr, size, n in raw:
        key = (n, round(size / 3.0))
        if key not in common:
            continue
        glyphs.update(mem)
        blobs.append((float(ctr[0]), float(ctr[1]), f"#{n}{key[1]}"[:4],
                      _style_key(units[mem[0]])))
    return glyphs, blobs


def _mark_glyph_text_chains(chains: list, blobs: list) -> None:
    """A dashed line whose gaps repeatedly hold an exploded glyph IS a
    dash-text line (milestone 2), even with no text layer to bridge across.

    Class definition, since it decides what the metric scores: "dash-text"
    means a dashed line carrying a REPEATING INLINE MARK in its gaps. The
    mark is usually a utility letter code (- W -, - G -, - FW -), and
    sometimes a direction symbol (the storm swale's flow chevron). We
    cannot OCR an exploded glyph reliably, so the class deliberately does
    not claim to distinguish letters from symbols - both are the same
    takeoff geometry and the same detection problem.
    """
    from scipy.spatial import cKDTree

    if not blobs:
        return
    # an inline label belongs to ITS OWN line: same layer, colour and
    # weight. Without this a line merely PASSING near unrelated symbols
    # (fence crossing vegetation ticks) gets read as dash-text.
    by_style = defaultdict(list)
    for b in blobs:
        by_style[b[3]].append(b)
    for c in chains:
        if not c.klass.startswith("dash") or c.length < 30.0:
            continue
        mine = by_style.get((c.color, round(c.width or 0.0, 1), c.layer))
        if not mine or len(mine) < 3:
            continue
        samples, _ = _sample_polyline(np.asarray(c.pts), step=2.0, max_n=40000)
        if not len(samples):
            continue
        tree = cKDTree(np.array([[b[0], b[1]] for b in mine]))
        hits = set()
        for k in cKDTree(samples).query_ball_tree(tree, 4.0):
            hits.update(k)
        if len(hits) < 3:
            continue
        # sorted: most_common breaks count ties by insertion order, which
        # must not inherit the set's iteration order
        toks = Counter(mine[h][2] for h in sorted(hits))
        top, n_top = toks.most_common(1)[0]
        if n_top >= 3 and c.length / n_top <= 400.0:
            c.klass = "dash-text"
            c.label_texts = [top] * n_top


def _strip_x_marks(units: list, idxs: list) -> list:
    """Fence-style X decorations: two short strokes crossing at their
    midpoints, riding ON a carrier line (—x—x—x—). The legs share the
    carrier's style, so they enter the dash pool and (a) break the carrier
    chain where links compete and (b) get swallowed into chains, corrupting
    the cadence class. An X is unambiguous geometry — near-identical
    midpoints, crossing angle, similar short lengths — so strip legs before
    matching. The carrier dashes then chain straight through, and every X
    center still sits on the emitted chain (coverage keeps crediting them).
    Only fires when the group has >= 3 X's: lone crossings elsewhere are
    left for the normal junk defenses."""
    from scipy.spatial import cKDTree

    cand = [i for i in idxs
            if 3.0 <= units[i].length <= 24.0 and len(units[i].pts) <= 4]
    if len(cand) < 6:
        return idxs
    mids = np.array([(units[i].pts[0] + units[i].pts[-1]) / 2.0 for i in cand])
    vecs = np.array([units[i].pts[-1] - units[i].pts[0] for i in cand])
    lens = np.array([units[i].length for i in cand])
    vecs = vecs / np.maximum(np.linalg.norm(vecs, axis=1, keepdims=True), 1e-9)
    tree = cKDTree(mids)
    pairs = []
    for a, b in tree.query_pairs(6.5):
        # CAD fences draw the X either as two strokes crossing at their
        # midpoints (mid distance ~0) or as two offset halves (~0.7 x leg
        # length apart); both are one decoration
        mid_d = float(np.hypot(*(mids[a] - mids[b])))
        if max(lens[a], lens[b]) > 1.8 * min(lens[a], lens[b]):
            continue
        cosang = abs(float(vecs[a] @ vecs[b]))
        if cosang > 0.87:  # < ~30 deg apart: parallel strokes, not an X
            continue
        pairs.append((mid_d, a, b))
    pairs.sort()
    used: set = set()
    legs: set = set()
    centers = []
    for _, a, b in pairs:
        if a in used or b in used:
            continue
        used.update((a, b))
        legs.update((cand[a], cand[b]))
        centers.append((mids[a] + mids[b]) / 2.0)
    if len(centers) < 3:
        return idxs
    kept = [i for i in idxs if i not in legs]

    # X's with a carrier line under them are done - the carrier chains
    # straight through the gap the legs occupied. But some fence stretches
    # are X-ONLY (no connecting dashes drawn): rebuild the carrier as
    # synthetic dashes at each stranded X center, aimed at its nearest
    # fellow X, so the normal matcher chains them at the X cadence.
    ref = units[idxs[0]]
    kept_mids = np.array([(units[i].pts[0] + units[i].pts[-1]) / 2.0
                          for i in kept]) if kept else np.empty((0, 2))
    kt = cKDTree(kept_mids) if len(kept_mids) else None
    ctr = np.asarray(centers)
    ct = cKDTree(ctr)
    dnn, _ = ct.query(ctr, k=2)
    spacing = float(np.median(dnn[:, 1]))
    if not np.isfinite(spacing) or spacing < 6.0 or spacing > 120.0:
        return kept
    half = min(spacing * 0.35, 14.0)
    for i, c in enumerate(ctr):
        if kt is not None:
            d, _ = kt.query(c, distance_upper_bound=spacing * 0.8)
            if np.isfinite(d):
                continue  # a real carrier stroke is nearby
        d2, j2 = ct.query(c, k=2)
        if not np.isfinite(d2[1]) or d2[1] > 2.2 * spacing:
            continue  # stranded singleton, don't invent a line
        v = ctr[j2[1]] - c
        v = v / max(float(np.hypot(*v)), 1e-9)
        pts = np.array([c - v * half, c + v * half])
        kept.append(len(units))
        units.append(StrokeUnit(
            pts=pts, color=ref.color, width=ref.width,
            layer=ref.layer, dashes=ref.dashes, closed=False))
    return kept


def _merge_twin_strokes(units: list) -> list:
    """Collapse double-drawn strokes into ONE stroke with the weight they
    actually PRINT at.

    CAD bolds a line by drawing it twice, offset by a fraction of a point
    up to ~3pt. Deduping the pair is not enough: the survivor keeps its
    hairline width, lands in the hairline weight class, and then groups,
    chains and legend-matches with genuine hairline junk - Oncor's PROPERTY
    LINE (w=0.12 drawn twice, looks heavy on paper) came through at 35%
    coverage and matched nothing in the legend this way. The pair IS one
    logical stroke whose printed footprint is stroke width + offset, so
    merge before style grouping: survivor takes the midline geometry and
    the effective width, and the twin is dropped.

    Guards mirror _dedup_twins: same style key, same length within 8%,
    parallel within ~5 degrees, and both endpoints coincident (same or
    reversed) - a twin is the same stroke drawn again, never a nearby
    parallel feature like a curb pair.
    """
    from scipy.spatial import cKDTree

    # pair on colour+layer only: CAD draws the same mark twice at DIFFERENT
    # widths too (Oncor p4 legend: a 0.12 hairline under a 2.40 stroke), and
    # keying on width would leave those pairs forever unmerged
    by_key = defaultdict(list)
    for i, u in enumerate(units):
        k = _style_key(u)
        by_key[(k[0], k[2])].append(i)

    drop: set = set()
    merged: dict = {}
    for idxs_all in by_key.values():
        if len(idxs_all) < 2:
            continue
        # ITERATE to a fixpoint: CAD redraws can stack the same mark 30-60
        # deep (layered xrefs replotted), and one pairwise pass only halves
        # a stack - 32 copies left 16 overlapping marks that chained into
        # in-place tangles and got pruned wholesale, taking real lines and
        # the legend swatch down with them.
        idxs = list(idxs_all)
        for _round in range(8):
            if len(idxs) < 2:
                break
            P0 = np.array([units[i].pts[0] for i in idxs], dtype=float)
            P1 = np.array([units[i].pts[-1] for i in idxs], dtype=float)
            L = np.array([units[i].length for i in idxs], dtype=float)
            D = np.array([units[i].direction() for i in idxs], dtype=float)
            mids = (P0 + P1) / 2.0
            tree = cKDTree(mids)
            # a double-drawn stroke is a PAIR; a stipple/hatch field is a
            # CROWD. Crowded units cannot be twins and pairing them explodes
            # the pair count into the millions on textured sheets, so they
            # are excluded up front. Stacked REDRAWS thin out each round, so
            # marks crowded by their own copies become pairable as the
            # stack collapses.
            # crowd = DISTINCT nearby marks. Coincident copies (a stack of
            # redraws at the same spot) must not count, or a 32-deep stack
            # reads as a crowd and gets excluded from the very pairing that
            # would collapse it.
            near5 = tree.query_ball_point(mids, 5.0, return_length=True)
            near0 = tree.query_ball_point(mids, 0.8, return_length=True)
            calm = np.nonzero((near5 - near0) <= 6)[0]
            if len(calm) < 2:
                break
            sub = cKDTree(mids[calm])
            pairs = sub.query_pairs(4.5, output_type="ndarray")
            if len(pairs) == 0:
                break
            pairs = calm[pairs]
            # greedy accepts below resolve conflicts first-come: pin the
            # order to unit index, not the KD-tree's emission order
            pairs = pairs[np.lexsort((pairs[:, 1], pairs[:, 0]))]
            pa, pb = pairs[:, 0], pairs[:, 1]
            # all guards vectorised; the python loop only sees survivors
            ok = np.abs(L[pa] - L[pb]) <= np.maximum(
                0.6, 0.08 * np.maximum(L[pa], L[pb]))
            ok &= np.abs(np.einsum("ij,ij->i", D[pa], D[pb])) >= 0.996
            d_same = np.maximum(np.hypot(*(P0[pa] - P0[pb]).T),
                                np.hypot(*(P1[pa] - P1[pb]).T))
            d_rev = np.maximum(np.hypot(*(P0[pa] - P1[pb]).T),
                               np.hypot(*(P1[pa] - P0[pb]).T))
            # endpoint-identity tolerance scales with mark size: a DOT's
            # direction is noise, so tiny marks merge only when truly
            # coincident (a dot twin cannot be told from the next dot
            # along a dotted line any other way)
            thr = np.clip(0.35 * np.maximum(L[pa], L[pb]), 0.6, 4.4)
            ok &= np.minimum(d_same, d_rev) <= thr
            if not ok.any():
                break
            same_first = d_same <= d_rev
            # --- ladder veto: a twin is an ISOLATED pair. In a dense
            # contour field (LIDAR topo) adjacent contour LINES sit only
            # 2-4pt apart with same-length, in-phase dashes - such a pair
            # passes every guard above, and merging it eats every other
            # contour, drags geometry to the midline between two DIFFERENT
            # lines, and poisons the width bump below (offset joins the
            # width: 0.48pt hairlines printed as 3.0pt on Belle Road).
            # A real double-draw has nothing else parallel at comparable
            # spacing: no third line on the far side of either member and
            # no next rung beyond the partner. Coincident pairs
            # (offset <= 1.2pt: stacks, true redraws) are never vetoed.
            kidx = np.nonzero(ok)[0]
            veto = np.zeros(len(L), dtype=bool)  # indexed by pair id below
            veto_pairs = set()
            if len(kidx):
                sep = mids[pb[kidx]] - mids[pa[kidx]]
                da = D[pa[kidx]]
                offp = da[:, 0] * sep[:, 1] - da[:, 1] * sep[:, 0]
                need = np.abs(offp) > 1.2
                if need.any():
                    # sideways-parallel neighbour count per mark, one
                    # vectorised pass (a per-pair radius search here cost
                    # 95s on Oncor's 58k-unit sheets): a mark with >=2
                    # parallel neighbours offset 1.2-12pt sits in a ladder
                    # (contour field); a true twin member has exactly its
                    # partner. Trade-off vs per-pair bands: a double-drawn
                    # line whose parallel SIBLING feature sits within 12pt
                    # now also refuses the offset-merge - it stays split
                    # thin (cosmetic) instead of risking eaten contours.
                    # enumerate over CALM marks only: crowded stipple
                    # dots would blow query_pairs into tens of millions
                    # on Oncor-scale sheets, and only line-like (calm)
                    # marks constitute ladder evidence
                    fp = sub.query_pairs(12.0, output_type="ndarray")
                    cnt = np.zeros(len(L), dtype=np.int32)
                    if len(fp):
                        fa, fb = calm[fp[:, 0]], calm[fp[:, 1]]
                        par = np.abs(np.einsum("ij,ij->i", D[fa], D[fb])) >= 0.94
                        sv = mids[fb] - mids[fa]
                        perp = np.abs(D[fa][:, 0] * sv[:, 1]
                                      - D[fa][:, 1] * sv[:, 0])
                        side = par & (perp >= 1.2)
                        np.add.at(cnt, fa[side], 1)
                        np.add.at(cnt, fb[side], 1)
                    bad = need & ((cnt[pa[kidx]] >= 2) | (cnt[pb[kidx]] >= 2))
                    veto_pairs = set(kidx[bad].tolist())
            made = False
            for k in np.nonzero(ok)[0]:
                if int(k) in veto_pairs:
                    continue
                ia, ib = idxs[int(pa[k])], idxs[int(pb[k])]
                if ia in drop or ib in drop:
                    continue
                ua, ub = units[ia], units[ib]
                # keep the FATTER stroke of a mixed-width pair - that is
                # the printed appearance; equal widths keep the longer one
                if abs((ua.width or 0) - (ub.width or 0)) > 0.05:
                    keep, gone = (ia, ib) if (ua.width or 0) >= (ub.width or 0) \
                        else (ib, ia)
                else:
                    keep, gone = (ia, ib) if ua.length >= ub.length else (ib, ia)
                uk, ug = units[keep], units[gone]
                nvec = uk.direction()
                dm = ug.pts.mean(axis=0) - uk.pts.mean(axis=0)
                off = abs(float(nvec[0] * dm[1] - nvec[1] * dm[0]))
                # midline is the truthful centerline of the printed line
                if len(uk.pts) == len(ug.pts):
                    gp = ug.pts if bool(same_first[k]) else ug.pts[::-1]
                    uk.pts = (uk.pts + gp) / 2.0
                    uk._dir = None
                merged.setdefault(id(uk), off)
                drop.add(gone)
                made = True
            idxs = [i for i in idxs if i not in drop]
            if not made:
                break

        # subsegment copies: a shorter mark lying ON a longer collinear
        # mark's path is a redraw/knockout duplicate, not linework of its
        # own (equal-length pairing can never catch a clipped copy)
        if len(idxs) >= 2:
            P0 = np.array([units[i].pts[0] for i in idxs], dtype=float)
            P1 = np.array([units[i].pts[-1] for i in idxs], dtype=float)
            L = np.array([units[i].length for i in idxs], dtype=float)
            mids = (P0 + P1) / 2.0
            tree = cKDTree(mids)
            # stable: equal-length marks sweep in index order every run
            order = np.argsort(-L, kind="stable")
            for oi in order:
                i = idxs[int(oi)]
                if i in drop or L[oi] < 3.0:
                    continue
                a, b = P0[oi], P1[oi]
                ab = b - a
                L2 = float(ab @ ab)
                if L2 < 1e-9:
                    continue
                for kk in tree.query_ball_point(mids[oi], float(L[oi])):
                    j = idxs[int(kk)]
                    if j == i or j in drop:
                        continue
                    if L[kk] > 0.9 * L[oi]:
                        continue  # near-equal: pair logic's job, not ours
                    ok_pts = True
                    for q in (P0[kk], P1[kk]):
                        t = max(0.0, min(1.0, float((q - a) @ ab) / L2))
                        if float(np.hypot(*(q - (a + t * ab)))) > 1.8:
                            ok_pts = False
                            break
                    if ok_pts:
                        drop.add(j)

    # Pattern-filled markers: a "dot" or square marker is often plotted as
    # a dense cluster of micro-strokes (32 hatch strokes inside a 2.5pt
    # box on Oncor p4). Those clusters chain into in-place tangles that
    # the junk pruner rightly kills - taking the dot, and with it the
    # dash-dot pattern it belongs to. Collapse each cluster to ONE
    # synthetic mark spanning its envelope.
    from collections import defaultdict as _dd
    by_key2 = _dd(list)
    for i, u in enumerate(units):
        if i in drop or u.length >= 5.0 or len(u.pts) > 6:
            continue
        k = _style_key(u)
        by_key2[(k[0], k[2])].append(i)
    for idxs2 in by_key2.values():
        if len(idxs2) < 6:
            continue
        mids2 = np.array([units[i].pts.mean(axis=0) for i in idxs2])
        t2 = cKDTree(mids2)
        # crowd guard, same reasoning as the twin-pass calm filter above: a
        # collapsible marker/dash cluster fits a 60x4.5 envelope, so no
        # member can have more than a couple hundred distinct 3pt
        # neighbours (corpus ceiling 172, one C8 hatch dash; the Oncor p4
        # dot is 32 strokes). A stipple/hatch FIELD gives every mark
        # THOUSANDS (CO3 Rifle p1: 126,677 marks averaging ~7,600 ->
        # ~484M pairs, and query_pairs' set build holds the GIL while it
        # eats tens of GB - the page hangs unkillably). The field's giant
        # component would only die on the span gate below anyway, so count
        # neighbours first (a count query materialises no pairs) and keep
        # crowded marks out of the clustering entirely: they stay
        # individual units for the normal junk defenses, and the fringe
        # rejection at the bottom keeps calm field-edge marks from forming
        # clusters the unguarded graph would have welded into the field.
        # Cap 256 = 1.5x the corpus ceiling, ~30x under field density.
        crowd = t2.query_ball_point(mids2, 3.0, return_length=True) - 1
        calm2 = np.nonzero(crowd <= 256)[0]
        if len(calm2) < 6:
            continue
        parent = list(range(len(idxs2)))

        def _find(a):
            while parent[a] != a:
                parent[a] = parent[parent[a]]
                a = parent[a]
            return a
        pairs2 = cKDTree(mids2[calm2]).query_pairs(3.0, output_type="ndarray")
        if len(pairs2):
            pairs2 = calm2[pairs2]
            # ascending (a, b): the exact order of the sorted() set
            # iteration this replaces - union outcomes must not follow the
            # KD-tree's emission order (accept-order pinning, b0bacf0)
            pairs2 = pairs2[np.lexsort((pairs2[:, 1], pairs2[:, 0]))]
            for a, b in pairs2.tolist():
                ra, rb = _find(a), _find(b)
                if ra != rb:
                    parent[ra] = rb
        groups2 = _dd(list)
        for k2 in range(len(idxs2)):
            groups2[_find(k2)].append(k2)
        has_crowd = len(calm2) < len(idxs2)
        for loc in groups2.values():
            if len(loc) < 6:
                continue
            # a component TOUCHING the crowd is the fringe of a texture
            # field: unguarded, its members would have welded into the
            # field's giant component and died on the span gate below, so
            # reject it here too - the guard must not mint clusters the
            # unguarded pass would never have collapsed. (Members are calm,
            # so each ball probe returns at most cap+1 ids.)
            if has_crowd and any(crowd[j] > 256 for k in loc
                                 for j in t2.query_ball_point(mids2[k], 3.0)):
                continue
            members = [idxs2[k] for k in loc]
            pts = np.vstack([units[i].pts for i in members])
            lo, hi = pts.min(axis=0), pts.max(axis=0)
            span = hi - lo
            # a filled MARKER is dot-sized; a filled DASH is a thin
            # elongated box (10x3 on the Oncor property line). Both are
            # one printed mark. Anything thicker/larger is hatch texture
            # and stays for the normal defenses.
            if float(min(span)) > 4.5 or float(max(span)) > 60.0:
                continue
            keep = max(members, key=lambda i: units[i].length)
            uk = units[keep]
            if span[0] >= span[1]:
                uk.pts = np.array([[lo[0], (lo[1] + hi[1]) / 2],
                                   [hi[0], (lo[1] + hi[1]) / 2]])
            else:
                uk.pts = np.array([[(lo[0] + hi[0]) / 2, lo[1]],
                                   [(lo[0] + hi[0]) / 2, hi[1]]])
            uk.length = float(max(span))
            uk.width = round(max(float(min(span)), uk.width or 0.0), 1)
            uk._dir = None
            for i in members:
                if i != keep:
                    drop.add(i)

    # Printed footprint = stroke width + offset, but the style key groups on
    # exact width, and raw per-pair offsets wobble (0.5..3pt along one same
    # line) - encode each raw offset and one bold line scatters into many
    # one-mark styles that can never form a cadence. All survivors of one
    # base style share the population's MEDIAN offset instead.
    if merged:
        survivors = [u for i, u in enumerate(units) if i not in drop]
        by_base = defaultdict(lambda: {"bumped": [], "rest": []})
        for u in survivors:
            k = _style_key(u)
            if id(u) in merged and merged[id(u)] > 0.25:
                by_base[k]["bumped"].append(u)
            else:
                by_base[k]["rest"].append(u)
        for k, pop in by_base.items():
            bumped = pop["bumped"]
            if not bumped:
                continue
            bump = float(np.median([merged[id(u)] for u in bumped]))
            for u in bumped:
                u.width = round((u.width or 0.0) + bump, 1)
            # One pattern can mix bolding styles - offset twins for the
            # long marks, coincident duplicates or single strokes for the
            # shorts and dots - and pairing only ever certifies part of a
            # line. A partial bump SPLITS the line into two width groups
            # (Oncor p4's property line bumped inside the FEMA band and
            # stayed thin outside it - one line, two styles, neither
            # chained fully). So the printed weight propagates to CLOSURE:
            # bumped marks seed, any same-base-style mark within gap reach
            # of TWO members joins, repeat until stable. Whole connected
            # populations move together or not at all.
            rest = [u for u in pop["rest"] if u.length <= 130.0]
            family = list(bumped)
            pending = rest
            # frontier expansion: each round only marks near the NEWLY
            # added members can join, so the family tree is rebuilt over a
            # shrinking frontier instead of the whole population (a naive
            # closure doubled build times on texture-heavy sheets)
            frontier = family
            fam_tree = None
            for _ in range(8):
                if not pending or not frontier:
                    break
                ft = cKDTree(np.array([(u.pts[0] + u.pts[-1]) / 2
                                       for u in frontier]))
                near = []
                still = []
                for u in pending:
                    r = 60.0 + 0.6 * u.length
                    if ft.query_ball_point((u.pts[0] + u.pts[-1]) / 2, r,
                                           return_length=True) > 0:
                        near.append(u)
                    else:
                        still.append(u)
                if not near:
                    break
                if fam_tree is None or len(frontier) > 0:
                    fam_tree = cKDTree(np.array([(u.pts[0] + u.pts[-1]) / 2
                                                 for u in family]))
                added = []
                for u in near:
                    r = 60.0 + 0.6 * u.length
                    hits = fam_tree.query_ball_point(
                        (u.pts[0] + u.pts[-1]) / 2, r, return_length=True)
                    if hits >= 2:
                        u.width = round((u.width or 0.0) + bump, 1)
                        added.append(u)
                    else:
                        still.append(u)
                family += added
                frontier = added
                pending = still
    # absorbed marks stay in the CALLER's list (eval uses it as the recall
    # denominator) - tag them so metrics know their ink lives on in a
    # survivor instead of scoring a genuinely double-drawn layer at 50%
    for i in sorted(drop):
        units[i]._absorbed = True
    if not drop:
        return units
    return [u for i, u in enumerate(units) if i not in drop]


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
        # no real line doubles back on itself mid-run: reject assemblies
        # whose path reverses repeatedly (texture fields / leader sunbursts
        # threading into fake cadences - the GCHC lawn spike storms)
        _segs = np.diff(pts, axis=0)
        _sl = np.hypot(_segs[:, 0], _segs[:, 1])
        _ks = _sl > 3.0
        if _ks.sum() >= 4:
            _sd = _segs[_ks] / _sl[_ks, None]
            _rv = np.einsum("ij,ij->i", _sd[:-1], _sd[1:]) < -0.5
            if float(_rv.mean()) > 0.2:
                continue
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


def _end_dir(pts: np.ndarray, end: int, lookback: float = 14.0) -> np.ndarray:
    """Outward unit direction at a chain endpoint, averaged over the last
    `lookback` pt of polyline so one short dash can't skew it."""
    seq = pts if end == 1 else pts[::-1]
    tip = seq[-1]
    ref = seq[0]
    acc = 0.0
    for k in range(len(seq) - 1, 0, -1):
        acc += float(np.hypot(*(seq[k] - seq[k - 1])))
        ref = seq[k - 1]
        if acc >= lookback:
            break
    v = tip - ref
    n = float(np.hypot(*v))
    return v / n if n > 1e-9 else np.array([1.0, 0.0])


def _join_chain_ends(chains: list) -> list:
    """Rejoin one physical line that survived detection as several chains.

    Two causes, one cure:
      * VERTICES - a property boundary turns 90 deg. The cadence matcher
        caps turn angle (rightly: that is what stops a line jumping onto a
        neighbour), so every corner ends a chain. The client's milestones
        ask for vertex/intersection handling explicitly.
      * LINK COMPETITION - an endpoint may take only ONE link, so where
        several dashes crowd a junction the winner can be the wrong one and
        a perfectly collinear continuation is left stranded.

    Guarded so unrelated features cannot fuse: identical colour, weight
    class and layer; comparable cadence; the join may not double back; and
    an endpoint with more than one candidate partner is left alone, because
    a T-junction is a genuine ambiguity rather than a join.
    """
    cands = [c for c in chains
             if (c.klass.startswith("dash") or c.klass == "solid")
             and len(c.pts) >= 2 and c.length >= 25.0
             and not _chain_closed(c)]
    if len(cands) < 2:
        return chains
    from scipy.spatial import cKDTree

    groups = defaultdict(list)
    for k, c in enumerate(cands):
        groups[(c.color, _weight_class(c.width), c.layer)].append(k)

    ok_links = []
    for members in groups.values():
        if len(members) < 2:
            continue
        eps, meta = [], []
        for k in members:
            c = cands[k]
            for end in (0, 1):
                eps.append(c.pts[-1] if end == 1 else c.pts[0])
                meta.append((k, end))
        eps = np.asarray(eps, dtype=float)
        tree = cKDTree(eps)

        def _cad(k):
            c = cands[k]
            return (c.ink or c.length) / max(c.n_dashes, 1)

        def _collinear(va, vb, gdir):
            return (va @ gdir) >= 0.86 and (vb @ -gdir) >= 0.86

        cand_by_ep = defaultdict(list)  # endpoint -> [(turn, dist, other)]
        for a, b in sorted(tree.query_pairs(56.0)):
            ka, ea = meta[a]
            kb, eb = meta[b]
            if ka == kb:
                continue
            ca, cb = cands[ka], cands[kb]
            both_solid = ca.klass == "solid" and cb.klass == "solid"
            if (ca.klass == "solid") != (cb.klass == "solid"):
                continue  # never join a solid to a dashed line
            d = float(np.hypot(*(eps[a] - eps[b])))
            va = _end_dir(np.asarray(ca.pts), ea)
            vb = _end_dir(np.asarray(cb.pts), eb)
            # 0 deg = straight continuation, 180 = folding back on itself
            turn = float(np.degrees(np.arccos(np.clip(-(va @ vb), -1.0, 1.0))))
            gap = eps[b] - eps[a]
            gn = float(np.hypot(*gap))
            gdir = gap / gn if gn > 1e-6 else va
            if both_solid:
                # Contours and other solids break two ways, with opposite
                # geometry (measured on Oncor p4):
                #  * an inline label interrupts the line: 20-34pt of blank
                #    paper but the line continues STRAIGHT through it
                #  * a sharp kink sheds a tiny piece: gap under ~9pt at a
                #    hard angle
                # Adjacent contours ending side by side have parallel
                # same-direction tangents = turn ~180, so neither rule can
                # fuse two different elevations.
                ok = (d <= 9.0 and turn <= 135.0) or                      (d <= 34.0 and turn <= 25.0 and _collinear(va, vb, gdir))
                if not ok:
                    continue
            else:
                da, db = _cad(ka), _cad(kb)
                if max(da, db) > 1.8 * min(da, db) + 3.0:
                    continue
                # how far one repeat of the pattern can carry the line past
                # the last mark before the break
                reach = 1.3 * (max(da, db) + max(_tpl_gap(ca), _tpl_gap(cb)))
                reach = float(min(max(reach, 12.0), 56.0))
                label_bridge = (d <= 34.0 and turn <= 25.0
                                and _collinear(va, vb, gdir))
                kink_repair = (d <= 9.0 and turn <= 135.0)
                # the turn between endpoint TANGENTS misses lateral
                # offset: two parallel lines with staggered ends read as
                # a straight continuation (turn 0) even when the gap runs
                # 90 deg sideways, welding neighbouring strips into a Z.
                # Charge the whole travel path instead: leave A along its
                # tangent, traverse the gap, arrive at B along its tangent
                # - the two bends together stay inside the same budget.
                # Tiny gaps keep the plain rule (gap direction is noise).
                path_turn = turn
                if d >= 6.0 and gn > 1e-6:
                    t1 = float(np.degrees(np.arccos(np.clip(va @ gdir, -1.0, 1.0))))
                    t2 = float(np.degrees(np.arccos(np.clip((-vb) @ gdir, -1.0, 1.0))))
                    path_turn = t1 + t2
                if not (d <= reach and path_turn <= 100.0) \
                        and not label_bridge and not kink_repair:
                    continue
            if turn > 135.0:
                continue
            # neither line may travel BACKWARDS to reach the other. Where a
            # line runs PAST a branch (a T-junction whose stem is already
            # part of this chain), the far endpoint still lands within reach
            # at a plausible turn, and joining it doubles the line back on
            # itself - a visible spike carrying phantom length. Sideways is
            # fine, since a genuine corner's gap can be perpendicular.
            if gn > 1e-6:
                if (va @ gdir) < -0.35 or (vb @ -gdir) < -0.35:
                    continue
            cand_by_ep[a].append((turn, d, b))
            cand_by_ep[b].append((turn, d, a))

        def _preferred(ep):
            """The one partner this endpoint clearly belongs to, or None.

            A single candidate is unambiguous. Where several chains meet,
            only a clear straight continuation wins: at a real T-junction
            the through-line reads ~0 deg while the branch turns sharply,
            so requiring that separation joins the through-line and leaves
            the branch alone instead of guessing between them."""
            lst = sorted(cand_by_ep[ep])
            if not lst:
                return None
            if len(lst) == 1:
                return lst[0][2]
            best, second = lst[0], lst[1]
            if best[0] <= 25.0 and second[0] >= best[0] + 40.0:
                return best[2]
            return None

        used = set()
        for ep in sorted(cand_by_ep):
            other = _preferred(ep)
            if other is None or ep in used or other in used:
                continue
            if _preferred(other) != ep:
                continue  # must be mutual
            used.update((ep, other))
            ka, ea = meta[ep]
            kb, eb = meta[other]
            ok_links.append((ka, ea, kb, eb))

    if not ok_links:
        return chains
    consumed = set()
    for seq in _walk_chains(cands, list(range(len(cands))), ok_links):
        if len(seq) < 2:
            continue
        pts, member_lens, gaps = _chain_geometry(cands, seq)
        # no real line doubles back on itself mid-run: reject assemblies
        # whose path reverses repeatedly (texture fields / leader sunbursts
        # threading into fake cadences - the GCHC lawn spike storms)
        _segs = np.diff(pts, axis=0)
        _sl = np.hypot(_segs[:, 0], _segs[:, 1])
        _ks = _sl > 3.0
        if _ks.sum() >= 4:
            _sd = _segs[_ks] / _sl[_ks, None]
            _rv = np.einsum("ij,ij->i", _sd[:-1], _sd[1:]) < -0.5
            if float(_rv.mean()) > 0.2:
                continue
        base = max((cands[k] for k, _ in seq), key=lambda c: c.length)
        base.pts = pts
        base.length = float(sum(member_lens) + sum(gaps))
        base.ink = float(sum((cands[k].ink or cands[k].length) for k, _ in seq))
        base.n_dashes = sum(cands[k].n_dashes for k, _ in seq)
        for k, _ in seq:
            if cands[k] is not base:
                consumed.add(id(cands[k]))
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
                    t_ink = 0.0
                    for k, _ in seq:
                        kind, payload = meta[k]
                        t_ink += float(payload[0].ink or payload[0].length) \
                            if kind == "chain" else float(units[payload].length)
                    out.append(LineChain(cid, pts, "solid", color, width,
                                         pts_len, len(seq), "solid",
                                         layer=layer, ink=t_ink))
                    cid += 1
                    consumed.update(k for k, _ in seq)
                    continue
            if total_len < 60.0:
                continue
            # no real line doubles back on itself mid-run: reject assemblies
            # whose path reverses repeatedly (texture fields / leader sunbursts
            # threading into fake cadences - the GCHC lawn spike storms)
            _segs = np.diff(pts, axis=0)
            _sl = np.hypot(_segs[:, 0], _segs[:, 1])
            _ks = _sl > 3.0
            if _ks.sum() >= 4:
                _sd = _segs[_ks] / _sl[_ks, None]
                _rv = np.einsum("ij,ij->i", _sd[:-1], _sd[1:]) < -0.5
                if float(_rv.mean()) > 0.2:
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
            tmpl = _dash_template(dls, [g for g in gaps if g > 0.5] or gaps)
            # ink = actual stroke, never gap: a merged CHAIN member's
            # length includes its gaps, and summing member lengths as ink
            # made a d10 g30 pattern claim 96% ink - which poisoned the
            # phantom-span audit's expectation (the long-standing 'ink
            # accounting' flags on Oncor p2/p4)
            true_ink = 0.0
            for k, _ in seq:
                kind, payload = meta[k]
                if kind == "chain":
                    true_ink += float(payload[0].ink or payload[0].length)
                else:
                    true_ink += float(units[payload].length)
            lc_cm = LineChain(cid, pts, klass, color, width, total_len,
                              n_dashes, sig, layer=layer, ink=true_ink)
            lc_cm.template = tmpl
            out.append(lc_cm)
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


def _pickup_end_marks(group_chains: list, units: list, dash_cand: list,
                      chained_units: set, max_picks: int = 4) -> None:
    """Absorb stranded single marks at chain ends.

    At a contour's chevron kink, link competition can leave one or two
    marks unchained - too few to ever form a candidate chain, so no pruner
    tuning can save them, and the line simply stops one dash short of the
    kink. A stranded mark whose end sits within the chain's own gap rhythm
    of a chain end, with a length the chain's cadence already contains,
    belongs to that chain.
    """
    from scipy.spatial import cKDTree

    free = [i for i in dash_cand
            if i not in chained_units and units[i].length >= 2.0]
    if not free:
        return
    fmid = np.array([(units[i].pts[0] + units[i].pts[-1]) / 2 for i in free])
    ftree = cKDTree(fmid)
    used: set = set()
    for c in group_chains:
        if not c.klass.startswith("dash") or c.n_dashes < 4:
            continue
        ink = c.ink or c.length
        gap = (c.length - ink) / max(c.n_dashes - 1, 1)
        reach = min(max(1.7 * gap + 2.0, 6.0), 30.0)
        dmax = 1.4 * max((u.length for u in
                          (units[i] for i in free)), default=0.0)
        for _ in range(max_picks):
            picked = False
            for end in (0, -1):
                ep = c.pts[end]
                best = None
                # marks whose MIDPOINT is within reach+half a long mark
                # (sorted: distance ties pick the lowest index every run)
                for k in sorted(ftree.query_ball_point(ep, reach + 0.7 * DASH_MAX_LEN)):
                    i = free[k]
                    if i in used:
                        continue
                    u = units[i]
                    if u.length > 1.4 * DASH_MAX_LEN:
                        continue
                    d0 = float(np.hypot(*(u.pts[0] - ep)))
                    d1 = float(np.hypot(*(u.pts[-1] - ep)))
                    d = min(d0, d1)
                    if d > reach:
                        continue
                    # never pick a mark the chain would DOUBLE BACK onto:
                    # at a callout-leader hub (GCHC lawns) free marks
                    # radiate BEHIND the chain end - often TOUCHING it at
                    # the hub - and picking one stitches a spike onto a
                    # clean run. Judge by where the mark's FAR end takes
                    # the line (works at zero gap too). A chevron kink
                    # turns at most ~135deg (dot -0.7); only true
                    # reversals are refused.
                    tang = c.pts[-1] - c.pts[-4 if len(c.pts) >= 4 else 0]                         if end != 0 else c.pts[0] - c.pts[3 if len(c.pts) >= 4 else -1]
                    tn = float(np.hypot(*tang))
                    far = (u.pts[-1] if d0 <= d1 else u.pts[0]) - ep
                    fn = float(np.hypot(*far))
                    if tn > 1e-6 and fn > 1e-6 and                             float(tang @ far) / (tn * fn) < -0.75:
                        continue
                    if best is None or d < best[0]:
                        best = (d, i, d0 <= d1)
                if best is None:
                    continue
                d, i, head_first = best
                u = units[i]
                seg = u.pts if head_first else u.pts[::-1]
                if end == 0:
                    c.pts = np.vstack([seg[::-1], c.pts])
                else:
                    c.pts = np.vstack([c.pts, seg])
                c.length += u.length + d
                c.ink = (c.ink or 0.0) + u.length
                c.n_dashes += 1
                used.add(i)
                chained_units.add(i)
                picked = True
            if not picked:
                break


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
    deferred = []  # short sharp-turn chains: junk unless they continue a line
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
            # applies to small-n chains.) EXCEPT at a contour's chevron
            # kink, where the shed piece is exactly short-and-turny - so
            # defer the verdict and keep the piece if it picks up right at
            # the end of a kept long chain with a matching cadence.
            if len(seq) <= 7 and mean_turn > 32.0:
                deferred.append((seq, lc, gaps))
                continue
            # texture-symbol fields (grass/earth pair-ticks, scattered
            # decoration) thread into LONG chains with regular gaps and
            # even PARALLEL headings - what betrays them is that the marks
            # do not point where the chain TRAVELS: a real dashed line's
            # every dash aims at the next one (a drawn corner breaks a few
            # links at most - a 40-dash ring has ~4), while a lawn chain
            # walks sideways/backwards between parallel ticks. Judge
            # heading-vs-travel per link, plus outright travel reversals.
            if len(seq) >= 8:
                cs = np.array([(units[i].pts[0] + units[i].pts[-1]) / 2
                               for i, _ in seq])
                steps = np.diff(cs, axis=0)
                slen = np.hypot(steps[:, 0], steps[:, 1])
                okl = slen > 1e-6
                if okl.sum() >= 4:
                    stepd = steps[okl] / slen[okl, None]
                    hd = heads[:-1][okl]
                    align = np.abs(np.einsum("ij,ij->i", hd, stepd))
                    rev = np.einsum("ij,ij->i", stepd[:-1], stepd[1:]) < -0.5
                    lens = np.array([units[i].length for i, _ in seq])[:-1][okl]
                    bad = (align < 0.7) & (lens > 2.5)  # dots have no heading
                    frac = float(bad.mean())
                    if frac > 0.25 or (len(rev) and float(rev.mean()) > 0.25):
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
        # hatch field: dense crossing strokes (crosshatch) kill outright.
        if n_cross / n_s > 0.5:
            continue
        # parallel strokes hugging the chain on BOTH sides (a lone parallel
        # partner - e.g. a double-line ditch - is fine) is hatch ONLY at
        # texture scale. A LONG chain of real-sized dashes flanked by
        # parallels is a LADDER of real lines - tight LIDAR contours 2-4pt
        # apart, a fence run between contours - and killing it strands
        # whole kilometre-scale lines. Measured on the corpus: hatch rows
        # ext<=230 / meddash 2.7 / crossing 0.87-1.0 (caught above anyway);
        # false kills were ext 700-1100 / meddash 9-14 / crossing 0.
        if min(n_left, n_right) / n_s > 0.35:
            ext = float(np.hypot(*(lc.pts.max(axis=0) - lc.pts.min(axis=0))))
            md = float(np.median(dls)) if dls else 0.0
            if ext < 240.0 or md < 6.0:
                continue
        kept.append((seq, lc, gaps))

    if deferred and kept:
        ends, meddash = [], []
        for seq, lc, _g in kept:
            if len(seq) >= 8:
                md = float(np.median([units[i].length for i, _ in seq]))
                ends += [lc.pts[0], lc.pts[-1]]
                meddash += [md, md]
        if ends:
            et = cKDTree(np.asarray(ends))
            for seq, lc, gaps in deferred:
                md = float(np.median([units[i].length for i, _ in seq]))
                for ep in (lc.pts[0], lc.pts[-1]):
                    d, j = et.query(ep)
                    if d <= 16.0 and max(md, meddash[j]) <= \
                            1.6 * min(md, meddash[j]) + 1.5:
                        kept.append((seq, lc, gaps))
                        break
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


def _chain_closed(c) -> bool:
    """A chain whose polyline returns to its start is a COMPLETE feature
    (footing rect, marker box, pond ring plotted as one dashed stroke). Its
    endpoints coincide, so end-direction guards degenerate to zero-length
    chords and silently pass - closed chains must be excluded from every
    end-joining stage explicitly."""
    pts = c.pts
    if len(pts) < 4:
        return False
    return float(np.hypot(*(pts[0] - pts[-1]))) <= max(2.0, 0.02 * c.length)


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
                  if c.klass.startswith("dash") and c.chain_id not in merged_away
                  and not _chain_closed(c)]
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
            # merge order pinned to chain_id, not KD-tree emission order:
            # which chain absorbs which decides the fix-point path
            cs = sorted(chain_set.values(), key=lambda c: c.chain_id)
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
            # ... and the SAME for b: without this, the bridge glues onto a
            # piece that faces AWAY and the merged line doubles back over
            # the label - two phantom passes of the gap length
            db = b.pts[-1] - b.pts[0] if b_end == 1 else b.pts[0] - b.pts[-1]
            nb = np.hypot(*db)
            if nb > 1e-9 and float(np.dot(db / nb, -g / dist)) < 0.71:
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


def _cadence_vec(sig: str):
    """Numeric cadence of a signature, or None when it has no measured
    numbers (solid / native dash arrays / misc), which are matched exactly."""
    ds, gs = [], []
    for tok in sig.split():
        if tok[:1] in "dg":
            try:
                v = float(tok[1:])
            except ValueError:
                return None
            (ds if tok[0] == "d" else gs).append(v)
    if not ds and not gs:
        return None
    return (tuple(sorted(ds)), tuple(sorted(gs)))


def _cadence_close(a, b, tol: float = 0.35) -> bool:
    if a is None or b is None:
        return False
    if len(a[0]) != len(b[0]) or len(a[1]) != len(b[1]):
        return False
    for xa, xb in zip(a[0] + a[1], b[0] + b[1]):
        lo, hi = sorted((xa, xb))
        if hi > lo * (1.0 + tol) + 1.5:
            return False
    return True


def _assign_styles(chains: list) -> None:
    """Group chains into user-facing line styles: same class + color + weight
    class + similar signature -> one style id, ready for the classify/approve
    UI.

    Cadence is CLUSTERED within a family rather than quantised onto fixed
    bins. Fixed bins put a boundary somewhere, and one physical line whose
    measured dash wanders across it lands in two different checkboxes: the
    Oncor property boundary split at 42.3pt vs 44.0pt, so ticking "the
    property line" silently dropped a third of the ring, including a whole
    corner. Same colour, weight, layer and class plus a dash pattern within
    ~35% is one line as far as the estimator is concerned.
    """
    fams = defaultdict(list)
    for c in chains:
        fams[(c.klass, c.color, _weight_class(c.width), c.layer)].append(c)

    styles: dict = {}
    for fam, cs in fams.items():
        sigs = sorted({c.dash_signature for c in cs})
        vecs = [_cadence_vec(sg) for sg in sigs]
        parent = list(range(len(sigs)))

        def find(a):
            while parent[a] != a:
                parent[a] = parent[parent[a]]
                a = parent[a]
            return a

        for i in range(len(sigs)):
            for j in range(i + 1, len(sigs)):
                if _cadence_close(vecs[i], vecs[j]):
                    ri, rj = find(i), find(j)
                    if ri != rj:
                        parent[ri] = rj
        # signatures with no measured numbers keep exact-match grouping
        cluster = {}
        for i, sg in enumerate(sigs):
            cluster[sg] = f"c{find(i)}" if vecs[i] is not None else sg
        for c in cs:
            key = (fam, cluster[c.dash_signature])
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
