"""Debug/demo overlay: render the page and draw detected chains on top,
colored by class, so detection quality is visible at a glance."""

import numpy as np
import pymupdf
from PIL import Image, ImageDraw

CLASS_COLORS = {
    "solid": (0, 160, 60),
    "dash1": (230, 60, 40),
    "dash2": (30, 90, 230),
    "dash3": (240, 150, 0),
    "dash-text": (170, 0, 200),
}


def render_overlay(
    page: pymupdf.Page,
    chains: list,
    dpi: int = 150,
    classes: set | None = None,
    line_width: int = 3,
    dim_background: bool = True,
    mode: str = "class",
) -> Image.Image:
    """mode="class": chains colored by detected class (analysis view).
    mode="style": chains drawn in their SOURCE color at weight-scaled
    width - "the original, but only what we detected." Faithful for human
    verification: a hole is a miss, a line that looks wrong IS wrong."""
    scale = dpi / 72.0
    pix = page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), colorspace="rgb")
    img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
    if dim_background:
        img = Image.blend(img, Image.new("RGB", img.size, (255, 255, 255)), 0.55)
    draw = ImageDraw.Draw(img)

    for c in chains:
        if classes is not None and c.klass not in classes:
            continue
        if mode == "style":
            src = c.color or (0.2, 0.2, 0.2)
            rgb = tuple(int(v * 255) for v in src)
            # very light strokes stay visible against the dimmed sheet
            if min(rgb) > 210:
                rgb = (150, 150, 150)
            width = max(2, min(7, int(round((c.width or 0.5) * 2.2))))
            color = rgb
        else:
            color = CLASS_COLORS.get(c.klass, (120, 120, 120))
            width = line_width
        pts = (np.asarray(c.pts) * scale).tolist()
        if len(pts) >= 2:
            draw.line([tuple(p) for p in pts], fill=color, width=width)
    return img
