#!/bin/bash
# Start the takeoff detection service with local env (API keys etc.)
cd "$(dirname "$0")"
set -a; [ -f .env ] && source .env; set +a
# Tesseract (raster OCR): harness-launched shells can miss the user PATH
# entry, and ocr_words then fails silently ([]). Append it when present.
case ":$PATH:" in
  *"Tesseract-OCR"*) ;;
  *) [ -d "/c/Program Files/Tesseract-OCR" ] \
       && export PATH="$PATH:/c/Program Files/Tesseract-OCR" ;;
esac
# Prefer a local venv (Windows: .venv/Scripts, POSIX: .venv/bin), else PATH python3.
if [ -x .venv/Scripts/python.exe ]; then PY=.venv/Scripts/python.exe
elif [ -x .venv/bin/python ]; then PY=.venv/bin/python
else PY=python3; fi
exec "$PY" -m uvicorn server:app --port "${PORT:-8100}"
