#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
    printf '%s\n' 'Run this installer with sudo on the Linux host.' >&2
    exit 1
fi

for dependency in smartctl systemctl systemd-sysusers; do
    if ! command -v "$dependency" >/dev/null 2>&1; then
        printf 'Required command not found: %s\n' "$dependency" >&2
        exit 1
    fi
done
/usr/bin/python3 -c 'import sqlite3, sys; sys.exit(sys.version_info < (3, 10))'
systemctl show-environment >/dev/null

project=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
target=/usr/local/lib/diskwatch
install -d -m 0755 "$target" "$target/web" /etc/sysusers.d
install -m 0644 "$project/diskwatch.py" "$target/diskwatch.py"
for asset in index.html app.css app.js theme.js; do
    install -m 0644 "$project/web/$asset" "$target/web/$asset"
done
install -m 0644 "$project/systemd/diskwatch.conf" /etc/sysusers.d/diskwatch.conf
systemd-sysusers /etc/sysusers.d/diskwatch.conf
for unit in diskwatch-collector.service diskwatch-collector.timer diskwatch-web.service; do
    install -m 0644 "$project/systemd/$unit" "/etc/systemd/system/$unit"
done

systemctl daemon-reload
systemctl start diskwatch-collector.service
systemctl enable --now diskwatch-collector.timer
systemctl enable diskwatch-web.service
systemctl restart diskwatch-web.service
printf '%s\n' 'Diskwatch dashboard: http://127.0.0.1:8765/'
