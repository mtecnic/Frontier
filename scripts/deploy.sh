#!/usr/bin/env bash
# Update a running install from git, rebuild, publish the client and restart the API.
#   WEB_ROOT=/var/www/frontier/public scripts/deploy.sh
# WEB_ROOT is the static folder your web server serves; leave it unset to serve public/ in place.
set -euo pipefail
cd "$(dirname "$0")/.."
git pull --ff-only
npm ci
npm run build
if [[ -n "${WEB_ROOT:-}" ]]; then
  mkdir -p "$WEB_ROOT"
  # Keep a customised config.js in the web root across deploys.
  rsync -a --delete --exclude config.js public/ "$WEB_ROOT/"
  [[ -f "$WEB_ROOT/config.js" ]] || cp public/config.js "$WEB_ROOT/config.js"
  echo "Client published to $WEB_ROOT"
fi
if systemctl list-unit-files frontier.service >/dev/null 2>&1; then
  sudo systemctl restart frontier
  echo "API restarted (migrations run automatically on start)"
fi
