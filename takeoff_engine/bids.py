"""Open bids from Bid Sniper, and the pull that turns one into a job.

Bid Sniper (OptionallyWorking/bid_sniper, :8200) polls the Utah portals,
scores every open solicitation for dirt-work relevance and thin fields, and
downloads the plan set on request. This module is the engine's side of
that: list the open bids, pick the drawing set, stream it here.

WHY THE ENGINE PULLS rather than the sniper pushing. The sniper's own
`takeoff.send` logs into the engine with one fixed account and uploads, so
every job it made belonged to that account whoever pressed the button, and
the sniper had to hold an engine password. Pulling from inside an engine
request means the job is owned by the person who clicked, exactly like an
upload from their browser, and the sniper needs no credentials at all.

Everything here is pure or takes an injected session, so tests run without
either service up.
"""
from __future__ import annotations

import os
from datetime import datetime, timedelta
from typing import Optional

import requests

# A bid must look at least this much like excavation / civil work to be
# offered. The sniper's classify.py scores 0..1; its own dashboard hides
# under 0.15 as "not our work", and 0.3 is where the current corpus's
# obvious roadway / storm-drain / reservoir jobs sit.
RELEVANCE_MIN = 0.3

DEFAULT_URL = "http://127.0.0.1:8200"


def sniper_url(hosted: bool, env: Optional[dict] = None) -> str:
    """Where Bid Sniper is, or "" when the tab must stay hidden.

    On a laptop it is the default local port unless BID_SNIPER_URL says
    otherwise. On a HOSTED box there is no default: the sniper runs on the
    operator's own machine with their browser session, and a hosted engine
    silently probing 127.0.0.1:8200 would either find nothing or find
    something that is not ours."""
    e = os.environ if env is None else env
    url = (e.get("BID_SNIPER_URL") or "").strip().rstrip("/")
    if url:
        return url
    return "" if hosted else DEFAULT_URL


def _parse_dt(s) -> Optional[datetime]:
    if not s or not isinstance(s, str):
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).replace(tzinfo=None)
    except ValueError:
        return None


def open_bids(rows, now: Optional[datetime] = None) -> list[dict]:
    """The listings worth showing on the Open-bids tab, best first.

    Keeps: status open, not dismissed, not a duplicate of another row
    (`dup_of` - BidNet mirrors U3P, and the sniper hides copies too), still
    open at `now` (a due date in the past is not a bid), and relevance at or
    above RELEVANCE_MIN. Undated bids are kept: "no close date read" is a
    fact for the card, not a reason to hide the job. Sorted by the sniper's
    score, highest first; ties by soonest close, then title, so two renders
    never swap cards."""
    now = now or datetime.utcnow()
    out = []
    for r in rows or []:
        if not isinstance(r, dict):
            continue
        if (r.get("status") or "open") != "open" or r.get("dismissed"):
            continue
        if r.get("dup_of"):
            continue
        if float(r.get("relevance") or 0.0) < RELEVANCE_MIN:
            continue
        due = _parse_dt(r.get("due"))
        if due is not None and due < now:
            continue
        days = None if due is None else (due - now).total_seconds() / 86400.0
        docs = r.get("documents") or []
        out.append({
            "id": r.get("id"),
            "title": r.get("title") or "(untitled)",
            "name": r.get("title") or "(untitled)",   # what projFilter searches
            "agency": r.get("agency"),
            "source": r.get("source"),
            "url": r.get("url"),
            "due": due.isoformat() if due else None,
            "days_left": None if days is None else round(days, 2),
            "score": round(float(r.get("score") or 0.0), 1),
            "competition": r.get("competition"),
            "why": list(r.get("why") or [])[:6],
            # what the sniper holds for this listing, so the card can say
            # whether Start will be instant, a download, or impossible
            "docs_listed": sum(1 for d in docs if isinstance(d, dict) and d.get("url")),
            "docs_local": sum(1 for d in docs if isinstance(d, dict) and d.get("local_path")),
            "takeoff_job": r.get("takeoff_job"),
        })
    # total order: two titles that differ only by case, then only by id, must
    # still land the same way whatever order the sniper sent them in
    out.sort(key=lambda b: (-b["score"],
                            b["days_left"] if b["days_left"] is not None else 1e9,
                            b["title"].lower(), b["title"], str(b["id"])))
    return out


def pick_plan(files, want: int = -1) -> Optional[dict]:
    """Which of the sniper's PDFs to make the job from.

    The sniper lists them largest first and the drawing set is almost always
    the biggest file - the RFB text, agreement template and schedule are a
    few hundred KB each. `want` is an explicit index for when it is not."""
    files = [f for f in (files or []) if isinstance(f, dict)
             and isinstance(f.get("i"), int) and (f.get("size") or 0) > 0]
    if not files:
        return None
    if want >= 0:
        for f in files:
            if f["i"] == want:
                return f
        return None
    return max(files, key=lambda f: (f.get("size") or 0, -f["i"]))


class Sniper:
    """A thin client over the sniper's HTTP API. `session` is anything with
    requests' get/post shape - the tests hand in a fake."""

    def __init__(self, base_url: str, session=None, timeout: float = 300.0):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self._s = session or requests.Session()

    def close(self) -> None:
        try:
            self._s.close()
        except Exception:
            pass

    def __enter__(self):
        return self

    def __exit__(self, *a):
        self.close()

    def _url(self, path: str) -> str:
        return self.base_url + path

    def list_open(self) -> list:
        r = self._s.get(self._url("/api/listings"), params={"all": 0}, timeout=15)
        r.raise_for_status()
        d = r.json()
        return d if isinstance(d, list) else []

    def plans(self, lid: str, fetch: bool) -> dict:
        """The plan PDFs the sniper holds for a listing; fetch=True makes it
        download from the portal first (seconds to a minute)."""
        r = self._s.get(self._url(f"/api/listings/{lid}/plans"),
                        params={"fetch": 1 if fetch else 0}, timeout=self.timeout)
        r.raise_for_status()
        return r.json()

    def file_bytes(self, lid: str, i: int) -> bytes:
        r = self._s.get(self._url(f"/api/listings/{lid}/plans/{i}"),
                        timeout=self.timeout)
        r.raise_for_status()
        return r.content

    def link(self, lid: str, job_id: str, url: Optional[str] = None) -> bool:
        try:
            r = self._s.post(self._url(f"/api/listings/{lid}/link"),
                             json={"job_id": job_id, "url": url}, timeout=15)
            return r.status_code == 200
        except requests.RequestException:
            return False


def bid_meta(plan: dict, lid: str) -> dict:
    """What the job record remembers about where it came from - the card's
    'from bid' line and the report's provenance. Small on purpose: the
    registry is rewritten on every registration."""
    return {
        "id": lid,
        "title": plan.get("title"),
        "agency": plan.get("agency"),
        "due": plan.get("due"),
        "url": plan.get("url"),
    }


def closes_text(due_iso: Optional[str], now: Optional[datetime] = None) -> str:
    """'closes in 3 days (Sep 10)' / 'closes today' / 'closed' / 'no close
    date read' - one phrase for the card and the status line."""
    due = _parse_dt(due_iso)
    if due is None:
        return "no close date read"
    now = now or datetime.utcnow()
    delta = due - now
    day = due.strftime("%b %-d") if os.name != "nt" else due.strftime("%b %d").replace(" 0", " ")
    if delta < timedelta(0):
        return "closed " + day
    d = int(delta.total_seconds() // 86400)
    if d == 0:
        return "closes today (" + day + ")"
    if d == 1:
        return "closes tomorrow (" + day + ")"
    return "closes in %d days (%s)" % (d, day)
