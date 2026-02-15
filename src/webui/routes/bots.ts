/**
 * Bot API Routes
 * RESTful API for managing Discord bots
 */

import { Router, Request, Response } from 'express';
import { WebSocketServer } from 'ws';
import * as containerManager from '../../docker/containerManager';
import * as repoManager from '../../git/repoManager';
import * as envManager from '../../env/manager';
import { getDeploymentInfo, setDeploymentMode } from '../../casaos/detector';
import { broadcastToClients } from '../server';
import { CreateBotRequest, UpdateBotRequest, DeploymentMode } from '../../types';
import { logCollectors } from '../../build/logCollector';

export function createBotRoutes(wss: WebSocketServer): Router {
  const router = Router();

  /**
   * GET /api/bots - List all bots
   */
  router.get('/', async (req: Request, res: Response) => {
    try {
      const bots = containerManager.getAllBots();
      res.json({ success: true, bots });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  /**
   * POST /api/bots - Create a new bot
   *
   * Supports two source types:
   * - git (default): { name, url, branch?, envVars? }
   *   URL should include token if private: https://TOKEN@github.com/owner/repo.git
   * - docker-image: { name, sourceType: 'docker-image', imageRef, envVars? }
   */
  router.post('/', async (req: Request, res: Response) => {
    try {
      const request: CreateBotRequest = req.body;

      if (!request.name) {
        res.status(400).json({ success: false, error: 'Name is required' });
        return;
      }

      const sourceType = request.sourceType || 'git';

      // Validate based on source type
      if (sourceType === 'git') {
        if (!request.url) {
          res.status(400).json({ success: false, error: 'url is required for git source type' });
          return;
        }
      } else if (sourceType === 'docker-image') {
        if (!request.imageRef) {
          res.status(400).json({ success: false, error: 'imageRef is required for docker-image source type' });
          return;
        }
      } else {
        res.status(400).json({ success: false, error: 'Invalid sourceType. Must be "git" or "docker-image"' });
        return;
      }

      const bot = await containerManager.createBot(request);
      broadcastToClients(wss, 'bot:created', bot);

      res.json({ success: true, bot });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  /**
   * GET /api/bots/:id - Get bot details
   */
  router.get('/:id', async (req: Request, res: Response) => {
    try {
      const bot = containerManager.getBot(req.params.id);

      if (!bot) {
        res.status(404).json({ success: false, error: 'Bot not found' });
        return;
      }

      // Get additional repo info (only for git source)
      let repoInfo = null;
      if (bot.sourceType === 'git' || !bot.sourceType) {
        try {
          repoInfo = await repoManager.getRepoInfo(req.params.id);
        } catch (err) {
          // Repo might not exist for docker-image bots
        }
      }

      res.json({ success: true, bot, repoInfo });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  /**
   * PUT /api/bots/:id - Update bot configuration
   */
  router.put('/:id', async (req: Request, res: Response) => {
    try {
      const update: UpdateBotRequest = req.body;
      const bot = await containerManager.updateBot(req.params.id, update);

      if (!bot) {
        res.status(404).json({ success: false, error: 'Bot not found' });
        return;
      }

      broadcastToClients(wss, 'bot:updated', bot);
      res.json({ success: true, bot });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  /**
   * DELETE /api/bots/:id - Delete a bot
   */
  router.delete('/:id', async (req: Request, res: Response) => {
    try {
      const success = await containerManager.deleteBot(req.params.id);

      if (!success) {
        res.status(404).json({ success: false, error: 'Bot not found' });
        return;
      }

      broadcastToClients(wss, 'bot:deleted', { id: req.params.id });
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  /**
   * POST /api/bots/:id/start - Start a bot
   */
  router.post('/:id/start', async (req: Request, res: Response) => {
    try {
      const result = await containerManager.startBot(req.params.id);

      if (!result.success) {
        res.status(400).json(result);
        return;
      }

      const bot = containerManager.getBot(req.params.id);
      broadcastToClients(wss, 'bot:started', bot);

      res.json({ success: true, bot });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  /**
   * POST /api/bots/:id/stop - Stop a bot
   */
  router.post('/:id/stop', async (req: Request, res: Response) => {
    try {
      const result = await containerManager.stopBot(req.params.id);

      if (!result.success) {
        res.status(400).json(result);
        return;
      }

      const bot = containerManager.getBot(req.params.id);
      broadcastToClients(wss, 'bot:stopped', bot);

      res.json({ success: true, bot });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  /**
   * POST /api/bots/:id/restart - Restart a bot
   */
  router.post('/:id/restart', async (req: Request, res: Response) => {
    try {
      const result = await containerManager.restartBot(req.params.id);

      if (!result.success) {
        res.status(400).json(result);
        return;
      }

      const bot = containerManager.getBot(req.params.id);
      broadcastToClients(wss, 'bot:restarted', bot);

      res.json({ success: true, bot });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  /**
   * POST /api/bots/:id/pull - Pull latest code and rebuild (git source only)
   */
  router.post('/:id/pull', async (req: Request, res: Response) => {
    try {
      const bot = containerManager.getBot(req.params.id);
      if (!bot) {
        res.status(404).json({ success: false, error: 'Bot not found' });
        return;
      }

      // Only git source type can pull updates
      if (bot.sourceType === 'docker-image') {
        res.status(400).json({ success: false, error: 'Cannot pull updates for docker-image source type. Use docker pull instead.' });
        return;
      }

      broadcastToClients(wss, 'bot:pulling', { id: req.params.id });

      const result = await containerManager.pullAndRebuild(req.params.id);

      if (!result.success) {
        res.status(400).json(result);
        return;
      }

      const updatedBot = containerManager.getBot(req.params.id);
      broadcastToClients(wss, 'bot:rebuilt', updatedBot);

      res.json({ success: true, bot: updatedBot });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  /**
   * POST /api/bots/:id/build - Build bot image without starting (non-blocking)
   * Returns immediately. Stream progress via GET /api/bots/:id/build-logs (SSE).
   */
  router.post('/:id/build', async (req: Request, res: Response) => {
    try {
      const bot = containerManager.getBot(req.params.id);
      if (!bot) {
        res.status(404).json({ success: false, error: 'Bot not found' });
        return;
      }

      // Return immediately — build runs in background
      res.json({ success: true, message: 'Build started' });

      // Fire-and-forget: build in background, broadcast result when done
      const botId = req.params.id;
      containerManager.buildBot(botId).then((result) => {
        const updatedBot = containerManager.getBot(botId);
        if (result.success) {
          broadcastToClients(wss, 'bot:built', updatedBot);
        } else {
          broadcastToClients(wss, 'bot:build-failed', { id: botId, error: result.error });
        }
      }).catch((err) => {
        console.error(`[API] Unexpected build error for bot ${botId}:`, err);
        broadcastToClients(wss, 'bot:build-failed', { id: botId, error: String(err) });
      });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  /**
   * GET /api/bots/:id/build-logs - Stream build logs via Server-Sent Events
   * Adapted from Yundera GitHub Compiler's SSE log streaming pattern.
   */
  router.get('/:id/build-logs', (req: Request, res: Response) => {
    const bot = containerManager.getBot(req.params.id);
    if (!bot) {
      res.status(404).json({ success: false, error: 'Bot not found' });
      return;
    }

    // Set up SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });

    // Send initial connection message
    res.write(`data: ${JSON.stringify({ message: `Connected to build logs for ${bot.name}`, type: 'system' })}\n\n`);

    // Get log collector (creates one if needed)
    const logCollector = logCollectors.get(req.params.id);

    // Send any existing logs (so late-joiners see history)
    const existingLogs = logCollector.getLogs();
    for (const log of existingLogs) {
      res.write(`data: ${JSON.stringify(log)}\n\n`);
    }

    // Listen for new logs in real-time
    const onLog = (log: unknown) => {
      if (res.writable) {
        res.write(`data: ${JSON.stringify(log)}\n\n`);
      }
    };

    logCollector.on('log', onLog);

    // Keep connection alive with periodic pings
    const keepAlive = setInterval(() => {
      if (res.writable) {
        res.write(`data: ${JSON.stringify({ message: '', type: 'ping' })}\n\n`);
      } else {
        clearInterval(keepAlive);
      }
    }, 15000);

    // Clean up on client disconnect
    req.on('close', () => {
      clearInterval(keepAlive);
      logCollector.removeListener('log', onLog);
      res.end();
    });
  });

  /**
   * GET /api/bots/:id/logs - Get bot logs
   */
  router.get('/:id/logs', async (req: Request, res: Response) => {
    try {
      const tail = parseInt(req.query.tail as string) || 100;
      const result = await containerManager.getBotLogs(req.params.id, tail);

      if (!result.success) {
        res.status(400).json(result);
        return;
      }

      res.json({ success: true, logs: result.logs });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  /**
   * GET /api/bots/:id/stats - Get bot resource stats
   */
  router.get('/:id/stats', async (req: Request, res: Response) => {
    try {
      const result = await containerManager.getBotStats(req.params.id);

      if (!result.success) {
        res.status(400).json(result);
        return;
      }

      res.json({ success: true, stats: result.stats });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  /**
   * GET /api/bots/:id/files - List bot repository files (git source only)
   */
  router.get('/:id/files', async (req: Request, res: Response) => {
    try {
      const bot = containerManager.getBot(req.params.id);
      if (!bot) {
        res.status(404).json({ success: false, error: 'Bot not found' });
        return;
      }

      // Only git source type has files
      if (bot.sourceType === 'docker-image') {
        res.json({ success: true, files: [], message: 'No files for docker-image source type' });
        return;
      }

      const files = repoManager.listRepoFiles(req.params.id);
      res.json({ success: true, files });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  /**
   * GET /api/bots/:id/updates - Check for updates (git source only)
   */
  router.get('/:id/updates', async (req: Request, res: Response) => {
    try {
      const bot = containerManager.getBot(req.params.id);
      if (!bot) {
        res.status(404).json({ success: false, error: 'Bot not found' });
        return;
      }

      // Only git source type can check for updates
      if (bot.sourceType === 'docker-image') {
        res.json({
          success: true,
          hasUpdates: false,
          message: 'Cannot check updates for docker-image source type. Check registry for new image versions.'
        });
        return;
      }

      const updates = await repoManager.checkForUpdates(req.params.id);
      res.json({ success: true, ...updates });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  /**
   * GET /api/bots/:id/env - Get environment variables info
   */
  router.get('/:id/env', async (req: Request, res: Response) => {
    try {
      const bot = containerManager.getBot(req.params.id);
      if (!bot) {
        res.status(404).json({ success: false, error: 'Bot not found' });
        return;
      }

      const envVars = envManager.getEnvVarsInfo(req.params.id);
      const validation = envManager.hasRequiredEnvVars(req.params.id);

      // Also parse .env.example from repo if git source
      let envExample: Array<{ key: string; description: string; defaultValue: string }> = [];
      if (bot.sourceType !== 'docker-image') {
        try {
          const repoPath = repoManager.getRepoPath(req.params.id);
          envExample = envManager.parseEnvExample(repoPath);
        } catch (err) {
          // Repo might not exist yet
        }
      }

      res.json({
        success: true,
        envVars,
        envExample,
        valid: validation.valid,
        missing: validation.missing
      });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  /**
   * PUT /api/bots/:id/env - Update environment variables
   */
  router.put('/:id/env', async (req: Request, res: Response) => {
    try {
      const bot = containerManager.getBot(req.params.id);
      if (!bot) {
        res.status(404).json({ success: false, error: 'Bot not found' });
        return;
      }

      const { vars } = req.body as { vars: Record<string, string> };
      if (!vars || typeof vars !== 'object') {
        res.status(400).json({ success: false, error: 'vars object is required' });
        return;
      }

      envManager.setEnvVars(req.params.id, vars);

      // Also update bot config
      await containerManager.updateBot(req.params.id, { envVars: vars });

      const validation = envManager.hasRequiredEnvVars(req.params.id);

      broadcastToClients(wss, 'bot:updated', containerManager.getBot(req.params.id));
      res.json({
        success: true,
        valid: validation.valid,
        missing: validation.missing
      });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  /**
   * POST /api/bots/:id/request-update - Bot requests its own update (called by bots)
   * Header: X-Bot-Token: {token}
   */
  router.post('/:id/request-update', async (req: Request, res: Response) => {
    try {
      const botId = req.params.id;
      const token = req.headers['x-bot-token'] as string;

      if (!token) {
        res.status(401).json({ success: false, error: 'X-Bot-Token header required' });
        return;
      }

      const bot = containerManager.getBot(botId);
      if (!bot) {
        res.status(404).json({ success: false, error: 'Bot not found' });
        return;
      }

      // Validate token
      if (bot.updateToken !== token) {
        res.status(403).json({ success: false, error: 'Invalid token' });
        return;
      }

      console.log(`[API] Bot ${botId} requested self-update`);
      broadcastToClients(wss, 'bot:update-requested', { id: botId });

      // Perform update
      const result = await containerManager.pullAndRebuild(botId);

      if (!result.success) {
        res.status(400).json(result);
        return;
      }

      broadcastToClients(wss, 'bot:rebuilt', containerManager.getBot(botId));
      res.json({ success: true, message: 'Update completed' });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  return router;
}

/**
 * System API Routes
 * Routes for deployment mode and system configuration
 */
export function createSystemRoutes(): Router {
  const router = Router();

  /**
   * GET /api/system/deployment - Get deployment mode info
   */
  router.get('/deployment', async (req: Request, res: Response) => {
    try {
      const info = await getDeploymentInfo();
      res.json({ success: true, ...info });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  /**
   * PUT /api/system/deployment - Set deployment mode
   */
  router.put('/deployment', async (req: Request, res: Response) => {
    try {
      const { mode } = req.body as { mode: DeploymentMode };
      if (!mode || !['casaos', 'docker'].includes(mode)) {
        res.status(400).json({ success: false, error: 'Invalid mode. Must be "casaos" or "docker"' });
        return;
      }

      setDeploymentMode(mode);
      const info = await getDeploymentInfo();
      res.json({ success: true, ...info });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  return router;
}
