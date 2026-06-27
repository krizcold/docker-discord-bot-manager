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

> **Test status:** the containerized Windows path is implemented; the core deploy lifecycle is verified, the full functional pass is in progress. See [../Documentation/BotManager/StandaloneMode.md](../Documentation/BotManager/StandaloneMode.md) for the checklist.

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

Runs the manager UI on a public VPS behind **Caddy** (automatic TLS) + **Authelia** (login + TOTP/WebAuthn MFA). The manager mounts the Docker socket (root-equivalent), so it is never exposed bare - only Caddy listens on 80/443, and every request passes a 2FA login. TLS works **without a domain** via sslip.io, or with your own domain.

### Semi-automated setup (recommended)

```bash
git clone https://github.com/krizcold/docker-discord-bot-manager.git
cd docker-discord-bot-manager
sudo ./setup.sh
```

Semi-automated: it still asks you the choices that matter - **sslip.io or your own domain**, your **admin password**, and a **contact email** - but automates the tedious/error-prone parts: it installs Docker if missing, opens the firewall, **generates the Authelia secrets and the argon2 password hash**, writes `.env` and `users_database.yml`, starts the stack, and prints how to enroll MFA. Re-run it any time to reconfigure (including switching sslip.io <-> a domain).

> **Not yet live-tested** on a real VPS (sslip.io TLS needs a public IP); config-reviewed against Authelia 4.39.20 / caddy-docker-proxy / sslip.io. Ready to try, not proven.
>
> **sslip.io caveat:** it is a Public-Suffix-List *candidate*; if it ever lands on the PSL, browsers + Authelia reject the session cookie. **Use a real domain for anything you intend to keep.**

### Fully manual setup (advanced)

You do **not** need any of this if you ran `setup.sh` above - these are the same steps it performs, by hand (sslip.io example for VPS IP `203.0.113.5`):

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
   PUBLIC_HOST=bot.203-0-113-5.sslip.io
   AUTHELIA_HOST=auth.203-0-113-5.sslip.io
   COOKIE_DOMAIN=203-0-113-5.sslip.io
   ACME_EMAIL=you@example.com
   TZ=Europe/Madrid
   BOT_DOMAIN_BASE=203-0-113-5.sslip.io   # optional: per-bot HTTPS subdomains
   ```
   **Critical:** `PUBLIC_HOST` and `AUTHELIA_HOST` MUST be subdomains of `COOKIE_DOMAIN` - note the **dots** (`bot.203-0-113-5.sslip.io`, NOT `bot-203-0-113-5...`). sslip.io resolves either, but a hyphen makes them *siblings* of `COOKIE_DOMAIN`, so the browser won't share the Authelia session cookie and login loops forever. (sslip.io maps any `<label>.203-0-113-5.sslip.io` to `203.0.113.5`.)
   For a real domain: `PUBLIC_HOST=bot.example.com`, `AUTHELIA_HOST=auth.example.com`, `COOKIE_DOMAIN=example.com`, `BOT_DOMAIN_BASE=example.com`, and point `bot.` / `auth.` A records (plus a wildcard `*.` so per-bot subdomains resolve) at the VPS. You do not edit `authelia/configuration.yml` - it reads these from the env. Caddy issues a **separate** certificate per hostname on demand; there is no wildcard certificate (that would need a DNS-01 challenge, which this stack does not set up), so each bot subdomain triggers its own Let's Encrypt issuance.
5. **Run** and enroll MFA:
   ```bash
   docker compose -f docker-compose.remote.yml up -d
   # browse https://$PUBLIC_HOST -> log in -> enroll TOTP/WebAuthn.
   # no SMTP, so read the enrollment link from:
   docker exec authelia cat /data/notification.txt
   ```

With `BOT_DOMAIN_BASE` set, a bot's web UI is published at `https://<bot-name>.<BOT_DOMAIN_BASE>` with its own cert (so Discord-OAuth bots work without a domain); the **Open** link uses that URL. Bot vhosts are not behind Authelia (each bot self-auths).

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

## How bots are reached

When a bot exposes a web UI, the manager publishes it on a host port (auto-assigned from `20000-29999`, override with `BOT_HOST_PORT_BASE`/`BOT_HOST_PORT_RANGE`) and shows an **Open** link. Ports bind to `127.0.0.1` by default - a published port bypasses host firewalls, so this avoids exposing bots on a server; set `BOT_PORT_BIND=0.0.0.0` for trusted-LAN access. On a server with the remote stack, bots are instead reached via their HTTPS subdomain (see **Server on Linux**).

### Bot web-UI access (AppShield)

Bots that ship Yundera's [AppShield](https://github.com/Yundera/AppShield) gateway (image `ghcr.io/yundera/appshield`) guard their web UI, and the manager wires two ways in:

- **Access hash - your private shortcut.** Every bot gets an `AUTH_HASH`. The **Open** link carries it (`.../?hash=<hash>`), so opening a bot from the manager drops you straight in with no login. Keep the hash private (don't share the Open URL). Rotate it with **Regenerate** next to `AUTH_HASH` in the bot's **Env** editor, then rebuild the bot to apply - older Open links stop working.
- **Username / password - for sharing.** To give other people access, set `WEBUI_USER` and `WEBUI_PASSWORD` in the bot's **Env** editor and rebuild. Anyone who opens the bot's URL without the hash then gets a login form. Both are empty by default (login off, hash-only), and they appear in the Env editor for any bot whose compose uses them.

AppShield needs no CasaOS or platform - it runs as a plain sidecar in front of the bot. It does not terminate TLS, so on a public server it sits behind the remote stack's Caddy (see **Server on Linux**) for HTTPS; locally it is plain HTTP on `127.0.0.1`.

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

The Web UI is backed by a REST API plus a WebSocket channel at `/ws`. Endpoints cover sources, instances, environment variables, config files, the credentials vault, per-bot console and file operations, and logs. See `../Documentation/BotManager/UpdateSystem/Endpoints.md` for the full reference.

WebSocket events include: `bot:status`, `bot:created`/`updated`/`deleted`, `bot:started`/`stopped`/`restarted`, `bot:pulling`/`built`/`rebuilt`, and the matching `*-failed` events.

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
| `NODE_ENV` | `production` | Node environment |

Remote mode adds `PUBLIC_HOST`, `AUTHELIA_HOST`, `COOKIE_DOMAIN`, `ACME_EMAIL`, `TZ` (see **Server on Linux**). On Yundera the platform supplies `PUID`/`PGID`/`TZ`/`APP_*`/`REF_*`/`DATA_ROOT`.

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
- Each managed bot's own web UI is guarded by its AppShield gateway - a private access hash (used by the **Open** link) plus an optional shared username/password. See **How bots are reached**.
- Secrets (bot tokens, API keys, config files) are stored encrypted on disk.

</details>

<details>
<summary><b>Future enhancements</b></summary>

- [ ] Live-test + harden the remote (Contabo) stack
- [ ] Grey out OAuth-callback fields in the wizard when no public base is set
- [ ] Resource usage graphs
- [ ] Multiple Docker hosts support
- [ ] Bot templates / presets

</details>

## License

GNU
