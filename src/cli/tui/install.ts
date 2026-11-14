import { randomBytes } from 'crypto';
import { Client } from '../client';
import {
  addSource, ConfigFileBody, defaultBotName, EnvHint, fetchSource, installBot, InstallStep, isImageSource, listSources, NameCheck,
  readSourceEnvs, recoverEnvs, Source, SourceEnvs, sourceName, validateName,
} from './api';
import { ConfigFileList } from './configfiles';
import { EditRequest } from './editbody';
import { editField, Field, field, FieldKey, showField } from './field';
import { GuidedBlock } from './guided';
import { VaultPicker } from './vaultpick';

export type InstallScreen = 'sources' | 'addsource' | 'details' | 'detecterror' | 'form' | 'installing';

export interface WizardView {
  body: string[];
  highlight?: number;
  cursor?: { line: number; col: number };
  keys: string;
  notice?: string;
}

export type WizardKey = FieldKey & { shift?: boolean };

/** What a key asks of the frame: quit, leave Install for the bot list with a notice, or hand the terminal to the editor. */
export type WizardExit = { quit: true } | { leave: true; notice?: string; installed?: boolean } | { edit: EditRequest } | undefined;

interface EnvRow {
  id: number;
  hint: EnvHint | null;
  key: Field;
  value: Field;
  /** The page's data-sensitive: a blank value is left out of the save. */
  sensitive: boolean;
  /** Shown as asterisks: the page leaves it out of the form, the route marks it sensitive, or it came from the vault. */
  mask: boolean;
  /** The page's vault button: text and number rows from the route's hints, and the generic token row. */
  vault: boolean;
}

type NameState =
  | { kind: 'idle' }
  | { kind: 'checking'; name: string }
  | { kind: 'answer'; name: string; answer: NameCheck }
  | { kind: 'failed'; name: string; text: string };

type StepState = 'waiting' | 'running' | 'done' | 'skipped';

interface Line {
  text: string;
  focus?: string;
  col?: number;
}

export interface WizardOptions {
  pollMs?: number;
  pollTries?: number;
  secret?: () => string;
  flushMs?: number;
  now?: () => number;
}

const KEY_WIDTH = 26;
const STEP_TEXT: Record<InstallStep, string> = {
  create: 'Create the bot',
  env: 'Save the environment variables',
  config: 'Save the config files',
};

// The page's sanitizeNamePreview, a mirror of the server's sanitizeName.
function namePreview(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '') || 'unnamed';
}

export function wrap(text: string, width: number, indent = ''): string[] {
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

function sameUrl(a: string | undefined, b: string): boolean {
  const norm = (u: string | undefined) => String(u || '').replace(/\/+$/, '').replace(/\.git$/, '').replace(/\/\/([^@]+)@/, '//');
  return norm(a) === norm(b);
}

export function matches(equals: string | string[], value: string): boolean {
  return (Array.isArray(equals) ? equals : String(equals).split(',')).includes(value);
}

/** The install wizard of the web page, screen by screen; the frame shows its view and passes it every key. */
export class InstallWizard {
  screen: InstallScreen = 'sources';
  notice: string | null = null;
  sources: Source[] | null = null;
  sourcesError: string | null = null;
  pick = 0;
  busy: string | null = null;
  addUrl = field();
  addBranch = field('main');
  addFocus: 0 | 1 = 0;
  adding = false;
  source: Source | undefined;
  detectError: string | null = null;
  interactive: { reason?: string; advice?: string } | null = null;
  name = field();
  defaultName = 'My Bot';
  nameState: NameState = { kind: 'idle' };
  reuseText: string | null = null;
  envsLoaded = false;
  loadingEnvs = false;
  rows: EnvRow[] = [];
  imageNote = false;
  readonly cfg: ConfigFileList;
  focus = 'name';
  scanning = false;
  createdBotId: string | null = null;
  lastFailure: string | null = null;
  steps: Record<InstallStep, StepState> = { create: 'waiting', env: 'waiting', config: 'waiting' };
  private seq = 0;
  private nextRow = 0;
  private readonly pollMs: number;
  private readonly pollTries: number;
  private readonly secret: () => string;
  private readonly flushMs: number;
  confirm: { text: string; run: () => Promise<WizardExit> } | null = null;
  private installingSeq: number | null = null;
  readonly picker: VaultPicker;

  constructor(private client: Client, private changed: () => void, opts: WizardOptions = {}) {
    this.picker = new VaultPicker(client, changed, (text) => this.say(text), opts.now);
    this.cfg = new ConfigFileList(client, changed, (text) => this.say(text), 'install', opts.flushMs ?? 10_000);
    this.pollMs = opts.pollMs ?? 2500;
    this.pollTries = opts.pollTries ?? 48;
    this.secret = opts.secret ?? (() => randomBytes(32).toString('hex'));
    this.flushMs = opts.flushMs ?? 10_000;
  }

  open(): void {
    this.screen = 'sources';
    void this.readSources();
  }

  private say(text: string | null): void {
    this.notice = text;
    this.changed();
  }

  async readSources(): Promise<void> {
    try {
      this.sources = await listSources(this.client);
      this.sourcesError = null;
    } catch (err) {
      this.sourcesError = err instanceof Error ? err.message : String(err);
    }
    this.pick = Math.min(this.pick, Math.max((this.sources?.length ?? 1) - 1, 0));
    this.changed();
  }

  private picked(): Source | undefined {
    return this.sourcesError ? undefined : this.sources?.[this.pick];
  }

  // cloneAndInstallSource: a source that is not cloned is fetched (cloned) first.
  private async installFrom(source: Source): Promise<void> {
    if (isImageSource(source) || source.isCloned) {
      void this.openSource(source);
      return;
    }
    const name = sourceName(source);
    this.busy = `Cloning ${name}.`;
    this.say(null);
    const r = await fetchSource(this.client, source.id);
    this.busy = null;
    if (r.ok === true) {
      await this.readSources();
      if (this.screen === 'sources') void this.openSource(this.sources?.find((s) => s.id === source.id) ?? source);
      return;
    }
    await this.readSources();
    this.say(r.ok === false ? `Could not clone ${name}: ${r.text}` : `No answer from the manager; the clone of ${name} may still be running (${r.text}). Check its state before trying again.`);
  }

  // fetchSource on the page.
  private async fetch(source: Source): Promise<void> {
    const name = sourceName(source);
    this.busy = `Fetching ${name}.`;
    this.say(null);
    const r = await fetchSource(this.client, source.id);
    this.busy = null;
    await this.readSources();
    if (r.ok === true) this.say(r.value.copyError ? r.value.copyError : r.value.hasUpdates ? `${name}: source updated with new commits.` : `${name}: source is up to date.`);
    else if (r.ok === false) this.say(`Could not fetch ${name}: ${r.text}`);
    else this.say(`No answer from the manager; the fetch of ${name} may still be running (${r.text}). Check its state before trying again.`);
  }

  // addSource on the page; after a lost answer it watches the list for the URL, as waitForSourceUrl does.
  private async add(): Promise<void> {
    const url = this.addUrl.text.trim();
    const branch = this.addBranch.text.trim();
    if (!url) {
      this.say('URL is required.');
      return;
    }
    this.adding = true;
    this.say(null);
    const r = await addSource(this.client, url, branch);
    if (r.ok === true) {
      this.adding = false;
      if (this.screen === 'addsource') this.screen = 'sources';
      await this.readSources();
      this.say('Source added.');
      return;
    }
    if (r.ok === false) {
      this.adding = false;
      this.say(`Could not add the source: ${r.text}`);
      return;
    }
    this.say(`No answer from the manager (${r.text}); the source add may still be running. Watching the source list for it.`);
    for (let i = 0; i < this.pollTries; i++) {
      await this.readSources();
      if (this.sources?.some((s) => sameUrl(s.url, url))) {
        this.adding = false;
        if (this.screen === 'addsource') this.screen = 'sources';
        this.say('Source added.');
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, this.pollMs));
    }
    this.adding = false;
    this.say(`can't confirm the source was added: the manager did not answer (${r.text}), and the source is not in the list. Check the list before adding it again.`);
  }

  // showInstallModal: read the source's details, then the form or the detect error.
  async openSource(source: Source): Promise<void> {
    const seq = ++this.seq;
    this.source = source;
    this.screen = 'details';
    this.detectError = null;
    this.interactive = null;
    this.createdBotId = null;
    this.lastFailure = null;
    this.envsLoaded = false;
    this.reuseText = null;
    this.nameState = { kind: 'idle' };
    this.defaultName = defaultBotName(source);
    this.say(null);
    const r = await readSourceEnvs(this.client, source.id);
    if (seq !== this.seq) return;
    let envs: SourceEnvs = {};
    if (r.ok === null) this.detectError = `the source could not be reached (${r.text})`;
    else if (r.ok === false) this.detectError = r.text;
    else if (r.value.success !== true) this.detectError = r.value.error || 'the source could not be read';
    else envs = r.value;
    this.buildForm(envs);
    this.screen = this.detectError ? 'detecterror' : 'form';
    this.changed();
    if (!this.detectError) void this.checkName();
  }

  // renderInstallModal: the name, the env rows from the hints, the config templates.
  private buildForm(envs: SourceEnvs): void {
    const hints = Array.isArray(envs.vars) ? envs.vars : [];
    this.interactive = envs.interactiveSetup || null;
    this.name = field(this.defaultName);
    this.rows = [];
    this.imageNote = false;
    if (hints.length > 0) for (const h of hints) this.rows.push(this.hintRow(h));
    else if (isImageSource(this.source)) this.imageNote = true;
    else this.rows.push(this.plainRow('DISCORD_TOKEN', '', { key: 'DISCORD_TOKEN', label: 'Discord Bot Token', required: true }, true, true));
    for (const row of this.rows) {
      if (row.hint?.generate && !row.value.text.trim()) row.value = field(this.secret());
    }
    // The page builds the wizard's cards with no saved mode, on, and the repo's mode when the route knows it.
    this.cfg.set((Array.isArray(envs.configFiles) ? envs.configFiles : []).map((cf) => ({
      path: cf.inContainerPath, body: cf.rawBody || '', enabled: true, manifest: cf.manifest, format: cf.format, parsed: cf.parsed,
      ...(cf.repoReadOnly !== undefined ? { repoReadOnly: cf.repoReadOnly } : {}),
    })));
    this.focus = 'name';
  }

  private hintRow(h: EnvHint): EnvRow {
    const current = h.defaultValue || '';
    let value = h.sensitive ? '' : current;
    if (h.options && h.options.length) {
      const norm = value.trim().toLowerCase();
      const hit = h.options.find((o) => String(o.value) === value) || h.options.find((o) => String(o.value).trim().toLowerCase() === norm);
      value = hit ? String(hit.value) : value !== '' ? value : String(h.options[0].value);
    }
    const vault = !(h.options && h.options.length) && !h.list && !h.autoWired && !h.inactive;
    return { id: this.nextRow++, hint: h, key: field(h.key), value: field(value), sensitive: !!h.sensitive, mask: !!h.sensitive, vault };
  }

  private plainRow(key: string, value: string, hint: EnvHint | null = null, mask = false, vault = false): EnvRow {
    return { id: this.nextRow++, hint, key: field(key), value: field(value), sensitive: false, mask, vault };
  }

  // toggleEnvVaultDropdown with the key the row was built with; the pick goes in as setEnvInputValue puts it.
  private pickInto(row: EnvRow): void {
    const key = row.hint?.key ?? row.key.text.trim();
    void this.picker.open(key, (value) => {
      if (!this.rows.includes(row)) return;
      row.value = field(value);
      row.mask = true;
      this.changed();
    });
  }

  private rowValue(key: string): string {
    const row = this.rows.find((r) => r.key.text.trim() === key);
    return row ? row.value.text.trim() : '';
  }

  private shown(row: EnvRow): boolean {
    const when = row.hint?.showWhen;
    return !when || matches(when.equals, this.rowValue(when.key));
  }

  private editable(row: EnvRow): boolean {
    return !row.hint?.autoWired && !row.hint?.inactive;
  }

  private focusables(): string[] {
    const out = ['name'];
    for (const row of this.rows) if (this.editable(row) && this.shown(row)) out.push(`k${row.id}`, `v${row.id}`);
    out.push(...this.cfg.focusables(), 'addcf', 'install');
    return out;
  }

  private moveFocus(step: number): void {
    const list = this.focusables();
    const at = Math.max(list.indexOf(this.focus), 0);
    const next = list[Math.min(Math.max(at + step, 0), list.length - 1)];
    const leaving = this.focus === 'name' && next !== 'name';
    if (next !== this.focus) this.leaveGuided();
    this.focus = next;
    if (leaving) void this.checkName();
    this.changed();
  }

  private leaveGuided(): void {
    this.cfg.leave(this.focus);
  }

  private focusedRow(): EnvRow | undefined {
    const m = /^[kv](\d+)$/.exec(this.focus);
    return m ? this.rows.find((r) => r.id === Number(m[1])) : undefined;
  }

  // onNameInput: the live check, run when the cursor leaves the name field.
  async checkName(): Promise<void> {
    const name = this.name.text.trim();
    if ((this.nameState.kind === 'checking' || this.nameState.kind === 'answer') && this.nameState.name === name) return;
    this.envsLoaded = false;
    if (!name) {
      this.nameState = { kind: 'idle' };
      this.reuseText = null;
      this.changed();
      return;
    }
    this.nameState = { kind: 'checking', name };
    this.changed();
    const r = await validateName(this.client, name, this.source?.id);
    if (this.name.text.trim() !== name || this.nameState.kind !== 'checking' || this.nameState.name !== name) return;
    if (r.ok === null) this.nameState = { kind: 'failed', name, text: `can't check the name: the manager did not answer (${r.text}).` };
    else if (r.ok === false) this.nameState = { kind: 'failed', name, text: `can't check the name: ${r.text}` };
    else if (r.value.valid !== true && !Array.isArray(r.value.errors)) this.nameState = { kind: 'failed', name, text: `can't check the name: ${r.value.error || 'the answer held no verdict'}` };
    else this.nameState = { kind: 'answer', name, answer: r.value };
    const answer = this.nameState.kind === 'answer' ? this.nameState.answer : null;
    if (answer && answer.valid === true) {
      this.reuseText = answer.reuseAvailable || answer.envsAvailable === true || answer.envsAvailable === 'unknown' ? reuseDetail(answer) : null;
      this.setConfigReuse(!!answer.reuseAvailable);
    } else {
      this.reuseText = null;
      if (answer) this.setConfigReuse(false);
    }
    this.changed();
  }

  // setInstallConfigReuse: over a kept data folder the template files start off.
  private setConfigReuse(reuse: boolean): void {
    for (const cf of this.cfg.files) {
      if (reuse && cf.enabled && !cf.reuseOff) {
        cf.enabled = false;
        cf.reuseOff = true;
      } else if (!reuse && cf.reuseOff) {
        cf.reuseOff = false;
        cf.enabled = true;
      }
    }
  }

  private reuseOn(): boolean {
    return this.nameState.kind === 'answer' && this.nameState.answer.valid === true && !!this.nameState.answer.reuseAvailable;
  }

  private envsOffered(): boolean {
    return this.nameState.kind === 'answer' && this.nameState.answer.valid === true && this.nameState.answer.envsAvailable === true && !this.envsLoaded;
  }

  // loadPreviousEnvs on the page.
  private async loadEnvs(): Promise<void> {
    const name = this.name.text.trim();
    if (!name || this.loadingEnvs) return;
    const seq = this.seq;
    this.loadingEnvs = true;
    this.reuseText = 'Loading the envs of the earlier install.';
    this.changed();
    const r = await recoverEnvs(this.client, name, this.source?.id);
    this.loadingEnvs = false;
    if (seq !== this.seq) return;
    if (r.ok !== true) {
      this.reuseText = r.ok === null ? `can't confirm the earlier envs: the manager did not answer (${r.text}).` : `Failed to load previous envs: ${r.text}`;
      this.changed();
      return;
    }
    const res = r.value;
    if (res.success !== true) {
      this.reuseText = res.error || 'Failed to load previous envs';
      this.changed();
      return;
    }
    const envs = Array.isArray(res.envs) ? res.envs : [];
    if (envs.length === 0) {
      this.reuseText = res.vaultBroken
        ? 'vault.json cannot be read, so envs kept from a removed bot could not be checked. Repair vault.json and try again.'
        : 'No recoverable envs found for this name.';
      if (!res.vaultBroken) this.envsLoaded = true;
      this.changed();
      return;
    }
    const applied = { vault: 0, compose: 0 };
    const count = (key: string) => {
      const env = envs.find((e) => e.key === key);
      if (env && (env.source === 'vault' || env.source === 'compose')) applied[env.source]++;
    };
    const seen = new Set<string>();
    const autoKept: string[] = [];
    for (const row of this.rows) {
      if (row.hint?.inactive) continue;
      const key = row.key.text.trim();
      const env = envs.find((e) => e.key === key);
      if (!key || !env) continue;
      seen.add(key);
      if (row.hint?.autoWired) {
        autoKept.push(key);
        continue;
      }
      row.value = field(env.value);
      if (env.sensitive) row.mask = true;
      count(key);
    }
    for (const env of envs) {
      if (seen.has(env.key)) continue;
      this.rows.push(this.plainRow(env.key, env.value, null, !!env.sensitive));
      count(env.key);
    }
    const parts = [...(applied.vault ? [`${applied.vault} from vault`] : []), ...(applied.compose ? [`${applied.compose} from compose`] : [])];
    this.reuseText = `Loaded ${applied.vault + applied.compose} env(s) into the form${parts.length ? ` (${parts.join(', ')})` : ''}. Review before saving.`
      + (autoKept.length ? ` Not loaded, set automatically by the manager: ${autoKept.join(', ')}.` : '')
      + (res.vaultBroken ? ' vault.json cannot be read, so envs kept from a removed bot were not checked.' : '');
    this.envsLoaded = true;
    this.changed();
  }

  // scanInstallEnvs and inspectInstallImage: new keys from the route join the form as plain rows.
  private async scan(): Promise<void> {
    if (!this.source || this.scanning) return;
    const image = isImageSource(this.source);
    const failText = image ? 'Image inspect failed' : 'Scan failed';
    const seq = this.seq;
    this.scanning = true;
    this.say(image ? 'Inspecting the image; a missing image is pulled first.' : 'Scanning the source code for variables.');
    const r = await readSourceEnvs(this.client, this.source.id, image ? 'inspect' : 'scan');
    this.scanning = false;
    if (seq !== this.seq) return;
    if (r.ok !== true) {
      this.say(r.ok === null ? `${failText}: the manager did not answer (${r.text}).` : `${failText}: ${r.text}`);
      return;
    }
    const res = r.value;
    if (res.success !== true || !Array.isArray(res.vars)) {
      this.say(res.error ? `${failText}: ${res.error}` : failText);
      return;
    }
    const existing = new Set(this.rows.map((row) => row.key.text.trim()).filter(Boolean));
    let added = 0;
    for (const v of res.vars) {
      if (v.autoWired || existing.has(v.key)) continue;
      this.rows.push(this.plainRow(v.key, v.defaultValue || '', null, !!v.sensitive));
      existing.add(v.key);
      added++;
    }
    if (added > 0) this.imageNote = false;
    if (image) {
      if (res.pullError) return this.say(`Image pull failed: ${res.pullError}`);
      if (!res.imageReady) return this.say('The image is not present locally, so its variables could not be read.');
      if (res.inspectError) return this.say(`Image inspect failed: ${res.inspectError}`);
      return this.say(added > 0 ? `Found ${added} variable(s) from the image.` : 'No new variables found in the image.');
    }
    const found = added > 0 ? `Found ${added} additional variable(s)` : 'No new variables found';
    const sc = res.sourceScan;
    this.say(sc && sc.scanned < sc.total
      ? `${found}. Scanned ${sc.scanned} of ${sc.total} source files; variables used only in the rest were not checked.`
      : `${found}.`);
  }

  // doInstall: the page's checks, then its calls in order. One install per opened form; Esc during its wait closes the form.
  private async install(): Promise<WizardExit> {
    if (this.installingHere()) return undefined;
    const seq = this.seq;
    this.installingSeq = seq;
    try {
      return await this.checkAndSend(seq);
    } finally {
      if (this.installingSeq === seq) this.installingSeq = null;
    }
  }

  private installingHere(): boolean {
    return this.installingSeq !== null && this.installingSeq === this.seq;
  }

  private async checkAndSend(seq: number): Promise<WizardExit> {
    const name = this.name.text.trim();
    if (!name) {
      this.say('Name is required.');
      return undefined;
    }
    const vars: Record<string, string> = {};
    const badNumbers: string[] = [];
    const outOfBounds: string[] = [];
    for (const row of this.rows) {
      if (!this.editable(row)) continue;
      const key = row.key.text.trim();
      if (!key) continue;
      const h = row.hint;
      const raw = row.value.text.trim();
      if (h?.inputType === 'number') {
        if (raw !== '' && !Number.isFinite(Number(raw))) {
          badNumbers.push(key);
          continue;
        }
        const bounded = (h.min !== undefined && h.min !== null) || (h.max !== undefined && h.max !== null);
        if (bounded && this.shown(row) && raw !== '') {
          const n = Number(raw);
          const bad = (h.step === 1 && !/^[0-9]+$/.test(raw)) || (h.min != null && n < h.min) || (h.max != null && n > h.max);
          if (bad) {
            outOfBounds.push(`${h.label || h.displayLabel || key} takes a whole number from ${h.min}${h.max != null ? ` to ${h.max}` : ''}.`);
            continue;
          }
        }
      }
      if (row.sensitive && raw === '') continue;
      vars[key] = raw;
    }
    if (badNumbers.length) {
      this.say(`Not a number: ${badNumbers.join(', ')}. Fix the value, then create. Nothing was created.`);
      return undefined;
    }
    if (outOfBounds.length) {
      this.say(`${outOfBounds.join(' ')} Nothing was created.`);
      return undefined;
    }
    // guidedReadyToSave: every form change must be in its file, and a value the save would clear is confirmed first.
    const blocks = this.cfg.blocks();
    for (const b of blocks) for (const sub of Object.keys(b.drafts)) b.leave(sub);
    let ready = true;
    for (const b of blocks) if (!(await b.flushForSave(this.flushMs))) ready = false;
    if (!ready) {
      if (seq === this.seq || this.screen === 'sources') this.say('A form change could not be written into its file (see the warning on the file). Nothing was saved.');
      return undefined;
    }
    if (seq !== this.seq) {
      // Another form may be open by now; the text belongs only on the Sources screen the Esc went to.
      if (this.screen === 'sources') this.say('The install form was closed before installing. Nothing was created.');
      return undefined;
    }
    const erasing = blocks.flatMap((b) => b.erasures());
    if (erasing.length) {
      this.confirm = {
        text: `Saving clears the value stored in the file for: ${erasing.map((e) => `${e.label} (now read from ${e.envVar})`).join(', ')}. Continue?`,
        run: () => this.send(name, vars),
      };
      this.say(null);
      return undefined;
    }
    return this.send(name, vars);
  }

  private async send(name: string, vars: Record<string, string>): Promise<WizardExit> {
    const configFiles: ConfigFileBody[] = this.cfg.collect();
    const source = this.source!;
    this.screen = 'installing';
    this.steps = { create: 'waiting', env: 'waiting', config: 'waiting' };
    this.say(null);
    const result = await installBot(this.client, { sourceId: source.id, name, vars, configFiles }, this.createdBotId, (step, state) => {
      this.steps[step] = state;
      this.changed();
    });
    if (result.botId) this.createdBotId = result.botId;
    if (result.ok === true) return { leave: true, notice: result.text, installed: true };
    this.lastFailure = result.text;
    this.screen = 'form';
    this.say(result.botId ? `${result.text} Move to Install and press Enter to retry.` : result.text);
    return undefined;
  }

  /** One key from the frame; `forwardDelete` is true when the raw input was the Delete key. */
  key(input: string, key: WizardKey, forwardDelete = false): WizardExit | Promise<WizardExit> {
    const k = input.toLowerCase();
    switch (this.screen) {
      case 'sources': {
        if (key.escape) return { leave: true };
        if (k === 'q' && !key.ctrl) return { quit: true };
        if (this.busy) return undefined;
        const list = this.sourcesError ? [] : this.sources ?? [];
        if (k === 'a') {
          this.screen = 'addsource';
          this.addUrl = field();
          this.addBranch = field('main');
          this.addFocus = 0;
          this.say(null);
          return undefined;
        }
        if (k === 'r') {
          void this.readSources();
          return undefined;
        }
        if (list.length === 0) return undefined;
        if (key.upArrow) this.pick = (this.pick + list.length - 1) % list.length;
        else if (key.downArrow) this.pick = (this.pick + 1) % list.length;
        else if (key.return) void this.installFrom(list[this.pick]);
        else if (k === 'f' && !isImageSource(list[this.pick])) void this.fetch(list[this.pick]);
        this.changed();
        return undefined;
      }
      case 'addsource': {
        if (key.escape) {
          this.screen = 'sources';
          this.say(this.adding ? this.notice : null);
          return undefined;
        }
        if (this.adding) return undefined;
        if (key.tab || key.upArrow || key.downArrow) this.addFocus = this.addFocus === 0 ? 1 : 0;
        else if (key.return) void this.add();
        else {
          const f = this.addFocus === 0 ? this.addUrl : this.addBranch;
          const next = editField(f, input, key, forwardDelete);
          if (next && this.addFocus === 0) this.addUrl = next;
          else if (next) this.addBranch = next;
        }
        this.changed();
        return undefined;
      }
      case 'details':
        if (key.escape) {
          this.seq++;
          this.screen = 'sources';
          this.say(null);
        }
        return undefined;
      case 'detecterror':
        if (key.escape) {
          this.screen = 'sources';
          this.say(null);
        } else if (k === 'r' && this.source) void this.openSource(this.source);
        else if (k === 'c') {
          this.detectError = null;
          this.screen = 'form';
          this.say(null);
          void this.checkName();
        }
        return undefined;
      case 'installing':
        return undefined;
      case 'form':
        return this.formKey(input, key, forwardDelete);
    }
  }

  private formKey(input: string, key: WizardKey, forwardDelete: boolean): WizardExit | Promise<WizardExit> {
    if (this.cfg.waiting) return undefined;
    if (this.picker.active) {
      this.picker.key(key);
      return undefined;
    }
    if (this.confirm) {
      const run = this.confirm.run;
      this.confirm = null;
      if (input.toLowerCase() === 'y' && !key.ctrl) return run();
      this.say('Cancelled: nothing was created.');
      return undefined;
    }
    if (this.installingHere() && !key.escape) return undefined;
    if (key.escape) {
      this.seq++;
      this.screen = 'sources';
      const left = this.createdBotId && this.lastFailure ? this.lastFailure : null;
      this.say(left);
      return undefined;
    }
    if (key.tab) {
      this.moveFocus(key.shift ? -1 : 1);
      return undefined;
    }
    if (key.upArrow || key.downArrow) {
      this.moveFocus(key.upArrow ? -1 : 1);
      return undefined;
    }
    const c = key.ctrl ? input.toLowerCase() : '';
    if (this.cfg.guidedFocus(this.focus)) {
      const before = this.focusables();
      const out = this.cfg.key(this.focus, input, key, forwardDelete);
      if (out && 'done' in out) {
        const after = this.focusables();
        if (!after.includes(this.focus)) {
          const at = before.indexOf(this.focus);
          const prev = before[at - 1];
          this.focus = prev && after.includes(prev) ? prev : after[Math.min(Math.max(at, 0), after.length - 1)];
          this.changed();
        }
        return undefined;
      }
      if (key.return) this.moveFocus(1);
      else if (c === 'f') void this.scan();
      return undefined;
    }
    if (this.focus === 'addcf') {
      if (key.return) {
        this.focus = this.cfg.add();
        this.changed();
      }
      return undefined;
    }
    if (this.cfg.owns(this.focus) && c === 'd') {
      const list = this.focusables();
      const at = list.indexOf(this.focus);
      this.cfg.remove(this.focus);
      const after = this.focusables();
      const prev = list.slice(0, Math.max(at, 0)).reverse().find((f) => after.includes(f) && !/^[pwbg]/.test(f));
      this.focus = prev ?? after[0];
      this.changed();
      return undefined;
    }
    if (this.cfg.owns(this.focus) && !c) {
      const out = this.cfg.key(this.focus, input, key, forwardDelete);
      if (out && 'next' in out) this.moveFocus(1);
      else if (out && 'edit' in out) return out.edit.then((edit) => (edit ? { edit } : undefined));
      return undefined;
    }
    const row = this.focusedRow();
    if (c === 'n') {
      const added = this.plainRow('', '');
      this.rows.push(added);
      this.imageNote = false;
      this.focus = `k${added.id}`;
      this.changed();
      return undefined;
    }
    if (c === 'f') {
      void this.scan();
      return undefined;
    }
    if (c === 'd') {
      if (row) {
        const list = this.focusables();
        const at = list.indexOf(this.focus);
        this.rows = this.rows.filter((r) => r !== row);
        const after = this.focusables();
        this.focus = after[Math.min(Math.max(at - 1, 0), after.length - 1)];
      }
      this.changed();
      return undefined;
    }
    if (c === 'p' && row?.vault && this.focus.startsWith('v')) {
      this.pickInto(row);
      return undefined;
    }
    if (c === 'g' && row?.hint?.generate) {
      row.value = field(this.secret());
      this.changed();
      return undefined;
    }
    if (this.focus === 'name' && c === 'r') {
      this.name = field(this.defaultName);
      void this.checkName();
      this.changed();
      return undefined;
    }
    if (this.focus === 'name' && c === 'l' && this.envsOffered()) {
      void this.loadEnvs();
      return undefined;
    }
    if (this.focus === 'install') {
      if (key.return) return this.install();
      return undefined;
    }
    if (key.return) {
      this.moveFocus(1);
      return undefined;
    }
    if (this.focus === 'name') {
      const next = editField(this.name, input, key, forwardDelete);
      if (next) this.name = next;
      this.changed();
      return undefined;
    }
    if (!row) return undefined;
    const options = row.hint?.options;
    if (this.focus.startsWith('v') && options && options.length) {
      if (key.leftArrow || key.rightArrow) {
        const at = options.findIndex((o) => String(o.value) === row.value.text);
        const next = at < 0 ? 0 : (at + (key.rightArrow ? 1 : options.length - 1)) % options.length;
        row.value = field(String(options[next].value));
        this.changed();
      }
      return undefined;
    }
    const target = this.focus.startsWith('k') ? row.key : row.value;
    const next = editField(target, input, key, forwardDelete);
    if (next && this.focus.startsWith('k')) row.key = next;
    else if (next) row.value = next;
    this.changed();
    return undefined;
  }

  /** The screen; a notice longer than the notice line is wrapped onto the last body lines instead of being cut. */
  view(inner: number, room: number): WizardView {
    const long = this.notice !== null && this.notice.length > inner ? wrap(this.notice, inner) : null;
    if (!long) return this.screenView(inner, room, this.notice ?? undefined);
    const space = Math.max(room - long.length - 1, 3);
    const v = this.screenView(inner, space, undefined);
    const body = v.body.slice(0, space);
    while (body.length < space) body.push('');
    return { ...v, body: [...body, '', ...long] };
  }

  private screenView(inner: number, room: number, notice: string | undefined): WizardView {
    switch (this.screen) {
      case 'sources':
        return this.sourcesView(inner, room, notice);
      case 'addsource': {
        const w = Math.max(inner - 13, 12);
        const url = showField(this.addUrl, w);
        const branch = showField(this.addBranch, w);
        const body = ['Add a source', '', `URL          ${url.text}`, `Branch       ${branch.text}`];
        if (this.adding) body.push('', 'Adding the source; the manager clones it before it answers.');
        return {
          body,
          ...(this.adding ? {} : { cursor: { line: this.addFocus === 0 ? 2 : 3, col: 13 + (this.addFocus === 0 ? url.col : branch.col) } }),
          keys: this.adding ? 'Esc Back' : 'Enter Add  Tab Next field  Esc Back',
          notice,
        };
      }
      case 'details':
        return { body: [`Reading the details of ${this.source ? sourceName(this.source) : 'the source'}.`], keys: 'Esc Back', notice };
      case 'detecterror':
        return {
          body: [
            `Install from Source: ${this.source ? sourceName(this.source) : ''}`,
            '',
            ...wrap(`Could not read this source's variables and config files: ${this.detectError}. Nothing below was detected.`, inner),
          ],
          keys: 'R Retry  C Continue manually  Esc Back',
          notice,
        };
      case 'installing':
        return {
          body: [
            `Installing ${this.name.text.trim()} from ${this.source ? sourceName(this.source) : ''}`,
            '',
            ...(['create', 'env', 'config'] as InstallStep[]).map((s) => `${STEP_TEXT[s].padEnd(34)}${this.stepText(s)}`),
          ],
          keys: 'Waiting for the manager',
          notice,
        };
      case 'form':
        if (this.picker.active) return { ...this.picker.view(inner, room), notice };
        if (this.cfg.waiting) return { ...this.formView(inner, room, undefined), keys: 'Waiting for the manager', notice: this.cfg.waiting };
        return this.formView(inner, room, notice);
    }
  }

  private stepText(step: InstallStep): string {
    const st = this.steps[step];
    if (st === 'running') return 'running';
    if (st === 'done') return 'done';
    if (st === 'skipped') return step === 'create' ? 'created before' : 'nothing to save';
    return '';
  }

  private sourcesView(inner: number, room: number, notice: string | undefined): WizardView {
    const keys = 'Enter Install  A Add  F Fetch  R Reread  Esc Back  Q Quit';
    if (this.sourcesError) return { body: [`can't read the sources: ${this.sourcesError}`], keys: 'A Add  R Reread  Esc Back  Q Quit', notice };
    if (!this.sources) return { body: ['Reading the sources.'], keys: 'Esc Back  Q Quit', notice };
    if (this.sources.length === 0) return { body: ['No sources yet. Press A to add a git repository.'], keys: 'A Add  R Reread  Esc Back  Q Quit', notice };
    const rows = this.sources.map((s, i) => {
      const what = isImageSource(s)
        ? `image ${s.imageRef ?? ''}`
        : `${s.branch ?? ''}${s.isCloned ? '' : s.cloneError ? `, clone failed: ${s.cloneError}` : ', not cloned'}`;
      return `${i === this.pick ? '>' : ' '} ${sourceName(s).padEnd(28)} ${what}`.slice(0, inner);
    });
    const space = room - 3;
    const first = Math.max(0, Math.min(this.pick - space + 1, rows.length - space));
    const shown = rows.slice(first, first + space);
    return {
      body: ['Sources', '', ...shown, ...(this.busy ? ['', this.busy] : [])],
      highlight: this.pick - first + 2,
      keys: this.busy ? 'Esc Back  Q Quit' : keys,
      notice,
    };
  }

  private nameLines(inner: number): string[] {
    const name = this.name.text.trim();
    const pad = ' '.repeat(13);
    if (!name) return [];
    const st = this.nameState;
    if (st.kind === 'answer' && st.name === name) {
      const a = st.answer;
      if (a.valid !== true) return wrap((a.errors ?? []).join(', '), inner, pad);
      const why = Array.isArray(a.conflicts) && a.conflicts.length ? `: ${a.conflicts.join('; ')}` : '';
      const note = a.adjusted ? ` (saved as "${a.displayName}"${why})` : '';
      return [
        ...wrap(`Compose name: ${a.sanitizedName}${note}`, inner, pad),
        ...(this.reuseText ? wrap(this.reuseText, inner, pad) : []),
        ...(this.envsOffered() ? [`${pad}Ctrl+L loads them.`] : []),
      ];
    }
    const lines = [`${pad}Compose name: ${namePreview(name)}`];
    if (st.kind === 'checking' && st.name === name) lines.push(`${pad}Checking the name.`);
    if (st.kind === 'failed' && st.name === name) lines.push(...wrap(st.text, inner, pad));
    return lines;
  }

  private rowLines(row: EnvRow, inner: number): Line[] {
    const h = row.hint;
    const lines: Line[] = [];
    const label = h ? h.label || h.displayLabel || '' : '';
    const required = !!h?.required || (!!h?.requiredWhen && matches(h.requiredWhen.equals, this.rowValue(h.requiredWhen.key)));
    if (label) lines.push({ text: `  ${label}${required ? ' (required)' : ''}` });
    const keyText = row.key.text;
    if (h?.autoWired) {
      lines.push({ text: `  ${keyText.padEnd(KEY_WIDTH)} Auto-configured` });
      return lines;
    }
    if (h?.inactive) {
      lines.push({ text: `  ${keyText.padEnd(KEY_WIDTH)} not used` }, ...wrap(h.inactive, inner, '    ').map((text) => ({ text })));
      return lines;
    }
    const keyField = showField(row.key, KEY_WIDTH);
    const valueWidth = Math.max(inner - KEY_WIDTH - 3, 12);
    const options = h?.options;
    let valueText: string;
    let valueCol: number | undefined;
    if (options && options.length) {
      const hit = options.find((o) => String(o.value) === row.value.text);
      valueText = `< ${hit ? hit.label || hit.value : `${row.value.text} (current)`} >`;
    } else {
      const v = showField(row.value, valueWidth, row.mask);
      valueText = v.text;
      valueCol = v.col;
    }
    const text = `  ${keyField.text} ${valueText}`;
    const kf = `k${row.id}`;
    const vf = `v${row.id}`;
    if (this.focus === kf) lines.push({ text, focus: kf, col: 2 + keyField.col });
    else if (this.focus === vf) lines.push({ text, focus: vf, col: valueCol === undefined ? undefined : 3 + KEY_WIDTH + valueCol });
    else lines.push({ text, focus: `${kf}|${vf}` });
    if (h?.description) lines.push(...wrap(h.description, inner, '    ').map((t) => ({ text: t })));
    if (h?.generate) lines.push({ text: '    Ctrl+G generates a new random secret.' });
    return lines;
  }

  private formView(inner: number, room: number, notice: string | undefined): WizardView {
    if (this.confirm) return { body: wrap(this.confirm.text, inner), keys: 'Y Continue  any other key Cancel', notice };
    const all: Line[] = [];
    const push = (text: string, extra: Partial<Line> = {}) => all.push({ text, ...extra });
    push(`Install from Source: ${this.source ? sourceName(this.source) : ''}`);
    if (this.interactive) for (const t of wrap(`Heads up: ${this.interactive.reason ?? ''} ${this.interactive.advice ?? ''}`.trim(), inner)) push(t);
    push('');
    const nameField = showField(this.name, Math.max(inner - 13, 12));
    push(`Name         ${nameField.text}`, { focus: 'name', col: 13 + nameField.col });
    for (const t of this.nameLines(inner)) push(t);
    push('');
    push('Environment variables');
    if (this.imageNote) for (const t of wrap('Prebuilt image: add the environment variables it needs (see its docs), or press Ctrl+F to inspect the image for them.', inner, '  ')) push(t);
    let group: string | undefined;
    for (const row of this.rows) {
      if (!this.shown(row)) continue;
      const g = row.hint?.group;
      if (g && g !== group) {
        push(`  ${g}`);
        const help = this.rows.find((r) => r.hint?.group === g && r.hint.groupHelp)?.hint?.groupHelp;
        if (help) for (const t of wrap(help, inner, '  ')) push(t);
      }
      group = g;
      all.push(...this.rowLines(row, inner));
    }
    if (this.rows.length === 0 && !this.imageNote) push('  No variables. Ctrl+N adds one.');
    push('');
    push('Config files');
    for (const t of wrap('Config files this bot reads, prefilled from its template. Tweak them here before installing; each is delivered into the container and persists across updates.', inner, '  ')) push(t);
    if (this.reuseOn() && this.cfg.files.length) {
      for (const t of wrap('A data folder kept under this name may hold edited copies of these files, so they start off and the kept copies stay. Turn a file on only after moving its kept copy away: a build keeps a file it did not deliver and stops, naming it.', inner, '  ')) push(t);
    }
    if (this.cfg.files.length === 0) push('  None.');
    all.push(...this.cfg.lines(inner, this.focus));
    push('  Add config file', { focus: 'addcf' });
    push('');
    push('  Install', { focus: 'install' });

    const at = Math.max(all.findIndex((l) => l.focus === this.focus || (l.focus?.split('|').includes(this.focus) ?? false)), 0);
    const first = Math.max(0, Math.min(at - Math.floor(room / 2), all.length - room));
    const shown = all.slice(first, first + room);
    const focused = all[at];
    const line = at - first;
    const isText = focused.col !== undefined;
    return {
      body: shown.map((l) => l.text),
      ...(isText ? { cursor: { line, col: focused.col! } } : { highlight: line }),
      keys: this.formKeys(),
      notice,
    };
  }

  private formKeys(): string {
    const row = this.focusedRow();
    const scan = isImageSource(this.source) ? 'Ctrl+F Inspect' : 'Ctrl+F Scan';
    if (this.focus === 'name') return ['Tab Next', 'Ctrl+R Default name', ...(this.envsOffered() ? ['Ctrl+L Load envs'] : []), 'Esc Back'].join('  ');
    if (this.focus === 'install') return 'Enter Install  Up Previous  Esc Back';
    if (this.focus === 'addcf') return 'Enter Add config file  Tab Next  Esc Back';
    if (this.cfg.owns(this.focus)) return [this.cfg.keys(this.focus), 'Tab Next', 'Esc Back'].filter(Boolean).join('  ');
    const choose = this.focus.startsWith('v') && row?.hint?.options?.length ? ['Left/Right Choose'] : [];
    // Ctrl+G is named on the line under a generate row, so the bar keeps to 75 columns with the vault key.
    const vault = this.focus.startsWith('v') && row?.vault ? ['Ctrl+P Vault'] : [];
    return [...choose, 'Tab Next', ...vault, 'Ctrl+N Add', 'Ctrl+D Remove', scan, 'Esc Back'].join('  ');
  }
}

// reuseDetailText on the page.
function reuseDetail(res: NameCheck): string {
  const parts: string[] = [];
  if (res.reuseAvailable) {
    parts.push(res.keptSource
      ? `A data folder kept from an earlier install of ${res.keptSource} exists under this name; this install will use it.`
      : 'A data folder from an earlier install exists under this name; this install will use it.');
  }
  if (res.envsAvailable === true) parts.push('Envs from an earlier install are available.');
  else if (res.envsAvailable === 'unknown') parts.push('vault.json cannot be read, so envs kept from a removed bot could not be checked.');
  return parts.join(' ');
}
