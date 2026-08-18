# Wiring the detection service into TakeoffDraft2

STATUS: implemented and typecheck-verified locally (2026-08-17). What
exists now:

- `POST /api/pages/{pageId}/elements/import` in the api-server
  (routes/elements.ts), spec'd in openapi.yaml (`importElements`), codegen
  ran (api-zod + api-client-react regenerated).
- "Import detected lines" button in the project sidebar (project.tsx):
  select a page, pick the exported elements.json, elements land on the
  page and flow into the takeoff summary/pricing.
- Vertex rescaling: the route rescales from the export's pixel space
  (pageWidthPt * imageDpi/72) to the page's stored imageWidth, so
  registration holds even if the app rasterized at a different DPI.
- No DB schema change was needed.

UPDATE (same day): Replit is out entirely. The app now runs self-hosted:

- **Storage**: pluggable driver (`storageProvider.ts`). `LOCAL_STORAGE_DIR`
  -> local disk (`localObjectStorage.ts`, presigned-style PUT at
  `/api/storage/local-upload/{uuid}`); otherwise legacy Replit/GCS. S3
  driver is the planned third for AWS prod (same interface).
- **Auth**: `DEV_FAKE_USER` env bypasses Clerk server-side; client runs
  without `VITE_CLERK_PUBLISHABLE_KEY` in dev mode (`lib/appAuth.ts`).
  Clerk still works when keys are present (it is Replit-independent) -
  keep it or swap for Cognito when building AWS prod.
- **Runbook**: `TakeoffDraft2/dev-local.sh` (Postgres 16 in Docker on
  :5433, api on :5001 - macOS AirPlay owns :5000 - web on :5173 with
  /api proxied).
- **pnpm-workspace.yaml**: removed Replit's darwin-binary-stripping
  overrides; added darwin+linux supportedArchitectures; run
  `pnpm approve-builds --all` once after install.

**Live E2E verified locally**: create project -> upload PDF (client
rasterizes -> PUT to local storage) -> page created -> import detection
export -> 486 elements render registered on the canvas. Note: client-side
300-DPI rasterization is slow (minutes/page in embedded browsers) - moving
rasterization into the detection service is the planned fix.

Local toolchain notes (macOS x64 + nvm): the repo's lockfile was born on
Linux, so `pnpm install` misses the darwin esbuild binary - fetch
`@esbuild/darwin-x64` via `npm pack` and export
`ESBUILD_BINARY_PATH=<.../bin/esbuild>` before codegen/typecheck. Also
`@clerk/shared` and `core-js` were added to `onlyBuiltDependencies` in
pnpm-workspace.yaml to satisfy pnpm 11's build-script approval.

## Original design notes

The endpoint accepts the exported JSON:

```jsonc
{ "imageDpi": 300, "pageWidthPt": 2592, "elements": [
    { "type": "line", "label": "Continuous Footing", "color": "#ff0000",
      "vertices": [{"x": 4657.4, "y": 3400.0}, ...] } ] }
```

Per element insert into `elementsTable` (pageId, type, label, color,
vertices). One correction at import time: if the page's stored
`imageWidth` differs from `pageWidthPt * imageDpi / 72` (the app may have
rasterized at a different effective DPI), scale vertices by
`imageWidth / (pageWidthPt * imageDpi / 72)`.

Pricing needs no work: it already keys off (label, elementType), so
imported lines join the Pricing tab as soon as a unit price exists for
their label.

## 2. Import UI (takeoff artifact)

A file-input button on the project page ("Import detected lines") posting
the JSON to the endpoint, then invalidating the elements query. ~40 lines.

## 3. Later: skip the file hop

Store the original PDF at upload (today only the rasterized PNGs are
kept), then let the api-server call this service directly:
`POST http://<service>/api/open-path` + `/detect` + `/approve`, importing
the result server-side. The review UI can then be embedded via iframe or
its style-list ported into the app. Until then the manual
export/import file hop works and keeps the systems decoupled.

## Running the service

```bash
cd detection-engine && python3 -m uvicorn server:app --port 8100
```

Open http://localhost:8100 - pick a sample or paste a PDF path, Detect,
review styles (click = isolate, checkbox = include, label = editable),
Approve & export. Exports land in `out/jobs/<job>/p<N>_elements.json`.
