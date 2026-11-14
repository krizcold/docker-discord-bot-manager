import { Client } from '../client';
import { ConfigFileBody } from './api';
import { EditRequest, EditResult } from './editbody';
import { editField, Field, field, FieldKey, showField } from './field';
import { GuidedBlock, Manifest } from './guided';

/** One config file card of the page (buildConfigFileBlockHtml). */
export interface ConfigFile {
  path: Field;
  body: string;
  enabled: boolean;
  /** The page's data-readonly: the mode the file was loaded with, undefined when the operator never chose. */
  loadedReadOnly: boolean | undefined;
  writable: boolean;
  writableTouched: boolean;
  repoReadOnly?: boolean;
  guided: GuidedBlock | null;
  undecryptable: boolean;
  inactive?: string;
  /** A repo default not saved yet, as loaded: Save sends it only when it differs. */
  template: { path: string; body: string; readOnly: boolean | undefined; enabled: boolean } | null;
  reuseOff: boolean;
}

export interface FileSource {
  path: string;
  body?: string;
  readOnly?: boolean;
  enabled?: boolean;
  manifest?: unknown;
  format?: string;
  parsed?: unknown;
  undecryptable?: boolean;
  inactive?: string;
  fromTemplate?: boolean;
  repoReadOnly?: boolean;
}

export interface FileLine {
  text: string;
  focus?: string;
  col?: number;
}

/** What a key on a config file did: moved on, asked for the raw editor, or nothing the list takes. */
export type FileKeyResult = { next: true } | { edit: Promise<EditRequest | null> } | { done: true } | null;

const UNDECRYPTABLE_GUIDED = 'The stored file no longer decrypts (the encryption key changed): restore the key, or enter the file again in the raw body';
const UNDECRYPTABLE_RAW = 'The stored file no longer decrypts (the encryption key changed). Leave it empty to keep the stored copy, or enter the file again to replace it.';
const ENABLED_HELP = "On, the next Build (or Update) delivers this file over the repo's copy. Off, it puts the repo default back in place of your edits. Either way a file the bot has changed since is kept.";

function wrapText(text: string, width: number, indent: string): string[] {
  const room = Math.max(width - indent.length, 10);
  const out: string[] = [];
  let rest = text;
  while (rest.length > room) {
    const cut = rest.lastIndexOf(' ', room);
    const at = cut > 0 ? cut : room;
    out.push(indent + rest.slice(0, at));
    rest = rest.slice(at).trimStart();
  }
  out.push(indent + rest);
  return out;
}

/** The page's configFileReadOnly: the toggle once moved, else the mode loaded (undefined when unset). */
export function readOnlyOf(cf: ConfigFile): boolean | undefined {
  return cf.writableTouched ? !cf.writable : cf.loadedReadOnly;
}

function writableHelp(cf: ConfigFile): string {
  if (cf.loadedReadOnly === true || cf.loadedReadOnly === false) {
    return 'Mount the file writable so the bot can change it; off mounts it read-only. Takes effect at the next Build (or Update).';
  }
  if (cf.repoReadOnly === true || cf.repoReadOnly === false) {
    return `Untouched, the file keeps the mode the repo's compose gives it (${cf.repoReadOnly ? 'read-only' : 'writable'}). On mounts it writable, off read-only, from the next Build (or Update).`;
  }
  return "Untouched, a file the repo's compose mounts keeps the repo's mode, and any other file is mounted read-only. On mounts it writable, off read-only, from the next Build (or Update).";
}

/**
 * The config file cards of one form (the install form or the config editor). Focus ids: `c<i>` the on/off line, `p<i>`
 * the path, `w<i>` Writable, `b<i>` the raw body, `g<i>:<part>` the guided form.
 */
export class ConfigFileList {
  files: ConfigFile[] = [];
  /** Set while a guided file's form is written into its body before nano opens; keys wait meanwhile. */
  waiting: string | null = null;

  constructor(
    private client: Client,
    private changed: () => void,
    private say: (text: string) => void,
    /** The word for the action that sends the files: "Save" or "Install". */
    private sendWord: string,
    /** How long the form's changes may take to reach the body before nano opens (the Save limit). */
    private flushMs = 10_000,
  ) {}

  make(src: FileSource): ConfigFile {
    const chosen = src.readOnly === true || src.readOnly === false;
    const cf: ConfigFile = {
      path: field(src.path || ''),
      body: src.body || '',
      enabled: src.enabled !== false,
      loadedReadOnly: chosen ? src.readOnly : undefined,
      writable: chosen ? src.readOnly === false : src.repoReadOnly === false,
      writableTouched: false,
      ...(src.repoReadOnly !== undefined ? { repoReadOnly: src.repoReadOnly } : {}),
      guided: null,
      undecryptable: !!src.undecryptable,
      ...(src.inactive ? { inactive: src.inactive } : {}),
      template: src.fromTemplate ? { path: (src.path || '').trim(), body: src.body || '', readOnly: chosen ? src.readOnly : undefined, enabled: src.enabled !== false } : null,
      reuseOff: false,
    };
    if (src.manifest && typeof src.manifest === 'object') {
      const m = src.manifest as Manifest;
      cf.guided = new GuidedBlock(
        this.client, this.changed, m, m.format || src.format || 'json', src.parsed,
        { get: () => cf.body, set: (b) => { cf.body = b; } },
        cf.undecryptable ? UNDECRYPTABLE_GUIDED : null,
      );
    }
    return cf;
  }

  set(sources: FileSource[]): void {
    this.files = sources.map((s) => this.make(s));
    for (const cf of this.files) cf.guided?.validateAll();
  }

  /** The page's "+ Add config file": an empty card; the returned id is its path field. */
  add(): string {
    this.files.push(this.make({ path: '', body: '' }));
    return `p${this.files.length - 1}`;
  }

  blocks(): GuidedBlock[] {
    return this.files.map((cf) => cf.guided).filter((b): b is GuidedBlock => !!b);
  }

  focusables(): string[] {
    const out: string[] = [];
    this.files.forEach((cf, i) => {
      out.push(`c${i}`, `p${i}`, `w${i}`, `b${i}`);
      if (cf.guided) for (const l of cf.guided.walk(80)) for (const id of l.ids ?? []) out.push(`g${i}:${id}`);
    });
    return out;
  }

  owns(focus: string): boolean {
    return /^[cpwb]\d+$/.test(focus) || /^g\d+:/.test(focus);
  }

  guidedFocus(focus: string): { block: GuidedBlock; sub: string } | null {
    const m = /^g(\d+):(.*)$/.exec(focus);
    const block = m ? this.files[Number(m[1])]?.guided : null;
    return m && block ? { block, sub: m[2] } : null;
  }

  leave(focus: string): void {
    const g = this.guidedFocus(focus);
    if (g) g.block.leave(g.sub);
  }

  /** The page's collectConfigFiles: a repo default left as loaded is skipped; an enabled file needs a body. */
  collect(): ConfigFileBody[] {
    const out: ConfigFileBody[] = [];
    for (const cf of this.files) {
      const path = cf.path.text.trim();
      const readOnly = readOnlyOf(cf);
      const t = cf.template;
      if (t && t.path === path && t.body === cf.body && t.readOnly === readOnly && t.enabled === cf.enabled) continue;
      if (path && (cf.body.trim() || !cf.enabled)) out.push({ path, body: cf.body, ...(readOnly === undefined ? {} : { readOnly }), enabled: cf.enabled });
    }
    return out;
  }

  /** The files whose stored copy no longer decrypts and which now hold a body (saveConfigEditor's question). */
  replacing(): string[] {
    return this.files.filter((cf) => cf.undecryptable && cf.body.trim()).map((cf) => cf.path.text.trim() || '(no path)');
  }

  private index(focus: string): number {
    const m = /^[cpwbg](\d+)/.exec(focus);
    return m ? Number(m[1]) : -1;
  }

  /** Removes the focused file; returns the index it had. */
  remove(focus: string): number {
    const i = this.index(focus);
    if (i >= 0) this.files.splice(i, 1);
    this.changed();
    return i;
  }

  // The page's Raw body, edited in nano: a guided file's pending form changes go into the body first.
  private async edit(cf: ConfigFile): Promise<EditRequest | null> {
    if (cf.guided) {
      for (const sub of Object.keys(cf.guided.drafts)) cf.guided.leave(sub);
      this.waiting = `Writing the form's changes into ${cf.path.text.trim() || 'the file'} before it opens in nano.`;
      this.changed();
      let flushed: boolean;
      try {
        flushed = await cf.guided.flushForSave(this.flushMs);
      } finally {
        this.waiting = null;
        this.changed();
      }
      if (!flushed) {
        this.say('A form change could not be written into the file (see the warning on the file), so its raw body was not opened.');
        return null;
      }
    }
    const name = cf.path.text.trim() || 'config';
    return { name, body: cf.body, done: (r) => this.applyEdit(cf, name, r) };
  }

  private applyEdit(cf: ConfigFile, name: string, r: EditResult): void {
    if (!this.files.includes(cf)) return;
    if (!r.ok) this.say(r.text);
    else if (!r.changed) this.say(`No change to ${name}.`);
    else {
      cf.body = r.body;
      if (cf.guided) {
        cf.guided.skipped = [];
        void cf.guided.reparse();
      }
      this.say(`Took the edited body of ${name}; it is sent when you ${this.sendWord}.`);
    }
    this.changed();
  }

  /** One key on a focus this list owns; null when the caller takes it (Tab, arrows, Esc and its own Ctrl keys). */
  key(focus: string, input: string, key: FieldKey, forwardDelete: boolean): FileKeyResult {
    const g = this.guidedFocus(focus);
    if (g) {
      if (g.block.key(g.sub, input, key, forwardDelete)) return { done: true };
      return key.return ? { next: true } : null;
    }
    const m = /^([cpwb])(\d+)$/.exec(focus);
    const cf = m ? this.files[Number(m[2])] : undefined;
    if (!m || !cf) return null;
    const part = m[1];
    if (part === 'b') return key.return ? { edit: this.edit(cf) } : null;
    if (key.return) return { next: true };
    if (part === 'c' && input === ' ') {
      cf.enabled = !cf.enabled;
      this.changed();
      return { done: true };
    }
    if (part === 'w' && input === ' ') {
      cf.writable = !cf.writable;
      cf.writableTouched = true;
      this.changed();
      return { done: true };
    }
    if (part === 'p') {
      const next = editField(cf.path, input, key, forwardDelete);
      if (!next) return null;
      cf.path = next;
      this.changed();
      return { done: true };
    }
    return null;
  }

  keys(focus: string): string {
    const g = this.guidedFocus(focus);
    if (g) return g.block.keysFor(g.sub);
    const part = focus.charAt(0);
    if (part === 'c') return 'Space On/off  Ctrl+D Remove file';
    if (part === 'w') return 'Space Writable on/off  Ctrl+D Remove file';
    if (part === 'b') return 'Enter Edit in nano  Ctrl+D Remove file';
    return 'Ctrl+D Remove file';
  }

  lines(inner: number, focus: string): FileLine[] {
    const all: FileLine[] = [];
    const push = (text: string, extra: Partial<FileLine> = {}) => all.push({ text, ...extra });
    this.files.forEach((cf, i) => {
      const path = cf.path.text;
      push(`  [${cf.enabled ? 'x' : ' '}] ${path.trim() || '(no path)'}`.slice(0, inner), { focus: `c${i}` });
      if (focus === `c${i}`) for (const t of wrapText(ENABLED_HELP, inner, '      ')) push(t);
      if (cf.inactive) for (const t of wrapText(cf.inactive, inner, '      ')) push(t);
      if (cf.template) for (const t of wrapText('Repo default, not saved yet: Save keeps it only if you change it.', inner, '      ')) push(t);
      const pf = showField(cf.path, Math.max(inner - 18, 12));
      push(`      Path        ${pf.text}`, { focus: `p${i}`, ...(focus === `p${i}` ? { col: 18 + pf.col } : {}) });
      push(`      [${cf.writable ? 'x' : ' '}] Writable`, { focus: `w${i}` });
      if (focus === `w${i}`) for (const t of wrapText(writableHelp(cf), inner, '          ')) push(t);
      const n = cf.body ? cf.body.split('\n').length - (cf.body.endsWith('\n') ? 1 : 0) : 0;
      push(`      ${cf.guided ? 'Raw body' : 'Body'}    ${n} line${n === 1 ? '' : 's'}; Enter edits it in nano`.slice(0, inner), { focus: `b${i}` });
      if (cf.undecryptable && !cf.guided) for (const t of wrapText(UNDECRYPTABLE_RAW, inner, '      ')) push(t);
      if (cf.guided) {
        const prefix = `g${i}:`;
        const sub = focus.startsWith(prefix) ? focus.slice(prefix.length) : undefined;
        for (const l of cf.guided.walk(inner, sub)) {
          push(l.text.slice(0, inner), {
            ...(l.ids ? { focus: l.ids.map((id) => prefix + id).join('|') } : {}),
            ...(l.col !== undefined && sub !== undefined && l.ids?.includes(sub) ? { col: l.col } : {}),
          });
        }
      }
    });
    return all;
  }
}
