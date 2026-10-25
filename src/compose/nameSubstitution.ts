/**
 * Compose Name Substitution Engine
 *
 * When processing a compose from source with original name -> custom instance name,
 * replace all occurrences across the compose structure.
 *
 * Replacements:
 *   name: field, service keys, container_name, depends_on, hostname,
 *   env values, labels, volume references and container paths, working_dir,
 *   command, entrypoint, healthcheck test, volume and network keys with their
 *   service references (an external one keeps the docker object it names),
 *   x-casaos.main, x-casaos.build, x-casaos.store_app_id, x-casaos.title
 */

import YAML from 'yaml';
import { composeEnvValue, splitDockerVolume } from '../templates/pcsProcessing';

export interface NameSubstitutionResult {
  content: string;
  /** Build-log lines naming each env value the substitution changed. */
  notes: string[];
}

/**
 * Substitute all occurrences of originalName with newSanitizedName in a compose file.
 * Optionally sets x-casaos.title to a titleName. Throws when the compose cannot be
 * parsed: a build that went on with the original names would share containers and
 * data folders with the instance that owns them.
 */
export function substituteComposeNames(
  composeContent: string,
  originalName: string,
  newSanitizedName: string,
  titleName?: string,
): NameSubstitutionResult {
  const notes: string[] = [];
  if (!originalName || originalName === newSanitizedName) {
    return { content: composeContent, notes };
  }

  const parsed = YAML.parseDocument(composeContent);
  if (parsed.errors.length > 0) {
    throw new Error(`the compose file cannot be parsed, so ${originalName} could not be renamed to ${newSanitizedName}: ${parsed.errors[0].message.split('\n')[0]}`);
  }
  const doc: any = parsed.toJSON();
  if (!doc || typeof doc !== 'object') {
    throw new Error(`the compose file holds no mapping, so ${originalName} could not be renamed to ${newSanitizedName}`);
  }

  const rename = (s: string): string => replaceInString(s, originalName, newSanitizedName);
  const renameList = (list: unknown[]): unknown[] => list.map(part => typeof part === 'string' ? rename(part) : part);
  const renameText = (s: string): string => replaceInString(s, originalName, composeEnvValue(newSanitizedName));

  // 1. name: field
  if (doc.name && typeof doc.name === 'string') {
    doc.name = rename(doc.name);
  }

  const volumeKeyMap: Record<string, string> = {};
  if (doc.volumes && typeof doc.volumes === 'object') {
    for (const key of Object.keys(doc.volumes)) {
      const renamed = rename(key);
      if (renamed !== key) volumeKeyMap[key] = renamed;
    }
  }
  const renameSource = (source: string): string => isNamedVolumeSource(source)
    ? (volumeKeyMap[source] || source)
    : replaceAppDataPath(source, originalName, newSanitizedName);

  // 2. Rename service keys and update all internal references
  if (doc.services && typeof doc.services === 'object') {
    const oldServiceNames = Object.keys(doc.services);
    const serviceNameMap = buildServiceNameMap(oldServiceNames, originalName, newSanitizedName);

    // Rename service keys
    const newServices: Record<string, any> = {};
    for (const [oldKey, service] of Object.entries(doc.services)) {
      const newKey = serviceNameMap[oldKey] || oldKey;
      newServices[newKey] = service;
    }
    doc.services = newServices;

    // Update references within each service
    for (const [serviceName, service] of Object.entries(doc.services) as Array<[string, any]>) {
      if (!service || typeof service !== 'object') continue;

      if (typeof service.container_name === 'string') service.container_name = rename(service.container_name);
      if (typeof service.hostname === 'string') service.hostname = rename(service.hostname);

      // depends_on (array or object form)
      if (Array.isArray(service.depends_on)) {
        service.depends_on = service.depends_on.map((dep: string) => serviceNameMap[dep] || dep);
      } else if (service.depends_on && typeof service.depends_on === 'object') {
        const newDeps: Record<string, any> = {};
        for (const [depKey, depValue] of Object.entries(service.depends_on)) {
          const newDepKey = serviceNameMap[depKey] || depKey;
          newDeps[newDepKey] = depValue;
        }
        service.depends_on = newDeps;
      }

      // environment (array or object form)
      if (Array.isArray(service.environment)) {
        service.environment = service.environment.map((entry: unknown) => {
          if (typeof entry !== 'string') return entry;
          const renamed = rename(entry);
          if (renamed !== entry) notes.push(`[Info] Substituted the compose name in ${serviceName} env ${entry.split('=')[0]}`);
          return renamed;
        });
      } else if (service.environment && typeof service.environment === 'object') {
        for (const [key, value] of Object.entries(service.environment)) {
          if (typeof value !== 'string') continue;
          const renamed = rename(value);
          if (renamed === value) continue;
          service.environment[key] = renamed;
          notes.push(`[Info] Substituted the compose name in ${serviceName} env ${key}`);
        }
      }

      // labels (Caddy labels and others)
      if (Array.isArray(service.labels)) {
        service.labels = renameList(service.labels);
      } else if (service.labels && typeof service.labels === 'object') {
        for (const [key, value] of Object.entries(service.labels)) {
          if (typeof value === 'string') service.labels[key] = rename(value);
        }
      }

      // volumes: a named volume follows its renamed key, an AppData source
      // follows the name, and the container path gets the same rename as the
      // env values that point at it.
      if (Array.isArray(service.volumes)) {
        service.volumes = service.volumes.map((vol: any) => {
          if (typeof vol === 'string') return renameShortVolume(vol, renameSource, rename);
          if (vol && typeof vol === 'object') {
            if (typeof vol.source === 'string') vol.source = renameSource(vol.source);
            if (typeof vol.target === 'string') vol.target = rename(vol.target);
          }
          return vol;
        });
      }

      if (typeof service.working_dir === 'string') service.working_dir = rename(service.working_dir);
      for (const field of ['command', 'entrypoint'] as const) {
        if (typeof service[field] === 'string') service[field] = rename(service[field]);
        else if (Array.isArray(service[field])) service[field] = renameList(service[field]);
      }
      if (service.healthcheck && typeof service.healthcheck === 'object') {
        const test = service.healthcheck.test;
        if (typeof test === 'string') service.healthcheck.test = rename(test);
        else if (Array.isArray(test)) service.healthcheck.test = renameList(test);
      }

      // networks: replace name references
      if (Array.isArray(service.networks)) {
        service.networks = renameList(service.networks);
      } else if (service.networks && typeof service.networks === 'object') {
        const newNets: Record<string, any> = {};
        for (const [netKey, netValue] of Object.entries(service.networks)) {
          newNets[rename(netKey)] = netValue;
        }
        service.networks = newNets;
      }
    }
  }

  // 3. x-casaos metadata
  const xcasaos = doc['x-casaos'];
  if (xcasaos && typeof xcasaos === 'object') {
    if (typeof xcasaos.main === 'string') {
      const serviceNameMap = doc.services
        ? buildServiceNameMap(Object.keys(doc.services), originalName, newSanitizedName)
        : {};
      // main might have already been renamed, check both forms
      xcasaos.main = serviceNameMap[xcasaos.main] || rename(xcasaos.main);
    }

    if (typeof xcasaos.build === 'string') xcasaos.build = rename(xcasaos.build);
    if (typeof xcasaos.store_app_id === 'string') xcasaos.store_app_id = rename(xcasaos.store_app_id);

    // Title: set to titleName if provided
    if (titleName && xcasaos.title && typeof xcasaos.title === 'object') {
      for (const lang of Object.keys(xcasaos.title)) {
        xcasaos.title[lang] = composeEnvValue(titleName);
      }
    } else if (xcasaos.title && typeof xcasaos.title === 'object') {
      for (const lang of Object.keys(xcasaos.title)) {
        if (typeof xcasaos.title[lang] === 'string') xcasaos.title[lang] = renameText(xcasaos.title[lang]);
      }
    }

    // Tagline and description: replace name references
    for (const field of ['tagline', 'description'] as const) {
      if (xcasaos[field] && typeof xcasaos[field] === 'object') {
        for (const lang of Object.keys(xcasaos[field])) {
          if (typeof xcasaos[field][lang] === 'string') xcasaos[field][lang] = renameText(xcasaos[field][lang]);
        }
      }
    }
  }

  // 4. Top-level volumes and networks: rename keys. An external entry keeps the
  // docker object it names. A declared volume name stays, so a volume another
  // instance already runs on is refused as shared instead of replaced by an empty one.
  for (const section of ['volumes', 'networks'] as const) {
    if (!doc[section] || typeof doc[section] !== 'object') continue;
    const renamed: Record<string, any> = {};
    for (const [key, value] of Object.entries(doc[section])) {
      const newKey = rename(key);
      let entry = value as any;
      if (entry && typeof entry === 'object' && entry.external) {
        const named = typeof entry.name === 'string' || (entry.external && typeof entry.external === 'object' && typeof entry.external.name === 'string');
        if (newKey !== key && !named) entry = { ...entry, name: key };
      } else if (section === 'networks' && entry && typeof entry === 'object' && typeof entry.name === 'string') {
        entry.name = rename(entry.name);
      }
      renamed[newKey] = entry;
    }
    doc[section] = renamed;
  }

  return { content: YAML.stringify(doc, { lineWidth: 0 }), notes };
}

// ─── Internal Helpers ───

/**
 * Replace originalName with newName in a string.
 * Uses substring replacement (not regex word-boundary) because compose names
 * are typically concatenated with other parts (e.g. "coolmusicbotapp").
 */
function replaceInString(str: string, originalName: string, newName: string): string {
  if (!str.includes(originalName)) return str;
  return str.split(originalName).join(newName);
}

/**
 * Replace the first path segment after /AppData/ in a volume path.
 * e.g. "/AppData/coolmusicbot/data/redis" -> "/AppData/mycoolbot/data/redis"
 */
function replaceAppDataPath(volumeStr: string, originalName: string, newName: string): string {
  const appDataPattern = `/AppData/${originalName}`;
  if (volumeStr.includes(appDataPattern)) {
    return volumeStr.split(appDataPattern).join(`/AppData/${newName}`);
  }
  return volumeStr;
}

function isNamedVolumeSource(source: string): boolean {
  return source !== '' && !/^[./~$]/.test(source) && !/^[A-Za-z]:[\\/]/.test(source);
}

/** "source:target[:mode]", or a bare container path for an anonymous volume. */
function renameShortVolume(vol: string, renameSource: (s: string) => string, rename: (s: string) => string): string {
  const split = splitDockerVolume(vol);
  if (!split) return rename(vol);
  const mode = vol.slice(split.source.length + 1 + split.dest.length);
  return `${renameSource(split.source)}:${rename(split.dest)}${mode}`;
}

/**
 * Build a mapping of old service names to new service names.
 * Services containing the originalName get it replaced with newName.
 */
function buildServiceNameMap(
  oldServiceNames: string[],
  originalName: string,
  newName: string,
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const old of oldServiceNames) {
    const renamed = replaceInString(old, originalName, newName);
    if (renamed !== old) {
      map[old] = renamed;
    }
  }
  return map;
}
