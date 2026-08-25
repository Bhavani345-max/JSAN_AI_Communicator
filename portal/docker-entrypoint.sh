#!/bin/sh
# Make the mounted volume writable, then drop to `node` and start the server.
#
# The image runs as an unprivileged user, but a freshly provisioned volume
# arrives owned by root with mode 755. SQLite cannot create its database file
# in a directory it cannot write, so the portal exits with
# "unable to open database file" and the platform crashloops it - on a fresh
# volume, which is exactly the first boot of a new deployment.
#
# Fixing ownership in the Dockerfile alone is not enough: that covers a volume
# the runtime seeds from the image path, but not one mounted root-owned over
# the top. Doing it here covers both, on every boot, and costs one chown.
#
# The chown is scoped to the directory holding SQLITE_PATH and only when that
# path is absolute - a relative SQLITE_PATH resolves inside the image, which is
# already owned correctly and must not be touched.
set -e

if [ "$(id -u)" = "0" ]; then
  case "${SQLITE_PATH:-}" in
    /*)
      data_dir="$(dirname "$SQLITE_PATH")"
      mkdir -p "$data_dir"
      # -R covers the -wal and -shm sidecars a previous run left behind.
      chown -R node:node "$data_dir"
      ;;
  esac
  exec su-exec node "$@"
fi

# Already unprivileged - nothing to fix and no way to fix it. Start anyway so a
# runtime that pins its own user still boots.
exec "$@"
