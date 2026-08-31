"""Flatten the training ledger for model training. Stdlib only.

One output row per event. Nested dicts (before / after / context, and
anything inside them) are flattened with dotted keys - context.chain.class,
after.z, before.surface - so a CSV loads straight into a dataframe or a
labeling tool. Lists are JSON-encoded into their single cell.

Usage:
  python tools/ledger_export.py --format csv  [--event ew_row_edit]
                                [--ledger-dir DIR] [--out FILE]
  python tools/ledger_export.py --format jsonl --event chain_excluded

--out defaults to stdout. --event filters to one event type; omit it for
everything. Reading the ledger here is fine: this tool sits outside the
detection/calculation pipeline, which is the boundary the write-only
invariant draws (see takeoff_engine/ledger.py).
"""

import argparse
import csv
import io
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from takeoff_engine import ledger  # noqa: E402

# stable identity columns first, in ledger-schema order
_CORE = ("ts_iso", "event", "job", "pdf_sha1", "page_index", "engine_sig",
         "schema_version", "ui_source", "dedupe")


def flatten(obj, prefix: str = "", out: "dict | None" = None) -> dict:
    out = {} if out is None else out
    if isinstance(obj, dict):
        for k, v in obj.items():
            key = f"{prefix}{k}"
            if isinstance(v, dict):
                flatten(v, key + ".", out)
            elif isinstance(v, list):
                out[key] = json.dumps(v, ensure_ascii=False)
            else:
                out[key] = v
    return out


def rows(directory, event_filter=None):
    for e, _f in ledger.iter_events(directory):
        if event_filter and e.get("event") != event_filter:
            continue
        row = {k: e.get(k) for k in _CORE if k in e}
        for section in ("before", "after", "context"):
            v = e.get(section)
            if isinstance(v, dict):
                flatten(v, section + ".", row)
            elif isinstance(v, list):
                row[section] = json.dumps(v, ensure_ascii=False)
            elif v is not None:
                row[section] = v
        yield row


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--format", choices=("csv", "jsonl"), default="jsonl")
    ap.add_argument("--event", default=None)
    ap.add_argument("--ledger-dir", default=None)
    ap.add_argument("--out", default=None)
    args = ap.parse_args(argv)
    d = Path(args.ledger_dir) if args.ledger_dir else (
        Path(os.environ["TAKEOFF_LEDGER_DIR"])
        if os.environ.get("TAKEOFF_LEDGER_DIR") else None)

    all_rows = list(rows(d, args.event))
    if args.format == "jsonl":
        buf = io.StringIO()
        for r in all_rows:
            buf.write(json.dumps(r, ensure_ascii=False) + "\n")
        text = buf.getvalue()
    else:
        cols = [c for c in _CORE if any(c in r for r in all_rows)]
        extra = sorted({k for r in all_rows for k in r} - set(cols))
        cols += extra
        buf = io.StringIO()
        w = csv.DictWriter(buf, fieldnames=cols, extrasaction="ignore",
                           lineterminator="\n")
        w.writeheader()
        for r in all_rows:
            w.writerow(r)
        text = buf.getvalue()

    if args.out:
        Path(args.out).write_text(text, encoding="utf-8", newline="\n")
        print(f"{len(all_rows)} events -> {args.out}", file=sys.stderr)
    else:
        sys.stdout.write(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
