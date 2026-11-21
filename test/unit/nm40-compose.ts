// The bot repo's docker-compose.yml (fully-modular-discord-bot f041540), comments left out.
export const BOT_COMPOSE = `name: fullymodulardiscordbot

services:
  fullymodulardiscordbot:
    image: ghcr.io/yundera/appshield:2.0.7
    container_name: fullymodulardiscordbot
    hostname: fullymodulardiscordbot
    restart: unless-stopped
    cpu_shares: 80
    healthcheck:
      test: ["CMD-SHELL", "curl -s -o /dev/null -w '%{http_code}' http://localhost:80/ | grep -qE '(200|301|302|403)'"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 30s
    user: "root"
    expose:
      - "80"
    environment:
      USER: "admin"
      PASSWORD: $APP_DEFAULT_PASSWORD
      BACKEND_HOST: "fullymodulardiscordbotapp"
      BACKEND_PORT: "8080"
      LISTEN_PORT: "80"
      ALLOWED_PATHS: "/guild,/auth,/assets"
      TZ: $TZ
    volumes:
      - type: bind
        source: $DATA_ROOT/AppData/fullymodulardiscordbot/appshield
        target: /data
    labels:
      caddy_0: fullymodulardiscordbot-\${APP_DOMAIN}
      caddy_0.import: gateway_tls
      caddy_0.reverse_proxy: "{{upstreams 80}}"
      caddy_1: fullymodulardiscordbot-\${APP_PUBLIC_IP_DASH}.nip.io
      caddy_1.import: gateway_tls
      caddy_1.reverse_proxy: "{{upstreams 80}}"
      caddy_2: fullymodulardiscordbot-\${APP_PUBLIC_IP_DASH}.sslip.io
      caddy_2.reverse_proxy: "{{upstreams 80}}"
    depends_on:
      - fullymodulardiscordbotapp
    networks:
      - internal
      - pcs

  fullymodulardiscordbotapp:
    image: ghcr.io/krizcold/fully-modular-discord-bot:latest
    container_name: fullymodulardiscordbotapp
    restart: unless-stopped
    stop_grace_period: 60s
    cpu_shares: 50
    environment:
      DISCORD_TOKEN: ''
      GUILD_ID: ''
      CLIENT_ID: ''
      BOT_MANAGER_API: $BOT_MANAGER_API
      BOT_MANAGER_INTERNAL_URL: $BOT_MANAGER_INTERNAL_URL
      BOT_ID: $APP_ID
      TZ: $TZ
    labels:
      fleet.control-port: "3928"
      fleet.transfer-port: "3929"
    volumes:
      - type: bind
        source: $DATA_ROOT/AppData/fullymodulardiscordbot/custom
        target: /app/custom
      - type: bind
        source: $DATA_ROOT/AppData/fullymodulardiscordbot/data
        target: /data
    networks:
      - internal
      - pcs
    expose:
      - 8080
    x-casaos:
      volumes:
        - container: /app/custom
          description:
            en_us: User overrides directory. Files placed here overlay /app/src at boot.
        - container: /data
          description:
            en_us: Persistent data directory for AppStore modules, applied-version, and bot data.

x-casaos:
  architectures:
    - amd64
    - arm64
  main: fullymodulardiscordbot
  build: fullymodulardiscordbotapp
  author: kriz_cold
  developer: kriz_cold
  icon: https://cdn.statically.io/gh/krizcold/AppStore/main/Apps/Fully-Modular-Discord-Bot/icon.png
  tagline:
    en_us: "(Test) A flexible Discord bot framework with Web-UI"
  category: Chat
  description:
    en_us: "A fully modular Discord bot with web-based management dashboard. Configure and monitor your bot from anywhere."
  title:
    en_us: "Fully Modular Discord Bot"
  port_map: "80"
`;
