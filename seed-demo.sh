#!/usr/bin/env bash
# Pre-warm a hosted box with the demo plan sets, so the boss never opens a
# meeting on a cold detect.
#
#   ./seed-demo.sh https://core.workoptional.studio
#   TAKEOFF_UI_PASSWORD=... ./seed-demo.sh https://core.workoptional.studio   # unattended
#
# RUN THIS AFTER ANY DEPLOY THAT CHANGED takeoff_engine/. A cached result
# stores the engine signature it was produced by, and server.py:_result_stale
# marks it stale when that signature moves - correctly, because serving a
# number the current engine would not produce is how a wrong figure reaches a
# bid. The volume keeps the files across a deploy; it cannot keep them VALID
# across an engine change. A UI-only or server-only deploy needs no re-seed.
#
# Runs from a machine that HAS the plan corpus - it uploads from here to there.
# Safe to re-run: uploads are content-addressed, and detect returns
# {"status":"done"} without recomputing when a fresh result already exists.
set -u

HOST="${1:-}"
if [ -z "$HOST" ]; then
  echo "usage: $0 https://host   (or http://127.0.0.1:8100 for a local box)" >&2
  exit 2
fi
HOST="${HOST%/}"

PW="${TAKEOFF_UI_PASSWORD:-}"
if [ -z "$PW" ]; then
  printf 'site password for %s: ' "$HOST" >&2
  read -rs PW; echo >&2
fi
[ -z "$PW" ] && { echo "no password given" >&2; exit 2; }

# Self-signed/local certs: only skip verification for a loopback target.
K=""
case "$HOST" in https://localhost*|https://127.0.0.1*) K="-k";; esac
CURL=(curl -sS $K -u "x:$PW" --max-time 1800)

# The corpus lives beside the repo, not in it.
cd "$(dirname "$0")/.." || exit 1

# WHICH PAGES AND WHY.
#   gate  - a page takeoff_engine/regress.py measures every run, so its
#           numbers are the ones we have evidence for.
#   asked - Koby named the set for client demos on 2026-08-25.
# Klayton's fiber set is deliberately absent: he said on the call he is under
# NDA and technically in breach sharing it. Do not add it.
SETS=(
  "TakeoffPro AI/Plans/C4.0-SITE-GRADING-PLAN-Rev.1.pdf|0|gate: 1429 chains, the densest sheet we score"
  "TakeoffPro AI/Plans/C8.0-STORM-LAYOUT-Rev.1.pdf|0|gate"
  "TakeoffPro AI/Plans/C3.0-Site-Plan-Rev.1.pdf|0|gate"
  "TakeoffPro AI/Plans/C9.0-ROAD-LAYOUT-Rev.1.pdf|0|gate"
  "TakeoffPro AI/Plans/Belle Farms Structural Plans.pdf|0|gate + asked"
  "TakeoffPro AI/Plans/Belle Farms Upper Parcel ROAD GRADING 1 of 2.pdf|0|asked (heavy topo)"
  "TakeoffPro AI/Plans/Belle Farms Upper Parcel ROAD GRADING 2 of 2.pdf|0|asked (heavy topo)"
  "TakeoffPro AI/Plans/C10.4-TYPICAL-ROAD-SECTIONS-Rev.1.pdf|0|asked"
  "TakeoffPro AI/Oncor Cloudcrest Substation Civils - 20251212.pdf_safe.pdf|2 3|gate + asked"
  "client_meet/beaumont/SWR_Guide_Residence_-_Civil_5.8.26.pdf|2 3|gate (p3 = printed C3.0, 55 layers)"
  "client_meet/beaumont/SWR_Barn_Residence_-_Landscaping_4.7.26.pdf|5 6 11|gate (p5 = L200, 115 layers)"
  "client_meet/beaumont/SWR_Barn_Residence_-_Civil_4.7.26.pdf|6 13 14|gate + asked"
  "client_meet/beaumont/SWR_Barn_Residence_-_Structural_4.7.26.pdf|3|gate + asked"
  "client_meet/beaumont/260603 Thielen Biggerstaff Residence.pdf|10|gate"
)

# Fail before uploading anything rather than half way through.
miss=0
for row in "${SETS[@]}"; do
  f="${row%%|*}"
  [ -f "$f" ] || { echo "MISSING: $f" >&2; miss=1; }
done
[ "$miss" -eq 1 ] && { echo "corpus incomplete - nothing uploaded" >&2; exit 1; }

if ! "${CURL[@]}" -o /dev/null -w '' "$HOST/api/config" 2>/dev/null; then
  echo "cannot reach $HOST (or the password is wrong)" >&2; exit 1
fi
echo "seeding $HOST"
echo

ok=0; bad=0; t_all=$(date +%s)
for row in "${SETS[@]}"; do
  f="${row%%|*}"; rest="${row#*|}"; pages="${rest%%|*}"; why="${rest#*|}"
  name="$(basename "$f")"
  printf '%s\n  %s\n' "$name" "$why"

  up="$("${CURL[@]}" -F "file=@$f" "$HOST/api/upload")"
  job="$(printf '%s' "$up" | sed -n 's/.*"job_id":"\([^"]*\)".*/\1/p')"
  if [ -z "$job" ]; then
    printf '  UPLOAD FAILED: %s\n\n' "$(printf '%s' "$up" | head -c 160)"; bad=$((bad+1)); continue
  fi

  # Queue every page of this document at once - the box has multiple workers
  # and the server queues the overflow itself.
  for p in $pages; do
    "${CURL[@]}" -o /dev/null -X POST "$HOST/api/job/$job/page/$p/detect"
  done

  for p in $pages; do
    t0=$(date +%s); st=""
    while [ $(( $(date +%s) - t0 )) -lt 1500 ]; do
      st="$("${CURL[@]}" "$HOST/api/job/$job/page/$p/status" | sed -n 's/.*"status":"\([^"]*\)".*/\1/p')"
      case "$st" in done) break;; idle|error) break;; esac
      sleep 5
    done
    el=$(( $(date +%s) - t0 ))
    if [ "$st" = "done" ]; then
      printf '  page %-3s done in %4ds\n' "$p" "$el"; ok=$((ok+1))
    else
      printf '  page %-3s FAILED (%s) after %ds\n' "$p" "${st:-no-reply}" "$el"; bad=$((bad+1))
    fi
  done
  echo
done

printf 'seeded %d page(s), %d failed, %ds total\n' "$ok" "$bad" "$(( $(date +%s) - t_all ))"
[ "$bad" -eq 0 ] || exit 1
