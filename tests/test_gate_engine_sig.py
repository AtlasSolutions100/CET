"""The chain gate's fingerprint comparison (takeoff_engine.regress._check,
engine_sig branch). Dependency-free, like tests/test_gate.py, and separate
from it because that file builds summaries WITHOUT engine_sig on purpose -
the branch must stay silent for those and loud for a real run.

Why it exists (2026-09-02, N9): gate-baseline.json recorded no engine_sig
and _check never compared one, so a detection-code change that moved no
count on the ten gate sheets - an __init__.py patch aimed at a sheet outside
the corpus - moved engine_sig and PASSED.

    python tests/test_gate_engine_sig.py
"""

import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from takeoff_engine import regress  # noqa: E402
from test_gate import _summary  # noqa: E402


def _run(baseline, now):
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "gate-baseline.json"
        p.write_text(json.dumps(baseline), encoding="utf-8")
        old = regress.BASELINE
        regress.BASELINE = p
        try:
            return regress._check(now)
        finally:
            regress.BASELINE = old


def _with_sig(sig):
    s = _summary()
    s["engine_sig"] = sig
    return s


CASES = []


def case(fn):
    CASES.append(fn)
    return fn


@case
def test_same_sig_passes():
    assert _run(_with_sig("aaaaaaaaaaaaaaaa"), _with_sig("aaaaaaaaaaaaaaaa")) == 0


@case
def test_moved_sig_fails_with_identical_counts():
    assert _run(_with_sig("aaaaaaaaaaaaaaaa"), _with_sig("bbbbbbbbbbbbbbbb")) == 1


@case
def test_unpinned_baseline_fails():
    assert _run(_summary(), _with_sig("aaaaaaaaaaaaaaaa")) == 1


@case
def test_hand_built_summary_without_sig_is_not_compared():
    # tests/test_gate.py's contract: no engine_sig on either side, no verdict
    # from this branch
    assert _run(_summary(), _summary()) == 0


@case
def test_real_run_records_engine_sig_key():
    # the summary _run_corpus writes carries the key _check reads
    src = (Path(regress.__file__)).read_text(encoding="utf-8")
    assert '"engine_sig": engine_sig(),' in src


def main() -> int:
    bad = 0
    for fn in CASES:
        try:
            fn()
            print(f"ok   {fn.__name__}")
        except AssertionError as e:
            bad += 1
            print(f"FAIL {fn.__name__}: {e}")
    print(f"{len(CASES) - bad}/{len(CASES)} passed")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
