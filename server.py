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
import threading
import time
import uuid
from collections import defaultdict
from pathlib import Path

import pymupdf
from fastapi import FastAPI, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from takeoff_engine.chain import build_chains
from takeoff_engine.classify_page import classify_page
from takeoff_engine.extract import extract_strokes
from takeoff_engine.legend_detect import read_legend
from takeoff_engine.scale_detect import detect_scale

ROOT = Path(__file__).parent
JOBS_DIR = ROOT / "out" / "jobs"
JOBS_DIR.mkdir(parents=True, exist_ok=True)
SAMPLES_DIR = (ROOT / ".." / "TakeoffPro AI").resolve()

app = FastAPI(title="Takeoff Detection Service")

# job_id -> {"path": str, "pages": int, "status": {page: "running"|"done"|"error:..."}}
JOBS: dict = {}
JOBS_LOCK = threading.Lock()


def _job_dir(job_id: str) -> Path:
    d = JOBS_DIR / job_id
    d.mkdir(parents=True, exist_ok=True)
    return d


class OpenPathBody(BaseModel):
    path: str


@app.get("/api/samples")
def list_samples():
    """Convenience: sample plans on this machine, for quick opening."""
    out = []
    if SAMPLES_DIR.exists():
        for p in sorted(SAMPLES_DIR.rglob("*.pdf")):
            try:
                size = p.stat().st_size
            except OSError:
                continue
            if size > 50_000:
                out.append({"path": str(p), "name": p.name, "mb": round(size / 1e6, 1)})
    return out[:80]


def _register(path: Path) -> dict:
    doc = pymupdf.open(path)
    job_id = uuid.uuid4().hex[:12]
    with JOBS_LOCK:
        JOBS[job_id] = {"path": str(path), "pages": doc.page_count, "status": {}}
    kinds = []
    for p in range(doc.page_count):
        kinds.append(classify_page(doc[p]).kind)
    doc.close()
    return {"job_id": job_id, "pages": len(kinds), "kinds": kinds, "name": Path(path).name}


@app.post("/api/open-path")
def open_path(body: OpenPathBody):
    p = Path(body.path).expanduser()
    if not p.exists() or p.suffix.lower() != ".pdf":
        raise HTTPException(404, f"not a PDF: {p}")
    return _register(p)


@app.post("/api/upload")
async def upload(file: UploadFile):
    dest = JOBS_DIR / f"upload_{uuid.uuid4().hex[:8]}_{file.filename}"
    dest.write_bytes(await file.read())
    return _register(dest)


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


def _detect_worker(job_id: str, page: int):
    job = JOBS[job_id]
    try:
        doc = pymupdf.open(job["path"])
        pg = doc[page]
        pc = classify_page(pg)
        if pc.kind == "raster":
            from takeoff_engine.raster import extract_raster_units

            words: list = []
            units = extract_raster_units(pg, words_out=words)
        else:
            units = extract_strokes(pg)
            words = pg.get_text("words")
            has_layers = any(u.layer for u in units[:300])
            if pc.text_chars < 1500 and not has_layers:
                # sparse text + no CAD layers = exploded annotations with no
                # metadata; OCR fills in word boxes for junk pruning +
                # dash-text labels. Layered pages skip OCR - layer names are
                # strictly better metadata and OCR words only add noise.
                try:
                    import numpy as _np

                    from takeoff_engine.text_detect import ocr_words

                    _pix = pg.get_pixmap(matrix=pymupdf.Matrix(150 / 72, 150 / 72),
                                         colorspace="rgb")
                    _img = _np.frombuffer(_pix.samples, dtype=_np.uint8).reshape(
                        _pix.height, _pix.width, 3)
                    words = list(words) + ocr_words(_img, px_to_pt=72.0 / 150)
                except Exception:
                    pass
            if pc.kind == "hybrid":
                from takeoff_engine.raster import extract_hybrid_image_units

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

                from takeoff_engine.text_detect import ocr_words as _ocr

                _pix2 = pg.get_pixmap(matrix=pymupdf.Matrix(150 / 72, 150 / 72),
                                      colorspace="rgb")
                _img2 = _np2.frombuffer(_pix2.samples, dtype=_np2.uint8).reshape(
                    _pix2.height, _pix2.width, 3)
                words_legend += _ocr(_img2, px_to_pt=72.0 / 150)
            except Exception:
                pass
        legend = read_legend(words_legend, chains)
        _legend_labels.update(legend["style_labels"])
        for st in style_list:
            if st["style_id"] in _legend_labels:
                st["suggested_label"] = _legend_labels[st["style_id"]] + " (legend)"
        scale = detect_scale(pg).to_dict()
        result = {
            "page": pc.to_dict(),
            "scale": scale,
            "legend": legend["entries"],
            "styles": style_list,
            "chains": [c.to_dict() for c in chains],
        }
        (_job_dir(job_id) / f"p{page}_result.json").write_text(json.dumps(result))
        job["status"][page] = "done"
    except Exception as e:  # surfaced to the UI
        job["status"][page] = f"error: {e}"
        raise


@app.post("/api/job/{job_id}/page/{page}/detect")
def detect(job_id: str, page: int):
    job = JOBS.get(job_id) or _404()
    if job["status"].get(page) == "running":
        return {"status": "running"}
    if (_job_dir(job_id) / f"p{page}_result.json").exists():
        job["status"][page] = "done"
        return {"status": "done"}
    job["status"][page] = "running"
    threading.Thread(target=_detect_worker, args=(job_id, page), daemon=True).start()
    return {"status": "running"}


@app.get("/api/job/{job_id}/page/{page}/status")
def status(job_id: str, page: int):
    job = JOBS.get(job_id) or _404()
    st = job["status"].get(page)
    if st is None and (_job_dir(job_id) / f"p{page}_result.json").exists():
        st = "done"
    return {"status": st or "idle"}


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


@app.post("/api/job/{job_id}/page/{page}/approve")
def approve(job_id: str, page: int, body: ApproveBody):
    f = _job_dir(job_id) / f"p{page}_result.json"
    if not f.exists():
        raise HTTPException(404, "no result to approve")
    res = json.loads(f.read_text())
    scale = body.image_dpi / 72.0
    elements = []
    excluded = set(body.excluded_chain_ids)
    for ch in res["chains"]:
        label = body.labels.get(ch["style_id"])
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
        items.append({
            "label": label, "count": t["count"],
            "length_ft": round(ft, 1) if ft is not None else None,
            "unit_price": price,
            "extended": round(ft * price, 2) if (ft is not None and price) else None,
        })
    export["items"] = items
    out = _job_dir(job_id) / f"p{page}_elements.json"
    out.write_text(json.dumps(export, indent=1))
    return JSONResponse({"exported": len(elements), "file": str(out),
                         "items": items})


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
            tp.insert_text((360, y), f'{it["length_ft"]:,}' if it["length_ft"] is not None else "-", fontsize=9)
            tp.insert_text((440, y), f'{it["unit_price"]:.2f}' if it.get("unit_price") else "-", fontsize=9)
            tp.insert_text((500, y), f'{it["extended"]:,.2f}' if it.get("extended") else "-", fontsize=9)
            if it.get("extended"):
                page_total += it["extended"]
            g = grand.setdefault(it["label"], {"count": 0, "ft": 0.0, "ext": 0.0})
            g["count"] += it["count"]
            g["ft"] += it["length_ft"] or 0.0
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
def analyze_page(job_id: str, page: int):
    """LLM page analyst: what is this sheet FOR, and which line styles
    matter for takeoff? Provider by available key, cheapest-first:
    XAI_API_KEY (Grok) > GROQ_API_KEY > ANTHROPIC_API_KEY."""
    import base64
    import os

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

    styles_ctx = ""
    rf = _job_dir(job_id) / f"p{page}_result.json"
    if rf.exists():
        res = json.loads(rf.read_text())
        styles_ctx = "\n".join(
            f'- style {st["style_id"]}: {st["class"]}, {st["n"]} lines, '
            f'{st["length_pt"]:.0f}pt, label "{st["suggested_label"]}"'
            for st in res["styles"][:20])

    prompt = (
        "You are helping a construction estimator do a quantity takeoff "
        "from this plan sheet. Sheet text (excerpt):\n" + text +
        "\n\nDetected line styles:\n" + styles_ctx +
        "\n\nAnswer in strict JSON with keys: purpose (one sentence: what "
        "this sheet is for), discipline (short), takeoff_focus (array of "
        "short strings: which linework an estimator should measure, "
        "referencing style ids when possible), ignore (array of short "
        "strings), inline_legend (array of {symbol, meaning} for any "
        "legend defined on the sheet itself)."
    )

    name, base, key, model = provider
    if name == "anthropic":
        import anthropic

        client = anthropic.Anthropic()
        msg = client.messages.create(
            model=model, max_tokens=700,
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
            json={"model": model, "max_tokens": 700,
                  "messages": [{"role": "user", "content": [
                      {"type": "image_url", "image_url": {
                          "url": f"data:image/jpeg;base64,{img_b64}"}},
                      {"type": "text", "text": prompt}]}]},
            timeout=90)
        if not r.ok:
            raise HTTPException(502, f"{name} API error {r.status_code}: "
                                     f"{r.text[:200]}")
        raw = r.json()["choices"][0]["message"]["content"]

    try:
        parsed = json.loads(raw[raw.index("{"): raw.rindex("}") + 1])
    except Exception:
        parsed = {"purpose": raw[:400]}
    parsed["_provider"] = f"{name}:{model}"
    return JSONResponse(parsed)


app.mount("/", StaticFiles(directory=ROOT / "webui", html=True), name="ui")
