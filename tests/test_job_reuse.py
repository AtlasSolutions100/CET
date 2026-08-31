"""An interrupted open must be RECLAIMED, not duplicated.

A job row records the source file's mtime. An open that dies before it
finishes leaves mtime None, and None never equals a real timestamp - so the
row could never be matched and every later open of the same file registered
another one. Measured on the development box before the fix: 420 registry
rows, 250 with a null mtime, including 63 rows for a single Belle Farms sheet.

This pins the reuse predicate itself, at the source, because the failure is
invisible at runtime: nothing errors, the app just quietly grows a new job
and orphans the cached detection sitting in the old one.
"""
import re
import sys
from pathlib import Path

SRC = (Path(__file__).parent.parent / "server.py").read_text(encoding="utf-8")
fails = []


def check(ok, msg):
    print(("ok: " if ok else "FAIL: ") + msg)
    if not ok:
        fails.append(msg)


# the predicate, as shipped
m = re.search(r'if \(j\.get\("path"\) == str\(path\)(.{0,240}?)\):', SRC, re.S)
check(bool(m), "the reuse predicate is where it was")
pred = m.group(1) if m else ""

check("owner" in pred, "owner is still part of the reuse key (two accounts, one file)")
check("_mt is None" in pred,
      "a null mtime is treated as reclaimable, not as a different file")
check("_mt == mtime" in pred,
      "a real mtime must still MATCH - a genuinely edited file is a new job")

# and the repair: a reclaimed row must stop being null, or it is reclaimed forever
after = SRC[m.end():m.end() + 400] if m else ""
check(re.search(r'if _mt is None:\s*\r?\n\s*j\["mtime"\] = mtime', after) is not None,
      "reclaiming REPAIRS the row's mtime instead of leaving it null")

# the predicate must not have become unconditional. `pred` is only the tail
# AFTER the path comparison (the regex above requires that comparison to match
# at all), so this asserts against the whole matched expression.
whole = m.group(0) if m else ""
check('j.get("path") == str(path)' in whole,
      "path equality is still required (reuse is not 'any job will do')")

print()
if fails:
    print(f"{len(fails)} FAILURE(S)")
    sys.exit(1)
print("all job-reuse checks passed")
