"""The first test in this repository.

It tests the gate's comparison logic - `takeoff_engine.regress._check` - which
is now what every other change is measured against. If this is wrong, a
regression ships wearing a green tick.

Deliberately dependency-free. pytest is not installed here and is not in
requirements.txt, and adding it changes the Docker image; that is a call for a
human, not something to slip in. Plain asserts run everywhere:

    python tests/test_gate.py

It needs no plan corpus, which matters: the corpus lives OUTSIDE the checkout
(`../TakeoffPro AI`, real client drawings that should not be in a repo), so CI
can never run the ten-sheet gate. It can run this.

The load-bearing case is test_recall_drop_does_not_fail. Recall, coverage and
ink capture all clamp at 1.0, so tracing the same ink twice RAISES them - and
the repo's own before/after for the double-count at chain.py:860-937 shows
derived recall dropping 93.0 -> 91.6 when the duplicates are removed. If the
gate ever starts failing on recall, the double-count is pinned in place for
good. That test is the tripwire.
"""

import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from takeoff_engine import regress  # noqa: E402


def _summary(**over):
    """A minimal but structurally real gate summary."""
    s = {
        "corpus": "fast",
        "sheets": {
            "SheetA p0": {
                "chains": 100, "phantom": 2, "spikes": 1,
                "precision": {"solid": 0.9, "dash1": 0.8},
                "truth": {"C-ROAD": 0.95},
                "n_lost": 0, "n_misfiled": 1,
                "welded_frac": 0.01, "pickup_frac": 0.01,
            },
        },
        "aggregate": {
            "mean_truth_class_acc": 0.95, "phantom_total": 2,
            "spikes_total": 1, "n_lost": 0, "n_misfiled": 1,
            "welded_frac": 0.0187, "pickup_frac": 0.0173,
        },
        "soft": {
            "linework_coverage_any": 0.99, "linework_coverage_own": 0.92,
            "linework_raw_recall": 0.929, "symbol_coverage": 0.71,
            "annotation_coverage": 0.57,
        },
    }
    for k, v in over.items():
        if k in ("chains", "phantom", "spikes", "n_lost", "n_misfiled"):
            s["sheets"]["SheetA p0"][k] = v
        elif k == "truth":
            s["sheets"]["SheetA p0"]["truth"] = v
        elif k == "precision":
            s["sheets"]["SheetA p0"]["precision"] = v
        elif k in s["aggregate"]:
            s["aggregate"][k] = v
        elif k in s["soft"]:
            s["soft"][k] = v
        else:
            raise KeyError(k)
    return s


def _run(baseline, now):
    """_check(now) against `baseline`, with BASELINE pointed at a temp file."""
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "gate-baseline.json"
        if baseline is not None:
            p.write_text(json.dumps(baseline), encoding="utf-8")
        old = regress.BASELINE
        regress.BASELINE = p
        try:
            return regress._check(now)
        finally:
            regress.BASELINE = old


CASES = []


def case(fn):
    CASES.append(fn)
    return fn


@case
def test_identical_passes():
    assert _run(_summary(), _summary()) == 0


@case
def test_missing_baseline_fails():
    assert _run(None, _summary()) == 1


@case
def test_corpus_mismatch_fails():
    b = _summary()
    n = _summary()
    n["corpus"] = "full"
    assert _run(b, n) == 1


@case
def test_chain_count_change_fails_in_either_direction():
    assert _run(_summary(), _summary(chains=101)) == 1
    assert _run(_summary(), _summary(chains=99)) == 1


@case
def test_phantom_worse_fails_better_passes():
    assert _run(_summary(), _summary(phantom=3)) == 1
    assert _run(_summary(), _summary(phantom=1)) == 0


@case
def test_spikes_worse_fails():
    assert _run(_summary(), _summary(spikes=2)) == 1


@case
def test_truth_accuracy_drop_fails():
    assert _run(_summary(), _summary(truth={"C-ROAD": 0.90})) == 1


@case
def test_truth_accuracy_gain_passes():
    assert _run(_summary(), _summary(truth={"C-ROAD": 0.99})) == 0


@case
def test_truth_layer_disappearing_fails():
    assert _run(_summary(), _summary(truth={})) == 1


@case
def test_precision_drop_fails():
    assert _run(_summary(),
                _summary(precision={"solid": 0.5, "dash1": 0.8})) == 1


@case
def test_misfiled_growth_fails():
    assert _run(_summary(), _summary(n_misfiled=2)) == 1


@case
def test_over_capture_increase_fails():
    """More welded blank paper is unambiguously worse. It must fail."""
    assert _run(_summary(), _summary(welded_frac=0.0233)) == 1
    assert _run(_summary(), _summary(pickup_frac=0.0200)) == 1


@case
def test_over_capture_decrease_passes():
    """Removing a double-count must read as an improvement, not a regression."""
    assert _run(_summary(), _summary(welded_frac=0.0100)) == 0
    assert _run(_summary(), _summary(pickup_frac=0.0100)) == 0


@case
def test_recall_drop_does_not_fail():
    """THE load-bearing case.

    Recall clamps at 1.0, so duplicated ink raises it. Fixing the known
    double-count DROPS derived recall 93.0 -> 91.6. If this ever starts
    returning 1, the gate has begun pinning the double-count in place and
    every future fix to it will look like a regression.
    """
    assert _run(_summary(), _summary(linework_raw_recall=0.80)) == 0
    assert _run(_summary(), _summary(linework_coverage_own=0.80)) == 0
    assert _run(_summary(), _summary(linework_coverage_any=0.80)) == 0


@case
def test_a_real_regression_beats_a_simultaneous_improvement():
    """A genuine gain must not mask a loss in the same run."""
    n = _summary(phantom=3)
    n["sheets"]["SheetA p0"]["truth"] = {"C-ROAD": 0.99}   # better
    assert _run(_summary(), n) == 1


def main() -> int:
    failed = []
    for fn in CASES:
        try:
            fn()
        except AssertionError:
            failed.append(fn.__name__)
        except Exception as e:                      # noqa: BLE001
            failed.append(f"{fn.__name__} ({e.__class__.__name__}: {e})")
    print(f"\n{len(CASES) - len(failed)}/{len(CASES)} gate tests passed")
    for f in failed:
        print(f"  FAILED  {f}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
