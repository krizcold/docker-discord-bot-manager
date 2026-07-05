/**
 * Manager self-update routes (standalone docker mode only; gated inside selfUpdate).
 *   GET  /api/manager/version  - current commit + whether an update is available
 *   POST /api/manager/update   - pull + rebuild + recreate, streaming progress over /ws
 */
import { Router, Request, Response } from 'express';
import { WebSocketServer } from 'ws';
import { broadcastToClients } from '../server';
import { getManagerVersion, runManagerUpdate } from '../../manager/selfUpdate';

export function createManagerRoutes(wss: WebSocketServer): Router {
  const router = Router();
  let updating = false;

  router.get('/version', async (_req: Request, res: Response) => {
    try {
      res.json({ success: true, ...(await getManagerVersion()) });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  router.post('/update', async (_req: Request, res: Response) => {
    const version = await getManagerVersion();
    if (!version.supported) {
      res.status(400).json({ success: false, error: version.reason || 'Self-update is not available here.' });
      return;
    }
    if (updating) {
      res.status(409).json({ success: false, error: 'An update is already in progress.' });
      return;
    }
    updating = true;
    res.json({ success: true, message: 'Manager update started' });

    const emit = (msg: string, level: 'info' | 'warning' | 'error' | 'success' = 'info') => {
      console.log(`[ManagerUpdate] ${msg}`);
      broadcastToClients(wss, 'manager:log', { line: msg, level });
    };

    broadcastToClients(wss, 'manager:update-started', {});
    runManagerUpdate(emit, () => broadcastToClients(wss, 'manager:restarting', {}))
      // The success path replaces this process (a detached one-shot recreates the
      // container), so runManagerUpdate only ever rejects here (on failure); the
      // restart signal is sent via the onRestarting callback above instead.
      .catch((err) => {
        updating = false;
        const error = String(err?.message || err);
        emit(error, 'error');
        broadcastToClients(wss, 'manager:update-failed', { error });
      });
  });

  return router;
}
