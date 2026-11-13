/**
 * Web UI Server
 * Express server for Discord Bot Manager
 */

import express, { Express, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import path from 'path';
import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import { createBotRoutes, createSystemRoutes, createValidationRoutes } from './routes/bots';
import { createSourceRoutes } from './routes/sources';
import { createVaultRoutes } from './routes/vault';
import { createConfigRoutes } from './routes/config';
import { createDiscordRoutes } from './routes/discord';
import { createManagerRoutes } from './routes/manager';
import { setSourceBroadcast } from '../source/sourceUpdater';
import { setInstanceBroadcast } from '../instance/instanceUpdater';
import { setContainerBroadcast } from '../docker/containerManager';
import { reconcileNow } from '../docker/stateReconciler';
import { handleTerminalMessage, closeTerminal } from './terminal';
import { jsonBodies } from './fsWriteBody';
import type { Gate } from './gate';

const PORT = parseInt(process.env.PORT || '8080', 10);

export function createServer(gate: Gate): { app: Express; server: http.Server; wss: WebSocketServer } {
  const app = express();
  const server = http.createServer(app);

  // WebSocket server for real-time updates
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const pathname = (req.url || '').split('?')[0];
    if (pathname !== '/ws' || (gate.active && !gate.allows(req))) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  app.use(gate.middleware);

  // Middleware
  app.use(cors());
  app.use(jsonBodies());

  // Static files. HTML is served no-cache so a post-update reload always fetches the
  // new SPA; other assets keep ETag/Last-Modified revalidation (304 when unchanged).
  app.use(express.static(path.join(__dirname, 'public'), {
    etag: true,
    lastModified: true,
    setHeaders: (res: Response, filePath: string) => {
      if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    },
  }));

  // API Routes
  app.use('/api/sources', createSourceRoutes(wss));
  app.use('/api/bots', createBotRoutes(wss));
  app.use('/api', createValidationRoutes());
  app.use('/api/vault', createVaultRoutes());
  app.use('/api/system', createSystemRoutes());
  app.use('/api/config', createConfigRoutes());
  app.use('/api/discord', createDiscordRoutes());
  app.use('/api/manager', createManagerRoutes(wss));

  // Wire source updater broadcast to WebSocket
  setSourceBroadcast((type, data) => broadcastToClients(wss, type, data));

  // Wire instance updater broadcast to WebSocket
  setInstanceBroadcast((type, data) => broadcastToClients(wss, type, data));

  // Wire container manager status broadcasts (fires on every bot status transition)
  setContainerBroadcast((type, data) => broadcastToClients(wss, type, data));

  // Health check
  app.get('/api/health', (req: Request, res: Response) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Serve index.html for all other routes (SPA support). No-cache so the browser
  // revalidates the shell every load and picks up a new build after an update.
  app.get('*', (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });

  // Error handler
  app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
    console.error('[Server] Error:', err);
    res.status(500).json({ success: false, error: err.message });
  });

  // WebSocket handling
  wss.on('connection', (ws: WebSocket) => {
    const wasEmpty = wss.clients.size === 1;
    console.log(`[WebSocket] Client connected (${wss.clients.size} total)`);
    if (wasEmpty) reconcileNow();

    ws.on('message', (raw) => {
      // Terminal control messages are multiplexed on this socket; broadcasts are
      // server -> client only, so any other inbound message is ignored.
      try { handleTerminalMessage(ws, raw.toString()); } catch (err) { console.error('[WebSocket] terminal message error:', err); }
    });

    ws.on('close', () => {
      closeTerminal(ws);
      console.log(`[WebSocket] Client disconnected (${wss.clients.size} remaining)`);
    });

    ws.on('error', (error) => {
      console.error('[WebSocket] Error:', error);
    });
  });

  return { app, server, wss };
}

export function startServer(gate: Gate): { wss: WebSocketServer } {
  const { server, wss } = createServer(gate);

  server.listen(PORT, () => {
    console.log(`[Server] Discord Bot Manager running on port ${PORT}`);
    console.log(`[Server] Web UI: http://localhost:${PORT}`);
  });

  return { wss };
}

/**
 * Broadcast message to all connected WebSocket clients
 */
export function broadcastToClients(wss: WebSocketServer, type: string, data: unknown): void {
  const message = JSON.stringify({ type, data, timestamp: new Date().toISOString() });

  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}
