#!/usr/bin/env bash
#
# Nightly Postgres backup. Installed as /usr/local/bin/leadsignal-backup-db and
# driven by leadsignal-backup.timer (see bootstrap-server.sh).
#
# pg_dump is run *inside* the Postgres container, so the client and server major
# versions always match — the single most common way a scripted dump breaks
# after an image bump.
set -euo pipefail

CONTAINER="${CONTAINER:-leadsignal_postgres_prod}"
ENV_FILE="${ENV_FILE:-/opt/leadsignal/env/deploy.env}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/leadsignal}"
RETAIN_DAYS="${RETAIN_DAYS:-14}"

# shellcheck disable=SC1090
set -a; . "$ENV_FILE"; set +a

docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null | grep -q true || {
    echo "[backup] $CONTAINER is not running — nothing to back up."
    exit 0
}

mkdir -p "$BACKUP_DIR"
stamp="$(date -u +%Y%m%d-%H%M%S)"
tmp="$BACKUP_DIR/.leadsignal-$stamp.sql.gz.partial"
out="$BACKUP_DIR/leadsignal-$stamp.sql.gz"

# Write to a .partial name first: a dump interrupted by a reboot must never be
# left behind looking like a valid restore point.
docker exec "$CONTAINER" pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --clean --if-exists \
    | gzip -9 > "$tmp"

# A gzip stream that does not decompress is not a backup.
gzip -t "$tmp"
mv "$tmp" "$out"
chmod 640 "$out"

find "$BACKUP_DIR" -name 'leadsignal-*.sql.gz' -mtime "+$RETAIN_DAYS" -delete
find "$BACKUP_DIR" -name '.leadsignal-*.partial' -mtime +1 -delete

echo "[backup] $out ($(du -h "$out" | cut -f1)), retaining ${RETAIN_DAYS}d"
