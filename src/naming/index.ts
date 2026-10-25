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
import { storeFileState } from '../config/storeFile';

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

type KeptFolder =
  | { kind: 'none' }
  | { kind: 'unchecked'; error: string }
  | { kind: 'unmarked' }
  | { kind: 'unreadable'; error: string }
  | { kind: 'marked'; marker: any };

/**
 * What /DATA/AppData/{sanitized} holds for a name no instance owns. The
 * .botmanager marker inside it survives a full Bot Manager wipe; a marker
 * that cannot be read or names no instance is reported, never taken as a
 * Bot Manager folder.
 */
function keptFolder(sanitized: string, existingInstances: InstanceConfig[]): KeptFolder {
  if (existingInstances.some(inst => inst.sanitizedName === sanitized)) return { kind: 'none' };
  const appDataPath = path.join(process.env.DATA_ROOT || '/DATA', 'AppData', sanitized);
  try {
    fs.lstatSync(appDataPath);
  } catch (error: any) {
    if (error?.code === 'ENOENT') return { kind: 'none' };
    return { kind: 'unchecked', error: error?.code || error?.message || String(error) };
  }

  const markerPath = path.join(appDataPath, '.botmanager');
  const state = storeFileState(markerPath);
  if (state.kind === 'absent') return { kind: 'unmarked' };
  if (state.kind === 'broken') return { kind: 'unreadable', error: state.error };
  let text: string;
  try {
    text = fs.readFileSync(markerPath, 'utf-8');
  } catch (error: any) {
    return { kind: 'unreadable', error: `.botmanager cannot be read (${error?.code || error?.message || error})` };
  }
  let marker: any;
  try {
    marker = JSON.parse(text);
  } catch (error: any) {
    return { kind: 'unreadable', error: `.botmanager cannot be parsed (${error?.message || error})` };
  }
  if (!marker || typeof marker !== 'object' || Array.isArray(marker) || typeof marker.instanceId !== 'string' || !marker.instanceId) {
    return { kind: 'unreadable', error: '.botmanager names no instance' };
  }
  return { kind: 'marked', marker };
}

/**
 * Check if /DATA/AppData/{sanitized} exists and is NOT a readable Bot Manager
 * folder: no marker, a marker that cannot be read, or a folder that cannot be checked.
 */
export function isAppDataOccupied(sanitized: string, existingInstances: InstanceConfig[]): boolean {
  const kept = keptFolder(sanitized, existingInstances);
  return kept.kind !== 'none' && kept.kind !== 'marked';
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

  const kept = keptFolder(sanitizedName, existingInstances);
  if (kept.kind === 'unchecked') {
    errors.push(`${appDataDisplayPath(sanitizedName)} cannot be checked (${kept.error}), so whether it holds another bot's data is unknown`);
  } else if (kept.kind === 'unreadable') {
    errors.push(`${appDataDisplayPath(sanitizedName)}: ${kept.error}, so whose data the folder holds is unknown`);
  } else if (kept.kind === 'unmarked') {
    errors.push(`/DATA/AppData/${sanitizedName}/ exists and is not managed by Bot Manager`);
  } else if (kept.kind === 'marked' && checks.source && !sameSource(kept.marker, checks.source)) {
    errors.push(`${appDataDisplayPath(sanitizedName)} holds data kept from ${describeSource(kept.marker)}; this install is from ${describeSource(checks.source)}`);
  }

  const foreign = checks.foreignProjects?.get(sanitizedName);
  if (foreign) {
    errors.push(`a docker project named "${sanitizedName}" already exists on this host (containers: ${foreign.join(', ')}); pick another name`);
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
  const kept = keptFolder(sanitizedName, existingInstances);
  const unknown = { marker: null, keptSource: null, sourceMatches: null };
  if (kept.kind === 'none') return { reuseAvailable: false, markerUnreadable: false, ...unknown };
  if (kept.kind === 'unchecked') return { reuseAvailable: false, markerUnreadable: true, ...unknown };
  if (kept.kind === 'unmarked') return { reuseAvailable: true, markerUnreadable: false, ...unknown };
  if (kept.kind === 'unreadable') return { reuseAvailable: true, markerUnreadable: true, ...unknown };
  return {
    reuseAvailable: true,
    marker: kept.marker,
    markerUnreadable: false,
    keptSource: describeSource(kept.marker),
    sourceMatches: source ? sameSource(kept.marker, source) : null,
  };
}
