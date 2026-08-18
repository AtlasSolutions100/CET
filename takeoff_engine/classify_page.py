"""Per-page input classification: vector / raster / hybrid.

Every downstream decision routes on this. A page that is mostly covered by
one large image is a raster page no matter how many stray paths it carries
(borders, stamps); a page with thousands of stroke paths and no significant
image coverage is a clean CAD export.
"""

from dataclasses import dataclass, asdict

import pymupdf


@dataclass
class PageClass:
    page_index: int
    kind: str  # "vector" | "raster" | "hybrid"
    path_count: int
    image_coverage: float  # fraction of page area covered by raster images
    text_chars: int
    width_pt: float
    height_pt: float

    def to_dict(self) -> dict:
        return asdict(self)


# Below this many stroke paths a page cannot meaningfully be a vector drawing;
# title-block borders alone are usually ~10-50 paths.
MIN_VECTOR_PATHS = 200
# Above this image coverage the raster content dominates the sheet.
RASTER_COVERAGE = 0.5
# Between these, images are present but vector linework still carries signal.
HYBRID_COVERAGE = 0.05


def classify_page(page: pymupdf.Page) -> PageClass:
    path_count = len(page.get_drawings())
    page_area = max(page.rect.width * page.rect.height, 1.0)

    img_area = 0.0
    for info in page.get_image_info():
        x0, y0, x1, y1 = info["bbox"]
        # Clip to the page: CAD exports sometimes place images with bboxes
        # hanging off-sheet.
        x0, y0 = max(x0, page.rect.x0), max(y0, page.rect.y0)
        x1, y1 = min(x1, page.rect.x1), min(y1, page.rect.y1)
        if x1 > x0 and y1 > y0:
            img_area += (x1 - x0) * (y1 - y0)
    coverage = min(img_area / page_area, 1.0)

    if coverage >= RASTER_COVERAGE and path_count < MIN_VECTOR_PATHS:
        kind = "raster"
    elif path_count >= MIN_VECTOR_PATHS and coverage < HYBRID_COVERAGE:
        kind = "vector"
    elif path_count >= MIN_VECTOR_PATHS:
        kind = "hybrid"
    else:
        # Few paths, little image coverage: near-empty sheet or a scan whose
        # image bbox metadata is odd. If any image exists, call it raster.
        kind = "raster" if img_area > 0 else "vector"

    return PageClass(
        page_index=page.number,
        kind=kind,
        path_count=path_count,
        image_coverage=round(coverage, 3),
        text_chars=len(page.get_text()),
        width_pt=page.rect.width,
        height_pt=page.rect.height,
    )
