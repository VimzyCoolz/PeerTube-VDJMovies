# PeerTube production image, built from source.
#
# This image is meant to be deployed with the stack defined in
# ./docker-compose.yml (Coolify, or a plain `docker compose up`).
# TLS termination and domain routing are handled by the reverse proxy in front
# of it, so this image only serves PeerTube on port 9000.
#
# The build context must be the repository root:
#   docker build -t peertube .

FROM node:22-trixie-slim

# System dependencies: ffmpeg for transcoding, python3 for yt-dlp imports,
# gosu to drop privileges in the entrypoint.
RUN apt update \
 && apt install -y --no-install-recommends openssl ffmpeg python3 python3-pip ca-certificates gnupg gosu build-essential curl git va-driver-all \
 && gosu nobody true \
 && rm /var/lib/apt/lists/* -fR

RUN npm install -g pnpm

# Node images hardcode the node uid to 1000, so reserve 999 for the peertube user.
ENV DEFAULT_PEERTUBE_UID=999
ENV DEFAULT_PEERTUBE_GID=999

RUN groupadd -r -g ${PEERTUBE_GID:-${DEFAULT_PEERTUBE_GID}} peertube \
    && useradd -r -u ${PEERTUBE_UID:-${DEFAULT_PEERTUBE_UID}} -g peertube -m peertube

# Install the application
COPY --chown=peertube:peertube . /app
WORKDIR /app

USER peertube

# Build the server and the client, then keep production dependencies only
RUN npm run install-node-dependencies \
 && npm run build \
 && rm -rf ./node_modules ./client/node_modules ./client/.angular \
 && npm run install-node-dependencies -- --production \
 && pnpm store prune

USER root

RUN mkdir /data /config \
 && chown -R peertube:peertube /data /config

ENV NODE_ENV=production
ENV NODE_CONFIG_DIR=/app/config:/app/support/docker/production/config:/config
ENV PEERTUBE_LOCAL_CONFIG=/config

# Storage (/data) and the local configuration written by the web admin (/config)
VOLUME /data
VOLUME /config

COPY ./support/docker/production/entrypoint.sh /usr/local/bin/entrypoint.sh
ENTRYPOINT [ "/usr/local/bin/entrypoint.sh" ]

EXPOSE 9000

CMD [ "node", "dist/server" ]
