FROM node:24.14.0-bookworm-slim
ARG DEBIAN_MIRROR=http://deb.debian.org
RUN sed -i "s|http://deb.debian.org|${DEBIAN_MIRROR}|g" /etc/apt/sources.list.d/debian.sources \
 && apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=30 -o Acquire::ForceIPv4=true update \
 && apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=30 -o Acquire::ForceIPv4=true install -y --no-install-recommends chromium fonts-noto-cjk fonts-noto-color-emoji \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/html-renderer
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
 && mkdir /run/renderer \
 && chown node:node /run/renderer
COPY renderer.mjs server.mjs healthcheck.mjs ./
ENV CHROMIUM_PATH=/usr/bin/chromium RENDERER_SOCKET=/run/renderer/http.sock HOME=/tmp XDG_CONFIG_HOME=/tmp/config XDG_CACHE_HOME=/tmp/cache
USER node
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 CMD ["node", "healthcheck.mjs"]
CMD ["node", "server.mjs"]
