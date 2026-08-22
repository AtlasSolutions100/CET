"""Detection service + classify-and-approve review UI.

Run:  python3 -m uvicorn server:app --port 8100

Workflow (the estimator's 5-minute loop):
  open a plan -> pick a page -> Detect -> review discovered line styles
  (overlay, counts, lengths, suggested labels) -> relabel / include ->
  Approve -> elements JSON in TakeoffDraft2 format is saved + downloadable.

The service holds detection results per (document, page) on disk under
out/jobs/, so re-opening a document reuses finished work.
"""

import json
import multiprocessing
import os
import threading
import time
import uuid
from collections import deque
from pathlib import Path

import pymupdf
from fastapi import FastAPI, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from takeoff_engine.chain import build_chains
from takeoff_engine.classify_page import classify_page
from takeoff_engine.detect_page import error_path, result_path, run_detect
from takeoff_engine.extract import extract_strokes, page_words
from takeoff_engine.marks import read_mark_schedule
from takeoff_engine.scale_detect import detect_scale

ROOT = Path(__file__).parent
JOBS_DIR = ROOT / "out" / "jobs"
JOBS_DIR.mkdir(parents=True, exist_ok=True)
SAMPLES_DIR = (ROOT / ".." / "TakeoffPro AI").resolve()

# Filesystem exposure. /api/open-path and /api/legend-sheet take a path
# from the client, and /api/samples lists plans on disk - fine on a laptop,
# an arbitrary-file read on a hosted box. Both are confined to PLAN_ROOTS:
#   TAKEOFF_PLAN_ROOTS  os.pathsep-separated directories (default: the
#                       local plan corpus + client_meet next to this repo,
#                       and our own upload dir)
#   TAKEOFF_HOSTED=1    hosted mode - open-path/legend-sheet paths are
#                       refused outright (uploads only) and /api/samples
#                       is empty, so one tenant never sees another's files
HOSTED = os.environ.get("TAKEOFF_HOSTED", "").strip().lower() in ("1", "true", "yes")
_roots_env = os.environ.get("TAKEOFF_PLAN_ROOTS", "").strip()
PLAN_ROOTS = [Path(r).expanduser().resolve()
              for r in (_roots_env.split(os.pathsep) if _roots_env else [])
              if r.strip()] or [
    SAMPLES_DIR,
    (ROOT / ".." / "client_meet").resolve(),
    JOBS_DIR.resolve(),
]


def _under_roots(p: Path) -> bool:
    """True when the RESOLVED path sits inside one of PLAN_ROOTS. Resolving
    first defeats ../ traversal and symlink tricks; a non-existent path is
    never allowed."""
    try:
        rp = p.expanduser().resolve(strict=True)
    except (OSError, RuntimeError):
        return False
    for root in PLAN_ROOTS:
        try:
            rp.relative_to(root)
            return True
        except ValueError:
            continue
    return False


def _client_pdf(raw: str) -> Path:
    """Validate a client-supplied PDF path or raise the right HTTP error."""
    if HOSTED:
        raise HTTPException(403, "path access is disabled on the hosted "
                                 "service - upload the PDF instead")
    p = Path(raw).expanduser()
    if not _under_roots(p) or p.suffix.lower() != ".pdf" or not p.is_file():
        # one message for missing and forbidden: a probe must not learn
        # which paths exist outside the roots
        raise HTTPException(404, "not an accessible PDF")
    return p.resolve()

app = FastAPI(title="Takeoff Detection Service")

# Optional site password: set TAKEOFF_UI_PASSWORD to require HTTP Basic
# auth on every request (username is ignored). Meant for exposing the
# review UI through a tunnel for remote demos.
_UI_PASSWORD = os.environ.get("TAKEOFF_UI_PASSWORD")
if _UI_PASSWORD:
    import base64 as _b64
    import secrets as _secrets

    from starlette.middleware.base import BaseHTTPMiddleware
    from starlette.responses import Response as _StarResponse

    class _BasicAuth(BaseHTTPMiddleware):
        async def dispatch(self, request, call_next):
            hdr = request.headers.get("authorization", "")
            ok = False
            if hdr.startswith("Basic "):
                try:
                    creds = _b64.b64decode(hdr[6:]).decode()
                    ok = _secrets.compare_digest(
                        creds.split(":", 1)[1], _UI_PASSWORD)
                except Exception:
                    ok = False
            if not ok:
                return _StarResponse(
                    "password required", status_code=401,
                    headers={"WWW-Authenticate": 'Basic realm="takeoff"'})
            return await call_next(request)

    app.add_middleware(_BasicAuth)

# job_id -> {"path": str, "pages": int, "status": {page: "running"|"done"|"error:..."}}
JOBS: dict = {}
JOBS_LOCK = threading.Lock()
REGISTRY = JOBS_DIR / "registry.json"


def _save_registry() -> None:
    """Jobs live in memory, but detection results live on disk - so without
    this a service restart answers 'unknown job' for work that is sitting
    right there, and the page has to be detected again."""
    try:
        REGISTRY.write_text(json.dumps(
            {jid: {"path": j["path"], "pages": j["pages"],
                   "mtime": j.get("mtime"), "kinds": j.get("kinds"),
                   "sizes": j.get("sizes")}
             for jid, j in JOBS.items()}, indent=1))
    except OSError:
        pass


def _load_registry() -> None:
    if not REGISTRY.exists():
        return
    try:
        saved = json.loads(REGISTRY.read_text())
    except (OSError, ValueError):
        return
    for jid, j in saved.items():
        if not Path(j.get("path", "")).exists():
            continue  # the PDF moved; a stale entry would fail confusingly
        status = {}
        d = JOBS_DIR / jid
        if d.is_dir():
            for f in d.glob("p*_result.json"):
                try:
                    status[int(f.name[1:].split("_")[0])] = "done"
                except ValueError:
                    continue
        JOBS[jid] = {"path": j["path"], "pages": j.get("pages", 0),
                     "mtime": j.get("mtime"), "kinds": j.get("kinds"),
                     "sizes": j.get("sizes"), "status": status}


_load_registry()


def _job_dir(job_id: str) -> Path:
    d = JOBS_DIR / job_id
    d.mkdir(parents=True, exist_ok=True)
    return d


class OpenPathBody(BaseModel):
    path: str


@app.get("/api/samples")
def list_samples():
    """Convenience: sample plans on this machine, for quick opening.
    Confined to PLAN_ROOTS (minus our own upload dir); empty when hosted."""
    out = []
    if HOSTED:
        return out
    for root in PLAN_ROOTS:
        if root == JOBS_DIR.resolve() or not root.is_dir():
            continue
        for p in sorted(root.rglob("*.pdf")):
            try:
                size = p.stat().st_size
            except OSError:
                continue
            if size > 50_000:
                out.append({"path": str(p), "name": p.name, "mb": round(size / 1e6, 1)})
    return out[:200]


def _register(path: Path, classify: bool = True) -> dict:
    """classify=False skips per-page vector/raster classification, which
    reads every drawing on every page. Rasterisation callers do not need it,
    and on a large package it dominates the cost of simply opening the file.

    Re-opening the SAME file (path + mtime) reuses its job: detect results,
    images, and the pinned AI verdict all live in the job dir, and a takeoff
    must come back identical when the same plan is opened twice."""
    doc = pymupdf.open(path)
    mtime = round(path.stat().st_mtime, 2)
    with JOBS_LOCK:
        for jid, j in JOBS.items():
            if j.get("path") == str(path) and j.get("mtime") == mtime:
                kinds0 = j.get("kinds")
                sizes0 = j.get("sizes")
                if kinds0 and sizes0:
                    doc.close()
                    return {"job_id": jid, "pages": j["pages"],
                            "kinds": kinds0, "sizes": sizes0,
                            "name": Path(path).name}
    job_id = uuid.uuid4().hex[:12]
    with JOBS_LOCK:
        JOBS[job_id] = {"path": str(path), "pages": doc.page_count,
                        "mtime": mtime, "status": {}}
        _save_registry()
    kinds, sizes = [], []
    for p in range(doc.page_count):
        kinds.append(classify_page(doc[p]).kind if classify else "unknown")
        r = doc[p].rect
        sizes.append([round(r.width, 2), round(r.height, 2)])
    doc.close()
    with JOBS_LOCK:
        JOBS[job_id]["kinds"] = kinds
        JOBS[job_id]["sizes"] = sizes
        _save_registry()
    # sizes let a caller compute exact raster pixel dimensions without
    # decoding an image (a 36x24in sheet at 300dpi is 78 megapixels)
    return {"job_id": job_id, "pages": len(kinds), "kinds": kinds,
            "sizes": sizes, "name": Path(path).name}


@app.post("/api/open-path")
def open_path(body: OpenPathBody):
    return _register(_client_pdf(body.path))


@app.post("/api/upload")
async def upload(file: UploadFile, classify: int = 1):
    dest = JOBS_DIR / f"upload_{uuid.uuid4().hex[:8]}_{file.filename}"
    dest.write_bytes(await file.read())
    return _register(dest, classify=bool(classify))


@app.get("/api/job/{job_id}/page/{page}/image")
def page_image(job_id: str, page: int, dpi: int = 130):
    job = JOBS.get(job_id) or _404()
    cache = _job_dir(job_id) / f"p{page}_{dpi}.png"
    if not cache.exists():
        doc = pymupdf.open(job["path"])
        pix = doc[page].get_pixmap(matrix=pymupdf.Matrix(dpi / 72, dpi / 72))
        pix.save(cache)
        doc.close()
    return FileResponse(cache, media_type="image/png")


def _404():
    raise HTTPException(404, "unknown job")


# ---------- detection scheduler: one child PROCESS per page ----------
# Detection used to run in a thread inside the web process. One heavy sheet
# pinned the CPU and the GIL (the extract/chain hot loops are C calls that
# never release it), so page images, samples and status stalled for seconds,
# nothing capped concurrency, and nothing could kill a runaway page
# (python-level SIGALRM budgets never fire inside a C call - FINDINGS F23).
# Each page now runs in a spawned child process (takeoff_engine.detect_page
# .run_detect, which writes the same p{page}_result.json): the web process
# stays responsive, at most TAKEOFF_WORKERS children run at once (FIFO
# beyond that), and a child over TAKEOFF_PAGE_BUDGET_S is terminated.
# Default cap is 4, not cpu_count-1: a heavy sheet (Barn civil p3, 412k
# paths) peaks at multiple GB, so 15 concurrent children on a 16-core box
# would swap long before they ran out of cores. Raise TAKEOFF_WORKERS on a
# box sized for it.
TAKEOFF_WORKERS = max(1, int(os.environ.get("TAKEOFF_WORKERS")
                             or min(4, max(1, (os.cpu_count() or 2) - 1))))
TAKEOFF_PAGE_BUDGET_S = float(os.environ.get("TAKEOFF_PAGE_BUDGET_S") or 900)
_MP = multiprocessing.get_context("spawn")
_SCHED = threading.Condition()          # guards the two containers below
_SCHED_QUEUE: deque = deque()           # (job_id, page) FIFO, not started yet
_SCHED_RUNNING: dict = {}               # (job_id, page) -> {"proc", "t0"}
_SCHED_THREAD: list = []                # [Thread] once the watcher is up


def _sched_start_locked(job_id: str, page: int) -> None:
    job = JOBS[job_id]
    proc = _MP.Process(
        target=run_detect, args=(job["path"], page, str(_job_dir(job_id))),
        name=f"detect-{job_id}-p{page}", daemon=True)
    proc.start()
    _SCHED_RUNNING[(job_id, page)] = {"proc": proc, "t0": time.time()}


def _sched_fill_locked() -> None:
    while _SCHED_QUEUE and len(_SCHED_RUNNING) < TAKEOFF_WORKERS:
        job_id, page = _SCHED_QUEUE.popleft()
        try:
            _sched_start_locked(job_id, page)
        except Exception as e:  # spawn itself failed; surface like any error
            JOBS[job_id]["status"][page] = f"error: could not start worker: {e}"


def _sched_finish_locked(key: tuple, reason: str | None = None) -> None:
    """Record the outcome of a child that has exited (reason=None: read it
    off the disk) or that we killed (reason given: clean partial files)."""
    job_id, page = key
    proc = _SCHED_RUNNING.pop(key)["proc"]
    d = _job_dir(job_id)
    rf, ef = result_path(d, page), error_path(d, page)
    if reason is None:
        if rf.exists():
            st = "done"
        elif ef.exists():
            try:
                st = f"error: {ef.read_text()}"
            except OSError:
                st = "error: detection failed"
        else:
            st = f"error: worker exited with code {proc.exitcode}"
    else:
        st = reason
        rf.unlink(missing_ok=True)  # a kill mid-write leaves a truncated file
    ef.unlink(missing_ok=True)
    try:
        proc.close()
    except Exception:
        pass
    job = JOBS.get(job_id)
    if job is not None:
        job["status"][page] = st


def _sched_loop() -> None:
    """Watcher: reap finished children, kill over-budget ones, start queued."""
    while True:
        with _SCHED:
            _SCHED.wait(timeout=0.25)
            now = time.time()
            for key, info in list(_SCHED_RUNNING.items()):
                proc = info["proc"]
                if not proc.is_alive():
                    proc.join()
                    _sched_finish_locked(key)
                elif now - info["t0"] > TAKEOFF_PAGE_BUDGET_S:
                    proc.terminate()
                    proc.join(10)
                    _sched_finish_locked(
                        key, f"error: timeout after {TAKEOFF_PAGE_BUDGET_S:g}s")
            _sched_fill_locked()


def _enqueue_detect(job_id: str, page: int) -> bool:
    """Queue a page for detection; returns True if it was already queued or
    running (so a double-click / a detect-all pass never runs a page twice)."""
    key = (job_id, page)
    with _SCHED:
        if key in _SCHED_RUNNING or key in _SCHED_QUEUE:
            return True
        JOBS[job_id]["status"][page] = "running"
        _SCHED_QUEUE.append(key)
        if not _SCHED_THREAD:
            t = threading.Thread(target=_sched_loop, name="detect-scheduler",
                                 daemon=True)
            t.start()
            _SCHED_THREAD.append(t)
        _sched_fill_locked()
        _SCHED.notify()
        return False


def _is_queued(job_id: str, page: int) -> bool:
    with _SCHED:
        return (job_id, page) in _SCHED_QUEUE


def _detect_worker(job_id: str, page: int):
    """Synchronous in-process detection (scripts / tests). The service itself
    goes through _enqueue_detect; this keeps the old entry point callable."""
    job = JOBS[job_id]
    try:
        run_detect(job["path"], page, str(_job_dir(job_id)))
        job["status"][page] = "done"
    except Exception as e:  # surfaced to the UI
        job["status"][page] = f"error: {e}"
        raise
    finally:
        error_path(_job_dir(job_id), page).unlink(missing_ok=True)


@app.post("/api/job/{job_id}/page/{page}/detect")
def detect(job_id: str, page: int):
    job = JOBS.get(job_id) or _404()
    if job["status"].get(page) == "running":
        return {"status": "running", "queued": _is_queued(job_id, page)}
    if (_job_dir(job_id) / f"p{page}_result.json").exists():
        job["status"][page] = "done"
        return {"status": "done"}
    _enqueue_detect(job_id, page)
    return {"status": "running", "queued": _is_queued(job_id, page)}


@app.get("/api/job/{job_id}/page/{page}/status")
def status(job_id: str, page: int):
    job = JOBS.get(job_id) or _404()
    st = job["status"].get(page)
    if st is None and (_job_dir(job_id) / f"p{page}_result.json").exists():
        st = "done"
    out = {"status": st or "idle"}
    if st == "running" and _is_queued(job_id, page):
        out["queued"] = True
    return out


@app.get("/api/job/{job_id}/page/{page}/result")
def result(job_id: str, page: int):
    f = _job_dir(job_id) / f"p{page}_result.json"
    if not f.exists():
        raise HTTPException(404, "no result yet")
    return Response(f.read_text(), media_type="application/json")


class ApproveBody(BaseModel):
    # style_id -> final label; only listed styles are exported
    labels: dict[int, str]
    # target raster width in px for TakeoffDraft2 vertex coordinates
    # (the app stores vertices in 300dpi-image pixel space)
    image_dpi: int = 300
    # individual chains the reviewer erased in the canvas
    excluded_chain_ids: list[int] = []
    # label -> unit price per linear foot (optional, for itemization)
    prices: dict[str, float] = {}
    # label -> trade division (Earthwork & Grading, Wet Utilities, ...) as
    # grouped in the review UI; carried through to export/report rows
    trades: dict[str, str] = {}
    # label -> number of discrete objects, for styles the reviewer measures
    # as countable pieces (shear-wall segments, pads) instead of footage
    object_counts: dict[str, int] = {}
    # chains created by review-UI edits (split / extend): full geometry,
    # replacing originals the client puts in excluded_chain_ids
    added_chains: list[dict] = []
    # chain_id -> label override ("separate from group": same style, its
    # own itemized row)
    chain_labels: dict[int, str] = {}
    # calculator results (earthwork CY, trench bedding, symbol counts...):
    # [{label, qty, unit, unit_price?}] - they price and report like any
    # other takeoff row, they just are not linear footage
    extra_items: list[dict] = []


@app.post("/api/job/{job_id}/page/{page}/approve")
def approve(job_id: str, page: int, body: ApproveBody):
    f = _job_dir(job_id) / f"p{page}_result.json"
    if not f.exists():
        raise HTTPException(404, "no result to approve")
    res = json.loads(f.read_text())
    scale = body.image_dpi / 72.0
    elements = []
    excluded = set(body.excluded_chain_ids)
    for ch in list(res["chains"]) + list(body.added_chains):
        label = body.chain_labels.get(ch["chain_id"]) \
            or body.labels.get(ch["style_id"])
        if label is None or ch["chain_id"] in excluded:
            continue
        color = ch.get("color")
        hexcol = "#%02x%02x%02x" % tuple(int(c * 255) for c in color) if color else "#333333"
        elements.append({
            "type": "line",
            "label": label,
            "color": hexcol,
            "vertices": [{"x": round(x * scale, 1), "y": round(y * scale, 1)}
                         for x, y in ch["points"]],
            "detectedClass": ch["class"],
            "lengthPt": ch["length_pt"],
        })
    export = {
        "source": Path(JOBS[job_id]["path"]).name if job_id in JOBS else "",
        "pageIndex": page,
        "imageDpi": body.image_dpi,
        "pageWidthPt": res["page"]["width_pt"],
        "pageHeightPt": res["page"]["height_pt"],
        "elements": elements,
    }
    det = res.get("scale")
    if det:
        # pixels-per-foot in the export's own pixel space; the app rescales
        # to its stored image width at import
        export["scale"] = {
            "pixelsPerUnit": body.image_dpi / det["ft_per_paper_inch"],
            "unit": "ft",
            "name": f'{det["text"]} (auto, {det["source"]})',
        }
    # itemization: per-label count + footage (when scale known) + pricing
    det = res.get("scale")
    ft_per_in = det["ft_per_paper_inch"] if det else None
    totals: dict = {}
    for el in elements:
        t = totals.setdefault(el["label"], {"count": 0, "length_pt": 0.0})
        t["count"] += 1
        t["length_pt"] += el["lengthPt"]
    items = []
    for label, t in sorted(totals.items(), key=lambda kv: -kv[1]["length_pt"]):
        ft = t["length_pt"] / 72.0 * ft_per_in if ft_per_in else None
        price = body.prices.get(label)
        n_obj = body.object_counts.get(label)
        if n_obj:
            # priced per EACH: footage stays as reference, money follows count
            items.append({
                "label": label, "count": t["count"],
                "trade": body.trades.get(label),
                "length_ft": round(ft, 1) if ft is not None else None,
                "qty": n_obj, "unit": "EA",
                "unit_price": price,
                "extended": round(n_obj * price, 2) if price else None,
            })
        else:
            items.append({
                "label": label, "count": t["count"],
                "trade": body.trades.get(label),
                "length_ft": round(ft, 1) if ft is not None else None,
                "unit_price": price,
                "extended": round(ft * price, 2) if (ft is not None and price) else None,
            })
    for ex in body.extra_items:
        try:
            qty = round(float(ex.get("qty", 0)), 1)
        except (TypeError, ValueError):
            continue
        label = str(ex.get("label", "")).strip()[:80]
        if not label or qty <= 0:
            continue
        price = ex.get("unit_price")
        try:
            price = float(price) if price is not None else None
        except (TypeError, ValueError):
            price = None
        items.append({
            "label": label, "count": 1, "length_ft": None,
            "trade": body.trades.get(label),
            "qty": qty, "unit": str(ex.get("unit", ""))[:8] or "EA",
            "unit_price": price,
            "extended": round(qty * price, 2) if price else None,
        })
    trade_rank = {t: i for i, t in enumerate((
        "Earthwork & Grading", "Wet Utilities", "Dry Utilities",
        "Paving & Concrete", "Structures", "Fencing & Sitework", "General"))}
    items.sort(key=lambda it: (trade_rank.get(it.get("trade"), 99),))
    export["items"] = items
    out = _job_dir(job_id) / f"p{page}_elements.json"
    out.write_text(json.dumps(export, indent=1))
    return JSONResponse({"exported": len(elements), "file": str(out),
                         "items": items})


class LegendSheetBody(BaseModel):
    # optional: a separate legend PDF. Packages are often split one sheet
    # per file, so the legend may not be a page of the plan being reviewed.
    path: str | None = None


@app.post("/api/job/{job_id}/legend-sheet")
def legend_sheet(job_id: str, body: LegendSheetBody):
    """Read a dedicated legend sheet ("C1.1 LEGEND & NOTES") and return the
    trade names it defines, as a vocabulary for the reviewer to pick from.

    Deliberately NOT applied automatically: see legend_detect for why
    matching these to styles by geometry produces confident wrong labels."""
    from takeoff_engine.legend_detect import read_legend_sheet

    job = JOBS.get(job_id) or _404()
    src = _client_pdf(body.path) if body.path else Path(job["path"])
    if not src.exists():
        raise HTTPException(404, "not found")
    doc = pymupdf.open(src)
    best: list = []
    scanned = []
    for i in range(doc.page_count):
        pg = doc[i]
        txt = pg.get_text()[:4000].upper()
        if "LEGEND" not in txt:
            continue
        scanned.append(i)
        words = page_words(pg)
        chains = build_chains(extract_strokes(pg), words=words)
        ent = read_legend_sheet(words, chains)
        if len(ent) < 8:
            # exploded-text legend sheets (GCHC/RPA): the row labels are
            # vector strokes, not text - OCR the render and retry
            try:
                import numpy as _np
                from takeoff_engine.text_detect import ocr_words
                _pix = pg.get_pixmap(matrix=pymupdf.Matrix(200 / 72, 200 / 72),
                                     colorspace="rgb")
                _img = _np.frombuffer(_pix.samples, dtype=_np.uint8).reshape(
                    _pix.height, _pix.width, 3)
                ocr = ocr_words(_img, px_to_pt=72.0 / 200)
                ent2 = read_legend_sheet(list(words) + ocr, chains)
                if len(ent2) > len(ent):
                    ent = ent2
            except Exception:
                pass
        if len(ent) > len(best):
            best = ent
    doc.close()
    names, seen = [], set()
    for e in best:
        n = e["label"].strip()
        if n.upper() in seen:
            continue
        seen.add(n.upper())
        names.append(n)
    return JSONResponse({"source": str(src), "pages_scanned": scanned,
                         "names": names, "count": len(names)})


@app.get("/api/job/{job_id}/page/{page}/elements")
def get_elements(job_id: str, page: int):
    f = _job_dir(job_id) / f"p{page}_elements.json"
    if not f.exists():
        raise HTTPException(404, "not approved yet")
    return FileResponse(f, media_type="application/json",
                        filename=f"elements_p{page}.json")


@app.get("/api/job/{job_id}/report.pdf")
def report_pdf(job_id: str):
    """Compile every approved page of this job into a deliverable PDF:
    per page an overlay of the approved lines on the sheet, then an
    itemized table (label / count / footage / pricing)."""
    import io

    from PIL import Image, ImageDraw

    job = JOBS.get(job_id) or _404()
    jd = _job_dir(job_id)
    pages = sorted(
        int(f.name[1:].split("_")[0])
        for f in jd.glob("p*_elements.json")
    )
    if not pages:
        raise HTTPException(404, "no approved pages yet")

    doc = pymupdf.open(job["path"])
    out = pymupdf.open()
    grand: dict = {}
    for pno in pages:
        exp = json.loads((jd / f"p{pno}_elements.json").read_text())
        pg = doc[pno]
        dpi = 130
        sc = dpi / 72.0
        pix = pg.get_pixmap(matrix=pymupdf.Matrix(sc, sc), colorspace="rgb")
        im = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
        im = Image.blend(im, Image.new("RGB", im.size, (255, 255, 255)), 0.45)
        d = ImageDraw.Draw(im)
        px2img = 72.0 / exp["imageDpi"] * sc  # export px -> report image px
        for el in exp["elements"]:
            col = el.get("color") or "#cc0000"
            pts = [(v["x"] * px2img, v["y"] * px2img) for v in el["vertices"]]
            if len(pts) >= 2:
                d.line(pts, fill=col, width=3)
        buf = io.BytesIO()
        im.save(buf, format="PNG")
        newp = out.new_page(width=pg.rect.width, height=pg.rect.height)
        newp.insert_image(newp.rect, stream=buf.getvalue())

        # itemized table page
        items = exp.get("items", [])
        tp = out.new_page(width=612, height=792)
        y = 60
        tp.insert_text((50, y), f"Page {pno + 1} - Itemized takeoff",
                       fontsize=16)
        y += 30
        tp.insert_text((50, y), "Label", fontsize=9)
        tp.insert_text((300, y), "Count", fontsize=9)
        tp.insert_text((360, y), "Length (ft)", fontsize=9)
        tp.insert_text((440, y), "Unit $", fontsize=9)
        tp.insert_text((500, y), "Extended $", fontsize=9)
        y += 14
        page_total = 0.0
        for it in items:
            if y > 740:
                tp = out.new_page(width=612, height=792)
                y = 60
            tp.insert_text((50, y), str(it["label"])[:52], fontsize=9)
            tp.insert_text((300, y), str(it["count"]), fontsize=9)
            _q = it["length_ft"] if it["length_ft"] is not None else it.get("qty")
            _u = "" if it["length_ft"] is not None else (" " + it.get("unit", "")).rstrip()
            tp.insert_text((360, y), f"{_q:,}{_u}" if _q is not None else "-", fontsize=9)
            tp.insert_text((440, y), f'{it["unit_price"]:.2f}' if it.get("unit_price") else "-", fontsize=9)
            tp.insert_text((500, y), f'{it["extended"]:,.2f}' if it.get("extended") else "-", fontsize=9)
            if it.get("extended"):
                page_total += it["extended"]
            g = grand.setdefault(it["label"], {"count": 0, "ft": 0.0, "ext": 0.0})
            g["count"] += it["count"]
            g["ft"] += it["length_ft"] or 0.0  # summary totals stay footage-only
            g["ext"] += it.get("extended") or 0.0
            y += 13
        if page_total:
            y += 8
            tp.insert_text((360, y), "Page total:", fontsize=10)
            tp.insert_text((500, y), f"{page_total:,.2f}", fontsize=10)

    # grand summary
    tp = out.new_page(width=612, height=792)
    y = 60
    tp.insert_text((50, y), f"{Path(job['path']).name} - Takeoff summary",
                   fontsize=16)
    y += 30
    tp.insert_text((50, y), "Label", fontsize=9)
    tp.insert_text((300, y), "Count", fontsize=9)
    tp.insert_text((360, y), "Length (ft)", fontsize=9)
    tp.insert_text((500, y), "Extended $", fontsize=9)
    y += 14
    total = 0.0
    for label, g in sorted(grand.items(), key=lambda kv: -kv[1]["ft"]):
        if y > 740:
            tp = out.new_page(width=612, height=792)
            y = 60
        tp.insert_text((50, y), label[:52], fontsize=9)
        tp.insert_text((300, y), str(g["count"]), fontsize=9)
        tp.insert_text((360, y), f'{g["ft"]:,.1f}', fontsize=9)
        tp.insert_text((500, y), f'{g["ext"]:,.2f}' if g["ext"] else "-", fontsize=9)
        total += g["ext"]
        y += 13
    if total:
        y += 10
        tp.insert_text((360, y), "PROJECT TOTAL:", fontsize=11)
        tp.insert_text((500, y), f"{total:,.2f}", fontsize=11)

    pdf_path = jd / "takeoff_report.pdf"
    out.save(pdf_path)
    return FileResponse(pdf_path, media_type="application/pdf",
                        filename=f"takeoff_{Path(job['path']).stem[:30]}.pdf")


class AnalyzeResponse(BaseModel):
    pass


@app.post("/api/job/{job_id}/page/{page}/analyze")
def analyze_page(job_id: str, page: int, fresh: bool = False):
    """LLM page analyst: what is this sheet FOR, and which line styles
    matter for takeoff? Provider by available key, cheapest-first:
    XAI_API_KEY (Grok) > GROQ_API_KEY > ANTHROPIC_API_KEY.

    The verdict caches for THIS SERVER SESSION only (re-opening the banner
    should not re-bill the model), and never on disk: a pinned verdict that
    survives restarts is blueprint memory a fresh seat would not have, and
    memory was removed 2026-08-20 for report consistency. fresh=1 re-reads
    the sheet."""
    import base64
    import os

    _ck = (job_id, page)
    if not fresh and _ck in _AI_SESSION_CACHE:
        return JSONResponse(_AI_SESSION_CACHE[_ck])

    import requests as _rq

    provider = None
    if os.environ.get("XAI_API_KEY"):
        provider = ("xai", "https://api.x.ai/v1", os.environ["XAI_API_KEY"],
                    os.environ.get("TAKEOFF_LLM_MODEL", "grok-4-fast-non-reasoning"))
    elif os.environ.get("GROQ_API_KEY"):
        provider = ("groq", "https://api.groq.com/openai/v1",
                    os.environ["GROQ_API_KEY"],
                    os.environ.get("TAKEOFF_LLM_MODEL",
                                   "meta-llama/llama-4-scout-17b-16e-instruct"))
    elif os.environ.get("ANTHROPIC_API_KEY"):
        provider = ("anthropic", None, os.environ["ANTHROPIC_API_KEY"],
                    os.environ.get("TAKEOFF_LLM_MODEL", "claude-haiku-4-5-20251001"))
    if provider is None:
        raise HTTPException(
            503, "No LLM key set. Export XAI_API_KEY (Grok), GROQ_API_KEY, "
                 "or ANTHROPIC_API_KEY on the detection service.")

    job = JOBS.get(job_id) or _404()
    doc = pymupdf.open(job["path"])
    pg = doc[page]
    scale = 1400 / max(pg.rect.width, pg.rect.height)
    pix = pg.get_pixmap(matrix=pymupdf.Matrix(scale * 2, scale * 2))
    img_b64 = base64.standard_b64encode(pix.tobytes("jpeg")).decode()
    text = pg.get_text()[:3000]

    styles_ctx = "(run Detect first - no styles known yet)"
    legend_ctx = ""
    known_ids: set = set()
    rf = _job_dir(job_id) / f"p{page}_result.json"
    if rf.exists():
        res = json.loads(rf.read_text())
        det = res.get("scale") or {}
        ft_per_in = det.get("ft_per_paper_inch")
        rows = []
        for st in res["styles"][:28]:
            known_ids.add(int(st["style_id"]))
            col = st.get("color")
            hexcol = ("#%02x%02x%02x" % tuple(int(c * 255) for c in col)) \
                if col else "n/a"
            qty = (f'{st["length_pt"] / 72.0 * ft_per_in:,.0f} ft'
                   if ft_per_in else f'{st["length_pt"]:,.0f} pt')
            rows.append(
                f'- style_id {st["style_id"]}: class={st["class"]}, '
                f'{st["n"]} lines, {qty}, colour {hexcol}, '
                f'width {st.get("width")}, pattern "{st.get("signature")}", '
                f'current label "{st["suggested_label"]}"')
        if rows:
            styles_ctx = "\n".join(rows)
        if res.get("legend"):
            legend_ctx = ("\n\nLegend rows the detector already read off this "
                          "sheet:\n" + "\n".join(
                              f'- "{e.get("label")}" -> style_id '
                              f'{e.get("sample_style")}'
                              for e in res["legend"]))

    prompt = (
        "You are helping a construction estimator do a quantity takeoff from "
        "this plan sheet. Decide WHAT THIS SHEET IS FOR, then which of the "
        "detected line styles an estimator should actually measure on it.\n\n"
        "Sheet text (excerpt):\n" + text +
        "\n\nDetected line styles (these style_id values are the only ones "
        "that exist - never invent one):\n" + styles_ctx + legend_ctx +
        "\n\nGuidance: a sheet usually has ONE job, and most linework on it "
        "is context rather than takeoff. A shear-wall plan means only the "
        "shear walls get measured; a roof plan means only roof framing. "
        "Title blocks, grid lines, dimension strings, leaders, hatching and "
        "match lines are never takeoff. Put a style in focus only if this "
        "sheet's purpose is what that line represents; if you are unsure "
        "about a style, leave it out of both lists.\n\n"
        "Reply with STRICT JSON only, no prose outside it, with keys:\n"
        '  purpose: one sentence on what this sheet is for\n'
        '  discipline: short string\n'
        '  focus: array of {"style_id": int, "label": "short trade name for '
        'this line", "why": "short reason", "measure": "line" or "object"}\n'
        '    measure="object" when the style marks DISCRETE COUNTABLE pieces '
        'an estimator prices each (shear-wall segments, footing pads, beams, '
        'fixtures); measure="line" for continuous runs priced per foot '
        '(pipe, curb, fence, contours).\n'
        '  ignore: array of style_id ints only, no objects\n'
        '  inline_legend: array of {"symbol": ..., "meaning": ...} for any '
        'legend defined on the sheet itself\n'
        '  page_modes: array from ["lines","objects","earthwork","trench",'
        '"count"] - the measurement modes this sheet needs\n'
        '  confidence: "high" | "medium" | "low"\n'
        'Keep every "why" under 12 words so the reply is not truncated.'
    )

    name, base, key, model = provider
    if name == "anthropic":
        import anthropic

        client = anthropic.Anthropic()
        msg = client.messages.create(
            model=model, max_tokens=2000, temperature=0,
            messages=[{"role": "user", "content": [
                {"type": "image", "source": {"type": "base64",
                 "media_type": "image/jpeg", "data": img_b64}},
                {"type": "text", "text": prompt}]}])
        raw = msg.content[0].text
    else:
        r = _rq.post(
            f"{base}/chat/completions",
            headers={"Authorization": f"Bearer {key}",
                     "Content-Type": "application/json"},
            json={"model": model, "max_tokens": 2000, "temperature": 0,
                  "messages": [{"role": "user", "content": [
                      {"type": "image_url", "image_url": {
                          "url": f"data:image/jpeg;base64,{img_b64}"}},
                      {"type": "text", "text": prompt}]}]},
            timeout=90)
        if not r.ok:
            raise HTTPException(502, f"{name} API error {r.status_code}: "
                                     f"{r.text[:200]}")
        raw = r.json()["choices"][0]["message"]["content"]

    parsed = None
    try:
        parsed = json.loads(raw[raw.index("{"): raw.rindex("}") + 1])
    except Exception:
        # a reply cut off by the token limit leaves unbalanced JSON; recover
        # the fields that did arrive rather than dumping raw text at the user
        for closer in ("]}", "}]}", '"}]}'):
            try:
                cut = raw.rindex(",")
                parsed = json.loads(raw[raw.index("{"):cut] + closer)
                parsed["_truncated"] = True
                break
            except Exception:
                continue
    if not isinstance(parsed, dict):
        parsed = {"purpose": "The model did not return usable JSON.",
                  "_unparsed": raw[:300]}

    # The UI turns focus/ignore into checkbox state, so a hallucinated
    # style_id would hide real linework from the takeoff. Keep only ids the
    # detector actually produced, and say plainly how many were discarded
    # rather than quietly shrinking the list.
    def _clean(items):
        out, dropped = [], 0
        for it in items if isinstance(items, list) else []:
            # focus arrives as objects, ignore as bare style_id ints
            if isinstance(it, (int, float)) or (
                    isinstance(it, str) and it.strip().lstrip("-").isdigit()):
                it = {"style_id": it}
            if not isinstance(it, dict):
                dropped += 1
                continue
            try:
                sid = int(it.get("style_id"))
            except (TypeError, ValueError):
                dropped += 1
                continue
            if known_ids and sid not in known_ids:
                dropped += 1
                continue
            row = {"style_id": sid}
            for k in ("label", "why"):
                if it.get(k):
                    row[k] = str(it[k])[:120]
            if str(it.get("measure", "")).lower() == "object":
                row["measure"] = "object"
            out.append(row)
        return out, dropped

    _MODES = ("lines", "objects", "earthwork", "trench", "count")
    pm = parsed.get("page_modes")
    parsed["page_modes"] = [m for m in (pm if isinstance(pm, list) else [])
                            if isinstance(m, str) and m in _MODES]
    focus, drop_f = _clean(parsed.get("focus"))
    ignore, drop_i = _clean(parsed.get("ignore"))
    seen = {f["style_id"] for f in focus}
    ignore = [i for i in ignore if i["style_id"] not in seen]  # focus wins
    parsed["focus"] = focus
    parsed["ignore"] = ignore
    parsed["_invalid_style_ids"] = drop_f + drop_i
    parsed["_known_style_ids"] = len(known_ids)
    parsed["_provider"] = f"{name}:{model}"
    _AI_SESSION_CACHE[_ck] = parsed
    return JSONResponse(parsed)


class EarthworkBody(BaseModel):
    # [{chain_id, z}] per surface, elevations in feet
    existing: list[dict] = []
    proposed: list[dict] = []
    # [{x, y, z}] spot grades in page pt - the printed FG/TS/TW elevations.
    # A detailed grading sheet often prints far more of these than labelled
    # contours, and a TIN can be built from them alone.
    existing_points: list[dict] = []
    proposed_points: list[dict] = []
    cell_ft: float = 2.0
    # Layer stacks (Beaumont workflow, F52). Each {name, thickness_in}.
    # existing_layers come OFF first (topsoil strip from the soils report,
    # old asphalt, road base): their total lowers the existing surface
    # before cut/fill. proposed_layers are built back on the proposed
    # side (driveway base + paving): the sheet shows finish grade, the
    # dig stops that much lower, so their total lowers the proposed
    # surface. Each layer's own volume = area x thickness.
    existing_layers: list[dict] = []
    proposed_layers: list[dict] = []
    # area the layers apply over, SF. Default: the TIN overlap area_sf
    # (where both surfaces are defined) - override with the clear & grub
    # area when the strip extends beyond the graded region.
    strip_area_sf: float | None = None


@app.get("/api/job/{job_id}/page/{page}/earthwork/suggest")
def earthwork_suggest(job_id: str, page: int):
    """Auto-pair elevation labels with the contours they sit on - a
    suggestion list for the review UI, not a decision."""
    from takeoff_engine.earthwork import suggest_elevations

    rf = _job_dir(job_id) / f"p{page}_result.json"
    if not rf.exists():
        raise HTTPException(404, "run detect first")
    res = json.loads(rf.read_text())
    job = JOBS.get(job_id) or _404()
    doc = pymupdf.open(job["path"])
    words = page_words(doc[page])
    doc.close()

    class _C:  # minimal chain view over the stored result
        def __init__(self, d):
            import numpy as _np
            self.chain_id = d["chain_id"]
            self.pts = _np.asarray(d["points"], float)
            self.length = d["length_pt"]
            self.width = d.get("width")
    chains = [_C(c) for c in res["chains"]]
    # contour labels printed inside line breaks are rotated + often
    # exploded to vectors: read them by deskewing each gap with the
    # line's own angle. OCR of a fixed raster is deterministic, so the
    # per-page cache reproduces on any seat (compute cache, not memory).
    gcache = _job_dir(job_id) / f"p{page}_elevgaps.json"
    gap_z = None
    if gcache.exists():
        try:
            gap_z = {int(k): tuple(v)
                     for k, v in json.loads(gcache.read_text()).items()}
        except Exception:
            gap_z = None
    if gap_z is None:
        import numpy as _np3

        from takeoff_engine.earthwork import gap_label_elevations
        doc2 = pymupdf.open(job["path"])
        pix = doc2[page].get_pixmap(dpi=150)
        img = _np3.frombuffer(pix.samples, _np3.uint8).reshape(
            pix.height, pix.width, pix.n)[:, :, :3].copy()
        doc2.close()
        gap_z = gap_label_elevations(chains, img, 150.0 / 72.0)
        try:
            gcache.write_text(json.dumps(
                {str(k): list(v) for k, v in gap_z.items()}))
        except OSError:
            pass
    sug = suggest_elevations(chains, words, gap_z=gap_z)
    by_id = {c.chain_id: c for c in chains}
    for r in sug:
        w = by_id[r["chain_id"]].width
        r["width"] = w
    # Spot grades ("FG: 15.96") are the elevations a detailed grading sheet
    # actually prints - Barn C3.4 has 45 of them against 2 labelled contours,
    # and the whole population used to be invisible. They are POINT
    # elevations, so they ride alongside the contour rows.
    from takeoff_engine.earthwork import read_spot_grades
    spots = read_spot_grades(words)

    # Two junk sources make the contour suggestions untrustworthy on sparse
    # sheets (Barn C3.4 offered 6 rows of which 4 were noise):
    #  - the sheet's own LEGEND text: "7900 EXISTING CONTOUR INTERVAL" reads
    #    as an elevation label sitting on the legend's sample bar. We already
    #    know where those bars are, so drop anything inside one.
    #  - stray 4-digit numbers, above all the DATE (2026). Judge by consensus
    #    like the spot grades do: keep the dominant hundreds band, and only
    #    when at least two candidates agree on it. A lone outlier is noise;
    #    if nothing agrees, nothing is dropped (better a noisy list than a
    #    silently emptied one).
    boxes = res.get("legend_samples") or []
    def _in_legend(r):
        x, y = r.get("label_xy", [None, None])
        if x is None:
            return False
        return any(b[0] - 6 <= x <= b[2] + 6 and b[1] - 8 <= y <= b[3] + 8
                   for b in boxes)
    kept = [r for r in sug if not _in_legend(r)]
    # cluster on GAPS, not on hundreds: a site that spans 7690-7710 is one
    # surface, and a hundreds bucket would cut it in half
    if len(kept) > 1:
        order = sorted(kept, key=lambda r: float(r["z"]))
        groups, cur = [], [order[0]]
        for prev, r in zip(order, order[1:]):
            if float(r["z"]) - float(prev["z"]) > 100.0:
                groups.append(cur); cur = []
            cur.append(r)
        groups.append(cur)
        top = max(groups, key=len)
        if len(top) >= 2:
            kept = top
    dropped = len(sug) - len(kept)
    sug = kept
    return {"suggestions": sug,
            "suggestions_dropped": dropped,
            "spot_grades": spots,
            "spot_datum_needed": bool(spots) and not any(
                g.get("resolved") for g in spots),
            "scale": res.get("scale"),
            "note": "confirm/edit in the UI; split into existing vs "
                    "proposed before calculating"}


def _layer_stack(rows: list) -> tuple[list, float]:
    """[{name, thickness_in}] -> (clean rows, total thickness ft)."""
    out, tot_in = [], 0.0
    for r in rows or []:
        try:
            t = float(r.get("thickness_in", 0) or 0)
        except (TypeError, ValueError):
            continue
        if t <= 0:
            continue
        out.append({"name": str(r.get("name") or "layer").strip() or "layer",
                    "thickness_in": t})
        tot_in += t
    return out, tot_in / 12.0


def _earthwork_run(job_id: str, page: int, body: EarthworkBody,
                   return_grid: bool = False) -> dict:
    """Shared by the volumes endpoint and the map endpoint: build both
    surfaces from the stored chains, lower each by its layer stack, and
    difference them. Adds the per-layer volumes and the offsets used."""
    import numpy as _np

    from takeoff_engine.earthwork import Surface, cut_fill

    rf = _job_dir(job_id) / f"p{page}_result.json"
    if not rf.exists():
        raise HTTPException(404, "run detect first")
    res = json.loads(rf.read_text())
    det = res.get("scale")
    if not det:
        raise HTTPException(400, "no scale on this page - calibrate first, "
                                 "volumes need real-world units")
    ft_per_pt = det["ft_per_paper_inch"] / 72.0
    pts_by_id = {c["chain_id"]: _np.asarray(c["points"], float)
                 for c in res["chains"]}

    def build(name, rows, points=()):
        surf = Surface(name)
        for r in rows:
            cid = int(r["chain_id"])
            if cid in pts_by_id:
                surf.contours.append((pts_by_id[cid], float(r["z"])))
        for q in points:
            try:
                surf.points.append((float(q["x"]), float(q["y"]), float(q["z"])))
            except (KeyError, TypeError, ValueError):
                continue
        return surf
    ex_layers, ex_off = _layer_stack(body.existing_layers)
    pr_layers, pr_off = _layer_stack(body.proposed_layers)
    result = cut_fill(build("existing", body.existing, body.existing_points),
                      build("proposed", body.proposed, body.proposed_points),
                      ft_per_pt, cell_ft=body.cell_ft,
                      existing_offset_ft=ex_off, proposed_offset_ft=pr_off,
                      return_grid=return_grid)
    if "error" in result:
        raise HTTPException(400, result["error"])
    result["ft_per_pt"] = round(ft_per_pt, 5)
    result["existing_offset_ft"] = round(ex_off, 4)
    result["proposed_offset_ft"] = round(pr_off, 4)
    # layer volumes: a slab of the strip area at the layer's thickness.
    # Default area is the TIN overlap (the region the cut/fill itself
    # covers); strip_area_sf overrides it with e.g. the clear & grub area.
    area = float(body.strip_area_sf) if body.strip_area_sf else float(result["area_sf"])
    result["layer_area_sf"] = round(area, 0)
    layers = []
    for side, rows in (("existing", ex_layers), ("proposed", pr_layers)):
        for r in rows:
            layers.append({"name": r["name"], "side": side,
                           "thickness_in": r["thickness_in"],
                           "volume_yd3": round(area * r["thickness_in"] / 12.0 / 27.0, 1)})
    result["layers"] = layers
    return result


@app.post("/api/job/{job_id}/page/{page}/earthwork")
def earthwork_calc(job_id: str, page: int, body: EarthworkBody):
    """Cut & fill volumes between two labeled contour surfaces, after
    lowering each by its layer stack (see EarthworkBody)."""
    return JSONResponse(_earthwork_run(job_id, page, body))


@app.post("/api/job/{job_id}/page/{page}/earthwork/map")
def earthwork_map(job_id: str, page: int, body: EarthworkBody):
    """Cut/fill map for the same request body as /earthwork: an RGBA PNG
    of the dz grid (cut blue, fill yellow-orange, depth -> opacity,
    undefined cells clear). Registration for the caller rides in headers:
      X-Map-Bbox    x0,y0,x1,y1 in page pt (the PNG stretches to this box)
      X-Map-Cell-Pt grid cell size in pt
      X-Map-Ref-Dz  |dz| in ft at which the colour reaches full opacity
    The PNG + its meta are cached as the LAST map for (job, page); GET the
    same path to re-read them without recomputing."""
    from takeoff_engine.earthwork import render_cut_fill_map

    result = _earthwork_run(job_id, page, body, return_grid=True)
    png, meta = render_cut_fill_map(result.pop("grid"))
    meta.update({k: result[k] for k in
                 ("cut_yd3", "fill_yd3", "net_yd3", "area_sf", "cell_ft",
                  "existing_offset_ft", "proposed_offset_ft")})
    d = _job_dir(job_id)
    try:
        (d / f"p{page}_ewmap.png").write_bytes(png)
        (d / f"p{page}_ewmap.json").write_text(json.dumps(meta))
    except OSError:
        pass
    return Response(png, media_type="image/png",
                    headers=_ewmap_headers(meta))


def _ewmap_headers(meta: dict) -> dict:
    return {
        "X-Map-Bbox": ",".join(f"{v:.3f}" for v in meta["bbox_pt"]),
        "X-Map-Cell-Pt": f"{meta['cell_pt']:.5f}",
        "X-Map-Ref-Dz": f"{meta['ref_dz_ft']:.3f}",
        "Cache-Control": "no-store",
    }


@app.get("/api/job/{job_id}/page/{page}/earthwork/map")
def earthwork_map_cached(job_id: str, page: int, meta: int = 0):
    """The last map rendered for (job, page): PNG by default, or its
    JSON meta (bbox, cell, ref depth, volumes) with ?meta=1."""
    d = _job_dir(job_id)
    pj, pp = d / f"p{page}_ewmap.json", d / f"p{page}_ewmap.png"
    if not (pj.exists() and pp.exists()):
        raise HTTPException(404, "no cut/fill map yet - POST this path first")
    m = json.loads(pj.read_text())
    if meta:
        return JSONResponse(m)
    return Response(pp.read_bytes(), media_type="image/png",
                    headers=_ewmap_headers(m))


@app.get("/api/job/{job_id}/page/{page}/callouts")
def callouts(job_id: str, page: int):
    """The sheet's own callouts as data: every detected leader paired with
    the text at its tail and the takeoff line it points at. Leaders stay
    out of the math; this makes them navigation/context instead."""
    import numpy as np

    job = JOBS.get(job_id) or _404()
    rf = _job_dir(job_id) / f"p{page}_result.json"
    if not rf.exists():
        raise HTTPException(404, "run detect first")
    cache = _job_dir(job_id) / f"p{page}_callouts.json"
    if cache.exists():
        return JSONResponse(json.loads(cache.read_text()))
    res = json.loads(rf.read_text())
    leaders = [c for c in res["chains"] if c.get("dash_signature") == "leader"]
    out = {"callouts": []}
    if leaders:
        doc = pymupdf.open(job["path"])
        pg = doc[page]
        words = page_words(pg)
        # sheets whose labels are outlines have no words worth pairing:
        # OCR once per page and cache with the result
        if len(words) < 8 * len(leaders):
            from takeoff_engine.text_detect import ocr_words
            pix = pg.get_pixmap(dpi=150)
            img = np.frombuffer(pix.samples, np.uint8).reshape(
                pix.height, pix.width, pix.n)[:, :, :3].copy()
            words = list(words) + ocr_words(img, 72.0 / 150.0)
        doc.close()
        W = [(w[0], w[1], w[2], w[3], str(w[4])) for w in words
             if str(w[4]).strip()]
        takeoff = [c for c in res["chains"] if c["class"] != "annotation"]
        segs = []
        for c in takeoff:
            p = np.asarray(c["points"], float)
            segs.append((c, p))

        def words_near(e, rad):
            hits = []
            for w in W:
                dx = max(w[0] - e[0], 0, e[0] - w[2])
                dy = max(w[1] - e[1], 0, e[1] - w[3])
                if (dx * dx + dy * dy) ** 0.5 <= rad:
                    hits.append(w)
            return hits

        def gather_text(e):
            seed = words_near(e, 40.0)
            if not seed:
                return ""
            # expand to same-row neighbours so multi-line notes read whole
            box = [min(w[0] for w in seed), min(w[1] for w in seed),
                   max(w[2] for w in seed), max(w[3] for w in seed)]
            grown = [w for w in W
                     if w[0] < box[2] + 90 and w[2] > box[0] - 90
                     and w[1] < box[3] + 26 and w[3] > box[1] - 26]
            grown.sort(key=lambda w: (round((w[1] + w[3]) / 2 / 9), w[0]))
            toks, prev = [], None
            for w in grown:
                t = w[4].strip()
                # OCR debris: bare punctuation and repeated words (the
                # sparse-PSM pass reads outline text twice along edges)
                if len(t) == 1 and not t.isalnum():
                    continue
                if prev is not None and t.upper() == prev.upper():
                    continue
                toks.append(t)
                prev = t
            return " ".join(toks)[:120]

        for c in leaders:
            p = np.asarray(c["points"], float)
            ends = [p[0], p[-1]]
            n_near = [len(words_near(e, 24.0)) for e in ends]
            ti = 0 if n_near[0] >= n_near[1] else 1
            text_end, tip = ends[ti], ends[1 - ti]
            text = gather_text(text_end)
            best, bd = None, 15.0
            for tc, tp in segs:
                d = np.min(np.hypot(tp[:, 0] - tip[0], tp[:, 1] - tip[1]))
                if d < bd:
                    bd, best = float(d), tc
            out["callouts"].append({
                "leader_chain_id": c["chain_id"],
                "text": text,
                "tx": round(float(text_end[0]), 1),
                "ty": round(float(text_end[1]), 1),
                "gx": round(float(tip[0]), 1),
                "gy": round(float(tip[1]), 1),
                "target_chain_id": best["chain_id"] if best else None,
                "target_style_id": best["style_id"] if best else None,
            })
    try:
        cache.write_text(json.dumps(out))
    except OSError:
        pass
    return JSONResponse(out)


def _doc_schedule(job_id: str, path: str, page: int) -> dict:
    """The mark schedule for this DOCUMENT, not just this page.

    An estimator's schedule usually lives on its own sheet - Bill Dunn's
    Aqua Vista set puts the window schedule on A830 (page 0) and the floor
    plans he counts on pages 1-5 - so a per-page lookup finds nothing on
    exactly the pages that need it.  This page first, then the rest of the
    document; the answer is cached per job because the OCR fallback on a
    scanned schedule sheet is slow.
    """
    from takeoff_engine import marks as _marks

    cache = _job_dir(job_id) / "schedule.json"
    if cache.exists():
        try:
            return json.loads(cache.read_text())
        except (OSError, ValueError):
            pass
    doc = pymupdf.open(path)
    best: dict = {"marks": [], "qty": {}, "header": "", "source": "none",
                  "page": None}
    order = [page] + [i for i in range(doc.page_count) if i != page]
    ocr_left = 3          # OCRing a scanned sheet costs ~40 s; bound it
    try:
        for i in order[:12]:
            pg = doc[i]
            words = list(page_words(pg))
            s = _marks.read_mark_schedule(words) if words else None
            if not (s and s["marks"]) and len(words) < 40 and ocr_left > 0:
                ocr_left -= 1
                # a scanned schedule sheet has no text layer at all; OCR it
                # upright (these sheets are landscape scanned onto portrait)
                # and read the mark column through the lookalike map
                try:
                    import numpy as _np

                    from takeoff_engine.text_detect import ocr_words
                    dpi = 600
                    pix = pg.get_pixmap(matrix=pymupdf.Matrix(dpi / 72, dpi / 72),
                                        colorspace="rgb")
                    img = _np.frombuffer(pix.samples, _np.uint8).reshape(
                        pix.height, pix.width, 3)
                    deg = _marks.orient_ccw(img[:, :, ::-1])
                    ow = ocr_words(_marks._rot_ccw(img, deg), px_to_pt=72.0 / dpi)
                    s = _marks.read_mark_schedule(list(ow), fuzzy=True)
                except Exception:
                    s = None
            if s and len(s["marks"]) > len(best["marks"]):
                best = dict(s)
                best["page"] = i
            # the first sheet that yields a real mark column IS the schedule
            # sheet - pages are visited current-first, and a floor plan does
            # not carry one, so stop rather than OCR the whole set
            if len(best["marks"]) >= 3:
                break
    finally:
        doc.close()
    try:
        cache.write_text(json.dumps(best))
    except OSError:
        pass
    return best


@app.get("/api/job/{job_id}/page/{page}/symbols/suggest")
def symbols_suggest(job_id: str, page: int):
    """Repeated congruent small shapes on the page - the countable symbols
    (grid bubbles, fixtures, window/door glyphs). Geometry does the finding
    and counting so the number is verifiable; the human (or the AI's
    inline-legend read) supplies the NAME.

    Two finders, one contract. Vector sheets group congruent closed stroke
    units. Scanned sheets have no strokes at all, so they go through
    takeoff_engine.marks, which matches the bubble as a picture and reads
    the code inside it. Either way the answer is {groups, schedule}."""
    import re as _re

    import numpy as np

    job = JOBS.get(job_id) or _404()
    doc = pymupdf.open(job["path"])
    pg = doc[page]
    units = extract_strokes(pg)
    words = page_words(pg)
    doc.close()

    # mark schedule, when the SET carries one: a header row containing
    # MARK (or WINDOW TYPE) anchors a table whose rows map mark -> quantity.
    # Used three ways: cross-check the counted symbols, EXCLUDE the table's
    # own cell rectangles from symbol grouping (they are congruent boxes and
    # count themselves otherwise - measured on the window benchmark), and
    # constrain what a scanned bubble is allowed to be read as.
    doc_sched = _doc_schedule(job_id, job["path"], page)
    here = read_mark_schedule(words) if words else {"marks": [], "qty": {},
                                                    "box": None}
    sched: dict = dict(here.get("qty") or {})
    table_box = here.get("box")
    if not sched and doc_sched.get("qty"):
        sched = dict(doc_sched["qty"])
    vocab = here.get("marks") or doc_sched.get("marks") or []

    if not units and not words:
        return _symbols_raster(job, page, vocab, sched, doc_sched)

    MARK_WORD = _re.compile(r"^[A-Z]{1,3}-?\d+[A-Z]?$")
    groups: dict = {}
    for u in units:
        if not u.closed or not (4.0 <= u.length <= 160.0):
            continue
        bb = u.pts.max(axis=0) - u.pts.min(axis=0)
        w, h = float(bb[0]), float(bb[1])
        if max(w, h) > 45.0 or max(w, h) < 2.0:
            continue
        key = (round(w), round(h), round(u.length / 4.0))
        c = (u.pts.min(axis=0) + u.pts.max(axis=0)) / 2.0
        groups.setdefault(key, []).append([round(float(c[0]), 1),
                                           round(float(c[1]), 1)])

    def _in_table(c):
        return table_box and table_box[0] <= c[0] <= table_box[2] \
            and table_box[1] <= c[1] <= table_box[3]

    def _mark_at(c):
        # the mark text lives INSIDE its bubble (measured 0.7pt): the word
        # box containing (or within 3pt of) the symbol center names it
        for w in words:
            t = str(w[4]).strip().upper()
            if not MARK_WORD.match(t):
                continue
            if w[0] - 3 <= c[0] <= w[2] + 3 and w[1] - 3 <= c[1] <= w[3] + 3:
                return t
        return None

    out = []
    for (w, h, _), centers in groups.items():
        # a symbol repeats; also drop coincident duplicates (drawn twice)
        uniq = []
        for c in centers:
            if all(abs(c[0]-d[0]) > 2 or abs(c[1]-d[1]) > 2 for d in uniq):
                uniq.append(c)
        # the schedule's own cell boxes are congruent shapes too
        if uniq and sum(1 for c in uniq if _in_table(c)) >= 0.6 * len(uniq):
            continue
        if len(uniq) < 3:
            continue
        marks: dict = {}
        unmarked = []
        for c in uniq:
            m = _mark_at(c)
            if m:
                marks.setdefault(m, []).append(c)
            else:
                unmarked.append(c)
        if sum(len(v) for v in marks.values()) >= 0.6 * len(uniq):
            # mark-bubble family: one countable group per mark, named by
            # the sheet, cross-checked against its own schedule
            for m in sorted(marks):
                g = {"w": w, "h": h, "n": len(marks[m]),
                     "centers": marks[m], "name": m}
                if m in sched:
                    g["schedule_qty"] = sched[m]
                out.append(g)
            if len(unmarked) >= 3:
                out.append({"w": w, "h": h, "n": len(unmarked),
                            "centers": unmarked})
        else:
            out.append({"w": w, "h": h, "n": len(uniq), "centers": uniq})
    out.sort(key=lambda g: -g["n"])
    return {"groups": out[:15], "schedule": sched,
            "schedule_marks": doc_sched.get("marks") or [],
            "schedule_page": doc_sched.get("page"),
            "schedule_header": doc_sched.get("header", ""),
            "schedule_source": doc_sched.get("source", "none")}


def _symbols_raster(job: dict, page: int, vocab: list, sched: dict,
                    doc_sched: dict) -> dict:
    """Scanned sheet: count mark bubbles as pictures (takeoff_engine.marks).

    Same {groups, schedule} contract as the vector path, so the Count panel
    needs no idea which finder ran. Centres come back in page points."""
    from takeoff_engine import marks as _marks

    mp = _marks.detect_marks(job["path"], page, vocab or None)
    by: dict = {}
    for t in mp.tags:
        if t.kind == "legend":
            continue
        # three buckets, not two: a schedule mark, a bubble read confidently
        # as something the schedule does not list (a neighbouring tag family
        # - the WALL tags read L04/L06 on Bill's floor plans), and a bubble
        # nothing could be read from. Collapsing the middle one into "not
        # read" hides a real answer from the estimator.
        key = t.code or ("~" + t.off_schedule if t.off_schedule else "")
        by.setdefault(key, []).append([round(t.cx_pt, 1), round(t.cy_pt, 1)])
    px_pt = 72.0 / _marks.RENDER_DPI
    w_pt = round(mp.tag_size[0] * px_pt, 1)
    h_pt = round(mp.tag_size[1] * px_pt, 1)
    out = []
    for code, cs in by.items():
        g = {"w": w_pt, "h": h_pt, "n": len(cs), "centers": cs,
             "source": "raster"}
        if code.startswith("~"):
            g["off_schedule"] = code[1:]
        elif code:
            g["name"] = code
            if code in sched:
                g["schedule_qty"] = sched[code]
        out.append(g)
    out.sort(key=lambda g: (0 if g.get("name") else 1 if g.get("off_schedule")
                            else 2, -g["n"]))
    return {"groups": out[:15], "schedule": sched,
            "schedule_marks": doc_sched.get("marks") or [],
            "schedule_page": doc_sched.get("page"),
            "schedule_header": doc_sched.get("header", ""),
            "schedule_source": doc_sched.get("source", "none"),
            "raster": True, "notes": mp.notes,
            "tag_px": list(mp.tag_size), "orient": mp.orient,
            "skew_deg": mp.skew_deg}


class StructureBody(BaseModel):
    # [{name?, points: [[x_pt, y_pt], ...] (>= 3 corners, page pt),
    #   depth_ft, layback_ft, footing_ft?}] - one entry per building
    structures: list[dict] = []


def _structure_one(s: dict, ft_per_pt: float) -> dict:
    """One building footprint -> the excavator's four bid-sheet numbers.
    Same arithmetic as the review UI (webui/app.js stCalc); this is the
    server-side source of truth for the export/report path.

      Mass Excavation CY      = footprint SF x depth / 27
      Structure Excavation CY = wall LF x (depth + footing) x layback / 27
      Structure Backfill CY   = Structure Excavation (dig it, fill it back)
      Slab Prep SF            = footprint SF
    """
    pts = s.get("points") or []
    try:
        ring = [(float(p[0]), float(p[1])) for p in pts]
    except (TypeError, ValueError, IndexError):
        raise HTTPException(400, "points must be [[x, y], ...] in page pt")
    if len(ring) >= 2 and abs(ring[0][0] - ring[-1][0]) < 0.5 \
            and abs(ring[0][1] - ring[-1][1]) < 0.5:
        ring.pop()     # first == last: one vertex, not two
    if len(ring) < 3:
        raise HTTPException(400, "an outline needs at least 3 corners")
    for x, y in ring:
        if not (x == x and y == y and abs(x) < 1e7 and abs(y) < 1e7):
            raise HTTPException(400, "non-finite corner coordinate")

    def num(key, default=0.0):
        v = s.get(key, default)
        try:
            v = float(v)
        except (TypeError, ValueError):
            raise HTTPException(400, f"{key} must be a number")
        if v != v or v < 0 or v > 1000:
            raise HTTPException(400, f"{key} out of range (0-1000 ft)")
        return v
    depth, layback, footing = num("depth_ft"), num("layback_ft", 4.0), num("footing_ft")
    area2 = 0.0
    perim = 0.0
    n = len(ring)
    for i in range(n):
        x1, y1 = ring[i]
        x2, y2 = ring[(i + 1) % n]
        area2 += x1 * y2 - x2 * y1
        perim += ((x2 - x1) ** 2 + (y2 - y1) ** 2) ** 0.5
    area_sf = abs(area2) / 2.0 * ft_per_pt * ft_per_pt
    perim_lf = perim * ft_per_pt
    struct = perim_lf * (depth + footing) * layback / 27.0
    return {
        "name": str(s.get("name", ""))[:60],
        "corners": n,
        "area_sf": round(area_sf, 1),
        "perim_lf": round(perim_lf, 1),
        "depth_ft": depth, "layback_ft": layback, "footing_ft": footing,
        "mass_cy": round(area_sf * depth / 27.0, 1),
        "struct_cy": round(struct, 1),
        "backfill_cy": round(struct, 1),
        "slab_sf": round(area_sf, 1),
    }


@app.post("/api/job/{job_id}/page/{page}/structure")
def structure_calc(job_id: str, page: int, body: StructureBody):
    """Building footprint(s) -> Mass Excavation / Structure Excavation /
    Structure Backfill (CY) and Slab Prep (SF), in the excavator's own
    bid-sheet terms. Validates the polygons and returns per-structure rows
    plus the page totals; the UI does the same math client-side and uses
    this as a cross-check."""
    rf = _job_dir(job_id) / f"p{page}_result.json"
    if not rf.exists():
        raise HTTPException(404, "run detect first")
    res = json.loads(rf.read_text())
    det = res.get("scale")
    if not det:
        raise HTTPException(400, "no scale on this page - calibrate first, "
                                 "volumes need real-world units")
    ft_per_pt = det["ft_per_paper_inch"] / 72.0
    if not body.structures:
        raise HTTPException(400, "no structures given")
    if len(body.structures) > 200:
        raise HTTPException(400, "too many structures")
    rows = [_structure_one(s, ft_per_pt) for s in body.structures]
    totals = {k: round(sum(r[k] for r in rows), 1)
              for k in ("mass_cy", "struct_cy", "backfill_cy", "slab_sf")}
    items = [{"label": label, "qty": totals[key], "unit": unit}
             for label, key, unit in (
                 ("Mass Excavation", "mass_cy", "CY"),
                 ("Structure Excavation", "struct_cy", "CY"),
                 ("Structure Backfill", "backfill_cy", "CY"),
                 ("Slab Prep", "slab_sf", "SF"))
             if totals[key] > 0]
    return JSONResponse({"structures": rows, "totals": totals,
                         "extra_items": items,
                         "ft_per_pt": round(ft_per_pt, 5)})


# Analyze verdicts live for this server session only - never on disk
_AI_SESSION_CACHE: dict = {}


@app.middleware("http")
async def _no_stale_ui(request, call_next):
    """UI assets must revalidate every load. A browser that keeps serving a
    cached app.js resurrects removed behavior (the blueprint-memory code
    lived on in stale tabs after removal); ETag revalidation keeps reloads
    fast while guaranteeing the current build."""
    resp = await call_next(request)
    if not request.url.path.startswith("/api"):
        resp.headers["Cache-Control"] = "no-cache, must-revalidate"
    return resp


app.mount("/", StaticFiles(directory=ROOT / "webui", html=True), name="ui")
