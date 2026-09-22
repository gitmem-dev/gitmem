#!/usr/bin/env bash
# GIT-83: put the disposable venue on a given schema, for the release gate.
#
#   scripts/venue-schema.sh reset-to <setup.sql>   drop gitmem objects, then apply <setup.sql>
#   scripts/venue-schema.sh apply    <setup.sql>   apply <setup.sql> on top (re-applicability)
#   add --dry-run to print what would run and exit
#
# Needs VENUE_REF and VENUE_DB_URL (a postgres:// URL for the venue only).
# Refuses production, and any URL that does not name VENUE_REF, before
# connecting. Uses psql with ON_ERROR_STOP, in one transaction per call.
set -euo pipefail

DENY_REFS="cjptxyezuxdiinufgrrm"   # production GitMem — never touch
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RESET_SQL="$HERE/../tests/e2e/venue/reset-gitmem-objects.sql"

die() { echo "[venue-schema] $*" >&2; exit 2; }

mode="${1:-}"; sql="${2:-}"; dry=false
[ "${3:-}" = "--dry-run" ] && dry=true
case "$mode" in reset-to|apply) ;; *) die "usage: venue-schema.sh reset-to|apply <setup.sql> [--dry-run]" ;; esac
[ -n "$sql" ] && [ -f "$sql" ] || die "schema file not found: ${sql:-<none>}"
[ -n "${VENUE_REF:-}" ] || die "VENUE_REF is not set"
[ -n "${VENUE_DB_URL:-}" ] || die "VENUE_DB_URL is not set"
for d in $DENY_REFS; do
  [ "$VENUE_REF" != "$d" ] || die "refusing: VENUE_REF is production ($d)"
  case "$VENUE_DB_URL" in *"$d"*) die "refusing: VENUE_DB_URL names production ($d)" ;; esac
done
case "$VENUE_DB_URL" in
  postgres://*|postgresql://*) ;;
  *) die "refusing: VENUE_DB_URL is not a postgres:// URL" ;;
esac
case "$VENUE_DB_URL" in *"$VENUE_REF"*) ;; *) die "refusing: VENUE_DB_URL does not name the venue ($VENUE_REF)" ;; esac

files=()
[ "$mode" = "reset-to" ] && files+=("$RESET_SQL")
files+=("$sql")
if $dry; then
  echo "[venue-schema] would apply to venue $VENUE_REF, one transaction: ${files[*]}"
  exit 0
fi
command -v psql >/dev/null || die "psql not found"
args=()
for f in "${files[@]}"; do args+=(-f "$f"); done
# NOTIFY is delivered at commit: PostgREST reloads its schema cache before the driver runs.
PGCONNECT_TIMEOUT=20 psql "$VENUE_DB_URL" -X -q -v ON_ERROR_STOP=1 --single-transaction "${args[@]}" \
  -c "NOTIFY pgrst, 'reload schema'"
echo "[venue-schema] venue $VENUE_REF: $mode $(basename "$sql") OK"
