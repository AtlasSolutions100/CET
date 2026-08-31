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
# CHANGED, deliberately: the shape used to be pinned as exactly
# {total, projects}. It now carries a third key, `demo`, and that key is the
# point of the change - the landing page tabs "Demo plans" against "Your
# projects", and an empty demo tab has to be able to say WHY it is empty
# (this box was never seeded) instead of just drawing nothing. The assertion
# is tightened rather than loosened: the set is still exact, so a fourth key
# appearing by accident still fails here.
ok(isinstance(r, dict) and set(r) == {"total", "projects", "demo"},
   "reply shape is {total, projects, demo}", set(r))
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

# ---- THE DEMO SET ----------------------------------------------------------
# A demo is a SHARED row (owner None - the visibility rule this route already
# had) whose display name is in demo-plans.json. Both halves matter: the
# manifest alone would let a client's private upload of the same filename
# join the demo tab, and sharedness alone would call every pre-accounts row a
# demo.
server.DEMO_PLANS = {
    "loves-lane-grading.pdf": {"page": 2, "shows": "grading, both surfaces"},
    "never-uploaded.pdf": {"page": 0, "shows": "not on this box"},
}
server.JOBS.clear()
seed("jobdemo000001", "loves-lane-grading.pdf", 9, owner=None, results=3,
     thumb=True, mtime=NOW - 900)
# same filename, but somebody's own upload: theirs, private, NOT a demo
seed("jobclient00001", "upload_ffffffffffff_loves-lane-grading.pdf", 9,
     owner="alice", results=1, thumb=True, mtime=NOW - 50)
seed("jobplain000001", "alices-own.pdf", 4, owner="alice", mtime=NOW - 10)

r = server.list_projects(_Req(user="alice"))
rows = {p["job_id"]: p for p in r["projects"]}
ok(rows["jobdemo000001"]["demo"] is True,
   "a shared row named in the manifest is a demo")
ok(rows["jobclient00001"]["demo"] is False,
   "alice's OWN upload of the same filename is not a demo",
   rows["jobclient00001"]["demo"])
ok(rows["jobclient00001"]["name"] == "loves-lane-grading.pdf",
   "...even though it displays under exactly the same name",
   rows["jobclient00001"]["name"])
ok(rows["jobplain000001"]["demo"] is False and
   rows["jobplain000001"]["demo_note"] is None,
   "an ordinary row carries demo False and no note")
ok(rows["jobdemo000001"]["demo_note"] == "grading, both surfaces",
   "the card's 'what this shows' line comes from the manifest",
   rows["jobdemo000001"]["demo_note"])
ok(rows["jobdemo000001"]["demo_page"] == 2,
   "...and so does the page a visitor should land on")
ok(rows["jobdemo000001"]["deletable"] is False,
   "a plain user still may not delete a shared demo (rule unchanged)")

# the set's own health, so an empty demo tab can say WHY it is empty
ok(r["demo"] == {"expected": 2, "present": 1,
                 "missing": ["never-uploaded.pdf"]},
   "demo block reports expected/present/missing by name", r["demo"])

# DEMO ROWS ARE NEVER CAPPED. The cards are tabbed, so a demo that fell off
# the end of the newest-200 slice would make the demo tab quietly wrong -
# and on the real box the demo sheets sit at position ~300 of 420.
server.JOBS.clear()
seed("jobdemo000001", "loves-lane-grading.pdf", 9, owner=None, results=3,
     mtime=NOW - 999999)              # oldest thing on the box
for i in range(230):
    seed("jobbulk%06d" % i, "bulk%03d.pdf" % i, 1, owner=None,
         mtime=NOW - i)
r = server.list_projects(_Req())
ids = [p["job_id"] for p in r["projects"]]
ok(r["total"] == 231, "total counts every visible row", r["total"])
ok(len(ids) == 201, "sent = every demo + the newest 200 of the rest",
   len(ids))
ok(ids[0] == "jobdemo000001",
   "the demo leads the reply even though it is the OLDEST row", ids[0])
ok(r["demo"]["present"] == 1, "and it is counted as present")
ok(sum(1 for p in r["projects"] if not p["demo"]) == 200,
   "the 200 cap still applies to everything that is not a demo")
# ordering within the non-demo block is unchanged: newest activity first
non = [p for p in r["projects"] if not p["demo"]]
ok(non == sorted(non, key=lambda p: -p["when"]),
   "non-demo rows keep the newest-activity-first order")

# a box with no manifest at all: no demos, and it says so as 0 expected
server.DEMO_PLANS = {}
r = server.list_projects(_Req())
ok(r["demo"] == {"expected": 0, "present": 0, "missing": []},
   "no manifest -> expected 0, which the UI renders as 'no demo set "
   "configured' rather than as an unseeded box", r["demo"])
ok(all(p["demo"] is False for p in r["projects"]),
   "...and no row claims to be a demo")

# ---- the manifest loader is never allowed to take the service down ---------
import json as _json  # noqa: E402
import tempfile as _tf  # noqa: E402

_bad = Path(_tf.mkdtemp()) / "demo-plans.json"
_bad.write_text("{ this is not json")
server.DEMO_MANIFEST = _bad
ok(server._load_demo_plans() == {}, "a corrupt manifest loads as empty")
_bad.write_text(_json.dumps({"plans": ["not", "a", "dict"]}))
ok(server._load_demo_plans() == {}, "a manifest of the wrong shape too")
_bad.unlink()
ok(server._load_demo_plans() == {}, "an absent manifest too")
_bad.write_text(_json.dumps({"plans": {"a.pdf": {"page": "x"},
                                       "b.pdf": {"page": -4},
                                       "": {"page": 1}}}))
got = server._load_demo_plans()
ok(set(got) == {"a.pdf", "b.pdf"}, "a blank key is dropped", set(got))
ok(got["a.pdf"]["page"] == 0 and got["b.pdf"]["page"] == 0,
   "an unusable or negative page falls back to 0, never crashes a card",
   (got["a.pdf"]["page"], got["b.pdf"]["page"]))

# ---- the shipped manifest is OURS, not a client's --------------------------
# The provenance rule from the brief, enforced rather than trusted: nothing
# from Ryno Construction and nothing from client_meet may be a demo plan.
_shipped = Path(server.ROOT) / "demo-plans.json"
ok(_shipped.exists(), "demo-plans.json ships with the repo")
_names = list(_json.loads(_shipped.read_text(encoding="utf-8"))["plans"])
_banned = ("ryno", "stice", "liberty", "beaumont", "kayden", "ellis",
           "klayton", "swr_", "thielen", "aqua vista")
for _n in _names:
    ok(not any(b in _n.lower() for b in _banned),
       "demo plan %r is not a client document" % _n)
ok(len(_names) >= 4, "the manifest has at least the four named plans",
   len(_names))

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
