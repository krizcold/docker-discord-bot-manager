/**
 * Manager self-update routes (standalone docker mode only; gated inside selfUpdate).
 *   GET  /api/manager/version  - current commit + whether an update is available
 *   POST /api/manager/update   - pull + rebuild + recreate, streaming progress over /ws
 */
import { Router, Request, Response } from 'express';
import { WebSocketServer } from 'ws';
import { broadcastToClients } from '../server';
import { getManagerVersion, runManagerUpdate, isUpdateInProgress } from '../../manager/selfUpdate';

export function createManagerRoutes(wss: WebSocketServer): Router {
  const router = Router();

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
    if (isUpdateInProgress()) {
      res.status(409).json({ success: false, error: 'An update is already in progress.' });
      return;
    }
    res.json({ success: true, message: 'Manager update started' });

    const emit = (msg: string, level: 'info' | 'warning' | 'error' | 'success' = 'info') => {
      console.log(`[ManagerUpdate] ${msg}`);
      broadcastToClients(wss, 'manager:log', { line: msg, level });
    };

    broadcastToClients(wss, 'manager:update-started', {});
    runManagerUpdate(emit, () => broadcastToClients(wss, 'manager:restarting', {}))
      // A restart replaces this process before the promise settles (the restart
      // signal is the onRestarting callback above). It resolves when the update
      // completed without needing a manager restart, and rejects on failure.
      .then(() => {
        broadcastToClients(wss, 'manager:update-complete', { message: 'Update complete - no manager restart was needed.' });
      })
      .catch((err) => {
        const error = String(err?.message || err);
        emit(error, 'error');
        broadcastToClients(wss, 'manager:update-failed', { error });
      });
  });

  return router;
}
