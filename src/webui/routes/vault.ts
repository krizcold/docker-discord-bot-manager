/**
 * Credentials Vault API Routes
 *
 * Provides a unified view of all env vars across bot instances + standalone vault entries.
 * Standalone entries stored in /data/data/vault.json.
 * Bot instance envs read from their existing encrypted storage.
 */

import { Router, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import * as containerManager from '../../docker/containerManager';
import * as envManager from '../../env/manager';

const DATA_DIR = process.env.DATA_DIR || '/data/data';
const VAULT_FILE = path.join(DATA_DIR, 'vault.json');

interface VaultEntry {
  key: string;
  value: string;
  hidden: boolean;  // true = value masked in UI, false = shown in plain
}

interface DeletedVaultEntry {
  key: string;
  value: string;
  botName: string;
  sanitizedName: string;
  deletedAt: number;
}

interface VaultConfig {
  standalone: VaultEntry[];
  deleted: DeletedVaultEntry[];
}

function loadVault(): VaultConfig {
  try {
    if (fs.existsSync(VAULT_FILE)) {
      const raw = JSON.parse(fs.readFileSync(VAULT_FILE, 'utf-8'));
      return {
        standalone: raw.standalone || [],
        deleted: raw.deleted || [],
      };
    }
  } catch { /* ignore */ }
  return { standalone: [], deleted: [] };
}

function saveVault(config: VaultConfig): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(VAULT_FILE, JSON.stringify(config, null, 2));
}

function maskValue(value: string): string {
  if (!value || value.length <= 8) return '****';
  return value.substring(0, 4) + '****' + value.substring(value.length - 4);
}

export function createVaultRoutes(): Router {
  const router = Router();

  /**
   * GET /api/vault - Get all vault entries (bot instances + standalone)
   * Values are masked for display.
   */
  router.get('/', (req: Request, res: Response) => {
    try {
      const instances = containerManager.getAllBots();
      const vault = loadVault();

      // Build groups: one per bot instance + standalone + deleted
      const groups: Array<{
        id: string;
        name: string;
        type: 'instance' | 'standalone' | 'deleted';
        entries: Array<{ key: string; value: string; masked: string; hidden?: boolean; botName?: string }>;
      }> = [];

      // Standalone group first
      groups.push({
        id: 'standalone',
        name: 'Standalone',
        type: 'standalone',
        entries: vault.standalone.map(e => ({
          key: e.key,
          value: e.hidden ? '' : e.value,
          masked: maskValue(e.value),
          hidden: e.hidden !== false  // default hidden
        }))
      });

      // Deleted group
      if (vault.deleted && vault.deleted.length > 0) {
        groups.push({
          id: 'deleted',
          name: 'Deleted / Recoverable',
          type: 'deleted',
          entries: vault.deleted.map(e => ({
            key: e.key,
            value: '',
            masked: maskValue(e.value),
            hidden: true,
            botName: e.botName
          }))
        });
      }

      // Bot instance groups
      for (const inst of instances) {
        try {
          const envVars = envManager.getEnvVars(inst.id);
          if (!envVars || Object.keys(envVars).length === 0) continue;

          // Detect which keys are sensitive
          const sensitivePatterns = ['TOKEN', 'SECRET', 'PASSWORD', 'API_KEY'];
          groups.push({
            id: inst.id,
            name: inst.displayName || inst.id,
            type: 'instance',
            entries: Object.entries(envVars).map(([key, value]) => {
              const isSensitive = sensitivePatterns.some(p => key.toUpperCase().includes(p));
              return {
                key,
                value: isSensitive ? '' : value,
                masked: maskValue(value),
                hidden: isSensitive
              };
            })
          });
        } catch { /* instance may not have env storage */ }
      }

      res.json({ success: true, groups });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  /**
   * GET /api/vault/all-values - Get all vault values (unmasked) for dropdown population
   * Returns flat array of { key, value, source } for install modal dropdowns.
   */
  router.get('/all-values', (req: Request, res: Response) => {
    try {
      const instances = containerManager.getAllBots();
      const vault = loadVault();

      const values: Array<{ key: string; value: string; source: string }> = [];

      // Standalone
      for (const e of vault.standalone) {
        values.push({ key: e.key, value: e.value, source: 'Standalone' });
      }

      // Deleted (preserved from uninstalled bots)
      for (const e of (vault.deleted || [])) {
        values.push({ key: e.key, value: e.value, source: `Deleted: ${e.botName}` });
      }

      // Bot instances
      for (const inst of instances) {
        try {
          const envVars = envManager.getEnvVars(inst.id);
          if (!envVars) continue;
          const name = inst.displayName || inst.id;
          for (const [key, value] of Object.entries(envVars)) {
            values.push({ key, value, source: name });
          }
        } catch { /* ignore */ }
      }

      res.json({ success: true, values });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  /**
   * POST /api/vault/standalone - Add a standalone vault entry
   */
  router.post('/standalone', (req: Request, res: Response) => {
    try {
      const { key, value, hidden } = req.body;
      if (!key) {
        res.status(400).json({ success: false, error: 'key is required' });
        return;
      }

      const vault = loadVault();
      const idx = vault.standalone.findIndex(e => e.key === key);
      if (idx >= 0) {
        vault.standalone[idx].value = value || '';
        if (hidden !== undefined) vault.standalone[idx].hidden = hidden;
      } else {
        vault.standalone.push({ key, value: value || '', hidden: hidden !== false });
      }
      saveVault(vault);

      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  /**
   * PUT /api/vault/standalone/:key - Update a standalone vault entry
   */
  router.put('/standalone/:key', (req: Request, res: Response) => {
    try {
      const { value, hidden, newKey } = req.body;
      const vault = loadVault();
      const entry = vault.standalone.find(e => e.key === req.params.key);
      if (!entry) {
        res.status(404).json({ success: false, error: 'Entry not found' });
        return;
      }
      if (value !== undefined) entry.value = value;
      if (hidden !== undefined) entry.hidden = hidden;
      if (newKey !== undefined && newKey !== entry.key) entry.key = newKey;
      saveVault(vault);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  /**
   * DELETE /api/vault/standalone/:key - Delete a standalone vault entry
   */
  router.delete('/standalone/:key', (req: Request, res: Response) => {
    try {
      const vault = loadVault();
      vault.standalone = vault.standalone.filter(e => e.key !== req.params.key);
      saveVault(vault);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  /**
   * DELETE /api/vault/deleted/:key - Delete a deleted vault entry by key+botName
   */
  router.delete('/deleted/:key', (req: Request, res: Response) => {
    try {
      const botName = req.query.botName as string;
      const vault = loadVault();
      vault.deleted = vault.deleted.filter(e => !(e.key === req.params.key && e.botName === botName));
      saveVault(vault);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  /**
   * PUT /api/vault/deleted/:key - Update a deleted vault entry (value or key rename)
   */
  router.put('/deleted/:key', (req: Request, res: Response) => {
    try {
      const botName = req.query.botName as string;
      const { value, newKey } = req.body;
      const vault = loadVault();
      const entry = vault.deleted.find(e => e.key === req.params.key && e.botName === botName);
      if (!entry) {
        res.status(404).json({ success: false, error: 'Entry not found' });
        return;
      }
      if (value !== undefined) entry.value = value;
      if (newKey !== undefined && newKey !== entry.key) entry.key = newKey;
      saveVault(vault);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  return router;
}
