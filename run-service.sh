#!/bin/bash
# Start the takeoff detection service with local env (API keys etc.)
cd "$(dirname "$0")"
set -a; [ -f .env ] && source .env; set +a
# Prefer a local venv (Windows: .venv/Scripts, POSIX: .venv/bin), else PATH python3.
if [ -x .venv/Scripts/python.exe ]; then PY=.venv/Scripts/python.exe
elif [ -x .venv/bin/python ]; then PY=.venv/bin/python
else PY=python3; fi
exec "$PY" -m uvicorn server:app --port "${PORT:-8100}"
