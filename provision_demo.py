"""Create the demo accounts and lock down who can see which plan sets.

Run INSIDE the app container, where /data/jobs is the live job store:

    docker compose exec -T app python provision_demo.py

Writes the credential list to /data/jobs/demo-credentials.txt (mode 600) and
prints nothing secret to stdout, so it is safe to run over a shared terminal
or from an automation log.

Restart the app afterwards. Ownership lives in registry.json, and the running
process holds JOBS in memory, so an edit here is not visible until it reloads.
"""

from __future__ import annotations

import json
import os
import secrets
import sys
from pathlib import Path

# Not via __file__: this is sometimes piped in over stdin, where there is no
# __file__ to derive a path from.
sys.path.insert(0, os.getcwd())
from takeoff_engine import users  # noqa: E402

# Our own team. Staff see every document on the box and can delete any of
# them, which is how the Beaumont sets stay reachable for a demo after they
# stop being shared, and how a client's upload gets cleaned off afterwards.
STAFF = ["koby@radiantaisoftware.com", "christian@radiantaisoftware.com"]

CLIENTS = [
    "deerecreek2@gmail.com",
    "admin@rpmenterprisellc.com",
    "jason@sitework.biz",
    "sal@santils.net",
    "jeff.ecifoundations@gmail.com",
    "gabe@feuzexcavation.com",
    "lester@tahoecontractorsaz.com",
    "shamrockpatm@gmail.com",
    "naylorconstruction1@gmail.com",
    "rpierce@piercesitework.com",
    "jpierce@piercesitework.com",
    "jordan@wysongglassnm.com",
    "bexinc72@gmail.com",
    "jland@affiliatedmetal.com",
    "rvrqvr@aol.com",
    "svwbilldunn@sbcglobal.net",
    "klayton@minersunderground.com",
    "ryan@rivercityplastics.com",
]

# Stays visible to everyone: the Loves Lane civil sheets and Belle Farms.
# Everything else on the box is a named client's drawings, and eighteen of the
# accounts above are competing contractors, so it moves to staff-only.
SHARED_PREFIXES = (
    "C3.0-Site-Plan",
    "C4.0-SITE-GRADING",
    "C8.0-STORM-LAYOUT",
    "C9.0-ROAD-LAYOUT",
    "C10.4-TYPICAL-ROAD",
    "Belle Farms",
)

# Ambiguous glyphs removed: these get read off a screen and typed into a
# browser prompt by someone who has never seen the product before.
ALPHABET = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"


def make_password(n: int = 14) -> str:
    return "".join(secrets.choice(ALPHABET) for _ in range(n))


def main() -> int:
    jobs_dir = Path(os.environ.get("TAKEOFF_JOBS_DIR") or "/data/jobs")
    if not jobs_dir.is_dir():
        print(f"!! {jobs_dir} is not a directory - run this inside the app "
              f"container", file=sys.stderr)
        return 1

    existing = users.load()
    store = dict(existing)
    creds: list[tuple[str, str, bool]] = []

    for name in STAFF + CLIENTS:
        name = name.strip().lower()
        if name in store:
            # Never silently reset a password somebody is already using.
            creds.append((name, "(unchanged - account already existed)",
                          bool(store[name].get("staff"))))
            continue
        pw = make_password()
        rec = users.hash_password(pw)
        if name in [s.lower() for s in STAFF]:
            rec["staff"] = True
        store[name] = rec
        creds.append((name, pw, bool(rec.get("staff"))))

    users.save(store)

    # --- ownership -------------------------------------------------------
    reg_path = jobs_dir / "registry.json"
    moved = kept = 0
    if reg_path.exists():
        reg = json.loads(reg_path.read_text())
        owner = STAFF[0].lower()
        for jid, row in reg.items():
            src = Path(row.get("path", "")).name
            # uploads are stored as upload_<hex>_<real name>
            disp = src.split("_", 2)[-1] if src.startswith("upload_") else src
            if disp.startswith(SHARED_PREFIXES):
                row["owner"] = None
                kept += 1
            else:
                row["owner"] = owner
                moved += 1
        tmp = reg_path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(reg, indent=1))
        tmp.replace(reg_path)

    # --- credential file -------------------------------------------------
    out = jobs_dir / "demo-credentials.txt"
    lines = [
        "CORE Takeoff - demo logins for https://core.workoptional.studio",
        "",
        "Give each person their own line. The username IS the email address.",
        "Anything typed as the username must match; the password is what",
        "matters and it is case-sensitive.",
        "",
        "DELETE THIS FILE once the passwords are distributed:",
        f"  rm {out}",
        "",
    ]
    w = max(len(c[0]) for c in creds)
    for name, pw, staff in sorted(creds, key=lambda c: (not c[2], c[0])):
        lines.append(f"{name.ljust(w)}  {pw}" + ("   [STAFF]" if staff else ""))
    out.write_text("\n".join(lines) + "\n")
    try:
        os.chmod(out, 0o600)
    except OSError:
        pass

    fresh = sum(1 for c in creds if not c[1].startswith("("))
    print(f"users total      : {len(store)}")
    print(f"  new this run   : {fresh}")
    print(f"  already existed: {len(creds) - fresh} (passwords untouched)")
    print(f"  staff          : {sum(1 for c in creds if c[2])}")
    print(f"plan sets shared : {kept}")
    print(f"plan sets staff-only: {moved}")
    print(f"credentials      : {out}  (mode 600, nothing printed here)")
    print("\nRestart the app so it reloads registry.json:")
    print("  docker compose restart app")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
