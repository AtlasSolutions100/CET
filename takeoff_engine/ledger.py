"""Training ledger: append-only JSONL of operator decisions.

Every correction an operator makes in the review UI is a labeled training
example - the engine said X, a human changed it to Y, with the context the
engine itself had. Until this module those corrections lived only in UI
state and the sidecar files they happened to ride on. Here they become
durable, structured, and training-ready, BEFORE any model exists. The
ledger is the asset; models come later.

PRIVACY STANCE - local-only. The ledger is written to out/ledger beside
the rest of this service's artifacts (or TAKEOFF_LEDGER_DIR). Nothing in
this module or its callers transmits an event anywhere; client plan data
never leaves the box. Events carry job ids, page indices, chain features
and operator numbers - no account names, no file contents.

WRITE-ONLY INVARIANT - nothing in the detection or calculation path may
ever READ this ledger. It is observation, not state: deleting the whole
directory changes no number any endpoint returns. The only readers are
the /api/ledger/stats endpoint and the tools/ledger_* scripts, all of
which sit outside the pipeline. A ledger write failure must never fail
the request it rides on: record() catches everything and logs once.

Layout: one file per month, out/ledger/events-YYYY-MM.jsonl, UTF-8 with
LF line endings regardless of platform. One JSON object per line:

    {"ts_iso", "event", "job", "pdf_sha1", "page_index", "engine_sig",
     "schema_version": 1, "before", "after", "context", "ui_source"}

plus "dedupe" on backfilled events (sha1 of the semantic payload, so a
second backfill run imports nothing new).
"""

import hashlib
import json
import os
import sys
import threading
import time
from pathlib import Path

SCHEMA_VERSION = 1

_ROOT = Path(__file__).resolve().parent.parent


def ledger_dir() -> Path:
    """Where the training ledger lives. It belongs beside the JOB STORE, not
    beside the code, and that distinction cost real data twice.

    It used to be _ROOT/out/ledger unconditionally - tied to the checkout.
    Two consequences, both measured on 2026-09-01:

    * IN THE CONTAINER _ROOT is /app, which is in the IMAGE and not on the
      mounted volume, so every deploy threw the hosted box's ledger away.
      The one artifact whose entire value is accumulating over time was the
      one artifact a release discarded.
    * ON THIS LAPTOP every agent that ran a server from this checkout wrote
      into the real ledger even though it was pointed at a throwaway job
      store. 114 of 503 events (23%) turned out to be synthetic - 79
      demo_opened, but also 12 approve_export and 6 style_label, which are
      the operator-decision signal the ledger exists to collect. A training
      set quietly seeded with a robot's own clicks.

    Following TAKEOFF_JOBS_DIR fixes both: a throwaway store gets a throwaway
    ledger, and a mounted volume keeps its history across releases.
    TAKEOFF_LEDGER_DIR still overrides everything, for tests that want their
    own and for a box that keeps the two apart deliberately.
    """
    d = os.environ.get("TAKEOFF_LEDGER_DIR")
    if d:
        return Path(d).expanduser()
    jobs = os.environ.get("TAKEOFF_JOBS_DIR")
    if jobs:
        return Path(jobs).expanduser() / "ledger"
    return _ROOT / "out" / "ledger"


_LOCK = threading.Lock()
_WARNED = False           # log a write failure once, then stay quiet
_SHA1_CACHE: dict = {}    # job id -> pdf sha1 (or None when unhashable)


def _pdf_sha1(job: str, pdf_path) -> "str | None":
    """sha1 of the source PDF, cached per job - the stable identity of the
    drawing a label was made against (job ids are per-registration)."""
    got = _SHA1_CACHE.get(job)
    if got is not None:
        return got
    if not pdf_path:
        # no path offered: do NOT cache the miss, a later caller may
        # know the path and fill it in
        return None
    try:
        h = hashlib.sha1()
        with open(pdf_path, "rb") as fh:
            for block in iter(lambda: fh.read(1 << 20), b""):
                h.update(block)
        _SHA1_CACHE[job] = h.hexdigest()
        return _SHA1_CACHE[job]
    except OSError:
        return None


def _engine_sig() -> "str | None":
    try:
        from takeoff_engine.detect_page import engine_sig
        return engine_sig()
    except Exception:
        return None


def semantic_key(event: str, job, page_index, before, after, context) -> str:
    """Dedupe key for backfill: sha1 of the semantic payload - everything
    that makes the event what it is, EXCLUDING timestamp and ui_source, so
    a re-run over the same files hashes identically."""
    blob = json.dumps([event, job, page_index, before, after, context],
                      sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False, default=str)
    return hashlib.sha1(blob.encode("utf-8")).hexdigest()


def record(event: str, job: str, page_index=None, before=None, after=None,
           context=None, ui_source: str = "webui", *, pdf_path=None,
           ts=None, dedupe_key=None) -> bool:
    """Append one event. NEVER raises - a ledger failure must never fail
    the request it rides on. Returns True when the line hit disk."""
    global _WARNED
    try:
        t = time.localtime(ts if ts is not None else time.time())
        line = json.dumps({
            "ts_iso": time.strftime("%Y-%m-%dT%H:%M:%S", t),
            "event": event,
            "job": job,
            "pdf_sha1": _pdf_sha1(job, pdf_path),
            "page_index": page_index,
            "engine_sig": _engine_sig(),
            "schema_version": SCHEMA_VERSION,
            "before": before,
            "after": after,
            "context": context,
            "ui_source": ui_source,
            **({"dedupe": dedupe_key} if dedupe_key else {}),
        }, ensure_ascii=False, default=str)
        d = ledger_dir()
        d.mkdir(parents=True, exist_ok=True)
        f = d / time.strftime("events-%Y-%m.jsonl", t)
        with _LOCK:
            # append-binary so the line ending is LF on every platform
            with open(f, "ab") as fh:
                fh.write(line.encode("utf-8") + b"\n")
        return True
    except Exception as e:                          # noqa: BLE001 - by design
        if not _WARNED:
            _WARNED = True
            try:
                print(f"[ledger] write failed ({e!r}); further failures "
                      f"will be silent. The request itself is unaffected.",
                      file=sys.stderr)
            except Exception:
                pass
        return False


# ---------- readers (used ONLY by /api/ledger/stats and tools/) -----------

def iter_events(directory: "Path | None" = None):
    """Yield (event_dict, file_path) for every parseable line, in month
    order. Malformed lines are skipped, not fatal - the ledger is
    append-only and a torn final line must not hide the rest."""
    d = directory or ledger_dir()
    if not d.is_dir():
        return
    for f in sorted(d.glob("events-*.jsonl")):
        try:
            raw = f.read_bytes()
        except OSError:
            continue
        for ln in raw.split(b"\n"):
            if not ln.strip():
                continue
            try:
                yield json.loads(ln.decode("utf-8")), f
            except (ValueError, UnicodeDecodeError):
                continue


def existing_dedupe_keys(directory: "Path | None" = None) -> set:
    return {e["dedupe"] for e, _ in iter_events(directory) if e.get("dedupe")}


def stats(directory: "Path | None" = None) -> dict:
    d = directory or ledger_dir()
    by_event: dict = {}
    by_job: dict = {}
    months: set = set()
    first = last = None
    total = 0
    for e, f in iter_events(d):
        total += 1
        by_event[e.get("event") or "?"] = by_event.get(e.get("event") or "?", 0) + 1
        j = e.get("job") or "?"
        by_job[j] = by_job.get(j, 0) + 1
        months.add(f.name[len("events-"):-len(".jsonl")])
        ts = e.get("ts_iso")
        if ts:
            first = ts if first is None or ts < first else first
            last = ts if last is None or ts > last else last
    size = 0
    if d.is_dir():
        for f in d.glob("events-*.jsonl"):
            try:
                size += f.stat().st_size
            except OSError:
                pass
    return {"total_events": total, "by_event_type": by_event,
            "by_job": by_job, "months": sorted(months),
            "first_ts": first, "last_ts": last, "file_bytes": size}


# ---------- chain / style features (context a future model learns from) ---

# What the cached result already carries per chain - copied, NEVER
# recomputed. n_points instead of the points themselves: the geometry
# stays in the job dir, the ledger records the decision and its features.
_CHAIN_FEATURE_KEYS = ("class", "style_id", "layer", "color", "width",
                       "length_pt", "ink_pt", "gap_pt", "pickup_pt",
                       "n_dashes", "dash_signature", "template",
                       "seg_counts")
_STYLE_FEATURE_KEYS = ("suggested_label", "class", "signature", "color",
                       "width", "layer", "length_pt", "n", "texture")


def chain_features(chain: dict) -> dict:
    out = {k: chain.get(k) for k in _CHAIN_FEATURE_KEYS if k in chain}
    pts = chain.get("points")
    if isinstance(pts, list):
        out["n_points"] = len(pts)
    return out


def style_features(style: dict) -> dict:
    return {k: style.get(k) for k in _STYLE_FEATURE_KEYS if k in style}


# tiny per-process cache: (path, mtime_ns) -> {chain_id: features}. The
# calcstate save is debounced in the UI, so several diffs can land for the
# same page in one session; re-parsing a 1,400-chain result each time is
# the only cost this module could add to a request, so don't.
_FEAT_CACHE: dict = {}
_FEAT_CACHE_MAX = 4


def chain_feature_map(result_path) -> dict:
    """{chain_id: features} from a cached p<N>_result.json, or {} when the
    file is missing/unreadable. Never raises."""
    try:
        p = Path(result_path)
        key = (str(p), p.stat().st_mtime_ns)
        hit = _FEAT_CACHE.get(key)
        if hit is not None:
            return hit
        res = json.loads(p.read_text(encoding="utf-8"))
        fmap = {c.get("chain_id"): chain_features(c)
                for c in res.get("chains") or [] if isinstance(c, dict)}
        if len(_FEAT_CACHE) >= _FEAT_CACHE_MAX:
            _FEAT_CACHE.pop(next(iter(_FEAT_CACHE)))
        _FEAT_CACHE[key] = fmap
        return fmap
    except Exception:
        return {}


# ---------- calcstate semantic diff ----------------------------------------

_EW_ROW_KEYS = ("z", "surface", "width", "dist", "manual")
_EW_SETTING_KEYS = ("spotOn", "spotSide", "spotDatum", "areaSf", "added")
_ST_ITEM_KEYS = ("pts", "source", "chain_id", "gap_pt", "depth_ft",
                 "layback_ft", "footing_ft")


def _ev(event, before=None, after=None, context=None) -> dict:
    return {"event": event, "before": before, "after": after,
            "context": context or {}}


def _rows_by_chain(ew: dict) -> dict:
    return {r.get("chain_id"): r for r in (ew.get("rows") or [])
            if isinstance(r, dict) and r.get("chain_id") is not None}


def _rows_snapshot(ew: dict) -> dict:
    rows = [r for r in (ew.get("rows") or []) if isinstance(r, dict)]
    by_surface: dict = {}
    for r in rows:
        s = r.get("surface") or "(none)"
        by_surface[s] = by_surface.get(s, 0) + 1
    return {"n_rows": len(rows),
            "n_manual": sum(1 for r in rows if r.get("manual")),
            "n_with_z": sum(1 for r in rows if r.get("z") is not None),
            "by_surface": by_surface,
            "layers": {k: [l.get("name") for l in (ew.get("layers") or {}).get(k, [])
                           if isinstance(l, dict)]
                       for k in ("existing", "proposed")},
            "settings": {k: ew.get(k) for k in _EW_SETTING_KEYS}}


def calcstate_events(old: dict, new: dict) -> list:
    """Semantic, row-level events for one calcstate sidecar write.

    old == {} means "no earlier record" (first save of a page, or backfill
    of a sidecar found on disk). In that case the earthwork ROWS are mostly
    engine-seeded suggestions, not human labels - so they are summarised in
    one ew_rows_snapshot (manual rows, which ARE operator additions, still
    get their own ew_row_add each), while hand-drawn things (boundary,
    structures, zones, trench, check-offs) emit their real events: their
    initial content IS operator work.
    """
    evs: list = []
    old = old if isinstance(old, dict) else {}
    new = new if isinstance(new, dict) else {}
    o_ew = old.get("ew") if isinstance(old.get("ew"), dict) else None
    n_ew = new.get("ew") if isinstance(new.get("ew"), dict) else None

    if n_ew is not None and o_ew is None:
        evs.append(_ev("ew_rows_snapshot", None, _rows_snapshot(n_ew)))
        for cid, r in _rows_by_chain(n_ew).items():
            if r.get("manual"):
                evs.append(_ev("ew_row_add", None, dict(r),
                               {"chain_id": cid}))
    elif n_ew is not None and o_ew is not None:
        o_rows, n_rows = _rows_by_chain(o_ew), _rows_by_chain(n_ew)
        for cid, r in n_rows.items():
            if cid not in o_rows:
                evs.append(_ev("ew_row_add", None, dict(r),
                               {"chain_id": cid}))
            else:
                o = o_rows[cid]
                if any(o.get(k) != r.get(k) for k in _EW_ROW_KEYS):
                    evs.append(_ev("ew_row_edit", dict(o), dict(r),
                                   {"chain_id": cid,
                                    "changed": [k for k in _EW_ROW_KEYS
                                                if o.get(k) != r.get(k)]}))
        for cid, o in o_rows.items():
            if cid not in n_rows:
                evs.append(_ev("ew_row_delete", dict(o), None,
                               {"chain_id": cid}))
        if (o_ew.get("layers") or {}) != (n_ew.get("layers") or {}):
            evs.append(_ev("ew_layers_set", o_ew.get("layers"),
                           n_ew.get("layers")))
        o_set = {k: o_ew.get(k) for k in _EW_SETTING_KEYS}
        n_set = {k: n_ew.get(k) for k in _EW_SETTING_KEYS}
        if o_set != n_set:
            evs.append(_ev("ew_settings_edit", o_set, n_set,
                           {"changed": [k for k in _EW_SETTING_KEYS
                                        if o_set[k] != n_set[k]]}))

    o_b, n_b = old.get("ew_bound"), new.get("ew_bound")
    if o_b != n_b:
        if n_b:
            evs.append(_ev("boundary_set", o_b, n_b))
        elif o_b:
            evs.append(_ev("boundary_cleared", o_b, None))

    o_tr, n_tr = old.get("tr"), new.get("tr")
    if o_tr != n_tr and (o_tr or n_tr):
        evs.append(_ev("trench_set" if n_tr else "trench_cleared",
                       o_tr, n_tr))

    evs.extend(_structure_events(old.get("st"), new.get("st")))

    o_z, n_z = old.get("zones"), new.get("zones")
    if o_z != n_z and (o_z or n_z):
        evs.append(_ev("workzones_set", o_z, n_z,
                       {"n_zones": len(n_z or [])}))

    o_ck = set((old.get("checks") or {}).get("done") or [])
    n_ck = set((new.get("checks") or {}).get("done") or [])
    for cid in sorted(n_ck - o_ck):
        evs.append(_ev("check_done", None, {"id": cid}))
    for cid in sorted(o_ck - n_ck):
        evs.append(_ev("check_undone", {"id": cid}, None))
    return evs


def _structure_events(o_st, n_st) -> list:
    """st.items diffed by structure NAME when names are unique on both
    sides (they carry the UI's own 'Structure N' sequence); otherwise one
    structure_set event with both lists - honest over clever."""
    o_st = o_st if isinstance(o_st, dict) else {}
    n_st = n_st if isinstance(n_st, dict) else {}
    o_items = [i for i in (o_st.get("items") or []) if isinstance(i, dict)]
    n_items = [i for i in (n_st.get("items") or []) if isinstance(i, dict)]
    if o_st == n_st or (not o_items and not n_items
                        and _st_defaults(o_st) == _st_defaults(n_st)):
        return []
    evs: list = []
    o_names = [i.get("name") for i in o_items]
    n_names = [i.get("name") for i in n_items]
    if len(set(o_names)) == len(o_names) and len(set(n_names)) == len(n_names):
        o_by = {i.get("name"): i for i in o_items}
        n_by = {i.get("name"): i for i in n_items}
        for name, it in n_by.items():
            if name not in o_by:
                evs.append(_ev("structure_add", None, dict(it),
                               {"name": name}))
            elif any(o_by[name].get(k) != it.get(k) for k in _ST_ITEM_KEYS):
                evs.append(_ev("structure_edit", dict(o_by[name]), dict(it),
                               {"name": name}))
        for name, it in o_by.items():
            if name not in n_by:
                evs.append(_ev("structure_delete", dict(it), None,
                               {"name": name}))
    elif o_items != n_items:
        evs.append(_ev("structure_set", o_items, n_items))
    if not evs and _st_defaults(o_st) != _st_defaults(n_st):
        evs.append(_ev("structure_defaults_edit", _st_defaults(o_st),
                       _st_defaults(n_st)))
    return evs


def _st_defaults(st: dict) -> dict:
    return {k: st.get(k) for k in ("depth_ft", "layback_ft", "footing_ft")}
