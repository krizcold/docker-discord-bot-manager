/**
 * Source API Routes
 * RESTful API for managing git sources
 */

import { Router, Request, Response } from 'express';
import { WebSocketServer } from 'ws';
import * as fs from 'fs';
import * as path from 'path';
import * as sourceManager from '../../source/sourceManager';
import { broadcastToClients } from '../server';
import { detectEnvVars, normalizeEnvLabel } from '../../env/manager';
import { detectBotType } from '../../detection';
import { CreateSourceRequest, UpdateSourceRequest } from '../../types';

export function createSourceRoutes(wss: WebSocketServer): Router {
  const router = Router();

  /**
   * GET /api/sources - List all sources
   */
  router.get('/', async (req: Request, res: Response) => {
    try {
      const sources = sourceManager.getAllSources();
      res.json({ success: true, sources });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  /**
   * POST /api/sources - Add a new source
   */
  router.post('/', async (req: Request, res: Response) => {
    try {
      const request: CreateSourceRequest = req.body;

      if (!request.url) {
        res.status(400).json({ success: false, error: 'url is required' });
        return;
      }

      // Check for duplicate URL
      const existing = sourceManager.findSourceByUrl(request.url);
      if (existing) {
        res.status(409).json({ success: false, error: 'A source with this URL already exists', source: existing });
        return;
      }

      const source = await sourceManager.createSource(request);
      broadcastToClients(wss, 'source:created', source);

      res.json({ success: true, source });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  /**
   * GET /api/sources/:id - Get source details
   */
  router.get('/:id', async (req: Request, res: Response) => {
    try {
      const source = sourceManager.getSource(req.params.id);
      if (!source) {
        res.status(404).json({ success: false, error: 'Source not found' });
        return;
      }

      const repoInfo = await sourceManager.getSourceRepoInfo(req.params.id);
      res.json({ success: true, source, repoInfo });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  /**
   * PUT /api/sources/:id - Update source
   */
  router.put('/:id', async (req: Request, res: Response) => {
    try {
      const update: UpdateSourceRequest = req.body;
      const source = sourceManager.updateSource(req.params.id, update);
      if (!source) {
        res.status(404).json({ success: false, error: 'Source not found' });
        return;
      }

      broadcastToClients(wss, 'source:updated', source);
      res.json({ success: true, source });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  /**
   * DELETE /api/sources/:id - Remove source
   */
  router.delete('/:id', async (req: Request, res: Response) => {
    try {
      const deleted = await sourceManager.deleteSource(req.params.id);
      if (!deleted) {
        res.status(404).json({ success: false, error: 'Source not found' });
        return;
      }

      broadcastToClients(wss, 'source:deleted', { id: req.params.id });
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  /**
   * POST /api/sources/:id/fetch - Trigger manual fetch
   */
  router.post('/:id/fetch', async (req: Request, res: Response) => {
    try {
      const source = sourceManager.getSource(req.params.id);
      if (!source) {
        res.status(404).json({ success: false, error: 'Source not found' });
        return;
      }

      const result = await sourceManager.fetchSource(req.params.id);

      if (result.hasUpdates) {
        const updatedSource = sourceManager.getSource(req.params.id);
        broadcastToClients(wss, 'source:updated', updatedSource);
      }

      res.json({ success: true, ...result });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  /**
   * GET /api/sources/:id/envs - Detect env vars from the source repo for the wizard.
   * ?scan=true forces the Tier 2 source-code scan.
   */
  router.get('/:id/envs', async (req: Request, res: Response) => {
    try {
      const source = sourceManager.getSource(req.params.id);
      if (!source) {
        res.status(404).json({ success: false, error: 'Source not found' });
        return;
      }

      const repoPath = sourceManager.getSourceRepoPath(req.params.id);
      if (!fs.existsSync(repoPath)) {
        res.json({ success: true, vars: [], tier2Ran: false, hasEnvExample: false, notCloned: true });
        return;
      }

      const scanSource = req.query.scan === 'true';
      const hasEnvExample = fs.existsSync(path.join(repoPath, '.env.example'));
      const detection = detectBotType(repoPath);

      const autoWiredKeys = new Set<string>();
      if (!detection.hasCompose) {
        for (const db of detection.databases) {
          if (db === 'postgres' || db === 'mariadb' || db === 'mysql') autoWiredKeys.add('DATABASE_URL');
          if (db === 'mongo') { autoWiredKeys.add('MONGO_URI'); autoWiredKeys.add('MONGODB_URI'); }
          if (db === 'redis') autoWiredKeys.add('REDIS_URL');
        }
        if (detection.needsLavalink) {
          autoWiredKeys.add('LAVALINK_HOST');
          autoWiredKeys.add('LAVALINK_PORT');
          autoWiredKeys.add('LAVALINK_PASSWORD');
        }
      }

      const vars = detectEnvVars(repoPath, { scanSource }).map(v =>
        autoWiredKeys.has(v.key) ? { ...v, autoWired: true } : v
      );

      // Env-first: surface a config file's top-level scalar keys as env vars, so
      // file-based bots that also read process.env (e.g. EvoBot) are fully
      // configurable without delivering a file. Token-family keys are required;
      // others show only when they have a pre-filled value (mirrors detectEnvVars).
      for (const cf of detection.configFiles || []) {
        for (const k of cf.keys) {
          if (vars.some(v => v.key === k.key)) continue;
          const required = k.key === detection.tokenVarName;
          if (!required && k.defaultValue.trim() === '') continue;
          vars.push({
            key: k.key,
            displayLabel: normalizeEnvLabel(k.key),
            description: '',
            defaultValue: k.defaultValue,
            required,
            source: 'config',
            sensitive: k.sensitive,
            autoWired: false,
          });
        }
      }

      // Always surface the bot's token var as a required field, even if the repo
      // declares it elsewhere (config file, hardcoded) and detection missed it.
      const tokenVar = detection.tokenVarName;
      if (tokenVar && !vars.some(v => v.key === tokenVar)) {
        vars.unshift({
          key: tokenVar,
          displayLabel: normalizeEnvLabel(tokenVar),
          description: '',
          defaultValue: '',
          required: true,
          source: 'env-example',
          sensitive: true,
          autoWired: false,
        });
      }

      res.json({ success: true, vars, configFiles: detection.configFiles || [], interactiveSetup: detection.interactiveSetup || null, tier2Ran: scanSource || !hasEnvExample, hasEnvExample });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  return router;
}
