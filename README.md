# Discord Bot Manager

> **WORK IN PROGRESS** -- under active development and NOT production-ready. APIs, configuration, file structure, and behavior may change without notice.

A Docker-based platform for deploying and managing multiple Discord bots from any GitHub repository or Docker image. It runs as a Yundera/CasaOS app, or **standalone** on a plain Windows or Linux machine with Docker. Bots are organized as **sources** (a repo or image) and **instances** (a deployed bot built from a source).

It auto-detects how it is running: `casaos` when a CasaOS host is present, otherwise `docker` (standalone). Set `DEPLOYMENT_MODE=docker` to force standalone.

---

## Install & run

First, clone the repository -- every scenario below runs from inside it:

```bash
git clone https://github.com/krizcold/docker-discord-bot-manager.git
cd docker-discord-bot-manager
```

(The compose files build the manager image from this source. To skip the local build, edit the compose file to use the prebuilt image instead - the `image:` line is commented next to `build: .`.)

| Scenario | Section |
|----------|---------|
| Windows desktop | **Standalone on Windows** |
| Local Linux machine | **Standalone on Linux** |
| Public Linux server (VPS / Contabo) | **Server on Linux** |
| Working on the manager's own code | **Development** |

<details>
<summary><b>Standalone on Windows (Docker Desktop)</b></summary>

The manager runs as a container under Docker Desktop and manages your bots as sibling containers. It binds to `127.0.0.1` only and has no login - keep it on your own machine.

**Prerequisites:** Docker Desktop installed and running in **Linux-container mode**.

1. Pick a host folder for data (e.g. `C:\dbm\data`) and set it, **using forward slashes**:
   ```powershell
   $env:HOST_DATA_DIR = "C:/dbm/data"
   ```
2. Start it:
   ```powershell
   docker compose -f docker-compose.standalone.yml up -d --build
   ```
3. Open <http://127.0.0.1:8090> and install a bot (add a repo URL or Docker image -> set env/config -> Install & Run).

`HOST_DATA_DIR` must be set: the host Docker daemon resolves a bot's bind-mounts as **host** paths, so the manager rewrites them to live under this shared folder. It must be an absolute host path that matches the data bind in the compose file.

> **Test status:** verified end-to-end on Windows Docker Desktop with a real multi-service bot (install, build, deploy, web-UI login, env edits, update).

</details>

<details>
<summary><b>Standalone on Linux</b></summary>

The same `/var/run/docker.sock` mount works as on Windows. Unlike Docker Desktop, Linux enforces real file ownership, so create the data dir owned by the bots' UID (`1000`) first; the manager also chowns the files it delivers, but the bind root should exist with the right owner.

**Prerequisites:** rootful Docker Engine + the Compose plugin.

1. Create the data folder and start:
   ```bash
   export HOST_DATA_DIR=/opt/dbm/data
   sudo mkdir -p "$HOST_DATA_DIR" && sudo chown 1000:1000 "$HOST_DATA_DIR"
   docker compose -f docker-compose.standalone.yml up -d --build
   ```
2. Open <http://127.0.0.1:8090>. (To reach it from another machine securely, see **Server on Linux** below.)

</details>

<details>
<summary><b>Server on Linux (public, behind MFA) -- Contabo</b></summary>

Runs the manager UI on a public VPS behind **Caddy** (automatic TLS) + **Authelia** (login + TOTP/WebAuthn MFA). The manager mounts the Docker socket (root-equivalent), so it is never exposed bare - only Caddy listens on 80/443, and every request passes an Authelia login (MFA by default; a setup.sh prompt can switch to password-only for prototyping). TLS works **without a domain** via sslip.io, or with your own domain.

### Semi-automated setup (recommended)

**Before you start - provider firewall.** setup.sh configures the on-box firewall (ufw) for you, but it cannot touch your hosting provider's external firewall (Contabo control panel, cloud security groups, etc.). If your VPS has one, add these inbound accept rules first:

| Rule | Protocol | Port | Source |
|---|---|---|---|
| SSH | TCP | 22 (or your custom SSH port) | Any |
| HTTP | TCP | 80 | Any |
| HTTPS | TCP | 443 | Any |
| HTTP/3 (optional) | UDP | 443 | Any |

Add the SSH rule **before** applying the firewall to the VPS, or you will lock yourself out. 80/443 must stay open to the world: 80 serves the Let's Encrypt challenge, and nothing answers on either port except Caddy, with everything behind it gated by the Authelia MFA login. If the panel has IPv6 sources, mirror the same rules for `::/0`.

```bash
sudo apt-get install -y git   # fresh Ubuntu server images ship without git
git clone https://github.com/krizcold/docker-discord-bot-manager.git
cd docker-discord-bot-manager
sudo ./setup.sh
```

A real `git clone` (not a ZIP download) is required: the manager's self-update pulls this checkout.

Semi-automated: it still asks you the choices that matter - a **data directory** (Enter accepts `/opt/dbm/data`), **sslip.io or your own domain**, a **contact email**, **whether login requires MFA** (default yes; `n` = password-only, handy for prototyping), and your **admin password** - but automates the tedious/error-prone parts: it installs Docker if missing, opens the firewall (detecting your SSH port first so enabling it cannot lock you out), **generates the Authelia secrets, the manager gateway secret, and the argon2 password hash**, writes `.env` and `users_database.yml`, starts the stack (restarting Authelia whenever it writes a new admin hash, so the password takes effect), and registers the admin TOTP device server-side, printing its QR code at the end (see **First login** below). Re-run it any time to reconfigure (including switching sslip.io <-> a domain, or `--reset-password` / `--reset-mfa`).

**First login:** setup.sh registers your authenticator (TOTP) device automatically and prints its QR code at the end of the run - scan it with any authenticator app (Google Authenticator, Aegis, ...). Then open `https://manager.dbot.<your-domain>` and sign in as **`admin`** with the password you set plus the current 6-digit code. Lost the QR? Re-run `sudo ./setup.sh` (it re-shows it). Lost the phone? `sudo ./setup.sh --reset-mfa` registers a fresh device; `--reset-password` does the same for the password. If you answered `n` to the MFA question, login is just `admin` + password (no QR is printed) - re-run setup.sh any time to switch.

> **Live-validated on a real VPS** (Contabo, Ubuntu 24.04, own-domain mode): TLS issuance, Authelia login with the terminal TOTP QR, bot installs on bare Linux, per-bot subdomains, and self-update. sslip.io mode remains config-reviewed only.
>
> **sslip.io caveat:** it is a Public-Suffix-List *candidate*; if it ever lands on the PSL, browsers + Authelia reject the session cookie. **Use a real domain for anything you intend to keep.**

### Fully manual setup (advanced)

You do **not** need any of this if you ran `setup.sh` above - these are the equivalent steps, by hand (one difference: setup.sh registers the TOTP device server-side and prints a QR, while this path enrolls it in the web UI via the notification.txt link) (sslip.io example for VPS IP `203.0.113.5`):

1. **Host prep:** create the data dir owned by the bot UID (`1000`), and open inbound TCP **80** and **443** (Contabo's external firewall too, if enabled; don't publish the manager/Authelia ports). Allow SSH **before** enabling the firewall so you are not locked out:
   ```bash
   sudo mkdir -p /opt/dbm/data && sudo chown 1000:1000 /opt/dbm/data
   sudo ufw allow OpenSSH                      # or: sudo ufw allow <your-ssh-port>/tcp
   sudo ufw allow 80,443/tcp && sudo ufw allow 443/udp
   sudo ufw enable
   ```
2. **Authelia secrets** (`crypto rand` prints `Random Value: <string>`; the pipe keeps just the value):
   ```bash
   mkdir -p ./authelia/secrets
   for f in JWT_SECRET SESSION_SECRET STORAGE_ENCRYPTION_KEY; do \
     docker run --rm authelia/authelia:4.39.20 authelia crypto rand --length 64 --charset alphanumeric \
     | sed -n 's/^Random Value: //p' | tr -d '\n' > ./authelia/secrets/$f; done
   chmod 700 ./authelia/secrets && chmod 600 ./authelia/secrets/*
   ```
3. **Admin password** -> generate an argon2id hash, then edit `authelia/users_database.yml`: replace the `$argon2id$...REPLACE...` placeholder on the `password:` line with the generated hash, and set a real `email:` (kept for future SMTP; the MFA-enrollment link is read from a file in step 5):
   ```bash
   docker run --rm -it authelia/authelia:4.39.20 authelia crypto hash generate argon2
   ```
4. **Create a file named `.env`** in the same folder as `docker-compose.remote.yml` (Compose auto-loads it; a different name needs `--env-file`):
   ```env
   HOST_DATA_DIR=/opt/dbm/data
   PUBLIC_HOST=manager.dbot.203-0-113-5.sslip.io
   AUTHELIA_HOST=auth.dbot.203-0-113-5.sslip.io
   COOKIE_DOMAIN=dbot.203-0-113-5.sslip.io
   ACME_EMAIL=you@example.com
   TZ=Europe/Madrid
   BOT_DOMAIN_BASE=dbot.203-0-113-5.sslip.io   # per-bot HTTPS hosts (<name>.<base>); same dbot. sub-level as the manager
   MANAGER_GATEWAY_SECRET=<long random string>   # recommended: gates direct manager access
   ```
   `MANAGER_GATEWAY_SECRET` is a shared secret only Caddy knows: when set, the manager rejects any HTTP or WebSocket request that lacks the matching `X-DBM-Gateway` header Caddy injects, so a bot container sharing a Docker network with the manager cannot bypass Authelia. Loopback requests and the bot update endpoints (authenticated by `X-Bot-Token`) are exempt; unset disables the gate. `setup.sh` generates it and keeps it across re-runs.
   **Critical:** `PUBLIC_HOST` and `AUTHELIA_HOST` MUST be subdomains of `COOKIE_DOMAIN` - note the **dots** (`manager.dbot.203-0-113-5.sslip.io`, NOT `manager-dbot-203-0-113-5...`). A label glued on with a hyphen makes them *siblings* of `COOKIE_DOMAIN`, so the browser won't share the Authelia session cookie and login loops forever. (sslip.io maps any `<labels>.203-0-113-5.sslip.io` to `203.0.113.5`.)
   For a real domain: `PUBLIC_HOST=manager.dbot.example.com`, `AUTHELIA_HOST=auth.dbot.example.com`, `COOKIE_DOMAIN=dbot.example.com`, `BOT_DOMAIN_BASE=dbot.example.com`, and a single wildcard A record `*.dbot.example.com` at the VPS - it covers the manager, the auth portal, and every bot. The whole system lives under the dedicated `dbot.` sub-level, so `example.com`, all its other subdomains, AND the session cookie stay entirely separate from the rest of your domain (`manager` and `auth` are reserved bot names so a bot can never shadow them). You do not edit `authelia/configuration.yml` - it reads these from the env. Caddy issues a **separate** certificate per hostname on demand; there is no wildcard certificate (that would need a DNS-01 challenge, which this stack does not set up), so each bot subdomain triggers its own Let's Encrypt issuance.
5. **Run** and enroll MFA:
   ```bash
   docker compose -f docker-compose.remote.yml up -d
   # browse https://$PUBLIC_HOST -> log in -> enroll TOTP/WebAuthn.
   # no SMTP, so read the enrollment link from:
   docker exec authelia cat /data/notification.txt
   ```

With `BOT_DOMAIN_BASE` set, a bot's web UI is published at `https://<bot-name>.<BOT_DOMAIN_BASE>` with its own cert (so Discord-OAuth bots work without a domain); the **Open** link uses that URL. By default each bot vhost sits behind the same Authelia MFA login as the manager; a bot whose main web service ships its own auth gateway (e.g. AppShield) is detected automatically and left to protect itself. Override per bot with the card's **Auth** selector (Auto / Managed / Public) or `PUT /api/bots/:id/web-auth`; the change applies on the bot's next start.

**Prefer no public surface?** Keep the manager private and reach it over a tunnel/VPN instead:
- **Tailscale** (recommended): `tailscale up` on the VPS + your devices; reach the UI over the tailnet, optionally with a real `*.ts.net` cert via `tailscale serve`. No open ports, no domain.
- **SSH tunnel:** the remote compose above publishes no host port, so for a tunnel run the **standalone** compose instead (`docker-compose.standalone.yml` - localhost-only, no auth), then `ssh -N -L 8080:127.0.0.1:8090 user@vps` and open <http://localhost:8080>.

</details>

<details>
<summary><b>Development (run from source)</b></summary>

For working on the manager's own code - **not a production install**.

```bash
npm install

# Native run in standalone docker mode (fast edit loop):
# PowerShell: $env:DEPLOYMENT_MODE="docker"; $env:DATA_DIR=".localrun/data"; npm run dev
# bash:       DEPLOYMENT_MODE=docker DATA_DIR=.localrun/data npm run dev

npm run build   # tsc compile (+ copy web assets)
npm start       # run the compiled output
```

Open <http://127.0.0.1:8080>. In a native run `HOST_DATA_DIR` auto-resolves from `DATA_DIR`, so bind-mounts line up without extra config.

</details>

---

## Updating the manager

On Yundera/CasaOS the platform updates the manager. On a standalone (Windows or Linux) install you update it yourself - two ways, both of which `git pull` the latest code and rebuild + recreate the stack:

- **From the UI** (standalone docker mode): the header shows the running version (checked in the background, cached for 60s) and, when the repo is behind, an **Update manager** button. It streams the pull + build; when the pulled commits change neither the manager image nor its compose file it reports already up to date without restarting, otherwise it recreates the manager and verifies the restart actually took effect; the page reconnects and shows the new version. (Hidden on Yundera, where the platform handles updates. On Windows the rebuild always works; if the auto-restart can't launch, the UI tells you the one-line command to finish it.)
- **From the command line**, run from the cloned repo root:
  ```bash
  sudo ./update.sh          # Linux
  ```
  ```powershell
  ./update.ps1              # Windows (set $env:HOST_DATA_DIR first for the standalone stack)
  ```

Both keep your local admin hash and `.env` and recreate the whole stack, so the auth layer is patched too (the manager image is rebuilt; Caddy/Authelia are pinned images that `compose up -d` recreates only when their config changed). Managed bots are separate compose projects, so they keep running.

---

## How bots are reached

When a bot exposes a web UI, the manager publishes it on a host port (auto-assigned from `20000-29999`, override with `BOT_HOST_PORT_BASE`/`BOT_HOST_PORT_RANGE`) and shows an **Open** link. Ports bind to `127.0.0.1` by default - a published port bypasses host firewalls, so this avoids exposing bots on a server; set `BOT_PORT_BIND=0.0.0.0` for trusted-LAN access. On a server with the remote stack, bots are instead reached via their HTTPS subdomain (see **Server on Linux**).

### Bot web-UI access

A bot never authenticates its own web UI. Authentication lives at the deployment boundary - a gateway in front of the bot, or a localhost-only bind - so the **Open** link just opens the app that the boundary already protects. Where that boundary is depends on how the manager is running:

| Deployment | Boundary | What the Open link opens |
|---|---|---|
| Yundera (managed or standalone) | AppShield in OIDC mode - sign into CasaOS once, SSO into the app | The internet-facing HTTPS app, already authenticated by your CasaOS session |
| Linux server (managed, remote stack) | The bundled Caddy + Authelia (SSO + optional MFA, default on) | The bot's HTTPS subdomain behind the same login as the manager |
| Windows / Linux standalone | Localhost bind (`127.0.0.1`) - no gateway | The bot's local host port on your own machine |

On Yundera the bot is its own CasaOS app, published at `https://<name>-<APP_DOMAIN>`. Its web UI is guarded by Yundera's [AppShield](https://github.com/Yundera/AppShield) gateway (image `ghcr.io/yundera/appshield`) in OIDC mode: AppShield points at the CasaOS auth-registrar via `OIDC_REGISTRAR_URL`, self-registers its client on first login, and after that your CasaOS session single-signs you on. Nothing else to configure. AppShield does not terminate TLS - Yundera fronts it with HTTPS.

The bot's Discord-OAuth member routes (`/guild`, `/auth`) are **public** paths that bypass the admin gateway (AppShield's `ALLOWED_PATHS = /guild,/auth`). That is the separate member-facing Discord login for the bot's own users, not the admin gate.

To share admin access with additional people through AppShield's own credential mode, set `WEBUI_USER` and `WEBUI_PASSWORD` in the bot's **Env** editor and restart the bot (credential edits apply on start, no rebuild needed). They appear in the Env editor for any bot whose compose uses them.

---

<details>
<summary><b>Features</b></summary>

- **Universal bot importer** - detects language, package manager, entry point, services, and env vars; generates a Dockerfile + Compose when the repo ships none.
- **Multi-language** - Node.js (npm/yarn/pnpm/bun), Python (pip/poetry/uv/pipenv/setuptools), Go, Java/Kotlin (Maven/Gradle/prebuilt JAR), Rust, C# (.NET).
- **Source / instance model** - one cloned source backs many instances.
- **Guided config builder** - a validated form over a bot's config file with live two-way Form/Raw sync (raw editor fallback).
- **Multi-service stacks** - auto-wires PostgreSQL/MongoDB/MariaDB/Redis + Lavalink; status-page sidecar for port-less bots (CasaOS).
- **Environment management** - encrypted env storage + an in-UI editor + a reusable Credentials Vault.
- **Per-bot Console & Files** - interactive shell + a file browser/editor.
- **Live logs**, **non-blocking lifecycle** (start/stop/restart/update/delete) with WebSocket status, and **opt-in auto-updates**.
- **CasaOS / PCS integration** and **standalone Docker** (this README).

</details>

<details>
<summary><b>Architecture</b></summary>

```
docker-discord-bot-manager/
├── src/
│   ├── index.ts          # Entry point
│   ├── types/            # TypeScript types
│   ├── detection/        # Language / framework / service detection
│   ├── templates/        # Dockerfile + compose generation, processing, variable substitution
│   ├── compose/          # Compose parsing / processing
│   ├── config/           # Guided config builder
│   ├── env/              # Encrypted env storage + detection
│   ├── source/           # Source repository management
│   ├── instance/         # Bot instance management + scheduled updates
│   ├── naming/           # App naming + collision detection
│   ├── git/              # Git operations
│   ├── docker/           # Docker client, container lifecycle, host-port allocation
│   ├── casaos/           # CasaOS / PCS integration + deployment-mode detection
│   ├── discord/          # Discord API (ID validation for guided config)
│   └── webui/            # Express + WebSocket server, routes, public UI, terminal
├── docker-compose.yml             # CasaOS / Yundera app
├── docker-compose.standalone.yml  # standalone (Windows / Linux)
├── docker-compose.remote.yml      # public server (Caddy + Authelia)
├── authelia/                      # remote-access auth gateway config
└── package.json
```

</details>

<details>
<summary><b>API & WebSocket events</b></summary>

The Web UI is backed by a REST API plus a WebSocket channel at `/ws`. Endpoints cover sources, instances, environment variables, config files, the credentials vault, per-bot console and file operations, logs, and the manager self-update.

WebSocket events include: `bot:status`, `bot:created`/`updated`/`deleted`, `bot:started`/`stopped`/`restarted`, `bot:pulling`/`built`/`rebuilt`, the matching `*-failed` events, and `manager:*` self-update events.

</details>

<details>
<summary><b>Environment variables</b></summary>

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8080` | Web server port (inside the container) |
| `DATA_DIR` | `/data/data` | Base data directory |
| `DEPLOYMENT_MODE` | (auto) | `casaos` or `docker`; forces the mode |
| `HOST_DATA_DIR` | = `DATA_DIR` | Host path the data dir is mounted from (containerized standalone) |
| `BOT_PORT_BIND` | `127.0.0.1` | Interface bots' host ports bind to (`0.0.0.0` for LAN) |
| `BOT_HOST_PORT_BASE` / `BOT_HOST_PORT_RANGE` | `20000` / `10000` | Host-port auto-assign range |
| `BOT_DOMAIN_BASE` | (unset) | Base for per-bot HTTPS subdomains (remote mode) |
| `ENV_ENCRYPTION_KEY` | (generated) | Key for the AES-256-CBC secret storage; when unset, a key file is generated under the data dir on first run |
| `NODE_ENV` | `production` | Node environment |

Remote mode adds `PUBLIC_HOST`, `AUTHELIA_HOST`, `COOKIE_DOMAIN`, `ACME_EMAIL`, `TZ`, `MANAGER_GATEWAY_SECRET` (see **Server on Linux**). On Yundera the platform supplies `PUID`/`PGID`/`TZ`/`APP_*`/`REF_*`/`DATA_ROOT`.

</details>

<details>
<summary><b>Bot requirements</b></summary>

Most public Discord bot repos work unmodified. The smoothest path is a repo that already ships a `Dockerfile` or `docker-compose.yml`; otherwise the manager detects the language and generates them. A bot should:

1. Be a Discord bot in a supported language (see Features).
2. Read its secrets (token, API keys) from environment variables or a config file.
3. Declare its dependencies (lock file, `requirements.txt`, `pom.xml`, etc.).

</details>

<details>
<summary><b>Security</b></summary>

- The Docker socket is mounted, which grants the manager full control of the host Docker daemon (root-equivalent). **Never expose the manager bare on the internet.**
- Standalone binds the UI to `127.0.0.1` and has no built-in login - reach it remotely only via a tunnel/VPN or the **Server on Linux** stack (Caddy + Authelia MFA).
- A bot never authenticates its own web UI; authentication lives at the deployment boundary. On Yundera, each bot is its own CasaOS app guarded by its AppShield gateway in OIDC mode (SSO from your CasaOS session); on the remote stack, public bot vhosts sit behind Authelia MFA by default (self-authenticating gateways are detected and skip it; per-bot override on the card); standalone binds to `127.0.0.1` with no gateway. See **How bots are reached**.
- On the remote stack, `MANAGER_GATEWAY_SECRET` makes the manager accept only Caddy-proxied (Authelia-passed) HTTP and WebSocket traffic; loopback and the token-authenticated bot update endpoints are exempt.
- Secrets are encrypted at rest with AES-256-CBC: sensitive per-bot env values (tokens, keys, passwords), user config-file bodies, and the credentials vault. The key comes from `ENV_ENCRYPTION_KEY`, or a key file generated under the data dir on first run.

</details>

<details>
<summary><b>Future enhancements</b></summary>

- [ ] Grey out OAuth-callback fields in the wizard when no public base is set
- [ ] Resource usage graphs
- [ ] Multiple Docker hosts support
- [ ] Bot templates / presets

</details>

## License

GNU
