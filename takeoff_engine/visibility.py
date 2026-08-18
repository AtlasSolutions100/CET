"""Render-visibility filter.

CAD PDFs can carry geometry the renderer never shows (optional-content
configs, membership dictionaries, xref leftovers). Enumerating every hiding
mechanism is a losing game - C8.0's contours are hidden by machinery that
neither get_ocgs nor /OCProperties/D/OFF reveals. So ask the only authority
that matters: the renderer. Chains whose sampled geometry lands on blank
paper in the rendered page did not appear to the human either, and must not
appear in the takeoff.
"""

import cv2
import numpy as np
import pymupdf

from .chain import _sample_polyline

# render resolution for the ink mask; 100dpi keeps it cheap and is plenty
# to decide ink-vs-paper
DPI = 100
# a sample counts as "on ink" if rendered ink lies within this many px
NEAR_PX = 3.0
# chains with less than this fraction of samples on ink are invisible.
# Visible dashed lines score >=0.5 (gap centers sit close to dash ends);
# hidden-layer chains score ~0.
MIN_INK_FRAC = 0.22


def filter_invisible(page: pymupdf.Page, chains: list) -> tuple[list, list]:
    """Split chains into (visible, hidden) using the rendered page."""
    scale = DPI / 72.0
    pix = page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), colorspace="gray")
    img = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width)
    ink = (img < 235).astype(np.uint8)
    # distance from every pixel to the nearest ink pixel
    dist = cv2.distanceTransform(1 - ink, cv2.DIST_L2, 3)

    visible, hidden = [], []
    h, w = ink.shape
    for c in chains:
        samples, _ = _sample_polyline(np.asarray(c.pts), step=8.0, max_n=80)
        if len(samples) == 0:
            visible.append(c)
            continue
        px = np.clip((samples * scale).astype(int), [0, 0], [w - 1, h - 1])
        near = dist[px[:, 1], px[:, 0]] <= NEAR_PX
        if float(near.mean()) >= MIN_INK_FRAC:
            visible.append(c)
        else:
            hidden.append(c)
    return visible, hidden
