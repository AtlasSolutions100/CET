# webui restyle — branch ui-kreo

Restyling toward modern takeoff-tool conventions (Kreo/STACK class).
Every behavior touched is listed here. Vanilla JS/CSS, no server changes
unless noted. Canvas interaction code (pan/zoom/click/draw) untouched.

## 1. Page thumbnail strip (new feature)

- New left-edge `<nav id="pageStrip">`: one thumbnail per page of the open
  PDF, served by the **existing** `/api/job/{id}/page/{p}/image` endpoint at
  `dpi=28` (server caches one PNG per page+dpi — no server change needed).
- Click a thumbnail → switches page (same path as the page dropdown, which
  is preserved; the dropdown and strip stay in sync both ways).
- Detection badge per page: hollow = not detected, amber pulse = running,
  green = done, red = error. Statuses seeded on document open via the
  existing per-page `/status` endpoint.
- "Detect all" button: fires the existing per-page `/detect` endpoint
  sequentially, polling `/status` per page; badges update live; pages
  already detected are skipped. Clicking again stops the sweep after the
  current page (the page already started keeps running server-side; its
  badge stays amber until refreshed/reopened). If the user is viewing a
  page when its detect finishes, the result loads live.
- Collapsible (persisted in localStorage `core-pagestrip`).
- Hooks added: `openPath` resets/renders the strip; `selectPage` marks the
  current thumb; single-page Detect and `poll()` now update the badge for
  the current page. No other behavior changed.
