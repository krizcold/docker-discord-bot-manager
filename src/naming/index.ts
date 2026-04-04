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
 * Check if /DATA/AppData/{sanitized} exists and is NOT managed by Bot Manager.
 * Uses the .botmanager marker file inside the AppData folder itself —
 * survives even if Bot Manager is fully wiped and reinstalled.
 */
export function isAppDataOccupied(sanitized: string, existingInstances: InstanceConfig[]): boolean {
  const dataRoot = process.env.DATA_ROOT || '/DATA';
  const appDataPath = path.join(dataRoot, 'AppData', sanitized);

  if (!fs.existsSync(appDataPath)) return false;

  // If any existing instance owns this sanitized name, it's tracked (not occupied)
  const tracked = existingInstances.some(
    inst => inst.sanitizedName === sanitized || inst.appName === sanitized
  );
  if (tracked) return false;

  // Check for .botmanager marker — if present, this is a Bot Manager folder (allow reuse)
  const markerPath = path.join(appDataPath, '.botmanager');
  if (fs.existsSync(markerPath)) return false;

  // Genuinely unknown/external folder — block
  return true;
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
 * Reads the .botmanager marker inside the AppData folder for metadata.
 */
export function checkFolderReuse(sanitizedName: string, existingInstances: InstanceConfig[]): {
  reuseAvailable: boolean;
  previousInstanceId: string | null;
  marker: any | null;
} {
  const dataRoot = process.env.DATA_ROOT || '/DATA';
  const appDataPath = path.join(dataRoot, 'AppData', sanitizedName);

  if (!fs.existsSync(appDataPath)) {
    return { reuseAvailable: false, previousInstanceId: null, marker: null };
  }

  // If a current instance owns this name, it's not "reusable" — it's in active use
  const activeOwner = existingInstances.find(
    i => i.sanitizedName === sanitizedName || i.appName === sanitizedName
  );
  if (activeOwner) {
    return { reuseAvailable: false, previousInstanceId: null, marker: null };
  }

  // Check for .botmanager marker
  const markerPath = path.join(appDataPath, '.botmanager');
  if (fs.existsSync(markerPath)) {
    try {
      const marker = JSON.parse(fs.readFileSync(markerPath, 'utf-8'));
      return {
        reuseAvailable: true,
        previousInstanceId: marker.instanceId || null,
        marker
      };
    } catch {
      // Marker exists but unreadable — still ours, allow reuse
      return { reuseAvailable: true, previousInstanceId: null, marker: null };
    }
  }

  // Fallback: scan Bot Manager's internal bots directory for orphaned env data
  const botsDir = path.join(process.env.DATA_DIR || '/data/data', 'bots');
  if (fs.existsSync(botsDir)) {
    try {
      const entries = fs.readdirSync(botsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const envStoragePath = path.join(botsDir, entry.name, 'env', 'storage.json');
        if (fs.existsSync(envStoragePath)) {
          const isActive = existingInstances.some(i => i.id === entry.name);
          if (!isActive) {
            return { reuseAvailable: true, previousInstanceId: entry.name, marker: null };
          }
        }
      }
    } catch { /* ignore */ }
  }

  // AppData exists but no marker and no internal data — still offer reuse
  return { reuseAvailable: true, previousInstanceId: null, marker: null };
}
