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
  | { kind: 'setYamlKey'; path: string; value: string | number | boolean }
  | { kind: 'deleteYamlKey'; path: string };

export interface TemplateModifier {
  match: { url?: string; urlContains?: string };
  target: string;            // config target name / basename this applies to, e.g. "application.yml"
  edits: TemplateEdit[];
}

export const TEMPLATE_MODIFIERS: TemplateModifier[] = [
  {
    // Lavamusic (bongodevs/lavamusic) ships example.application.yml wired for
    // companion services / credentials we never deploy, all of which break the
    // out-of-the-box experience:
    //  - every lavasrc source enabled with only placeholder credentials; the
    //    Apple Music placeholder token crashes LavaSrc on boot.
    //  - youtube.remoteCipher pointed at a yt-cipher server on localhost:8001;
    //    its presence forces remote signature deciphering, so every WEB-family
    //    client fails with "Connection refused" and nothing ever plays.
    // We also enable youtube.oauth: a datacenter IP hits YouTube's "Sign in to
    // confirm you're not a bot" wall, and OAuth is youtube-source's only bypass.
    // With oauth.enabled true and no refreshToken, Lavalink logs a device code on
    // boot; the user authorizes once (burner Google account advised) and pastes the
    // logged refreshToken back into this config to persist it across restarts.
    match: { urlContains: 'lavamusic' },
    target: 'application.yml',
    edits: [
      { kind: 'setYamlKey', path: 'plugins.lavasrc.sources.spotify', value: false },
      { kind: 'setYamlKey', path: 'plugins.lavasrc.sources.applemusic', value: false },
      { kind: 'setYamlKey', path: 'plugins.lavasrc.sources.deezer', value: false },
      { kind: 'setYamlKey', path: 'plugins.lavasrc.sources.yandexmusic', value: false },
      { kind: 'deleteYamlKey', path: 'plugins.youtube.remoteCipher' },
      { kind: 'setYamlKey', path: 'plugins.youtube.oauth.enabled', value: true },
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
  const keys = edit.path.split('.');
  // deleteYamlKey: drop an existing key/block (e.g. an integration pointed at a
  // companion service we never deploy). Yaml-only; comments on the node go with it.
  if (edit.kind === 'deleteYamlKey') {
    if (format !== 'yaml') return body;
    try {
      const doc = parseDocument(body);
      if (!doc.hasIn(keys)) return body;
      doc.deleteIn(keys);
      return doc.toString();
    } catch {
      return body;
    }
  }
  // setYamlKey: only touch an EXISTING key (never create spurious keys).
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
