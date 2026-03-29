/**
 * Name Resolution, Validation, and Collision Detection
 *
 * Three name layers:
 *   Display name:   "My Custom Bot!"  — user's raw input, shown in UI
 *   Sanitized name: "mycustombot"     — compose name, folders, Caddy labels, CasaOS app name
 *   Title name:     "My Custom Bot"   — x-casaos.title.en_us (uppercase + spaces, no special chars)
 */

import * as fs from 'fs';
import * as path from 'path';
import { InstanceConfig, ResolvedNames, RESERVED_NAMES } from '../types';

/**
 * Derive sanitized name from display name.
 * Lowercase, strip non-alphanumeric, collapse.
 * "My Custom Bot!" -> "mycustombot"
 */
export function sanitizeName(displayName: string): string {
  return displayName
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .replace(/^$/, 'unnamed');
}

/**
 * Derive title name from display name.
 * Strip special chars but keep letters, digits, and spaces. Collapse whitespace. Trim.
 * "My Custom Bot!" -> "My Custom Bot"
 */
export function titleizeName(displayName: string): string {
  return displayName
    .replace(/[^a-zA-Z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim() || 'Unnamed';
}

/**
 * Resolve all three name layers from a display name.
 */
export function resolveNames(displayName: string): ResolvedNames {
  return {
    displayName,
    sanitizedName: sanitizeName(displayName),
    titleName: titleizeName(displayName),
  };
}

/**
 * Check if a sanitized name is in the hard-block reserved list.
 */
export function isReservedName(sanitized: string): boolean {
  return RESERVED_NAMES.includes(sanitized);
}

/**
 * Check if /DATA/AppData/{sanitized} exists and is NOT tracked by any current instance.
 */
export function isAppDataOccupied(sanitized: string, existingInstances: InstanceConfig[]): boolean {
  const dataRoot = process.env.DATA_ROOT || '/DATA';
  const appDataPath = path.join(dataRoot, 'AppData', sanitized);

  if (!fs.existsSync(appDataPath)) return false;

  // If any existing instance owns this sanitized name, it's tracked (not "occupied by an unknown")
  const tracked = existingInstances.some(
    inst => inst.sanitizedName === sanitized || inst.appName === sanitized
  );
  return !tracked;
}

/**
 * Validate a display name against all constraints.
 * Returns { valid, errors[] }.
 */
export function validateName(
  displayName: string,
  existingInstances: InstanceConfig[],
  excludeInstanceId?: string,
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!displayName || !displayName.trim()) {
    errors.push('Name cannot be empty');
    return { valid: false, errors };
  }

  const { sanitizedName, titleName } = resolveNames(displayName);

  if (!sanitizedName || sanitizedName === 'unnamed') {
    errors.push('Name must contain at least one letter or digit');
    return { valid: false, errors };
  }

  // Reserved name check
  if (isReservedName(sanitizedName)) {
    errors.push(`"${sanitizedName}" is a reserved system name`);
  }

  // Collision check on all three layers
  const others = existingInstances.filter(i => i.id !== excludeInstanceId);

  if (others.some(i => i.sanitizedName === sanitizedName)) {
    errors.push(`Sanitized name "${sanitizedName}" is already in use`);
  }
  if (others.some(i => i.displayName === displayName)) {
    errors.push(`Display name "${displayName}" is already in use`);
  }
  if (others.some(i => i.titleName === titleName)) {
    errors.push(`Title name "${titleName}" is already in use`);
  }

  // AppData occupation check
  if (isAppDataOccupied(sanitizedName, existingInstances)) {
    errors.push(`/DATA/AppData/${sanitizedName}/ exists and is not managed by Bot Manager`);
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Check if a sanitized name has reusable data from a previous bot manager instance.
 * Returns the previous instance ID if found, or null.
 *
 * Condition: /DATA/AppData/{sanitized} exists AND is tracked by a bot manager instance
 * that no longer exists in the current registry (deleted but data preserved).
 */
export function checkFolderReuse(sanitizedName: string, existingInstances: InstanceConfig[]): {
  reuseAvailable: boolean;
  previousInstanceId: string | null;
} {
  const dataRoot = process.env.DATA_ROOT || '/DATA';
  const appDataPath = path.join(dataRoot, 'AppData', sanitizedName);

  if (!fs.existsSync(appDataPath)) {
    return { reuseAvailable: false, previousInstanceId: null };
  }

  // If a current instance owns this name, it's not "reusable" — it's in active use
  const activeOwner = existingInstances.find(
    i => i.sanitizedName === sanitizedName || i.appName === sanitizedName
  );
  if (activeOwner) {
    return { reuseAvailable: false, previousInstanceId: null };
  }

  // Check if any bot manager instance directory has env data for this sanitized name
  // by scanning /data/data/bots/*/env/storage.json
  const botsDir = path.join(process.env.DATA_DIR || '/data/data', 'bots');
  if (!fs.existsSync(botsDir)) {
    return { reuseAvailable: false, previousInstanceId: null };
  }

  try {
    const entries = fs.readdirSync(botsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const envStoragePath = path.join(botsDir, entry.name, 'env', 'storage.json');
      if (fs.existsSync(envStoragePath)) {
        // This bot directory has credentials — check if it maps to our sanitized name
        // by seeing if this instance id is NOT in the current registry
        const isActive = existingInstances.some(i => i.id === entry.name);
        if (!isActive) {
          return { reuseAvailable: true, previousInstanceId: entry.name };
        }
      }
    }
  } catch { /* ignore */ }

  // AppData exists but no previous credentials found — still offer reuse of data directory
  return { reuseAvailable: true, previousInstanceId: null };
}
