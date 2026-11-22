#!/usr/bin/env bash
# Installs the nightly Numen database backup as a systemd timer (02:45, like the Compass one
# at 02:30), running deploy/backup.sh as the repo's owner. Safe to re-run. Needs sudo.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
OWNER=$(stat -c %U "$HERE")
HOME_DIR=$(getent passwd "$OWNER" | cut -d: -f6)

sudo tee /etc/systemd/system/numen-db-backup.service >/dev/null <<UNIT
[Unit]
Description=Numen PostgreSQL backup (verified pg_dump, 14-day retention)
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
User=$OWNER
Environment=HOME=$HOME_DIR
ExecStart=$HERE/backup.sh
Nice=10
IOSchedulingClass=best-effort
IOSchedulingPriority=7
TimeoutStartSec=30min
UNIT

sudo tee /etc/systemd/system/numen-db-backup.timer >/dev/null <<UNIT
[Unit]
Description=Nightly Numen PostgreSQL backup

[Timer]
OnCalendar=*-*-* 02:45:00
RandomizedDelaySec=5m
Persistent=true

[Install]
WantedBy=timers.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable --now numen-db-backup.timer
systemctl list-timers numen-db-backup.timer --no-pager
