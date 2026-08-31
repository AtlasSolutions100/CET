"""GET /api/projects - the landing page's card list, pinned.

Same import technique as tests/test_workzone_server.py: JOBS_DIR is pointed
at a disposable temp dir BEFORE server import, then the route function is
called directly with a stub Request (all it reads is request.scope). The
fixtures cover the fields a card renders from - detected counts
p<N>_result.json, approved counts p<N>_elements.json, has_thumb is the
p0_28.png strip cache - plus the two behaviours that must not regress:
the /api/recent ownership rule (per-user mode hides other people's plans;
single-password mode hides nothing) and the self-declared coverage
({total, projects}) so a capped list can never silently read as "my plans
are gone".

Dependency-free beyond the venv:  python tests/test_projects_api.py
"""

import os
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

os.environ["TAKEOFF_JOBS_DIR"] = tempfile.mkdtemp(prefix="projects_test_")

import server  # noqa: E402

JOBS_DIR = server.JOBS_DIR

CHECKS = []


def ok(cond, msg, got=None):
    CHECKS.append((cond, msg, got))


class _Req:
    """The route reads request.scope and nothing else."""

    def __init__(self, user=None, staff=False):
        self.scope = {"tk_user": user, "tk_staff": staff}


def seed(jid, name, pages, owner=None, results=0, approved=0, thumb=False,
         mtime=None):
    src = JOBS_DIR / name
    src.write_bytes(b"%PDF-1.4 stub")
    if mtime is not None:
        os.utime(src, (mtime, mtime))
    d = JOBS_DIR / jid
    d.mkdir(exist_ok=True)
    for p in range(results):
        (d / f"p{p}_result.json").write_text("{}")
    for p in range(approved):
        (d / f"p{p}_elements.json").write_text("{}")
    if thumb:
        (d / "p0_28.png").write_bytes(b"\x89PNG stub")
    if mtime is not None:
        os.utime(d, (mtime, mtime))
    server.JOBS[jid] = {"path": str(src), "pages": pages, "mtime": None,
                        "owner": owner, "status": {}}


NOW = time.time()
server.JOBS.clear()
# oldest -> newest activity, deliberately seeded out of order
seed("jobaaaaaaaaa", "upload_ab12cd34ef56_barn.pdf", 15, owner=None,
     results=15, approved=2, thumb=True, mtime=NOW - 500)
seed("jobbbbbbbbbb", "kayden.pdf", 48, owner="alice", results=12,
     thumb=False, mtime=NOW - 100)
seed("jobccccccccc", "ellis.pdf", 54, owner="bob", results=3, approved=1,
     thumb=True, mtime=NOW - 300)
# registered but its PDF is gone: must not produce a dead card
server.JOBS["jobdddddddddd"] = {"path": str(JOBS_DIR / "vanished.pdf"),
                                "pages": 9, "owner": None, "status": {}}

# ---- single-password mode (user None => staff): every living job ----------
r = server.list_projects(_Req())
ok(isinstance(r, dict) and set(r) == {"total", "projects"},
   "reply shape is {total, projects}", set(r))
rows = {p["job_id"]: p for p in r["projects"]}
ok(r["total"] == 3 and len(rows) == 3,
   "single-password mode: 3 cards, the vanished PDF dropped", r["total"])
ok([p["job_id"] for p in r["projects"]] ==
   ["jobbbbbbbbbb", "jobccccccccc", "jobaaaaaaaaa"],
   "sorted newest activity first", [p["job_id"] for p in r["projects"]])

barn = rows["jobaaaaaaaaa"]
ok(barn["name"] == "barn.pdf",
   "upload_<hash>_ plumbing stripped from the card name", barn["name"])
ok(barn["pages"] == 15 and barn["detected"] == 15 and barn["approved"] == 2,
   "detected counts p*_result.json, approved counts p*_elements.json",
   (barn["pages"], barn["detected"], barn["approved"]))
ok(barn["has_thumb"] is True and rows["jobbbbbbbbbb"]["has_thumb"] is False,
   "has_thumb reads the p0_28.png strip cache")
ok(barn["shared"] is True and barn["deletable"] is True,
   "owner-less row is shared; staff may delete it")
ok(abs(barn["when"] - (NOW - 500)) < 5,
   "when is the job dir's mtime", barn["when"])
ok(rows["jobbbbbbbbbb"]["approved"] == 0,
   "no approvals -> approved 0, never missing")

# ---- per-user mode: alice sees hers + shared, never bob's -----------------
r = server.list_projects(_Req(user="alice"))
ids = [p["job_id"] for p in r["projects"]]
ok("jobbbbbbbbbb" in ids and "jobaaaaaaaaa" in ids
   and "jobccccccccc" not in ids,
   "alice: own + shared, bob's plans invisible", ids)
al = {p["job_id"]: p for p in r["projects"]}
ok(al["jobbbbbbbbbb"]["mine"] is True and al["jobbbbbbbbbb"]["deletable"] is True,
   "alice's own row is mine + deletable")
ok(al["jobaaaaaaaaa"]["mine"] is False and al["jobaaaaaaaaa"]["deletable"] is False,
   "shared demo row is not deletable for a plain user")

# ---- staff in per-user mode see everything ---------------------------------
r = server.list_projects(_Req(user="carol", staff=True))
ok(len(r["projects"]) == 3, "staff see every account's plans",
   len(r["projects"]))

# ---- report ---------------------------------------------------------------
failures = 0
for cond, msg, got in CHECKS:
    if cond:
        print("ok:", msg)
    else:
        failures += 1
        print("FAIL:", msg, "" if got is None else "(got %r)" % (got,))
if failures:
    sys.exit("%d failure(s)" % failures)
print("all projects api tests passed")
