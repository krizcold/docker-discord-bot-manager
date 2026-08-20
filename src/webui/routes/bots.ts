/**
 * Bot API Routes
 * RESTful API for managing Discord bot instances
 */

import { Router, Request, Response } from 'express';
import { WebSocketServer } from 'ws';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import * as containerManager from '../../docker/containerManager';
import * as dockerClient from '../../docker/dockerClient';
import * as envManager from '../../env/manager';
import { buildBotEnvList, buildBotConfigList } from '../../env/envList';
import * as configFileManager from '../../config/configFileManager';
import { findManifest, sanitizeSeedRows } from '../../config/installManifests';
import { parseConfig } from '../../config/configSerializer';
import * as terminal from '../terminal';
import * as sourceManager from '../../source/sourceManager';
import * as fleetBackup from '../../instance/fleetBackup';
import * as fleetReplication from '../../instance/fleetReplication';
import { loadVault, saveVault } from './vault';
import { getDeploymentInfo, setDeploymentMode, getDeploymentMode } from '../../casaos/detector';
import { broadcastToClients } from '../server';
import { DeploymentMode } from '../../types';
import { logCollectors } from '../../build/logCollector';
import { makeUniqueName, resolveNames, checkFolderReuse, sanitizeName } from '../../naming';
import * as fs from 'fs';
import * as path from 'path';
import { readEnvsFromComposeFile } from '../../docker/containerManager';
import { getFleetControlPort, isFleetMaster, fleetPublicHost, fleetHostSuffix, fleetAppContainerName, getAppServiceName, getWebUiIndexPath } from '../../templates/pcsProcessing';
import { getBotDir } from '../../git/repoManager';

const BOT_MANAGER_KEYS = new Set(['BOT_ID', 'BOT_MANAGER_UPDATE_TOKEN', 'BOT_MANAGER_INTERNAL_URL']);

// Full-bot WS payloads carry activeOp so cards can clear/set busy state
// without waiting for the next GET /api/bots refresh.
function withActiveOp<T extends { id: string } | null | undefined>(bot: T): T | (T & { activeOp: string | null }) {
  if (!bot) return bot;
  return { ...bot, activeOp: containerManager.isBotBusy(bot.id) };
}

export function createBotRoutes(wss: WebSocketServer): Router {
  const router = Router();

  /**
   * GET /api/bots - List all bot instances
   * Joins source info for each instance.
   */
  router.get('/', async (req: Request, res: Response) => {
    try {
      const bots = containerManager.getAllBots();
      const mode = await getDeploymentMode();

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

        // CasaOS Open link: docker mode already carries publicUrl/hostPort; on CasaOS
        // neither exists, so derive the gateway URL from the bot's Caddy host here.
        const webOpenUrl = (mode === 'casaos' && bot.status === 'running')
          ? casaosWebOpenUrl(bot.sanitizedName, bot.id)
          : null;

        // Sidecar backup status: null for instances without a managed fleet DB.
        const fleetBackupInfo = bot.fleetDb ? {
          lastAt: bot.lastFleetBackupAt || null,
          stale: fleetBackup.isFleetBackupStale(bot),
          lastError: fleetBackup.getFleetBackupError(bot.id),
          ...fleetBackup.effectiveFleetBackup(bot),
        } : null;

        return {
          ...bot,
          autoUpdate: bot.autoUpdate || false,
          autoUpdateInterval: bot.autoUpdateInterval || 86400000,
          autoUpdateHour: bot.autoUpdateHour ?? 4,
          fleetBackup: fleetBackupInfo,
          source: source ? { id: source.id, composeName: source.composeName, lastCommitHash: source.lastCommitHash, url: source.url, autoUpdate: source.autoUpdate } : null,
          updateAvailable,
          behindBy,
          webOpenUrl,
          // Effective readiness (ping or grace fallback) drives the Open button.
          webUiReady: containerManager.isBotWebUiReady(bot),
          activeOp: containerManager.isBotBusy(bot.id),
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
   * GET /api/bots/fleet/masters - Fleet masters running on this manager, with the
   * connection info a co-worker install needs. Returns CONTROL_SECRET in plaintext
   * like /api/recover-envs does: the whole API sits behind the manager's auth edge
   * and the value exists to be filled into a co-worker's secret field.
   * Each master carries two addresses: localUrl for a same-manager worker (dials
   * over the shared network, no public round-trip) and masterUrl for a genuinely
   * cross-host worker (public wss). Either may be null when it cannot be derived.
   * Also returns fleetBase: the mode-resolved fleet host suffix, so the install
   * wizard can preview a new master's public URL; null when no public base exists.
   */
  router.get('/fleet/masters', async (req: Request, res: Response) => {
    try {
      const dataRoot = process.env.DATA_ROOT || '/DATA';
      // Deployed compose, resolved like containerManager's resolveComposePath:
      // CasaOS metadata path when present, else the bot-dir copy.
      const fleetAddrsOf = (bot: { id: string; sanitizedName: string }) => {
        const casaosPath = path.join(dataRoot, 'AppData', 'casaos', 'apps', bot.sanitizedName, 'docker-compose.yml');
        const composePath = fs.existsSync(casaosPath) ? casaosPath : path.join(getBotDir(bot.id), 'docker-compose.yml');
        if (!fs.existsSync(composePath)) return null;
        const composeContent = fs.readFileSync(composePath, 'utf-8');
        const controlPort = getFleetControlPort(composeContent);
        if (controlPort === null) return null;

        // Public wss URL a genuinely cross-host worker uses. Same URL the
        // injection path hands the node as FLEET_PUBLIC_URL; null when no
        // publicly-trusted base exists for the mode (e.g. standalone/Windows).
        const host = fleetPublicHost(bot.sanitizedName);
        const publicUrl = host ? `wss://${host}` : null;

        // Local URL a same-host/same-manager worker should dial instead, so the
        // handshake stays on the box rather than looping out through the public
        // gateway. Both modes dial the app container by name over the shared
        // network (pcs on CasaOS, dbm_internal in docker mode):
        // host.docker.internal is Docker Desktop-only and the fleet host port is
        // loopback-bound, so on bare Linux a container-name dial is the only
        // route that works.
        const cname = fleetAppContainerName(composeContent);
        const localUrl = cname ? `ws://${cname}:${controlPort}` : null;
        return { publicUrl, localUrl };
      };

      // Designated backup masters, keyed by the fleet they belong to: one
      // CONTROL_SECRET per fleet, so a backup joins the master whose secret it
      // shares. They come second in a candidate list (the master leads).
      const backups: Array<{ id: string; localUrl: string | null; publicUrl: string | null; secret: string }> = [];
      for (const bot of containerManager.getAllBots()) {
        try {
          const env = envManager.getEnvVars(bot.id);
          const role = (env['BOT_NODE_ROLE'] || '').trim().toLowerCase();
          if (role !== 'backup-master' && (env['FLEET_BACKUP_MASTER'] || '').trim() !== '1') continue;
          const secret = (env['CONTROL_SECRET'] || '').trim();
          if (secret === '') continue;
          const addrs = fleetAddrsOf(bot);
          if (!addrs) continue;
          backups.push({ id: bot.id, localUrl: addrs.localUrl, publicUrl: addrs.publicUrl, secret });
        } catch {
          // an unreadable instance must not break the list
        }
      }

      const masters: Array<{
        id: string; name: string; masterUrl: string | null; localUrl: string | null;
        secretSet: boolean; controlSecret: string; localCandidates: string[]; publicCandidates: string[];
      }> = [];
      for (const bot of containerManager.getAllBots()) {
        try {
          const env = envManager.getEnvVars(bot.id);
          if (!isFleetMaster(env)) continue;
          const addrs = fleetAddrsOf(bot);
          if (!addrs || (!addrs.publicUrl && !addrs.localUrl)) continue;

          const controlSecret = (env['CONTROL_SECRET'] || '').trim();
          // Never list a node as its own backup: a promoted ex-backup can carry
          // both the master role and a stale designation flag.
          const peers = controlSecret === '' ? [] : backups.filter(b => b.secret === controlSecret && b.id !== bot.id);
          const dedupe = (urls: Array<string | null>) => [...new Set(urls.filter((u): u is string => !!u))];
          const localCandidates = dedupe([addrs.localUrl, ...peers.map(p => p.localUrl)]);
          const publicCandidates = dedupe([addrs.publicUrl, ...peers.map(p => p.publicUrl)]);
          masters.push({
            id: bot.id, name: bot.displayName, masterUrl: addrs.publicUrl, localUrl: addrs.localUrl,
            secretSet: controlSecret !== '', controlSecret, localCandidates, publicCandidates,
          });
        } catch {
          // an unreadable instance must not break the list
        }
      }
      res.json({ success: true, fleetBase: fleetHostSuffix(), masters });
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

      const busyOp = containerManager.isBotBusy(req.params.id);
      if (busyOp) {
        res.status(409).json({ success: false, error: `Operation '${busyOp}' already in progress` });
        return;
      }

      // When keepEnv=true (default), preserve env vars in vault for recovery.
      // When keepEnv=false, user explicitly wants them gone; don't save.
      // Every removal creates a new group so repeated removals of a same-named
      // bot are kept as separate recoverable versions. Saved before deleteBot
      // for crash-safety, rolled back if the deletion fails.
      let savedGroupId: string | null = null;
      if (keepEnv) {
        try {
          const envVars = envManager.getEnvVars(req.params.id);
          if (envVars) {
            const entries = Object.entries(envVars)
              .filter(([key]) => !BOT_MANAGER_KEYS.has(key))
              .map(([key, value]) => ({ key, value }));
            if (entries.length > 0) {
              const vault = loadVault();
              const groupId = randomUUID();
              vault.deletedBots.push({
                id: groupId,
                botName: bot.displayName,
                sanitizedName: bot.sanitizedName,
                deletedAt: Date.now(),
                entries,
              });
              saveVault(vault);
              savedGroupId = groupId;
            }
          }
        } catch (err) {
          console.warn(`[API] Failed to preserve env vars in vault: ${err}`);
        }
      }

      const rollbackVaultGroup = () => {
        if (!savedGroupId) return;
        try {
          const vault = loadVault();
          vault.deletedBots = vault.deletedBots.filter(g => g.id !== savedGroupId);
          saveVault(vault);
        } catch (err) {
          console.warn(`[API] Failed to roll back vault group: ${err}`);
        }
      };

      let success: boolean;
      try {
        success = await containerManager.deleteBot(req.params.id, keepData);
      } catch (err) {
        rollbackVaultGroup();
        throw err;
      }
      if (!success) {
        rollbackVaultGroup();
        res.status(404).json({ success: false, error: 'Bot not found' });
        return;
      }

      broadcastToClients(wss, 'bot:deleted', { id: req.params.id });
      res.json({ success: true, vaulted: savedGroupId !== null });
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

      const busyOp = containerManager.isBotBusy(req.params.id);
      if (busyOp) {
        res.status(409).json({ success: false, error: `Operation '${busyOp}' already in progress` });
        return;
      }

      res.json({ success: true, message: 'Starting bot' });

      const botId = req.params.id;
      containerManager.startBot(botId).then((result) => {
        const updatedBot = withActiveOp(containerManager.getBot(botId));
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
      const busyOp = containerManager.isBotBusy(req.params.id);
      if (busyOp) {
        res.status(409).json({ success: false, error: `Operation '${busyOp}' already in progress` });
        return;
      }

      const result = await containerManager.stopBot(req.params.id);
      if (!result.success) {
        res.status(400).json(result);
        return;
      }

      const bot = withActiveOp(containerManager.getBot(req.params.id));
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

      const busyOp = containerManager.isBotBusy(req.params.id);
      if (busyOp) {
        res.status(409).json({ success: false, error: `Operation '${busyOp}' already in progress` });
        return;
      }

      res.json({ success: true, message: 'Restarting bot' });

      const botId = req.params.id;
      containerManager.restartBot(botId).then((result) => {
        const updatedBot = withActiveOp(containerManager.getBot(botId));
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

      const busyOp = containerManager.isBotBusy(req.params.id);
      if (busyOp) {
        res.status(409).json({ success: false, error: `Operation '${busyOp}' already in progress` });
        return;
      }

      broadcastToClients(wss, 'bot:pulling', { id: req.params.id });
      res.json({ success: true, message: 'Updating instance from source' });

      const botId = req.params.id;

      // Invoked synchronously after res.json so the op lock and log session
      // exist before the client's POST resolves (the frontend connects its SSE
      // stream only after this response). buildGitInstance re-fetches the
      // source itself, so no pre-fetch is needed here.
      containerManager.pullAndRebuild(botId).then((result) => {
        if (result.success) {
          broadcastToClients(wss, 'bot:rebuilt', withActiveOp(containerManager.getBot(botId)));
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

      const busyOp = containerManager.isBotBusy(req.params.id);
      if (busyOp) {
        res.status(409).json({ success: false, error: `Operation '${busyOp}' already in progress` });
        return;
      }

      res.json({ success: true, message: 'Build started' });

      const botId = req.params.id;
      containerManager.buildBot(botId).then((result) => {
        const updatedBot = withActiveOp(containerManager.getBot(botId));
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
   * GET /api/bots/:id/build-logs - Stream operation logs via SSE (protocol v2).
   * Replays the collector's session history, then: while an op runs, live-tails
   * with a 15s liveness status heartbeat and closes after the terminal frame;
   * otherwise sends the terminal/idle frame and closes immediately. Streams
   * never idle open - the frontend relies on this to avoid reset frames.
   */
  router.get('/:id/build-logs', (req: Request, res: Response) => {
    const botId = req.params.id;
    const bot = containerManager.getBot(botId);
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
    res.write('retry: 15000\n\n');

    const writeFrame = (frame: object) => {
      if (res.writable) {
        res.write(`data: ${JSON.stringify(frame)}\n\n`);
      }
    };
    const currentStatus = () => containerManager.getBot(botId)?.status || 'unknown';

    const collector = logCollectors.getIfExists(botId);

    if (!collector || collector.opState === 'idle') {
      if (collector) {
        for (const log of collector.getLogs()) writeFrame(log);
      }
      writeFrame({ type: 'idle', status: currentStatus(), timestamp: Date.now() });
      res.end();
      return;
    }

    for (const log of collector.getLogs()) writeFrame(log);

    const writeTerminalFrame = () => {
      const durationMs = (collector.opEndedAt || Date.now()) - collector.opStartedAt;
      if (collector.opState === 'done') {
        writeFrame({ type: 'done', op: collector.opName, durationMs, finalStatus: currentStatus(), timestamp: Date.now() });
      } else {
        writeFrame({
          type: 'failed', op: collector.opName, durationMs,
          error: collector.opError || 'unknown error', finalStatus: currentStatus(), timestamp: Date.now()
        });
      }
      res.end();
    };

    if (collector.opState !== 'running') {
      writeTerminalFrame();
      return;
    }

    const statusFrame = () => ({
      type: 'status',
      op: collector.opName,
      startedAt: collector.opStartedAt,
      sinceLastLogMs: Math.max(0, Date.now() - collector.lastActivityAt),
      timestamp: Date.now()
    });
    writeFrame(statusFrame());

    const onLog = (log: unknown) => writeFrame(log as object);
    const heartbeat = setInterval(() => writeFrame(statusFrame()), 15000);
    const cleanup = () => {
      clearInterval(heartbeat);
      collector.removeListener('log', onLog);
      collector.removeListener('op', onOp);
    };
    const onOp = () => {
      if (collector.opState === 'done' || collector.opState === 'failed') {
        cleanup();
        writeTerminalFrame();
      }
    };

    collector.on('log', onLog);
    collector.on('op', onOp);

    req.on('close', () => {
      cleanup();
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
      const containers = await dockerClient.listProjectContainers(appName);
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

    // One follow process serves both history (--tail N) and live tail, so no
    // synchronous history fetch blocks the event loop.
    const logsProcess = spawn('docker', ['logs', '-f', '--tail', String(lines), containerName]);

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

      // Bot-originated checks carry X-Bot-Token; validate it when present.
      // UI calls come through the gateway and send no token.
      const givenToken = req.headers['x-bot-token'];
      if (givenToken !== undefined && givenToken !== bot.updateToken) {
        res.status(403).json({ success: false, error: 'Invalid bot token' });
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

      const repoPath = (bot.sourceType !== 'docker-image' && bot.sourceId)
        ? sourceManager.getSourceRepoPath(bot.sourceId)
        : null;

      const vars = buildBotEnvList(repoPath, req.params.id, bot.tokenVarName);
      const validation = envManager.hasRequiredEnvVars(req.params.id, bot.tokenVarName);

      res.json({
        success: true,
        vars,
        tokenVarName: bot.tokenVarName,
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

      const envVars = { ...vars };
      const dropped = envManager.setEnvVars(req.params.id, envVars);
      await containerManager.updateBot(req.params.id, { envVars });
      // Keys the save retired (legacy fleet designation/dial) must leave the
      // instance record and the deployed compose too, or the start-time sync
      // re-bakes them from the stale snapshot (same trio as DELETE /env/:key).
      if (dropped.length > 0) {
        containerManager.removeBotEnvVars(req.params.id, dropped);
        for (const key of dropped) containerManager.removeEnvKeyFromDeployedCompose(req.params.id, key);
      }

      const validation = envManager.hasRequiredEnvVars(req.params.id, bot.tokenVarName);
      broadcastToClients(wss, 'bot:updated', containerManager.getBot(req.params.id));
      res.json({ success: true, valid: validation.valid, missing: validation.missing });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  /**
   * DELETE /api/bots/:id/env/:key - Remove an environment variable
   */
  router.delete('/:id/env/:key', async (req: Request, res: Response) => {
    try {
      const bot = containerManager.getBot(req.params.id);
      if (!bot) {
        res.status(404).json({ success: false, error: 'Bot not found' });
        return;
      }
      // An in-flight start would re-bake the key into the compose from its
      // stale instance snapshot, and nothing would ever strip it again.
      const activeOp = containerManager.isBotBusy(req.params.id);
      if (activeOp) {
        res.status(409).json({ success: false, error: `Bot operation in progress (${activeOp}); retry when it completes` });
        return;
      }
      envManager.deleteEnvVar(req.params.id, req.params.key);
      containerManager.removeBotEnvVars(req.params.id, [req.params.key]);
      containerManager.removeEnvKeyFromDeployedCompose(req.params.id, req.params.key);
      const validation = envManager.hasRequiredEnvVars(req.params.id, bot.tokenVarName);
      broadcastToClients(wss, 'bot:updated', containerManager.getBot(req.params.id));
      res.json({ success: true, valid: validation.valid, missing: validation.missing });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  /**
   * POST /api/bots/:id/validate-db - Test a database URL with a one-shot psql.
   * The URL rides as an argv element (never a shell string, never logged) and
   * the run is hard-killed after 10 seconds. Errors surface password-redacted.
   */
  router.post('/:id/validate-db', async (req: Request, res: Response) => {
    try {
      const bot = containerManager.getBot(req.params.id);
      if (!bot) {
        res.status(404).json({ success: false, error: 'Bot not found' });
        return;
      }

      const { url } = req.body as { url?: string };
      if (!url || typeof url !== 'string' || !url.trim()) {
        res.status(400).json({ success: false, error: 'url is required' });
        return;
      }
      const target = url.trim();

      const result = await new Promise<{ ok: boolean; error?: string }>(resolve => {
        const child = spawn('docker', ['run', '--rm', 'postgres:16-alpine', 'psql', target, '-c', 'SELECT 1']);
        let stderr = '';
        let killed = false;
        let settled = false;
        const finish = (r: { ok: boolean; error?: string }) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(r);
        };
        const timer = setTimeout(() => {
          killed = true;
          child.kill('SIGKILL');
        }, 10000);
        child.stderr.on('data', d => { if (stderr.length < 4000) stderr += d.toString(); });
        child.on('error', err => finish({ ok: false, error: `Failed to run docker: ${err.message}` }));
        child.on('close', code => {
          if (killed) return finish({ ok: false, error: 'Connection test timed out after 10 seconds' });
          if (code === 0) return finish({ ok: true });
          finish({ ok: false, error: redactDbError(stderr.trim() || `psql exited with code ${code}`, target) });
        });
      });

      if (result.ok) {
        res.json({ success: true, ok: true });
        return;
      }
      const hint = sslModeHint(target);
      res.json({ success: true, ok: false, error: result.error, ...(hint ? { hint } : {}) });
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
      const repoPath = (bot.sourceType !== 'docker-image' && bot.sourceId)
        ? sourceManager.getSourceRepoPath(bot.sourceId)
        : null;
      const source = bot.sourceId ? sourceManager.getSource(bot.sourceId) : null;
      // Attach a guided install manifest + parsed body per file when one exists,
      // so the post-install editor renders the same guided form as the wizard.
      const files = buildBotConfigList(repoPath, req.params.id, source?.url).map(f => {
        const targetName = path.basename(f.path);
        const manifest = (source?.url ? findManifest(source.url, targetName) : undefined) || null;
        const format = envManager.configFileFormat(targetName);
        let body = f.body;
        let parsed: unknown = null;
        if (manifest) {
          body = sanitizeSeedRows(manifest, body);
          const r = parseConfig(manifest.format, body);
          if (r.ok) parsed = r.data;
        }
        return { ...f, body, format, manifest, parsed };
      });
      res.json({ success: true, files });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  /**
   * PUT /api/bots/:id/config - Replace config files for a bot
   * Body: { files: [{ path, body, readOnly?, enabled? }] }
   */
  router.put('/:id/config', async (req: Request, res: Response) => {
    try {
      const bot = containerManager.getBot(req.params.id);
      if (!bot) {
        res.status(404).json({ success: false, error: 'Bot not found' });
        return;
      }

      const { files } = req.body as { files: Array<{ path: string; body: string; readOnly?: boolean; enabled?: boolean }> };
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
   * POST /api/bots/:id/webui-ready - Bot reports its web UI is serving.
   * The bot pings this once its HTTP server is listening, so the Open button
   * stays disabled until the web UI is actually reachable after a (re)start.
   */
  router.post('/:id/webui-ready', async (req: Request, res: Response) => {
    try {
      const botId = req.params.id;
      const token = req.headers['x-bot-token'] as string;
      const bot = containerManager.getBot(botId);
      if (!bot) {
        res.status(404).json({ success: false, error: 'Bot not found' });
        return;
      }
      if (!token || bot.updateToken !== token) {
        res.status(403).json({ success: false, error: 'Invalid token' });
        return;
      }
      containerManager.setWebUiReady(botId, true);
      broadcastToClients(wss, 'bot:updated', containerManager.getBot(botId));
      res.json({ success: true });
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
          broadcastToClients(wss, 'bot:rebuilt', withActiveOp(containerManager.getBot(botId)));
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

  /**
   * PUT /api/bots/:id/fleet-backup-config - Update the sidecar backup schedule
   * on the INSTANCE (enabled / hour / keep). Mirrors /auto-update.
   */
  router.put('/:id/fleet-backup-config', async (req: Request, res: Response) => {
    try {
      const bot = containerManager.getBot(req.params.id);
      if (!bot) {
        res.status(404).json({ success: false, error: 'Bot not found' });
        return;
      }

      const { enabled, hour, keep } = req.body as { enabled: boolean; hour?: number; keep?: number };
      if (typeof enabled !== 'boolean') {
        res.status(400).json({ success: false, error: 'enabled (boolean) is required' });
        return;
      }

      const updated = containerManager.updateInstanceFleetBackup(req.params.id, enabled, hour, keep);
      broadcastToClients(wss, 'bot:updated', updated);
      res.json({ success: true, fleetBackup: updated?.fleetBackup });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  /**
   * GET /api/bots/:id/fleet-backups - List sidecar dump files, newest first.
   */
  router.get('/:id/fleet-backups', async (req: Request, res: Response) => {
    try {
      const bot = containerManager.getBot(req.params.id);
      if (!bot) {
        res.status(404).json({ success: false, error: 'Bot not found' });
        return;
      }
      res.json({ success: true, backups: fleetBackup.listFleetBackups(req.params.id) });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  /**
   * POST /api/bots/:id/fleet-backups/restore - Restore a dump into the sidecar.
   * Stops every instance on the same URL, takes a pre-restore safety dump
   * (refusing the restore if it fails), pg_restores, restarts the instances.
   */
  router.post('/:id/fleet-backups/restore', async (req: Request, res: Response) => {
    try {
      const bot = containerManager.getBot(req.params.id);
      if (!bot) {
        res.status(404).json({ success: false, error: 'Bot not found' });
        return;
      }

      const { file } = req.body as { file?: string };
      if (!file || typeof file !== 'string') {
        res.status(400).json({ success: false, error: 'file is required' });
        return;
      }
      if (/[/\\]/.test(file)) {
        res.status(400).json({ success: false, error: 'file must be a bare file name' });
        return;
      }

      const result = await fleetBackup.restoreFleetBackup(req.params.id, file);
      res.json(result.success
        ? { success: true, steps: result.steps }
        : { success: false, error: result.error, steps: result.steps });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  /**
   * GET /api/bots/:id/fleet-replication - Replication posture + live probe.
   * include=block adds the replica copy block (DSN + pinned cert; behind
   * manager auth by design, like the env editor).
   */
  router.get('/:id/fleet-replication', async (req: Request, res: Response) => {
    try {
      const bot = containerManager.getBot(req.params.id);
      if (!bot) {
        res.status(404).json({ success: false, error: 'Bot not found' });
        return;
      }
      const status = await fleetReplication.getFleetReplicationStatus(bot);
      if (status.enabled && req.query.include === 'block') {
        const block = await fleetReplication.getReplicaCopyBlock(bot);
        res.json({ success: true, replication: status, block: block.success ? { dsn: block.dsn, cert: block.cert } : null, blockError: block.success ? null : block.error });
        return;
      }
      res.json({ success: true, replication: status });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  /**
   * POST /api/bots/:id/fleet-replication - Enable/update ({enabled:true,
   * publicHost, hostPort?}) or disable ({enabled:false}) the replication
   * posture. Port publish and the rewritten URL apply on the next start.
   */
  router.post('/:id/fleet-replication', async (req: Request, res: Response) => {
    try {
      const bot = containerManager.getBot(req.params.id);
      if (!bot) {
        res.status(404).json({ success: false, error: 'Bot not found' });
        return;
      }
      const { enabled, publicHost, hostPort } = req.body as { enabled?: boolean; publicHost?: string; hostPort?: number };
      if (typeof enabled !== 'boolean') {
        res.status(400).json({ success: false, error: 'enabled (boolean) is required' });
        return;
      }
      let result;
      if (enabled) {
        if (!publicHost || typeof publicHost !== 'string') {
          res.status(400).json({ success: false, error: 'publicHost is required to enable replication' });
          return;
        }
        result = await fleetReplication.enableFleetReplication(bot, publicHost, hostPort);
      } else {
        result = await fleetReplication.disableFleetReplication(bot);
      }
      if (result.success) broadcastToClients(wss, 'bot:updated', containerManager.getBot(req.params.id));
      res.json(result);
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  /**
   * PUT /api/bots/:id/web-auth - Set the public URL auth mode on the INSTANCE.
   * Applies on the bot's next start.
   */
  router.put('/:id/web-auth', async (req: Request, res: Response) => {
    try {
      const bot = containerManager.getBot(req.params.id);
      if (!bot) {
        res.status(404).json({ success: false, error: 'Bot not found' });
        return;
      }

      const { mode } = req.body as { mode?: string };
      if (mode !== 'auto' && mode !== 'managed' && mode !== 'public') {
        res.status(400).json({ success: false, error: "mode must be 'auto', 'managed' or 'public'" });
        return;
      }

      const updated = containerManager.updateInstanceWebAuth(req.params.id, mode);
      broadcastToClients(wss, 'bot:updated', updated);
      res.json({ success: true, bot: updated });
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

      // A reserved or already-used name is auto-uniquified on install rather than
      // rejected, so report the name we would actually use instead of an error.
      let uniqueName: string;
      try {
        uniqueName = makeUniqueName(name, existingInstances, excludeId);
      } catch (err) {
        res.json({ valid: false, errors: [err instanceof Error ? err.message : String(err)] });
        return;
      }
      const names = resolveNames(uniqueName);
      const reuse = checkFolderReuse(names.sanitizedName, existingInstances);

      res.json({ valid: true, errors: [], ...names, ...reuse, adjusted: uniqueName !== name, requestedName: name });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  /**
   * GET /api/recover-envs?name=<displayName>
   * Returns recoverable plaintext env vars for a name, pulled from:
   *   1. newest deleted-bot vault group matching sanitizedName
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
      const sensitivePatterns = ['TOKEN', 'SECRET', 'PASSWORD', 'API_KEY'];
      const isSensitive = (key: string) => sensitivePatterns.some(p => key.toUpperCase().includes(p));

      // Source 1: newest deleted-bot vault group matching this name
      const fromVault: Record<string, string> = {};
      const matchingGroup = loadVault().deletedBots
        .filter(g => g.sanitizedName === targetSanitized)
        .sort((a, b) => b.deletedAt - a.deletedAt)[0];
      for (const entry of matchingGroup?.entries || []) {
        fromVault[entry.key] = entry.value;
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

/**
 * Redact the password portion of a database URL.
 */
function redactDbUrl(url: string): string {
  return url.replace(/(:\/\/[^:@/]*):[^@]*@/, '$1:***@');
}

/**
 * Scrub a psql error for the response: any occurrence of the full URL becomes
 * its redacted form, and any occurrence of the password (raw or URI-decoded)
 * becomes ***.
 */
function redactDbError(text: string, url: string): string {
  let out = text.split(url).join(redactDbUrl(url));
  const secrets = new Set<string>();
  try {
    const pw = new URL(url).password;
    if (pw) {
      secrets.add(pw);
      try { secrets.add(decodeURIComponent(pw)); } catch { /* keep raw */ }
    }
  } catch {
    const m = url.match(/:\/\/[^:@/]*:([^@]+)@/);
    if (m) secrets.add(m[1]);
  }
  for (const pw of secrets) {
    if (pw) out = out.split(pw).join('***');
  }
  return out;
}

/**
 * TLS hint for remote databases: the host is not local (localhost/loopback and
 * managed sidecars excluded) and the URL carries no sslmode parameter.
 */
function sslModeHint(url: string): string | null {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return null;
    if (host.endsWith('-fleet-postgres')) return null;
    if (u.searchParams.has('sslmode')) return null;
    return 'consider sslmode=require for a remote database';
  } catch {
    return null;
  }
}

/**
 * CasaOS Open URL for a running web bot: the bot's Caddy route on the platform
 * gateway (`https://<sanitizedName>-<APP_DOMAIN>`) plus the web-UI index path. Auth
 * is the gateway's job (AppShield), not a URL param. Mirrors how pcsProcessing
 * stamps caddy_0 = `${appName}-${APP_DOMAIN}` for the web service. Returns null when
 * APP_DOMAIN is unavailable (not on Yundera) or the deployed compose declares no
 * web UI, so the UI shows no button rather than a fabricated link.
 */
function casaosWebOpenUrl(sanitizedName: string, botId: string): string | null {
  const appDomain = process.env.APP_DOMAIN || '';
  if (!appDomain) return null;
  const dataRoot = process.env.DATA_ROOT || '/DATA';
  const casaosPath = path.join(dataRoot, 'AppData', 'casaos', 'apps', sanitizedName, 'docker-compose.yml');
  const composePath = fs.existsSync(casaosPath) ? casaosPath : path.join(getBotDir(botId), 'docker-compose.yml');
  if (!fs.existsSync(composePath)) return null;
  const webUiPath = getWebUiIndexPath(fs.readFileSync(composePath, 'utf-8')) || '/';
  return `https://${sanitizedName}-${appDomain}${webUiPath}`;
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
