/**
 * Name Resolution, Validation, and Collision Detection
 *
 * Three name layers:
 *   Display name:   "My Custom Bot!"  - user's raw input, shown in UI
 *   Sanitized name: "mycustombot"     - compose name, folders, Caddy labels, CasaOS app name
 *   Title name:     "My Custom Bot"   - x-casaos.title.en_us (uppercase + spaces, no special chars)
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

/** What an instance is built from, as the .botmanager marker records it. */
export interface InstallSource {
  sourceUrl: string | null;
  sourceType: string;
  imageRef?: string | null;
}

/** Facts a name check needs from outside the registry. */
export interface NameChecks {
  /** Compose projects on the docker host holding containers of no registered bot, with those containers' names. */
  foreignProjects?: Map<string, string[]>;
  /** The install's source: a data folder kept from another source then refuses the name. */
  source?: InstallSource;
}

export function sameSource(marker: Partial<InstallSource> | null | undefined, source: InstallSource): boolean {
  return (marker?.sourceType || 'git') === (source.sourceType || 'git')
    && (marker?.sourceUrl || null) === (source.sourceUrl || null)
    && (marker?.imageRef || null) === (source.imageRef || null);
}

export function describeSource(source: Partial<InstallSource> | null | undefined): string {
  if (source?.sourceType === 'docker-image') return `image ${source.imageRef || '(not recorded)'}`;
  return source?.sourceUrl || '(source not recorded)';
}

function appDataDisplayPath(sanitized: string): string {
  return `${(process.env.DATA_ROOT || '/DATA').replace(/\\/g, '/').replace(/\/+$/, '')}/AppData/${sanitized}/`;
}

/**
 * Check if /DATA/AppData/{sanitized} exists and is NOT managed by Bot Manager.
 * Uses the .botmanager marker file inside the AppData folder itself,
 * which survives even if Bot Manager is fully wiped and reinstalled.
 */
export function isAppDataOccupied(sanitized: string, existingInstances: InstanceConfig[]): boolean {
  const dataRoot = process.env.DATA_ROOT || '/DATA';
  const appDataPath = path.join(dataRoot, 'AppData', sanitized);

  if (!fs.existsSync(appDataPath)) return false;

  // If any existing instance owns this sanitized name, it's tracked (not occupied)
  const tracked = existingInstances.some(inst => inst.sanitizedName === sanitized);
  if (tracked) return false;

  // Check for .botmanager marker: if present, this is a Bot Manager folder (allow reuse)
  const markerPath = path.join(appDataPath, '.botmanager');
  if (fs.existsSync(markerPath)) return false;

  // Genuinely unknown/external folder: block
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
  checks: NameChecks = {},
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

  const foreign = checks.foreignProjects?.get(sanitizedName);
  if (foreign) {
    errors.push(`a docker project named "${sanitizedName}" already exists on this host (containers: ${foreign.join(', ')}); pick another name`);
  }

  if (checks.source) {
    const reuse = checkFolderReuse(sanitizedName, existingInstances, checks.source);
    if (reuse.markerUnreadable) {
      errors.push(`${appDataDisplayPath(sanitizedName)}.botmanager cannot be read, so whose data that folder holds cannot be checked`);
    } else if (reuse.sourceMatches === false) {
      errors.push(`${appDataDisplayPath(sanitizedName)} holds data kept from ${reuse.keptSource}; this install is from ${describeSource(checks.source)}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Return a display name guaranteed to pass validateName, appending an
 * incrementing numeric suffix ("Bot" -> "Bot 2" -> "Bot 3") when the requested
 * name is reserved, already in use on any layer, or maps to an occupied AppData
 * folder. Empty / alphanumeric-less names are unfixable and throw.
 */
export function makeUniqueName(
  displayName: string,
  existingInstances: InstanceConfig[],
  excludeInstanceId?: string,
  checks: NameChecks = {},
): string {
  const base = (displayName || '').trim();
  if (!base) {
    throw new Error('Name cannot be empty');
  }
  const baseSanitized = sanitizeName(base);
  if (!baseSanitized || baseSanitized === 'unnamed') {
    throw new Error('Name must contain at least one letter or digit');
  }

  let candidate = base;
  for (let suffix = 2; suffix < 1000; suffix++) {
    if (validateName(candidate, existingInstances, excludeInstanceId, checks).valid) {
      return candidate;
    }
    candidate = `${base} ${suffix}`;
  }
  throw new Error(`Could not derive a unique name from "${base}"`);
}

/**
 * Check if a sanitized name has reusable data from a previous bot manager instance.
 * Returns reuseAvailable=true when an AppData folder exists at that name and no
 * active instance currently owns it. The .botmanager marker is returned when present,
 * with the source it records and, given the install's source, whether the two match.
 */
export function checkFolderReuse(sanitizedName: string, existingInstances: InstanceConfig[], source?: InstallSource): {
  reuseAvailable: boolean;
  marker: any | null;
  markerUnreadable: boolean;
  keptSource: string | null;
  sourceMatches: boolean | null;
} {
  const none = { reuseAvailable: false, marker: null, markerUnreadable: false, keptSource: null, sourceMatches: null };
  const dataRoot = process.env.DATA_ROOT || '/DATA';
  const appDataPath = path.join(dataRoot, 'AppData', sanitizedName);

  if (!fs.existsSync(appDataPath)) return none;
  if (existingInstances.some(i => i.sanitizedName === sanitizedName)) return none;

  const markerPath = path.join(appDataPath, '.botmanager');
  if (!fs.existsSync(markerPath)) {
    return { reuseAvailable: true, marker: null, markerUnreadable: false, keptSource: null, sourceMatches: null };
  }
  let marker: any;
  try {
    marker = JSON.parse(fs.readFileSync(markerPath, 'utf-8'));
  } catch {
    marker = null;
  }
  if (!marker || typeof marker !== 'object') {
    return { reuseAvailable: true, marker: null, markerUnreadable: true, keptSource: null, sourceMatches: null };
  }
  return {
    reuseAvailable: true,
    marker,
    markerUnreadable: false,
    keptSource: describeSource(marker),
    sourceMatches: source ? sameSource(marker, source) : null,
  };
}
