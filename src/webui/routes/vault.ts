/**
 * Credentials Vault API Routes
 *
 * Provides a unified view of all env vars across bot instances + standalone vault entries.
 * Standalone entries and deleted-bot credential groups stored encrypted at rest in /data/data/vault.json as
 * { v: 1, data: "v2:<iv>:<authTag>:<ciphertext>" } using the env manager's AES-256-GCM helpers.
 * Bot instance envs read from their existing encrypted storage.
 */

import { Router, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import * as containerManager from '../../docker/containerManager';
import * as envManager from '../../env/manager';
import { storeFileState, preserveCorruptCopy, listCorruptCopies, corruptCopyNote, writeFileAtomic } from '../../config/storeFile';

const DATA_DIR = process.env.DATA_DIR || '/data/data';
const VAULT_FILE = path.join(DATA_DIR, 'vault.json');

export interface VaultEntry {
  key: string;
  value: string;
  hidden: boolean;  // true = value masked in UI, false = shown in plain
}

export interface DeletedBotGroup {
  id: string;
  botName: string;
  sanitizedName: string;
  deletedAt: number;
  entries: Array<{ key: string; value: string }>;
}

export interface VaultConfig {
  standalone: VaultEntry[];
  deletedBots: DeletedBotGroup[];
}

let warnedUnreadableVault = false;

// Configs handed out by a load that could not read vault.json: they look
// empty, so a save built on one would destroy every vaulted group, even when
// the file reads again by save time.
const brokenVaultLoads = new WeakSet<VaultConfig>();

type VaultLoad = { state: 'absent' | 'ok'; config: VaultConfig } | { state: 'broken'; config: VaultConfig; error: string };

/**
 * Read vault.json. Only a definitely missing file is an empty vault; a file
 * that cannot be checked, read or decrypted is broken (a timestamped copy is
 * kept beside it) and loads as an empty vault no save may build on.
 */
export function readVault(): VaultLoad {
  const state = storeFileState(VAULT_FILE);
  if (state.kind === 'absent') return { state: 'absent', config: { standalone: [], deletedBots: [] } };
  try {
    if (state.kind === 'broken') throw new Error(state.error);
    const wrapper = JSON.parse(fs.readFileSync(VAULT_FILE, 'utf-8'));
    if (!wrapper || typeof wrapper.data !== 'string') throw new Error('unrecognized vault format');
    const plain = envManager.decryptOrNull(wrapper.data);
    if (plain === null) throw new Error('vault.json cannot be decrypted');
    const raw = JSON.parse(plain);
    warnedUnreadableVault = false;
    return { state: 'ok', config: { standalone: raw.standalone || [], deletedBots: raw.deletedBots || [] } };
  } catch (error: any) {
    if (!warnedUnreadableVault) {
      warnedUnreadableVault = true;
      console.warn(`[Vault] vault.json is unreadable or cannot be decrypted (${error?.message || error}); it reads as empty and saves are refused`);
    }
    preserveCorruptCopy(VAULT_FILE);
    const config: VaultConfig = { standalone: [], deletedBots: [] };
    brokenVaultLoads.add(config);
    return { state: 'broken', config, error: String(error?.message || error) };
  }
}

export function loadVault(): VaultConfig {
  return readVault().config;
}

/**
 * True when vault.json cannot be read, checked or decrypted. Lanes that write
 * on behalf of a preservation promise probe this first and refuse instead.
 */
export function vaultFileBroken(): boolean {
  return readVault().state === 'broken';
}

/** The incident copies of vault.json kept beside it, oldest first. */
export function vaultCorruptCopies(): string[] {
  return listCorruptCopies(VAULT_FILE);
}

export function saveVault(config: VaultConfig): void {
  // Guarded here so every caller (vault routes, delete lane, rollbacks) is
  // covered: a config loaded from a broken vault, or a vault broken now.
  if (brokenVaultLoads.has(config) || vaultFileBroken()) {
    throw new Error(`vault.json could not be read, so nothing was saved: the save would destroy every previously vaulted group. Repair or remove vault.json first (${corruptCopyNote(VAULT_FILE)}).`);
  }
  const wrapper = { v: 1, data: envManager.encrypt(JSON.stringify(config)) };
  // Atomic: this file is the only home of the vaulted groups, so a kill
  // mid-save must not leave it truncated.
  writeFileAtomic(VAULT_FILE, JSON.stringify(wrapper, null, 2));
}

function maskValue(value: string): string {
  if (!value || value.length <= 8) return '****';
  return value.substring(0, 4) + '****' + value.substring(value.length - 4);
}

function renameRefused(entries: Array<{ key: string }>, from: string, newKey: unknown, res: Response): boolean {
  if (newKey === undefined || newKey === from) return false;
  if (typeof newKey !== 'string' || !newKey.trim()) {
    res.status(400).json({ success: false, error: 'The new key cannot be blank. Nothing was saved.' });
    return true;
  }
  if (entries.some(e => e.key === newKey)) {
    res.status(409).json({ success: false, error: `An entry named ${newKey} already exists in this group. Nothing was saved.` });
    return true;
  }
  return false;
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
      const loaded = readVault();
      const vault = loaded.config;

      // Build groups: one per bot instance + standalone + one per deleted bot
      const groups: Array<{
        id: string;
        name: string;
        type: 'instance' | 'standalone' | 'deleted';
        deletedAt?: number;
        entries: Array<{ key: string; value: string; masked: string; hidden?: boolean }>;
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

      // Deleted bot groups, newest first
      const deletedGroups = [...vault.deletedBots].sort((a, b) => b.deletedAt - a.deletedAt);
      for (const g of deletedGroups) {
        groups.push({
          id: g.id,
          name: `[Deleted] ${g.botName}`,
          type: 'deleted',
          deletedAt: g.deletedAt,
          entries: g.entries.map(e => ({
            key: e.key,
            value: '',
            masked: maskValue(e.value),
            hidden: true
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

      res.json({
        success: true,
        groups,
        vaultBroken: loaded.state === 'broken',
        vaultError: loaded.state === 'broken' ? loaded.error : undefined,
        corruptCopies: vaultCorruptCopies(),
        secretKeyProblem: envManager.secretKeyProblem(),
      });
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
      for (const g of vault.deletedBots) {
        for (const e of g.entries) {
          values.push({ key: e.key, value: e.value, source: `Deleted: ${g.botName}` });
        }
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
      if (vault.standalone.some(e => e.key === key)) {
        res.status(409).json({ success: false, error: `A vault entry named ${key} already exists; edit that entry instead. Nothing was saved.` });
        return;
      }
      vault.standalone.push({ key, value: value || '', hidden: hidden !== false });
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
      if (renameRefused(vault.standalone, entry.key, newKey, res)) return;
      if (value !== undefined) entry.value = value;
      if (hidden !== undefined) entry.hidden = hidden;
      if (newKey !== undefined) entry.key = newKey;
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
   * DELETE /api/vault/deleted/:key - Delete an entry from a deleted-bot group by key+groupId
   */
  router.delete('/deleted/:key', (req: Request, res: Response) => {
    try {
      const groupId = req.query.groupId as string;
      const vault = loadVault();
      const group = vault.deletedBots.find(g => g.id === groupId);
      if (!group) {
        res.status(404).json({ success: false, error: 'Group not found' });
        return;
      }
      group.entries = group.entries.filter(e => e.key !== req.params.key);
      if (group.entries.length === 0) {
        vault.deletedBots = vault.deletedBots.filter(g => g.id !== groupId);
      }
      saveVault(vault);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  /**
   * PUT /api/vault/deleted/:key - Update an entry in a deleted-bot group (value or key rename)
   */
  router.put('/deleted/:key', (req: Request, res: Response) => {
    try {
      const groupId = req.query.groupId as string;
      const { value, newKey } = req.body;
      const vault = loadVault();
      const group = vault.deletedBots.find(g => g.id === groupId);
      const entry = group?.entries.find(e => e.key === req.params.key);
      if (!entry) {
        res.status(404).json({ success: false, error: 'Entry not found' });
        return;
      }
      if (renameRefused(group!.entries, entry.key, newKey, res)) return;
      if (value !== undefined) entry.value = value;
      if (newKey !== undefined) entry.key = newKey;
      saveVault(vault);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  /**
   * DELETE /api/vault/deleted-group/:id - Remove an entire deleted-bot group
   */
  router.delete('/deleted-group/:id', (req: Request, res: Response) => {
    try {
      const vault = loadVault();
      const before = vault.deletedBots.length;
      vault.deletedBots = vault.deletedBots.filter(g => g.id !== req.params.id);
      if (vault.deletedBots.length === before) {
        res.status(404).json({ success: false, error: 'Group not found' });
        return;
      }
      saveVault(vault);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  return router;
}
