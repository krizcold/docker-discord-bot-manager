/**
 * Bot API Routes
 * RESTful API for managing Discord bot instances
 */

import { Router, Request, Response, NextFunction } from 'express';
import { WebSocketServer } from 'ws';
import { randomUUID } from 'crypto';
import * as containerManager from '../../docker/containerManager';
import { fsWriteBody } from '../fsWriteBody';
import { pipeContainerLogs } from '../logStream';
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
import * as fleetReplica from '../../instance/fleetReplica';
import { loadVault, readVault, saveVault, vaultFileBroken } from './vault';
import { getDeploymentInfo, setDeploymentMode, getDeploymentMode, DeploymentModeForcedError } from '../../casaos/detector';
import { broadcastToClients } from '../server';
import { DeploymentMode, FleetBackupConfig, InstanceConfig } from '../../types';
import { logCollectors, LOG_BOOT_ID } from '../../build/logCollector';
import { makeUniqueName, validateName, resolveNames, checkFolderReuse, sanitizeName, InstallSource } from '../../naming';
import * as fs from 'fs';
import * as path from 'path';
import { readEnvsFromComposeFile } from '../../docker/containerManager';
import { getFleetControlPort, fleetPublicHost, fleetHostSuffix, fleetAppContainerName, getAppServiceName, getWebUiIndexPath, sharedNetworkName, frontingGatewayDropped, botPortBind, isLoopbackBind } from '../../templates/pcsProcessing';
import { getBotDir, getEnvPath } from '../../git/repoManager';
import { probeDatabaseUrl } from '../dbProbe';
import { listCorruptCopies } from '../../config/storeFile';
import { getAppFacts, hasAppHooks } from '../../instance/appHookClient';
import { backupModeConsent, findAppCapabilities, foldedRoleValue } from '../../config/appCapabilities';
import { isAutoRebuilding } from '../../instance/instanceUpdater';

const BOT_MANAGER_KEYS = new Set(['BOT_ID', 'BOT_MANAGER_UPDATE_TOKEN', 'BOT_MANAGER_INTERNAL_URL']);

// Every record that leaves for the browser (response or WS broadcast) goes
// through this: the registry-held secrets never ship to the UI.
const publicBot = containerManager.withoutRecordSecrets;

// Full-bot WS payloads carry activeOp so cards can clear/set busy state
// without waiting for the next GET /api/bots refresh.
function withActiveOp<T extends { id: string } | null | undefined>(bot: T): T | (T & { activeOp: string | null }) {
  if (!bot) return bot;
  return { ...bot, activeOp: containerManager.isBotBusy(bot.id) };
}

// The computed health keys every bot record carries to the page, so a push
// never replaces them with the raw record's fleetBackup config.
function botHealth(bot: InstanceConfig): { fleetBackup: Record<string, unknown> | null; fenceStuck: string | null } {
  return {
    fleetBackup: bot.fleetDb ? {
      lastAt: bot.lastFleetBackupAt || null,
      stale: fleetBackup.isFleetBackupStale(bot),
      lastError: fleetBackup.getFleetBackupError(bot.id),
      restoreError: fleetBackup.getFleetRestoreError(bot.id),
      scoped: fleetBackup.fleetBackupScopeState(bot),
      ...fleetBackup.effectiveFleetBackup(bot),
    } : null,
    fenceStuck: fleetBackup.getFleetFenceStuck(bot.id),
  };
}

function withHealth<T extends { id: string } | null | undefined>(bot: T): T {
  const record = bot ? containerManager.getBot(bot.id) : null;
  return record ? { ...bot, ...botHealth(record) } : bot;
}

type HealthPush = { id: string } & ReturnType<typeof botHealth>;

/** Pushes for the bots whose verdict or backup status changed since the last call. */
export function collectHealthChanges(seen: Map<string, string>): HealthPush[] {
  const changed: HealthPush[] = [];
  const live = new Set<string>();
  for (const bot of containerManager.getAllBots()) {
    live.add(bot.id);
    let health: ReturnType<typeof botHealth>;
    try { health = botHealth(bot); } catch { continue; }
    const key = JSON.stringify([health.fleetBackup, health.fenceStuck]);
    if (seen.get(bot.id) === key) continue;
    seen.set(bot.id, key);
    changed.push({ id: bot.id, ...health });
  }
  for (const id of [...seen.keys()]) if (!live.has(id)) seen.delete(id);
  return changed;
}

const HEALTH_PUSH_MS = 15000;

const FLEET_MASTER_FACTS_TIMEOUT_MS = 3000;

const UPDATE_HEAD_UNREAD = "The source checkout's current commit could not be read, so the manager can't confirm whether an update is available.";
const UPDATE_BUILT_UNKNOWN = "The manager has no record of the commit this bot was built from, so it can't confirm whether an update is available. Rebuilding the bot records it.";
const UPDATE_SOURCE_MISSING = "The bot's source is not in the source list, so the manager can't confirm whether an update is available.";

/** The deployed value of one env key, or null when the deployed compose is missing or unreadable, lacks it or holds two values. */
function deployedEnvValue(botId: string, key: string): string | null {
  const deployed = containerManager.deployedComposeEnvValues(botId, [key], true);
  if (!deployed || deployed.length === 0) return null;
  const values = new Set(deployed.map(d => d.value.trim()));
  return values.size === 1 ? [...values][0] : null;
}

/** The role a bot was deployed with, folded; null when the deployed compose is missing, unreadable or holds two values. */
function deployedRole(botId: string, roleEnv: Parameters<typeof foldedRoleValue>[0]): string | null {
  const deployed = containerManager.deployedComposeEnvValues(botId, [roleEnv.key], true);
  if (!deployed) return null;
  const values = new Set(deployed.map(d => foldedRoleValue(roleEnv, d.value)));
  if (values.size > 1) return null;
  return values.size === 1 ? [...values][0] : foldedRoleValue(roleEnv, undefined);
}

export function createBotRoutes(wss: WebSocketServer): Router {
  const router = Router();

  // A lane admitted during SIGTERM's bounded wait would be cut short by the exit; a bot's web-UI ping changes no lane.
  router.use(function shutdownGate(req: Request, res: Response, next: NextFunction) {
    if (!containerManager.isShuttingDown() || req.method === 'GET' || req.method === 'HEAD' || /^\/[^/]+\/webui-ready$/.test(req.path)) return next();
    res.status(503).json({ success: false, error: containerManager.SHUTDOWN_REFUSAL });
  });

  const healthSeen = new Map<string, string>();
  setInterval(() => {
    try {
      if (containerManager.registryFault()) return;
      for (const push of collectHealthChanges(healthSeen)) broadcastToClients(wss, 'bot:health', push);
    } catch (err) {
      console.error('[HealthPush] Health read failed:', err);
    }
  }, HEALTH_PUSH_MS).unref();

  router.use((req: Request, res: Response, next) => {
    const registryFault = containerManager.registryFault();
    if (registryFault) {
      res.status(503).json({ success: false, broken: true, error: registryFault });
      return;
    }
    next();
  });

  /**
   * GET /api/bots - List all bot instances
   * Joins source info for each instance.
   */
  router.get('/', async (req: Request, res: Response) => {
    try {
      const bots = containerManager.getAllBots();
      // The mode only builds the CasaOS Open link: an undecided mode must not
      // hide the bots, so the list carries on without it.
      let mode: Awaited<ReturnType<typeof getDeploymentMode>> | null = null;
      let deploymentModeError: string | undefined;
      try {
        mode = await getDeploymentMode();
      } catch (error: any) {
        deploymentModeError = String(error?.message || error);
      }

      // Join source info + compute commits-behind for bots that are behind
      const heads = new Map<string, Promise<string | null>>();
      const botsWithSource = await Promise.all(bots.map(async bot => {
        let source = null;
        let updateAvailable = false;
        let updateCantConfirm: string | undefined;
        let sourceHead: string | null = null;
        let behindBy = 0;

        if (bot.sourceId) {
          source = sourceManager.getSource(bot.sourceId);
          if (source && bot.lastBuiltCommit) {
            if (!heads.has(bot.sourceId)) heads.set(bot.sourceId, sourceManager.readSourceHead(bot.sourceId));
            const head = await heads.get(bot.sourceId)!;
            sourceHead = head;
            if (head === null) {
              updateCantConfirm = UPDATE_HEAD_UNREAD;
            } else {
              updateAvailable = bot.lastBuiltCommit !== head;
              if (updateAvailable) {
                behindBy = await sourceManager.getCommitsBehind(bot.sourceId, bot.lastBuiltCommit);
              }
            }
          }
          if (source && !bot.lastBuiltCommit) updateCantConfirm = UPDATE_BUILT_UNKNOWN;
        }
        if (!source && bot.lastBuiltCommit) updateCantConfirm = UPDATE_SOURCE_MISSING;

        // CasaOS Open link: docker mode already carries publicUrl/hostPort; on CasaOS
        // neither exists, so derive the gateway URL from the bot's Caddy host here.
        const webOpenUrl = (mode === 'casaos' && bot.status === 'running')
          ? casaosWebOpenUrl(bot.sanitizedName, bot.id)
          : null;

        // A decommissioned database's safety dump must stay reachable: this
        // is the Database button's only reason to render once fleetDb is gone.
        let hasDbBackups: boolean | undefined;
        if (!bot.fleetDb) {
          try { hasDbBackups = fleetBackup.listFleetBackups(bot.id).length > 0; } catch { hasDbBackups = true; }
        }

        return {
          ...publicBot(bot)!,
          autoUpdate: bot.autoUpdate || false,
          autoUpdateInterval: bot.autoUpdateInterval || 86400000,
          autoUpdateHour: bot.autoUpdateHour ?? 4,
          hasDbBackups,
          ...(containerManager.getReconcileRead(bot.id) ?? { statusCheckedAt: null, servicesUp: null }),
          // Sidecar backup status (null without a managed fleet DB) and the
          // sampler's cached verdict; changes reach open tabs as bot:health.
          ...botHealth(bot),
          // Fleet-worker marker: drives the Database button's replica surface.
          // A node that dials out per its app's own record; the default fold
          // keeps an absent role out of the dial-out set (R7), and an app
          // declaring no control plane has no worker semantics at all.
          fleetWorker: (() => {
            const cp = findAppCapabilities(bot.sourceUrl)?.controlPlane;
            return !!cp && cp.roleEnv.dialsOut.includes(foldedRoleValue(cp.roleEnv, bot.envVars?.[cp.roleEnv.key]));
          })(),
          // The node's consent to active (stand-in) mode as its SAVED env holds
          // it, read by the key its app declares (20.5, B6-j); null where the
          // declared row does not apply to this node. The enable is the app's own.
          fleetBackupConsent: backupModeConsent(findAppCapabilities(bot.sourceUrl), bot.envVars),
          // Whether this app declares lifecycle hooks, so the UI knows if the
          // one-click surfaces can work at all before offering them.
          appHooks: hasAppHooks(bot),
          source: source ? { id: source.id, composeName: source.composeName, lastCommitHash: source.lastCommitHash, url: source.url, autoUpdate: source.autoUpdate } : null,
          updateAvailable,
          ...(updateCantConfirm ? { updateCantConfirm } : {}),
          sourceHead,
          behindBy,
          webOpenUrl,
          // Effective readiness (ping or grace fallback) drives the Open button.
          webUiReady: containerManager.isBotWebUiReady(bot),
          activeOp: containerManager.isBotBusy(bot.id),
        };
      }));

      const bind = botPortBind();
      res.json({ success: true, bots: botsWithSource, deploymentMode: mode, portBind: { bind, loopback: isLoopbackBind(bind) }, ...(deploymentModeError ? { deploymentModeError } : {}) });
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
        broadcastToClients(wss, 'bot:created', publicBot(bot));
        res.json({ success: true, bot: publicBot(bot) });
        return;
      }

      if (body.sourceId) {
        const bot = await containerManager.createInstance({
          sourceId: body.sourceId,
          displayName: body.displayName,
          envVars: body.envVars,
        });
        broadcastToClients(wss, 'bot:created', publicBot(bot));
        res.json({ success: true, bot: publicBot(bot) });
        return;
      }

      res.status(400).json({ success: false, error: 'Must provide sourceId or sourceType=docker-image' });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  /**
   * GET /api/bots/fleet/masters - Fleet dial targets running on this manager,
   * with the connection info a joining worker install needs. Returns the shared
   * control secret in plaintext like /api/recover-envs does: the whole API sits
   * behind the manager's auth edge and the value exists to be filled into a
   * joining worker's secret field.
   * Each entry carries two addresses: localUrl for a same-manager worker (dials
   * over the shared network, no public round-trip) and masterUrl for a genuinely
   * cross-host worker (public secure URL). Either may be null when it cannot be
   * derived. Also returns fleetUrlTemplate: a full URL template with a {name}
   * placeholder for the sanitized instance name, so the install wizard can
   * preview a new node's public URL without composing one itself; null when no
   * public base exists.
   */
  router.get('/fleet/masters', async (req: Request, res: Response) => {
    try {
      const dataRoot = process.env.DATA_ROOT || '/DATA';
      // Only the lane this mode's deploy attaches: casaos routes APP_DOMAIN, docker BOT_DOMAIN_BASE.
      const mode = await getDeploymentMode();
      // Deployed compose, resolved like containerManager's resolveComposePath:
      // CasaOS metadata path when present, else the bot-dir copy. Schemes come
      // from the bot's own record: the public route is TLS-terminated at the
      // proxy, the same-box container-name dial never is.
      const fleetAddrsOf = (bot: { id: string; sanitizedName: string }, urlScheme: { secure: string; plain: string }) => {
        const casaosPath = path.join(dataRoot, 'AppData', 'casaos', 'apps', bot.sanitizedName, 'docker-compose.yml');
        const composePath = fs.existsSync(casaosPath) ? casaosPath : path.join(getBotDir(bot.id), 'docker-compose.yml');
        if (!fs.existsSync(composePath)) return null;
        const composeContent = fs.readFileSync(composePath, 'utf-8');
        const controlPort = getFleetControlPort(composeContent);
        if (controlPort === null) return null;

        // Public URL a genuinely cross-host worker uses. Same URL the
        // injection path authors under the record's publicUrl key; null when no
        // publicly-trusted base exists for the mode (e.g. standalone/Windows).
        const host = fleetPublicHost(bot.sanitizedName, mode);
        const publicUrl = host ? `${urlScheme.secure}://${host}` : null;

        // Local URL a same-host/same-manager worker should dial instead, so the
        // handshake stays on the box rather than looping out through the public
        // gateway. Both modes dial the app container by name over the shared
        // network (pcs on CasaOS, dbm_internal in docker mode):
        // host.docker.internal is Docker Desktop-only and the fleet host port is
        // loopback-bound, so on bare Linux a container-name dial is the only
        // route that works.
        const cname = fleetAppContainerName(composeContent);
        const localUrl = cname ? `${urlScheme.plain}://${cname}:${controlPort}` : null;
        return { publicUrl, localUrl };
      };

      // Secondary dial targets per each bot's own record: every folded role
      // value AFTER the first entry of dialTargetOrder. One shared secret per
      // fleet pairs them with their primary; the manager reads only the
      // POSITION, never what the values mean. Secondaries come second in a
      // candidate list (the first dial target leads).
      const secondaries: Array<{ id: string; localUrl: string | null; publicUrl: string | null; secret: string }> = [];
      for (const bot of containerManager.getAllBots()) {
        try {
          const cp = findAppCapabilities(bot.sourceUrl)?.controlPlane;
          if (!cp || !cp.groupSecretEnv) continue;
          const folded = deployedRole(bot.id, cp.roleEnv);
          if (folded === null || cp.roleEnv.dialTargetOrder.indexOf(folded) <= 0) continue;
          const secret = deployedEnvValue(bot.id, cp.groupSecretEnv);
          if (!secret) continue;
          const addrs = fleetAddrsOf(bot, cp.urlScheme);
          if (!addrs) continue;
          secondaries.push({ id: bot.id, localUrl: addrs.localUrl, publicUrl: addrs.publicUrl, secret });
        } catch {
          // an unreadable instance must not break the list
        }
      }

      type MasterEntry = {
        id: string; name: string; masterUrl: string | null; localUrl: string | null;
        secretSet: boolean; controlSecret: string; secretUnfilled: string | null; localCandidates: string[]; publicCandidates: string[];
        unanswered: string | null;
      };
      // One slot per candidate in record order; a slot settles to null when the app says it is not a live master.
      const slots: Array<Promise<MasterEntry | null>> = [];
      for (const bot of containerManager.getAllBots()) {
        try {
          const cp = findAppCapabilities(bot.sourceUrl)?.controlPlane;
          if (!cp) continue;
          const env = envManager.getEnvVars(bot.id);
          // The deployed role decides, not a saved edit not yet applied; a blank one folds to the record's default.
          const folded = deployedRole(bot.id, cp.roleEnv);
          if (folded === null || folded !== cp.roleEnv.dialTargetOrder[0]) continue;
          const addrs = fleetAddrsOf(bot, cp.urlScheme);
          if (!addrs || (!addrs.publicUrl && !addrs.localUrl)) continue;

          const controlSecret = cp.groupSecretEnv ? (env[cp.groupSecretEnv] || '').trim() : '';
          // Positions in dialTargetOrder are disjoint, so a node cannot match
          // both lists; the id filter stays as a cheap invariant guard.
          const runSecret = cp.groupSecretEnv ? deployedEnvValue(bot.id, cp.groupSecretEnv) : null;
          const peers = !runSecret ? [] : secondaries.filter(b => b.secret === runSecret && b.id !== bot.id);
          // The wizard fills only the secret the node was deployed with.
          let secretUnfilled: string | null = null;
          if (cp.groupSecretEnv && controlSecret !== '') {
            const deployed = containerManager.deployedComposeEnvValues(bot.id, [cp.groupSecretEnv], true);
            if (deployed === undefined) secretUnfilled = `The deployed setup of ${bot.displayName} could not be read, so its fleet secret is not filled in. Paste it from that node (its Usage tab > Connect a worker).`;
            else if (!deployed || deployed.length === 0 || deployed.some(d => d.value.trim() !== controlSecret)) secretUnfilled = `The saved fleet secret of ${bot.displayName} is not the one it was deployed with, so it is not filled in. Restart ${bot.displayName} to apply its saved settings, then reopen this form.`;
          }
          const dedupe = (urls: Array<string | null>) => [...new Set(urls.filter((u): u is string => !!u))];
          const localCandidates = dedupe([addrs.localUrl, ...peers.map(p => p.localUrl)]);
          const publicCandidates = dedupe([addrs.publicUrl, ...peers.map(p => p.publicUrl)]);
          const entry: MasterEntry = {
            id: bot.id, name: bot.displayName, masterUrl: addrs.publicUrl, localUrl: addrs.localUrl,
            secretSet: controlSecret !== '', controlSecret: secretUnfilled ? '' : controlSecret, secretUnfilled, localCandidates, publicCandidates,
            unanswered: null,
          };
          const cantConfirm = `${bot.displayName} did not answer, so the manager can't confirm it is running as the fleet's master.`;
          const unanswered = (): MasterEntry => ({ ...entry, unanswered: cantConfirm });
          if (!hasAppHooks(bot)) {
            slots.push(Promise.resolve(unanswered()));
            continue;
          }
          slots.push(getAppFacts(bot, FLEET_MASTER_FACTS_TIMEOUT_MS).then(read => {
            const f = read.success ? read.facts : undefined;
            if (!f) return unanswered();
            return f.running && f.initialized && f.role === 'master' && !f.superseded ? entry : null;
          }, unanswered));
        } catch {
          // an unreadable instance must not break the list
        }
      }
      const masters = (await Promise.all(slots)).filter((m): m is MasterEntry => m !== null);
      // A full template rather than a bare host suffix, so the browser never
      // composes a URL (or assumes a scheme) itself.
      const suffix = fleetHostSuffix(mode);
      res.json({ success: true, fleetUrlTemplate: suffix === null ? null : `wss://{name}${suffix}`, masters });
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
      let updateCantConfirm: string | undefined;

      if (bot.sourceId) {
        source = sourceManager.getSource(bot.sourceId);
        if (source) {
          repoInfo = await sourceManager.getSourceRepoInfo(bot.sourceId);
          if (bot.lastBuiltCommit) {
            const head = await sourceManager.readSourceHead(bot.sourceId);
            if (head === null) updateCantConfirm = UPDATE_HEAD_UNREAD;
            else updateAvailable = bot.lastBuiltCommit !== head;
          } else {
            updateCantConfirm = UPDATE_BUILT_UNKNOWN;
          }
        }
      }
      if (!source && bot.lastBuiltCommit) updateCantConfirm = UPDATE_SOURCE_MISSING;

      res.json({ success: true, bot: withActiveOp(publicBot(bot)), source, repoInfo, updateAvailable, ...(updateCantConfirm ? { updateCantConfirm } : {}) });
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

      broadcastToClients(wss, 'bot:updated', publicBot(bot));
      res.json({ success: true, bot: publicBot(bot) });
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

      broadcastToClients(wss, 'bot:updated', publicBot(bot));
      res.json({ success: true, bot: publicBot(bot) });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  /**
   * DELETE /api/bots/:id - Delete a bot instance
   */
  router.delete('/:id', async (req: Request, res: Response) => {
    try {
      const keepData = req.query.keepData !== 'false';
      const keepEnv = req.query.keepEnv !== 'false'; // default true (preserve env)
      const confirmFleetData = req.query.confirmFleetData === 'true';
      const confirmPromoted = req.query.confirmPromoted === 'true';
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

      const refusal = await fleetReplica.instanceRemovalRefusal(bot, keepData, confirmFleetData, confirmPromoted);
      if (refusal) {
        res.status(409).json({ success: false, ...refusal });
        return;
      }
      let dbDumps = 0;
      try { dbDumps = fleetBackup.listFleetBackups(req.params.id).length; } catch { /* the answer then names none */ }
      const keptReplicaVolume = !keepData ? bot.fleetDbReplicaKept?.volume : undefined;

      // Docker mode keys a bot's data folder by its id, so a later install
      // under the same name starts on a new, empty folder.
      const keptDataDir = keepData && (await getDeploymentMode()) === 'docker'
        ? containerManager.hostBotDirFor(req.params.id)
        : undefined;

      // When keepEnv=true (default), preserve env vars in vault for recovery.
      // When keepEnv=false, user explicitly wants them gone; don't save.
      // Every removal creates a new group so repeated removals of a same-named
      // bot are kept as separate recoverable versions. Saved before deleteBot
      // for crash-safety, rolled back if the deletion fails.
      let savedGroupId: string | null = null;
      if (keepEnv) {
        // A corrupt store would vault NOTHING, and undecryptable values would
        // vault as empty strings, while the deletion goes on to destroy the
        // bot dir including the last recoverable copy (a storage.json.corrupt-<time> copy,
        // or ciphertext a restored key file would decrypt again) - on the very
        // lane that promises preservation. Refuse; unchecking the env-preserve
        // option is the explicit consent path for deleting anyway.
        const { corrupt, undecryptable } = envManager.getEnvVarsWithStatus(req.params.id);
        if (corrupt) {
          res.status(409).json({ success: false, error: 'The env store for this bot cannot be read (a copy is kept beside it as storage.json.corrupt-<time> when it could be read), so its values cannot be vaulted. Restore the store first, or delete again without preserving env values to proceed.' });
          return;
        }
        if (undecryptable.length > 0) {
          res.status(409).json({ success: false, error: `The env store for this bot holds values that no longer decrypt (${undecryptable.join(', ')}), so they cannot be vaulted. Restoring the original encryption key would recover them; or delete again without preserving env values to proceed.` });
          return;
        }
        try {
          const envVars = envManager.getEnvVars(req.params.id);
          const entries = Object.entries(envVars || {})
            .filter(([key]) => !BOT_MANAGER_KEYS.has(key))
            .map(([key, value]) => ({ key, value }));
          if (entries.length > 0) {
            // An unreadable vault file loads as an empty vault, so saving the
            // new group into it would overwrite every previously vaulted
            // group. Probed only when there is something to vault: an empty
            // env store must not block the delete.
            if (vaultFileBroken()) {
              res.status(409).json({ success: false, error: 'The credentials vault (vault.json) exists but cannot be read, so preserving this bot\'s env values would overwrite every previously vaulted group. Repair or remove vault.json first (a copy of the damaged file is kept beside it as vault.json.corrupt-<time> when it could be read), or delete again without preserving env values to proceed.' });
              return;
            }
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
        } catch (err) {
          // A failed vault write on the lane that promises preservation must
          // refuse the deletion, not warn and destroy the only copy.
          res.status(409).json({ success: false, error: `Preserving the env values in the vault failed (${err}), so nothing was deleted. Fix the vault write, or delete again without preserving env values to proceed.` });
          return;
        }
      }

      const rollbackVaultGroup = () => {
        if (!savedGroupId) return;
        try {
          // A failed deleteBot may still have destroyed the bot dir (and the
          // env store in it) before its failure gate threw; the vault group is
          // then the only surviving copy and must stay. A duplicate group from
          // a later successful retry is benign; a removed group is
          // unrecoverable.
          if (!fs.existsSync(path.join(getEnvPath(req.params.id), 'storage.json'))) {
            console.warn('[API] Delete failed after the env store was destroyed; keeping the vault group as the only surviving copy');
            return;
          }
          const vault = loadVault();
          vault.deletedBots = vault.deletedBots.filter(g => g.id !== savedGroupId);
          saveVault(vault);
        } catch (err) {
          console.warn(`[API] Failed to roll back vault group: ${err}`);
        }
      };

      const envCopies = containerManager.botEnvCopies(req.params.id);
      let success: boolean;
      try {
        success = await containerManager.deleteBot(req.params.id, keepData, keepEnv, confirmFleetData, confirmPromoted);
      } catch (err) {
        rollbackVaultGroup();
        throw err;
      }
      if (!success) {
        rollbackVaultGroup();
        res.status(404).json({ success: false, error: 'Bot not found' });
        return;
      }

      const envDeleted = !keepEnv && envCopies.every(p => !fs.existsSync(p));
      broadcastToClients(wss, 'bot:deleted', { id: req.params.id });
      res.json({
        success: true, vaulted: savedGroupId !== null, envDeleted,
        ...(keptDataDir ? { keptDataDir } : {}),
        ...(dbDumps > 0 ? { dbDumpsKept: { count: dbDumps, folder: `backups/${req.params.id}/fleet-postgres` } } : {}),
        ...(keptReplicaVolume ? { keptReplicaVolume } : {}),
      });
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

      const refusal = containerManager.startPreflightRefusal(req.params.id);
      if (refusal) {
        res.status(409).json(refusal);
        return;
      }

      const opId = randomUUID();
      res.json({ success: true, message: 'Starting bot', opId });

      const botId = req.params.id;
      containerManager.startBot(botId).then((result) => {
        const updatedBot = withHealth(withActiveOp(publicBot(containerManager.getBot(botId))));
        if (result.success) {
          broadcastToClients(wss, 'bot:started', { ...updatedBot, opId, ...(result.warning ? { warning: result.warning } : {}) });
        } else {
          broadcastToClients(wss, 'bot:start-failed', { id: botId, opId, error: result.error });
        }
      }).catch((err) => {
        broadcastToClients(wss, 'bot:start-failed', { id: botId, opId, error: String(err) });
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

      const bot = withHealth(withActiveOp(publicBot(containerManager.getBot(req.params.id))));
      broadcastToClients(wss, 'bot:stopped', bot);
      res.json(result.warning ? { success: true, bot, warning: result.warning } : { success: true, bot });
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

      const refusal = containerManager.startPreflightRefusal(req.params.id);
      if (refusal) {
        res.status(409).json(refusal);
        return;
      }

      const opId = randomUUID();
      res.json({ success: true, message: 'Restarting bot', opId });

      const botId = req.params.id;
      containerManager.restartBot(botId).then((result) => {
        const updatedBot = withHealth(withActiveOp(publicBot(containerManager.getBot(botId))));
        if (result.success) {
          broadcastToClients(wss, 'bot:restarted', { ...updatedBot, opId, warning: result.warning });
        } else {
          broadcastToClients(wss, 'bot:restart-failed', { id: botId, opId, error: result.error });
        }
      }).catch((err) => {
        broadcastToClients(wss, 'bot:restart-failed', { id: botId, opId, error: String(err) });
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

      const refusal = containerManager.updatePreflightRefusal(req.params.id);
      if (refusal) {
        res.status(409).json(refusal);
        return;
      }

      broadcastToClients(wss, 'bot:pulling', { id: req.params.id });
      const opId = randomUUID();
      res.json({ success: true, message: 'Updating instance from source', opId });

      const botId = req.params.id;

      // Invoked synchronously after res.json so the op lock and log session
      // exist before the client's POST resolves (the frontend connects its SSE
      // stream only after this response). buildGitInstance re-fetches the
      // source itself, so no pre-fetch is needed here.
      containerManager.pullAndRebuild(botId).then((result) => {
        if (result.success) {
          broadcastToClients(wss, 'bot:rebuilt', { ...withActiveOp(publicBot(containerManager.getBot(botId))), opId, ...(result.warning ? { warning: result.warning } : {}) });
        } else {
          broadcastToClients(wss, 'bot:pull-failed', { id: botId, opId, error: result.error });
        }
      }).catch((err) => {
        broadcastToClients(wss, 'bot:pull-failed', { id: botId, opId, error: String(err) });
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

      const refusal = containerManager.buildPreflightRefusal(req.params.id);
      if (refusal) {
        res.status(409).json(refusal);
        return;
      }

      const opId = randomUUID();
      res.json({ success: true, message: 'Build started', opId });

      const botId = req.params.id;
      containerManager.buildBot(botId).then((result) => {
        const updatedBot = withHealth(withActiveOp(publicBot(containerManager.getBot(botId))));
        if (result.success) {
          broadcastToClients(wss, 'bot:built', { ...updatedBot, opId });
        } else {
          broadcastToClients(wss, 'bot:build-failed', { id: botId, opId, error: result.error });
        }
      }).catch((err) => {
        broadcastToClients(wss, 'bot:build-failed', { id: botId, opId, error: String(err) });
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
        res.write(`data: ${JSON.stringify({ ...frame, bootId: LOG_BOOT_ID })}\n\n`);
      }
    };
    const currentStatus = () => containerManager.getBot(botId)?.status || 'unknown';

    const collector = logCollectors.getIfExists(botId);

    if (!collector || collector.opState === 'idle') {
      if (collector) {
        for (const log of collector.getLogs()) writeFrame(log);
      }
      const cutOp = containerManager.cutOpOf(botId);
      writeFrame({ type: 'idle', status: currentStatus(), ...(cutOp ? { cutOp } : {}), timestamp: Date.now() });
      res.end();
      return;
    }

    for (const log of collector.getLogs()) writeFrame(log);

    const writeTerminalFrame = () => {
      const endedAt = collector.opEndedAt || Date.now();
      const ending = {
        op: collector.opName, durationMs: endedAt - collector.opStartedAt,
        finalStatus: collector.opEndStatus || 'unknown', currentStatus: currentStatus(), timestamp: endedAt
      };
      if (collector.opState === 'done') {
        writeFrame({ type: 'done', ...ending });
      } else {
        writeFrame({ type: 'failed', ...ending, error: collector.opError || 'unknown error' });
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

  /** DELETE /api/bots/:id/cut-op - Dismiss the note that a manager restart cut an operation on this bot. */
  router.delete('/:id/cut-op', (req: Request, res: Response) => {
    try {
      if (!containerManager.getBot(req.params.id)) {
        res.status(404).json({ success: false, error: 'Bot not found' });
        return;
      }
      const result = containerManager.dismissCutOp(req.params.id);
      if (result.success && result.dismissed) broadcastToClients(wss, 'bot:updated', publicBot(containerManager.getBot(req.params.id)));
      res.status(result.success ? 200 : 500).json(result);
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  /**
   * GET /api/bots/:id/logs - Get bot logs
   */
  router.get('/:id/logs', async (req: Request, res: Response) => {
    try {
      const tail = parseInt(req.query.tail as string) || 100;
      const result = await containerManager.getBotLogs(req.params.id, tail);
      if (!result.success) {
        res.status(result.unanswered ? 503 : 400).json({ success: false, error: result.error });
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
      if (!containers) {
        res.status(503).json({ success: false, error: 'Docker did not answer, so the containers of this bot could not be listed' });
        return;
      }
      res.json({ success: true, containers, appName });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  /**
   * GET /api/bots/:id/containers/:container/logs/stream - Stream container logs via SSE
   */
  router.get('/:id/containers/:container/logs/stream', async (req: Request, res: Response) => {
    const containerName = req.params.container;
    const lines = parseInt(req.query.lines as string) || 50;

    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(containerName)) {
      res.status(400).json({ success: false, error: 'Invalid container name' });
      return;
    }

    const bot = containerManager.getBot(req.params.id);
    if (!bot) {
      res.status(404).json({ success: false, error: 'Bot not found' });
      return;
    }
    let owned: Array<{ name: string }> | null;
    try {
      owned = await dockerClient.listProjectContainers(bot.sanitizedName);
    } catch {
      owned = null;
    }
    if (!owned) {
      res.status(503).json({ success: false, error: 'Docker did not answer, so the containers of this bot could not be listed' });
      return;
    }
    if (!owned.some((c) => c.name === containerName)) {
      res.status(403).json({ success: false, error: 'Container does not belong to this bot' });
      return;
    }
    if (req.socket?.destroyed) return;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    res.write(`event: connected\ndata: ${JSON.stringify({ message: `Connected to ${containerName} logs` })}\n\n`);

    pipeContainerLogs(req, res, containerName, lines, req.query.follow !== '0');
  });

  /**
   * GET /api/bots/:id/stats - Get bot resource stats
   */
  router.get('/:id/stats', async (req: Request, res: Response) => {
    try {
      const result = await containerManager.getBotStats(req.params.id);
      if (!result.success) {
        res.status(result.unanswered ? 503 : 400).json({ success: false, error: result.error });
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
      let fetched = true;
      try {
        await sourceManager.fetchSource(bot.sourceId);
      } catch (err) {
        fetched = false;
        console.warn(`[API] Failed to fetch source for update check: ${err}`);
      }

      if (!sourceManager.getSource(bot.sourceId)) {
        res.json({ success: true, hasUpdates: false, behindBy: 0, cantConfirm: UPDATE_SOURCE_MISSING });
        return;
      }
      const head = await sourceManager.readSourceHead(bot.sourceId);
      if (head === null) {
        res.json({ success: true, hasUpdates: false, behindBy: 0, cantConfirm: UPDATE_HEAD_UNREAD });
        return;
      }

      if (!bot.lastBuiltCommit) {
        res.json({ success: true, hasUpdates: false, behindBy: 0, cantConfirm: UPDATE_BUILT_UNKNOWN });
        return;
      }

      if (bot.lastBuiltCommit !== head) {
        const behindBy = await sourceManager.getCommitsBehind(bot.sourceId, bot.lastBuiltCommit);
        res.json({ success: true, hasUpdates: true, behindBy: behindBy || 1 });
        return;
      }
      if (!fetched) {
        res.json({ success: true, hasUpdates: false, behindBy: 0, cantConfirm: "The source could not be fetched from its repository, so the manager can't confirm whether an update is available." });
        return;
      }
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

      const repoPath = (bot.sourceType !== 'docker-image' && bot.sourceId)
        ? sourceManager.getSourceRepoPath(bot.sourceId)
        : null;

      const gateway = { dropped: frontingGatewayDropped(await getDeploymentMode(), bot.webAuth), webAuth: bot.webAuth, publicUrl: !!bot.publicUrl };
      const vars = buildBotEnvList(repoPath, req.params.id, bot.tokenVarName, bot.sourceUrl || undefined, gateway);
      const validation = envManager.hasRequiredEnvVars(req.params.id, bot.tokenVarName);
      const storePath = path.join(getEnvPath(req.params.id), 'storage.json');

      res.json({
        success: true,
        vars,
        tokenVarName: bot.tokenVarName,
        valid: validation.valid,
        missing: validation.missing,
        undecryptable: validation.undecryptable,
        storeBroken: envManager.getEnvVarsWithStatus(req.params.id).corrupt,
        corruptCopies: listCorruptCopies(storePath),
        secretKeyProblem: envManager.secretKeyProblem(),
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

      const { vars: given, removed, renamed } = req.body as { vars: Record<string, string>; removed?: string[]; renamed?: Record<string, string> };
      if (!given || typeof given !== 'object') {
        res.status(400).json({ success: false, error: 'vars object is required' });
        return;
      }
      if (removed !== undefined && (!Array.isArray(removed) || removed.some(k => typeof k !== 'string'))) {
        res.status(400).json({ success: false, error: 'removed must be a list of key names' });
        return;
      }
      if (renamed !== undefined && (!renamed || typeof renamed !== 'object' || Array.isArray(renamed) || Object.values(renamed).some(k => typeof k !== 'string'))) {
        res.status(400).json({ success: false, error: 'renamed must map each new key name to its old one' });
        return;
      }
      const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
      // A renamed secret row arrives blank (the editor never shows a stored
      // secret), so the stored value is carried to the new name here; when it
      // cannot be, nothing is saved, or the removal of the old name would
      // destroy the only copy.
      const vars: Record<string, string> = { ...given };
      if (renamed && Object.keys(renamed).length > 0) {
        const stored = envManager.getEnvVars(req.params.id);
        // Taken only when this same save does not free it: a stored name that is
        // neither removed nor itself renamed away (a swap, a chain, or a deleted
        // row whose name another row takes). Carried values below are read from
        // the store before anything is written.
        const sources = new Set(Object.values(renamed));
        const taken = Object.keys(renamed).filter(to => has(stored, to) && !(removed || []).includes(to) && !sources.has(to));
        if (taken.length > 0) {
          res.status(409).json({ success: false, error: `${taken.join(', ')} ${taken.length === 1 ? 'is' : 'are'} already stored, so a rename onto ${taken.length === 1 ? 'it' : 'them'} would overwrite a stored value; nothing was saved. Pick another name, or remove the stored key first.` });
          return;
        }
      }
      const carry = Object.entries(renamed || {}).filter(([to]) => !has(given, to));
      if (carry.length > 0) {
        const { vars: stored, undecryptable, corrupt } = envManager.getEnvVarsWithStatus(req.params.id);
        for (const [to, from] of carry) {
          if (corrupt || undecryptable.includes(from) || !has(stored, from)) {
            res.status(409).json({ success: false, error: `Could not carry the stored value of ${from} to ${to} (${corrupt ? 'the env store cannot be read' : undecryptable.includes(from) ? 'it no longer decrypts' : 'it is not stored'}); nothing was saved. Enter the value for ${to}, then save again.` });
            return;
          }
          vars[to] = stored[from];
        }
      }
      const toRemove = (removed || []).filter(k => !has(vars, k));
      // Same reason as the single-key removal below: an in-flight start would
      // re-bake a removed key into the compose from its stale snapshot.
      if (toRemove.length > 0) {
        const activeOp = containerManager.isBotBusy(req.params.id);
        if (activeOp) {
          res.status(409).json({ success: false, error: `Bot operation in progress (${activeOp}); nothing was saved, retry when it completes` });
          return;
        }
      }

      // updateBot is the dual-write funnel: the store takes everything
      // (sensitive values encrypted), the record keeps the non-sensitive keys.
      await containerManager.updateBot(req.params.id, { envVars: { ...vars } });
      let removal: ReturnType<typeof containerManager.removeStoredEnvKeys>;
      try {
        removal = containerManager.removeStoredEnvKeys(req.params.id, toRemove);
      } catch (err) {
        const stored = envManager.getEnvVars(req.params.id);
        const still = toRemove.filter(k => Object.prototype.hasOwnProperty.call(stored, k));
        broadcastToClients(wss, 'bot:updated', publicBot(containerManager.getBot(req.params.id)));
        res.status(500).json({ success: false, stillStored: still, error: `Saved, but the removal of the deleted keys stopped (${err instanceof Error ? err.message : String(err)})${still.length ? `: ${still.join(', ')} ${still.length === 1 ? 'is' : 'are'} still stored` : ''}; save again to retry the removal` });
        return;
      }
      // A running bot keeps the env it was deployed with until Apply or Restart applies the save.
      let pendingUnrecorded = '';
      try {
        await containerManager.markPendingApplyIfRunning(req.params.id);
      } catch (err) {
        pendingUnrecorded = err instanceof Error ? err.message : String(err);
      }
      const notApplied = containerManager.getBot(req.params.id)?.pendingApply === true;

      const validation = envManager.hasRequiredEnvVars(req.params.id, bot.tokenVarName);
      broadcastToClients(wss, 'bot:updated', publicBot(containerManager.getBot(req.params.id)));
      if (removal.stillStored.length > 0) {
        res.status(500).json({
          success: false,
          removed: removal.removed,
          stillStored: removal.stillStored,
          valid: validation.valid,
          missing: validation.missing,
          error: `Saved${removal.removed.length ? ` and removed ${removal.removed.join(', ')}` : ''}, but could not edit ${removal.composeFailures.join(', ')}, so ${removal.stillStored.join(', ')} ${removal.stillStored.length === 1 ? 'is' : 'are'} still stored; save again to retry the removal`,
        });
        return;
      }
      res.json({
        success: true, removed: removal.removed, valid: validation.valid, missing: validation.missing,
        ...(notApplied ? { notApplied: true } : {}),
        ...(pendingUnrecorded ? { warning: `Saved, but could not record that the running bot needs Apply or Restart to apply it: ${pendingUnrecorded}` } : {}),
      });
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
      const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
      const deployedBefore = containerManager.deployedComposeEnvValues(req.params.id, [req.params.key]);
      const held = has(envManager.getEnvVars(req.params.id), req.params.key) || has(bot.envVars || {}, req.params.key)
        || deployedBefore === undefined || (deployedBefore !== null && deployedBefore.length > 0);
      const unedited = containerManager.removeEnvKeyEverywhere(req.params.id, req.params.key);
      // A running bot keeps the env it was deployed with until Apply or Restart applies the removal.
      let pendingUnrecorded = '';
      if (held) {
        try {
          await containerManager.markPendingApplyIfRunning(req.params.id);
        } catch (err) {
          pendingUnrecorded = err instanceof Error ? err.message : String(err);
        }
      }
      const notApplied = containerManager.getBot(req.params.id)?.pendingApply === true;
      const validation = envManager.hasRequiredEnvVars(req.params.id, bot.tokenVarName);
      broadcastToClients(wss, 'bot:updated', publicBot(containerManager.getBot(req.params.id)));
      if (unedited.length > 0) {
        res.status(500).json({
          success: false,
          valid: validation.valid,
          missing: validation.missing,
          error: `Could not edit ${unedited.join(', ')}, so ${req.params.key} is still stored; retry the removal`,
        });
        return;
      }
      res.json({
        success: true, valid: validation.valid, missing: validation.missing,
        ...(notApplied ? { notApplied: true } : {}),
        ...(notApplied && held ? { message: `${req.params.key} removed. The running bot keeps the env it started with until you Apply or Restart it.` } : {}),
        ...(pendingUnrecorded ? { warning: `Removed, but could not record that the running bot needs Apply or Restart to apply it: ${pendingUnrecorded}` } : {}),
      });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  /**
   * POST /api/bots/:id/validate-db - Test a database URL with a one-shot psql
   * (dbProbe: the password goes by environment, never argv). The run is
   * hard-killed after 10 seconds. Errors surface password-redacted.
   *
   * The probe joins the shared sidecar network, so a managed database's
   * container name resolves here exactly as it does from the bot; on the
   * default bridge it never could. sslmode=no-verify is translated first:
   * that spelling is node-postgres only and libpq rejects the URL outright,
   * which used to fail every managed fleet URL the replication rewrite mints.
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

      const network = sharedNetworkName(await getDeploymentMode());
      const result = await probeDatabaseUrl(target, network);

      if (result.ok) {
        res.json({ success: true, ok: true });
        return;
      }
      const hint = result.notTested ? null : sslModeHint(target);
      res.json({ success: true, ok: false, error: result.error, ...(result.notTested ? { notTested: true } : {}), ...(hint ? { hint } : {}) });
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
      const gateway = { dropped: frontingGatewayDropped(await getDeploymentMode(), bot.webAuth), webAuth: bot.webAuth, publicUrl: !!bot.publicUrl };
      // Attach a guided install manifest + parsed body per file when one exists,
      // so the post-install editor renders the same guided form as the wizard.
      const files = buildBotConfigList(repoPath, req.params.id, source?.url, gateway).map(f => {
        const targetName = path.basename(f.path);
        const manifest = (source?.url ? findManifest(source.url, targetName) : undefined) || null;
        const format = envManager.configFileFormat(targetName);
        let body = f.body;
        let parsed: unknown = null;
        if (manifest) {
          body = sanitizeSeedRows(manifest, body);
          const r = parseConfig(manifest.format, body);
          if (r.ok) parsed = r.data ?? {};
        }
        return { ...f, body, format, manifest, parsed };
      });
      res.json({
        success: true,
        files,
        storeBroken: configFileManager.getConfigFilesWithStatus(req.params.id).corrupt,
        corruptCopies: listCorruptCopies(path.join(getEnvPath(req.params.id), 'configFiles.json')),
        secretKeyProblem: envManager.secretKeyProblem(),
      });
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
      const after = configFileManager.getConfigFiles(req.params.id).filter(f => f.enabled !== false).map(configFileManager.mountKey).sort().join('\n');
      let built: string[] | null = null;
      try { built = configFileManager.getBuiltMounts(req.params.id); } catch { /* unreadable: mounts unknown */ }
      broadcastToClients(wss, 'bot:updated', publicBot(containerManager.getBot(req.params.id)));
      // Start only rewrites the bodies of mounted files; a mount set unlike the last build's needs a build.
      const mountsUnknown = built === null;
      res.json({ success: true, needsUpdate: !mountsUnknown && [...built!].sort().join('\n') !== after, mountsUnknown });
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

  router.put('/:id/fs/write', fsWriteBody, async (req: Request, res: Response) => {
    try {
      const { target, path, body, eol } = req.body as { target?: string; path?: string; body?: string; eol?: string };
      if (typeof path !== 'string' || typeof body !== 'string') {
        res.status(400).json({ success: false, error: 'path and body are required' });
        return;
      }
      res.json(await terminal.fsWrite(req.params.id, target || 'host', path, body, { eol }));
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  router.post('/:id/fs/create', async (req: Request, res: Response) => {
    try {
      const { target, path } = req.body as { target?: string; path?: string };
      if (typeof path !== 'string') { res.status(400).json({ success: false, error: 'path is required' }); return; }
      res.json(await terminal.fsCreate(req.params.id, target || 'host', path));
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
      const { target, from, to, overwrite } = req.body as { target?: string; from?: string; to?: string; overwrite?: boolean };
      if (typeof from !== 'string' || typeof to !== 'string') { res.status(400).json({ success: false, error: 'from and to are required' }); return; }
      res.json(await terminal.fsRename(req.params.id, target || 'host', from, to, { overwrite: overwrite === true }));
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
      broadcastToClients(wss, 'bot:updated', publicBot(containerManager.getBot(botId)));
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
          broadcastToClients(wss, 'bot:rebuilt', { ...withActiveOp(publicBot(containerManager.getBot(botId))), ...(result.warning ? { warning: result.warning } : {}) });
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
      broadcastToClients(wss, 'bot:updated', publicBot(updated));
      const rebuildInProgress = isAutoRebuilding(req.params.id);
      res.json({
        success: true, autoUpdate: enabled, autoUpdateInterval: updated?.autoUpdateInterval, autoUpdateHour: updated?.autoUpdateHour,
        rebuildInProgress,
        ...(rebuildInProgress && !enabled ? { message: "Auto-update is off for future checks, but an automatic rebuild had already started and is still running; check the bot's log for its result." } : {}),
      });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  /**
   * PUT /api/bots/:id/fleet-backup-config - Update the sidecar backup schedule
   * on the INSTANCE. The body carries only the changed fields (enabled / hour /
   * keep) and, under `expected`, the stored value each one replaces; a field
   * changed since answers 409 with what is stored, and nothing is saved.
   */
  router.put('/:id/fleet-backup-config', async (req: Request, res: Response) => {
    try {
      const bot = containerManager.getBot(req.params.id);
      if (!bot) {
        res.status(404).json({ success: false, error: 'Bot not found' });
        return;
      }

      const body = (req.body || {}) as { enabled?: unknown; hour?: unknown; keep?: unknown; expected?: Record<string, unknown> };
      const changes: Partial<FleetBackupConfig> = {};
      if (body.enabled !== undefined) {
        if (typeof body.enabled !== 'boolean') { res.status(400).json({ success: false, error: 'enabled must be true or false. Nothing was saved.' }); return; }
        changes.enabled = body.enabled;
      }
      if (body.hour !== undefined) {
        if (typeof body.hour !== 'number' || !Number.isInteger(body.hour) || body.hour < 0 || body.hour > 23) {
          res.status(400).json({ success: false, error: 'hour must be a whole number from 0 to 23. Nothing was saved.' }); return;
        }
        changes.hour = body.hour;
      }
      if (body.keep !== undefined) {
        if (!fleetBackup.isValidFleetBackupKeep(body.keep)) {
          res.status(400).json({ success: false, error: 'keep must be a whole number from 1 to 365. Nothing was saved.' }); return;
        }
        changes.keep = body.keep;
      }
      const fields = Object.keys(changes) as Array<keyof FleetBackupConfig>;
      if (fields.length === 0) {
        res.status(400).json({ success: false, error: 'No backup setting was given. Nothing was saved.' });
        return;
      }
      const expected = body.expected && typeof body.expected === 'object' ? body.expected : null;
      if (!expected || fields.some(f => expected[f] === undefined)) {
        res.status(400).json({ success: false, error: 'expected must carry the stored value of each changed setting. Nothing was saved.' });
        return;
      }
      const prior: Partial<FleetBackupConfig> = {};
      for (const f of fields) (prior as Record<string, unknown>)[f] = expected[f];

      const result = containerManager.updateInstanceFleetBackup(req.params.id, changes, prior);
      if (!result.instance) {
        res.status(404).json({ success: false, error: 'Bot not found' });
        return;
      }
      if (result.conflict) {
        res.status(409).json({ success: false, error: 'The backup settings were changed elsewhere. Nothing was saved; the stored settings are shown.', fleetBackup: result.conflict });
        return;
      }
      broadcastToClients(wss, 'bot:updated', publicBot(result.instance));
      res.json({ success: true, fleetBackup: result.instance.fleetBackup });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  /** GET /api/bots/fleet/orphan-backups - Dump folders whose instance was removed. */
  router.get('/fleet/orphan-backups', (_req: Request, res: Response) => {
    try {
      const fault = containerManager.registryFault();
      if (fault) {
        res.status(503).json({ success: false, broken: true, error: fault });
        return;
      }
      const known = new Set(containerManager.getAllBots().map(b => b.id));
      res.json({ success: true, folders: fleetBackup.orphanedFleetBackups(known) });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  /**
   * GET /api/bots/:id/fleet-backups - List sidecar dump files, newest first.
   * Answers for a removed instance too while its folder holds dumps.
   */
  router.get('/:id/fleet-backups', async (req: Request, res: Response) => {
    try {
      const bot = containerManager.getBot(req.params.id);
      if (!bot) {
        const fault = containerManager.registryFault();
        if (fault) {
          res.status(503).json({ success: false, broken: true, error: fault });
          return;
        }
        const kept = /^[A-Za-z0-9_-]+$/.test(req.params.id) ? fleetBackup.listFleetBackups(req.params.id) : [];
        if (kept.length > 0) {
          res.json({ success: true, removed: true, backups: kept });
          return;
        }
        res.status(404).json({ success: false, error: 'Bot not found' });
        return;
      }
      res.json({ success: true, backups: fleetBackup.listFleetBackups(req.params.id) });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  /** DELETE /api/bots/:id/fleet-backups/restore-error - Dismiss a failed restore's notice. */
  router.delete('/:id/fleet-backups/restore-error', (req: Request, res: Response) => {
    if (!containerManager.getBot(req.params.id)) {
      res.status(404).json({ success: false, error: 'Bot not found' });
      return;
    }
    res.json({ success: true, dismissed: fleetBackup.dismissFleetRestoreError(req.params.id) });
  });

  /** GET /api/bots/:id/fleet-backups/restore-preview - The instances a restore would stop, for its confirm. */
  router.get('/:id/fleet-backups/restore-preview', async (req: Request, res: Response) => {
    try {
      if (!containerManager.getBot(req.params.id)) {
        res.status(404).json({ success: false, error: 'Bot not found' });
        return;
      }
      res.json(await fleetBackup.previewFleetRestore(req.params.id));
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
        ? {
          success: true,
          steps: result.steps,
          ...(result.warning ? { warning: result.warning } : {}),
          note: 'A restore brings back whatever the dump remembers: if it predates the removal of a fleet node, the shard table may hold frozen leases on that dead registration - check the fleet table and declare-lost any node that no longer exists',
        }
        : { success: false, error: result.error, steps: result.steps });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  /**
   * POST /api/bots/:id/fleet-db/decommission - Destroy the managed fleet
   * database (B4m-2c, dump-gated destroy). The only permit is a fresh
   * pre-decommission dump; the refusals are the manager's own records, never
   * app facts.
   */
  router.post('/:id/fleet-db/decommission', async (req: Request, res: Response) => {
    try {
      const bot = containerManager.getBot(req.params.id);
      if (!bot) {
        res.status(404).json({ success: false, error: 'Bot not found' });
        return;
      }
      res.json(await fleetReplica.decommissionFleetDb(bot.id));
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

  /** DELETE /api/bots/:id/fleet-replication/slots/:slot - drop one inactive fleet standby slot on this primary. */
  router.delete('/:id/fleet-replication/slots/:slot', async (req: Request, res: Response) => {
    try {
      const bot = containerManager.getBot(req.params.id);
      if (!bot) {
        res.status(404).json({ success: false, error: 'Bot not found' });
        return;
      }
      res.json(await fleetReplication.dropFleetSlot(bot, String(req.params.slot || '')));
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
      const { enabled, publicHost, hostPort, slotWalKeepMb } = req.body as { enabled?: boolean; publicHost?: string; hostPort?: number; slotWalKeepMb?: number };
      if (typeof enabled !== 'boolean') {
        res.status(400).json({ success: false, error: 'enabled (boolean) is required' });
        return;
      }
      let result: { success: boolean; error?: string };
      if (enabled) {
        if (!publicHost || typeof publicHost !== 'string') {
          res.status(400).json({ success: false, error: 'publicHost is required to enable replication' });
          return;
        }
        result = await fleetReplication.enableFleetReplication(bot, publicHost, hostPort, slotWalKeepMb, { dbPassword: await fleetReplica.fleetDbPasswordFallback(bot) });
      } else {
        result = await fleetReplication.disableFleetReplication(bot);
      }
      if (result.success) broadcastToClients(wss, 'bot:updated', publicBot(containerManager.getBot(req.params.id)));
      res.json(result);
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  /**
   * GET /api/bots/:id/fleet-replica - Standby status (record + provisioning
   * phase + live streaming probe).
   */
  router.get('/:id/fleet-replica', async (req: Request, res: Response) => {
    try {
      const bot = containerManager.getBot(req.params.id);
      if (!bot) {
        res.status(404).json({ success: false, error: 'Bot not found' });
        return;
      }
      res.json({ success: true, replica: await fleetReplica.getFleetReplicaStatus(bot), copyBackup: fleetBackup.copyBackupInfo(bot) });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  /**
   * POST /api/bots/:id/fleet-replica - Provision a standby from a primary's
   * copy block ({primaryDsn, cert, publicHost, hostPort?}). Async: poll the
   * GET for the phase.
   */
  router.post('/:id/fleet-replica', async (req: Request, res: Response) => {
    try {
      const bot = containerManager.getBot(req.params.id);
      if (!bot) {
        res.status(404).json({ success: false, error: 'Bot not found' });
        return;
      }
      const { primaryDsn, cert, publicHost, hostPort, confirm, confirmVolume } = req.body as { primaryDsn?: string; cert?: string; publicHost?: string; hostPort?: number; confirm?: boolean; confirmVolume?: string };
      if (!primaryDsn || !cert || !publicHost) {
        res.status(400).json({ success: false, error: 'primaryDsn, cert and publicHost are required' });
        return;
      }
      res.json(fleetReplica.provisionFleetReplica(bot, primaryDsn, cert, publicHost, hostPort, confirm === true, { confirmVolume: typeof confirmVolume === 'string' ? confirmVolume : undefined }));
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  /**
   * POST /api/bots/:id/fleet-adopt-primary - File a promoted standby as this
   * machine's fleet database and enable replication on it, so the machine that
   * just took over can hand out the copy block the old one re-seeds from.
   */
  router.post('/:id/fleet-adopt-primary', async (req: Request, res: Response) => {
    try {
      const bot = containerManager.getBot(req.params.id);
      if (!bot) {
        res.status(404).json({ success: false, error: 'Bot not found' });
        return;
      }
      const result = await fleetReplica.adoptPromotedReplica(bot);
      if (result.success) {
        broadcastToClients(wss, 'bot:updated', publicBot(containerManager.getBot(req.params.id)));
      }
      res.json(result);
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  /**
   * POST /api/bots/:id/fleet-reseed - Heal a stale primary by making it a
   * standby of the machine that now serves the fleet ({primaryDsn, cert,
   * publicHost, hostPort?}). Destructive: the local database is dumped once
   * and then deleted. Async: poll GET /fleet-replica for the phase.
   */
  router.post('/:id/fleet-reseed', async (req: Request, res: Response) => {
    try {
      const bot = containerManager.getBot(req.params.id);
      if (!bot) {
        res.status(404).json({ success: false, error: 'Bot not found' });
        return;
      }
      const { primaryDsn, cert, publicHost, hostPort, confirm, confirmVolume } = req.body as { primaryDsn?: string; cert?: string; publicHost?: string; hostPort?: number; confirm?: boolean; confirmVolume?: string };
      if (!primaryDsn || !cert || !publicHost) {
        res.status(400).json({ success: false, error: 'primaryDsn, cert and publicHost are required' });
        return;
      }
      res.json(fleetReplica.reseedStalePrimary(bot, primaryDsn, cert, publicHost, hostPort, confirm === true, { confirmVolume: typeof confirmVolume === 'string' ? confirmVolume : undefined }));
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  /**
   * DELETE /api/bots/:id/fleet-replica - Remove the standby service + record
   * (volume retained). The primary's slot is orphaned by this: the response
   * reminds the caller, and the UI confirm warns beforehand.
   */
  router.delete('/:id/fleet-replica', async (req: Request, res: Response) => {
    try {
      const bot = containerManager.getBot(req.params.id);
      if (!bot) {
        res.status(404).json({ success: false, error: 'Bot not found' });
        return;
      }
      const slot = bot.fleetDbReplica?.slot;
      const result = await fleetReplica.removeFleetReplica(bot, { confirmPromoted: (req.body as { confirmPromoted?: boolean } | undefined)?.confirmPromoted === true });
      if (result.success) {
        broadcastToClients(wss, 'bot:updated', publicBot(containerManager.getBot(req.params.id)));
        res.json({ success: true, warning: `The primary keeps replication slot ${slot}, which retains WAL until it is dropped there: its Database modal lists the slot with a Drop action once nothing streams on it` });
        return;
      }
      res.json(result);
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  /**
   * DELETE /api/bots/:id/fleet-replica/seed - Cancel the seed in flight
   * (preparing or seeding), or dismiss a parked one. Past the copy the answer
   * is to remove the standby afterwards. Body { startedAt, parked } names the
   * run the view showed; a needsConfirm answer carries the question and the
   * seed it was worded from, and the confirmed call adds { committed, confirm }.
   */
  router.delete('/:id/fleet-replica/seed', async (req: Request, res: Response) => {
    try {
      const bot = containerManager.getBot(req.params.id);
      if (!bot) {
        res.status(404).json({ success: false, error: 'Bot not found' });
        return;
      }
      const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
      const result = await fleetReplica.cancelReplicaSeed(bot, {
        startedAt: typeof body.startedAt === 'number' ? body.startedAt : undefined,
        parked: typeof body.parked === 'boolean' ? body.parked : undefined,
        committed: typeof body.committed === 'boolean' ? body.committed : undefined,
        confirm: body.confirm === true,
      });
      if (result.success) broadcastToClients(wss, 'bot:updated', publicBot(containerManager.getBot(req.params.id)));
      res.json(result);
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  /** POST /api/bots/:id/fleet-replica/finish-retire - remove the env pins a stale-primary re-seed could not. */
  router.post('/:id/fleet-replica/finish-retire', async (req: Request, res: Response) => {
    try {
      const bot = containerManager.getBot(req.params.id);
      if (!bot) {
        res.status(404).json({ success: false, error: 'Bot not found' });
        return;
      }
      const result = await fleetReplica.finishPinsRetire(bot);
      broadcastToClients(wss, 'bot:updated', publicBot(containerManager.getBot(req.params.id)));
      res.json(result);
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  /**
   * POST /api/bots/:id/fleet-replica/reseed - Re-seed this standby now from
   * the copy block the bot holds (the automatic re-seed's manual retry; resets
   * its attempt ledger). Async: poll GET /fleet-replica for the phase.
   */
  router.post('/:id/fleet-replica/reseed', async (req: Request, res: Response) => {
    try {
      const bot = containerManager.getBot(req.params.id);
      if (!bot) {
        res.status(404).json({ success: false, error: 'Bot not found' });
        return;
      }
      const result = await fleetReplica.reseedStandby(bot, 'operator');
      if (result.success) broadcastToClients(wss, 'bot:updated', publicBot(containerManager.getBot(req.params.id)));
      res.json(result);
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  /**
   * PUT /api/bots/:id/web-auth - Set the public URL auth mode on the INSTANCE.
   * Applies on the bot's next Update or Build, which author the proxy labels.
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
      broadcastToClients(wss, 'bot:updated', publicBot(updated));
      res.json({ success: true, bot: publicBot(updated) });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  return router;
}

/** The source an install would build from, as the .botmanager marker records it. */
function installSourceFor(sourceId: string | undefined, imageRef: string | undefined): InstallSource | undefined {
  if (imageRef) return { sourceUrl: null, sourceType: 'docker-image', imageRef };
  if (!sourceId) return undefined;
  const source = sourceManager.getSource(sourceId);
  if (!source) return undefined;
  if (source.sourceType === 'docker-image' && source.imageRef) {
    return { sourceUrl: null, sourceType: 'docker-image', imageRef: source.imageRef };
  }
  return { sourceUrl: source.url, sourceType: 'git' };
}

/**
 * Env values recoverable for a name: the newest deleted-bot vault group with
 * that sanitized name, then the CasaOS compose file left at
 * /DATA/AppData/casaos/apps/<sanitizedName>/docker-compose.yml. Vault entries
 * win over compose when the same key exists in both; the keys the manager
 * injects are left out.
 */
function recoverableEnvs(name: string, existingInstances: InstanceConfig[]): {
  envs: Array<{ key: string; value: string; sensitive: boolean; source: 'vault' | 'compose' }>;
  sources: { vault: number; compose: number };
  vaultBroken: boolean;
} {
  const targetSanitized = sanitizeName(name);
  const sensitivePatterns = ['TOKEN', 'SECRET', 'PASSWORD', 'API_KEY'];
  const isSensitive = (key: string) => sensitivePatterns.some(p => key.toUpperCase().includes(p));

  const fromVault: Record<string, string> = {};
  const vaultLoad = readVault();
  const matchingGroup = vaultLoad.config.deletedBots
    .filter(g => g.sanitizedName === targetSanitized)
    .sort((a, b) => b.deletedAt - a.deletedAt)[0];
  for (const entry of matchingGroup?.entries || []) {
    fromVault[entry.key] = entry.value;
  }

  const dataRoot = process.env.DATA_ROOT || '/DATA';
  const composePath = path.join(dataRoot, 'AppData', 'casaos', 'apps', targetSanitized, 'docker-compose.yml');
  const ownedByInstance = existingInstances.some(i => i.sanitizedName === targetSanitized);
  const fromCompose = ownedByInstance ? {} : readEnvsFromComposeFile(composePath) || {};

  const merged: Record<string, { value: string; source: 'vault' | 'compose' }> = {};
  for (const [k, v] of Object.entries(fromCompose)) {
    if (!BOT_MANAGER_KEYS.has(k)) merged[k] = { value: v, source: 'compose' };
  }
  for (const [k, v] of Object.entries(fromVault)) {
    merged[k] = { value: v, source: 'vault' };
  }

  const envs = Object.entries(merged).map(([key, { value, source }]) => ({ key, value, sensitive: isSensitive(key), source }));
  return {
    envs,
    sources: { vault: envs.filter(e => e.source === 'vault').length, compose: envs.filter(e => e.source === 'compose').length },
    vaultBroken: vaultLoad.state === 'broken',
  };
}

/**
 * The name an install under `name` will save: a reserved or already-used name is
 * auto-uniquified on install rather than rejected.
 */
async function resolveInstallTarget(name: string, req: Request) {
  const excludeId = req.query.excludeId as string;
  const existingInstances = containerManager.getAllBots();
  const source = installSourceFor(req.query.sourceId as string | undefined, req.query.imageRef as string | undefined);
  const foreignProjects = await containerManager.foreignDockerProjects(existingInstances.map(i => i.id));
  const uniqueName = makeUniqueName(name, existingInstances, excludeId, { foreignProjects, source });
  const conflicts = uniqueName !== name.trim() ? validateName(name, existingInstances, excludeId, { foreignProjects, source }).errors : [];
  return { uniqueName, conflicts, existingInstances, source };
}

/**
 * GET /api/validate-name - Validate a bot name
 * Query: ?name=...&excludeId=...&sourceId=... (or &imageRef=...)
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

      let target: Awaited<ReturnType<typeof resolveInstallTarget>>;
      try {
        target = await resolveInstallTarget(name, req);
      } catch (err) {
        res.json({ valid: false, errors: [err instanceof Error ? err.message : String(err)] });
        return;
      }
      const { uniqueName, conflicts, existingInstances, source } = target;
      const names = resolveNames(uniqueName);
      const reuse = checkFolderReuse(names.sanitizedName, existingInstances, source);
      const recoverable = recoverableEnvs(uniqueName, existingInstances);
      const envsAvailable: boolean | 'unknown' = recoverable.envs.length > 0 ? true : recoverable.vaultBroken ? 'unknown' : false;

      res.json({ valid: true, errors: [], ...names, ...reuse, envsAvailable, conflicts, adjusted: uniqueName !== name, requestedName: name });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  /**
   * GET /api/recover-envs?name=<displayName>&sourceId=... (or &imageRef=...)
   * Reads the envs for the name the install will save, the same name validate-name answers.
   * Returns recoverable plaintext env vars for a name, pulled from:
   *   1. newest deleted-bot vault group matching sanitizedName
   *   2. CasaOS compose file at /DATA/AppData/casaos/apps/<sanitizedName>/docker-compose.yml, unless an instance owns that name
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

      let target: Awaited<ReturnType<typeof resolveInstallTarget>>;
      try {
        target = await resolveInstallTarget(name, req);
      } catch (err) {
        res.json({ success: false, error: err instanceof Error ? err.message : String(err), envs: [] });
        return;
      }
      res.json({ success: true, name: target.uniqueName, ...recoverableEnvs(target.uniqueName, target.existingInstances) });
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
      try {
        setDeploymentMode(mode);
      } catch (error) {
        if (error instanceof DeploymentModeForcedError) {
          res.status(409).json({ success: false, error: error.message });
          return;
        }
        res.status(500).json({ success: false, error: `The deployment mode could not be saved, so it was not changed: ${(error as Error)?.message || error}` });
        return;
      }
      const info = await getDeploymentInfo();
      res.json({ success: true, ...info });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  return router;
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
