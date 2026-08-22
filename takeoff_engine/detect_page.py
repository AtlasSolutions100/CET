"""Per-page detection pipeline, runnable in a child process.

This is the body of what used to be ``server._detect_worker``: open the
PDF, extract units, chain them, read the legend, detect scale / fills /
openings, flag texture styles, and write ``p{page}_result.json``.

It lives here - and NOT in server.py - because the service runs it in a
``multiprocessing`` child (spawn context). The child re-imports the target
function's module; if that module were ``server`` it would re-create the
FastAPI app, reload the job registry and mount static files on every
page. This module must therefore never import ``server``.

Contract: ``run_detect(pdf_path, page, job_dir)`` writes
``<job_dir>/p{page}_result.json`` with exactly the keys and content the
thread worker wrote. On failure it writes ``<job_dir>/p{page}_error.txt``
with the exception text (so the parent can surface ``error: <reason>``
across the process boundary) and re-raises.
"""

import json
from collections import defaultdict
from pathlib import Path

import pymupdf

from .chain import build_chains
from .classify_page import classify_page
from .extract import extract_strokes, page_words
from .legend_detect import read_legend
from .scale_detect import detect_scale


def result_path(job_dir: str, page: int) -> Path:
    return Path(job_dir) / f"p{page}_result.json"


def error_path(job_dir: str, page: int) -> Path:
    return Path(job_dir) / f"p{page}_error.txt"


def run_detect(pdf_path: str, page: int, job_dir: str) -> None:
    out_dir = Path(job_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    try:
        result = detect_page(pdf_path, page)
        result_path(job_dir, page).write_text(json.dumps(result))
    except Exception as e:  # surfaced to the UI by the parent process
        try:
            error_path(job_dir, page).write_text(str(e))
        except OSError:
            pass
        raise


def detect_page(pdf_path: str, page: int) -> dict:
    """The pure pipeline: returns the result dict for one page."""
    doc = pymupdf.open(pdf_path)
    pg = doc[page]
    pc = classify_page(pg)
    if pc.kind == "raster":
        from .raster import extract_raster_units

        words: list = []
        units = extract_raster_units(pg, words_out=words)
    else:
        units = extract_strokes(pg)
        words = page_words(pg)
        has_layers = any(u.layer for u in units[:300])
        if pc.text_chars < 1500 and not has_layers:
            # sparse text + no CAD layers = exploded annotations with no
            # metadata; OCR fills in word boxes for junk pruning +
            # dash-text labels. Layered pages skip OCR - layer names are
            # strictly better metadata and OCR words only add noise.
            try:
                import numpy as _np

                from .text_detect import ocr_words

                _pix = pg.get_pixmap(matrix=pymupdf.Matrix(150 / 72, 150 / 72),
                                     colorspace="rgb")
                _img = _np.frombuffer(_pix.samples, dtype=_np.uint8).reshape(
                    _pix.height, _pix.width, 3)
                words = list(words) + ocr_words(_img, px_to_pt=72.0 / 150)
            except Exception:
                pass
        if pc.kind == "hybrid":
            from .raster import extract_hybrid_image_units

            units.extend(extract_hybrid_image_units(pg))
    chains = build_chains(units, words=words)

    _legend_labels: dict = {}
    styles: dict = defaultdict(lambda: {
        "n": 0, "length_pt": 0.0, "class": "", "color": None,
        "width": 0.0, "layer": "", "signature": "",
    })
    for c in chains:
        s = styles[c.style_id]
        s["n"] += 1
        s["length_pt"] += c.length
        s["class"] = c.klass
        s["color"] = c.color
        s["width"] = c.width
        s["layer"] = c.layer
        s["signature"] = c.dash_signature
    style_list = []
    for sid, s in styles.items():
        label = s["layer"].split("|")[-1] if s["layer"] else \
            f'{s["class"]} {s["signature"]}'.strip()
        label = _legend_labels.get(sid, label)
        style_list.append({
            "style_id": sid, "suggested_label": label,
            "length_pt": round(s["length_pt"], 1), **{
                k: s[k] for k in ("n", "class", "color", "width",
                                  "layer", "signature")},
        })
    style_list.sort(key=lambda s: -s["length_pt"])

    # legend reading: OCR words help here even on layered pages (the
    # legend text is often exploded strokes); these words are used ONLY
    # for the legend, not for chaining
    words_legend = list(words)
    if pc.text_chars < 1500 and pc.kind != "raster":
        try:
            import numpy as _np2

            from .text_detect import ocr_words as _ocr

            _pix2 = pg.get_pixmap(matrix=pymupdf.Matrix(150 / 72, 150 / 72),
                                  colorspace="rgb")
            _img2 = _np2.frombuffer(_pix2.samples, dtype=_np2.uint8).reshape(
                _pix2.height, _pix2.width, 3)
            words_legend += _ocr(_img2, px_to_pt=72.0 / 150)
        except Exception:
            pass
    legend = read_legend(words_legend, chains, units=units)
    _legend_labels.update(legend["style_labels"])
    # swatch locations: the legend's own sample bars must never be
    # counted as takeoff objects (Belle p2 grew a 25th 'shear wall')
    legend_samples = [e["sample_box"] for e in legend.get("entries", [])
                      if e.get("sample_box")]
    # the swatch bars themselves are sheet furniture: demote the
    # chains living inside the legend strips so they never reach the
    # style pool as takeoff linework
    import numpy as _np
    for c in chains:
        if c.klass == "annotation" or len(c.pts) < 2:
            continue
        m = _np.asarray(c.pts).mean(axis=0)
        for b in legend_samples:
            if b[0]-6 <= m[0] <= b[2]+6 and b[1]-8 <= m[1] <= b[3]+8 \
                    and c.length <= 1.5 * (b[2] - b[0]):
                c.klass = "annotation"
                c.dash_signature = "legend swatch"
                break
    for st in style_list:
        if st["style_id"] in _legend_labels:
            st["suggested_label"] = _legend_labels[st["style_id"]] + " (legend)"
    scale = detect_scale(pg).to_dict()
    from .extract import fill_boxes, door_swings
    try:
        fills = fill_boxes(pg)
    except Exception:
        fills = []
    try:
        openings = door_swings(
            units, (scale or {}).get("ft_per_paper_inch"), words)
    except Exception:
        openings = []
    # texture styles: a shading fill is MANY parallel chains at a tight
    # regular pitch. Measured: GCHC 'SHADING ASPHALT' strips pitch
    # 1-4pt; real parallel features sit far wider (contours 20-40pt,
    # curb pairs are 2 members). Flagged styles default OFF in the UI
    # and render faint - they are area shading, not takeoff linework.
    by_style_chains = {}
    for c in chains:
        by_style_chains.setdefault(c.style_id, []).append(c)
    for st in style_list:
        cs = by_style_chains.get(st["style_id"], [])
        st["texture"] = False
        if len(cs) < 15:
            continue
        dirs = []
        mids = []
        for c in cs:
            pts = _np.asarray(c.pts)
            v = pts[-1] - pts[0]
            n = float(_np.hypot(*v))
            if n < 1e-6:
                continue
            dirs.append(v / n)
            mids.append(pts.mean(axis=0))
        if len(dirs) < 15:
            continue
        D = _np.asarray(dirs)
        ang = _np.arctan2(D[:, 1], D[:, 0]) * 2
        R = float(_np.hypot(_np.mean(_np.cos(ang)), _np.mean(_np.sin(ang))))
        if R < 0.80:
            continue  # 0.80: GCHC EXST-CONCRETE shading bends with the
                      # slope and measured R=0.84; real mixed-direction
                      # linework sits far lower (L-PVMT-CONC: 0.21)
        mean_ang = _np.arctan2(_np.mean(_np.sin(ang)), _np.mean(_np.cos(ang))) / 2
        nrm = _np.array([-_np.sin(mean_ang), _np.cos(mean_ang)])
        off = _np.sort(_np.asarray(mids) @ nrm)
        gaps = _np.diff(off)
        gaps = gaps[gaps > 0.05]
        # pitch 9.0: measured shading pitches 1-4pt (GCHC South) and
        # 6.2-6.6pt (GCHC North EXST-CONCRETE, escaped the first 6.0
        # gate by 0.2-0.6pt); nearest real parallel features are
        # contour fields at 18-40pt - margin stays > 2x
        if len(gaps) >= 10 and float(_np.median(gaps)) <= 9.0:
            st["texture"] = True
    return {
        "page": pc.to_dict(),
        "scale": scale,
        "legend": legend["entries"],
        "styles": style_list,
        "chains": [c.to_dict() for c in chains],
        "fills": fills,
        "openings": openings,
        "legend_samples": legend_samples,
    }
