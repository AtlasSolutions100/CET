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

## 4. CSV export (new feature) + itemized computation extracted

- `renderItemized`'s computation (label totals, EA object counts, qty/ft
  overrides, prices, trade grouping/sorting) is extracted verbatim into
  `computeTakeoffRows()`; the panel and the new CSV both consume it, so
  they can never disagree. Rendering output is unchanged.
- New "CSV" button in the approve bar (left of Approve & export), enabled
  whenever a result is loaded. Client-side blob download named
  `<doc>_p<N>_takeoff.csv`. Columns: label, trade, count/EA (line count
  for LF rows, "N EA"/"N CY" for counted/calculator rows), feet (pt when
  no scale), $/ft, ext $; TOTAL row when anything is priced. Overrides
  and prices are included exactly as the panel shows them.

## 5. Visual pass (CSS only — no behavior change)

- **One accent color.** The per-tool button rainbow is gone: Analyze
  (was purple), Earthwork (brown), Trench (teal), Count (purple) are now
  quiet chrome buttons; primary actions (Detect, Approve, calculator
  Calculate/Add buttons, faithful-pattern active state) use the single
  green accent. The Analyze banner is neutral panel + accent edge instead
  of purple. Kept deliberately: dash-class badges (data encoding), the
  magenta measure tool (matches its canvas ink), EXIST/PROP green/blue
  (surface encoding), red danger states.
- **Less border noise, 8px rhythm.** Section headers no longer carry
  full-width bottom borders; hierarchy comes from spacing and label
  weight. Paddings normalized to the 4/8/12 grid. Border-radius unified
  at 7-8px. Slim custom scrollbars on the data panes. `:focus-visible`
  accent outline for keyboard use.
- Both themes intact: every new rule uses the existing CSS variables;
  dark stays default, paper theme unchanged apart from inheriting the
  same cleanups.
