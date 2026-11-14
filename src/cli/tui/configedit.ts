import { Client } from '../client';
import { BotConfig, ConfigSaveAnswer, readBotConfig, saveBotConfig } from './api';
import { ConfigFileList, FileLine } from './configfiles';
import { EditRequest } from './editbody';
import { WizardKey, wrap } from './install';

export interface ConfigView {
  body: string[];
  highlight?: number;
  cursor?: { line: number; col: number };
  keys: string;
  notice?: string;
}

/** What a key asks of the frame: quit, go back to the bot screen (`saved` re-reads the bot list), or hand off to the editor. */
export type ConfigExit = { quit: true } | { leave: true; notice?: string; saved?: boolean } | { edit: EditRequest } | undefined;

export interface ConfigOptions {
  flushMs?: number;
}

/** The page's config file editor (showConfigEditor to saveConfigEditor) for one bot. */
export class ConfigEditor {
  state: 'loading' | 'failed' | 'form' | 'saving' = 'loading';
  loadError = '';
  notice: string | null = null;
  config: BotConfig = {};
  focus = 'addcf';
  confirm: { text: string; run: () => Promise<ConfigExit> } | null = null;
  readonly cfg: ConfigFileList;
  private readonly flushMs: number;

  constructor(private client: Client, private changed: () => void, readonly botId: string, readonly name: string, opts: ConfigOptions = {}) {
    this.flushMs = opts.flushMs ?? 10_000;
    this.cfg = new ConfigFileList(client, changed, (text) => this.say(text), 'save', this.flushMs);
  }

  private say(text: string | null): void {
    this.notice = text;
    this.changed();
  }

  // showConfigEditor: read the files, then the cards; a failed read shows the route's text and nothing to save.
  async open(): Promise<void> {
    this.state = 'loading';
    this.changed();
    const r = await readBotConfig(this.client, this.botId);
    if (r.ok === null) {
      this.state = 'failed';
      this.loadError = `can't read the config files of ${this.name}: the manager did not answer (${r.text}).`;
    } else if (r.ok === false || r.value.success !== true) {
      this.state = 'failed';
      this.loadError = r.ok === false ? r.text : r.value.error || 'Failed to load';
    } else {
      this.config = r.value;
      const files = Array.isArray(r.value.files) ? r.value.files : [];
      this.cfg.set(files.map((f) => ({
        path: f.path, body: f.body, readOnly: f.readOnly, enabled: f.enabled, manifest: f.manifest, format: f.format, parsed: f.parsed,
        undecryptable: f.bodyUndecryptable, inactive: f.inactive, fromTemplate: f.fromTemplate, repoReadOnly: f.repoReadOnly,
      })));
      this.state = 'form';
      this.focus = this.focusables()[0];
    }
    this.changed();
  }

  private focusables(): string[] {
    return [...this.cfg.focusables(), 'addcf', 'save'];
  }

  private moveFocus(step: number): void {
    const list = this.focusables();
    const at = Math.max(list.indexOf(this.focus), 0);
    const next = list[Math.min(Math.max(at + step, 0), list.length - 1)];
    if (next !== this.focus) this.cfg.leave(this.focus);
    this.focus = next;
    this.changed();
  }

  key(input: string, key: WizardKey, forwardDelete = false): ConfigExit | Promise<ConfigExit> {
    if (this.cfg.waiting) return undefined;
    if (this.confirm) {
      const run = this.confirm.run;
      this.confirm = null;
      if (input.toLowerCase() === 'y' && !key.ctrl) return run();
      this.state = 'form';
      this.say('Cancelled: nothing was saved.');
      return undefined;
    }
    if (this.state === 'saving') return undefined;
    if (key.escape) return { leave: true };
    if (this.state !== 'form') return undefined;
    if (key.tab) {
      this.moveFocus(key.shift ? -1 : 1);
      return undefined;
    }
    if (key.upArrow || key.downArrow) {
      this.moveFocus(key.upArrow ? -1 : 1);
      return undefined;
    }
    if (this.focus === 'save') return key.return ? this.save() : undefined;
    if (this.focus === 'addcf') {
      if (key.return) {
        this.focus = this.cfg.add();
        this.changed();
      }
      return undefined;
    }
    const c = key.ctrl ? input.toLowerCase() : '';
    const before = this.focusables();
    if (!this.cfg.guidedFocus(this.focus) && c === 'd') {
      const at = before.indexOf(this.focus);
      this.cfg.remove(this.focus);
      const after = this.focusables();
      this.focus = before.slice(0, Math.max(at, 0)).reverse().find((f) => after.includes(f) && !/^[pwbg]/.test(f)) ?? after[0];
      this.changed();
      return undefined;
    }
    const out = this.cfg.key(this.focus, input, key, forwardDelete);
    if (out && 'next' in out) this.moveFocus(1);
    else if (out && 'edit' in out) return out.edit.then((edit) => (edit ? { edit } : undefined));
    else if (out && 'done' in out) {
      const after = this.focusables();
      if (!after.includes(this.focus)) {
        const at = before.indexOf(this.focus);
        const prev = before[at - 1];
        this.focus = prev && after.includes(prev) ? prev : after[Math.min(Math.max(at, 0), after.length - 1)];
        this.changed();
      }
    }
    return undefined;
  }

  // saveConfigEditor: the guided forms flushed and their erasures confirmed, the undecryptable copies confirmed, then PUT.
  private async save(): Promise<ConfigExit> {
    this.state = 'saving';
    this.say(null);
    const blocks = this.cfg.blocks();
    for (const b of blocks) for (const sub of Object.keys(b.drafts)) b.leave(sub);
    let ready = true;
    for (const b of blocks) if (!(await b.flushForSave(this.flushMs))) ready = false;
    if (!ready) {
      this.state = 'form';
      this.say('A form change could not be written into its file (see the warning on the file). Nothing was saved.');
      return undefined;
    }
    const erasing = blocks.flatMap((b) => b.erasures());
    const afterErasures = () => this.confirmReplacing();
    if (erasing.length) {
      this.confirm = {
        text: `Saving clears the value stored in the file for: ${erasing.map((e) => `${e.label} (now read from ${e.envVar})`).join(', ')}. Continue?`,
        run: afterErasures,
      };
      this.changed();
      return undefined;
    }
    return afterErasures();
  }

  private async confirmReplacing(): Promise<ConfigExit> {
    const replacing = this.cfg.replacing();
    if (replacing.length) {
      this.state = 'saving';
      this.confirm = {
        text: `The stored copy of ${replacing.join(', ')} no longer decrypts. Saving replaces it with what you entered, and it cannot be recovered by restoring the old key afterwards. Continue?`,
        run: () => this.send(),
      };
      this.changed();
      return undefined;
    }
    return this.send();
  }

  private async send(): Promise<ConfigExit> {
    this.state = 'saving';
    this.say(null);
    const r = await saveBotConfig(this.client, this.botId, this.cfg.collect());
    this.state = 'form';
    if (r.ok === null) {
      this.say(`can't confirm the config files of ${this.name} were saved: the manager did not answer (${r.text}).`);
      return undefined;
    }
    const res: ConfigSaveAnswer = r.ok ? r.value : { success: false, error: r.text };
    if (res.success !== true) {
      this.say(`${this.name}: ${res.error || 'Failed to save'}`);
      return undefined;
    }
    const n = this.name;
    const text = res.needsUpdate
      ? `Config files of ${n} saved. Press Build, then Start (Install & Run if the bot was never started), to apply: files were added, removed, turned on or off, or changed mode.`
      : res.mountsUnknown
        ? `Config files of ${n} saved. The manager has no record of the mounts the last build made, so it can't tell whether Start is enough: press Build, then Start, to be sure (Install & Run if the bot was never started).`
        : `Config files of ${n} saved. Press Start (or Build, then Start; Install & Run if the bot was never started) to apply.`;
    return { leave: true, notice: text, saved: true };
  }

  /** The screen; a notice longer than the notice line is wrapped onto the last body lines instead of being cut. */
  view(inner: number, room: number): ConfigView {
    const long = this.notice !== null && this.notice.length > inner ? wrap(this.notice, inner) : null;
    if (!long) return this.screenView(inner, room, this.notice ?? undefined);
    const space = Math.max(room - long.length - 1, 3);
    const v = this.screenView(inner, space, undefined);
    const body = v.body.slice(0, space);
    while (body.length < space) body.push('');
    return { ...v, body: [...body, '', ...long] };
  }

  private screenView(inner: number, room: number, notice: string | undefined): ConfigView {
    const title = `Config Files: ${this.name}`;
    if (this.state === 'loading') return { body: [title, '', 'Reading the config files.'], keys: 'Esc Back', notice };
    if (this.state === 'failed') return { body: ['Config Files', '', ...wrap(this.loadError, inner)], keys: 'Esc Back', notice };
    if (this.confirm) return { body: [title, '', ...wrap(this.confirm.text, inner)], keys: 'Y Continue  any other key Cancel', notice };
    const all: FileLine[] = [];
    const push = (text: string, extra: Partial<FileLine> = {}) => all.push({ text, ...extra });
    const wrapped = (text: string) => {
      for (const t of wrap(text, inner)) push(t);
    };
    push(title);
    wrapped('Files bind-mounted into the container. Saved changes are applied the next time the bot starts, so press Start (or Update / Install & Run) after saving.');
    const c = this.config;
    // storeHealthBanner for configFiles.json.
    if (c.secretKeyProblem) wrapped(`Secrets cannot be saved: ${c.secretKeyProblem}. Fix the key file and restart the manager.`);
    if (c.storeBroken) wrapped('configFiles.json cannot be read, so saves are refused until it is repaired or replaced.');
    if (c.corruptCopies && c.corruptCopies.length) wrapped(`Copies of damaged configFiles.json kept beside it: ${c.corruptCopies.join(', ')}.`);
    push('');
    all.push(...this.cfg.lines(inner, this.focus));
    push('  Add config file', { focus: 'addcf' });
    push('');
    push('  Save', { focus: 'save' });
    const at = Math.max(all.findIndex((l) => l.focus === this.focus || (l.focus?.split('|').includes(this.focus) ?? false)), 0);
    const first = Math.max(0, Math.min(at - Math.floor(room / 2), all.length - room));
    const shown = all.slice(first, first + room);
    const focused = all[at];
    const line = at - first;
    if (this.state === 'saving') return { body: shown.map((l) => l.text), keys: 'Waiting for the manager', notice: 'Saving the config files.' };
    if (this.cfg.waiting) return { body: shown.map((l) => l.text), keys: 'Waiting for the manager', notice: this.cfg.waiting };
    return {
      body: shown.map((l) => l.text),
      ...(focused.col !== undefined ? { cursor: { line, col: focused.col } } : { highlight: line }),
      keys: this.formKeys(),
      notice,
    };
  }

  private formKeys(): string {
    if (this.focus === 'save') return 'Enter Save  Up Previous  Esc Cancel';
    if (this.focus === 'addcf') return 'Enter Add config file  Tab Next  Esc Cancel';
    return [this.cfg.keys(this.focus), 'Tab Next', 'Esc Cancel'].filter(Boolean).join('  ');
  }
}
