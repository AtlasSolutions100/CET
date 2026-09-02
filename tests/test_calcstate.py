"""The calculator-input sidecar (p<N>_calcstate.json).

What is pinned here and why:

  * the size cap answers 413 and REFUSES - an oversized blob must leave the
    earlier record untouched, because "saved" state that was silently not
    saved is how an operator loses an afternoon of surface assignments;
  * non-JSON and non-object bodies answer 400, never a stack trace and never
    a partial file;
  * the write is atomic (tmp + os.replace): a crash mid-write must leave the
    PREVIOUS record readable, not half a file that GET reads back as {};
  * GET returns {} for absent AND for corrupt, so the UI restore path is one
    unconditional GET;
  * a job_id that is not a direct child of JOBS_DIR (`..`) is refused - this
    route writes to disk;
  * a job_id with no registry row is refused EVEN WHEN its directory exists:
    that is an orphan, and until 2026-09-01 the check accepted either.

fastapi.testclient is NOT usable in this venv (starlette's testclient module
raises at import: it wants the httpx2 package, which requirements.txt does
not carry), so these tests call the route functions and helpers directly -
they are plain functions, and everything HTTP-specific in them is the
HTTPException they raise. Checked on 2026-08-30:
    python -c "import fastapi.testclient"  ->  RuntimeError (httpx2 missing)

Dependency-free like tests/test_gate.py:  python tests/test_calcstate.py
"""

import json
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

# The jobs dir must be pointed somewhere disposable BEFORE server is
# imported: server.py resolves and creates JOBS_DIR at import time.
_TMP = tempfile.mkdtemp(prefix="calcstate_test_")
os.environ["TAKEOFF_JOBS_DIR"] = _TMP
# ... and so must the training ledger: _calcstate_put emits observation
# events (takeoff_engine/ledger.py), and without this they would land in
# the real out/ledger every time this suite runs.
os.environ["TAKEOFF_LEDGER_DIR"] = tempfile.mkdtemp(prefix="calcstate_test_lg_")

from fastapi import HTTPException  # noqa: E402

import server  # noqa: E402

def _row(jid: str) -> None:
    """Register a job the way upload/_register does. The write path checks
    the REGISTRY ROW, not the directory: a directory with no row is an
    orphan (tests/test_orphan_job.py) and must be refused."""
    server.JOBS[jid] = {"path": str(Path(_TMP) / f"{jid}.pdf"), "pages": 1,
                        "owner": "tester", "status": {}}


def _err(fn, *a):
    """The HTTPException a call raises, or None if it succeeds."""
    try:
        fn(*a)
        return None
    except HTTPException as e:
        return e


def test_path_is_a_page_sidecar_in_the_job_dir():
    p = server._calcstate_path("jobA", 3)
    assert p.name == "p3_calcstate.json", p.name
    assert p.parent == Path(_TMP) / "jobA", p


def test_check_accepts_an_object_and_only_an_object():
    assert server._calcstate_check(b'{"v": 1, "ew": null}') == {"v": 1, "ew": None}
    e = _err(server._calcstate_check, b"[1, 2]")
    assert e is not None and e.status_code == 400, e
    e = _err(server._calcstate_check, b"not json at all")
    assert e is not None and e.status_code == 400, e


def test_size_cap_refuses_with_413():
    big = b'{"pad": "' + b"x" * server.CALCSTATE_MAX_BYTES + b'"}'
    e = _err(server._calcstate_check, big)
    assert e is not None and e.status_code == 413, e
    # the cap is a byte count on the wire, so a blob AT the cap still passes
    pad = server.CALCSTATE_MAX_BYTES - len(b'{"pad": ""}')
    at_cap = b'{"pad": "' + b"x" * pad + b'"}'
    assert len(at_cap) == server.CALCSTATE_MAX_BYTES
    assert server._calcstate_check(at_cap)["pad"] == "x" * pad


def test_put_then_get_round_trips():
    (Path(_TMP) / "jobA").mkdir(exist_ok=True)
    _row("jobA")
    blob = {"v": 1, "engine_sig": "sig123",
            "ew": {"rows": [{"chain_id": 7, "z": 101.5, "surface": "existing"}]}}
    out = server._calcstate_put("jobA", 3, json.dumps(blob).encode())
    assert out["ok"] is True
    got = server.get_calcstate("jobA", 3)
    assert got == blob, got
    # absent page -> {} (never 404: the UI restore path is one plain GET)
    assert server.get_calcstate("jobA", 9) == {}


def test_write_is_atomic_and_oversize_keeps_the_earlier_record():
    (Path(_TMP) / "jobB").mkdir(exist_ok=True)
    _row("jobB")
    first = {"v": 1, "tr": {"od_in": 6}}
    server._calcstate_put("jobB", 0, json.dumps(first).encode())
    # no tmp file left behind
    leftovers = list((Path(_TMP) / "jobB").glob("*.tmp"))
    assert leftovers == [], leftovers
    # an oversized second write is refused AND the first record still stands
    big = b'{"pad": "' + b"x" * server.CALCSTATE_MAX_BYTES + b'"}'
    e = _err(server._calcstate_put, "jobB", 0, big)
    assert e is not None and e.status_code == 413, e
    assert server.get_calcstate("jobB", 0) == first


def test_corrupt_file_reads_as_empty_not_error():
    (Path(_TMP) / "jobC").mkdir(exist_ok=True)
    server._calcstate_path("jobC", 1).write_text("{ half a rec")
    assert server.get_calcstate("jobC", 1) == {}
    # and a JSON file that is not an object is also treated as no record
    server._calcstate_path("jobC", 2).write_text("[1, 2, 3]")
    assert server.get_calcstate("jobC", 2) == {}


def test_traversal_and_unknown_jobs_are_refused():
    e = _err(server._calcstate_put, "..", 0, b"{}")
    assert e is not None and e.status_code == 404, e
    e = _err(server.get_calcstate, "..", 0)
    assert e is not None and e.status_code == 404, e
    # a job that neither the registry nor the disk knows: no blind dir creation
    e = _err(server._calcstate_put, "never_opened_job", 0, b"{}")
    assert e is not None and e.status_code == 404, e
    assert not (Path(_TMP) / "never_opened_job").exists()
    # an ORPHAN: the directory is there, the registry row is not. Refused,
    # and the file it holds is not touched.
    (Path(_TMP) / "orphan_job").mkdir(exist_ok=True)
    f = server._calcstate_path("orphan_job", 0)
    f.write_text('{"marker": "OWNER"}')
    assert "orphan_job" not in server.JOBS
    e = _err(server._calcstate_put, "orphan_job", 0, b'{"marker": "INTRUDER"}')
    assert e is not None and e.status_code == 404, e
    assert f.read_text() == '{"marker": "OWNER"}'


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for fn in fns:
        fn()
        print(f"ok  {fn.__name__}")
    print(f"{len(fns)} tests passed")
