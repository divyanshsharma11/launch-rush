#!/bin/sh
# Nightly data-only backup of the Supabase database; keeps 7 days.
# Run from this folder, e.g. cron: 0 2 * * * cd /opt/launch-rush && ./backup.sh
# Restore: run the migrations on an empty database, truncate the seeded tables, then pg_restore --data-only.
set -eu

dir="${BACKUP_DIR:-backups}"
file="launch_rush_$(date +%F).dump"
mkdir -p "$dir"

docker run --rm --user "$(id -u):$(id -g)" --env-file .env.prod \
  -e PGPORT=5432 -e PGSSLMODE=verify-ca -e PGSSLROOTCERT=/certs/ca.crt \
  -v "$PWD/certs/supabase-ca.crt:/certs/ca.crt:ro" -v "$PWD/$dir:/out" postgres:18 \
  pg_dump --no-owner --no-privileges --data-only -Fc -n public -n paysim -n erpsim \
  -T public.schema_migrations -f "/out/$file"

find "$dir" -name 'launch_rush_*.dump' -mtime +7 -delete
echo "backup written: $dir/$file"
