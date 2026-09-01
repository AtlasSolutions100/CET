"""The training ledger (takeoff_engine/ledger.py + the server.py hooks).

What is pinned here, and why it matters:

  * record() writes one valid JSON line with every schema key - a ledger
    a trainer cannot parse is not an asset, it is a liability.
  * month rotation: events land in events-YYYY-MM.jsonl by their own
    timestamp, so a backfilled 2026-07 decision files under 2026-07.
  * the calcstate differ emits ROW-LEVEL semantic events (add/edit/
    delete), not blob dumps - the whole point of the ledger is that each
    line is one labeled decision.
  * the server hooks attach the engine's own cached chain features and
    never raise - a ledger failure must never fail the request it rides
    on (the write-failure case points the ledger at an impossible path
    and asserts the caller survives).
  * backfill is idempotent: a second run over the same files imports
    nothing new (dedupe on the sha1 of the semantic payload).

Dependency-free like tests/test_gate.py:  python tests/test_ledger.py
(the hook simulation imports server.py, so fastapi/pydantic/pymupdf must
be importable - they are in this repo's venv; no plan corpus is needed).
"""

import json
import os
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

# server.py resolves and creates JOBS_DIR at import time - point it
# somewhere disposable first (same pattern as tests/test_calcstate.py)
os.environ["TAKEOFF_JOBS_DIR"] = tempfile.mkdtemp(prefix="ledger_test_jobs_")

from takeoff_engine import ledger  # noqa: E402

CHECKS = []


def ok(cond, msg, extra=""):
    CHECKS.append((bool(cond), msg, extra))


def fresh_dir(tag: str) -> Path:
    d = Path(tempfile.mkdtemp(prefix=f"ledger_test_{tag}_"))
    os.environ["TAKEOFF_LEDGER_DIR"] = str(d)
    return d


def events_in(d: Path) -> list:
    return [e for e, _ in ledger.iter_events(d)]


# ---------- 1. record(): valid JSON, required keys, LF endings ------------

def test_record_schema():
    d = fresh_dir("schema")
    wrote = ledger.record("style_label", "jobA", 3,
                          {"suggested_label": "dashed x"},
                          {"label": "SILT FENCE"},
                          {"style_id": 7}, "webui")
    ok(wrote, "record() reports success")
    files = list(d.glob("events-*.jsonl"))
    ok(len(files) == 1, "one month file created", files)
    raw = files[0].read_bytes()
    ok(b"\r\n" not in raw, "JSONL uses LF only (even on Windows)")
    e = json.loads(raw.decode("utf-8"))
    for key in ("ts_iso", "event", "job", "pdf_sha1", "page_index",
                "engine_sig", "schema_version", "before", "after",
                "context", "ui_source"):
        ok(key in e, f"schema key present: {key}")
    ok(e["schema_version"] == 1, "schema_version is 1")
    ok(e["event"] == "style_label" and e["job"] == "jobA"
       and e["page_index"] == 3, "identity fields round-trip")
    ok(e["after"] == {"label": "SILT FENCE"}, "after round-trips")


# ---------- 2. month rotation ----------------------------------------------

def test_month_rotation():
    d = fresh_dir("months")
    jan = time.mktime((2026, 1, 15, 12, 0, 0, 0, 0, -1))
    feb = time.mktime((2026, 2, 15, 12, 0, 0, 0, 0, -1))
    ledger.record("check_done", "jobB", 0, None, {"id": "x"}, None, ts=jan)
    ledger.record("check_done", "jobB", 0, None, {"id": "y"}, None, ts=feb)
    names = sorted(f.name for f in d.glob("events-*.jsonl"))
    ok(names == ["events-2026-01.jsonl", "events-2026-02.jsonl"],
       "one file per month, named by the event's own timestamp", names)


# ---------- 3. calcstate differ: row-level semantics ------------------------

ROW5 = {"chain_id": 5, "z": 100.0, "surface": "existing",
        "width": 1.4, "dist": None, "manual": False}
ROW9 = {"chain_id": 9, "z": 102.0, "surface": "proposed",
        "width": 0.7, "dist": 0.5, "manual": True}


def blob(rows, **kw):
    b = {"v": 1, "engine_sig": "cafe",
         "ew": {"rows": rows,
                "layers": {"existing": [], "proposed": []},
                "spotOn": {}, "spotSide": None, "spotDatum": None,
                "areaSf": None, "added": False}}
    b.update(kw)
    return b


def test_calcstate_diff():
    # add: a row appears
    evs = ledger.calcstate_events(blob([ROW5]), blob([ROW5, ROW9]))
    kinds = [e["event"] for e in evs]
    ok(kinds == ["ew_row_add"], "row appears -> exactly ew_row_add", kinds)
    ok(evs[0]["after"] == ROW9 and evs[0]["context"]["chain_id"] == 9,
       "ew_row_add carries the row and its chain id")

    # edit: z changes on one row
    r5b = dict(ROW5, z=101.5, manual=True)
    evs = ledger.calcstate_events(blob([ROW5, ROW9]), blob([r5b, ROW9]))
    ok([e["event"] for e in evs] == ["ew_row_edit"],
       "z change -> exactly ew_row_edit", [e["event"] for e in evs])
    ok(evs[0]["before"] == ROW5 and evs[0]["after"] == r5b, "before/after are the ROW, not the blob")
    ok(sorted(evs[0]["context"]["changed"]) == ["manual", "z"],
       "changed keys named", evs[0]["context"])

    # delete: a row disappears
    evs = ledger.calcstate_events(blob([ROW5, ROW9]), blob([ROW5]))
    ok([e["event"] for e in evs] == ["ew_row_delete"],
       "row gone -> exactly ew_row_delete")
    ok(evs[0]["before"] == ROW9 and evs[0]["after"] is None,
       "delete keeps the erased row as `before`")

    # first save: engine-seeded rows summarise, manual rows are labels
    evs = ledger.calcstate_events({}, blob([ROW5, ROW9]))
    kinds = [e["event"] for e in evs]
    ok(kinds == ["ew_rows_snapshot", "ew_row_add"],
       "first save -> snapshot + one add per MANUAL row only", kinds)
    snap = evs[0]["after"]
    ok(snap["n_rows"] == 2 and snap["n_manual"] == 1,
       "snapshot counts rows and manual rows", snap)

    # boundary, zones, checks
    evs = ledger.calcstate_events(
        blob([ROW5]),
        blob([ROW5], ew_bound={"pts": [[0, 0], [1, 0], [1, 1]]},
             zones=[[0, 0, 5, 5]], checks={"done": ["scale", "ew"]}))
    kinds = sorted(e["event"] for e in evs)
    ok(kinds == ["boundary_set", "check_done", "check_done",
                 "workzones_set"],
       "boundary/zones/check-offs each emit their own event", kinds)

    # trench + structures
    evs = ledger.calcstate_events(
        blob([ROW5]),
        blob([ROW5], tr={"style_id": 3, "od_in": 8, "d0_ft": 3, "d1_ft": 4,
                         "rules": []},
             st={"items": [{"name": "Structure 1", "pts": [[0, 0]],
                            "source": "drawn", "chain_id": None,
                            "gap_pt": 0, "depth_ft": 8, "layback_ft": 4,
                            "footing_ft": 0}],
                 "seq": 2, "depth_ft": 8, "layback_ft": 4, "footing_ft": 0}))
    kinds = sorted(e["event"] for e in evs)
    ok(kinds == ["structure_add", "trench_set"],
       "trench setup and drawn structure each emit", kinds)

    # no change -> no events
    ok(ledger.calcstate_events(blob([ROW5]), blob([ROW5])) == [],
       "identical blobs emit nothing")


# ---------- 4. hooked-endpoint simulation (server.py) -----------------------

def make_job(job_id: str) -> Path:
    jd = Path(os.environ["TAKEOFF_JOBS_DIR"]) / job_id
    jd.mkdir(parents=True, exist_ok=True)
    # the registry row too: the write routes refuse a directory with no row
    # (an orphan - tests/test_orphan_job.py), exactly as the service would
    import server
    server.JOBS[job_id] = {"path": str(jd.with_suffix(".pdf")), "pages": 1,
                           "owner": "tester", "status": {}}
    res = {"page": {"width_pt": 100.0, "height_pt": 100.0},
           "engine_sig": "cafe",
           "scale": None,
           "styles": [{"style_id": 2, "suggested_label": "dashed x",
                       "class": "dash1", "signature": "d4 g2",
                       "color": [0, 0, 0], "width": 1.4, "layer": "C-TOPO",
                       "length_pt": 500.0, "n": 3, "texture": False}],
           "chains": [{"chain_id": 5, "style_id": 2, "class": "dash1",
                       "color": [0, 0, 0], "width": 1.4, "layer": "C-TOPO",
                       "length_pt": 100.0, "ink_pt": 60.0, "gap_pt": 0.0,
                       "pickup_pt": 0.0, "n_dashes": 9,
                       "dash_signature": "d4 g2",
                       "points": [[0.0, 0.0], [10.0, 10.0]]}]}
    (jd / "p0_result.json").write_text(json.dumps(res))
    return jd


def test_server_hooks():
    import server

    # calcstate end-to-end: POST body -> sidecar write -> semantic events
    d = fresh_dir("hooks")
    make_job("jobhook")
    first = blob([ROW5])
    server._calcstate_put("jobhook", 0, json.dumps(first).encode())
    edited = blob([dict(ROW5, z=104.0)])
    server._calcstate_put("jobhook", 0, json.dumps(edited).encode())
    evs = events_in(d)
    kinds = [e["event"] for e in evs]
    ok("ew_rows_snapshot" in kinds, "first save -> snapshot event", kinds)
    edit = [e for e in evs if e["event"] == "ew_row_edit"]
    ok(len(edit) == 1, "second save -> one ew_row_edit", kinds)
    if edit:
        ok(edit[0]["before"]["z"] == 100.0 and edit[0]["after"]["z"] == 104.0,
           "edit carries z before/after")
        ch = (edit[0]["context"] or {}).get("chain")
        ok(isinstance(ch, dict) and ch.get("class") == "dash1"
           and ch.get("n_points") == 2,
           "engine chain features attached from the cached result", ch)

    # approve hook: style labels, chain erasures, export summary
    d = fresh_dir("approve")
    jd = make_job("jobappr")
    res = json.loads((jd / "p0_result.json").read_text())
    body = server.ApproveBody(labels={2: "SILT FENCE"},
                              excluded_chain_ids=[5])
    export = {"elements": [], "items": [{"label": "SILT FENCE", "count": 1}],
              "overrides": [], "scale": None}
    server._ledger_approve("jobappr", 0, body, res, export)
    evs = events_in(d)
    kinds = sorted(e["event"] for e in evs)
    ok(kinds == ["approve_export", "chain_excluded", "style_label"],
       "approve emits label + erasure + export summary", kinds)
    sl = [e for e in evs if e["event"] == "style_label"][0]
    ok(sl["before"] == {"suggested_label": "dashed x"}
       and sl["after"] == {"label": "SILT FENCE"},
       "style_label is engine-said-X -> human-said-Y", sl)
    ex = [e for e in evs if e["event"] == "chain_excluded"][0]
    ok((ex["context"] or {}).get("chain", {}).get("length_pt") == 100.0,
       "excluded chain carries its engine features")

    # write failure: hooks and record() survive an impossible ledger dir
    blocker = Path(tempfile.mkdtemp(prefix="ledger_test_blk_")) / "flat.txt"
    blocker.write_text("not a directory")
    os.environ["TAKEOFF_LEDGER_DIR"] = str(blocker / "sub")
    ok(ledger.record("style_label", "j", 0, None, {"label": "X"}, None)
       is False, "record() returns False instead of raising")
    try:
        server._calcstate_put("jobhook", 0, json.dumps(first).encode())
        survived = True
    except Exception as e:  # noqa: BLE001
        survived = False
        print("  !! calcstate save died on a ledger failure:", repr(e))
    ok(survived, "a ledger write failure never fails the request")


# ---------- 5. backfill: real semantics, idempotent -------------------------

def test_backfill_idempotent():
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "ledger_backfill",
        Path(__file__).resolve().parent.parent / "tools" / "ledger_backfill.py")
    bf = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(bf)

    jobs = Path(tempfile.mkdtemp(prefix="ledger_test_bfjobs_"))
    jd = jobs / "bfjob"
    jd.mkdir()
    (jd / "p0_calcstate.json").write_text(json.dumps(
        blob([ROW9], ew_bound={"pts": [[0, 0], [1, 0], [1, 1]]},
             checks={"done": ["scale"]})))
    (jd / "p0_scale.json").write_text(json.dumps(
        {"ft_per_paper_inch": 20.0, "text": '1" = 20\'',
         "set_by": "reviewer", "set_at": "2026-08-30T19:42:34"}))
    (jd / "p0_elements.json").write_text(json.dumps(
        {"source": "x.pdf", "pageIndex": 0, "imageDpi": 300,
         "elements": [{"label": "SILT FENCE"}],
         "items": [{"label": "SILT FENCE", "count": 1}],
         "overrides": []}))
    (jobs / "registry.json").write_text(json.dumps(
        {"bfjob": {"path": "C:/nonexistent.pdf", "pages": 1}}))

    d = fresh_dir("backfill")
    r1 = bf.backfill(jobs)
    n1 = len(events_in(d))
    src = r1["sources"]
    ok(src.get("calcstate", {}).get("events", 0) >= 4,
       "calcstate sidecar -> snapshot + manual row + boundary + check",
       src.get("calcstate"))
    ok(src.get("scale_pick", {}).get("events") == 1, "scale pick imported")
    ok(src.get("elements", {}).get("events") == 1, "approved export imported")
    ok(n1 == sum(s["events"] for s in src.values()),
       "report counts match lines on disk", (n1, src))
    ok(all(e.get("ui_source") == "backfill" and e.get("dedupe")
           for e in events_in(d)),
       "backfill events are marked and carry a dedupe key")
    ok("client-side" in r1["not_importable"]["review_ui_label_memory"],
       "the localStorage-only source is declared, not faked")

    r2 = bf.backfill(jobs)
    n2 = len(events_in(d))
    ok(n2 == n1, "second run imports nothing new", (n1, n2))
    ok(all(s["events"] == 0 for s in r2["sources"].values()),
       "second-run report says 0 imported per source", r2["sources"])


def main() -> int:
    test_record_schema()
    test_month_rotation()
    test_calcstate_diff()
    test_server_hooks()
    test_backfill_idempotent()
    failed = [c for c in CHECKS if not c[0]]
    for okv, msg, extra in CHECKS:
        print(("PASS " if okv else "FAIL ") + msg
              + (f"   [{extra}]" if (extra != "" and not okv) else ""))
    print(f"\n{len(CHECKS) - len(failed)}/{len(CHECKS)} checks passed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
