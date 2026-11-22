#!/usr/bin/env bash
# Nightly backup of the Numen database: agents, knowledge bases and their documents, users,
# settings, call logs. Writes a custom-format pg_dump to $BACKUP_DIR, checks it can be read
# back, and keeps the last $KEEP_DAYS days. Run by numen-db-backup.timer (install-backup.sh).
#
# Restore (into the running stack; replaces what's there):
#   docker compose -f ~/numen/deploy/docker-compose.yml exec -T db \
#     pg_restore -U numen -d numen --clean --if-exists < ~/numen-backups/numen-YYYYMMDD-HHMMSS.dump
set -euo pipefail

REPO=${REPO:-$HOME/numen}
BACKUP_DIR=${BACKUP_DIR:-$HOME/numen-backups}
KEEP_DAYS=${KEEP_DAYS:-14}
COMPOSE=(docker compose -f "$REPO/deploy/docker-compose.yml")

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
stamp=$(date +%Y%m%d-%H%M%S)
out="$BACKUP_DIR/numen-$stamp.dump"
tmp="$out.partial"
trap 'rm -f "$tmp"' EXIT

"${COMPOSE[@]}" exec -T db pg_dump -U numen -d numen -Fc > "$tmp"

# Check: non-empty and readable, with the main tables in it.
size=$(stat -c %s "$tmp")
[ "$size" -gt 1024 ] || { echo "backup too small ($size bytes)" >&2; exit 1; }
listing=$("${COMPOSE[@]}" exec -T db pg_restore --list < "$tmp")
for table in agents knowledge_bases phone_numbers calls users kb_documents; do
  grep -q "TABLE DATA public $table " <<<"$listing" || { echo "backup is missing table $table" >&2; exit 1; }
done

chmod 600 "$tmp"
mv "$tmp" "$out"
find "$BACKUP_DIR" -name 'numen-*.dump' -mtime +"$KEEP_DAYS" -delete
echo "backup ok: $out ($size bytes); $(ls "$BACKUP_DIR"/numen-*.dump | wc -l) kept"
