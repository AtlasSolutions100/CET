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

## 2. Vertical tool rail + canvas status pill (restyle only)

- The toolkit (measure/split/extend/cut-span/draw/reclassify/separate/
  delete/faithful) is now a slim vertical icon rail on the canvas's left
  edge. Same buttons, same IDs, same tooltips, same shortcuts — CSS only.
- `#selInfo` and `#measureInfo` moved out of the rail into a floating
  pill (`.canvas-status`) bottom-center of the canvas. IDs unchanged, so
  all JS that writes them is untouched. Empty selInfo collapses via
  `:empty` so no ghost pill shows.
- Mini legend nudged from `left:12px` to `left:64px` so a tall rail can
  never overlap it on short windows.

## 3. Sidebar hierarchy (restructure + one unit change)

- New sheet header at the sidebar top (`#sheetHead`): doc name, "Sheet
  N / M", page kind, scale chip (green when found, red "no scale" when
  not), detection status chip. Status chip mirrors the thumbnail badge
  live via `setPageStatus`.
- Sidebar order is now: sheet header → Sheet legend → Line styles →
  Itemized takeoff → calculator panels (earthwork/trench/callouts/count)
  → approve bar. All element IDs unchanged; the four calculator panels
  moved below the takeoff in the DOM only.
- Sheet legend got a real collapsible section header (`#legendHead`,
  wired into the existing SECTIONS toggle); the old inline label div
  inside `#legendBox` was removed. Re-render respects a user collapse.
- "Detected line styles" header renamed "Line styles"; the style search
  box and color chips now live inside that section and collapse with it.
- **Unit change:** style-row meta and the selection pill now lead with
  quantity in feet when the sheet has a scale (`fmtQty`, e.g. "1.2k LF"),
  falling back to pt verbatim when there is no scale. Line count and
  signature are still shown. Itemized takeoff/mini legend already used
  feet; this aligns the style list with them.
