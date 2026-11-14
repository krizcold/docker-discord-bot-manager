#!/usr/bin/env bash
# dbm - run the Discord Bot Manager console inside the manager container.
#
#   ./dbm.sh                           # the terminal application, when run in a terminal
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
if [ -t 0 ] && [ -t 1 ]; then
  status=0
  docker exec -it "$container" node /app/dist/cli/dbm.js "$@" || status=$?
  # A session cut by a manager restart leaves the terminal in paste mode, on the alternate screen, with no cursor.
  # Only the run with no verb uses the alternate screen; leaving it elsewhere restores a saved cursor over the output.
  if [ "$#" -eq 0 ]; then
    printf '\033[?2004l\033[?25h\033[?1049l'
  else
    printf '\033[?2004l\033[?25h'
  fi
  exit "$status"
fi
exec docker exec -i "$container" node /app/dist/cli/dbm.js "$@"
