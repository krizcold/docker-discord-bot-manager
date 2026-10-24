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
import { buildWizardEnvList } from '../../env/envList';
import { getDeploymentMode } from '../../casaos/detector';
import { frontingGatewayDropped } from '../../templates/pcsProcessing';
import { applyTemplateModifiers } from '../../config/templateModifiers';
import { findManifest, sanitizeSeedRows, manifestHasInFileToken } from '../../config/installManifests';
import { parseConfig } from '../../config/configSerializer';
import { envVarsFromImageConfig, DetectedEnvVar } from '../../env/manager';
import { findImageEnvHints } from '../../source/imageHints';
import * as dockerClient from '../../docker/dockerClient';
import { CreateSourceRequest, UpdateSourceRequest } from '../../types';

export function createSourceRoutes(wss: WebSocketServer): Router {
  const router = Router();

  /**
   * GET /api/sources - List all sources
   */
  router.get('/', async (req: Request, res: Response) => {
    try {
      const registryFault = sourceManager.sourceRegistryFault();
      if (registryFault) {
        res.status(503).json({ success: false, broken: true, error: registryFault });
        return;
      }
      const sources = sourceManager.getAllSources().map(s => ({ ...s, isCloned: sourceManager.isSourceCloned(s) }));
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
      if (sourceManager.isSourceCloning(request.url)) {
        res.status(409).json({ success: false, error: 'A source with this URL is being cloned' });
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

      // A url/branch change wiped the clone (lastChecked set, commit info nulled);
      // re-clone in the background and push the refreshed source to the UI when done.
      if (source.sourceType !== 'docker-image' && source.lastChecked && !source.lastCommitHash) {
        sourceManager.fetchSource(source.id)
          .then(() => broadcastToClients(wss, 'source:updated', sourceManager.getSource(source.id)))
          .catch(err => {
            console.error(`[API] Re-clone after source edit failed for ${source.id}:`, err);
            broadcastToClients(wss, 'source:fetch-failed', { id: source.id, error: String(err) });
          });
      }
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

      // Prebuilt-image source: cannot scan a repo. Surface curated hints for known
      // images, plus any env vars the image itself declares (Config.Env). Inspecting
      // needs the image locally, so it auto-runs when the image is already pulled and
      // otherwise pulls on demand only when explicitly requested (?inspect=true),
      // since images can be large.
      if (source.sourceType === 'docker-image') {
        const imageRef = source.imageRef || '';
        const curated = findImageEnvHints(imageRef);
        let imageReady = !!imageRef && await dockerClient.imageExists(imageRef);
        let pullError: string | undefined;
        let inspectError: string | undefined;
        if (imageRef && !imageReady && req.query.inspect === 'true') {
          try {
            await dockerClient.pullImage(imageRef);
            imageReady = await dockerClient.imageExists(imageRef);
            if (!imageReady) pullError = 'the pull finished but the image is still not present';
          } catch (err: any) {
            pullError = String(err?.message || err);
          }
        }
        let inspected: DetectedEnvVar[] = [];
        if (imageReady) {
          const env = dockerClient.inspectImageEnv(imageRef);
          if (env) inspected = envVarsFromImageConfig(env);
          else inspectError = 'the image environment could not be read';
        }
        const seen = new Set(curated.map(v => v.key.toUpperCase()));
        const vars = [...curated];
        for (const v of inspected) {
          const k = v.key.toUpperCase();
          if (!seen.has(k)) { seen.add(k); vars.push(v); }
        }
        res.json({ success: true, vars, configFiles: [], interactiveSetup: null, isImage: true, imageReady, ...(pullError ? { pullError } : {}), ...(inspectError ? { inspectError } : {}) });
        return;
      }

      const repoPath = sourceManager.getSourceRepoPath(req.params.id);
      if (!sourceManager.isSourceCloned(source)) {
        const why = source.cloneError ? `: the last clone failed (${source.cloneError})` : '';
        res.status(409).json({ success: false, notCloned: true, error: `The source repository is not cloned${why}. Fetch or Install the source first.` });
        return;
      }

      const scanSource = req.query.scan === 'true';
      const hasEnvExample = fs.existsSync(path.join(repoPath, '.env.example'));
      // A new bot starts with the default Auth mode.
      const gateway = { dropped: frontingGatewayDropped(await getDeploymentMode(), undefined), publicUrl: !!process.env.BOT_DOMAIN_BASE, domainBase: !!process.env.BOT_DOMAIN_BASE };
      const { vars, detection, sourceScan } = buildWizardEnvList(repoPath, { scanSource, sourceUrl: source.url, gateway });

      // Apply any per-source template modifier to the prefilled config defaults
      // (data-driven; the user can still tweak/revert in the wizard). When a
      // source has a guided install manifest for this file, attach it plus the
      // parsed body so the wizard can render the guided form.
      const configFiles = (detection.configFiles || []).map(cf => {
        let rawBody = applyTemplateModifiers(source.url, cf.targetName, cf.format, cf.rawBody);
        const manifest = findManifest(source.url, cf.targetName) || null;
        let parsed: unknown = null;
        if (manifest) {
          rawBody = sanitizeSeedRows(manifest, rawBody);   // drop placeholder seed rows so the bot boots
          const r = parseConfig(manifest.format, rawBody);
          if (r.ok) parsed = r.data ?? {};
        }
        return { ...cf, rawBody, manifest, parsed };
      });

      // When the token is configured via a guided in-file field, the bot's env
      // TOKEN (if any) is optional (only used with tokenFromENV); don't show it as
      // a required field competing with the guided token.
      const TOKEN_RE = /^(DISCORD_)?(BOT_|CLIENT_)?TOKEN$/i;
      const inFileToken = configFiles.some(cf => cf.manifest && manifestHasInFileToken(cf.manifest));
      const outVars = inFileToken ? vars.map(v => (TOKEN_RE.test(v.key) ? { ...v, required: false } : v)) : vars;

      res.json({
        success: true,
        vars: outVars,
        configFiles,
        interactiveSetup: detection.interactiveSetup || null,
        tier2Ran: scanSource || !hasEnvExample,
        hasEnvExample,
        sourceScan: sourceScan || null,
      });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  return router;
}
