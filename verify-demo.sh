#!/usr/bin/env bash
# Throwaway instance for verifying the DEMO PLANS behaviour, on :8137 so it
# collides with neither run-service.sh (:8100) nor run-dev.sh (:8128).
#
# Its job store defaults to a SCRATCH directory, not the real one: the demo
# fresh-open deletes everything derived from a plan, and a verification run
# must not sweep the box's actual caches. Seed the scratch dir with a COPY of
# the real registry.json if you want the "this box holds 15 jobs for one demo"
# starting condition:
#
#   cp "$TAKEOFF_JOBS_DIR_REAL/registry.json" out/verify-jobs/registry.json
#   bash verify-demo.sh &
#   .venv/Scripts/python.exe tools/verify_demo_fresh.py \
#       http://localhost:8137 out/verify/<date>/demo-fresh \
#       out/verify-jobs/registry.json
set -e
cd "$(dirname "$0")"
export PATH="$PATH:/c/Program Files/Tesseract-OCR"
export PYTHONIOENCODING=utf-8
export PYTHONUNBUFFERED=1
export TAKEOFF_JOBS_DIR="${TAKEOFF_JOBS_DIR:-$PWD/out/verify-jobs}"
mkdir -p "$TAKEOFF_JOBS_DIR"

# ABSOLUTE, unlike run-dev.sh's relative roots. This is run from worktrees as
# well as from the main checkout, and "../TakeoffPro AI" resolves to nothing
# three directories down - which is worth knowing, because it is exactly the
# unseeded-box condition the demo cards have to degrade honestly under.
CORPUS="${TAKEOFF_CORPUS:-$(cd .. 2>/dev/null && pwd)/TakeoffPro AI}"
export TAKEOFF_PLAN_ROOTS="${TAKEOFF_PLAN_ROOTS:-$CORPUS;$TAKEOFF_JOBS_DIR}"
unset TAKEOFF_UI_PASSWORD
unset TAKEOFF_HOSTED
PY=./.venv/Scripts/python.exe
[ -x "$PY" ] || PY=../../../.venv/Scripts/python.exe
[ -x "$PY" ] || PY=python
echo "demo verification instance on :8137"
echo "  jobs  $TAKEOFF_JOBS_DIR"
echo "  plans $TAKEOFF_PLAN_ROOTS"
exec "$PY" -m uvicorn server:app --port 8137 --log-level info
