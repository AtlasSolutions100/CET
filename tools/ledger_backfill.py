"""Backfill the training ledger from label sources already on disk.

The ledger (takeoff_engine/ledger.py) started recording on the day it
shipped; this imports what was PROVABLY labeled before that day:

  a) p<N>_calcstate.json  - the calculator-input sidecars. Each carries
     operator-confirmed decisions: manual elevation rows, layer stacks,
     hand-drawn boundaries, trench setups, structure outlines, work-area
     zones, review check-offs. Imported through the same semantic differ
     the live hook uses (ledger.calcstate_events with old={}), so a
     backfilled boundary_set looks exactly like a live one.
  b) p<N>_scale.json      - reviewer scale picks (a human overruled or
     replaced the engine's reading).
  c) p<N>_elements.json   - approved sheet exports: the final labels,
     itemized counts, overrides and scale a human signed off on.

  NOT importable: the original :8100 classify/approve review store's
  per-document label/price/trade memory. It is CLIENT-SIDE ONLY -
  localStorage in the browser (webui/app.js, MEM_V) - and never reached
  the server. The approvals that DID reach the server are exactly the
  p<N>_elements.json files imported by (c).

Timestamps come from file mtime (the closest thing to "when the decision
was recorded" these files carry), ui_source is "backfill", and every
event carries a dedupe key - sha1 of the semantic payload - so a second
run imports nothing new. Stdlib only.

Usage:
  python tools/ledger_backfill.py [--jobs-dir DIR] [--ledger-dir DIR]
                                  [--dry-run]

--jobs-dir defaults to TAKEOFF_JOBS_DIR, else <repo>/out/jobs (the same
resolution server.py uses). --ledger-dir sets TAKEOFF_LEDGER_DIR for
this run.
"""

import argparse
import json
import os
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from takeoff_engine import ledger  # noqa: E402

_PAGE_OF = re.compile(r"^p(\d+)_")


def _mtime(f: Path):
    try:
        return f.stat().st_mtime
    except OSError:
        return None


def _load(f: Path):
    try:
        d = json.loads(f.read_text(encoding="utf-8"))
        return d if isinstance(d, dict) else None
    except (OSError, ValueError):
        return None


def _registry_paths(jobs_dir: Path) -> dict:
    reg = _load(jobs_dir / "registry.json") or {}
    return {jid: (row or {}).get("path") for jid, row in reg.items()
            if isinstance(row, dict)}


def _emit(counter: dict, seen: set, source: str, event: str, job, page,
          before, after, context, ts, pdf_path, dry: bool) -> None:
    """Record one backfill event, deduped on its semantic payload. The
    volatile 'chain' feature enrichment is EXCLUDED from the key: a
    re-detect that changes the cached features must not make the same
    decision import twice."""
    ctx_key = {k: v for k, v in (context or {}).items() if k != "chain"}
    key = ledger.semantic_key(event, job, page, before, after, ctx_key)
    counter.setdefault(source, {"files": 0, "events": 0, "skipped": 0})
    if key in seen:
        counter[source]["skipped"] += 1
        return
    seen.add(key)
    counter[source]["events"] += 1
    if not dry:
        ledger.record(event, job, page, before, after, context,
                      ui_source="backfill", pdf_path=pdf_path, ts=ts,
                      dedupe_key=key)


def backfill(jobs_dir: Path, dry: bool = False) -> dict:
    seen = ledger.existing_dedupe_keys()
    paths = _registry_paths(jobs_dir)
    counter: dict = {}
    if not jobs_dir.is_dir():
        return {"error": f"jobs dir not found: {jobs_dir}", "sources": {}}

    for jd in sorted(p for p in jobs_dir.iterdir() if p.is_dir()):
        job = jd.name
        pdf = paths.get(job)

        # (a) calculator-input sidecars -> semantic events
        for f in sorted(jd.glob("p*_calcstate.json")):
            m = _PAGE_OF.match(f.name)
            blob = _load(f)
            if not m or blob is None:
                continue
            page = int(m.group(1))
            counter.setdefault("calcstate", {"files": 0, "events": 0,
                                             "skipped": 0})["files"] += 1
            feats = ledger.chain_feature_map(jd / f"p{page}_result.json")
            for e in ledger.calcstate_events({}, blob):
                ctx = dict(e.get("context") or {})
                cid = ctx.get("chain_id")
                if cid in feats:
                    ctx["chain"] = feats[cid]
                _emit(counter, seen, "calcstate", e["event"], job, page,
                      e.get("before"), e.get("after"), ctx,
                      _mtime(f), pdf, dry)

        # (b) reviewer scale picks
        for f in sorted(jd.glob("p*_scale.json")):
            m = _PAGE_OF.match(f.name)
            pick = _load(f)
            if not m or not pick or pick.get("ft_per_paper_inch") is None:
                continue
            page = int(m.group(1))
            counter.setdefault("scale_pick", {"files": 0, "events": 0,
                                              "skipped": 0})["files"] += 1
            # what the engine reads NOW, for comparison - the reading the
            # human actually overruled was not stored beside the pick
            res = _load(jd / f"p{page}_result.json") or {}
            eng = res.get("scale") or None
            _emit(counter, seen, "scale_pick", "scale_set", job, page,
                  None if not eng else {
                      "ft_per_paper_inch": eng.get("ft_per_paper_inch"),
                      "text": eng.get("text"),
                      "source": eng.get("source")},
                  dict(pick),
                  {"engine_reading_is_current_not_original": bool(eng)},
                  _mtime(f), pdf, dry)

        # (c) approved sheet exports
        for f in sorted(jd.glob("p*_elements.json")):
            m = _PAGE_OF.match(f.name)
            exp = _load(f)
            if not m or exp is None:
                continue
            page = int(m.group(1))
            counter.setdefault("elements", {"files": 0, "events": 0,
                                            "skipped": 0})["files"] += 1
            labels = sorted({(el.get("label") or "")
                             for el in exp.get("elements") or []
                             if isinstance(el, dict)})
            wa = {k: v for k, v in (exp.get("work_area") or {}).items()
                  if k != "zones"}
            _emit(counter, seen, "elements", "approve_export", job, page,
                  None,
                  {"n_elements": len(exp.get("elements") or []),
                   "items": exp.get("items"),
                   "overrides": exp.get("overrides"),
                   "scale": exp.get("scale"),
                   "work_area": wa or None},
                  {"source_pdf_name": exp.get("source"),
                   "labels": labels,
                   "image_dpi": exp.get("imageDpi")},
                  _mtime(f), pdf, dry)

    return {"jobs_dir": str(jobs_dir),
            "ledger_dir": str(ledger.ledger_dir()),
            "dry_run": dry,
            "sources": counter,
            "not_importable": {
                "review_ui_label_memory": "client-side only (browser "
                "localStorage, webui/app.js MEM_V); never persisted "
                "server-side"}}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--jobs-dir", default=None)
    ap.add_argument("--ledger-dir", default=None)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args(argv)
    if args.ledger_dir:
        os.environ["TAKEOFF_LEDGER_DIR"] = args.ledger_dir
    jobs = Path(args.jobs_dir or os.environ.get("TAKEOFF_JOBS_DIR")
                or (Path(__file__).resolve().parent.parent / "out" / "jobs"))
    report = backfill(jobs, dry=args.dry_run)
    print(json.dumps(report, indent=1))
    return 0 if "error" not in report else 1


if __name__ == "__main__":
    raise SystemExit(main())
