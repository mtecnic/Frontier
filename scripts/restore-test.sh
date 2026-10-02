#!/usr/bin/env bash
# Monthly restore drill: load the newest backup into a scratch database, check it, drop it.
# Needs a role that may CREATE DATABASE (the frontier role created by scripts/setup-db.sh can).
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ -z "${DATABASE_URL:-}" && -f .env ]]; then
  DATABASE_URL=$(grep -E '^DATABASE_URL=' .env | tail -1 | cut -d= -f2-)
fi
: "${DATABASE_URL:?Set DATABASE_URL or create .env}"
DEST=${BACKUP_DIR:-/var/backups/frontier}
latest=$(ls -1t "$DEST"/daily/frontier-*.dump 2>/dev/null | head -1 || true)
[[ -n "$latest" ]] || { echo "No backups in $DEST/daily"; exit 1; }

scratch="frontier_restore_test_$(date +%s)"
base_url="${DATABASE_URL%/*}"
admin_url="$base_url/postgres"
cleanup() { psql "$admin_url" -qc "DROP DATABASE IF EXISTS $scratch" >/dev/null 2>&1 || true; }
trap cleanup EXIT

psql "$admin_url" -qc "CREATE DATABASE $scratch"
pg_restore --no-owner --dbname="$base_url/$scratch" "$latest"
read -r users parcels mismatches < <(psql "$base_url/$scratch" -Atqc "
  SELECT (SELECT count(*) FROM users), (SELECT count(*) FROM parcels),
         (SELECT count(*) FROM users u LEFT JOIN (SELECT user_id, sum(amount_cents) t FROM ledger GROUP BY user_id) l
            ON l.user_id = u.id WHERE u.cash_cents <> coalesce(l.t, 0))" | tr '|' ' ')
echo "$(date -u +%FT%TZ) restore test of $(basename "$latest"): $users users, $parcels parcels, $mismatches ledger mismatches"
[[ "$mismatches" == "0" ]] || { echo "LEDGER MISMATCH in restored backup"; exit 2; }
