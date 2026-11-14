import { Client } from '../client';
import { ConfigOp, parseConfigBody, serializeConfigBody, validateDiscordId } from './api';
import { editField, Field, field, FieldKey, showField } from './field';

// The manifest shapes of src/config/installManifests.ts, as the envs route sends them.
export interface Option {
  value: string | number | boolean;
  label?: string;
}

export interface FieldSpec {
  type: string;
  label?: string;
  help?: string;
  required?: boolean;
  default?: unknown;
  sensitive?: boolean;
  envAlt?: { var: string; flagPath?: string };
  options?: Option[];
  element?: { field?: FieldSpec; objectFields?: Array<FieldSpec & { key: string }>; itemLabel?: string };
  rows?: Array<{ key: string; label: string }>;
  columns?: Array<{ key: string; label: string }>;
  serverIdRef?: { path: string };
  literals?: string[];
  placeholders?: string[];
  showWhen?: { path: string; equals?: unknown; notEquals?: unknown; in?: unknown[] };
  target?: { path?: string };
  key?: string;
}

export interface SectionSpec {
  id: string;
  title: string;
  help?: string;
  toggle?: { target?: { path: string }; default: boolean; disabledBehavior: string; omitPath?: { path: string } };
  fields?: FieldSpec[];
  sections?: SectionSpec[];
}

export interface Manifest {
  format?: string;
  sections?: SectionSpec[];
  root?: FieldSpec;
}

export interface GuidedLine {
  text: string;
  focus?: string;
  col?: number;
}

type Desc =
  | { t: 'scalar'; f: FieldSpec; path: string; list?: { listPath: string; index: number } ; envAlt?: boolean }
  | { t: 'envalt-env'; f: FieldSpec; path: string }
  | { t: 'toggle'; sec: SectionSpec }
  | { t: 'list'; f: FieldSpec; listPath: string }
  | { t: 'item'; f: FieldSpec; listPath: string; index: number }
  | { t: 'cell'; f: FieldSpec; base: string };

const KIND: Record<string, string> = { 'user-id': 'user', 'role-id': 'role', 'channel-id': 'channel', 'guild-id': 'guild', 'role-or-user-id': 'member' };
const PAUSED = 'The file does not parse, so its guided form is paused; it goes as the repo has it.';
const TEXTLIKE = new Set(['text', 'password', 'number', 'color', ...Object.keys(KIND)]);

// The page's guidedConfig.js path grammar: [N] is an array index, a dotted part is a key.
export function splitPath(p: string): Array<string | number> {
  const out: Array<string | number> = [];
  const re = /\[(\d+)\]|([^.[\]]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(p))) {
    if (m[1] !== undefined) out.push(Number(m[1]));
    else if (m[2]) out.push(m[2]);
  }
  return out;
}

export function getAt(obj: unknown, p: string): unknown {
  let c = obj as Record<string | number, unknown> | null | undefined;
  for (const s of splitPath(p)) {
    if (c == null) return undefined;
    c = c[s] as Record<string | number, unknown> | null | undefined;
  }
  return c;
}

export function setAt(obj: unknown, p: string, val: unknown): void {
  const segs = splitPath(p);
  let c = obj as Record<string | number, unknown>;
  for (let i = 0; i < segs.length - 1; i++) {
    const s = segs[i];
    if (c[s] == null || typeof c[s] !== 'object') c[s] = typeof segs[i + 1] === 'number' ? [] : {};
    c = c[s] as Record<string | number, unknown>;
  }
  c[segs[segs.length - 1]] = val;
}

function walkFields(sections: SectionSpec[] | undefined, fn: (f: FieldSpec) => void): void {
  for (const sec of sections || []) {
    for (const f of sec.fields || []) fn(f);
    walkFields(sec.sections, fn);
  }
}

function elemPath(listPath: string, index: number, key?: string): string {
  const base = listPath ? `${listPath}[${index}]` : `[${index}]`;
  return key ? `${base}.${key}` : base;
}

function wrap(text: string, width: number, indent: string): string[] {
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

// renderChip on the page, in its words.
function chipText(kind: string, r: { success?: boolean; status?: string; name?: string; resolvedKind?: string; reason?: string }): string {
  if (!r || r.success !== true) return "Can't validate";
  const k = r.resolvedKind || kind;
  if (r.status === 'ok') return k === 'channel' ? `# ${r.name || ''}` : r.name || '';
  if (r.status === 'invalid') return `Invalid ${kind === 'member' ? 'ID' : kind}`;
  if (r.status === 'bot_not_in_guild') return 'Bot not in this server, or it cannot read it';
  if (r.status === 'cannot_access') return "Can't access (check perms)";
  const why: Record<string, string> = {
    token: 'Set token to validate',
    token_rejected: 'Discord rejected this token (401): check or regenerate it',
    forbidden: 'Discord refused access (403)',
    missing_guild: 'Set Server ID first',
    rate_limit: "Can't validate: Discord rate limit",
    network: "Can't validate: Discord did not answer",
  };
  return (r.reason && why[r.reason]) || "Can't validate";
}

/** One config file's guided form (guidedConfig.js): the body stays the file's text, changed only by the serialize round trip. */
export class GuidedBlock {
  parsed: unknown;
  readonly tokenPath: string | null;
  pending: ConfigOp[] = [];
  inflight: Promise<boolean> | null = null;
  serializeError: string | null = null;
  unconfirmed = false;
  skipped: string[] = [];
  parseError: string | null = null;
  formLocked = false;
  envStash: Record<string, unknown> = {};
  expanded: Record<string, boolean> = {};
  chips: Record<string, string> = {};
  notes: Record<string, string> = {};
  drafts: Record<string, Field> = {};
  private checks: Record<string, number> = {};
  private checkSeq = 0;

  constructor(
    private client: Client,
    private changed: () => void,
    readonly manifest: Manifest,
    readonly format: string,
    parsed: unknown,
    private body: { get: () => string; set: (b: string) => void },
  ) {
    let tokenPath: string | null = null;
    walkFields(manifest.sections, (f) => {
      if (!tokenPath && f.type === 'password' && f.target?.path) tokenPath = f.target.path;
    });
    this.tokenPath = tokenPath;
    this.parsed = parsed == null ? {} : structuredClone(parsed);
    if (parsed == null && body.get().trim()) {
      this.formLocked = true;
      this.parseError = PAUSED;
    }
  }

  private findField(path: string): FieldSpec | null {
    let found: FieldSpec | null = null;
    walkFields(this.manifest.sections, (f) => {
      if (f.target?.path === path) found = f;
    });
    return found;
  }

  private cur(path: string, def: unknown): unknown {
    const v = getAt(this.parsed, path);
    return v !== undefined ? v : def !== undefined ? def : '';
  }

  private envMode(f: FieldSpec): 'env' | 'file' {
    return f.envAlt?.flagPath && getAt(this.parsed, f.envAlt.flagPath) ? 'env' : 'file';
  }

  /** The badge: a failed write outranks an unconfirmed one, a skipped field, then a parse problem. */
  badge(): string {
    if (this.serializeError) return `A form change was not written to the file: ${this.serializeError}`;
    if (this.unconfirmed) return 'No answer from the manager yet; could not confirm the form change was written';
    if (this.skipped.length) return `Could not apply: ${this.skipped.join(', ')}; the file was not changed there`;
    return this.parseError ?? '';
  }


  private push(op: ConfigOp): void {
    this.pending.push(op);
  }

  flush(): Promise<boolean> {
    if (this.inflight) return this.inflight;
    if (!this.pending.length) return Promise.resolve(!this.serializeError);
    this.inflight = this.runSerialize().then((ok) => {
      this.inflight = null;
      return ok;
    });
    return this.inflight;
  }

  private async runSerialize(): Promise<boolean> {
    let reparse = false;
    while (this.pending.length) {
      const ops = this.pending;
      this.pending = [];
      const r = await serializeConfigBody(this.client, this.format, this.body.get(), ops);
      const answer = r.ok === true ? r.value : null;
      if (!answer || answer.success !== true || typeof answer.body !== 'string') {
        this.pending = ops.concat(this.pending);
        this.serializeError = r.ok === null ? `the manager did not answer (${r.text})` : r.ok === false ? r.text : answer?.error || 'the request failed';
        this.changed();
        return false;
      }
      this.body.set(answer.body);
      this.serializeError = null;
      this.unconfirmed = false;
      const skipped = Array.isArray(answer.skipped) ? (answer.skipped as string[]) : [];
      const sent = ops.map((o) => o.path);
      this.skipped = this.skipped.filter((p) => !sent.includes(p)).concat(skipped.filter((p, i) => skipped.indexOf(p) === i));
      if (skipped.length) reparse = true;
    }
    if (reparse) void this.reparse();
    this.changed();
    return !this.serializeError;
  }

  async reparse(): Promise<void> {
    const r = await parseConfigBody(this.client, this.format, this.body.get());
    const a = r.ok === true ? r.value : null;
    if (a && a.success === true && a.ok === true) {
      this.parsed = a.data ?? {};
      this.parseError = null;
      this.formLocked = false;
      this.validateAll();
    } else this.parseError = a && a.success === true ? PAUSED : 'Could not refresh the form; showing earlier values';
    this.changed();
  }

  /** guidedFlushAll for this block: false when a change is not in the body. */
  async flushForSave(timeoutMs = 10_000): Promise<boolean> {
    this.serializeError = null;
    this.unconfirmed = false;
    let timer: NodeJS.Timeout | undefined;
    const done = await Promise.race([
      this.flush(),
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs);
      }),
    ]);
    clearTimeout(timer);
    if (done === 'timeout') {
      this.unconfirmed = true;
      this.changed();
    }
    return !(done !== true || this.pending.length || this.inflight || this.skipped.length);
  }

  /** guidedPendingErasures: in-file values a save would clear because their field reads from env now. */
  erasures(): Array<{ label: string; envVar: string }> {
    const out: Array<{ label: string; envVar: string }> = [];
    for (const path of Object.keys(this.envStash)) {
      const f = this.findField(path);
      if (f && f.envAlt && this.envMode(f) === 'env') out.push({ label: f.label || path, envVar: f.envAlt.var });
    }
    return out;
  }


  private validate(path: string, f: FieldSpec, value: unknown): void {
    const kind = KIND[f.type];
    const val = String(value ?? '').trim();
    const seq = ++this.checkSeq;
    this.checks[path] = seq;
    if (!val || (f.placeholders || []).includes(val)) {
      delete this.chips[path];
      return;
    }
    if ((f.literals || []).includes(val)) {
      this.chips[path] = val;
      return;
    }
    if (!/^\d{5,25}$/.test(val)) {
      this.chips[path] = `Invalid ${kind}`;
      return;
    }
    this.chips[path] = 'Checking.';
    const token = this.tokenPath ? String(getAt(this.parsed, this.tokenPath) || '') : '';
    const guildId = f.serverIdRef?.path ? getAt(this.parsed, f.serverIdRef.path) : undefined;
    void validateDiscordId(this.client, { token, kind, id: val, guildId }).then((r) => {
      if (this.checks[path] !== seq) return;
      this.chips[path] = r.ok === true ? chipText(kind, r.value) : r.ok === null ? `can't confirm: the manager did not answer (${r.text})` : "Can't validate";
      this.changed();
    });
  }

  /** guidedValidateAll: every id field the form shows. */
  validateAll(): void {
    for (const e of this.walk(80)) {
      const d = e.desc;
      if (d && d.t === 'scalar' && KIND[d.f.type]) this.validate(d.path, d.f, this.cur(d.path, d.f.default));
    }
    this.changed();
  }


  private set(path: string, value: unknown, now = true): void {
    setAt(this.parsed, path, value);
    this.push({ path, value });
    if (now) void this.flush();
  }

  /** The cursor leaves a field: a typed value goes into the body, and an id field is checked. */
  leave(sub: string): void {
    const draft = this.drafts[sub];
    if (!draft) return;
    delete this.drafts[sub];
    const d = this.descOf(sub);
    if (!d || d.t !== 'scalar') return;
    const { f, path } = d;
    const kept = getAt(this.parsed, path);
    let val: unknown = draft.text;
    delete this.notes[path];
    if (draft.text === String(this.cur(path, f.default) ?? '')) {
      this.changed();
      return;
    }
    if (f.type === 'number') {
      const v = draft.text.trim();
      const n = Number(v);
      if (v === '' || Number.isNaN(n)) {
        this.notes[path] = `Not a number: the file keeps ${kept == null ? 'its value' : String(kept)}`;
        this.changed();
        return;
      }
      val = n;
    }
    this.set(path, val);
    if (KIND[f.type]) this.validate(path, f, val);
    this.changed();
  }

  private descOf(sub: string): Desc | undefined {
    return this.walk(80).find((e) => e.ids?.includes(sub))?.desc;
  }

  private newItem(f: FieldSpec | undefined): unknown {
    const el = f?.element || {};
    if (el.objectFields) {
      const o = {};
      for (const of of el.objectFields) {
        if (of.showWhen) continue;
        let dv = of.default;
        if (dv === undefined) dv = of.type === 'list' ? [] : of.type === 'boolean' ? false : of.type === 'number' ? 0 : '';
        setAt(o, of.key, dv);
      }
      return o;
    }
    if (el.field) return el.field.default !== undefined ? el.field.default : '';
    return '';
  }

  private listArray(listPath: string): unknown {
    return listPath ? getAt(this.parsed, listPath) : this.parsed;
  }

  private addItem(f: FieldSpec, listPath: string): void {
    let arr = this.listArray(listPath);
    if (!Array.isArray(arr)) {
      arr = [];
      if (listPath) setAt(this.parsed, listPath, arr);
      else this.parsed = arr;
    }
    const list = arr as unknown[];
    const idx = list.length;
    list.push(this.newItem(f));
    this.expanded[elemPath(listPath, idx)] = true;
    this.push({ path: elemPath(listPath, idx), value: list[idx], insert: true });
    void this.flush();
    this.refreshList(listPath);
  }

  private removeItem(listPath: string, index: number): void {
    const arr = this.listArray(listPath);
    if (!Array.isArray(arr)) return;
    arr.splice(index, 1);
    this.push({ path: elemPath(listPath, index), remove: true });
    void this.flush();
    this.refreshList(listPath);
  }

  // guidedRefresh after a list change: checks, notes and drafts are keyed by element path, which now names other items.
  private refreshList(listPath: string): void {
    const under = (path: string) => path.startsWith(`${listPath}[`);
    for (const store of [this.chips, this.notes, this.checks] as Array<Record<string, unknown>>) {
      for (const path of Object.keys(store)) if (under(path)) delete store[path];
    }
    for (const sub of Object.keys(this.drafts)) if (sub.startsWith('f:') && under(sub.slice(2))) delete this.drafts[sub];
    this.validateAll();
  }

  // guidedEnvAltMode on the page.
  private switchEnv(f: FieldSpec, path: string): void {
    if (!f.envAlt) return;
    const toEnv = this.envMode(f) === 'file';
    if (f.envAlt.flagPath) this.set(f.envAlt.flagPath, toEnv, false);
    if (toEnv) {
      const cur = getAt(this.parsed, path);
      if (cur !== undefined && cur !== '') this.envStash[path] = cur;
      this.set(path, '', false);
    } else if (Object.prototype.hasOwnProperty.call(this.envStash, path)) {
      const back = this.envStash[path];
      delete this.envStash[path];
      this.set(path, back, false);
    }
    void this.flush();
  }

  /** One key on a focused part of the form; false when the key is not the form's. */
  key(sub: string, input: string, key: FieldKey, forwardDelete: boolean): boolean {
    const d = this.descOf(sub);
    if (!d) return false;
    const c = key.ctrl ? input.toLowerCase() : '';
    const space = input === ' ' && !key.ctrl;
    if (d.t === 'toggle') {
      if (!space || !d.sec.toggle) return false;
      const t = d.sec.toggle;
      const cur = t.target ? getAt(this.parsed, t.target.path) : undefined;
      const on = !(cur === undefined ? !!t.default : !!cur);
      if (t.target?.path) this.set(t.target.path, on, false);
      if (!on && t.disabledBehavior === 'omit' && t.omitPath) this.push({ path: t.omitPath.path, remove: true });
      void this.flush();
      if (on) this.validateAll();
      this.changed();
      return true;
    }
    if (d.t === 'list') {
      if (c !== 'n') return false;
      this.addItem(d.f, d.listPath);
      this.changed();
      return true;
    }
    if (d.t === 'item') {
      if (c === 'n') this.addItem(d.f, d.listPath);
      else if (c === 'd') this.removeItem(d.listPath, d.index);
      else if (space) {
        const p = elemPath(d.listPath, d.index);
        this.expanded[p] = !this.isExpanded(d.f, p);
        if (this.expanded[p]) this.validateAll();
      } else return false;
      this.changed();
      return true;
    }
    if (d.t === 'cell') {
      const path = sub.slice(2);
      if (space) this.set(path, !getAt(this.parsed, path));
      else if (c === 'a') {
        const rows = d.f.rows || [];
        const colKey = path.slice(path.lastIndexOf('.') + 1);
        const all = rows.every((r) => !!getAt(this.parsed, `${d.base}.${r.key}.${colKey}`));
        for (const r of rows) this.set(`${d.base}.${r.key}.${colKey}`, !all, false);
        void this.flush();
      } else return false;
      this.changed();
      return true;
    }
    if (d.t === 'envalt-env') {
      if (c !== 'e') return false;
      this.switchEnv(d.f, d.path);
      this.changed();
      return true;
    }
    const { f, path, list } = d;
    if (c === 'e' && d.envAlt) {
      this.leave(sub);
      this.switchEnv(f, path);
      this.changed();
      return true;
    }
    if (c === 'd' && list) {
      delete this.drafts[sub];
      this.removeItem(list.listPath, list.index);
      this.changed();
      return true;
    }
    if (c === 'n' && list) {
      this.leave(sub);
      const listSpec = this.listSpecAt(list.listPath);
      if (listSpec) this.addItem(listSpec, list.listPath);
      this.changed();
      return true;
    }
    if (f.type === 'boolean') {
      if (!space) return false;
      this.set(path, !this.cur(path, f.default));
      this.changed();
      return true;
    }
    if (f.type === 'select') {
      if (!key.leftArrow && !key.rightArrow) return false;
      const opts = f.options || [];
      if (!opts.length) return true;
      const at = opts.findIndex((o) => String(o.value) === String(this.cur(path, f.default)));
      const next = at < 0 ? 0 : (at + (key.rightArrow ? 1 : opts.length - 1)) % opts.length;
      this.set(path, opts[next].value);
      this.changed();
      return true;
    }
    if (!TEXTLIKE.has(f.type)) return false;
    const draft = this.drafts[sub] ?? field(String(this.cur(path, f.default) ?? ''));
    const next = editField(draft, input, key, forwardDelete);
    if (!next) return false;
    this.drafts[sub] = next;
    this.changed();
    return true;
  }

  private listSpecs: Record<string, FieldSpec> = {};

  private listSpecAt(listPath: string): FieldSpec | undefined {
    this.walk(80);
    return this.listSpecs[listPath];
  }

  private isExpanded(f: FieldSpec, base: string): boolean {
    const el = f.element || {};
    return this.expanded[base] !== undefined ? this.expanded[base] : (el.objectFields?.length ?? 0) <= 4;
  }

  keysFor(sub: string): string {
    const d = this.descOf(sub);
    if (!d) return '';
    if (d.t === 'toggle') return 'Space On/off';
    if (d.t === 'list') return 'Ctrl+N Add';
    if (d.t === 'item') return 'Space Open/close  Ctrl+N Add  Ctrl+D Remove';
    if (d.t === 'cell') return 'Space On/off  Ctrl+A Whole column';
    if (d.t === 'envalt-env') return 'Ctrl+E In file';
    const keys: string[] = [];
    if (d.f.type === 'boolean') keys.push('Space On/off');
    if (d.f.type === 'select') keys.push('Left/Right Choose');
    if (d.envAlt) keys.push('Ctrl+E From env');
    if (d.list) keys.push('Ctrl+N Add', 'Ctrl+D Remove');
    return keys.join('  ');
  }


  /** The form's lines, each focusable part with its id and what it edits. */
  walk(inner: number, focus?: string): Array<GuidedLine & { ids?: string[]; desc?: Desc }> {
    const out: Array<GuidedLine & { ids?: string[]; desc?: Desc }> = [];
    this.listSpecs = {};
    const badge = this.badge();
    if (badge) for (const t of wrap(badge, inner, '    ')) out.push({ text: t });
    if (this.formLocked) return out;
    const text = (t: string, ind: string) => {
      for (const l of wrap(t, inner, ind)) out.push({ text: l });
    };
    const req = (f: FieldSpec, on = true) => (f.required && on ? ' (required)' : '');

    const scalar = (f: FieldSpec, path: string, ind: string, list?: { listPath: string; index: number }) => {
      const sub = `f:${path}`;
      const label = f.label || '';
      const desc: Desc = { t: 'scalar', f, path, ...(list ? { list } : {}) };
      if (f.type === 'boolean') {
        out.push({ text: `${ind}[${this.cur(path, f.default) ? 'x' : ' '}] ${label}${req(f)}`, ids: [sub], desc });
      } else {
        if (f.envAlt && !list) {
          const mode = this.envMode(f);
          out.push({ text: `${ind}${label}${req(f, mode === 'file')}  (${mode === 'file' ? 'In file' : 'From env'})` });
          if (mode === 'env') {
            out.push({ text: `${ind}  Set ${f.envAlt.var} as an environment variable for this bot.`, ids: [sub], desc: { t: 'envalt-env', f, path } });
            if (f.help) text(f.help, `${ind}  `);
            return;
          }
          (desc as { envAlt?: boolean }).envAlt = true;
        } else if (label) out.push({ text: `${ind}${label}${req(f)}` });
        const cind = `${ind}  `;
        if (f.type === 'select') {
          const cur = this.cur(path, f.default);
          const hit = (f.options || []).find((o) => String(o.value) === String(cur));
          out.push({ text: `${cind}< ${hit ? hit.label || String(hit.value) : String(cur)} >`, ids: [sub], desc });
        } else {
          const draft = this.drafts[sub] ?? field(String(this.cur(path, f.default) ?? ''));
          const shown = showField(draft, Math.max(inner - cind.length, 12), f.type === 'password');
          out.push({ text: `${cind}${shown.text}`, ids: [sub], desc, ...(focus === sub ? { col: cind.length + shown.col } : {}) });
        }
      }
      if (this.chips[path] !== undefined && this.chips[path] !== '') text(`Discord: ${this.chips[path]}`, `${ind}  `);
      if (this.notes[path]) text(this.notes[path], `${ind}  `);
      if (this.skipped.includes(path)) text('This change could not be written to the file.', `${ind}  `);
      if (f.help) text(f.help, `${ind}  `);
    };

    const elementField = (listPath: string, index: number, ef: FieldSpec & { key?: string }, ind: string) => {
      const base = elemPath(listPath, index);
      if (ef.showWhen) {
        const cur = getAt(this.parsed, `${base}.${ef.showWhen.path}`);
        if (ef.showWhen.equals !== undefined && cur !== ef.showWhen.equals) return;
        if (ef.showWhen.notEquals !== undefined && cur === ef.showWhen.notEquals) return;
        if (ef.showWhen.in !== undefined && !ef.showWhen.in.includes(cur)) return;
      }
      const itemPath = ef.key ? `${base}.${ef.key}` : base;
      if (ef.type === 'list') return list(ef, itemPath, ind);
      scalar(ef, itemPath, ind, { listPath, index });
    };

    const list = (f: FieldSpec, listPath: string, ind: string) => {
      this.listSpecs[listPath] = f;
      const arr = getAt(this.parsed, listPath);
      const items = Array.isArray(arr) ? arr : [];
      out.push({ text: `${ind}${f.label || ''}${req(f)}  (${items.length})`, ids: [`l:${listPath}`], desc: { t: 'list', f, listPath } });
      if (f.help) text(f.help, `${ind}  `);
      if (!items.length) out.push({ text: `${ind}  None yet` });
      const el = f.element || {};
      items.forEach((_, i) => {
        if (el.objectFields) {
          const base = elemPath(listPath, i);
          const open = this.isExpanded(f, base);
          const label = el.itemLabel
            ? el.itemLabel.replace(/\{([\w.@]+)\}/g, (_m, k: string) => {
              const v = getAt(this.parsed, `${base}.${k}`);
              return v == null ? '' : String(v);
            })
            : `Item ${i + 1}`;
          out.push({ text: `${ind}  ${open ? 'v' : '>'} ${label}`, ids: [`i:${base}`], desc: { t: 'item', f, listPath, index: i } });
          if (open) for (const of of el.objectFields) elementField(listPath, i, of, `${ind}    `);
        } else {
          elementField(listPath, i, el.field || { type: 'text' }, `${ind}  `);
        }
      });
    };

    const grid = (f: FieldSpec, ind: string) => {
      const base = f.target?.path || '';
      out.push({ text: `${ind}${f.label || ''}` });
      if (f.help) text(f.help, `${ind}  `);
      const cols = f.columns || [];
      const labelWidth = Math.max(...(f.rows || []).map((r) => r.label.length), 8) + 2;
      out.push({ text: `${ind}  ${''.padEnd(labelWidth)}${cols.map((c) => c.label.padEnd(Math.max(c.label.length, 3) + 2)).join('')}` });
      for (const r of f.rows || []) {
        let line = `${ind}  ${r.label.padEnd(labelWidth)}`;
        const ids: string[] = [];
        let col: number | undefined;
        for (const c of cols) {
          const p = `${base}.${r.key}.${c.key}`;
          const id = `c:${p}`;
          if (focus === id) col = line.length + 1;
          ids.push(id);
          line += `[${getAt(this.parsed, p) ? 'x' : ' '}]`.padEnd(Math.max(c.label.length, 3) + 2);
        }
        out.push({ text: line, ids, desc: { t: 'cell', f, base }, ...(col !== undefined ? { col } : {}) });
      }
    };

    const fieldAt = (f: FieldSpec, ind: string) => {
      const path = f.target?.path ?? '';
      if (f.type === 'list') return list(f, path, ind);
      if (f.type === 'grid') return grid(f, ind);
      scalar(f, path, ind);
    };

    const section = (sec: SectionSpec, ind: string) => {
      let on = true;
      if (sec.toggle) {
        const cur = sec.toggle.target ? getAt(this.parsed, sec.toggle.target.path) : undefined;
        on = cur === undefined ? !!sec.toggle.default : !!cur;
        out.push({ text: `${ind}[${on ? 'x' : ' '}] ${sec.title}`, ids: [`t:${sec.id}`], desc: { t: 'toggle', sec } });
      } else out.push({ text: `${ind}${sec.title}` });
      if (sec.help) text(sec.help, `${ind}  `);
      if (!on) return;
      for (const f of sec.fields || []) fieldAt(f, `${ind}  `);
      for (const s of sec.sections || []) section(s, `${ind}  `);
    };

    if (this.manifest.root) fieldAt(this.manifest.root, '    ');
    else for (const sec of this.manifest.sections || []) section(sec, '    ');

    return out;
  }
}
