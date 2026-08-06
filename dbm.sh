#!/usr/bin/env bash
# dbm - run the Discord Bot Manager console inside the manager container.
#
#   ./dbm.sh bots list                 # exec into the manager container
#   DBM_CONTAINER=name ./dbm.sh ...    # override the container name
#   DBM_LOCAL=1 ./dbm.sh --port 8090   # host-native (dev build in ./dist)
#
# Runs only against loopback inside the target host; nothing remote.
set -euo pipefail

if [ "${DBM_LOCAL:-}" = "1" ]; then
  exec node "$(dirname "$0")/dist/cli/dbm.js" "$@"
fi

container="${DBM_CONTAINER:-discordbotmanagerapp}"
exec docker exec -i "$container" node /app/dist/cli/dbm.js "$@"
