#!/bin/sh
set -eu
umask 077
# The account's WeChat container (leave-koishi 6.7): the pinned agent-wechat daemon, alone, on the network the app
# container shares. Loopback only; the app container's init created the private data directory and the owner
# token in the mounted state before this starts, and the daemon refuses to run without them.
data="${KOISHI_STATE_DIR:-/var/lib/yesimbot}/data/agent-wechat"
export HOME="$data" TMPDIR=/tmp
# Chat contents stay out of the container log; startup failures (stderr) do not.
exec /usr/bin/tini -- /opt/agent-wechat/wx serve --listen 127.0.0.1:6174 --data-dir "$data" --token-file "$data/api-token" >/dev/null
