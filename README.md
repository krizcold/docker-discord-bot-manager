# Discord Bot Manager

> **WORK IN PROGRESS** -- This project is under active development and is NOT ready for production use. APIs, configuration, file structure, and behavior may change without notice. Future updates will likely introduce breaking changes.

A Docker-based platform for deploying and managing multiple Discord bots from any GitHub repository or Docker image. Bots are organized as **sources** (a repo or image) and **instances** (a deployed bot built from a source); one source can back many instances.

## Features

- **Universal bot importer**: Import virtually any Discord bot repository. The manager detects the language, package manager, entry point, required backing services, and environment variables, and generates a Dockerfile and Docker Compose file when the repo ships none.
- **Multi-language support**: Node.js (npm/yarn/pnpm/bun), Python (pip/poetry/uv/pipenv/setuptools), Go, Java/Kotlin (Maven/Gradle/prebuilt JAR), Rust, and C# (.NET).
- **Source / instance model**: A cloned source repo can back multiple bot instances. Fetch a source once, rebuild its instances on demand.
- **Guided config builder**: For supported bots, a validated form is rendered over the bot's config file with live two-way Form/Raw sync. Bots without a manifest fall back to a raw editor.
- **Multi-service stacks**: Auto-wires backing services (PostgreSQL, MongoDB, MariaDB/MySQL, Redis) and Lavalink for music bots, plus a status-page sidecar for bots with no web UI.
- **Environment management**: Encrypted environment storage with an in-UI editor and a reusable Credentials Vault shared across instances.
- **Per-bot Console and Files**: An interactive shell and a file browser/editor scoped to each bot's container or its persistent data folder.
- **Live logs**: SSE log streaming and live build logs.
- **Lifecycle control**: Start, stop, restart, update (pull and rebuild), and uninstall, with non-blocking APIs and real-time WebSocket status.
- **Automatic updates**: Opt-in per-source update checking and per-instance scheduled rebuilds.
- **CasaOS / PCS integration**: Deploys bots as managed CasaOS apps on the Yundera platform, with Caddy routing, platform variable substitution, and metadata placement.

## Deployment

The manager auto-detects its deployment mode:

- **CasaOS / PCS** (Yundera platform): the primary target. Bots are deployed as managed CasaOS apps and their compose files are processed for the platform (`cpu_shares`, Caddy labels, the `pcs` network, platform variables, and `x-casaos` metadata).
- **Docker**: when no CasaOS environment is detected, bots are deployed with plain Docker Compose.

The provided `docker-compose.yml` deploys the manager itself behind the platform's `nginx-hash-lock` gateway. See `Documentation/BotManager/` for the full architecture.

## Requirements

- Docker and Docker Compose
- Access to the Docker socket (the manager controls containers through the host Docker daemon)

## Quick Start

The manager runs as a container with the host Docker socket mounted. On the Yundera platform it installs as a CasaOS app. To run it directly:

```bash
docker compose up -d
```

The app listens on port `8080` inside the container (`PORT`). On the platform it is reached through the gateway rather than a published host port.

Then, in the Web UI:

1. Pick a bot from the source sidebar, or add a repository URL or Docker image
2. Click **Install**, set a name, and fill in the detected environment variables and config
3. Click **Install & Run**

## Architecture

```
docker-discord-bot-manager/
├── src/
│   ├── index.ts          # Entry point
│   ├── types/            # TypeScript types
│   ├── detection/        # Language / framework / service detection
│   ├── templates/        # Dockerfile + compose generation, PCS processing, variable substitution
│   ├── compose/          # Compose parsing / processing
│   ├── config/           # Guided config builder (manifests, serializer, surfacing)
│   ├── env/              # Encrypted env storage + detection
│   ├── source/           # Source repository management
│   ├── instance/         # Bot instance management + scheduled updates
│   ├── naming/           # App naming + collision detection
│   ├── git/              # Git operations
│   ├── docker/           # Docker client + container lifecycle
│   ├── casaos/           # CasaOS / PCS integration + deployment-mode detection
│   ├── discord/          # Discord API (ID validation for guided config)
│   └── webui/
│       ├── server.ts     # Express + WebSocket server
│       ├── routes/       # API routes
│       └── public/       # Web UI
├── Dockerfile
├── docker-compose.yml
└── package.json
```

## API

The Web UI is backed by a REST API plus a WebSocket channel at `/ws`. Endpoints cover sources, instances, environment variables, config files, the credentials vault, per-bot console and file operations, and logs. See `Documentation/BotManager/UpdateSystem/Endpoints.md` for the full reference.

## WebSocket Events

Connect to `/ws` for real-time updates. Events include:

- `bot:status` - incremental status change for an instance
- `bot:created` / `bot:updated` / `bot:deleted`
- `bot:started` / `bot:stopped` / `bot:restarted`
- `bot:pulling` / `bot:built` / `bot:rebuilt` - build and update progress
- `bot:start-failed` / `bot:restart-failed` / `bot:build-failed` / `bot:pull-failed`

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8080` | Web server port (inside the container) |
| `DATA_DIR` | `/data` | Base data directory (set in the provided compose) |
| `NODE_ENV` | `production` | Node environment |

On the Yundera platform the manager also receives platform variables (`PUID`, `PGID`, `TZ`, `APP_DOMAIN`, `APP_PUBLIC_IP_DASH`, `APP_DEFAULT_PASSWORD`, `DATA_ROOT`, and the `REF_*` set). These are supplied by the platform; you do not set them for a standalone Docker run.

## Bot Requirements

The importer targets unmodified upstream bots, so most public Discord bot repositories work with no changes. The smoothest path is a repo that already ships a `Dockerfile` or `docker-compose.yml`; when neither is present, the manager detects the language and generates them.

A bot should:

1. Be a Discord bot in a supported language (see Features)
2. Read its secrets (bot token, API keys) from environment variables or a config file
3. Declare its dependencies (lock file, `requirements.txt`, `pom.xml`, etc.)

## Security Considerations

- The Docker socket is mounted, which grants the manager full control of the host Docker daemon
- Secrets (bot tokens, API keys, config files) are stored encrypted on disk
- The Web UI has no built-in per-route authentication. On the Yundera platform it is protected by the `nginx-hash-lock` gateway. For a standalone run, place it behind your own authenticating reverse proxy.

## Development

```bash
# Install dependencies
npm install

# Run in development mode
npm run dev

# Build TypeScript
npm run build

# Run production
npm start
```

## Future Enhancements

- [ ] Built-in Web UI authentication for standalone runs
- [ ] Resource usage graphs
- [ ] Multiple Docker hosts support
- [ ] Bot templates / presets

## License

GNU
