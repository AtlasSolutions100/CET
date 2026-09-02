"""Find - and with --purge, remove - shared rows minted over a client's upload.

WHAT IT IS FOR. Before b528e74 an unseeded hosted box scanned JOBS_DIR for
the demo plans, found a client's own upload wearing a demo name, and
_demo_job registered a SHARED row (owner None) over that client's PDF.
The fix stops new ones; it does nothing about rows already in the store,
and those are still served: the owner-None row loop in _demo_source finds
them, and a staff seed of our own copy does NOT displace them, because
_demo_source and _demo_job pick the LOWEST job id among the shared rows
for a name. The only repair is deleting the row, its job directory (the
renders and detections of the client's sheets that demo opens produced)
and its _demo_thumbs PNG. This tool does that, and nothing else.

WHAT COUNTS AS A LEAK. An owner-None row whose PDF is ALSO registered to a
CLIENT account - the leak's signature: the client uploaded (that row
carries their name) and the demo minted a second, owner-less row over the
same file. Compared on resolved paths, so another spelling of the same
file is the same file. A client account is any owner that is not flagged
staff in the store's users.json; an owner the store has never heard of is
a client too (fail closed). The ledger is the second witness: every
demo_opened event on the shared row is listed (job id, when, and the
manifest name the visitor opened), and events on the client's own job id
carry the same pdf_sha1, which is printed when it matches.

WHAT IS NOT PURGED, deliberately. An owner-None row under the store with
NO client row on its path is what a legitimate staff seed looks like
(seed-demo.sh uploads through /api/upload). It is also what a leak looks
like once the client deleted their own row. The two cannot be told apart
from the registry, so such rows are LISTED with their ledger history -
including any job id in the ledger that worked the same bytes and is no
longer in the registry - and left alone. Read that section before
declaring a box clean.

The identical-bytes case: staff uploading the SAME bytes a client did
lands on the client's path with a second, shared row - by construction
the demo then IS the client's file, byte for byte. That row is flagged
here too. Purging it costs one re-run of seed-demo.sh; keeping it means
a client's upload is on the demo card. Purge.

DRY RUN BY DEFAULT. Nothing is written unless --purge is given, and
--store is required: there is no default store, because the only wrong
store to run this against is the live one somebody assumed.

    python tools/demo_rows_audit.py --store /data/jobs
    python tools/demo_rows_audit.py --store /data/jobs --purge

Run with the app STOPPED or restart it afterwards: JOBS lives in process
memory and a row removed here comes back from memory on the next
_save_registry otherwise.

Reading the ledger here is fine: this tool sits outside the detection and
calculation pipeline, which is the boundary the write-only invariant in
takeoff_engine/ledger.py draws. Stdlib only.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import sys
from pathlib import Path

# the same expression server._display_name strips: our upload prefix is
# plumbing, and the thumbnail cache is keyed on the name without it
_UPLOAD_PREFIX = re.compile(r"^upload_[0-9a-f]{8,12}_")


def display_name(p: Path) -> str:
    """The manifest name a row wears - server._display_name's rule."""
    return _UPLOAD_PREFIX.sub("", p.name)


def resolve_key(raw: str) -> str | None:
    try:
        return os.path.normcase(str(Path(raw).resolve(strict=True)))
    except (OSError, RuntimeError, ValueError):
        return None


def sha1_of(p: Path) -> str | None:
    try:
        h = hashlib.sha1()
        with open(p, "rb") as fh:
            for block in iter(lambda: fh.read(1 << 20), b""):
                h.update(block)
        return h.hexdigest()
    except OSError:
        return None


def load_json(p: Path, what: str) -> dict:
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except OSError as e:
        sys.exit(f"!! cannot read {what} at {p}: {e}")
    except ValueError as e:
        sys.exit(f"!! {what} at {p} is not valid JSON: {e}")
    if not isinstance(data, dict):
        sys.exit(f"!! {what} at {p} is not a JSON object")
    return data


def iter_ledger(ledger_dir: Path):
    if not ledger_dir.is_dir():
        return
    for f in sorted(ledger_dir.glob("events-*.jsonl")):
        try:
            raw = f.read_bytes()
        except OSError:
            continue
        for ln in raw.split(b"\n"):
            if not ln.strip():
                continue
            try:
                yield json.loads(ln.decode("utf-8"))
            except (ValueError, UnicodeDecodeError):
                continue


def thumb_pngs(thumbs: Path, name: str, src: Path) -> list[Path]:
    """The cached card thumbnails for this row: server.demo_thumb keys them
    on sha1(name)[:12]_<int mtime>_<size>_p<page>. Every page for that
    file's stat is this file's picture; page is not needed."""
    try:
        st = src.stat()
    except OSError:
        return []
    tag = "%s_%d_%d_p" % (hashlib.sha1(name.encode("utf-8")).hexdigest()[:12],
                          int(st.st_mtime), st.st_size)
    if not thumbs.is_dir():
        return []
    return sorted(p for p in thumbs.glob(tag + "*.png") if p.is_file())


def audit(store: Path, ledger_dir: Path) -> dict:
    reg_path = store / "registry.json"
    if not reg_path.is_file():
        sys.exit(f"!! {store} holds no registry.json - is this a job store?")
    reg = load_json(reg_path, "registry.json")
    users_path = store / "users.json"
    users = load_json(users_path, "users.json") if users_path.is_file() else {}
    staff = {n.lower() for n, rec in users.items()
             if isinstance(rec, dict) and rec.get("staff")}

    def is_client(owner) -> bool:
        return owner is not None and str(owner).lower() not in staff

    # path key -> [(jid, owner)] for every row that resolves
    by_key: dict = {}
    keys: dict = {}
    for jid, row in reg.items():
        k = resolve_key(str(row.get("path", "")))
        keys[jid] = k
        if k is not None:
            by_key.setdefault(k, []).append((jid, row.get("owner")))

    # ledger: demo_opened per job, and every job id seen per pdf_sha1
    opened: dict = {}
    jobs_by_sha: dict = {}
    for e in iter_ledger(ledger_dir):
        j = e.get("job")
        if e.get("event") == "demo_opened":
            ctx = e.get("context") or {}
            opened.setdefault(j, []).append(
                (e.get("ts_iso"), ctx.get("name") if isinstance(ctx, dict) else None))
        sha = e.get("pdf_sha1")
        if sha and j:
            jobs_by_sha.setdefault(sha, set()).add(j)

    store_key = os.path.normcase(str(store.resolve()))
    leaks, kept, missing = [], [], []
    for jid, row in sorted(reg.items()):
        if row.get("owner") is not None:
            continue
        raw = str(row.get("path", ""))
        k = keys[jid]
        if k is None:
            missing.append({"jid": jid, "path": raw})
            continue
        src = Path(raw)
        name = display_name(src)
        clients = [(o_jid, o) for o_jid, o in by_key.get(k, [])
                   if o_jid != jid and is_client(o)]
        under_store = k.startswith(store_key + os.sep)
        sha = sha1_of(src) if (clients or under_store) else None
        same_bytes = sorted(jobs_by_sha.get(sha, set()) - {jid}) if sha else []
        entry = {"jid": jid, "path": raw, "name": name,
                 "under_store": under_store, "clients": clients,
                 "sha1": sha, "opened": opened.get(jid, []),
                 # job ids in the ledger that worked the same bytes, split by
                 # what the registry says about them today
                 "same_bytes_client": [j for j in same_bytes
                                       if j in reg and is_client(reg[j].get("owner"))],
                 "same_bytes_gone": [j for j in same_bytes if j not in reg],
                 "thumbs": thumb_pngs(store / "_demo_thumbs", name, src),
                 "job_dir": (store / jid) if (store / jid).is_dir() else None}
        if clients:
            leaks.append(entry)
        else:
            kept.append(entry)
    return {"store": store, "ledger": ledger_dir, "registry": reg,
            "reg_path": reg_path, "leaks": leaks, "kept": kept,
            "missing": missing, "staff": sorted(staff)}


def report(a: dict) -> None:
    print(f"store   : {a['store']}")
    print(f"ledger  : {a['ledger']}"
          + ("" if a["ledger"].is_dir() else "  (no ledger directory: no events to cross-reference)"))
    print(f"rows    : {len(a['registry'])} total, "
          f"{sum(1 for r in a['registry'].values() if r.get('owner') is None)} shared (owner None)")
    print(f"staff   : {', '.join(a['staff']) or '(none in users.json - every owner counts as a client)'}")
    print()
    print(f"LEAKS - shared rows over a client's upload: {len(a['leaks'])}")
    for e in a["leaks"]:
        print(f"  job {e['jid']}  {e['name']!r}")
        print(f"      path      : {e['path']}")
        for o_jid, o in e["clients"]:
            print(f"      client row: job {o_jid} owned by {o!r} points at the same file")
        if e["same_bytes_client"]:
            print(f"      ledger    : events on client job(s) {', '.join(e['same_bytes_client'])} "
                  f"carry this file's pdf_sha1 {e['sha1'][:12]}")
        n = len(e["opened"])
        if n:
            first, last = e["opened"][0][0], e["opened"][-1][0]
            names = sorted({nm for _, nm in e["opened"] if nm})
            print(f"      ledger    : {n} demo_opened event(s) on this row, {first} .. {last}, "
                  f"as {', '.join(repr(x) for x in names) or '?'}")
        else:
            print("      ledger    : no demo_opened event on this row")
        for t in e["thumbs"]:
            print(f"      thumb     : {t}")
        if e["job_dir"]:
            print(f"      job dir   : {e['job_dir']}")
    print()
    print(f"SHARED ROWS KEPT - no client row on the path: {len(a['kept'])}")
    for e in a["kept"]:
        where = "under the store (an upload: a staff seed, or a leak whose client row is gone)" \
            if e["under_store"] else "outside the store (a corpus file)"
        print(f"  job {e['jid']}  {e['name']!r}  {where}")
        print(f"      {len(e['opened'])} demo_opened event(s)")
        if e["same_bytes_gone"]:
            print(f"      WARNING: job(s) {', '.join(e['same_bytes_gone'])} - no longer in the "
                  f"registry - worked the same bytes; if that was a client's upload, "
                  f"this row is a leak. Decide by hand.")
        if e["same_bytes_client"]:
            print(f"      WARNING: client job(s) {', '.join(e['same_bytes_client'])} worked "
                  f"the same bytes under another path")
    if a["missing"]:
        print()
        print(f"SHARED ROWS WHOSE FILE IS GONE (inert: the server skips them on load): "
              f"{len(a['missing'])}")
        for e in a["missing"]:
            print(f"  job {e['jid']}  {e['path']}")


def purge(a: dict) -> int:
    if not a["leaks"]:
        print("\nnothing to purge")
        return 0
    reg = a["registry"]
    print("\nPURGING")
    for e in a["leaks"]:
        jid = e["jid"]
        for t in e["thumbs"]:
            try:
                t.unlink()
                print(f"  removed thumb   {t}")
            except OSError as err:
                print(f"  !! could not remove thumb {t}: {err}")
        d = e["job_dir"]
        if d is not None and d.resolve().parent == a["store"].resolve():
            try:
                shutil.rmtree(d)
                print(f"  removed job dir {d}")
            except OSError as err:
                print(f"  !! could not remove job dir {d}: {err}")
        reg.pop(jid, None)
        print(f"  removed row     {jid}  ({e['name']!r})")
        print(f"  kept PDF        {e['path']}  (the client's own row still points at it)")
    tmp = a["reg_path"].with_suffix(".json.tmp")
    tmp.write_text(json.dumps(reg, indent=1))
    tmp.replace(a["reg_path"])
    print(f"  wrote           {a['reg_path']}  ({len(reg)} rows)")
    print("\nRestart the app so it reloads registry.json (JOBS is held in memory):")
    print("  docker compose restart app")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        prog="python tools/demo_rows_audit.py",
        description="List (and with --purge remove) shared registry rows minted "
                    "over a client's upload. Dry run unless --purge.")
    ap.add_argument("--store", required=True,
                    help="the job store holding registry.json (the box's "
                         "/data/jobs). Required; there is no default on purpose.")
    ap.add_argument("--ledger", default=None,
                    help="the training-ledger directory (default: <store>/ledger, "
                         "which is where the service writes it)")
    ap.add_argument("--purge", action="store_true",
                    help="delete the leak rows, their job directories and "
                         "_demo_thumbs PNGs. Without it nothing is written.")
    args = ap.parse_args(argv)
    store = Path(args.store).expanduser()
    if not store.is_dir():
        sys.exit(f"!! --store {store} is not a directory")
    ledger_dir = Path(args.ledger).expanduser() if args.ledger else store / "ledger"
    a = audit(store, ledger_dir)
    report(a)
    if args.purge:
        return purge(a)
    if a["leaks"]:
        print(f"\nDRY RUN: {len(a['leaks'])} leak row(s) would be removed. "
              f"Re-run with --purge to do it.")
    else:
        print("\nDRY RUN: no leak rows found.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
