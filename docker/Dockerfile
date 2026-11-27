# The tested upstream digest contains amd64 QQ binaries only.
ARG NAPCAT_IMAGE=mlikiowa/napcat-docker@sha256:d00a30e32f76d59a6c7de6b62985defb36b8889a7deaf1fb024170b8955298b6
FROM node:24.14.0-bookworm-slim AS node-runtime

FROM ${NAPCAT_IMAGE} AS runtime-base
USER root
# The pinned image force-configures QQ with xdg-utils missing. Repair that
# existing graph alone: --fix-broken with new tools does not resolve their
# transitive dependencies. Then install tools normally; never remove QQ.
# FFmpeg: agent-wechat prepares WeChat voice, video and some image previews with it.
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends --no-remove --fix-broken xdg-utils \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends --no-remove openssh-client supervisor tini ca-certificates python3-pkg-resources ffmpeg \
 && apt-get check \
 && rm -rf /var/lib/apt/lists/*

# Compile native dependencies against the same libc as the final QQ runtime.
FROM runtime-base AS build
COPY --from=node-runtime /usr/local/ /usr/local/
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ pkg-config liblzma-dev \
 && rm -rf /var/lib/apt/lists/*
ENV npm_config_nodedir=/usr/local
WORKDIR /opt/yesimbot
COPY . .
RUN --mount=type=cache,id=yesimbot-yarn,target=/root/.yarn/berry/cache,sharing=locked \
    chmod +x .yarn/releases/yarn-4.12.0.cjs \
 && ln -sf /opt/yesimbot/.yarn/releases/yarn-4.12.0.cjs /usr/local/bin/yarn \
 && yarn install --immutable \
 && yarn turbo run build --concurrency 2
# Keep workspace links and locked native dependencies in their original paths.
# Only allowlisted source enters the final image (no operator configuration).
RUN --mount=type=cache,id=yesimbot-yarn,target=/root/.yarn/berry/cache,sharing=locked \
    YARN_ENABLE_IMMUTABLE_INSTALLS=true yarn workspaces focus @yesimbot/distribution-app --production \
 && node docker/prepare-runtime.mjs

# The pinned agent-wechat daemon (WeChat), checksum-verified with its license notices.
FROM node-runtime AS agent-wechat
COPY docker/fetch-agent-wechat.mjs /tmp/fetch-agent-wechat.mjs
RUN node /tmp/fetch-agent-wechat.mjs /opt/agent-wechat

# An account as separate containers (leave-koishi 6.7) on one shared network, so each restarts alone
# (docs/account-runtime-manager.md): the application (`--target app`), the unmodified NapCat image, and agent-wechat
# (`--target wechat`), whose image also holds the shared network. The wechat image changes only with the daemon.
FROM node-runtime AS wechat
# FFmpeg: agent-wechat prepares WeChat voice, video and some image previews with it.
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends tini ca-certificates ffmpeg \
 && rm -rf /var/lib/apt/lists/*
COPY --from=agent-wechat /opt/agent-wechat/ /opt/agent-wechat/
COPY docker/start-wechat.sh /opt/yesimbot/start-wechat.sh
ENV KOISHI_STATE_DIR=/var/lib/yesimbot
ENTRYPOINT ["/bin/sh", "/opt/yesimbot/start-wechat.sh"]

FROM node-runtime AS app-base
# FFmpeg: Core transcodes images and compresses videos with it.
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends openssh-client supervisor tini ca-certificates ffmpeg \
 && rm -rf /var/lib/apt/lists/*

# Native dependencies compiled against the app image's own libc.
FROM app-base AS app-build
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ pkg-config liblzma-dev \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/yesimbot
COPY . .
RUN --mount=type=cache,id=yesimbot-app-yarn,target=/root/.yarn/berry/cache,sharing=locked \
    chmod +x .yarn/releases/yarn-4.12.0.cjs \
 && ln -sf /opt/yesimbot/.yarn/releases/yarn-4.12.0.cjs /usr/local/bin/yarn \
 && yarn install --immutable \
 && yarn turbo run build --concurrency 2
RUN --mount=type=cache,id=yesimbot-app-yarn,target=/root/.yarn/berry/cache,sharing=locked \
    YARN_ENABLE_IMMUTABLE_INSTALLS=true yarn workspaces focus @yesimbot/distribution-app --production \
 && node docker/prepare-runtime.mjs

FROM app-base AS app
COPY --from=app-build /opt/yesimbot/runtime/ /opt/yesimbot/
COPY docker/ /opt/yesimbot/docker/
RUN ln -sf /opt/yesimbot/.yarn/releases/yarn-4.12.0.cjs /usr/local/bin/yarn
ENV YESIMBOT_IMAGE=app QQ_ACCOUNT="" KOISHI_STATE_DIR=/var/lib/yesimbot NAPCAT_CONFIG_DIR=/app/napcat/config NODE_PATH=/opt/yesimbot/docker/app/node_modules:/opt/yesimbot/node_modules
WORKDIR /var/lib/yesimbot
EXPOSE 5140
HEALTHCHECK --interval=30s --timeout=12s --start-period=180s --retries=3 CMD ["node", "/opt/yesimbot/docker/healthcheck.mjs"]
ENTRYPOINT ["/opt/yesimbot/docker/entrypoint.sh"]

# The host, NapCat and agent-wechat in one container: what production runs. The default target.
FROM runtime-base
COPY --from=build /usr/local/bin/node /usr/local/bin/node
COPY --from=build /opt/yesimbot/runtime/ /opt/yesimbot/
COPY --from=agent-wechat /opt/agent-wechat/ /opt/agent-wechat/
COPY docker/ /opt/yesimbot/docker/
RUN ln -sf /opt/yesimbot/.yarn/releases/yarn-4.12.0.cjs /usr/local/bin/yarn
ENV QQ_ACCOUNT="" KOISHI_STATE_DIR=/var/lib/yesimbot NAPCAT_CONFIG_DIR=/app/napcat/config NODE_PATH=/opt/yesimbot/docker/app/node_modules:/opt/yesimbot/node_modules
WORKDIR /var/lib/yesimbot
EXPOSE 5140
HEALTHCHECK --interval=30s --timeout=12s --start-period=180s --retries=3 CMD ["node", "/opt/yesimbot/docker/healthcheck.mjs"]
ENTRYPOINT ["/opt/yesimbot/docker/entrypoint.sh"]
