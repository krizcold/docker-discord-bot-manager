/**
 * Bot API Routes
 * RESTful API for managing Discord bot instances
 */

import { Router, Request, Response } from 'express';
import { WebSocketServer } from 'ws';
import { spawn, execSync } from 'child_process';
import * as containerManager from '../../docker/containerManager';
import * as repoManager from '../../git/repoManager';
import * as envManager from '../../env/manager';
import * as sourceManager from '../../source/sourceManager';
import { getDeploymentInfo, setDeploymentMode } from '../../casaos/detector';
import { broadcastToClients } from '../server';
import { DeploymentMode } from '../../types';
import { logCollectors } from '../../build/logCollector';
import { validateName, resolveNames, checkFolderReuse } from '../../naming';

export function createBotRoutes(wss: WebSocketServer): Router {
  const router = Router();

  /**
   * GET /api/bots - List all bot instances
   * Joins source info for each instance.
   */
  router.get('/', async (req: Request, res: Response) => {
    try {
      const bots = containerManager.getAllBots();

      // Join source info
      const botsWithSource = bots.map(bot => {
        let source = null;
        let updateAvailable = false;

        if (bot.sourceId) {
          source = sourceManager.getSource(bot.sourceId);
          if (source && bot.lastBuiltCommit && source.lastCommitHash) {
            updateAvailable = bot.lastBuiltCommit !== source.lastCommitHash;
          }
        }

        return {
          ...bot,
          source: source ? { id: source.id, composeName: source.composeName, lastCommitHash: source.lastCommitHash, url: source.url } : null,
          updateAvailable,
        };
      });

      res.json({ success: true, bots: botsWithSource });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  /**
   * POST /api/bots - Create a new bot instance
   *
   * Two formats:
   * - From source: { sourceId, displayName?, envVars? }
   * - Docker image: { sourceType: 'docker-image', displayName, imageRef, envVars? }
   *
   * Also accepts legacy format: { name, sourceType?, url?, branch?, imageRef?, envVars? }
   */
  router.post('/', async (req: Request, res: Response) => {
    try {
      const body = req.body;

      // Docker image flow
      if (body.sourceType === 'docker-image') {
        const displayName = body.displayName || body.name;
        if (!displayName) {
          res.status(400).json({ success: false, error: 'displayName is required' });
          return;
        }
        if (!body.imageRef) {
          res.status(400).json({ success: false, error: 'imageRef is required for docker-image source type' });
          return;
        }

        const bot = await containerManager.createDockerImageInstance({
          displayName,
          imageRef: body.imageRef,
          envVars: body.envVars,
        });
        broadcastToClients(wss, 'bot:created', bot);
        res.json({ success: true, bot });
        return;
      }

      // Source-based flow
      if (body.sourceId) {
        const bot = await containerManager.createInstance({
          sourceId: body.sourceId,
          displayName: body.displayName,
          envVars: body.envVars,
          reuseFromInstanceId: body.reuseFromInstanceId,
        });
        broadcastToClients(wss, 'bot:created', bot);
        res.json({ success: true, bot });
        return;
      }

      // Legacy flow: { name, url, branch? }
      if (body.name || body.url) {
        const name = body.name || body.displayName;
        if (!name) {
          res.status(400).json({ success: false, error: 'Name is required' });
          return;
        }
        if (!body.url) {
          res.status(400).json({ success: false, error: 'url or sourceId is required' });
          return;
        }

        const bot = await containerManager.createBot({
          name,
          url: body.url,
          branch: body.branch,
          envVars: body.envVars,
        });
        broadcastToClients(wss, 'bot:created', bot);
        res.json({ success: true, bot });
        return;
      }

      res.status(400).json({ success: false, error: 'Must provide sourceId, url, or sourceType=docker-image' });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  /**
   * GET /api/bots/:id - Get bot instance details
   */
  router.get('/:id', async (req: Request, res: Response) => {
    try {
      const bot = containerManager.getBot(req.params.id);
      if (!bot) {
        res.status(404).json({ success: false, error: 'Bot not found' });
        return;
      }

      // Source info
      let source = null;
      let repoInfo = null;
      let updateAvailable = false;

      if (bot.sourceId) {
        source = sourceManager.getSource(bot.sourceId);
        if (source) {
          repoInfo = await sourceManager.getSourceRepoInfo(bot.sourceId);
          if (bot.lastBuiltCommit && source.lastCommitHash) {
            updateAvailable = bot.lastBuiltCommit !== source.lastCommitHash;
          }
        }
      }

      res.json({ success: true, bot, source, repoInfo, updateAvailable });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  /**
   * PUT /api/bots/:id - Update bot instance configuration
   */
  router.put('/:id', async (req: Request, res: Response) => {
    try {
      const update = req.body;
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
   * PUT /api/bots/:id/source - Reassign instance to a different source
   */
  router.put('/:id/source', async (req: Request, res: Response) => {
    try {
      const { sourceId } = req.body as { sourceId: string };
      if (!sourceId) {
        res.status(400).json({ success: false, error: 'sourceId is required' });
        return;
      }

      const bot = containerManager.reassignSource(req.params.id, sourceId);
      if (!bot) {
        res.status(404).json({ success: false, error: 'Bot or source not found' });
        return;
      }

      broadcastToClients(wss, 'bot:updated', bot);
      res.json({ success: true, bot });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  /**
   * DELETE /api/bots/:id - Delete a bot instance
   */
  router.delete('/:id', async (req: Request, res: Response) => {
    try {
      const keepData = req.query.keepData === 'true';
      const success = await containerManager.deleteBot(req.params.id, keepData);
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
   * POST /api/bots/:id/start - Start a bot (non-blocking)
   */
  router.post('/:id/start', async (req: Request, res: Response) => {
    try {
      const bot = containerManager.getBot(req.params.id);
      if (!bot) {
        res.status(404).json({ success: false, error: 'Bot not found' });
        return;
      }

      res.json({ success: true, message: 'Starting bot' });

      const botId = req.params.id;
      containerManager.startBot(botId).then((result) => {
        const updatedBot = containerManager.getBot(botId);
        if (result.success) {
          broadcastToClients(wss, 'bot:started', updatedBot);
        } else {
          broadcastToClients(wss, 'bot:start-failed', { id: botId, error: result.error });
        }
      }).catch((err) => {
        broadcastToClients(wss, 'bot:start-failed', { id: botId, error: String(err) });
      });
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
   * POST /api/bots/:id/restart - Restart a bot (non-blocking)
   */
  router.post('/:id/restart', async (req: Request, res: Response) => {
    try {
      const bot = containerManager.getBot(req.params.id);
      if (!bot) {
        res.status(404).json({ success: false, error: 'Bot not found' });
        return;
      }

      res.json({ success: true, message: 'Restarting bot' });

      const botId = req.params.id;
      containerManager.restartBot(botId).then((result) => {
        const updatedBot = containerManager.getBot(botId);
        if (result.success) {
          broadcastToClients(wss, 'bot:restarted', updatedBot);
        } else {
          broadcastToClients(wss, 'bot:restart-failed', { id: botId, error: result.error });
        }
      }).catch((err) => {
        broadcastToClients(wss, 'bot:restart-failed', { id: botId, error: String(err) });
      });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  /**
   * POST /api/bots/:id/update - Rebuild instance from latest source commit
   * Replaces the old /pull endpoint for source-backed instances.
   */
  router.post('/:id/update', async (req: Request, res: Response) => {
    try {
      const bot = containerManager.getBot(req.params.id);
      if (!bot) {
        res.status(404).json({ success: false, error: 'Bot not found' });
        return;
      }

      if (bot.sourceType === 'docker-image') {
        res.status(400).json({ success: false, error: 'Cannot update docker-image instances this way' });
        return;
      }

      broadcastToClients(wss, 'bot:pulling', { id: req.params.id });
      res.json({ success: true, message: 'Updating instance from source' });

      const botId = req.params.id;
      containerManager.pullAndRebuild(botId).then((result) => {
        if (result.success) {
          broadcastToClients(wss, 'bot:rebuilt', containerManager.getBot(botId));
        } else {
          broadcastToClients(wss, 'bot:pull-failed', { id: botId, error: result.error });
        }
      }).catch((err) => {
        broadcastToClients(wss, 'bot:pull-failed', { id: botId, error: String(err) });
      });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  /**
   * POST /api/bots/:id/pull - Pull latest code and rebuild (legacy, delegates to /update)
   */
  router.post('/:id/pull', async (req: Request, res: Response) => {
    try {
      const bot = containerManager.getBot(req.params.id);
      if (!bot) {
        res.status(404).json({ success: false, error: 'Bot not found' });
        return;
      }

      if (bot.sourceType === 'docker-image') {
        res.status(400).json({ success: false, error: 'Cannot pull updates for docker-image source type' });
        return;
      }

      broadcastToClients(wss, 'bot:pulling', { id: req.params.id });
      res.json({ success: true, message: 'Pulling and rebuilding' });

      const botId = req.params.id;
      containerManager.pullAndRebuild(botId).then((result) => {
        if (result.success) {
          broadcastToClients(wss, 'bot:rebuilt', containerManager.getBot(botId));
        } else {
          broadcastToClients(wss, 'bot:pull-failed', { id: botId, error: result.error });
        }
      }).catch((err) => {
        broadcastToClients(wss, 'bot:pull-failed', { id: botId, error: String(err) });
      });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  /**
   * POST /api/bots/:id/build - Build bot image without starting (non-blocking)
   */
  router.post('/:id/build', async (req: Request, res: Response) => {
    try {
      const bot = containerManager.getBot(req.params.id);
      if (!bot) {
        res.status(404).json({ success: false, error: 'Bot not found' });
        return;
      }

      res.json({ success: true, message: 'Build started' });

      const botId = req.params.id;
      containerManager.buildBot(botId).then((result) => {
        const updatedBot = containerManager.getBot(botId);
        if (result.success) {
          broadcastToClients(wss, 'bot:built', updatedBot);
        } else {
          broadcastToClients(wss, 'bot:build-failed', { id: botId, error: result.error });
        }
      }).catch((err) => {
        broadcastToClients(wss, 'bot:build-failed', { id: botId, error: String(err) });
      });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  /**
   * GET /api/bots/:id/build-logs - Stream build logs via SSE
   */
  router.get('/:id/build-logs', (req: Request, res: Response) => {
    const bot = containerManager.getBot(req.params.id);
    if (!bot) {
      res.status(404).json({ success: false, error: 'Bot not found' });
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });

    res.write(`data: ${JSON.stringify({ message: `Connected to build logs for ${bot.displayName}`, type: 'system' })}\n\n`);

    const logCollector = logCollectors.get(req.params.id);

    if (req.query.fresh === 'true') {
      logCollector.clear();
    }

    const existingLogs = logCollector.getLogs();
    for (const log of existingLogs) {
      res.write(`data: ${JSON.stringify(log)}\n\n`);
    }

    const onLog = (log: unknown) => {
      if (res.writable) {
        res.write(`data: ${JSON.stringify(log)}\n\n`);
      }
    };

    logCollector.on('log', onLog);

    const keepAlive = setInterval(() => {
      if (res.writable) {
        res.write(`data: ${JSON.stringify({ message: '', type: 'ping' })}\n\n`);
      } else {
        clearInterval(keepAlive);
      }
    }, 15000);

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
   * GET /api/bots/:id/containers - List all containers for a bot's compose project
   */
  router.get('/:id/containers', async (req: Request, res: Response) => {
    try {
      const bot = containerManager.getBot(req.params.id);
      if (!bot) {
        res.status(404).json({ success: false, error: 'Bot not found' });
        return;
      }

      const appName = bot.appName || bot.sanitizedName || `bot-${req.params.id}`;

      const output = execSync(
        `docker ps -a --filter "label=com.docker.compose.project=${appName}" --format "{{.Names}}\\t{{.State}}\\t{{.Status}}" 2>/dev/null || ` +
        `docker ps -a --filter "name=${appName}" --format "{{.Names}}\\t{{.State}}\\t{{.Status}}" 2>/dev/null`,
        { encoding: 'utf8', timeout: 10000 }
      ).trim();

      const containers = output
        .split('\n')
        .filter(line => line.trim())
        .map(line => {
          const [name, state, status] = line.split('\t');
          return { name, state: state || 'unknown', status: status || '' };
        });

      res.json({ success: true, containers, appName });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  /**
   * GET /api/bots/:id/containers/:container/logs/stream - Stream container logs via SSE
   */
  router.get('/:id/containers/:container/logs/stream', (req: Request, res: Response) => {
    const containerName = req.params.container;
    const lines = parseInt(req.query.lines as string) || 50;

    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(containerName)) {
      res.status(400).json({ success: false, error: 'Invalid container name' });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    res.write(`event: connected\ndata: ${JSON.stringify({ message: `Connected to ${containerName} logs` })}\n\n`);

    try {
      const result = execSync(`docker logs --tail ${lines} ${containerName} 2>&1`, {
        encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 * 5
      });
      const logLines = result.split('\n').filter(line => line.trim().length > 0);
      for (const logLine of logLines) {
        res.write(`event: log\ndata: ${JSON.stringify({ log: logLine, timestamp: new Date().toISOString() })}\n\n`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('No such container')) {
        res.write(`event: log\ndata: ${JSON.stringify({ log: `Container '${containerName}' not found or not running`, timestamp: new Date().toISOString() })}\n\n`);
      }
    }

    const logsProcess = spawn('docker', ['logs', '-f', '--tail', '0', containerName]);

    const handleData = (data: Buffer) => {
      if (!res.writable) return;
      const lines = data.toString().split('\n').filter((l: string) => l.trim().length > 0);
      for (const logLine of lines) {
        res.write(`event: log\ndata: ${JSON.stringify({ log: logLine, timestamp: new Date().toISOString() })}\n\n`);
      }
    };

    logsProcess.stdout.on('data', handleData);
    logsProcess.stderr.on('data', handleData);
    logsProcess.on('error', (error) => {
      if (res.writable) {
        res.write(`event: error\ndata: ${JSON.stringify({ error: error.message })}\n\n`);
      }
    });

    const keepAlive = setInterval(() => {
      if (res.writable) {
        res.write(`event: ping\ndata: ${JSON.stringify({ timestamp: new Date().toISOString() })}\n\n`);
      }
    }, 30000);

    const cleanup = () => {
      clearInterval(keepAlive);
      logsProcess.kill('SIGTERM');
    };

    req.on('close', cleanup);
    req.on('error', cleanup);
    res.on('close', cleanup);
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
   * GET /api/bots/:id/files - List repository files
   */
  router.get('/:id/files', async (req: Request, res: Response) => {
    try {
      const bot = containerManager.getBot(req.params.id);
      if (!bot) {
        res.status(404).json({ success: false, error: 'Bot not found' });
        return;
      }

      if (bot.sourceType === 'docker-image') {
        res.json({ success: true, files: [], message: 'No files for docker-image source type' });
        return;
      }

      // Read from source repo, not bot directory
      if (bot.sourceId) {
        const repoPath = sourceManager.getSourceRepoPath(bot.sourceId);
        if (repoPath && require('fs').existsSync(repoPath)) {
          // Use a simple file listing from the source path
          const files = listFiles(repoPath);
          res.json({ success: true, files });
          return;
        }
      }

      // Fallback to legacy
      const files = repoManager.listRepoFiles(req.params.id);
      res.json({ success: true, files });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  /**
   * GET /api/bots/:id/updates - Check if instance needs update
   */
  router.get('/:id/updates', async (req: Request, res: Response) => {
    try {
      const bot = containerManager.getBot(req.params.id);
      if (!bot) {
        res.status(404).json({ success: false, error: 'Bot not found' });
        return;
      }

      if (bot.sourceType === 'docker-image') {
        res.json({ success: true, hasUpdates: false, message: 'Cannot check updates for docker-image source type' });
        return;
      }

      // Check against source's latest commit
      if (bot.sourceId) {
        const source = sourceManager.getSource(bot.sourceId);
        if (source && bot.lastBuiltCommit && source.lastCommitHash) {
          const hasUpdates = bot.lastBuiltCommit !== source.lastCommitHash;
          res.json({ success: true, hasUpdates, behindBy: hasUpdates ? 1 : 0 });
          return;
        }
      }

      // If no source or no commit tracking, report unknown
      res.json({ success: true, hasUpdates: false, behindBy: 0 });
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

      // Parse .env.example from source repo
      let envExample: Array<{ key: string; description: string; defaultValue: string }> = [];
      if (bot.sourceType !== 'docker-image') {
        try {
          let repoPath: string | null = null;
          if (bot.sourceId) {
            repoPath = sourceManager.getSourceRepoPath(bot.sourceId);
          }
          if (!repoPath || !require('fs').existsSync(repoPath)) {
            repoPath = repoManager.getRepoPath(req.params.id);
          }
          envExample = envManager.parseEnvExample(repoPath);
        } catch (err) {
          // Repo might not exist
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
      await containerManager.updateBot(req.params.id, { envVars: vars });

      const validation = envManager.hasRequiredEnvVars(req.params.id);
      broadcastToClients(wss, 'bot:updated', containerManager.getBot(req.params.id));
      res.json({ success: true, valid: validation.valid, missing: validation.missing });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  /**
   * POST /api/bots/:id/request-update - Bot requests its own update
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

      if (bot.updateToken !== token) {
        res.status(403).json({ success: false, error: 'Invalid token' });
        return;
      }

      console.log(`[API] Bot ${botId} requested self-update`);
      broadcastToClients(wss, 'bot:update-requested', { id: botId });
      res.json({ success: true, message: 'Update started' });

      // Fetch source first if available, then rebuild
      if (bot.sourceId) {
        try {
          await sourceManager.fetchSource(bot.sourceId);
        } catch (err) {
          console.warn(`[API] Failed to fetch source for self-update: ${err}`);
        }
      }

      containerManager.pullAndRebuild(botId).then((result) => {
        if (result.success) {
          broadcastToClients(wss, 'bot:rebuilt', containerManager.getBot(botId));
        } else {
          broadcastToClients(wss, 'bot:pull-failed', { id: botId, error: result.error });
        }
      }).catch((err) => {
        broadcastToClients(wss, 'bot:pull-failed', { id: botId, error: String(err) });
      });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  /**
   * PUT /api/bots/:id/auto-update - Toggle auto-update (now on source level)
   * Kept for backward compat — redirects to source auto-update if applicable.
   */
  router.put('/:id/auto-update', async (req: Request, res: Response) => {
    try {
      const bot = containerManager.getBot(req.params.id);
      if (!bot) {
        res.status(404).json({ success: false, error: 'Bot not found' });
        return;
      }

      const { enabled } = req.body as { enabled: boolean };
      if (typeof enabled !== 'boolean') {
        res.status(400).json({ success: false, error: 'enabled (boolean) is required' });
        return;
      }

      // If instance has a source, toggle auto-update on the source
      if (bot.sourceId) {
        sourceManager.updateSource(bot.sourceId, { autoUpdate: enabled });
      }

      broadcastToClients(wss, 'bot:updated', containerManager.getBot(req.params.id));
      res.json({ success: true, autoUpdate: enabled });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  return router;
}

/**
 * GET /api/validate-name - Validate a bot name
 * Query: ?name=...&excludeId=...
 */
export function createValidationRoutes(): Router {
  const router = Router();

  router.get('/validate-name', async (req: Request, res: Response) => {
    try {
      const name = req.query.name as string;
      if (!name) {
        res.json({ valid: false, errors: ['Name is required'] });
        return;
      }

      const excludeId = req.query.excludeId as string;
      const existingInstances = containerManager.getAllBots();
      const result = validateName(name, existingInstances, excludeId);
      const names = resolveNames(name);
      const reuse = result.valid ? checkFolderReuse(names.sanitizedName, existingInstances) : { reuseAvailable: false, previousInstanceId: null };

      res.json({ ...result, ...names, ...reuse });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  return router;
}

/**
 * System API Routes
 */
export function createSystemRoutes(): Router {
  const router = Router();

  router.get('/deployment', async (req: Request, res: Response) => {
    try {
      const info = await getDeploymentInfo();
      res.json({ success: true, ...info });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  router.put('/deployment', async (req: Request, res: Response) => {
    try {
      const { mode } = req.body as { mode: DeploymentMode };
      if (!mode || !['casaos', 'docker'].includes(mode)) {
        res.status(400).json({ success: false, error: 'Invalid mode' });
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

// Helper: list files in a directory (max 100)
function listFiles(dirPath: string): string[] {
  const fs = require('fs');
  const path = require('path');
  const files: string[] = [];

  function walkDir(dir: string, prefix = ''): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walkDir(path.join(dir, entry.name), relativePath);
      } else {
        files.push(relativePath);
      }
    }
  }

  walkDir(dirPath);
  return files.slice(0, 100);
}
