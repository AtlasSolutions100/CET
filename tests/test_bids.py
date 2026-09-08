"""OPEN BIDS: the engine's side of the Bid Sniper hand-off (2026-09-07).

takeoff_engine/bids.py is what /api/bids and /api/bids/{id}/pull are built
from. Everything here runs with neither service up: the client takes an
injected session with requests' get/post shape, and the rest is pure.

What is pinned, and why each one matters:

  * open_bids keeps ONLY open, undismissed, non-duplicate, still-open,
    relevant rows. A closed bid on the tab is a job nobody can bid; a
    BidNet mirror of a U3P listing is the same job twice; a row under the
    relevance floor is a janitorial contract.
  * an UNDATED bid is kept, with days_left None. "No close date read" is a
    fact for the card, not a reason to hide the work.
  * order is score desc, then soonest close, then title - total, so two
    renders never swap cards.
  * pick_plan takes the LARGEST file (the drawing set) unless told which;
    an explicit index that is not there returns None rather than the
    largest, because "the file you asked for" and "some file" are not the
    same answer.
  * sniper_url: hidden on a hosted box unless configured; the local default
    otherwise; BID_SNIPER_URL wins everywhere and loses its trailing slash.
  * the client hits the sniper's routes with the query the sniper reads
    (fetch=0/1), streams file bytes verbatim, and link() never raises.
    It is exercised over a fake session with requests' get/post shape.

Run:  python tests/test_bids.py      (or under pytest)
"""
from __future__ import annotations

import json
import sys
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import requests  # noqa: E402

from takeoff_engine import bids  # noqa: E402

FAILS: list[str] = []


def check(cond, msg):
    print(("  ok   " if cond else "  FAIL ") + msg)
    if not cond:
        FAILS.append(msg)


NOW = datetime(2026, 9, 7, 12, 0, 0)


def row(**kw):
    d = {"id": "bonfire:utah:1", "source": "bonfire:utah", "title": "T",
         "agency": "CITIES - Lehi City", "url": "https://x/1",
         "status": "open", "dismissed": False, "dup_of": None,
         "relevance": 0.8, "score": 20.0, "competition": None,
         "due": (NOW + timedelta(days=5)).isoformat(),
         "documents": [{"url": "https://x/d", "local_path": None}],
         "why": ["a", "b"], "takeoff_job": None}
    d.update(kw)
    return d


# ---- open_bids: the filter ---------------------------------------------------
print("open_bids")
kept = bids.open_bids([row()], NOW)
check(len(kept) == 1, "a plain open relevant row is kept")
b = kept[0]
check(b["days_left"] == 5.0, "days_left is measured from now (5.0)")
check(b["docs_listed"] == 1 and b["docs_local"] == 0,
      "document counts: one link listed, none on disk")
check(b["name"] == b["title"], "name mirrors title so the search box works")

check(bids.open_bids([row(status="closed")], NOW) == [], "closed status is dropped")
check(bids.open_bids([row(dismissed=True)], NOW) == [], "dismissed is dropped")
check(bids.open_bids([row(dup_of="bidnet:9")], NOW) == [], "a duplicate row is dropped")
check(bids.open_bids([row(relevance=0.29)], NOW) == [], "below the relevance floor is dropped")
check(bids.open_bids([row(relevance=0.30)], NOW) != [], "at the floor is kept")
check(bids.open_bids([row(due=(NOW - timedelta(hours=1)).isoformat())], NOW) == [],
      "a due date an hour ago is dropped")
und = bids.open_bids([row(due=None)], NOW)
check(len(und) == 1 and und[0]["days_left"] is None and und[0]["due"] is None,
      "an undated bid is kept with days_left None")
check(bids.open_bids([row(due="not a date")], NOW)[0]["days_left"] is None,
      "an unparseable date reads as undated rather than raising")
check(bids.open_bids([None, "x", 3, row()], NOW).__len__() == 1,
      "junk rows are skipped, not fatal")
check(bids.open_bids(None, NOW) == [], "None input is an empty tab")

# ---- open_bids: the order ----------------------------------------------------
print("order")
rows = [
    row(id="a", title="Bravo", score=10, due=(NOW + timedelta(days=9)).isoformat()),
    row(id="b", title="Alpha", score=30, due=(NOW + timedelta(days=9)).isoformat()),
    row(id="c", title="Charlie", score=30, due=(NOW + timedelta(days=2)).isoformat()),
    row(id="d", title="Delta", score=30, due=None),
    row(id="e", title="alpha", score=30, due=(NOW + timedelta(days=9)).isoformat()),
]
order = [b["id"] for b in bids.open_bids(rows, NOW)]
check(order == ["c", "b", "e", "d", "a"],
      "score desc, then soonest close, undated after dated, then title; got %s" % order)
check(order == [b["id"] for b in bids.open_bids(list(reversed(rows)), NOW)],
      "the order does not depend on input order")

# ---- pick_plan ---------------------------------------------------------------
print("pick_plan")
files = [{"i": 0, "name": "big.pdf", "size": 6_500_000},
         {"i": 1, "name": "rfb.pdf", "size": 400_000},
         {"i": 2, "name": "agreement.pdf", "size": 100_000}]
check(bids.pick_plan(files)["i"] == 0, "the largest file is the drawing set by default")
check(bids.pick_plan(list(reversed(files)))["i"] == 0, "...regardless of list order")
check(bids.pick_plan(files, 1)["i"] == 1, "an explicit index is honoured")
check(bids.pick_plan(files, 7) is None, "an explicit index that is not there is None, not the largest")
check(bids.pick_plan([]) is None and bids.pick_plan(None) is None, "no files is None")
check(bids.pick_plan([{"i": 0, "name": "empty.pdf", "size": 0}]) is None,
      "a zero-byte file is not a plan")
tie = [{"i": 0, "size": 5}, {"i": 1, "size": 5}]
check(bids.pick_plan(tie)["i"] == 0, "equal sizes: the sniper's first (largest-first) wins")

# ---- sniper_url --------------------------------------------------------------
print("sniper_url")
check(bids.sniper_url(hosted=True, env={}) == "", "hosted + unset = hidden")
check(bids.sniper_url(hosted=False, env={}) == bids.DEFAULT_URL, "laptop + unset = local default")
check(bids.sniper_url(hosted=True, env={"BID_SNIPER_URL": "http://10.0.0.5:8200/"})
      == "http://10.0.0.5:8200", "configured wins on a hosted box, trailing slash dropped")
check(bids.sniper_url(hosted=False, env={"BID_SNIPER_URL": "  "}) == bids.DEFAULT_URL,
      "blank config is unset")

# ---- bid_meta / closes_text ----------------------------------------------------
print("meta")
m = bids.bid_meta({"title": "T", "agency": "A", "due": "2026-09-15T23:00:00",
                   "url": "https://x", "files": [1, 2, 3], "takeoff_job": "zz"}, "bonfire:utah:1")
check(set(m) == {"id", "title", "agency", "due", "url"},
      "the registry keeps only the five small fields")
check(m["id"] == "bonfire:utah:1", "...keyed by the sniper's listing id")
check(bids.closes_text(None, NOW) == "no close date read", "closes_text: undated")
check(bids.closes_text((NOW + timedelta(days=3)).isoformat(), NOW).startswith("closes in 3 days ("),
      "closes_text: in 3 days")
check(bids.closes_text((NOW + timedelta(hours=2)).isoformat(), NOW).startswith("closes today"),
      "closes_text: today")
check(bids.closes_text((NOW - timedelta(days=1)).isoformat(), NOW).startswith("closed "),
      "closes_text: closed")

# ---- the client, over a fake session ------------------------------------------
print("client")
SEEN: list[tuple[str, str, dict]] = []
PDF = b"%PDF-1.4\n%fake\n" + b"x" * 100


class Resp:
    def __init__(self, status, body=b"", js=None):
        self.status_code = status
        self.content = body
        self._js = js

    def json(self):
        return self._js

    def raise_for_status(self):
        if self.status_code >= 400:
            e = requests.HTTPError("%d" % self.status_code)
            e.response = self
            raise e


class FakeSession:
    """requests.Session's get/post shape, answering like the sniper."""

    def get(self, url, params=None, timeout=None):
        path = url.split("http://sniper.test", 1)[1]
        SEEN.append(("GET", path, dict(params or {})))
        if path == "/api/listings":
            return Resp(200, js=[row()])
        if path == "/api/listings/bonfire:utah:1/plans":
            return Resp(200, js={"id": "bonfire:utah:1", "title": "T",
                                 "files": [{"i": 0, "name": "big.pdf", "size": len(PDF)}]})
        if path == "/api/listings/bonfire:utah:1/plans/0":
            return Resp(200, body=PDF)
        return Resp(404)

    def post(self, url, json=None, timeout=None):
        path = url.split("http://sniper.test", 1)[1]
        SEEN.append(("POST", path, dict(json or {})))
        if path == "/api/listings/bonfire:utah:1/link":
            return Resp(200 if (json or {}).get("job_id") == "abc123" else 400, js={"ok": True})
        return Resp(404)

    def close(self):
        pass


with bids.Sniper("http://sniper.test/", session=FakeSession()) as s:
    check(s.base_url == "http://sniper.test", "base url loses its trailing slash")
    lst = s.list_open()
    check(len(lst) == 1 and SEEN[-1][1:] == ("/api/listings", {"all": 0}),
          "list_open asks the sniper for open rows only (all=0)")
    p = s.plans("bonfire:utah:1", fetch=False)
    check(SEEN[-1][2] == {"fetch": 0}, "plans(fetch=False) does not make the sniper download")
    p = s.plans("bonfire:utah:1", fetch=True)
    check(SEEN[-1][2] == {"fetch": 1}, "plans(fetch=True) does")
    raw = s.file_bytes("bonfire:utah:1", 0)
    check(raw == PDF, "file bytes come back verbatim")
    check(s.link("bonfire:utah:1", "abc123", "http://engine/#job=abc123") is True,
          "link posts the job id and reports the sniper's answer")
    check(SEEN[-1][2] == {"job_id": "abc123", "url": "http://engine/#job=abc123"},
          "...with the job id and the open link in the body")
    check(s.link("bonfire:utah:1", "wrong") is False, "a refused link is False, not an exception")
    try:
        s.plans("nope", fetch=False)
        check(False, "a 404 from the sniper raises requests.HTTPError (the route turns it into 502)")
    except requests.HTTPError:
        check(True, "a 404 from the sniper raises requests.HTTPError (the route turns it into 502)")


class DeadSession:
    def get(self, *a, **k):
        raise requests.ConnectionError("refused")

    def post(self, *a, **k):
        raise requests.ConnectionError("refused")

    def close(self):
        pass


with bids.Sniper("http://sniper.test", session=DeadSession()) as s:
    check(s.link("x", "y") is False, "link() on a dead sniper is False, never raises")
    try:
        s.list_open()
        check(False, "list_open on a dead sniper raises (the route turns it into ok:false)")
    except requests.RequestException:
        check(True, "list_open on a dead sniper raises (the route turns it into ok:false)")

print("\n%d FAILED" % len(FAILS) if FAILS else "\nall passed")
sys.exit(1 if FAILS else 0)
