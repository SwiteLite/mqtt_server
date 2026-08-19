#!/bin/bash
# Déploiement sur BeagleBone — git pull + deps + PM2
#
# Usage (sur la BBB) :
#   ./deploy.sh
#   APP_DIR=/home/debian/mqtt_server ./deploy.sh

set -euo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "$0")" && pwd)}"
cd "$APP_DIR"

echo "==> Deploy mqtt_server in $APP_DIR"

echo "==> git pull"
git pull --ff-only

echo "==> npm install (production)"
npm install --omit=dev

if pm2 describe mqtt-broker >/dev/null 2>&1; then
  echo "==> pm2 restart"
  pm2 restart ecosystem.config.cjs
else
  echo "==> pm2 start (first run)"
  pm2 start ecosystem.config.cjs
  pm2 save
fi

echo "==> status"
pm2 status

echo "==> quick check"
curl -sf "http://127.0.0.1:${HTTP_PORT:-3000}/temperatures" | head -c 200 || true
echo
echo "Deploy OK — $(date -Iseconds)"
