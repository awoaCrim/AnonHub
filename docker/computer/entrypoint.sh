#!/bin/sh
# Starts the desktop, the browser and the device client. The client pairs itself once with the
# one-time code the manager leaves at /run/computer/pair-code, then reconnects on every start.
set -u
STATE="$HOME/.local/state/yesimbot-device"
CLIENT=/opt/yesimbot-client/client.cjs
export XDG_RUNTIME_DIR=/tmp/xdg-bot
mkdir -p "$XDG_RUNTIME_DIR" "$HOME/workspaces" "$HOME/.config" && chmod 700 "$XDG_RUNTIME_DIR"

# Desktop: one virtual screen, a window manager, and the accessibility bus agent-desktop reads windows through.
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99
Xvfb :99 -screen 0 1600x1000x24 -nolisten tcp -ac &
for _ in $(seq 1 50); do [ -S /tmp/.X11-unix/X99 ] && break; sleep 0.1; done
eval "$(dbus-launch --sh-syntax)"
export DBUS_SESSION_BUS_ADDRESS
/usr/libexec/at-spi-bus-launcher --launch-immediately &
openbox &
# The client is the only remote ingress. No VNC port is published or bound to a bridge address.
(
  while true; do
    x11vnc -display :99 -listen 127.0.0.1 -rfbport 5900 -nopw -forever -shared -repeat -xkb -noxdamage \
      > /tmp/x11vnc.log 2>&1
    sleep 2
  done
) &

# The browser stays open; if it is closed or crashes it comes back with the same profile.
# The profile lives on the computer's disk and outlives the container: a lock left by the previous container
# (another hostname) would keep Chromium from starting, and only this container ever runs it.
rm -f "$HOME/.config/chromium/SingletonLock" "$HOME/.config/chromium/SingletonSocket" "$HOME/.config/chromium/SingletonCookie"
# Its accessibility tree stays off (no ACCESSIBILITY_ENABLED): once anything has read the tree, Debian's
# Chromium 156 crashes as soon as text is typed into the address bar. Pages are driven through the browser tool
# (DevTools); agent-desktop sees the window only on screenshots.
(
  while true; do
    chromium --no-sandbox --disable-dev-shm-usage --no-first-run --no-default-browser-check \
      --force-renderer-accessibility --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 \
      --user-data-dir="$HOME/.config/chromium" --window-position=0,0 --window-size=1600,1000 about:blank \
      > /tmp/chromium.log 2>&1
    sleep 2
  done
) &

node /opt/computer/write-config.mjs "$STATE" || exit 1

# First start: pair with the code the manager left; it is single-use and valid for five minutes.
if [ ! -f "$STATE/credential.json" ] && [ -s /run/computer/pair-code ]; then
  node "$CLIENT" pair --state "$STATE" --code "$(cat /run/computer/pair-code)" --name "${COMPUTER_NAME:-bot-computer}" || echo "pairing failed; the manager will issue a new code"
fi

# Exit code 75 means the client installed an update and wants to be restarted into it.
while true; do
  node "$CLIENT" run --state "$STATE"
  code=$?
  [ "$code" -eq 75 ] || sleep 5
done
