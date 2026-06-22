/**
 * Curated hints for known prebuilt bot images, keyed by image ref (tag/digest
 * ignored). Data only; the engine that returns and merges these is general (the
 * same pattern as install manifests). A prebuilt image cannot be scanned like a
 * repo, so these provide the bits image inspection cannot reliably recover:
 *   - env hints: required-no-default vars (a bot token, a prefix) are read at
 *     runtime, not declared in Config.Env, so inspection alone misses them.
 *   - dataPath: where the image keeps its persistent data, so the manager binds
 *     persistence at the right in-container path (Config.Volumes inspection covers
 *     images that declare a VOLUME; this covers the rest / overrides ambiguity).
 */
import { DetectedEnvVar, normalizeEnvLabel } from '../env/manager';

function hint(
  key: string,
  opts: { required?: boolean; sensitive?: boolean; label?: string; defaultValue?: string; description?: string } = {},
): DetectedEnvVar {
  return {
    key,
    displayLabel: opts.label || normalizeEnvLabel(key),
    description: opts.description || '',
    defaultValue: opts.defaultValue || '',
    required: !!opts.required,
    source: 'image',
    sensitive: !!opts.sensitive,
    autoWired: false,
  };
}

interface ImageHint {
  match: string;          // image ref, tag/digest ignored
  vars?: DetectedEnvVar[];
  dataPath?: string;      // in-container persistent data dir
}

const IMAGE_HINTS: ImageHint[] = [
  {
    // Community Red-DiscordBot image. Stores ALL data (cogs, settings, instance
    // config) under /data. TZ/PUID/PGID are platform-injected, so only the
    // genuinely user-set vars are listed (minimal run vars).
    match: 'phasecorex/red-discordbot',
    dataPath: '/data',
    vars: [
      hint('TOKEN', { required: true, sensitive: true }),
      hint('PREFIX', { required: true, label: 'Command Prefix', defaultValue: '!' }),
      hint('OWNER', { label: 'Bot Owner ID', description: 'Your Discord user ID (optional, one-time).' }),
    ],
  },
];

function matchImage(imageRef: string): ImageHint | undefined {
  const ref = (imageRef || '').toLowerCase();
  return IMAGE_HINTS.find(e => {
    const m = e.match.toLowerCase();
    return ref === m || ref.startsWith(m + ':') || ref.startsWith(m + '@');
  });
}

/** Curated env hints for a docker-image source, by image ref. Empty when unknown. */
export function findImageEnvHints(imageRef: string): DetectedEnvVar[] {
  const entry = matchImage(imageRef);
  return entry && entry.vars ? entry.vars.map(v => ({ ...v })) : [];
}

/** Curated in-container data path for a docker-image source. Null when unknown. */
export function findImageDataPath(imageRef: string): string | null {
  const entry = matchImage(imageRef);
  return entry && entry.dataPath ? entry.dataPath : null;
}
