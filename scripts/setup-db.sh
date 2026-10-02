#!/usr/bin/env bash
# Create the PostgreSQL role and database for Frontier. Run on the server as root (or a sudoer):
#   sudo scripts/setup-db.sh 'a-strong-password'
set -euo pipefail
PASS=${1:?usage: setup-db.sh PASSWORD}
DB=${DB_NAME:-frontier}
ROLE=${DB_ROLE:-frontier}
sudo -u postgres psql -v ON_ERROR_STOP=1 <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '$ROLE') THEN
    CREATE ROLE $ROLE LOGIN PASSWORD '$PASS' CREATEDB;
  END IF;
END \$\$;
SQL
sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname = '$DB'" | grep -q 1 || sudo -u postgres createdb -O "$ROLE" "$DB"
echo "Database ready. Put this in .env:"
echo "DATABASE_URL=postgres://$ROLE:$PASS@localhost:5432/$DB"
