#!/bin/sh
set -eu
umask 077
# Chat connectors are optional; a workspace/WeChat runtime does not start QQ. The app image has neither: NapCat and
# agent-wechat run in the account's own containers on this container's network.
if [ "${YESIMBOT_IMAGE:-}" = app ]; then
  export NAPCAT_AUTOSTART=false WECHAT_AUTOSTART=false
elif [ -n "${QQ_ACCOUNT:-}" ]; then
  export NAPCAT_AUTOSTART=true WECHAT_AUTOSTART=true
else
  export NAPCAT_AUTOSTART=false WECHAT_AUTOSTART=true
fi
export QQ_ACCOUNT="${QQ_ACCOUNT:-}"
node /opt/yesimbot/docker/init.mjs
exec /usr/bin/tini -- /usr/bin/supervisord -c /opt/yesimbot/docker/supervisord.conf
