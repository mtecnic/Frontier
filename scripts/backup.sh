#!/usr/bin/env bash
# Nightly full backup of the Frontier database, kept for 30 days.
#   scripts/backup.sh          pg_dump (custom format) into $BACKUP_DIR/daily
#   scripts/backup.sh --base   also take a pg_basebackup for point-in-time recovery with the WAL archive
# Reads DATABASE_URL from the environment or ./.env.
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ -z "${DATABASE_URL:-}" && -f .env ]]; then
  DATABASE_URL=$(grep -E '^DATABASE_URL=' .env | tail -1 | cut -d= -f2-)
fi
: "${DATABASE_URL:?Set DATABASE_URL or create .env}"
DEST=${BACKUP_DIR:-/var/backups/frontier}
KEEP_DAYS=${KEEP_DAYS:-30}
stamp=$(date -u +%Y%m%d-%H%M%S)

mkdir -p "$DEST/daily"
out="$DEST/daily/frontier-$stamp.dump"
pg_dump --format=custom --no-owner --file="$out.partial" "$DATABASE_URL"
mv "$out.partial" "$out"
echo "$(date -u +%FT%TZ) backup written: $out ($(du -h "$out" | cut -f1))"
find "$DEST/daily" -name 'frontier-*.dump' -mtime +"$KEEP_DAYS" -print -delete

if [[ "${1:-}" == "--base" ]]; then
  mkdir -p "$DEST/base"
  pg_basebackup --dbname="$DATABASE_URL" -D "$DEST/base/$stamp" -Ft -z -X none
  echo "base backup written: $DEST/base/$stamp"
  find "$DEST/base" -mindepth 1 -maxdepth 1 -type d -mtime +"$KEEP_DAYS" -print -exec rm -rf {} +
  # WAL older than the oldest kept base backup is no longer needed.
  oldest=$(ls -1 "$DEST/base" | sort | head -1)
  if [[ -n "$oldest" && -d "$DEST/wal" ]]; then
    label=$(tar -xzOf "$DEST/base/$oldest/base.tar.gz" backup_label 2>/dev/null | sed -n 's/^START WAL LOCATION: .* (file \(.*\))$/\1/p')
    [[ -n "$label" ]] && pg_archivecleanup "$DEST/wal" "$label" || true
  fi
fi
