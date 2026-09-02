"""provision_demo.py shares a row ONLY when it is ours: already shared, or
owned by a STAFF account. A client's row keeps its owner whatever it is
named, and the tool prints each refusal with the display name and owner.

THE HOLE (b528e74 and earlier). The ownership block decided on the display
name alone: any registry row whose name is a manifest name or starts with a
SHARED_PREFIX got owner None, with no look at who uploaded it, and every
other row was moved to staff. On a copy of a store holding only alice's
"Belle Farms Structural Plans.pdf" it printed "plan sets shared : 1" and
published her private bid set to every account on the box. DEPLOY and the
Dockerfile tell staff to re-run this tool on the box, so it has to be safe
against a store that holds client uploads named like our demo cards.

Runs the real script as a subprocess against a THROWAWAY store copy (the
script reads TAKEOFF_JOBS_DIR), the way it is run on the box, and reads
registry.json back.

Dependency-free:  python tests/test_provision_ownership.py
"""

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import provision_demo  # noqa: E402

STAFF_OWNER = provision_demo.STAFF[0].lower()
ALICE = "alice_synth@example.test"          # not on the roster: a client
manifest = json.loads((ROOT / "demo-plans.json").read_text(encoding="utf-8"))
NAMES = sorted(manifest["plans"])
NAME = ("Belle Farms Structural Plans.pdf"
        if "Belle Farms Structural Plans.pdf" in NAMES else NAMES[0])
PREFIX_NAME = provision_demo.SHARED_PREFIXES[0] + "-synthetic.pdf"


def row(store: Path, name: str, owner, hexid: str) -> dict:
    return {"path": str(store / f"upload_{hexid}_{name}"), "pages": 1,
            "mtime": 1.0, "kinds": None, "sizes": [[612.0, 792.0]],
            "owner": owner}


def run_tool(store: Path) -> str:
    env = dict(os.environ, TAKEOFF_JOBS_DIR=str(store))
    r = subprocess.run([sys.executable, "provision_demo.py"], cwd=str(ROOT),
                       env=env, capture_output=True, text=True, timeout=600)
    assert r.returncode == 0, (r.returncode, r.stdout, r.stderr)
    return r.stdout


def test_1_client_rows_keep_their_owner_staff_rows_are_shared():
    store = Path(tempfile.mkdtemp(prefix="provision_owner_test_"))
    reg = {
        # alice's upload wearing a manifest name: the adversary's case
        "a1a1a1a1a1a1": row(store, NAME, ALICE, "0a0a0a0a0a0a"),
        # alice's upload wearing a shared prefix
        "a2a2a2a2a2a2": row(store, PREFIX_NAME, ALICE, "0b0b0b0b0b0b"),
        # alice's ordinary upload: must not be moved to staff either
        "a3a3a3a3a3a3": row(store, "Alice Private Bid Set.pdf", ALICE,
                            "0c0c0c0c0c0c"),
        # our own seed, uploaded by a staff account: shared
        "5e5e5e5e5e5e": row(store, NAME, STAFF_OWNER, "0d0d0d0d0d0d"),
        # a staff member's ordinary upload: staff-only, as before
        "5f5f5f5f5f5f": row(store, "Staff Scratch Set.pdf", STAFF_OWNER,
                            "0e0e0e0e0e0e"),
        # a row from before per-user mode: shared already, stays shared
        "6a6a6a6a6a6a": row(store, NAME, None, "0f0f0f0f0f0f"),
    }
    (store / "registry.json").write_text(json.dumps(reg, indent=1))

    out = run_tool(store)
    after = json.loads((store / "registry.json").read_text())
    owners = {jid: r.get("owner") for jid, r in after.items()}

    # THE ASSERTION THE HOLE FAILS: on b528e74 alice's manifest-named row
    # comes back with owner None and the output says "plan sets shared : 3".
    assert owners["a1a1a1a1a1a1"] == ALICE, \
        "alice's manifest-named upload was shared: owners=%r\n%s" % (owners, out)
    assert owners["a2a2a2a2a2a2"] == ALICE, owners
    assert owners["a3a3a3a3a3a3"] == ALICE, \
        "alice's ordinary upload was moved to staff: %r" % owners
    assert owners["5e5e5e5e5e5e"] is None, owners
    assert owners["5f5f5f5f5f5f"] == STAFF_OWNER, owners
    assert owners["6a6a6a6a6a6a"] is None, owners

    # the output says which rows it refused, by display name and owner
    for disp in (NAME, PREFIX_NAME, "Alice Private Bid Set.pdf"):
        line = [ln for ln in out.splitlines()
                if "refused" in ln and repr(disp) in ln and repr(ALICE) in ln]
        assert line, "no refusal printed for %r owned by %r:\n%s" % (
            disp, ALICE, out)
    assert "plan sets shared : 2" in out, out
    assert "plan sets staff-only: 1" in out, out
    assert "plan sets left with their client: 3" in out, out

    # nothing else about the row was touched
    for jid in reg:
        a, b = dict(reg[jid]), dict(after[jid])
        a.pop("owner"), b.pop("owner")
        assert a == b, (jid, a, b)


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for fn in fns:
        fn()
        print(f"ok  {fn.__name__}")
    print(f"{len(fns)} tests passed")
