/**
 * Discord ID validation endpoint for the guided config form. The bot's own token
 * is supplied by the caller (the wizard already holds it in the form), used only
 * to query the Discord REST API, and never returned to the client.
 */
import { Router, Request, Response } from 'express';
import { validateDiscordId, ValidateKind } from '../../discord/validator';

const KINDS: ValidateKind[] = ['user', 'role', 'channel', 'guild', 'member'];

export function createDiscordRoutes(): Router {
  const router = Router();

  // POST /api/discord/validate { token, kind, id, guildId? } -> { success, status, name?, avatarUrl?, extra?, reason? }
  router.post('/validate', async (req: Request, res: Response) => {
    try {
      const { token, kind, id, guildId } = req.body as {
        token?: string; kind?: ValidateKind; id?: string; guildId?: string;
      };
      if (typeof token !== 'string' || !token) {
        res.json({ success: true, status: 'cannot_validate', reason: 'token' });
        return;
      }
      if (!kind || !KINDS.includes(kind)) {
        res.status(400).json({ success: false, error: 'kind must be user|role|channel|guild' });
        return;
      }
      const result = await validateDiscordId(token, kind, String(id || ''), guildId ? String(guildId) : undefined);
      res.json({ success: true, ...result });
    } catch {
      res.json({ success: true, status: 'cannot_validate', reason: 'network' });
    }
  });

  return router;
}
