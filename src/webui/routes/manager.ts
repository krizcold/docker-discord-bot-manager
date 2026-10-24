/**
 * Manager self-update routes (standalone docker mode only; gated inside selfUpdate).
 *   GET  /api/manager/version  - current commit, whether an update is available, the running update and the last outcome
 *   POST /api/manager/update   - pull + rebuild + recreate, streaming progress over /ws under the answered opId
 */
import { randomUUID } from 'crypto';
import { Router, Request, Response } from 'express';
import { WebSocketServer } from 'ws';
import { broadcastToClients } from '../server';
import { getManagerVersion, runManagerUpdate, isUpdateInProgress, updateBlocker } from '../../manager/selfUpdate';
import { getDeploymentMode } from '../../casaos/detector';

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
    if (await getDeploymentMode() !== 'docker') {
      res.status(400).json({ success: false, error: 'Updates are managed by the platform (Yundera/CasaOS).' });
      return;
    }
    if (isUpdateInProgress()) {
      res.status(409).json({ success: false, inProgress: true, error: 'An update is already in progress.' });
      return;
    }
    const blocker = updateBlocker();
    if (blocker) {
      res.status(400).json({ success: false, error: blocker });
      return;
    }
    const opId = randomUUID();
    res.json({ success: true, opId, message: 'Manager update started' });

    const emit = (msg: string, level: 'info' | 'warning' | 'error' | 'success' = 'info') => {
      console.log(`[ManagerUpdate] ${msg}`);
      broadcastToClients(wss, 'manager:log', { opId, line: msg, level });
    };

    broadcastToClients(wss, 'manager:update-started', { opId });
    runManagerUpdate(emit, (target) => broadcastToClients(wss, 'manager:restarting', { opId, target }), opId)
      // A restart replaces this process before the promise settles; the next
      // process answers the outcome on GET /version (lastUpdate).
      .then((outcome) => {
        if (outcome.state === 'pending') broadcastToClients(wss, 'manager:update-pending', { opId, message: outcome.message });
        else broadcastToClients(wss, 'manager:update-complete', { opId, state: outcome.state, message: outcome.message });
      })
      .catch((err) => {
        const error = String(err?.message || err);
        emit(error, 'error');
        broadcastToClients(wss, 'manager:update-failed', { opId, error });
      });
  });

  return router;
}
