#!/bin/sh
set -eu
exec /usr/local/bin/node /opt/yesimbot/apps/server/dist/main.js --state "${KOISHI_STATE_DIR:-/var/lib/yesimbot}"
