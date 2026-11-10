#!/bin/sh
set -e

# PeerTube builds its public URL as "<scheme>://<hostname>:<port>" itself, so
# PEERTUBE_WEBSERVER_HOSTNAME must be a bare host. Coolify's SERVICE_FQDN_* value
# carries the internal port (e.g. "example.com:9000"); strip any ":<port>" suffix.
if [ -n "${PEERTUBE_WEBSERVER_HOSTNAME:-}" ]; then
    PEERTUBE_WEBSERVER_HOSTNAME="${PEERTUBE_WEBSERVER_HOSTNAME%%:*}"
    export PEERTUBE_WEBSERVER_HOSTNAME
fi

find /config ! -user peertube -exec chown peertube:peertube {} \; || true

# first arg is `-f` or `--some-option`
# or first arg is `something.conf`
if [ "${1#-}" != "$1" ] || [ "${1%.conf}" != "$1" ]; then
    set -- node "$@"
fi

# allow the container to be started with `--user`
if [ "$1" = 'node' -a "$(id -u)" = '0' ]; then
    find /data ! -user peertube -exec  chown peertube:peertube {} \;
    exec gosu peertube "$0" "$@"
fi

exec "$@"
