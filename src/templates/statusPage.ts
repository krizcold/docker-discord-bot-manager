/**
 * Status Page Sidecar
 *
 * Bots that expose no web port get an nginx:alpine sidecar serving a static
 * status page, so CasaOS has a tile to "Open". The service is injected by
 * processComposeForCasaOS and the HTML is written to the bind-mounted dir at
 * build time.
 */

import { BotConfig } from '../types';

/**
 * Build the status-page service object (plain YAML-ready record).
 * Injected before the per-service pass so it inherits Caddy labels,
 * webui_port, network, and PUID/TZ handling as the main service.
 */
export function buildStatusPageService(appName: string, botId: string): Record<string, unknown> {
  return {
    image: 'nginx:alpine',
    container_name: `${appName}-status`,
    restart: 'unless-stopped',
    cpu_shares: 10,
    expose: ['80'],
    networks: ['pcs'],
    volumes: [
      { type: 'bind', source: `/DATA/AppData/${appName}/status-page`, target: '/usr/share/nginx/html' }
    ],
    labels: {
      'managed-by': 'discord-bot-manager',
      'bot-id': botId,
      'service-type': 'status-page'
    }
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Generate the static status-page HTML for a bot. Self-contained (inline CSS,
 * no external assets), auto-refreshes, and links back to the Bot Manager UI
 * when the public domain is known.
 */
export function generateStatusPageHtml(bot: BotConfig): string {
  const title = escapeHtml(bot.titleName || bot.displayName);
  const domain = process.env.APP_DOMAIN || '';
  const scheme = process.env.REF_SCHEME || 'https';
  const managerUrl = domain ? `${scheme}://discordbotmanager-${domain}` : '';
  const managerLink = managerUrl
    ? `<a href="${escapeHtml(managerUrl)}">Open Discord Bot Manager</a>`
    : 'Managed by Discord Bot Manager';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="30">
  <title>${title}</title>
  <style>
    body { margin: 0; font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
      background: #1b1d21; color: #e6e6e6; display: flex; min-height: 100vh;
      align-items: center; justify-content: center; }
    .card { background: #25282d; border: 1px solid #34383f; border-radius: 12px;
      padding: 2.5rem 3rem; max-width: 480px; text-align: center; }
    h1 { margin: 0 0 0.5rem; font-size: 1.5rem; }
    .status { display: inline-block; margin: 0.75rem 0; padding: 0.3rem 0.9rem;
      border-radius: 999px; background: #1f3a2b; color: #6fd99a; font-size: 0.85rem; }
    p { color: #9aa0a6; line-height: 1.5; }
    a { color: #4db6ac; text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${title}</h1>
    <div class="status">Running</div>
    <p>This Discord bot has no web interface. It runs in the background and connects directly to Discord.</p>
    <p>${managerLink}</p>
  </div>
</body>
</html>
`;
}
