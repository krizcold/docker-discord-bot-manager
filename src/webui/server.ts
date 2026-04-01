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
import { setSourceBroadcast } from '../source/sourceUpdater';
import { setInstanceBroadcast } from '../instance/instanceUpdater';

const PORT = parseInt(process.env.PORT || '8080', 10);

export function createServer(): { app: Express; server: http.Server; wss: WebSocketServer } {
  const app = express();
  const server = http.createServer(app);

  // WebSocket server for real-time updates
  const wss = new WebSocketServer({ server, path: '/ws' });

  // Middleware
  app.use(cors());
  app.use(express.json());

  // Static files
  app.use(express.static(path.join(__dirname, 'public')));

  // API Routes
  app.use('/api/sources', createSourceRoutes(wss));
  app.use('/api/bots', createBotRoutes(wss));
  app.use('/api', createValidationRoutes());
  app.use('/api/vault', createVaultRoutes());
  app.use('/api/system', createSystemRoutes());

  // Wire source updater broadcast to WebSocket
  setSourceBroadcast((type, data) => broadcastToClients(wss, type, data));

  // Wire instance updater broadcast to WebSocket
  setInstanceBroadcast((type, data) => broadcastToClients(wss, type, data));

  // Health check
  app.get('/api/health', (req: Request, res: Response) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Serve index.html for all other routes (SPA support)
  app.get('*', (req: Request, res: Response) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });

  // Error handler
  app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
    console.error('[Server] Error:', err);
    res.status(500).json({ success: false, error: err.message });
  });

  // WebSocket handling
  wss.on('connection', (ws: WebSocket) => {
    console.log('[WebSocket] Client connected');

    ws.on('close', () => {
      console.log('[WebSocket] Client disconnected');
    });

    ws.on('error', (error) => {
      console.error('[WebSocket] Error:', error);
    });
  });

  return { app, server, wss };
}

export function startServer(): void {
  const { server } = createServer();

  server.listen(PORT, () => {
    console.log(`[Server] Discord Bot Manager running on port ${PORT}`);
    console.log(`[Server] Web UI: http://localhost:${PORT}`);
  });
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
