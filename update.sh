#!/usr/bin/env bash
#
# Update the Bot Manager in place: pull the latest code and rebuild + recreate the
# stack. Run from the cloned repo root (the same one you ran setup.sh / compose in).
# For the standalone (non-remote) stack, HOST_DATA_DIR must be set in the environment.
#
set -uo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

c_bold=$'\033[1m'; c_grn=$'\033[32m'; c_red=$'\033[31m'; c_off=$'\033[0m'
info() { printf '%s==>%s %s\n' "$c_bold" "$c_off" "$*"; }
ok()   { printf '%s[ok]%s %s\n' "$c_grn" "$c_off" "$*"; }
die()  { printf '%s[x]%s %s\n'  "$c_red" "$c_off" "$*" >&2; exit 1; }

# Remote stack if a public host is configured, otherwise the standalone stack.
if [ -f .env ] && grep -q '^PUBLIC_HOST=' .env; then COMPOSE="docker-compose.remote.yml"; else COMPOSE="docker-compose.standalone.yml"; fi
[ -f "$COMPOSE" ] || die "$COMPOSE not found - run this from the cloned repo root."
info "Updating via $COMPOSE"

# The standalone stack reads HOST_DATA_DIR from the shell (no .env), but sudo strips it.
# Recover it from the running manager so `sudo ./update.sh` just works.
if [ "$COMPOSE" = "docker-compose.standalone.yml" ] && [ -z "${HOST_DATA_DIR:-}" ]; then
  HOST_DATA_DIR="$(docker inspect discordbotmanagerapp --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null | sed -n 's/^HOST_DATA_DIR=//p' | head -n1)"
  [ -n "$HOST_DATA_DIR" ] && export HOST_DATA_DIR || die "HOST_DATA_DIR is not set and the manager isn't running to read it from. Re-run as:  sudo HOST_DATA_DIR=/your/data/dir ./update.sh"
fi

# Keep the locally-written admin hash; otherwise the tracked-file change blocks the pull.
git -c safe.directory='*' update-index --skip-worktree authelia/users_database.yml 2>/dev/null || true

info "Pulling latest code..."
git -c safe.directory='*' pull --ff-only || die "git pull failed - resolve it by hand, then re-run."

info "Rebuilding and recreating (the first build can take a few minutes)..."
docker compose -f "$COMPOSE" up -d --build || die "docker compose up failed."

ok "Bot Manager updated."
docker compose -f "$COMPOSE" ps || true
