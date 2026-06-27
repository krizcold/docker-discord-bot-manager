#!/usr/bin/env bash
#
# Bot Manager - automated public install for a Linux VPS (e.g. Contabo).
# Stands up the manager UI behind Caddy (automatic TLS) + Authelia (login + MFA)
# from docker-compose.remote.yml. Re-runnable: run it again to reconfigure, e.g. to
# switch between sslip.io and your own domain. The manual steps in README.md remain
# the advanced alternative; this script does exactly what they describe.
#
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

COMPOSE_FILE="docker-compose.remote.yml"
AUTHELIA_DIR="authelia"
SECRETS_DIR="$AUTHELIA_DIR/secrets"
USERS_DB="$AUTHELIA_DIR/users_database.yml"
ENV_FILE=".env"
DEFAULT_DATA_DIR="/opt/dbm/data"
PUID=1000
PGID=1000
SECRET_NAMES="JWT_SECRET SESSION_SECRET STORAGE_ENCRYPTION_KEY"
RESET_PASSWORD=0

umask 077   # secrets, .env and users_database.yml are created 0600 from the first write

c_bold=$'\033[1m'; c_red=$'\033[31m'; c_grn=$'\033[32m'; c_yel=$'\033[33m'; c_off=$'\033[0m'
say()  { printf '%s\n' "$*"; }
info() { printf '%s==>%s %s\n' "$c_bold" "$c_off" "$*"; }
ok()   { printf '%s[ok]%s %s\n' "$c_grn" "$c_off" "$*"; }
warn() { printf '%s[!]%s %s\n'  "$c_yel" "$c_off" "$*" >&2; }
die()  { printf '%s[x]%s %s\n'  "$c_red" "$c_off" "$*" >&2; exit 1; }

usage() {
  cat <<EOF
Bot Manager public installer (Caddy auto-TLS + Authelia MFA).

  Usage: sudo ./setup.sh [--reset-password] [-h|--help]

Re-run any time to reconfigure (e.g. switch sslip.io <-> your own domain).
  --reset-password   Set a new admin password even if one is already configured.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --reset-password) RESET_PASSWORD=1 ;;
    -h|--help) usage; exit 0 ;;
    *) usage; die "Unknown argument: $1" ;;
  esac
  shift
done

# Reads existing .env (KEY=value) so re-runs keep stable defaults.
env_get() { [ -f "$ENV_FILE" ] || return 0; sed -n "s/^$1=//p" "$ENV_FILE" | head -n1; }

read_secret() { local __v; read -rsp "$2" __v; printf '\n' >&2; printf -v "$1" '%s' "$__v"; }

authelia_cli() { docker run --rm "$AUTHELIA_IMAGE" authelia "$@"; }
# Extract the value by shape, so a labelled or bare CLI output both parse.
gen_secret() { authelia_cli crypto rand --length 64 --charset alphanumeric 2>/dev/null | grep -oE '[A-Za-z0-9]{64}' | head -n1; }
gen_hash()   { authelia_cli crypto hash generate argon2 --password "$1" 2>/dev/null | grep -oE '\$argon2id\$[^[:space:]]+' | head -n1; }

detect_public_ip() {
  local ip
  for url in https://api.ipify.org https://ifconfig.me https://icanhazip.com; do
    ip="$(curl -fsS --max-time 8 "$url" 2>/dev/null | tr -d '[:space:]')"
    case "$ip" in *.*.*.*) printf '%s' "$ip"; return 0 ;; esac
  done
  return 1
}

# ── Preflight ───────────────────────────────────────────────────────────────
[ "$(id -u)" -eq 0 ] || die "Run as root: sudo ./setup.sh"
[ -f "$COMPOSE_FILE" ] || die "$COMPOSE_FILE not found - run this from the cloned repo root."

if [ -r /etc/os-release ]; then . /etc/os-release; fi
case "${ID:-} ${ID_LIKE:-}" in
  *ubuntu*|*debian*) : ;;
  *) warn "Untested OS '${ID:-unknown}'. The installer assumes Ubuntu/Debian (apt + get.docker.com). Continuing." ;;
esac

if ! command -v curl >/dev/null 2>&1; then
  info "Installing curl ..."
  apt-get update -qq && apt-get install -y -qq curl ca-certificates || die "Could not install curl (needed for the Docker install + public-IP detection)."
fi

if ! command -v docker >/dev/null 2>&1; then
  info "Docker not found - installing via get.docker.com ..."
  curl -fsSL https://get.docker.com | sh || die "Docker installation failed."
  systemctl enable --now docker 2>/dev/null || true
fi
command -v docker >/dev/null 2>&1 || die "Docker is not installed."
docker compose version >/dev/null 2>&1 || die "The Docker Compose plugin is missing (need 'docker compose')."

# The manager and Caddy bind /var/run/docker.sock; rootless/remote Docker won't work.
if [ -n "${DOCKER_HOST:-}" ] && [ "${DOCKER_HOST}" != "unix:///var/run/docker.sock" ]; then
  die "DOCKER_HOST=$DOCKER_HOST set - rootless/remote Docker is unsupported. Use rootful Docker at /var/run/docker.sock."
fi
[ -S /var/run/docker.sock ] || die "No /var/run/docker.sock - this setup requires rootful Docker."
docker info >/dev/null 2>&1 || die "Cannot reach the Docker daemon (is it running? 'systemctl status docker')."

AUTHELIA_IMAGE="$(grep -oE 'authelia/authelia:[^[:space:]"]+' "$COMPOSE_FILE" | head -n1)"
[ -n "$AUTHELIA_IMAGE" ] || die "Could not read the Authelia image tag from $COMPOSE_FILE."
info "Pulling $AUTHELIA_IMAGE ..."
docker pull "$AUTHELIA_IMAGE" >/dev/null 2>&1 || die "Could not pull $AUTHELIA_IMAGE (check network / registry access)."

# ── Data directory (owned by the bots' PUID:PGID) ─────────────────────────────
data_default="$(env_get HOST_DATA_DIR)"; data_default="${data_default:-$DEFAULT_DATA_DIR}"
read -rp "Data directory [$data_default]: " HOST_DATA_DIR
HOST_DATA_DIR="${HOST_DATA_DIR:-$data_default}"
case "$HOST_DATA_DIR" in /*) : ;; *) die "Data directory must be an absolute path." ;; esac
mkdir -p "$HOST_DATA_DIR" || die "Could not create $HOST_DATA_DIR."
# Own the bind root only (NOT -R): the manager fixes per-bot subtree ownership itself,
# and a recursive chown on a re-run would steal a service-owned dir (e.g. Postgres uid 999).
chown "$PUID:$PGID" "$HOST_DATA_DIR" || die "Could not chown $HOST_DATA_DIR to $PUID:$PGID."
ok "Data dir ready: $HOST_DATA_DIR (root owned $PUID:$PGID; per-bot files chowned at deploy)"

# ── Hostname / domain ─────────────────────────────────────────────────────────
prev_cookie_domain="$(env_get COOKIE_DOMAIN)"
info "How should the manager be reached over HTTPS?"
say  "  1) sslip.io           - no domain, derived from this server's public IP (quick start)"
say  "  2) your own domain    - sturdier certs/cookies (recommended for anything you keep)"
read -rp "Choice [1]: " domain_choice; domain_choice="${domain_choice:-1}"

if [ "$domain_choice" = "2" ]; then
  read -rp "Base domain (e.g. example.com): " BASE_DOMAIN
  [ -n "$BASE_DOMAIN" ] || die "A domain is required for option 2."
  COOKIE_DOMAIN="$BASE_DOMAIN"
  PUBLIC_HOST="bot.$BASE_DOMAIN"
  AUTHELIA_HOST="auth.$BASE_DOMAIN"
  BOT_DOMAIN_BASE="$BASE_DOMAIN"
  vps_ip="$(detect_public_ip)" || vps_ip=""
  info "Point these DNS records at this server${vps_ip:+ ($vps_ip)}:"
  say  "    A   $PUBLIC_HOST    -> ${vps_ip:-<server IP>}"
  say  "    A   $AUTHELIA_HOST   -> ${vps_ip:-<server IP>}"
  say  "    A   *.$BASE_DOMAIN   -> ${vps_ip:-<server IP>}   (wildcard, for per-bot subdomains)"
  read -rp "Press Enter once DNS is set (or to continue and set it later) ... " _
  if [ -n "$vps_ip" ]; then
    resolved="$(getent ahostsv4 "$PUBLIC_HOST" 2>/dev/null | awk '{print $1; exit}')"
    if [ "$resolved" = "$vps_ip" ]; then ok "$PUBLIC_HOST resolves to $vps_ip."
    else warn "Could not confirm $PUBLIC_HOST -> $vps_ip (got '${resolved:-nothing}'). If DNS is still propagating, or sits behind a proxy/floating IP, this may be fine; TLS needs it to resolve to this server."; fi
  fi
else
  info "Detecting this server's public IPv4 ..."
  vps_ip="$(detect_public_ip)" || vps_ip=""
  [ -n "$vps_ip" ] || read -rp "Could not auto-detect. Enter this server's public IPv4: " vps_ip
  read -rp "Public IP [$vps_ip]: " ip_in; vps_ip="${ip_in:-$vps_ip}"
  case "$vps_ip" in *.*.*.*) : ;; *) die "Invalid IPv4: $vps_ip" ;; esac
  dash_ip="$(printf '%s' "$vps_ip" | tr '.' '-')"
  COOKIE_DOMAIN="$dash_ip.sslip.io"
  PUBLIC_HOST="bot.$dash_ip.sslip.io"
  AUTHELIA_HOST="auth.$dash_ip.sslip.io"
  BOT_DOMAIN_BASE="$dash_ip.sslip.io"
  ok "sslip.io hosts derived from $vps_ip (dotted subdomains of $COOKIE_DOMAIN)."
  warn "sslip.io shares a global Let's Encrypt budget and is a Public-Suffix-List candidate - use a real domain for anything you keep."
fi

# ── Host firewall ─────────────────────────────────────────────────────────────
if command -v ufw >/dev/null 2>&1; then
  # Keep the CURRENT SSH session reachable (its server port) before flipping to default-deny.
  ssh_port="$(printf '%s' "${SSH_CONNECTION:-}" | awk '{print $4}')"; case "$ssh_port" in ''|*[!0-9]*) ssh_port=22 ;; esac
  ufw allow "$ssh_port/tcp" >/dev/null 2>&1 || true
  ufw allow OpenSSH         >/dev/null 2>&1 || true
  ufw allow 80/tcp  >/dev/null 2>&1 || true
  ufw allow 443/tcp >/dev/null 2>&1 || true
  ufw allow 443/udp >/dev/null 2>&1 || true
  ufw --force enable >/dev/null 2>&1 || true
  ok "Host firewall (ufw): SSH ($ssh_port) preserved; 80/tcp, 443/tcp, 443/udp open."
else
  warn "ufw not found - make sure inbound 80 + 443 are open by other means."
fi
warn "Contabo's EXTERNAL firewall (web panel) is separate from this host. If enabled, open inbound 80 + 443 there too, or TLS will silently fail."

# ── Authelia secrets (idempotent) ─────────────────────────────────────────────
mkdir -p "$SECRETS_DIR"; chmod 700 "$SECRETS_DIR" 2>/dev/null || true
for name in $SECRET_NAMES; do
  f="$SECRETS_DIR/$name"
  if [ ! -s "$f" ]; then
    info "Generating $name ..."
    gen_secret > "$f"
  fi
  chmod 600 "$f" 2>/dev/null || true
  [ -s "$f" ] || die "Secret $name is empty - generation failed. Try: docker run --rm $AUTHELIA_IMAGE authelia crypto rand --length 64 --charset alphanumeric"
done
ok "Authelia secrets present and non-empty (3)."

# ── Contact email + timezone ──────────────────────────────────────────────────
email_default="$(env_get ACME_EMAIL)"
read -rp "Contact email (Let's Encrypt + admin)${email_default:+ [$email_default]}: " ACME_EMAIL
ACME_EMAIL="${ACME_EMAIL:-$email_default}"
[ -n "$ACME_EMAIL" ] || die "An email is required."
TZ_VAL="$(timedatectl show -p Timezone --value 2>/dev/null)"; [ -n "$TZ_VAL" ] || TZ_VAL="$(env_get TZ)"; [ -n "$TZ_VAL" ] || TZ_VAL="UTC"

# ── Admin password + users_database.yml ───────────────────────────────────────
need_password=0
if [ "$RESET_PASSWORD" -eq 1 ]; then need_password=1
elif [ ! -f "$USERS_DB" ] || grep -q 'REPLACE_WITH_GENERATED_HASH' "$USERS_DB"; then need_password=1; fi

if [ "$need_password" -eq 1 ]; then
  while :; do
    read_secret ADMIN_PW  "Admin password: "
    read_secret ADMIN_PW2 "Confirm password: "
    [ -n "$ADMIN_PW" ] || { warn "Password cannot be empty."; continue; }
    [ "$ADMIN_PW" = "$ADMIN_PW2" ] || { warn "Passwords do not match."; continue; }
    break
  done
  info "Hashing the admin password ..."
  ADMIN_HASH="$(gen_hash "$ADMIN_PW")"
  [ -n "$ADMIN_HASH" ] || die "Failed to generate the password hash."
  cat > "$USERS_DB" <<EOF
# Single admin user for the Bot Manager remote gateway. Generated by setup.sh.
# 'password' is an argon2id hash; the user must stay in group 'admins'.
users:
  admin:
    disabled: false
    displayname: 'Administrator'
    password: '${ADMIN_HASH}'
    email: '${ACME_EMAIL}'
    groups:
      - 'admins'
EOF
  chmod 600 "$USERS_DB" 2>/dev/null || true
  ok "Wrote $USERS_DB"
else
  ok "Admin password already configured (use --reset-password to change it)."
fi

# ── .env ──────────────────────────────────────────────────────────────────────
if [ -n "$prev_cookie_domain" ] && [ "$prev_cookie_domain" != "$COOKIE_DOMAIN" ]; then
  warn "Cookie domain changed ($prev_cookie_domain -> $COOKIE_DOMAIN): existing logins are invalidated and Caddy issues fresh certificates for the new hostnames. Old certs stay cached in the caddy_data volume (harmless); to fully reset TLS, run 'docker compose -f $COMPOSE_FILE down' and re-run this script."
fi
cat > "$ENV_FILE" <<EOF
HOST_DATA_DIR=$HOST_DATA_DIR
PUBLIC_HOST=$PUBLIC_HOST
AUTHELIA_HOST=$AUTHELIA_HOST
COOKIE_DOMAIN=$COOKIE_DOMAIN
ACME_EMAIL=$ACME_EMAIL
TZ=$TZ_VAL
BOT_DOMAIN_BASE=$BOT_DOMAIN_BASE
EOF
ok "Wrote $ENV_FILE"

# ── Deploy ────────────────────────────────────────────────────────────────────
info "Starting the stack (the first build can take a few minutes) ..."
docker compose -f "$COMPOSE_FILE" up -d || die "docker compose up failed."

info "Waiting for containers to settle ..."
sleep 6
docker compose -f "$COMPOSE_FILE" ps || true

info "Checking Caddy TLS issuance (up to 60s) ..."
cert_state=0
for _ in $(seq 1 12); do
  logs="$(docker logs caddy 2>&1)"
  if printf '%s' "$logs" | grep -qiE 'certificate obtained successfully|obtaining certificate'; then cert_state=1; break; fi
  if printf '%s' "$logs" | grep -qiE 'could not get certificate|failed to obtain certificate|too many certificates already issued|no solvers available'; then cert_state=2; break; fi
  sleep 5
done
case "$cert_state" in
  1) ok "Caddy is obtaining / has obtained TLS certificates." ;;
  2) warn "Caddy reported a certificate problem - run 'docker logs caddy'. Usual causes: 80/443 blocked by Contabo's external firewall, or DNS not pointing here." ;;
  *) warn "No certificate result yet (issuance can take a little longer). Check later with 'docker logs caddy'." ;;
esac

cat <<EOF

${c_grn}${c_bold}Done.${c_off}

  Manager URL : https://$PUBLIC_HOST
  Login       : admin  /  (the password you set)

  Enroll MFA:
    1. Open  https://$PUBLIC_HOST  and log in.
    2. Register a TOTP or WebAuthn device. Authelia would email a confirmation link,
       but there is no SMTP here, so read it from the container:
         docker exec authelia cat /data/notification.txt
    3. Open that link, finish enrollment, and scan the QR into your authenticator.

  Reminders:
    - If TLS fails: open inbound 80 + 443 in Contabo's external firewall panel (separate from this host).
$( [ "$domain_choice" = "2" ] && printf '    - Make sure DNS A records for bot. / auth. / *  point at this server.\n' )
    - Reconfigure any time (including switching domain mode): sudo ./setup.sh
EOF
