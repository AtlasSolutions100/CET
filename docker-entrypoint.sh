#!/bin/sh
# Refuse to start a reachable box without a password.
#
# share.sh already refuses to open a tunnel without TAKEOFF_UI_PASSWORD. A
# container is the same exposure with less ceremony, so it gets the same guard:
# the failure mode this prevents is a box holding clients' live bid documents,
# answering 200 to anyone who finds the address. A missing password must be a
# refusal to boot, not a warning in a log nobody reads.
set -e

if [ -z "${TAKEOFF_UI_PASSWORD}" ]; then
  echo "!! Refusing to start: TAKEOFF_UI_PASSWORD is not set." >&2
  echo "   This container is reachable and holds client plan sets." >&2
  echo "   Set it in the environment (compose reads it from .env)." >&2
  exit 1
fi

if [ "${#TAKEOFF_UI_PASSWORD}" -lt 8 ]; then
  echo "!! Refusing to start: TAKEOFF_UI_PASSWORD is shorter than 8 characters." >&2
  exit 1
fi

# The job store must be writable, or every detection fails one page at a time
# with an error the operator cannot act on.
: "${TAKEOFF_JOBS_DIR:=/data/jobs}"
mkdir -p "$TAKEOFF_JOBS_DIR"
if [ ! -w "$TAKEOFF_JOBS_DIR" ]; then
  echo "!! Refusing to start: $TAKEOFF_JOBS_DIR is not writable." >&2
  echo "   Check the volume mount and its ownership." >&2
  exit 1
fi

echo "CORE takeoff: hosted=${TAKEOFF_HOSTED:-0} workers=${TAKEOFF_WORKERS:-?}" \
     "jobs=${TAKEOFF_JOBS_DIR} budget=${TAKEOFF_PAGE_BUDGET_S:-?}s"

exec "$@"
