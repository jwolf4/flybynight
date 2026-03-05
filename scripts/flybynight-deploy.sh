#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="/opt/flybynight"
WEB_ROOT="/var/www/flybynight"
SITES_AVAILABLE="/etc/nginx/sites-available"
SITE_NAME="flybynight"

# Ensure repo exists
if [ ! -d "$REPO_DIR/.git" ]; then
  sudo mkdir -p "$REPO_DIR"
  sudo chown -R "$USER":"$USER" "$REPO_DIR"
  git clone https://github.com/jwolf4/flybynight.git "$REPO_DIR"
fi

cd "$REPO_DIR"
git fetch origin
git reset --hard origin/master

# Deploy only the web files (adjust if you add server code later)
sudo mkdir -p "$WEB_ROOT"
sudo rsync -av --delete \
  --exclude ".git" \
  --exclude ".github" \
  "$REPO_DIR"/ "$WEB_ROOT"/

# Static-safe perms
sudo chown -R www-data:www-data "$WEB_ROOT"
sudo find "$WEB_ROOT" -type d -exec chmod 755 {} \;
sudo find "$WEB_ROOT" -type f -exec chmod 644 {} \;

# Find nginx site file in repo (expects exactly one match, or named flybynight*)
SITE_CANDIDATES=()
while IFS= read -r -d '' f; do
  SITE_CANDIDATES+=("$f")
done < <(find "$REPO_DIR/conf/sites" -maxdepth 1 -type f \( -name "flybynight" -o -name "flybynight*" \) -print0)

if [ "${#SITE_CANDIDATES[@]}" -eq 0 ]; then
  echo "ERROR: No nginx site file found under $REPO_DIR/conf/sites"
  echo "       Files present:"
  ls -ալ "$REPO_DIR/conf/sites" || true
  exit 1
elif [ "${#SITE_CANDIDATES[@]}" -gt 1 ]; then
  echo "ERROR: Multiple nginx site candidates found:"
  printf '  - %s\n' "${SITE_CANDIDATES[@]}"
  echo "Pick one and hardcode it in the deploy script."
  exit 1
fi

NGINX_SITE_SRC="${SITE_CANDIDATES[0]}"
sudo install -m 644 "$NGINX_SITE_SRC" "$SITES_AVAILABLE/$SITE_NAME"

sudo nginx -t
sudo systemctl reload nginx

# Ensure compose runs from repo root explicitly
sudo docker compose -f "$REPO_DIR/docker-compose.yml" up -d