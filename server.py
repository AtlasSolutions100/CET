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
import math
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


def _result_stale(job_id: str, page: int) -> bool:
    """True when a stored result was produced by DIFFERENT engine code.

    A result is cached on (pdf path, mtime), which says nothing about whether
    the code changed. See takeoff_engine.detect_page.engine_sig - a scale fix
    landed on 2026-08-22 while the browser kept serving the old wrong value
    out of this cache.
    """
    from takeoff_engine.detect_page import engine_sig

    f = _job_dir(job_id) / f"p{page}_result.json"
    if not f.exists():
        return False
    try:
        sig = json.loads(f.read_text()).get("engine_sig")
    except (OSError, ValueError):
        return True
    return sig != engine_sig()


@app.post("/api/job/{job_id}/page/{page}/detect")
def detect(job_id: str, page: int):
    job = JOBS.get(job_id) or _404()
    if job["status"].get(page) == "running":
        return {"status": "running", "queued": _is_queued(job_id, page)}
    if (_job_dir(job_id) / f"p{page}_result.json").exists() \
            and not _result_stale(job_id, page):
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
    # A result from older engine code is not "done" as far as the UI is
    # concerned: auto-loading it puts a number on screen that the current
    # engine would not produce, and the reviewer has no way to tell. Report
    # it as idle-with-a-reason so the page shows "not detected" and one
    # click on Detect recomputes it.
    if st == "done" and _result_stale(job_id, page):
        return {"status": "idle", "stale": True}
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


@app.post("/api/job/{job_id}/reset")
def reset_job(job_id: str, preview: bool = False):
    """Throw away everything DERIVED from this PDF, so the next detect is cold.

    This exists for demos. The review UI already forgets a document's saved
    decisions on request, but that only clears the browser: the service keeps
    every page's detection in p<N>_result.json and serves it straight back, so
    a "fresh" run in front of a client would replay a result computed hours
    earlier. That is a pre-warmed cache presented as a live run, which is the
    one thing a demo is not allowed to be.

    What goes: every derived artifact in this job's own directory - detection
    results, page renders, earthwork maps, callouts, symbols, schedules, AND
    the two that are operator work rather than cache: the approved sheet
    exports (p<N>_elements.json) and any report PDF already built. Those two
    are counted separately and named in the confirmation dialog, because
    sweeping a deliverable away under the word "cached" is not consent.
    Pass preview=1 to get the counts back without deleting anything.

    What stays: the source PDF. It is never inside the job directory - a
    sample is opened by path from wherever it lives, and an upload is written
    to JOBS_DIR/upload_<hex>_<name>.pdf, a SIBLING of this directory. The
    guard below re-derives the directory from JOBS_DIR and refuses anything
    that does not resolve to a direct child of it, so a crafted job_id cannot
    walk out of the jobs tree. The registry entry also stays, so the document
    stays open in the UI and simply needs detecting again.
    """
    d = (JOBS_DIR / job_id).resolve()
    if d.parent != JOBS_DIR.resolve() or not d.is_dir():
        raise HTTPException(404, "unknown job")

    # Classify before touching anything. Two of these are OPERATOR WORK, not
    # cache: p<N>_elements.json is an approved sheet export, and the report PDF
    # is the only deliverable this product has. The first version of this route
    # swept them away with the renders under the word "cached", which is not
    # informed consent - so the UI asks for a preview first and names them.
    def kind(name: str) -> str:
        if name.endswith("_elements.json"):
            return "approved"
        if name.endswith(".pdf"):
            return "report"
        if name.endswith("_result.json"):
            return "detection"
        if name.endswith(".png"):
            return "render"
        return "other"

    counts = {"approved": 0, "report": 0, "detection": 0, "render": 0, "other": 0}
    freed = 0
    files = [f for f in sorted(d.iterdir()) if f.is_file()]
    for f in files:
        counts[kind(f.name)] += 1
        try:
            freed += f.stat().st_size
        except OSError:
            pass

    out = {"ok": True, "counts": counts, "total": len(files),
           "freed_mb": round(freed / 1048576, 2)}
    if preview:
        out["preview"] = True
        return out

    removed = 0
    for f in files:
        try:
            f.unlink()
            removed += 1
        except OSError:
            pass  # a file the operator has open elsewhere; report the rest

    # The in-memory status map is what makes the UI think a page is done.
    # Leaving it behind would show "detected" over a directory with nothing
    # in it - the screen disagreeing with the record, again.
    with JOBS_LOCK:
        j = JOBS.get(job_id)
        if j is not None:
            j["status"] = {}

    out["removed"] = removed
    return out


@app.get("/api/job/{job_id}/page/{page}/confidence")
def page_confidence(job_id: str, page: int):
    """Page-level trust signals for the review banner. Read-only.

    Two facts the detect result does not already carry, and both decide
    whether an operator should believe this sheet's numbers:

      * NOT TO SCALE when the sheet prints no ratio at all. ScaleResult
        .to_dict() returns None when there is no `best`, so `has_nts` is
        dropped in exactly the case where it matters most.
      * where each spot elevation's base elevation came from - the sheet's
        own legend note (the drafter telling us) or a consensus guess off
        other numbers on the page. Barn Civil p3 is the cautionary case:
        the guess landed a clean 200 ft high on all 272 grades and every
        value still read as a plausible elevation (earthwork.read_spot_datum).

    Text layer only - no OCR, no rasterising - and nothing here feeds a
    quantity. It costs one page parse (0.4-2.3 s measured), so the UI
    fetches it once per page and upgrades the banner when it lands, rather
    than holding up detect. Deliberately NOT folded into the detect result:
    that would change `detect_page.engine_sig` and stale every cached page
    in the corpus for a reporting change.
    """
    from takeoff_engine.earthwork import read_spot_datum, read_spot_grades
    from takeoff_engine.extract import page_lines as _page_lines
    from takeoff_engine.scale_detect import _NTS

    job = JOBS.get(job_id) or _404()
    doc = pymupdf.open(job["path"])
    try:
        if page < 0 or page >= doc.page_count:
            raise HTTPException(404, "no such page")
        pg = doc[page]
        has_nts = bool(_NTS.search(pg.get_text()))
        words = page_words(pg)
        lines = _page_lines(pg)
    finally:
        doc.close()
    try:
        spots = read_spot_grades(words, lines=lines)
    except Exception:
        spots = []
    declared = read_spot_datum(lines)
    # Which branch of read_spot_grades resolved each grade, reconstructed
    # from the same three inputs the reader itself used (value >= 1000 ->
    # printed in full; declared datum -> the sheet's own note; otherwise
    # the consensus guess). Reconstructed here rather than returned by the
    # reader so that no stored detect result changes shape.
    n_printed = n_note = n_inferred = n_unresolved = 0
    for g in spots:
        if not g.get("resolved"):
            n_unresolved += 1
        elif g["value"] >= 1000.0:
            n_printed += 1
        elif declared is not None and g["value"] < 100.0:
            n_note += 1
        else:
            n_inferred += 1
    return {
        "has_nts": has_nts,
        "spots": {
            "n": len(spots),
            "printed_in_full": n_printed,
            "from_sheet_note": n_note,
            "inferred": n_inferred,
            "unresolved": n_unresolved,
            "declared_datum": declared,
        },
    }


# ---------- the scale a human chose --------------------------------------
# Every foot, square foot and cubic yard on a sheet is one multiplication away
# from `ft_per_paper_inch`, and on a quarter of the pages that return a scale
# at all the sheet prints more than one - a plan and its details. The review
# UI lets the estimator pick which one governs the drawing and redraws every
# number on screen from it (webui/app.js renderScalePick). Until this file
# learned to read that pick, `approve` recomputed every length from the
# ENGINE's choice, so the screen and the exported takeoff disagreed with no
# symptom - Barn Landscaping L604 exported 4x low - and the export still
# stamped the number `(auto, text)` with the estimator's approval on it.
#
# The pick is stored BESIDE the detect result, never inside it, for two
# reasons that both matter:
#   * `_result_stale` throws the cached result away whenever engine code
#     changes (detect_page.engine_sig). A human's reading of which caption
#     governs the drawing is not invalidated by an engine edit.
#   * a re-detect rewrites p<N>_result.json wholesale.
# It is a judgement about the DRAWING, not an engine output, so it outlives
# both. `set_by` is the provenance, and it travels with the number all the
# way into the elements JSON and onto the face of the report PDF.

_BY_REVIEWER = "reviewer"

# The band a reviewer's scale has to land in to be usable at all.
#
# A number a person types is reachable from the review UI (webui/app.js
# renderScaleTyped) and from anything that POSTs `scale.ft_per_paper_inch`,
# and until this band existed neither had a floor or a ceiling: Gate 1
# posted 1e9 and the export came back quoting 1,967,692,500,000.1 ft with
# a straight face.
#
# It REFUSES, it does not clamp. A clamp turns a typo into a confident
# wrong number - the most expensive thing this engine can produce,
# because it reaches a bid - while a refusal costs one retype and says
# what it wanted. Measured, not assumed:
#
#   * 6,714 corpus pages read text-only through takeoff_engine.scale_detect
#     (out/verify/2026-08-23/scalebox/work/band_corpus.py; the per-page rows
#     are in band_corpus.json). 279 return a scale, and every one lands
#     between 0.3333 and 250.0 ft per paper inch, over 26 distinct values.
#   * FLOOR 0.0833 ft/in is 1/12 - FULL SIZE, one paper inch to one real
#     inch. Three separate things put it there and none of them is a
#     round number picked for looks:
#       - the smallest reading anywhere in that scan is 0.3333, and the
#         smallest from an UNAMBIGUOUS imperial caption is 0.4 (`5" = 2'`,
#         GAOA Star Meadow 007^S-01 New Foundation.pdf page 0). The 0.3333
#         is the engine reading `Scale 3:1` as if it were 3" = 1'-0"; read
#         as a ratio that caption means a 3x ENLARGEMENT (0.0278 ft/in),
#         so it is quoted here as the observed extreme, not as a scale we
#         vouch for.
#       - CONVENTION: the largest scale an architect's rule carries is
#         3" = 1'-0" = 0.3333 ft/in (see scale_detect._scan, which measured
#         it against drawn geometry on Barn Landscaping L804).
#       - full size is one step finer again, so the floor sits 4x below the
#         smallest thing this corpus reads and still admits a full-size
#         detail. Under it the drawing is ENLARGED past life size (2:1,
#         3:1, 4:1 shop detailing), which is not geometry anyone takes
#         quantities off.
#     It is 1/12 rounded DOWN to four places, so the number this module
#     PRINTS in its refusal is itself inside the band when typed back.
#   * CEILING 1000 ft/in is 4x the corpus maximum (1" = 250' on
#     client_meet/beaumont/SWR_Guide_Residence_-_Civil_5.8.26.pdf, engine
#     page index 8) and 2.5x scale_detect._scan's own text-caption accept
#     ceiling of 400. At 1000 ft/in a 36-inch-wide sheet spans 6.8 miles.
#   * scale_detect's own FLOOR of 0.33 is deliberately not reused: it is
#     there to stop a dimension string (`6" - 2'` = 0.3333) reading as a
#     scale, an ambiguity a number typed on purpose does not have.
#
# The band cannot catch a plausible-but-wrong number (20 typed as 200 is
# inside it). Nothing here can. That is what the amber banner and the
# `set by the reviewer` provenance on the export and the PDF are for.
SCALE_FT_MIN = 0.0833
SCALE_FT_MAX = 1000.0


def _sane_ft(v) -> float | None:
    """A usable feet-per-paper-inch, or None - which means REFUSE.

    Never substitutes a default. Every caller says out loud that it
    refused; silently falling back to another number is how a scale a
    person set stops being the scale the deliverable used.
    """
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(f):
        return None
    return f if SCALE_FT_MIN <= f <= SCALE_FT_MAX else None


def _refuse_scale(v) -> HTTPException:
    """Why this number was refused, in the words the reviewer needs."""
    return HTTPException(400, (
        f"scale {v!r} is not a usable number of feet per paper inch. "
        f"This app accepts {SCALE_FT_MIN:.4f} to {SCALE_FT_MAX:g} - "
        f"from full size (1 inch of paper = 1 real inch) to 1 inch = "
        f"{SCALE_FT_MAX:g} ft, which already covers every scale this app "
        f"has read anywhere in the plan corpus (0.33 to 250). Nothing was "
        f"changed; retype the scale."))


def _scale_pick_path(job_id: str, page: int) -> Path:
    return _job_dir(job_id) / f"p{page}_scale.json"


def _stored_scale_pick(job_id: str, page: int) -> dict | None:
    f = _scale_pick_path(job_id, page)
    if not f.exists():
        return None
    try:
        d = json.loads(f.read_text())
    except (OSError, ValueError):
        return None
    # An out-of-band sidecar can now only come from a hand edit or an
    # older build - the approve route refuses to write one. Ignoring it
    # drops the page back to the engine's reading, which the chip, the
    # banner and the export all state as `auto`: visible, not silent.
    return d if _sane_ft(d.get("ft_per_paper_inch")) is not None else None


def _page_scale(job_id: str, page: int, res: dict,
                sent: "ApproveScale | None" = None) -> dict | None:
    """The scale this page's quantities are computed from, and who set it.

    Returns the engine's scale dict with `set_by` added ("auto" or
    "reviewer"), plus `engine_*` recording what the engine had thought when a
    human overruled it - or None when the sheet has no scale at all.

    `sent` is what the review UI had ON SCREEN when Approve was pressed, and
    it wins: the deliverable must never disagree with the screen the human
    approved (CLAUDE.md 1). A pick is written to disk so a reload, a
    re-detect and a later re-approve all agree with it; approving the
    engine's own reading retires an earlier pick rather than letting it
    outlive the screen.
    """
    eng = res.get("scale") or None
    eng_ft = None
    if eng:
        try:
            eng_ft = float(eng.get("ft_per_paper_inch") or 0) or None
        except (TypeError, ValueError):
            eng_ft = None
    pick = None
    want = 0.0
    if sent is not None:
        # Refuse rather than ignore. Quietly dropping a number the screen
        # was showing would export the ENGINE's scale under the human's
        # approval - the exact disagreement this function exists to end.
        checked = _sane_ft(sent.ft_per_paper_inch)
        if checked is None:
            raise _refuse_scale(sent.ft_per_paper_inch)
        want = checked
    if want > 0:
        # A screen that DIFFERS from the engine had a person change it,
        # whatever flag came with it. The converse is not true, and the
        # flag alone must NOT record a pick: renderScalePick stamps
        # picked_by_reviewer on every click including the button already
        # ON, so clicking away and back again would land here with the
        # engine's own value and make the export say 'set by the reviewer;
        # the engine had read <the same number>' - self-contradicting, and
        # it writes a sidecar where the rule below says to retire one.
        # Found by Gate 1 on the live UI. Value only.
        same_as_engine = eng_ft is not None and abs(eng_ft - want) < 1e-9
        if not same_as_engine:
            pick = {"ft_per_paper_inch": want,
                    "text": (sent.text or "").strip() or None,
                    "set_by": _BY_REVIEWER,
                    "set_at": time.strftime("%Y-%m-%dT%H:%M:%S")}
            try:
                _scale_pick_path(job_id, page).write_text(
                    json.dumps(pick, indent=1))
            except OSError:
                pass  # unwritable: this approve still honours the screen
        else:
            try:
                _scale_pick_path(job_id, page).unlink(missing_ok=True)
            except OSError:
                pass
    else:
        # Nothing on the wire (an older UI, or a re-approve from a script):
        # an earlier human decision is still the best information this page
        # has, and it deliberately survived the re-detect.
        pick = _stored_scale_pick(job_id, page)
    if pick is None:
        return None if eng is None else {**eng, "set_by": "auto"}
    out = dict(eng or {})
    out.update({
        "text": pick.get("text") or (eng or {}).get("text"),
        "ft_per_paper_inch": float(pick["ft_per_paper_inch"]),
        "set_by": _BY_REVIEWER,
        "set_at": pick.get("set_at"),
        # read off the CURRENT result, so the comparison printed next to the
        # human's number is what the engine thinks NOW, not a stale copy
        "engine_ft_per_paper_inch": eng_ft,
        "engine_text": (eng or {}).get("text"),
        "engine_source": (eng or {}).get("source"),
        # both were measured against the engine's number, not this one
        "agrees": None,
        "delta_pct": None,
    })
    return out


def _ft(v) -> str:
    """4.0 -> "4", 5.3333 -> "5.33". Estimators read feet per paper inch."""
    try:
        return f"{float(v):.2f}".rstrip("0").rstrip(".")
    except (TypeError, ValueError):
        return "?"


def _scale_name(det: dict) -> str:
    """What the export calls this scale. A number a person chose must never
    be labelled `auto`: his approval is on it, and a reader downstream has no
    other way to know the engine was overruled."""
    text = det.get("text") or f'1 inch = {_ft(det.get("ft_per_paper_inch"))} ft'
    if det.get("set_by") != _BY_REVIEWER:
        return f'{text} (auto, {det.get("source") or "unknown"})'
    if det.get("engine_ft_per_paper_inch"):
        return (f'{text} (set by the reviewer; the engine had read '
                f'{det.get("engine_text") or "?"} = '
                f'{_ft(det["engine_ft_per_paper_inch"])} ft per inch)')
    return f'{text} (set by the reviewer; the engine read no scale here)'


def _scale_report_lines(sc: dict | None, image_dpi=None) -> list[str]:
    """The scale statement printed on the face of the report PDF. A printed
    takeoff whose scale a person overrode has to say so where it is read.

    `ftPerPaperInch` is only written for a reviewer pick, and elements files
    approved before this endpoint learned about picks have neither - so the
    auto case is recovered from the pixels-per-foot the export already
    carried, which is exactly image_dpi / ft_per_paper_inch."""
    if not sc:
        return ["Scale: none was read on this sheet - no footage can be "
                "quoted from it."]
    ppu = sc.get("pixelsPerUnit")
    ft = sc.get("ftPerPaperInch")
    if ft is None and ppu and image_dpi:
        ft = image_dpi / ppu
    head = f"Scale: 1 inch = {_ft(ft)} ft" if ft else "Scale"
    if sc.get("setBy") != _BY_REVIEWER:
        return [f'{head}   [{sc.get("name", "")}]']
    eng = sc.get("engineFtPerPaperInch")
    out = [f"{head}   - SET BY THE REVIEWER, not read by the engine."]
    if eng:
        out.append(f'The engine had read 1 inch = {_ft(eng)} ft '
                   f'({sc.get("engineText") or "?"}). Every length below is '
                   f"computed from the reviewer's scale.")
    else:
        out.append("The engine found no scale on this sheet. Every length "
                   "below is computed from the reviewer's scale.")
    return out


class ApproveScale(BaseModel):
    # the scale in force ON SCREEN when Approve was pressed, in feet of real
    # world per paper inch. `picked_by_reviewer` is the review UI's own flag
    # for "a human chose this instead of the engine's reading".
    ft_per_paper_inch: float
    text: str | None = None
    picked_by_reviewer: bool = False


class QtyOverride(BaseModel):
    """A number a person typed over a computed one.

    Until 2026-08-24 there was no field for this and the server recomputed
    every footage from geometry, so the review panel and the CSV showed the
    operator's corrected figure while elements.json and the report PDF showed
    the detector's - same line item, different number, no warning anywhere.
    """
    label: str
    # the review UI's own two-way split (webui/app.js ovKey): "qty" for a row
    # counted in EACHes, "ft" for everything measured by length or carrying a
    # calculator's own unit. Keyed and split exactly as the UI keys it.
    kind: str = "ft"
    # float, not int: an EA box accepts 3.5 and a 422 on approve is not an
    # answer to that.
    qty: float
    # what the count column showed: "ft"/"pt" for a measured row, else
    # EA / CY / SF / LF. "pt" means this sheet had no scale.
    unit: str = "ft"
    # the computed figure being replaced. Never dropped: an export that
    # cannot show what was measured cannot be audited.
    engine_qty: float | None = None


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
    # as countable pieces (shear-wall segments, pads) instead of footage.
    # float, not int: the quantity box is an <input type="number"> and
    # nothing stops a reviewer typing 3.5 into it. Declared int, pydantic
    # answered a 422 whose detail is a LIST OF DICTS, which the review UI
    # rendered as the string "[object Object]" - so a whole approve failed
    # and the operator was told nothing at all. Half a pad is a strange
    # quantity, but refusing to record it is not this field's job.
    object_counts: dict[str, float] = {}
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
    # Free-text lines printed on the FACE of the report PDF, under the scale
    # statement. A quantity whose basis the reader cannot see is exactly what
    # this product must not ship: the review UI sends the earthwork caveat
    # here (contour interpolation, how many contours, region not bounded), so
    # a person holding only the PDF learns it too. Bounded in `approve`.
    notes: list[str] = []
    # the scale the reviewer had on screen. Omitted = keep whatever this page
    # already decided (a stored pick, else the engine's). See _page_scale.
    scale: ApproveScale | None = None
    # label -> the quantity the operator typed over the computed one, for
    # EVERY row kind the itemized panel shows: footage, EA object count,
    # symbol count, calculator CY/SF/LF. Built from computeTakeoffRows(), the
    # same single function the panel and the CSV are built from - so the
    # export cannot drift from the screen the way the hand-assembled payload
    # did. See QtyOverride.
    quantity_overrides: list["QtyOverride"] = []


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
    det = _page_scale(job_id, page, res, body.scale)
    if det:
        # pixels-per-foot in the export's own pixel space; the app rescales
        # to its stored image width at import
        export["scale"] = {
            "pixelsPerUnit": body.image_dpi / det["ft_per_paper_inch"],
            "unit": "ft",
            "name": _scale_name(det),
        }
        if det.get("set_by") == _BY_REVIEWER:
            # machine-readable twin of the sentence in `name`, so no consumer
            # has to parse English to learn that a human set this number
            export["scale"].update({
                "setBy": _BY_REVIEWER,
                "ftPerPaperInch": det["ft_per_paper_inch"],
                "engineFtPerPaperInch": det.get("engine_ft_per_paper_inch"),
                "engineText": det.get("engine_text"),
                "setAt": det.get("set_at"),
            })
    # itemization: per-label count + footage (when scale known) + pricing
    ft_per_in = det["ft_per_paper_inch"] if det else None
    totals: dict = {}
    for el in elements:
        t = totals.setdefault(el["label"], {"count": 0, "length_pt": 0.0})
        t["count"] += 1
        t["length_pt"] += el["lengthPt"]
    # `qty <= 0` is "no override" here because it is "no override" in the box:
    # computeTakeoffRows applies one only `if (!isNaN(ov) && ov > 0)`.
    ov_ft: dict = {}
    ov_qty: dict = {}
    ov_used: set = set()
    ov_warn: list = []
    for _o in body.quantity_overrides:
        _lab = (_o.label or "").strip()
        if not _lab or _o.qty is None or _o.qty <= 0:
            continue
        (ov_qty if _o.kind == "qty" else ov_ft)[_lab] = _o

    items = []
    for label, t in sorted(totals.items(), key=lambda kv: -kv[1]["length_pt"]):
        ft = t["length_pt"] / 72.0 * ft_per_in if ft_per_in else None
        price = body.prices.get(label)
        n_obj = body.object_counts.get(label)
        # PRESENCE, not truthiness. object_counts now carries the DETECTED
        # count, and a style the reviewer put in object mode that yielded
        # zero objects sent 0 - which `if n_obj:` read as "not an object
        # row", quietly rerouting it into the footage branch and dropping
        # any EA override on it. CLAUDE.md section 5, "0.0 is not None".
        if n_obj is not None:
            o = ov_qty.get(label)
            qty = float(o.qty) if o else n_obj
            if o:
                ov_used.add(("qty", label))
            # priced per EACH: footage stays as reference, money follows count
            items.append({
                "label": label, "count": t["count"],
                "trade": body.trades.get(label),
                "length_ft": round(ft, 1) if ft is not None else None,
                "qty": qty, "unit": "EA",
                "unit_price": price,
                "extended": round(qty * price, 2) if price else None,
                **({"qty_set_by": _BY_REVIEWER, "engine_qty": n_obj} if o else {}),
            })
        else:
            o = ov_ft.get(label)
            billed = ft
            if o and ft is not None:
                billed = round(float(o.qty), 1)
                ov_used.add(("ft", label))
            items.append({
                "label": label, "count": t["count"],
                "trade": body.trades.get(label),
                "length_ft": round(billed, 1) if billed is not None else None,
                "unit_price": price,
                "extended": round(billed * price, 2) if (billed is not None and price) else None,
                # The geometry still measures the original, and the per-chain
                # elements in this same file still sum to it. Both figures are
                # carried so a reader can reconcile them rather than guess.
                **({"qty_set_by": _BY_REVIEWER,
                    "engine_length_ft": round(ft, 1)} if (o and ft is not None) else {}),
            })
    for ex in body.extra_items:
        try:
            qty = round(float(ex.get("qty", 0)), 1)
        except (TypeError, ValueError):
            continue
        raw_label = str(ex.get("label", "")).strip()
        label = raw_label[:80]
        if not label or qty <= 0:
            continue
        price = ex.get("unit_price")
        try:
            price = float(price) if price is not None else None
        except (TypeError, ValueError):
            price = None
        unit = str(ex.get("unit", ""))[:8] or "EA"
        # `unit == "EA"` exactly, not .upper(): the UI splits on the same
        # literal, and a case difference here would read the wrong bucket.
        # Looked up on the UNTRUNCATED label, which is what the UI keyed on.
        o = (ov_qty if unit == "EA" else ov_ft).get(raw_label)
        eng_qty = qty
        if o:
            qty = round(float(o.qty), 1)
            ov_used.add(("qty" if unit == "EA" else "ft", raw_label))
        items.append({
            "label": label, "count": 1, "length_ft": None,
            "trade": body.trades.get(label),
            "qty": qty, "unit": unit,
            "unit_price": price,
            "extended": round(qty * price, 2) if price else None,
            **({"qty_set_by": _BY_REVIEWER, "engine_qty": eng_qty} if o else {}),
        })
    trade_rank = {t: i for i, t in enumerate((
        "Earthwork & Grading", "Wet Utilities", "Dry Utilities",
        "Paving & Concrete", "Structures", "Fencing & Sitework", "General"))}
    items.sort(key=lambda it: (trade_rank.get(it.get("trade"), 99),))
    # Anything the operator typed that matched no row here. Silence would let
    # a renamed or unticked row swallow a correction without trace.
    for _o in body.quantity_overrides:
        _lab = (_o.label or "").strip()
        if not _lab or _o.qty is None or _o.qty <= 0:
            continue
        if (_o.kind, _lab) not in ov_used:
            ov_warn.append(f'"{_lab}": a typed quantity matched no row in this '
                           f"export and was NOT applied.")

    export["items"] = items
    # Written even when empty, on purpose: [] says "this export knows what an
    # override is and has none", which a file predating the field cannot say.
    # A reader has to be able to tell those two apart.
    export["overrides"] = [
        {"label": it["label"],
         "kind": "qty" if it.get("unit") else "ft",
         "unit": it.get("unit") or "ft",
         "qty": it.get("qty") if it.get("qty") is not None else it["length_ft"],
         "engine_qty": it.get("engine_qty") if it.get("engine_qty") is not None
                       else it.get("engine_length_ft")}
        for it in items if it.get("qty_set_by") == _BY_REVIEWER
    ]
    if ov_warn:
        export["override_warnings"] = ov_warn[:12]
    # verbatim onto the report (report_pdf prints them under the scale
    # lines); capped so no caller can paper over the table with prose
    export["notes"] = [str(x).strip()[:400] for x in body.notes[:6]
                       if str(x).strip()]
    out = _job_dir(job_id) / f"p{page}_elements.json"
    out.write_text(json.dumps(export, indent=1))
    return JSONResponse({"exported": len(elements), "file": str(out),
                         "items": items, "scale": export.get("scale"),
                         "overrides": export["overrides"],
                         "override_warnings": ov_warn})


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


@app.get("/api/job/{job_id}/page/{page}/scale")
def get_scale_pick(job_id: str, page: int):
    """The scale decision recorded for this page: what the engine reads NOW,
    and whether a human overruled it and with what.

    Read-only, and it changes nothing. It exists so the recorded decision is
    inspectable without opening the job directory - and so the review UI can
    one day restore a pick after a browser reload, which today it cannot:
    the pick lives in an in-memory Map (webui/app.js `store`), so a reload
    forgets it, the screen falls back to the engine's reading, and approving
    that screen correctly retires the recorded pick. See _page_scale.
    """
    f = _job_dir(job_id) / f"p{page}_result.json"
    eng = None
    if f.exists():
        try:
            eng = (json.loads(f.read_text()).get("scale") or {}) or None
        except (OSError, ValueError):
            eng = None
    pick = _stored_scale_pick(job_id, page)
    return {
        "engine": None if not eng else {
            "ft_per_paper_inch": eng.get("ft_per_paper_inch"),
            "text": eng.get("text"), "source": eng.get("source")},
        "reviewer": pick,
        "in_force": (pick or {}).get("ft_per_paper_inch")
                    or (eng or {}).get("ft_per_paper_inch"),
    }


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
    import textwrap

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
    all_notes: list[str] = []
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
        y += 17
        # Every number in the table below is this multiplication. When a
        # person overrode the engine's reading, the printed takeoff says so
        # on its own face - the reader of the PDF has no other way to know.
        for _ln in _scale_report_lines(exp.get("scale"), exp.get("imageDpi")):
            tp.insert_text((50, y), _ln[:118], fontsize=8)
            y += 11
        # Caveats the reviewer's calculators attached to their own rows. They
        # sit ABOVE the table on purpose: a reader who stops at the first
        # number has already passed them.
        # Above the table, like every other caveat here: a reader who stops
        # at the first number has already passed it.
        _ovs = exp.get("overrides") or []
        if _ovs:
            for _seg in textwrap.wrap(
                    f"{len(_ovs)} quantity(ies) on this sheet were SET BY THE "
                    "REVIEWER, replacing the measured figure. Each is marked * "
                    "with the measured value printed under it. The line "
                    "geometry in the data export still measures the original "
                    "figure.", 118):
                tp.insert_text((50, y), _seg, fontsize=8)
                y += 11
        for _nt in (exp.get("notes") or []):
            if _nt not in all_notes:
                all_notes.append(_nt)
            for _seg in (textwrap.wrap(str(_nt), 118) or [""]):
                tp.insert_text((50, y), _seg, fontsize=8)
                y += 11
        y += 8
        tp.insert_text((50, y), "Label", fontsize=9)
        tp.insert_text((300, y), "Count", fontsize=9)
        tp.insert_text((360, y), "Length (ft)", fontsize=9)
        tp.insert_text((440, y), "Unit $", fontsize=9)
        tp.insert_text((500, y), "Extended $", fontsize=9)
        y += 14
        page_total = 0.0
        for it in items:
            # a row printing a sub-line needs the break a little earlier
            _sub = (it.get("qty_set_by") == _BY_REVIEWER) \
                or (it.get("unit") and it.get("length_ft") is not None)
            if y > (722 if _sub else 740):
                tp = out.new_page(width=612, height=792)
                y = 60
            _ov = it.get("qty_set_by") == _BY_REVIEWER
            tp.insert_text((50, y), (str(it["label"])[:50] + " *") if _ov
                           else str(it["label"])[:52], fontsize=9)
            tp.insert_text((300, y), str(it["count"]), fontsize=9)
            # Choose the column by the row's UNIT, not by whether length_ft
            # happens to be populated. An EA row keeps its footage as a
            # REFERENCE, so the old test printed that footage in the
            # "Length (ft)" cell of a row that was priced from a COUNT -
            # Length x Unit $ did not equal Extended $, which is either an
            # unnoticed wrong quantity or a visible contradiction. The
            # reference footage moves to the sub-line below.
            if it.get("unit"):
                _q = it.get("qty")
                _u = (" " + it["unit"]).rstrip()
            else:
                _q = it["length_ft"]
                _u = ""
            # a calculator row that rounded to whole units is a whole
            # number: round(x, 1) leaves 13677.0, which prints
            # "13,677.0 CY" and re-asserts the tenth the rounding removed.
            # Guarded on _u so the footage column is untouched.
            if _q is not None and _u and float(_q).is_integer():
                _q = int(_q)
            tp.insert_text((360, y), f"{_q:,}{_u}" if _q is not None else "-", fontsize=9)
            tp.insert_text((440, y), f'{it["unit_price"]:.2f}' if it.get("unit_price") else "-", fontsize=9)
            tp.insert_text((500, y), f'{it["extended"]:,.2f}' if it.get("extended") else "-", fontsize=9)
            if it.get("extended"):
                page_total += it["extended"]
            # An EA/CY row's reference footage, stated as reference.
            if it.get("unit") and it.get("length_ft") is not None:
                y += 11
                tp.insert_text((60, y),
                               f'({it["length_ft"]:,} ft of line carries this row)',
                               fontsize=8)
            if _ov:
                _e = it.get("engine_length_ft")
                _eu = "ft"
                if _e is None:
                    _e = it.get("engine_qty")
                    _eu = it.get("unit") or ""
                _typed = it.get("qty") if it.get("qty") is not None else it["length_ft"]
                y += 11
                tp.insert_text((60, y),
                               f"* set by the reviewer: {_typed:,} "
                               f"{it.get('unit') or 'ft'}"
                               + (f". Measured on this sheet: {_e:,} {_eu}."
                                  if _e is not None else "."),
                               fontsize=8)
            # Keyed by (label, UNIT). Footage-only accumulation printed an EA
            # row's REFERENCE footage into the project footage total, and gave
            # a 172,094 CY earthwork row a summary line reading "0.0" under
            # "Length (ft)" - a real quantity rendered as nothing, on the page
            # a client is most likely to read.
            _unit = it.get("unit") or "ft"
            g = grand.setdefault((it["label"], _unit),
                                 {"count": 0, "qty": 0.0, "ext": 0.0,
                                  "eng": 0.0, "ov": False, "unit": _unit})
            g["count"] += it["count"]
            if _unit == "ft":
                g["qty"] += it["length_ft"] or 0.0
                _ef = it.get("engine_length_ft")
                g["eng"] += (_ef if _ef is not None else it["length_ft"]) or 0.0
            else:
                g["qty"] += it.get("qty") or 0.0
                _eq = it.get("engine_qty")
                g["eng"] += (_eq if _eq is not None else it.get("qty")) or 0.0
            g["ov"] = g["ov"] or it.get("qty_set_by") == _BY_REVIEWER
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
    y += 17
    # Truth in labelling, not de-duplication. These rows add each approved
    # sheet's footage together; the same run drawn on four sheets is in here
    # four times. Matching runs ACROSS sheets is a rotation-invariant problem
    # whose first attempt failed on a bucket edge, and getting it wrong
    # deletes real footage - so the row says what it is instead of pretending.
    tp.insert_text((50, y), f"{len(pages)} approved sheet(s), added together. "
                            "Nothing is de-duplicated across sheets.",
                   fontsize=8)
    y += 11
    # This page repeats the rows, so it repeats what they rest on. A reader
    # who turns straight to the summary must not be the one person who never
    # sees the caveat attached to a quantity in it.
    for _nt in all_notes[:8]:
        for _seg in (textwrap.wrap(str(_nt), 118) or [""]):
            tp.insert_text((50, y), _seg, fontsize=8)
            y += 11
    # Define the star BEFORE the rows that carry it. A row whose typed and
    # measured totals happen to match prints the star with no per-row
    # explanation, so the page needs its own.
    if any(g["ov"] for g in grand.values()):
        for _seg in textwrap.wrap(
                "* one or more quantities under this label were SET BY THE "
                "REVIEWER rather than measured. Where the totals differ, the "
                "measured figure is printed under the row.", 118):
            tp.insert_text((50, y), _seg, fontsize=8)
            y += 11
    y += 10
    tp.insert_text((50, y), "Label", fontsize=9)
    tp.insert_text((300, y), "Count", fontsize=9)
    tp.insert_text((360, y), "Quantity", fontsize=9)
    tp.insert_text((500, y), "Extended $", fontsize=9)
    y += 14
    total = 0.0
    # Footage rows first and biggest-first within a unit, so the page still
    # reads the way it did; a CY or EA row can no longer sort as if it were 0.
    for (label, _u), g in sorted(
            grand.items(),
            key=lambda kv: (kv[1]["unit"] != "ft", -kv[1]["qty"])):
        if y > (728 if g["ov"] else 740):
            tp = out.new_page(width=612, height=792)
            y = 60
        tp.insert_text((50, y), (label[:50] + " *") if g["ov"] else label[:52],
                       fontsize=9)
        tp.insert_text((300, y), str(g["count"]), fontsize=9)
        _qs = f'{g["qty"]:,.1f}' if g["unit"] == "ft" else f'{g["qty"]:,g}'
        tp.insert_text((360, y), f'{_qs} {g["unit"]}', fontsize=9)
        tp.insert_text((500, y), f'{g["ext"]:,.2f}' if g["ext"] else "-", fontsize=9)
        total += g["ext"]
        if g["ov"] and abs(g["eng"] - g["qty"]) > 0.05:
            y += 11
            tp.insert_text((60, y),
                           "* includes a quantity set by the reviewer; the "
                           f'measured total was {g["eng"]:,.1f} {g["unit"]}.',
                           fontsize=8)
        y += 13
    if total:
        y += 10
        tp.insert_text((277, y), "SUM OF APPROVED SHEETS:", fontsize=11)
        tp.insert_text((500, y), f"{total:,.2f}", fontsize=11)
        y += 14
        tp.insert_text((50, y), "Not a project total: a run drawn on several "
                                "sheets is counted once per sheet.",
                       fontsize=8)

    pdf_path = jd / "takeoff_report.pdf"
    # deflate=True, garbage=4 - NOT cosmetic. Measured on one Beaumont sheet
    # (engine page 6, 5460x3900 overlay at 130 dpi): out.save() alone writes
    # 63.89 MB against a 4.30 MB source stream, because the image goes in
    # uncompressed and the xref is never collected. With these two arguments
    # it is 3.45 MB - 18.5x smaller, pixels byte-identical (verified by
    # comparing re-rendered pixmaps). The ratio varies with ink density; a
    # sparser sheet measured 25.1x. A 15-sheet job was ~958 MB, i.e. the
    # product's only deliverable could not be emailed. Do not remove.
    out.save(pdf_path, deflate=True, garbage=4)
    return FileResponse(pdf_path, media_type="application/pdf",
                        filename=f"takeoff_{Path(job['path']).stem[:30]}.pdf")


class AnalyzeResponse(BaseModel):
    pass


# ---------------------------------------------------------------------------
# Analyze: an assistant whose hit rate is known.
#
# This endpoint reads a sheet with a vision model. It was OFF until
# 2026-08-23 for a reason that has not gone away: its output re-ticks and
# re-labels a takeoff, and until we had ground truth there was nothing to
# score it against. There now is (ground-truth/*.json, 33 pages), so every
# field below carries the hit rate it actually earned, measured over three
# runs on those pages. The numbers live in _AI_GRADES and travel with the
# payload so the UI can label each suggestion with its own score instead of
# presenting all of them as equally trustworthy.
#
# Two rules that are not negotiable regardless of any future score:
#   * nothing here writes the takeoff. Every proposal is shown, attributed
#     to the model, accepted one at a time and individually reversible.
#   * nothing here is evidence for the confidence banner. A model that
#     agrees with the engine is not a second independent source - they can
#     read the same printed caption and be wrong together.
#
# _AI_GRADES fields: n = scored opportunities, hit = hit rate over the three
# runs, stable = share of items identical across all three runs, verdict =
# what the UI is allowed to do with it. Provenance for every number is in
# out/verify/2026-08-23/aiscored/SCORES.md.
_AI_GRADES: dict = {
    "_measured": "33 ground-truth pages x 3 runs (99 calls, 98 answered), "
                 "xai:grok-4-fast-reasoning, 2026-08-23. Full working in "
                 "out/verify/2026-08-23/aiscored/SCORES.md.",
    "sheet_id": {
        "hit": "18/18 replies right on the 6 pages that carry a "
               "human-confirmed sheet number",
        "stable": "identical in all 3 runs on 32/32 pages",
        "use": "show"},
    "sheet_title": {
        "hit": "24/33 replies right on the 11 pages that carry a "
               "human-confirmed title; 8/11 pages right in every run and "
               "the other 3 wrong in every run",
        "stable": "identical in all 3 runs on 24/32 pages",
        "use": "show"},
    "scale_text": {
        "hit": "27 of the 31 times it answered on a page whose printed "
               "caption we read by eye; 4 wrong, all four on the scanned "
               "aqua-vista set. Where the engine already has a scale it "
               "contradicted it 0 times in 44 replies and abstained 16",
        "stable": "identical in all 3 runs on 30/32 pages",
        "use": "show, never apply"},
    "focus": {
        "hit": "15% of its focus rows on a layered sheet (29/190) name a "
               "HATCH layer, whose stroke length is not a quantity. One "
               "click on all of them keeps a median 18% of the page's "
               "drawn length and drops the rest",
        "stable": "same set in all 3 runs on 8/32 pages; pairwise Jaccard "
                  "0.68 mean, 0.00 worst",
        "use": "one row at a time"},
    "ignore": {
        "hit": "17% of its ignore rows on a layered sheet (248/1471) drop "
               "a WALL / FTNG / SLAB / CURB / PIPE layer - real work",
        "stable": "same set in all 3 runs on 9/32 pages",
        "use": "one row at a time"},
    "label": {
        "hit": "not scorable: on layered sheets the CAD layer name is "
               "already in the prompt (it repeats it 47% of the time), and "
               "the 57 focus rows with no layer have no truth file",
        "stable": "50% - the label matched on 28 of the 56 style_ids that "
                  "all three runs focused",
        "use": "one row at a time"},
    "page_modes": {
        "hit": "earthwork and trench never flickered between runs (1 and 2 "
               "pages); count flickered on 6/32 pages and objects on 5/32",
        "stable": "identical in all 3 runs on 21/32 pages",
        "use": "earthwork and trench chips only"},
    "confidence": {
        "hit": "NOT calibrated - 'high' was right on 10/13 title-block "
               "fields and 'medium' on 32/38, i.e. the wrong way round",
        "stable": "identical in all 3 runs on 18/32 pages",
        "use": "hidden"},
}


def _ai_norm_name(s) -> str:
    """Loose comparison key for two names of the same thing: case, spaces,
    punctuation and CAD's abbreviation dashes all dropped."""
    return "".join(ch for ch in str(s or "").lower() if ch.isalnum())


def _ai_same_name(a, b) -> bool:
    """True when the model's label is the CAD layer name back again. Not a
    quality judgement - an echo can be the right answer - but the UI must
    not sell it as the model having read the drawing."""
    na, nb = _ai_norm_name(a), _ai_norm_name(b)
    if not na or not nb:
        return False
    return na == nb or na in nb or nb in na


def _ai_prompt(text: str, styles_ctx: str, legend_ctx: str,
               variant: str = "graded") -> str:
    """The question we put to the model.

    variant="shipped" reproduces the prompt as it stood at c344420, kept so
    the added asks (sheet id / title / scale) can be shown not to have moved
    the focus and ignore hit rates. Set TAKEOFF_AI_PROMPT_VARIANT=shipped on
    a scratch instance to measure that arm; the service never sets it.
    """
    head = (
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
        '  confidence: "high" | "medium" | "low"\n')
    if variant == "shipped":
        return head + ('Keep every "why" under 12 words so the reply is not '
                       'truncated.')
    # The title block and the scale caption are things the sheet ASSERTS
    # about itself, so they are cheap to ask for and cheap to check. Both
    # are scored; see _AI_GRADES for what the UI does with them.
    return head + (
        '  sheet_id: the sheet number printed in the title block, e.g. '
        '"A-2.00" or "C4.3", or null if you cannot read one\n'
        '  sheet_title: the sheet title printed in the title block, copied '
        'exactly, or null\n'
        '  scale_text: the drawing scale exactly as printed on the sheet, '
        'e.g. "1/4\\" = 1\'-0\\"" or "1\\"=20\'", or null if no scale is '
        'printed. If several are printed, give the one for the main plan '
        'view. Never compute or guess one: null is the right answer when '
        'the sheet does not say.\n'
        'Copy sheet_id, sheet_title and scale_text off the drawing '
        'character for character - do not tidy, expand or normalise them.\n'
        'Keep every "why" under 12 words so the reply is not truncated.')


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

    t_start = time.time()
    _ck = (job_id, page)
    if not fresh and _ck in _AI_SESSION_CACHE:
        return JSONResponse(_AI_SESSION_CACHE[_ck])

    # A missing dependency used to surface as a bare 500 with the traceback
    # only in the server log, which is how this endpoint spent two weeks
    # "broken" for an install reason. Name the package.
    try:
        import requests as _rq
    except ImportError:
        raise HTTPException(
            503, "Analyze needs the 'requests' package on the detection "
                 "service (pip install -r requirements.txt).")

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
            503, "Analyze has no LLM key. Set XAI_API_KEY (Grok), "
                 "GROQ_API_KEY or ANTHROPIC_API_KEY in the detection "
                 "service's .env and restart it; nothing else on this page "
                 "needs a key.")

    job = JOBS.get(job_id) or _404()
    doc = pymupdf.open(job["path"])
    pg = doc[page]
    scale = 1400 / max(pg.rect.width, pg.rect.height)
    pix = pg.get_pixmap(matrix=pymupdf.Matrix(scale * 2, scale * 2))
    img_b64 = base64.standard_b64encode(pix.tobytes("jpeg")).decode()
    img_px = [pix.width, pix.height]
    text = pg.get_text()[:3000]

    styles_ctx = "(run Detect first - no styles known yet)"
    legend_ctx = ""
    known_ids: set = set()
    layer_of: dict = {}
    rf = _job_dir(job_id) / f"p{page}_result.json"
    if rf.exists():
        res = json.loads(rf.read_text())
        det = res.get("scale") or {}
        ft_per_in = det.get("ft_per_paper_inch")
        rows = []
        for st in res["styles"][:28]:
            known_ids.add(int(st["style_id"]))
            layer_of[int(st["style_id"])] = st.get("layer") or ""
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

    prompt = _ai_prompt(text, styles_ctx, legend_ctx,
                        os.environ.get("TAKEOFF_AI_PROMPT_VARIANT", "graded"))

    name, base, key, model = provider
    usage = {}
    t_model = time.time()
    # Every failure mode below reaches the operator as its own sentence.
    # "AI analysis failed (500)" tells nobody whether to retry, top up a
    # balance, or fix an install, and this endpoint has now been each of
    # those three.
    if name == "anthropic":
        import anthropic

        try:
            client = anthropic.Anthropic()
            msg = client.messages.create(
                model=model, max_tokens=2000, temperature=0,
                messages=[{"role": "user", "content": [
                    {"type": "image", "source": {"type": "base64",
                     "media_type": "image/jpeg", "data": img_b64}},
                    {"type": "text", "text": prompt}]}])
        except Exception as e:  # anthropic raises its own typed errors
            raise HTTPException(
                502, f"{name} ({model}) refused the request: "
                     f"{type(e).__name__}: {str(e)[:200]}")
        raw = msg.content[0].text
        u = getattr(msg, "usage", None)
        if u is not None:
            usage = {"prompt_tokens": getattr(u, "input_tokens", None),
                     "completion_tokens": getattr(u, "output_tokens", None)}
    else:
        try:
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
        except _rq.exceptions.Timeout:
            raise HTTPException(
                504, f"{name} ({model}) did not answer within 90s. The "
                     f"sheet is unchanged - press Analyze again to retry.")
        except _rq.exceptions.RequestException as e:
            raise HTTPException(
                502, f"Cannot reach {name} at {base}: "
                     f"{type(e).__name__}. Check the network, then retry.")
        if not r.ok:
            body = (r.text or "")[:200]
            # xAI answers a wrong key with 400 invalid-argument, not 401, so
            # the status alone does not identify this case. Measured against
            # a deliberately wrong key on 2026-08-23.
            bad_key = ("api key" in body.lower()
                       or "invalid-argument" in body.lower())
            if r.status_code in (401, 403) or (
                    r.status_code == 400 and bad_key):
                msg_ = (f"{name} rejected the API key (HTTP {r.status_code}). "
                        f"The key in the service's .env is wrong, revoked or "
                        f"has no access to {model}.")
            elif r.status_code == 429:
                ra = r.headers.get("retry-after")
                msg_ = (f"{name} rate-limited this request (HTTP 429)"
                        + (f"; retry after {ra}s. " if ra else ". ")
                        + "Nothing was changed on the sheet.")
            elif r.status_code == 404:
                msg_ = (f"{name} has no model called '{model}' (HTTP 404). "
                        f"Fix TAKEOFF_LLM_MODEL in the service's .env.")
            elif r.status_code in (402,):
                msg_ = (f"{name} declined for billing (HTTP 402): {body}")
            elif 500 <= r.status_code < 600:
                msg_ = (f"{name} is failing on its side (HTTP "
                        f"{r.status_code}): {body}. Retry shortly.")
            else:
                msg_ = f"{name} API error {r.status_code}: {body}"
            raise HTTPException(502, msg_)
        try:
            jr = r.json()
            raw = jr["choices"][0]["message"]["content"]
        except (ValueError, KeyError, IndexError, TypeError):
            raise HTTPException(
                502, f"{name} returned a reply this service could not read: "
                     f"{(r.text or '')[:200]}")
        u = jr.get("usage") or {}
        usage = {"prompt_tokens": u.get("prompt_tokens"),
                 "completion_tokens": u.get("completion_tokens"),
                 "total_tokens": u.get("total_tokens")}
    model_ms = int((time.time() - t_model) * 1000)

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
        # Not a 500 and not a silent shrug: say what came back instead.
        raise HTTPException(
            502, f"{name} ({model}) replied with something that is not JSON, "
                 f"so there is nothing to show. First 200 characters: "
                 f"{str(raw)[:200]}")

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
            # A label that just repeats the CAD layer we already handed the
            # model in the prompt is an echo, not a reading. The UI says so,
            # because "the AI named this" is a much stronger claim than the
            # model earned on those rows.
            lay = (layer_of.get(sid) or "").split("|")[-1]
            if lay:
                row["layer"] = lay
                row["echo"] = _ai_same_name(row.get("label"), lay)
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
    for k in ("sheet_id", "sheet_title", "scale_text"):
        v = parsed.get(k)
        parsed[k] = str(v)[:120] if isinstance(v, str) and v.strip() else None
    parsed["_invalid_style_ids"] = drop_f + drop_i
    parsed["_known_style_ids"] = len(known_ids)
    parsed["_layered_style_ids"] = sum(1 for v in layer_of.values() if v)
    parsed["_provider"] = f"{name}:{model}"
    parsed["_usage"] = usage
    parsed["_ms"] = {"model": model_ms,
                     "total": int((time.time() - t_start) * 1000)}
    parsed["_img_px"] = img_px
    parsed["_grades"] = _AI_GRADES
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
    # --- material balance (F87 B7) -------------------------------------
    # Each existing_layers row may also carry {reuse_pct, respread_pct,
    # destination}: what share of that removal is reused as structural
    # fill, what share is respread on site, and where the rest goes. The
    # remainder is exported. The defaults leave every removal at 100%
    # export - Beaumont Estimate #853 shows the stripped topsoil is NOT
    # structural reuse (earthwork.material_balance carries the arithmetic).
    # Site cut IS reused 1:1 against site fill in #853, so this defaults to
    # 100 - the only defaulted assumption in the balance.
    cut_reuse_pct: float = 100.0
    # Volumes are in-place yards between the two surfaces. #853 applies no
    # swell / shrink / compaction factor, so these default to 1.0; they
    # exist only so a user whose job needs one can enter it.
    export_factor: float = 1.0
    import_factor: float = 1.0


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
    # Lines as well as words: a spot grade written up the side of a sheet has
    # its tag and value on one PDF line but nowhere near each other on a
    # horizontal row, so the word reader misses every rotated label and can
    # pair a tag to the value beside it. See earthwork.read_spot_grades.
    from takeoff_engine.extract import page_lines as _page_lines
    lines = _page_lines(doc[page])
    doc.close()

    class _C:  # minimal chain view over the stored result
        def __init__(self, d):
            import numpy as _np
            self.chain_id = d["chain_id"]
            self.pts = _np.asarray(d["points"], float)
            self.length = d["length_pt"]
            self.width = d.get("width")
            # layer and linetype are what stop a profile box or a title
            # block entering the contour TIN, and stop an elevation being
            # inherited across two different objects whose ends happen to
            # meet (earthwork._is_plan_chain / the pass-2 union guard).
            # They are in the stored result; not lifting them here made
            # those guards a silent no-op on the service path even though
            # they measured correctly offline.
            self.layer = d.get("layer") or ""
            self.klass = d.get("class") or ""
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
    spots = read_spot_grades(words, lines=lines)

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
    """[{name, thickness_in}] -> (clean rows, total thickness ft).

    A removal row may also carry the material-balance disposition
    (reuse_pct / respread_pct / destination). It rides along untouched for
    material_balance() to read; it never affects the surface offset.
    """
    out, tot_in = [], 0.0
    for r in rows or []:
        try:
            t = float(r.get("thickness_in", 0) or 0)
        except (TypeError, ValueError):
            continue
        if t <= 0:
            continue
        out.append({"name": str(r.get("name") or "layer").strip() or "layer",
                    "thickness_in": t,
                    "reuse_pct": r.get("reuse_pct"),
                    "respread_pct": r.get("respread_pct"),
                    "destination": r.get("destination")})
        tot_in += t
    return out, tot_in / 12.0


def _earthwork_run(job_id: str, page: int, body: EarthworkBody,
                   return_grid: bool = False) -> dict:
    """Shared by the volumes endpoint and the map endpoint: build both
    surfaces from the stored chains, lower each by its layer stack, and
    difference them. Adds the per-layer volumes and the offsets used."""
    import numpy as _np

    from takeoff_engine.earthwork import (Surface, clamp_pct, cut_fill,
                                          material_balance)

    rf = _job_dir(job_id) / f"p{page}_result.json"
    if not rf.exists():
        raise HTTPException(404, "run detect first")
    res = json.loads(rf.read_text())
    # _page_scale, NOT res["scale"]. The reviewer can type a scale or pick a
    # different printed caption, and until 2026-08-23 these two volume routes
    # read the ENGINE's number straight out of the cached result and ignored
    # them both. Measured on Barn Civil engine page 2 = printed sheet 3 (C3.0):
    # type 1" = 60', watch every length on screen double, press Calculate, and
    # the CY came back computed at the engine's 30 ft/in - then priced,
    # exported and printed. Screen and deliverable disagreeing with nothing
    # saying so is the harm this whole sidecar exists to prevent. It also made
    # these two the only places left that answer "calibrate first" on a page
    # the operator HAS calibrated by hand.
    det = _page_scale(job_id, page, res)
    if not det:
        raise HTTPException(400, "no scale on this page - type one into the "
                                 "scale box in the sheet header first; volumes "
                                 "need real-world units")
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
            row = {"name": r["name"], "side": side,
                   "thickness_in": r["thickness_in"],
                   "volume_yd3": round(area * r["thickness_in"] / 12.0 / 27.0, 1)}
            if side == "existing":
                # only a REMOVAL has anywhere to go. A proposed layer is
                # purchased material sitting above subgrade, not site dirt.
                row["reuse_pct"] = clamp_pct(r.get("reuse_pct"), 0.0)
                row["respread_pct"] = clamp_pct(r.get("respread_pct"), 0.0)
                row["destination"] = str(r.get("destination") or "on site")[:40]
            layers.append(row)
    result["layers"] = layers
    # Where the dirt goes: export / reuse / import (F87 B7, Beaumont). The
    # two areas differ on purpose and every row says which one it used -
    # removal layers are stripped over the disturbed area (layer_area_sf),
    # cut and fill exist only where the two TINs overlap (area_sf). #853
    # bids it the same way: Strip Topsoil over the Clear & Grub area,
    # Site Cut / Site Fill over the graded region.
    result["balance"] = material_balance(
        result["cut_yd3"], result["fill_yd3"], layers,
        cut_reuse_pct=body.cut_reuse_pct,
        export_factor=body.export_factor,
        import_factor=body.import_factor,
        cut_area_sf=result["area_sf"], layer_area_sf=area)
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
    """Cached wrapper. The finding is deterministic for a given page, and on
    a scanned sheet it costs minutes (takeoff_engine.marks renders, deskews
    and template-matches at 300 dpi). Caching it per page is what makes a
    whole-document rollup affordable: /marks-rollup reads these files rather
    than recomputing six floor plans."""
    from takeoff_engine.detect_page import engine_sig

    sig = engine_sig()
    f = _job_dir(job_id) / f"p{page}_symbols.json"
    if f.exists():
        try:
            js = json.loads(f.read_text())
            # Same rule as a detect result (F96): a cache keyed only on the
            # PDF happily serves counts the current code would not produce.
            # This one feeds /marks-rollup, so a stale entry becomes a stale
            # quantity in the number Bill faxes a supplier.
            if js.get("engine_sig") == sig:
                return JSONResponse(js)
        except (OSError, ValueError):
            pass
    out = _symbols_compute(job_id, page)
    try:
        out["engine_sig"] = sig
        _job_dir(job_id).mkdir(parents=True, exist_ok=True)
        f.write_text(json.dumps(out))
    except OSError:
        pass
    return JSONResponse(out)


def _symbols_compute(job_id: str, page: int):
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


@app.get("/api/job/{job_id}/marks-rollup")
def marks_rollup(job_id: str):
    """Every mark code in the DOCUMENT, per page and in total.

    Bill Dunn asked for exactly this on 2026-08-21: "I want to know that I
    have 27 type D windows on the fifth floor". A per-page count cannot
    answer it and neither can a per-page CSV - what he faxes a supplier is
    one quantity per type for the whole building.

    Reads the per-page symbol caches only; it never triggers detection, so
    it is instant and it reports which pages are still pending rather than
    quietly counting a partial document as a total. `schedule_qty` is the
    architect's own printed quantity where the schedule carries one, so the
    row doubles as the reconciliation an estimator is actually paid for.
    """
    from takeoff_engine.detect_page import engine_sig

    _sig = engine_sig()
    job = JOBS.get(job_id) or _404()
    d = _job_dir(job_id)
    npages = int(job.get("pages") or 0)
    per_page: dict[int, dict[str, int]] = {}
    pending: list[int] = []
    sched: dict[str, float] = {}
    sched_page = None
    for pno in range(npages):
        f = d / f"p{pno}_symbols.json"
        if not f.exists():
            pending.append(pno)
            continue
        try:
            js = json.loads(f.read_text())
        except (OSError, ValueError):
            pending.append(pno)
            continue
        # a count produced by older engine code is not a count for this
        # document - report the sheet as still needing Count rather than
        # folding a stale quantity into the total (F96)
        if js.get("engine_sig") != _sig:
            pending.append(pno)
            continue
        if not sched and js.get("schedule"):
            sched = {str(k): v for k, v in js["schedule"].items()}
            sched_page = js.get("schedule_page")
        counts: dict[str, int] = {}
        for g in js.get("groups") or []:
            nm = (g.get("name") or "").strip()
            if not nm:
                continue          # unread bubbles are reported separately
            counts[nm] = counts.get(nm, 0) + int(g.get("n") or 0)
        if counts:
            per_page[pno] = counts

    codes = sorted({c for pc in per_page.values() for c in pc}
                   | {str(k) for k in sched})
    rows = []
    for c in codes:
        by = {str(p): per_page[p][c] for p in sorted(per_page) if c in per_page[p]}
        found = sum(by.values())
        q = sched.get(c)
        row = {"code": c, "per_page": by, "found": found}
        if q is not None:
            try:
                q = int(round(float(q)))
                row["schedule_qty"] = q
                row["delta"] = found - q
            except (TypeError, ValueError):
                pass
        rows.append(row)
    return JSONResponse({
        "rows": rows,
        "pages_counted": sorted(per_page),
        "pages_pending": pending,
        "schedule_page": sched_page,
        "total_found": sum(r["found"] for r in rows),
        "total_schedule": sum(r["schedule_qty"] for r in rows
                              if "schedule_qty" in r) or None,
    })


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
    # _page_scale, NOT res["scale"]. The reviewer can type a scale or pick a
    # different printed caption, and until 2026-08-23 these two volume routes
    # read the ENGINE's number straight out of the cached result and ignored
    # them both. Measured on Barn Civil engine page 2 = printed sheet 3 (C3.0):
    # type 1" = 60', watch every length on screen double, press Calculate, and
    # the CY came back computed at the engine's 30 ft/in - then priced,
    # exported and printed. Screen and deliverable disagreeing with nothing
    # saying so is the harm this whole sidecar exists to prevent. It also made
    # these two the only places left that answer "calibrate first" on a page
    # the operator HAS calibrated by hand.
    det = _page_scale(job_id, page, res)
    if not det:
        raise HTTPException(400, "no scale on this page - type one into the "
                                 "scale box in the sheet header first; volumes "
                                 "need real-world units")
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
