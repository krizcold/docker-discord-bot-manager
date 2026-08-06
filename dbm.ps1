# dbm - run the Discord Bot Manager console inside the manager container.
#
#   ./dbm.ps1 bots list                    # exec into the manager container
#   $env:DBM_CONTAINER="name"; ./dbm.ps1   # override the container name
#   $env:DBM_LOCAL="1"; ./dbm.ps1 --port 8090   # host-native (dev build in .\dist)
#
# Runs only against loopback inside the target host; nothing remote.
param([Parameter(ValueFromRemainingArguments = $true)] $Args)

if ($env:DBM_LOCAL -eq "1") {
  node "$PSScriptRoot/dist/cli/dbm.js" @Args
  exit $LASTEXITCODE
}

$container = if ($env:DBM_CONTAINER) { $env:DBM_CONTAINER } else { "discordbotmanagerapp" }
docker exec -i $container node /app/dist/cli/dbm.js @Args
exit $LASTEXITCODE
