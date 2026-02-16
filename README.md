# Discord Bot Manager

> **WORK IN PROGRESS** -- This project is under active development and is NOT ready for production use. APIs, configuration, file structure, and behavior may change without notice. Future updates will likely introduce breaking changes.

A Docker-in-Docker application for managing multiple Discord bots from any GitHub repository.

## Features

- **Multi-Bot Management**: Run multiple Discord bots from different repositories
- **Docker-in-Docker**: Each bot runs in its own isolated container
- **GitHub Integration**: Clone bots directly from public or private repositories
- **Web UI**: Simple interface for managing bot lifecycle
- **Real-Time Updates**: WebSocket-based status updates
- **Resource Limits**: Memory and CPU limits per bot container

## Requirements

- Docker and Docker Compose
- Access to Docker socket (for Docker-in-Docker)

## Quick Start

1. **Build and run:**
   ```bash
   docker-compose up -d
   ```

2. **Access the Web UI (Running locally):**
   Open `http://localhost:8090` in your browser

3. **Add a bot:**
   - Click "+ Add Bot"
   - Enter a name for your bot
   - Paste the GitHub repository URL
   - (Optional) Add GitHub token for private repos
   - Click "Add Bot"

4. **Start your bot:**
   - Click "Start" on the bot card

## Architecture

```
discord-bot-manager/
├── src/
│   ├── index.ts              # Entry point
│   ├── types/                # TypeScript types
│   ├── docker/
│   │   ├── dockerClient.ts   # Docker API wrapper
│   │   └── containerManager.ts # Bot lifecycle management
│   ├── git/
│   │   └── repoManager.ts    # Git operations
│   └── webui/
│       ├── server.ts         # Express server
│       ├── routes/
│       │   └── bots.ts       # Bot API routes
│       └── public/
│           └── index.html    # Web UI
├── data/
│   ├── bots.json             # Bot registry
│   └── bots/{bot-id}/        # Cloned repositories
├── Dockerfile
├── docker-compose.yml
└── package.json
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/bots` | List all bots |
| POST | `/api/bots` | Create a new bot |
| GET | `/api/bots/:id` | Get bot details |
| PUT | `/api/bots/:id` | Update bot config |
| DELETE | `/api/bots/:id` | Delete a bot |
| POST | `/api/bots/:id/start` | Start bot container |
| POST | `/api/bots/:id/stop` | Stop bot container |
| POST | `/api/bots/:id/restart` | Restart bot container |
| POST | `/api/bots/:id/pull` | Pull latest code and rebuild |
| GET | `/api/bots/:id/logs` | Get container logs |
| GET | `/api/bots/:id/stats` | Get resource stats |

## WebSocket Events

Connect to `/ws` for real-time updates:

- `bot:created` - New bot added
- `bot:updated` - Bot config changed
- `bot:deleted` - Bot removed
- `bot:started` - Bot started
- `bot:stopped` - Bot stopped
- `bot:restarted` - Bot restarted
- `bot:rebuilt` - Code pulled and rebuilt

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8080` | Web server port |
| `DATA_DIR` | `/data/data` | Data directory path |
| `NODE_ENV` | `production` | Node environment |

## Bot Requirements

For a bot to work with this manager, it should:

1. Have a `package.json` with a `start` script
2. (Optional) Include a `Dockerfile` for custom builds
3. Accept environment variables for configuration

If no Dockerfile is present, a generic Node.js Dockerfile will be generated.

## Security Considerations

- Docker socket is mounted (required for container management)
- GitHub tokens are stored in the bot registry
- No authentication on Web UI by default (add reverse proxy for production)

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

- [ ] Authentication for Web UI
- [ ] Environment variable editor in UI
- [ ] Build logs streaming
- [ ] Resource usage graphs
- [ ] Multiple Docker hosts support
- [ ] Bot templates/presets

## License

GNU
