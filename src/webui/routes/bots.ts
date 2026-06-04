/**
 * Bot API Routes
 * RESTful API for managing Discord bot instances
 */

import { Router, Request, Response } from 'express';
import { WebSocketServer } from 'ws';
import { spawn, execSync } from 'child_process';
import * as containerManager from '../../docker/containerManager';
import * as envManager from '../../env/manager';
import * as configFileManager from '../../config/configFileManager';
import * as terminal from '../terminal';
import * as sourceManager from '../../source/sourceManager';
import { getDeploymentInfo, setDeploymentMode } from '../../casaos/detector';
import { broadcastToClients } from '../server';
import { DeploymentMode } from '../../types';
import { logCollectors } from '../../build/logCollector';
import { validateName, resolveNames, checkFolderReuse, sanitizeName } from '../../naming';
import * as fs from 'fs';
import * as path from 'path';
import { readEnvsFromComposeFile } from '../../docker/containerManager';

export function createBotRoutes(wss: WebSocketServer): Router {
  const router = Router();

  /**
   * GET /api/bots - List all bot instances
   * Joins source info for each instance.
   */
  router.get('/', async (req: Request, res: Response) => {
    try {
      const bots = containerManager.getAllBots();

      // Join source info + compute commits-behind for bots that are behind
      const botsWithSource = await Promise.all(bots.map(async bot => {
        let source = null;
        let updateAvailable = false;
        let behindBy = 0;

        if (bot.sourceId) {
          source = sourceManager.getSource(bot.sourceId);
          if (source && bot.lastBuiltCommit && source.lastCommitHash) {
            updateAvailable = bot.lastBuiltCommit !== source.lastCommitHash;
            if (updateAvailable) {
              behindBy = await sourceManager.getCommitsBehind(bot.sourceId, bot.lastBuiltCommit);
            }
          }
        }

        return {
          ...bot,
          autoUpdate: bot.autoUpdate || false,
          autoUpdateInterval: bot.autoUpdateInterval || 86400000,
          autoUpdateHour: bot.autoUpdateHour ?? 4,
          source: source ? { id: source.id, composeName: source.composeName, lastCommitHash: source.lastCommitHash, url: source.url, autoUpdate: source.autoUpdate } : null,
          updateAvailable,
          behindBy,
        };
      }));

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
   */
  router.post('/', async (req: Request, res: Response) => {
    try {
      const body = req.body;

      if (body.sourceType === 'docker-image') {
        if (!body.displayName) {
          res.status(400).json({ success: false, error: 'displayName is required' });
          return;
        }
        if (!body.imageRef) {
          res.status(400).json({ success: false, error: 'imageRef is required for docker-image source type' });
          return;
        }

        const bot = await containerManager.createDockerImageInstance({
          displayName: body.displayName,
          imageRef: body.imageRef,
          envVars: body.envVars,
        });
        broadcastToClients(wss, 'bot:created', bot);
        res.json({ success: true, bot });
        return;
      }

      if (body.sourceId) {
        const bot = await containerManager.createInstance({
          sourceId: body.sourceId,
          displayName: body.displayName,
          envVars: body.envVars,
        });
        broadcastToClients(wss, 'bot:created', bot);
        res.json({ success: true, bot });
        return;
      }

      res.status(400).json({ success: false, error: 'Must provide sourceId or sourceType=docker-image' });
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
      const keepEnv = req.query.keepEnv !== 'false'; // default true (preserve env)
      const bot = containerManager.getBot(req.params.id);

      if (!bot) {
        res.status(404).json({ success: false, error: 'Bot not found' });
        return;
      }

      // When keepEnv=true (default), preserve env vars in vault for recovery.
      // When keepEnv=false, user explicitly wants them gone; don't save.
      if (keepEnv) {
        try {
          const envVars = envManager.getEnvVars(req.params.id);
          if (envVars && Object.keys(envVars).length > 0) {
            const vaultPath = require('path').join(process.env.DATA_DIR || '/data/data', 'vault.json');
            const fs = require('fs');
            let vault: { standalone: Array<{ key: string; value: string; hidden: boolean }>; deleted: Array<{ key: string; value: string; botName: string; sanitizedName?: string; deletedAt: number }> } = { standalone: [], deleted: [] };
            try {
              if (fs.existsSync(vaultPath)) {
                const raw = JSON.parse(fs.readFileSync(vaultPath, 'utf-8'));
                vault = { standalone: raw.standalone || [], deleted: raw.deleted || [] };
              }
            } catch { /* ignore */ }

            const botName = bot.displayName;
            const sanitizedName = bot.sanitizedName;
            const now = Date.now();
            for (const [key, value] of Object.entries(envVars)) {
              // Upsert: latest wins by key+botName
              const idx = vault.deleted.findIndex(d => d.key === key && d.botName === botName);
              const entry = { key, value, botName, sanitizedName, deletedAt: now };
              if (idx >= 0) {
                vault.deleted[idx] = entry;
              } else {
                vault.deleted.push(entry);
              }
            }
            fs.mkdirSync(require('path').dirname(vaultPath), { recursive: true });
            fs.writeFileSync(vaultPath, JSON.stringify(vault, null, 2));
          }
        } catch (err) {
          console.warn(`[API] Failed to preserve env vars in vault: ${err}`);
        }
      }

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

      // Fetch source first to ensure we have the latest code
      if (bot.sourceId) {
        try {
          await sourceManager.fetchSource(bot.sourceId);
        } catch (err) {
          console.warn(`[API] Failed to fetch source before update: ${err}`);
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

      const appName = bot.sanitizedName;

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

      if (!bot.sourceId) {
        res.json({ success: true, files: [] });
        return;
      }
      const repoPath = sourceManager.getSourceRepoPath(bot.sourceId);
      const files = (repoPath && require('fs').existsSync(repoPath)) ? listFiles(repoPath) : [];
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

      if (!bot.sourceId) {
        res.json({ success: true, hasUpdates: false, behindBy: 0 });
        return;
      }

      // Fetch source first to ensure we have the latest remote state
      let fetchBehindBy = 0;
      try {
        const fetchResult = await sourceManager.fetchSource(bot.sourceId);
        fetchBehindBy = fetchResult.behindBy;
      } catch (err) {
        console.warn(`[API] Failed to fetch source for update check: ${err}`);
      }

      const source = sourceManager.getSource(bot.sourceId);
      if (!source || !source.lastCommitHash) {
        // Source not cloned or no commit info; can't determine
        res.json({ success: true, hasUpdates: false, behindBy: 0 });
        return;
      }

      if (!bot.lastBuiltCommit) {
        // Never tracked what commit was built; assume behind
        res.json({ success: true, hasUpdates: true, behindBy: fetchBehindBy || 1 });
        return;
      }

      const hasUpdates = bot.lastBuiltCommit !== source.lastCommitHash;
      res.json({ success: true, hasUpdates, behindBy: hasUpdates ? fetchBehindBy || 1 : 0 });
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
      if (bot.sourceType !== 'docker-image' && bot.sourceId) {
        try {
          const repoPath = sourceManager.getSourceRepoPath(bot.sourceId);
          if (require('fs').existsSync(repoPath)) {
            envExample = envManager.parseEnvExample(repoPath);
          }
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
   * GET /api/bots/:id/config - Get config files for a bot
   */
  router.get('/:id/config', async (req: Request, res: Response) => {
    try {
      const bot = containerManager.getBot(req.params.id);
      if (!bot) {
        res.status(404).json({ success: false, error: 'Bot not found' });
        return;
      }
      res.json({ success: true, files: configFileManager.getConfigFiles(req.params.id) });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  /**
   * PUT /api/bots/:id/config - Replace config files for a bot
   * Body: { files: [{ path, body }] }
   */
  router.put('/:id/config', async (req: Request, res: Response) => {
    try {
      const bot = containerManager.getBot(req.params.id);
      if (!bot) {
        res.status(404).json({ success: false, error: 'Bot not found' });
        return;
      }

      const { files } = req.body as { files: Array<{ path: string; body: string }> };
      if (!Array.isArray(files)) {
        res.status(400).json({ success: false, error: 'files array is required' });
        return;
      }

      configFileManager.setConfigFiles(req.params.id, files);
      broadcastToClients(wss, 'bot:updated', containerManager.getBot(req.params.id));
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  /**
   * Per-bot file browser/editor (Console + Files feature).
   * `target` is either a container name belonging to the bot, or "host" for the
   * bot's persistent /DATA/AppData/<app> folder. Scoping/validation happens in
   * the terminal module.
   */
  router.get('/:id/fs/list', async (req: Request, res: Response) => {
    try {
      const result = await terminal.fsList(req.params.id, String(req.query.target || 'host'), String(req.query.path || ''));
      res.json(result);
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  router.get('/:id/fs/read', async (req: Request, res: Response) => {
    try {
      const result = await terminal.fsRead(req.params.id, String(req.query.target || 'host'), String(req.query.path || ''));
      res.json(result);
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  router.put('/:id/fs/write', async (req: Request, res: Response) => {
    try {
      const { target, path, body } = req.body as { target?: string; path?: string; body?: string };
      if (typeof path !== 'string' || typeof body !== 'string') {
        res.status(400).json({ success: false, error: 'path and body are required' });
        return;
      }
      res.json(await terminal.fsWrite(req.params.id, target || 'host', path, body));
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  router.post('/:id/fs/mkdir', async (req: Request, res: Response) => {
    try {
      const { target, path } = req.body as { target?: string; path?: string };
      if (typeof path !== 'string') { res.status(400).json({ success: false, error: 'path is required' }); return; }
      res.json(await terminal.fsMkdir(req.params.id, target || 'host', path));
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  router.post('/:id/fs/delete', async (req: Request, res: Response) => {
    try {
      const { target, path } = req.body as { target?: string; path?: string };
      if (typeof path !== 'string') { res.status(400).json({ success: false, error: 'path is required' }); return; }
      res.json(await terminal.fsDelete(req.params.id, target || 'host', path));
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  router.post('/:id/fs/rename', async (req: Request, res: Response) => {
    try {
      const { target, from, to } = req.body as { target?: string; from?: string; to?: string };
      if (typeof from !== 'string' || typeof to !== 'string') { res.status(400).json({ success: false, error: 'from and to are required' }); return; }
      res.json(await terminal.fsRename(req.params.id, target || 'host', from, to));
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
   * PUT /api/bots/:id/auto-update - Toggle instance auto-update
   * Sets autoUpdate and optional autoUpdateInterval on the INSTANCE (not source).
   */
  router.put('/:id/auto-update', async (req: Request, res: Response) => {
    try {
      const bot = containerManager.getBot(req.params.id);
      if (!bot) {
        res.status(404).json({ success: false, error: 'Bot not found' });
        return;
      }

      const { enabled, interval, hour } = req.body as { enabled: boolean; interval?: number; hour?: number };
      if (typeof enabled !== 'boolean') {
        res.status(400).json({ success: false, error: 'enabled (boolean) is required' });
        return;
      }

      const updated = containerManager.updateInstanceAutoUpdate(req.params.id, enabled, interval, hour);
      broadcastToClients(wss, 'bot:updated', updated);
      res.json({ success: true, autoUpdate: enabled, autoUpdateInterval: updated?.autoUpdateInterval, autoUpdateHour: updated?.autoUpdateHour });
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
      const reuse = result.valid ? checkFolderReuse(names.sanitizedName, existingInstances) : { reuseAvailable: false, marker: null };

      res.json({ ...result, ...names, ...reuse });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  /**
   * GET /api/recover-envs?name=<displayName>
   * Returns recoverable plaintext env vars for a name, pulled from:
   *   1. vault.deleted entries matching sanitizedName (or botName -> sanitize)
   *   2. CasaOS compose file at /DATA/AppData/casaos/apps/<sanitizedName>/docker-compose.yml
   * Vault entries win over compose when the same key exists in both.
   * Bot-manager-injected keys (BOT_ID, BOT_MANAGER_UPDATE_TOKEN, BOT_MANAGER_INTERNAL_URL) are stripped.
   * Frontend calls this when the user clicks "Load envs from previous installation".
   */
  router.get('/recover-envs', async (req: Request, res: Response) => {
    try {
      const name = req.query.name as string;
      if (!name) {
        res.json({ success: false, error: 'Name is required', envs: [] });
        return;
      }

      const targetSanitized = sanitizeName(name);
      const BOT_MANAGER_KEYS = new Set(['BOT_ID', 'BOT_MANAGER_UPDATE_TOKEN', 'BOT_MANAGER_INTERNAL_URL']);
      const sensitivePatterns = ['TOKEN', 'SECRET', 'PASSWORD', 'API_KEY'];
      const isSensitive = (key: string) => sensitivePatterns.some(p => key.toUpperCase().includes(p));

      // Source 1: vault.deleted entries matching this name
      const vaultPath = path.join(process.env.DATA_DIR || '/data/data', 'vault.json');
      const fromVault: Record<string, string> = {};
      try {
        if (fs.existsSync(vaultPath)) {
          const vault = JSON.parse(fs.readFileSync(vaultPath, 'utf-8'));
          const deleted = Array.isArray(vault.deleted) ? vault.deleted : [];
          for (const entry of deleted) {
            if (entry.sanitizedName !== targetSanitized) continue;
            if (BOT_MANAGER_KEYS.has(entry.key)) continue;
            fromVault[entry.key] = entry.value;
          }
        }
      } catch (err) {
        console.warn(`[RecoverEnvs] Failed to read vault: ${err}`);
      }

      // Source 2: surviving compose file at CasaOS metadata path
      const dataRoot = process.env.DATA_ROOT || '/DATA';
      const composePath = path.join(dataRoot, 'AppData', 'casaos', 'apps', targetSanitized, 'docker-compose.yml');
      const fromCompose = readEnvsFromComposeFile(composePath) || {};

      // Merge: vault wins over compose
      const merged: Record<string, { value: string; source: 'vault' | 'compose' }> = {};
      for (const [k, v] of Object.entries(fromCompose)) {
        if (!BOT_MANAGER_KEYS.has(k)) merged[k] = { value: v, source: 'compose' };
      }
      for (const [k, v] of Object.entries(fromVault)) {
        merged[k] = { value: v, source: 'vault' };
      }

      const envs = Object.entries(merged).map(([key, { value, source }]) => ({
        key,
        value,
        sensitive: isSensitive(key),
        source,
      }));

      res.json({
        success: true,
        envs,
        sources: {
          vault: Object.keys(fromVault).length,
          compose: Object.keys(fromCompose).length,
        },
      });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error), envs: [] });
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
