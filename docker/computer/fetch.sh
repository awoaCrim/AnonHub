#!/bin/sh
# Puts the pinned device client (which carries agent-desktop) into vendor/ before `docker build`.
# It is checked against the published digests; nothing unverified enters the image.
# Usage: fetch.sh <site origin>
set -eu
SITE="${1:?site origin, e.g. https://yesimbot-koishi.uwoacrimson.com}"
here=$(cd "$(dirname "$0")" && pwd)
work="$here/vendor.tmp"
rm -rf "$work" && mkdir -p "$work/client"

# The client: the same signed portable release every other computer runs.
curl -fsSL "$SITE/downloads/client.json" -o "$work/client.json"
set -- $(python3 -c '
import json, sys
release = next(r for r in json.load(open(sys.argv[1]))["releases"] if r["platform"] == "portable")
print(release["url"], release["sha256"], release["version"])' "$work/client.json")
curl -fsSL "$SITE$1" -o "$work/client.zip"
echo "$2  $work/client.zip" | sha256sum -c -
unzip -q "$work/client.zip" -d "$work/client"
(cd "$work/client" && sha256sum -c SHA256SUMS --quiet)
echo "client $3"

[ -f "$work/client/agent-desktop-linux-x64" ] || { echo "this client release has no agent-desktop"; exit 1; }

rm -f "$work/client.zip" "$work/client.json"
rm -rf "$here/vendor" && mv "$work" "$here/vendor"
