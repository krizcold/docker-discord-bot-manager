# Update the Bot Manager on Windows (standalone). Run from the cloned repo root.
# HOST_DATA_DIR must be set first, same as the initial start:
#   $env:HOST_DATA_DIR = "C:/dbm/data"
#   ./update.ps1
$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

$compose = if ((Test-Path .env) -and (Select-String -Path .env -Pattern '^PUBLIC_HOST=' -Quiet)) {
  'docker-compose.remote.yml'
} else {
  'docker-compose.standalone.yml'
}
if (-not (Test-Path $compose)) { throw "$compose not found - run this from the cloned repo root." }
Write-Host "==> Updating via $compose"

# The standalone stack needs HOST_DATA_DIR; recover it from the running manager if unset.
if ($compose -eq 'docker-compose.standalone.yml' -and -not $env:HOST_DATA_DIR) {
  $envLines = docker inspect discordbotmanagerapp --format '{{range .Config.Env}}{{println .}}{{end}}' 2>$null
  $hd = $envLines | Where-Object { $_ -like 'HOST_DATA_DIR=*' } | Select-Object -First 1
  if ($hd) { $env:HOST_DATA_DIR = $hd.Substring('HOST_DATA_DIR='.Length) }
  else { throw 'Set $env:HOST_DATA_DIR first (e.g. $env:HOST_DATA_DIR = "C:/dbm/data"), then re-run.' }
}

# Keep the locally-written admin hash; otherwise the tracked-file change blocks the pull.
git -c safe.directory='*' update-index --skip-worktree authelia/users_database.yml 2>$null

Write-Host "==> Pulling latest code..."
git -c safe.directory='*' pull --ff-only

Write-Host "==> Rebuilding and recreating..."
docker compose -f $compose up -d --build

Write-Host "[ok] Bot Manager updated."
docker compose -f $compose ps
