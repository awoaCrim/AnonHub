# A friend's bot's own computer: a Linux desktop (Xvfb + Openbox), Chromium, a shell and files,
# driven by the YesImBot device client that pairs itself on first start.
# Build context: this directory after `fetch.sh` has put the pinned client in vendor/. The desktop driver,
# agent-desktop, ships inside the client package and updates with it.
FROM node:24.14.0-trixie-slim
# Optional Debian mirror host for slow links, e.g. mirrors.tuna.tsinghua.edu.cn.
ARG APT_MIRROR=

RUN if [ -n "$APT_MIRROR" ]; then sed -i "s|deb.debian.org|$APT_MIRROR|g" /etc/apt/sources.list.d/debian.sources; fi \
 && apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      tini ca-certificates curl unzip xz-utils git python3 procps less nano \
      xvfb xauth openbox x11-utils x11vnc dbus dbus-x11 at-spi2-core \
      chromium fonts-noto-cjk fonts-noto-color-emoji fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/*

# The node image's own user (uid 1000) becomes the bot; its home is the computer's disk.
RUN usermod -l bot -d /home/bot -m node && groupmod -n bot node

COPY vendor/client /opt/yesimbot-client
COPY entrypoint.sh write-config.mjs /opt/computer/
RUN chmod 0755 /opt/computer/entrypoint.sh /opt/yesimbot-client/agent-desktop-linux-x64 /opt/yesimbot-client/agent-desktop-linux-clipboard-owner \
 && /opt/yesimbot-client/agent-desktop-linux-x64 version \
 && node /opt/yesimbot-client/client.cjs version

USER bot
WORKDIR /home/bot
ENV HOME=/home/bot DISPLAY=:99 LANG=C.UTF-8 TZ=Asia/Shanghai
ENTRYPOINT ["/usr/bin/tini", "--", "/opt/computer/entrypoint.sh"]
