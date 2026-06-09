/**
 * Data-driven per-source config-template modifiers. Keyed by the SOURCE REPO URL
 * (data, like DEFAULT_SOURCES - never a bot/image name in code), each record
 * applies format-agnostic edits to the DEFAULT template content the install
 * wizard prefills, so a bot whose shipped template crashes out-of-the-box (e.g. an
 * integration enabled with only a placeholder credential) can be defaulted to a
 * working state. The user still sees and can freely edit/revert every value in the
 * wizard; a modifier only changes the prefilled default, it never locks anything.
 * Adding a new bot is purely appending one record - no code branches.
 */
import { parseDocument } from 'yaml';

export type TemplateEdit =
  | { kind: 'replace'; find: string | RegExp; replace: string }
  | { kind: 'setYamlKey'; path: string; value: string | number | boolean };

export interface TemplateModifier {
  match: { url?: string; urlContains?: string };
  target: string;            // config target name / basename this applies to, e.g. "application.yml"
  edits: TemplateEdit[];
}

export const TEMPLATE_MODIFIERS: TemplateModifier[] = [
  {
    // Lavamusic (bongodevs/lavamusic) ships example.application.yml with every
    // lavasrc source enabled but only placeholder credentials; LavaSrc crashes
    // Lavalink on boot (the Apple Music placeholder token). Default them off so it
    // boots out-of-the-box - the user re-enables and adds keys for any they want.
    match: { urlContains: 'lavamusic' },
    target: 'application.yml',
    edits: [
      { kind: 'setYamlKey', path: 'plugins.lavasrc.sources.spotify', value: false },
      { kind: 'setYamlKey', path: 'plugins.lavasrc.sources.applemusic', value: false },
      { kind: 'setYamlKey', path: 'plugins.lavasrc.sources.deezer', value: false },
      { kind: 'setYamlKey', path: 'plugins.lavasrc.sources.yandexmusic', value: false },
    ],
  },
];

function modifierMatches(m: TemplateModifier, url: string, targetName: string): boolean {
  if (m.target && m.target.toLowerCase() !== (targetName || '').toLowerCase()) return false;
  const u = (url || '').toLowerCase();
  if (m.match.url) return u === m.match.url.toLowerCase();
  if (m.match.urlContains) return !!u && u.includes(m.match.urlContains.toLowerCase());
  return false;
}

function applyEdit(edit: TemplateEdit, format: string, body: string): string {
  if (edit.kind === 'replace') {
    return body.replace(edit.find as RegExp, edit.replace);
  }
  // setYamlKey: only touch an EXISTING key (never create spurious keys).
  const keys = edit.path.split('.');
  if (format === 'yaml') {
    try {
      const doc = parseDocument(body);
      if (!doc.hasIn(keys)) return body;
      doc.setIn(keys, edit.value);
      return doc.toString();
    } catch {
      return body;
    }
  }
  // Non-yaml fallback: line-anchored set of `lastKey: value`.
  const last = keys[keys.length - 1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!last) return body;
  const re = new RegExp(`(^[^\\S\\n]*${last}[^\\S\\n]*:[^\\S\\n]*).*$`, 'mi');
  return re.test(body) ? body.replace(re, `$1${edit.value}`) : body;
}

/**
 * Apply every matching modifier's edits to a template body. url keys the registry
 * (source repo), targetName/format select and drive the edits. Returns the
 * (possibly unchanged) body.
 */
export function applyTemplateModifiers(url: string, targetName: string, format: string, rawBody: string): string {
  let body = rawBody;
  for (const m of TEMPLATE_MODIFIERS) {
    if (!modifierMatches(m, url, targetName)) continue;
    for (const edit of m.edits) body = applyEdit(edit, format, body);
  }
  return body;
}
