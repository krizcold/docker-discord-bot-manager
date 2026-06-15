/**
 * Stateless config (de)serialization endpoints for the guided config builder.
 * The frontend keeps the raw body as the source of truth and uses these to keep
 * the guided form and the raw editor in live two-way sync, reusing the single
 * server-side serializer (configSerializer) so there is no duplicate JS logic.
 */
import { Router, Request, Response } from 'express';
import { parseConfig, serializeConfig, ConfigFormat, ConfigOp } from '../../config/configSerializer';

function isFormat(v: unknown): v is ConfigFormat {
  return v === 'json' || v === 'yaml';
}

export function createConfigRoutes(): Router {
  const router = Router();

  // POST /api/config/parse { format, body } -> { success, ok, data? | error? }
  router.post('/parse', (req: Request, res: Response) => {
    try {
      const { format, body } = req.body as { format?: unknown; body?: unknown };
      if (!isFormat(format) || typeof body !== 'string') {
        res.status(400).json({ success: false, error: 'format (json|yaml) and body are required' });
        return;
      }
      res.json({ success: true, ...parseConfig(format, body) });
    } catch (error) {
      console.error('[config route] error:', error);   // detail stays server-side; body may hold a token
      res.status(500).json({ success: false, error: 'Internal error' });
    }
  });

  // POST /api/config/serialize { format, body, ops } -> { success, body }
  router.post('/serialize', (req: Request, res: Response) => {
    try {
      const { format, body, ops } = req.body as { format?: unknown; body?: unknown; ops?: unknown };
      if (!isFormat(format) || typeof body !== 'string' || !Array.isArray(ops)) {
        res.status(400).json({ success: false, error: 'format (json|yaml), body, and ops[] are required' });
        return;
      }
      res.json({ success: true, body: serializeConfig(format, body, ops as ConfigOp[]) });
    } catch (error) {
      console.error('[config route] error:', error);   // detail stays server-side; body may hold a token
      res.status(500).json({ success: false, error: 'Internal error' });
    }
  });

  return router;
}
