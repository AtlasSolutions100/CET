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
unset TAKEOFF_UI_PASSWORD
unset TAKEOFF_HOSTED
PY=./.venv/Scripts/python.exe
[ -x "$PY" ] || PY=python
echo "CORE takeoff DEV on :8128 - no login, working tree, $(git branch --show-current)"
exec "$PY" -m uvicorn server:app --port 8128 --log-level info
