/**
 * Curated environment-variable hints for known prebuilt bot images, keyed by image
 * ref (tag/digest ignored). Data only; the engine that returns and merges these is
 * general (the same pattern as install manifests). A prebuilt image cannot be
 * scanned like a repo, and required-no-default vars (a bot token, a prefix) are read
 * at runtime rather than declared, so image inspection alone cannot surface them.
 * These hints provide the required vars; the inspect layer fills in declared extras.
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

const IMAGE_ENV_HINTS: Array<{ match: string; vars: DetectedEnvVar[] }> = [
  {
    // Community Red-DiscordBot image. TZ/PUID/PGID are platform-injected, so only
    // the genuinely user-set vars are listed (see feedback: minimal run vars).
    match: 'phasecorex/red-discordbot',
    vars: [
      hint('TOKEN', { required: true, sensitive: true }),
      hint('PREFIX', { required: true, label: 'Command Prefix', defaultValue: '!' }),
      hint('OWNER', { label: 'Bot Owner ID', description: 'Your Discord user ID (optional, one-time).' }),
    ],
  },
];

/** Curated env hints for a docker-image source, by image ref. Empty when unknown. */
export function findImageEnvHints(imageRef: string): DetectedEnvVar[] {
  const ref = (imageRef || '').toLowerCase();
  const entry = IMAGE_ENV_HINTS.find(e => {
    const m = e.match.toLowerCase();
    return ref === m || ref.startsWith(m + ':') || ref.startsWith(m + '@');
  });
  return entry ? entry.vars.map(v => ({ ...v })) : [];
}
