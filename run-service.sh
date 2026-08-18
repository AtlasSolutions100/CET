#!/bin/bash
# Start the takeoff detection service with local env (API keys etc.)
cd "$(dirname "$0")"
set -a; [ -f .env ] && source .env; set +a
exec python3 -m uvicorn server:app --port "${PORT:-8100}"
