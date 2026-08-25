#!/bin/sh
# Refuse to start a reachable box without a password.
#
# share.sh already refuses to open a tunnel without TAKEOFF_UI_PASSWORD. A
# container is the same exposure with less ceremony, so it gets the same guard:
# the failure mode this prevents is a box holding clients' live bid documents,
# answering 200 to anyone who finds the address. A missing password must be a
# refusal to boot, not a warning in a log nobody reads.
set -e

# EITHER real accounts OR a site password. Once per-user logins exist,
# TAKEOFF_UI_PASSWORD is dead weight and gets deleted from .env - refusing to
# boot without it at that point would be refusing to boot a correctly
# configured box. What must never happen is BOTH being absent, because the app
# then has nobody to authenticate and this container is on the public internet.
: "${TAKEOFF_JOBS_DIR:=/data/jobs}"
_USERS_FILE="${TAKEOFF_JOBS_DIR}/users.json"
_HAVE_ACCOUNTS=0
if [ -s "${_USERS_FILE}" ] && grep -q '"algo"' "${_USERS_FILE}" 2>/dev/null; then
  _HAVE_ACCOUNTS=1
fi

if [ -z "${TAKEOFF_UI_PASSWORD}" ] && [ "${_HAVE_ACCOUNTS}" -eq 0 ]; then
  echo "!! Refusing to start: no way to sign in." >&2
  echo "   This container is reachable and holds client plan sets." >&2
  echo "   Either set TAKEOFF_UI_PASSWORD, or create an account first:" >&2
  echo "     docker compose run --rm app python -m takeoff_engine.users add you@example.com" >&2
  exit 1
fi

if [ -n "${TAKEOFF_UI_PASSWORD}" ] && [ "${#TAKEOFF_UI_PASSWORD}" -lt 8 ]; then
  echo "!! Refusing to start: TAKEOFF_UI_PASSWORD is shorter than 8 characters." >&2
  exit 1
fi

if [ "${_HAVE_ACCOUNTS}" -eq 1 ]; then
  echo "CORE takeoff: per-user logins active ($(grep -c '"algo"' "${_USERS_FILE}") account(s))"
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
