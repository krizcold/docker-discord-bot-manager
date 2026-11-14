# dbm - run the Discord Bot Manager console inside the manager container.
#
#   ./dbm.ps1                              # the terminal application, when run in a terminal
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

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  [Console]::Error.WriteLine("[Error] docker is not on PATH, so dbm cannot reach the manager container.")
  exit 1
}

$container = if ($env:DBM_CONTAINER) { $env:DBM_CONTAINER } else { "discordbotmanagerapp" }
if (-not [Console]::IsInputRedirected -and -not [Console]::IsOutputRedirected) {
  docker exec -it $container node /app/dist/cli/dbm.js @Args
  $status = $LASTEXITCODE
  # A session cut by a manager restart leaves the terminal in paste mode, on the alternate screen, with no cursor.
  # Only the run with no verb uses the alternate screen; a console without VT processing would print the sequences.
  if ($Host.UI.SupportsVirtualTerminal) {
    $esc = [char]27
    $reset = "$esc[?2004l$esc[?25h"
    if ($null -eq $Args -or $Args.Count -eq 0) { $reset += "$esc[?1049l" }
    [Console]::Write($reset)
  }
  exit $status
}
docker exec -i $container node /app/dist/cli/dbm.js @Args
exit $LASTEXITCODE
