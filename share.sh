#!/bin/bash
# Put the review UI on the internet, password-protected, for a remote demo.
# Prints a https://....trycloudflare.com URL - send it to whoever is testing.
# Password = TAKEOFF_UI_PASSWORD in .env (any username works).
cd "$(dirname "$0")"
command -v cloudflared >/dev/null 2>&1 || brew install cloudflared
if ! lsof -ti :8100 >/dev/null 2>&1; then
  nohup ./run-service.sh > /tmp/detect-svc.log 2>&1 &
  sleep 3
fi
echo ""
echo "=== Review UI is live locally on http://localhost:8100 ==="
echo "=== Creating public link (leave this window open)...   ==="
echo ""
exec cloudflared tunnel --url http://localhost:8100
