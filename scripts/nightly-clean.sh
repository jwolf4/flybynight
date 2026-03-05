
#!/usr/bin/env sh
set -eu

echo "[cleanup] $(date) wiping redis and media"

redis-cli -h redis --scan --pattern "fbn:*" | xargs redis-cli -h redis del
rm -rf /media/* || true

echo "[cleanup] done"