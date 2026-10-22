#!/usr/bin/env bash
# Build the site and upload it to the Contabo VM (ssh host alias "backoffice", user deploy).
# DEPLOY_DIR must match `root` in the nginx server block for nib.emuye.dev.
set -euo pipefail
cd "$(dirname "$0")"

DEPLOY_DIR="${DEPLOY_DIR:-/opt/nib}"
npm run build
# ClearAllForwardings: the backoffice alias forwards port 3200, which is not needed here.
rsync -az --delete -e "ssh -o ClearAllForwardings=yes" dist/ "backoffice:${DEPLOY_DIR}/"
echo "Deployed to ${DEPLOY_DIR}"
