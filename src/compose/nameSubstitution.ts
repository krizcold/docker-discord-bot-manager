/**
 * Compose Name Substitution Engine
 *
 * When processing a compose from source with original name -> custom instance name,
 * replace all occurrences across the compose structure.
 *
 * Replacements:
 *   name: field, service keys, container_name, depends_on, hostname,
 *   env values referencing sibling services, Caddy labels, volume paths
 *   (first segment after /AppData/), x-casaos.main, x-casaos.build,
 *   x-casaos.store_app_id, x-casaos.title
 */

import YAML from 'yaml';

/**
 * Substitute all occurrences of originalName with newSanitizedName in a compose file.
 * Optionally sets x-casaos.title to a titleName.
 */
export function substituteComposeNames(
  composeContent: string,
  originalName: string,
  newSanitizedName: string,
  titleName?: string,
): string {
  if (!originalName || originalName === newSanitizedName) {
    return composeContent;
  }

  let doc: any;
  try {
    doc = YAML.parse(composeContent);
  } catch (err) {
    console.warn('[NameSubstitution] Failed to parse compose YAML, returning unmodified:', err);
    return composeContent;
  }

  if (!doc || typeof doc !== 'object') return composeContent;

  // 1. name: field
  if (doc.name && typeof doc.name === 'string') {
    doc.name = replaceInString(doc.name, originalName, newSanitizedName);
  }

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
    for (const service of Object.values(doc.services) as any[]) {
      if (!service || typeof service !== 'object') continue;

      // container_name
      if (typeof service.container_name === 'string') {
        service.container_name = replaceInString(service.container_name, originalName, newSanitizedName);
      }

      // hostname
      if (typeof service.hostname === 'string') {
        service.hostname = replaceInString(service.hostname, originalName, newSanitizedName);
      }

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
        service.environment = service.environment.map((entry: string) =>
          replaceInString(entry, originalName, newSanitizedName)
        );
      } else if (service.environment && typeof service.environment === 'object') {
        for (const [key, value] of Object.entries(service.environment)) {
          if (typeof value === 'string') {
            service.environment[key] = replaceInString(value, originalName, newSanitizedName);
          }
        }
      }

      // labels (Caddy labels and others)
      if (service.labels && typeof service.labels === 'object') {
        if (Array.isArray(service.labels)) {
          service.labels = service.labels.map((label: string) =>
            replaceInString(label, originalName, newSanitizedName)
          );
        } else {
          for (const [key, value] of Object.entries(service.labels)) {
            if (typeof value === 'string') {
              service.labels[key] = replaceInString(value, originalName, newSanitizedName);
            }
          }
        }
      }

      // volumes: replace first segment after /AppData/
      if (Array.isArray(service.volumes)) {
        service.volumes = service.volumes.map((vol: any) => {
          if (typeof vol === 'string') {
            return replaceAppDataPath(vol, originalName, newSanitizedName);
          }
          if (vol && typeof vol === 'object' && typeof vol.source === 'string') {
            vol.source = replaceAppDataPath(vol.source, originalName, newSanitizedName);
          }
          return vol;
        });
      }

      // networks: replace name references
      if (Array.isArray(service.networks)) {
        service.networks = service.networks.map((net: string) =>
          replaceInString(net, originalName, newSanitizedName)
        );
      } else if (service.networks && typeof service.networks === 'object') {
        const newNets: Record<string, any> = {};
        for (const [netKey, netValue] of Object.entries(service.networks)) {
          const newNetKey = replaceInString(netKey, originalName, newSanitizedName);
          newNets[newNetKey] = netValue;
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
      xcasaos.main = serviceNameMap[xcasaos.main] || replaceInString(xcasaos.main, originalName, newSanitizedName);
    }

    if (typeof xcasaos.build === 'string') {
      xcasaos.build = replaceInString(xcasaos.build, originalName, newSanitizedName);
    }

    if (typeof xcasaos.store_app_id === 'string') {
      xcasaos.store_app_id = replaceInString(xcasaos.store_app_id, originalName, newSanitizedName);
    }

    // Title: set to titleName if provided
    if (titleName && xcasaos.title && typeof xcasaos.title === 'object') {
      for (const lang of Object.keys(xcasaos.title)) {
        xcasaos.title[lang] = titleName;
      }
    } else if (xcasaos.title && typeof xcasaos.title === 'object') {
      for (const lang of Object.keys(xcasaos.title)) {
        if (typeof xcasaos.title[lang] === 'string') {
          xcasaos.title[lang] = replaceInString(xcasaos.title[lang], originalName, newSanitizedName);
        }
      }
    }

    // Tagline and description: replace name references
    for (const field of ['tagline', 'description'] as const) {
      if (xcasaos[field] && typeof xcasaos[field] === 'object') {
        for (const lang of Object.keys(xcasaos[field])) {
          if (typeof xcasaos[field][lang] === 'string') {
            xcasaos[field][lang] = replaceInString(xcasaos[field][lang], originalName, newSanitizedName);
          }
        }
      }
    }
  }

  // 4. Top-level volumes: rename keys
  if (doc.volumes && typeof doc.volumes === 'object') {
    const newVolumes: Record<string, any> = {};
    for (const [key, value] of Object.entries(doc.volumes)) {
      const newKey = replaceInString(key, originalName, newSanitizedName);
      newVolumes[newKey] = value;
    }
    doc.volumes = newVolumes;
  }

  // 5. Top-level networks: rename keys
  if (doc.networks && typeof doc.networks === 'object') {
    const newNetworks: Record<string, any> = {};
    for (const [key, value] of Object.entries(doc.networks)) {
      const newKey = replaceInString(key, originalName, newSanitizedName);
      const netValue = value as any;
      if (netValue && typeof netValue === 'object' && typeof netValue.name === 'string') {
        netValue.name = replaceInString(netValue.name, originalName, newSanitizedName);
      }
      newNetworks[newKey] = netValue;
    }
    doc.networks = newNetworks;
  }

  return YAML.stringify(doc, { lineWidth: 0 });
}

// ─── Internal Helpers ───

/**
 * Replace originalName with newName in a string.
 * Uses substring replacement (not regex word-boundary) because compose names
 * are typically concatenated with other parts (e.g. "coolmusicbotapp").
 */
function replaceInString(str: string, originalName: string, newName: string): string {
  if (!str.includes(originalName)) return str;
  // Replace all occurrences
  return str.split(originalName).join(newName);
}

/**
 * Replace the first path segment after /AppData/ in a volume path.
 * e.g. "/AppData/coolmusicbot/data/redis" -> "/AppData/mycoolbot/data/redis"
 */
function replaceAppDataPath(volumeStr: string, originalName: string, newName: string): string {
  // Handle both bind mount strings "source:target" and plain paths
  const appDataPattern = `/AppData/${originalName}`;
  if (volumeStr.includes(appDataPattern)) {
    return volumeStr.split(appDataPattern).join(`/AppData/${newName}`);
  }
  return volumeStr;
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
