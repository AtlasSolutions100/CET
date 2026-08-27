#!/usr/bin/env bash
# Dev instance for working on the engine. Separate from run-service.sh on
# purpose:
#
#   * port 8128, so it never collides with the :8100 instance
#   * NO auth - TAKEOFF_UI_PASSWORD and TAKEOFF_HOSTED are cleared, so there is
#     no login page in the way while iterating. Never expose this port.
#   * serves the working tree, so an edit to webui/ is one refresh away
#
# Started through .claude/launch.json rather than a backgrounded shell command:
# a dev server launched as a child of a one-off shell call is not supervised
# and gets reaped, which is what kept killing this one.
set -e
cd "$(dirname "$0")"
export PATH="$PATH:/c/Program Files/Tesseract-OCR"
export PYTHONIOENCODING=utf-8
export PYTHONUNBUFFERED=1
export PYTHONFAULTHANDLER=1          # a native crash prints a stack, not silence

# The job store lives OUTSIDE OneDrive, deliberately.
#
# It held 1.3 GB across 1,481 files inside the synced tree, and every
# detection writes a ~700 KB result plus page renders. OneDrive opens each
# one to upload it while the service still has it open, which is a Windows
# sharing violation - the "another app is using this file" errors, and the
# freeze that took the machine out once already. Same reasoning that put
# Postgres in C:/Users/kobys/takeoff-pg.
export TAKEOFF_JOBS_DIR="${TAKEOFF_JOBS_DIR:-C:/Users/kobys/takeoff-jobs}"

# Client plan sets pulled off the box for development live OUTSIDE OneDrive,
# for the same reason the job store does - and because a customer's drawings
# should not be syncing into a personal cloud account by default. Setting this
# REPLACES the defaults, so the sample corpus and client_meet are re-listed
# here rather than lost.
export TAKEOFF_PLAN_ROOTS="${TAKEOFF_PLAN_ROOTS:-../TakeoffPro AI;../client_meet;C:/Users/kobys/takeoff-plans;C:/Users/kobys/takeoff-jobs}"
unset TAKEOFF_UI_PASSWORD
unset TAKEOFF_HOSTED
PY=./.venv/Scripts/python.exe
[ -x "$PY" ] || PY=python
echo "CORE takeoff DEV on :8128 - no login, working tree, $(git branch --show-current)"
exec "$PY" -m uvicorn server:app --port 8128 --log-level info
