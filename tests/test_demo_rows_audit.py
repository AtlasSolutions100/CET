"""tools/demo_rows_audit.py finds - and only with --purge removes - the
shared rows the pre-fix leak minted over a client's upload.

THE DATA (b528e74 and earlier, and still on production). An unseeded
hosted box scanned JOBS_DIR for the demo plans, found a client's own
upload wearing a demo name, and registered a SHARED row (owner None) over
it. The code fix stops new ones; the rows already in the store are still
served by the owner-None row loop, and a staff seed does NOT displace
them because _demo_source/_demo_job pick the lowest job id. Only deleting
the row (with its job directory and _demo_thumbs PNG) repairs it.

The store here has one of each:
  * a LEAK  - alice's upload under the store, her own row (owner alice)
              AND a shared row over the same file, with demo_opened
              events on the shared row in the ledger;
  * a SEED  - a staff upload under the store, shared, different bytes,
              no client row: legitimate, must be listed as kept and
              never touched;
  * a CLIENT row - alice's ordinary upload, owned, must be ignored.
Dry run lists only the leak; --purge removes only it, and prints what it
did; no --store refuses to run.

Dependency-free:  python tests/test_demo_rows_audit.py
"""

import hashlib
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TOOL = ROOT / "tools" / "demo_rows_audit.py"
PY = sys.executable

manifest = json.loads((ROOT / "demo-plans.json").read_text(encoding="utf-8"))
NAMES = sorted(manifest["plans"])
NAME = ("Belle Farms Structural Plans.pdf"
        if "Belle Farms Structural Plans.pdf" in NAMES else NAMES[0])
PAGE = int(manifest["plans"][NAME].get("page") or 0)
ALICE, STAFF = "alice_synth@example.test", "staff_synth@example.test"
LEAK, SEED, A_ROW, C_ROW = "1eak1eak1eak", "5eed5eed5eed", "a1a1a1a1a1a1", "c1c1c1c1c1c1"


def pdf_bytes(salt: bytes) -> bytes:
    """The tool hashes bytes and stats files; it never parses a PDF."""
    return b"%PDF-1.4\n% synthetic " + salt + b"\n%%EOF\n"


def row(path: Path, owner) -> dict:
    return {"path": str(path), "pages": 1, "mtime": round(path.stat().st_mtime, 2),
            "kinds": None, "sizes": [[612.0, 792.0]], "owner": owner}


def thumb_name(name: str, src: Path) -> str:
    st = src.stat()
    return "%s_%d_%d_p%d.png" % (hashlib.sha1(name.encode()).hexdigest()[:12],
                                 int(st.st_mtime), st.st_size, PAGE)


def event(ev: str, job: str, sha: str, ctx=None) -> str:
    return json.dumps({"ts_iso": "2026-08-30T10:00:00", "event": ev, "job": job,
                       "pdf_sha1": sha, "page_index": None, "engine_sig": "x",
                       "schema_version": 1, "before": None, "after": None,
                       "context": ctx, "ui_source": "webui"})


def build_store() -> dict:
    store = Path(tempfile.mkdtemp(prefix="rows_audit_test_")).resolve()
    a_pdf = store / ("upload_0a0a0a0a0a0a_" + NAME)
    a_pdf.write_bytes(pdf_bytes(b"alice"))
    s_pdf = store / ("upload_0b0b0b0b0b0b_" + NAME)
    s_pdf.write_bytes(pdf_bytes(b"our corpus copy"))
    c_pdf = store / "upload_0c0c0c0c0c0c_Alice Private Bid Set.pdf"
    c_pdf.write_bytes(pdf_bytes(b"client"))
    reg = {A_ROW: row(a_pdf, ALICE), LEAK: row(a_pdf, None),
           SEED: row(s_pdf, None), C_ROW: row(c_pdf, ALICE)}
    (store / "registry.json").write_text(json.dumps(reg, indent=1))
    (store / "users.json").write_text(json.dumps({
        ALICE: {"algo": "pbkdf2_sha256", "salt": "00", "iterations": 1, "hash": "00"},
        STAFF: {"algo": "pbkdf2_sha256", "salt": "00", "iterations": 1, "hash": "00",
                "staff": True}}))
    for jid in (A_ROW, LEAK, SEED, C_ROW):
        (store / jid).mkdir()
        (store / jid / "p0_130.png").write_bytes(b"png")
    thumbs = store / "_demo_thumbs"
    thumbs.mkdir()
    leak_thumb = thumbs / thumb_name(NAME, a_pdf)
    seed_thumb = thumbs / thumb_name(NAME, s_pdf)
    other_thumb = thumbs / "unrelated_0_0_p0.png"
    for t in (leak_thumb, seed_thumb, other_thumb):
        t.write_bytes(b"png")
    a_sha = hashlib.sha1(a_pdf.read_bytes()).hexdigest()
    s_sha = hashlib.sha1(s_pdf.read_bytes()).hexdigest()
    (store / "ledger").mkdir()
    (store / "ledger" / "events-2026-08.jsonl").write_bytes(("\n".join([
        event("demo_opened", LEAK, a_sha, {"name": NAME, "removed": 0, "failed": 0}),
        event("demo_opened", LEAK, a_sha, {"name": NAME, "removed": 3, "failed": 0}),
        event("style_label", A_ROW, a_sha, {"x": 1}),
        event("demo_opened", SEED, s_sha, {"name": NAME, "removed": 0, "failed": 0}),
    ]) + "\n").encode())
    return {"store": store, "reg": reg, "a_pdf": a_pdf, "s_pdf": s_pdf,
            "leak_thumb": leak_thumb, "seed_thumb": seed_thumb,
            "other_thumb": other_thumb}


def run(args: list, expect_ok=True) -> str:
    r = subprocess.run([PY, str(TOOL)] + args, cwd=str(ROOT),
                       capture_output=True, text=True, timeout=120)
    if expect_ok:
        assert r.returncode == 0, (r.returncode, r.stdout, r.stderr)
    else:
        assert r.returncode != 0, (r.returncode, r.stdout, r.stderr)
    return r.stdout + r.stderr


def listed(out: str, section: str) -> set:
    """Job ids under a section heading, up to the next heading."""
    lines = out.splitlines()
    start = next(i for i, ln in enumerate(lines) if ln.startswith(section))
    ids = set()
    for ln in lines[start + 1:]:
        if ln and not ln.startswith(" "):
            break
        if ln.startswith("  job "):
            ids.add(ln.split()[1])
    return ids


def registry(store: Path) -> dict:
    return json.loads((store / "registry.json").read_text())


def test_0_tool_exists():
    # THE ASSERTION 998bf35 FAILS: the tool is new in this commit.
    assert TOOL.is_file(), "tools/demo_rows_audit.py is missing"


def test_1_refuses_without_a_store():
    s = build_store()
    out = run([], expect_ok=False)
    assert "--store" in out, out
    out = run(["--purge"], expect_ok=False)
    assert "--store" in out, out
    assert registry(s["store"]) == s["reg"]


def test_2_dry_run_lists_only_the_leak_and_writes_nothing():
    s = build_store()
    out = run(["--store", str(s["store"])])
    assert listed(out, "LEAKS") == {LEAK}, out
    assert listed(out, "SHARED ROWS KEPT") == {SEED}, out
    assert "DRY RUN" in out and "--purge" in out, out
    # evidence printed: the client row, the ledger, the thumb, the job dir
    assert ("job %s owned by %r" % (A_ROW, ALICE)) in out, out
    assert "2 demo_opened event(s) on this row" in out, out
    assert ("client job(s) %s" % A_ROW) in out, out
    assert str(s["leak_thumb"]) in out, out
    assert str(s["store"] / LEAK) in out, out
    # nothing written
    assert registry(s["store"]) == s["reg"]
    for t in (s["leak_thumb"], s["seed_thumb"], s["other_thumb"]):
        assert t.is_file(), t
    for jid in (A_ROW, LEAK, SEED, C_ROW):
        assert (s["store"] / jid / "p0_130.png").is_file()


def test_3_purge_removes_only_the_leak_and_says_so():
    s = build_store()
    out = run(["--store", str(s["store"]), "--purge"])
    after = registry(s["store"])
    assert set(after) == {A_ROW, SEED, C_ROW}, after
    for jid in (A_ROW, SEED, C_ROW):
        assert after[jid] == s["reg"][jid], jid
    assert not s["leak_thumb"].exists(), "the leak's thumbnail survived"
    assert s["seed_thumb"].is_file(), "the seed's thumbnail was removed"
    assert s["other_thumb"].is_file()
    assert not (s["store"] / LEAK).exists(), "the leak's job dir survived"
    for jid in (A_ROW, SEED, C_ROW):
        assert (s["store"] / jid / "p0_130.png").is_file(), jid
    assert s["a_pdf"].is_file(), "the client's PDF was deleted"
    assert s["s_pdf"].is_file()
    # it printed what it did
    assert ("removed row     %s" % LEAK) in out, out
    assert ("removed thumb   %s" % s["leak_thumb"]) in out, out
    assert ("removed job dir %s" % (s["store"] / LEAK)) in out, out
    assert "kept PDF" in out and "restart" in out.lower(), out
    # a second run finds nothing
    out = run(["--store", str(s["store"])])
    assert listed(out, "LEAKS") == set(), out
    assert "no leak rows found" in out, out


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for fn in fns:
        fn()
        print(f"ok  {fn.__name__}")
    print(f"{len(fns)} tests passed")
