import { randomBytes } from 'crypto';
import { Client } from '../client';
import { BotEnv, EditorVar, EnvSaveAnswer, readBotEnv, saveBotEnv, validateDb } from './api';
import { editField, Field, field, showField } from './field';
import { matches, WizardKey, wrap } from './install';
import { VaultPicker } from './vaultpick';

export interface EditorView {
  body: string[];
  highlight?: number;
  cursor?: { line: number; col: number };
  keys: string;
  notice?: string;
}

/** What a key asks of the frame: quit, or go back to the bot screen with a notice (`saved` re-reads the bot list). */
export type EditorExit = { quit: true } | { leave: true; notice?: string; saved?: boolean } | undefined;

export interface EditorOptions {
  secret?: () => string;
  now?: () => number;
}

interface Row {
  id: number;
  hint: EditorVar | null;
  key: Field;
  /** The page's data-original-key: the key the row was read with, '' for an added row. */
  originalKey: string;
  /** The value the save sends; for a list row, the items joined with commas. */
  value: Field;
  items: Field[] | null;
  /** The page's data-sensitive: a blank value keeps the stored one. */
  sensitive: boolean;
  /** Shown as asterisks: a secret the route blanked, a generated secret or a value picked from the vault. */
  mask: boolean;
  /** The page's vault button: text and number rows built from the route's list. */
  vault: boolean;
  vaultKey: string;
  /** A stored select value matching no option: the page keeps it as its own last option. */
  carried?: string;
}

type Part = { kind: 'group'; title: string; help?: string } | { kind: 'advanced' } | { kind: 'row'; id: number };

interface Line {
  text: string;
  focus?: string;
  col?: number;
}

// The page's ENV_LABELS: names for keys the route gives no label.
const ENV_LABELS: Record<string, string> = {
  TOKEN: 'Discord Bot Token',
  DISCORD_TOKEN: 'Discord Bot Token',
  BOT_TOKEN: 'Discord Bot Token',
  CLIENT_TOKEN: 'Discord Bot Token',
  CLIENT_ID: 'Discord Client ID',
  DISCORD_CLIENT_ID: 'Discord Client ID',
  GUILD_ID: 'Discord Guild ID',
  MONGO_URI: 'MongoDB Connection URI',
  MONGODB_URI: 'MongoDB Connection URI',
  DATABASE_URL: 'Database URL',
  REDIS_URL: 'Redis URL',
  LAVALINK_HOST: 'Lavalink Host',
  LAVALINK_PORT: 'Lavalink Port',
  LAVALINK_PASSWORD: 'Lavalink Password',
};

const KEY_WIDTH = 26;
const VALUE_COL = 3 + KEY_WIDTH;

function listItems(value: string): Field[] {
  const items = value.split(',').map((s) => s.trim()).filter((s) => s !== '');
  return (items.length ? items : ['']).map((s) => field(s));
}

/** The page's env editor (showEnvEditor to saveEnvEditor) for one bot; the frame shows its view and passes it every key. */
export class EnvEditor {
  state: 'loading' | 'failed' | 'form' | 'saving' = 'loading';
  loadError = '';
  notice: string | null = null;
  env: BotEnv = {};
  rows: Row[] = [];
  parts: Part[] = [];
  focus = 'save';
  stored: string[] = [];
  initial: Record<string, string> = {};
  confirm: { lines: string[]; run: () => Promise<EditorExit> } | null = null;
  savingText = '';
  readonly picker: VaultPicker;
  private nextRow = 0;
  private readonly secret: () => string;

  constructor(private client: Client, private changed: () => void, readonly botId: string, readonly name: string, opts: EditorOptions = {}) {
    this.secret = opts.secret ?? (() => randomBytes(32).toString('hex'));
    this.picker = new VaultPicker(client, changed, (text) => this.say(text), opts.now);
  }

  private say(text: string | null): void {
    this.notice = text;
    this.changed();
  }

  // showEnvEditor: read the env, then the rows; a failed read shows the route's text and nothing to save.
  async open(): Promise<void> {
    this.state = 'loading';
    this.changed();
    const r = await readBotEnv(this.client, this.botId);
    if (r.ok === null) {
      this.state = 'failed';
      this.loadError = `can't read the environment variables of ${this.name}: the manager did not answer (${r.text}).`;
    } else if (r.ok === false || r.value.success !== true) {
      this.state = 'failed';
      this.loadError = r.ok === false ? r.text : r.value.error || 'Failed to load';
    } else {
      this.env = r.value;
      this.build(Array.isArray(r.value.vars) ? r.value.vars : []);
      this.state = 'form';
    }
    this.changed();
  }

  // renderEnvRows: groups in the route's order, each group's advanced rows after its others, ungrouped advanced rows last.
  private build(vars: EditorVar[]): void {
    this.rows = [];
    this.parts = [];
    if (vars.length === 0) {
      const row = this.newRow(null, '', '', true);
      this.rows.push(row);
      this.parts.push({ kind: 'row', id: row.id });
    }
    const advanced: Part[] = [];
    let i = 0;
    while (i < vars.length) {
      const group = vars[i].group;
      if (!group) {
        const row = this.hintRow(vars[i]);
        this.rows.push(row);
        (vars[i].advanced ? advanced : this.parts).push({ kind: 'row', id: row.id });
        i++;
        continue;
      }
      const members: EditorVar[] = [];
      while (i < vars.length && vars[i].group === group) members.push(vars[i++]);
      const help = members.find((e) => e.groupHelp)?.groupHelp;
      this.parts.push({ kind: 'group', title: group, ...(help ? { help } : {}) });
      const main = members.filter((e) => !e.advanced).map((e) => this.hintRow(e));
      const adv = members.filter((e) => e.advanced).map((e) => this.hintRow(e));
      this.rows.push(...main, ...adv);
      this.parts.push(...main.map((r) => ({ kind: 'row' as const, id: r.id })));
      if (adv.length) this.parts.push({ kind: 'advanced' }, ...adv.map((r) => ({ kind: 'row' as const, id: r.id })));
    }
    if (advanced.length) this.parts.push({ kind: 'advanced' }, ...advanced);
    this.stored = vars.filter((v) => v.isSet).map((v) => v.key);
    this.initial = {};
    for (const row of this.rows) {
      const k = row.key.text.trim();
      if (!row.hint?.inactive && k) this.initial[k] = row.value.text;
    }
    this.focus = this.focusables()[0];
  }

  private newRow(hint: EditorVar | null, key: string, value: string, vault: boolean): Row {
    return {
      id: this.nextRow++, hint, key: field(key), originalKey: key, value: field(value), items: null,
      sensitive: !!hint?.sensitive, mask: !!hint?.sensitive, vault, vaultKey: key,
    };
  }

  // renderEnvRow and buildEnvRowHtml: a secret is blank; a select keeps an unknown stored value as "(current)".
  private hintRow(e: EditorVar): Row {
    const current = e.value !== undefined && e.value !== null ? e.value : e.defaultValue || '';
    let value = e.sensitive ? '' : current;
    const options = e.options && e.options.length ? e.options : null;
    let carried: string | undefined;
    if (options) {
      const norm = value.trim().toLowerCase();
      const hit = options.find((o) => String(o.value) === value) || options.find((o) => String(o.value).trim().toLowerCase() === norm);
      if (!hit && value !== '') carried = value;
      value = hit ? String(hit.value) : value !== '' ? value : String(options[0].value);
    }
    const row = this.newRow(e, e.key, value, !options && !e.list && !e.autoWired && !e.inactive);
    row.carried = carried;
    // Only the page's text input carries data-sensitive; a select or a list sends what it holds.
    row.sensitive = !!e.sensitive && !options && !e.list;
    if (!options && e.list) row.items = listItems(value);
    return row;
  }

  private row(id: number): Row | undefined {
    return this.rows.find((r) => r.id === id);
  }

  private live(row: Row): boolean {
    return !row.hint?.inactive && !row.hint?.autoWired;
  }

  // envRowValue: the first editable row with the key.
  private rowValue(key: string): string {
    const row = this.rows.find((r) => this.live(r) && r.key.text.trim() === key);
    return row ? row.value.text.trim() : '';
  }

  private shown(row: Row): boolean {
    const when = row.hint?.showWhen;
    return !when || matches(when.equals, this.rowValue(when.key));
  }

  private required(row: Row): boolean {
    const h = row.hint;
    if (!h) return false;
    if (h.requiredWhen) return matches(h.requiredWhen.equals, this.rowValue(h.requiredWhen.key));
    return !!h.required;
  }

  private orderedRows(): Row[] {
    return this.parts.flatMap((p) => (p.kind === 'row' ? [this.row(p.id)].filter((r): r is Row => !!r) : []));
  }

  private focusables(): string[] {
    const out: string[] = [];
    for (const row of this.orderedRows()) {
      if (!this.live(row) || !this.shown(row)) continue;
      out.push(`k${row.id}`);
      if (row.items) row.items.forEach((_, n) => out.push(`i${row.id}:${n}`));
      else out.push(`v${row.id}`);
    }
    out.push('save');
    return out;
  }

  private moveFocus(step: number): void {
    const list = this.focusables();
    const at = Math.max(list.indexOf(this.focus), 0);
    this.focus = list[Math.min(Math.max(at + step, 0), list.length - 1)];
    this.changed();
  }

  private focused(): { row: Row; part: 'k' | 'v' | 'i'; item: number } | null {
    const m = /^([kvi])(\d+)(?::(\d+))?$/.exec(this.focus);
    const row = m ? this.row(Number(m[2])) : undefined;
    return m && row ? { row, part: m[1] as 'k' | 'v' | 'i', item: m[3] === undefined ? -1 : Number(m[3]) } : null;
  }

  // envListRecompute: the items, trimmed and without blanks, joined with commas.
  private syncList(row: Row): void {
    if (!row.items) return;
    row.value = field(row.items.map((f) => f.text.trim()).filter((v) => v !== '').join(','));
  }

  // setEnvInputValue for a text row: the value the vault entry holds.
  private pickInto(row: Row): void {
    void this.picker.open(row.vaultKey, (value) => {
      if (!this.rows.includes(row)) return;
      row.value = field(value);
      row.mask = true;
      this.changed();
    });
  }

  /** One key from the frame; `forwardDelete` is true when the raw input was the Delete key. */
  key(input: string, key: WizardKey, forwardDelete = false): EditorExit | Promise<EditorExit> {
    if (this.picker.active) {
      this.picker.key(key);
      return undefined;
    }
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
    if (this.focus === 'save') {
      if (key.return) return this.save();
      if (key.ctrl && input.toLowerCase() === 'n') this.addRow();
      return undefined;
    }
    if (key.return) {
      this.moveFocus(1);
      return undefined;
    }
    const c = key.ctrl ? input.toLowerCase() : '';
    const at = this.focused();
    if (c === 'n') {
      this.addRow();
      return undefined;
    }
    if (!at) return undefined;
    const { row, part, item } = at;
    if (c === 'd') {
      if (part === 'i') this.removeItem(row, item);
      else this.removeRow(row);
      return undefined;
    }
    if (c === 'a' && row.items) {
      row.items.push(field());
      this.focus = `i${row.id}:${row.items.length - 1}`;
      this.changed();
      return undefined;
    }
    const options = row.hint?.options && row.hint.options.length ? row.hint.options : null;
    if (c === 'g' && row.hint?.generate && !options && !row.items) {
      row.value = field(this.secret());
      row.mask = true;
      this.changed();
      return undefined;
    }
    if (c === 'p' && part === 'v' && row.vault) {
      this.pickInto(row);
      return undefined;
    }
    if (part === 'k') {
      const next = editField(row.key, input, key, forwardDelete);
      if (next) row.key = next;
      this.changed();
      return undefined;
    }
    if (part === 'v' && options) {
      if (key.leftArrow || key.rightArrow) {
        const values = [...options.map((o) => String(o.value)), ...(row.carried !== undefined ? [row.carried] : [])];
        const now = values.indexOf(row.value.text);
        const next = now < 0 ? 0 : (now + (key.rightArrow ? 1 : values.length - 1)) % values.length;
        row.value = field(values[next]);
        this.changed();
      }
      return undefined;
    }
    if (part === 'i' && row.items) {
      const next = editField(row.items[item], input, key, forwardDelete);
      if (next) {
        row.items[item] = next;
        this.syncList(row);
      }
      this.changed();
      return undefined;
    }
    const next = editField(row.value, input, key, forwardDelete);
    if (next) row.value = next;
    this.changed();
    return undefined;
  }

  // addEnvEditorRow: a blank key and value at the end, with no vault button.
  private addRow(): void {
    const row = this.newRow(null, '', '', false);
    this.rows.push(row);
    this.parts.push({ kind: 'row', id: row.id });
    this.focus = `k${row.id}`;
    this.changed();
  }

  private removeRow(row: Row): void {
    const list = this.focusables();
    const at = list.indexOf(this.focus);
    this.rows = this.rows.filter((r) => r !== row);
    this.parts = this.parts.filter((p) => !(p.kind === 'row' && p.id === row.id));
    const after = this.focusables();
    const prev = list.slice(0, Math.max(at, 0)).reverse().find((f) => after.includes(f));
    this.focus = prev ?? after[0];
    this.changed();
  }

  // envListRemove: the last item removed leaves one blank item.
  private removeItem(row: Row, item: number): void {
    if (!row.items) return;
    row.items.splice(item, 1);
    if (row.items.length === 0) row.items.push(field());
    this.syncList(row);
    this.focus = `i${row.id}:${Math.min(item, row.items.length - 1)}`;
    this.changed();
  }

  // saveEnvEditor: the page's checks, the database test, then PUT env with the kept, removed and renamed keys.
  private async save(): Promise<EditorExit> {
    const vars: Record<string, string> = {};
    const badNumbers: string[] = [];
    const outOfBounds: string[] = [];
    const rowKeys: string[] = [];
    const origins: Array<{ key: string; originalKey: string }> = [];
    const renamed: Record<string, string> = {};
    for (const row of this.orderedRows()) {
      if (!this.live(row)) continue;
      const key = row.key.text.trim();
      if (key) rowKeys.push(key);
      origins.push({ key, originalKey: row.originalKey });
      if (!key) continue;
      const h = row.hint;
      const value = row.value.text;
      const isNumber = h?.inputType === 'number' && !h.options?.length && !row.items;
      if (isNumber && value.trim() !== '' && !Number.isFinite(Number(value.trim()))) {
        badNumbers.push(key);
        continue;
      }
      const bounded = isNumber && ((h!.min !== undefined && h!.min !== null) || (h!.max !== undefined && h!.max !== null));
      if (bounded && this.shown(row) && value.trim() !== '') {
        const v = value.trim();
        const n = Number(v);
        const bad = (h!.step === 1 && !/^[0-9]+$/.test(v)) || !Number.isFinite(n) || (h!.min != null && n < h!.min) || (h!.max != null && n > h!.max);
        if (bad) {
          outOfBounds.push(`${h!.label || h!.displayLabel || key} takes a whole number from ${h!.min}${h!.max != null ? ` to ${h!.max}` : ''}.`);
          continue;
        }
      }
      if (row.sensitive && value === '') {
        if (row.originalKey && row.originalKey !== key && this.stored.includes(row.originalKey)) renamed[key] = row.originalKey;
        continue;
      }
      vars[key] = value;
    }
    const dupes = rowKeys.filter((k, i) => rowKeys.indexOf(k) !== i);
    if (dupes.length > 0) {
      this.say(`Two rows hold the same key (${[...new Set(dupes)].join(', ')}); give each row its own key, then save. Nothing was saved.`);
      return undefined;
    }
    if (badNumbers.length > 0) {
      this.say(`Not a number: ${badNumbers.join(', ')}. Fix the value, then save. Nothing was saved.`);
      return undefined;
    }
    if (outOfBounds.length > 0) {
      this.say(`${outOfBounds.join(' ')} Nothing was saved.`);
      return undefined;
    }
    const removed = this.stored.filter((k) => !origins.some((r) => r.key === k && r.originalKey === k));
    const send = () => this.send({ vars, removed, renamed });

    // A new database URL is tested first; a failed test still saves when the operator says Y.
    const dbRow = this.orderedRows().find((r) => r.hint?.semantic === 'db-dsn');
    const dbKey = dbRow ? dbRow.key.text.trim() : '';
    const dbUrl = dbKey ? (vars[dbKey] || '').trim() : '';
    if (dbUrl && dbUrl !== (this.initial[dbKey] || '').trim()) {
      this.state = 'saving';
      this.savingText = 'Testing the database URL.';
      this.say(null);
      const r = await validateDb(this.client, this.botId, dbUrl);
      const check = r.ok === true ? r.value : null;
      if (!(check && check.success && check.ok)) {
        const msg = (check && check.error) || 'connection test failed';
        const lines = r.ok !== true
          ? ['The database connection test got no answer from the manager, so whether this URL works is unknown.', '', 'Save anyway?']
          : check && check.notTested
            ? ['The database could not be tested:', msg, '', 'Save anyway?']
            : ['Database connection test failed:', msg, ...(check && check.hint ? ['', `Hint: ${check.hint}`] : []), '', 'Save anyway?'];
        this.confirm = { lines, run: send };
        this.changed();
        return undefined;
      }
    }
    return send();
  }

  private async send(body: { vars: Record<string, string>; removed: string[]; renamed: Record<string, string> }): Promise<EditorExit> {
    this.state = 'saving';
    this.savingText = 'Saving the environment variables.';
    this.say(null);
    const r = await saveBotEnv(this.client, this.botId, body);
    this.state = 'form';
    if (r.ok === null) {
      this.say(`can't confirm the environment variables of ${this.name} were saved: the manager did not answer (${r.text}).`);
      return undefined;
    }
    const res: EnvSaveAnswer = r.ok ? r.value : { success: false, error: r.text };
    if (res.success === true) {
      const gone = Array.isArray(res.removed) ? res.removed : [];
      const saved = gone.length ? `Environment variables of ${this.name} saved; removed ${gone.join(', ')}` : `Environment variables of ${this.name} saved`;
      const text = res.warning
        ? `${saved}. ${res.warning}`
        : res.notApplied
          ? `${saved}. The running bot still uses the old values until you Apply or Restart it.`
          : `${saved}.`;
      return { leave: true, notice: text, saved: true };
    }
    const text = `${this.name}: ${res.error || 'Failed to save'}`;
    if (res.stillStored) return { leave: true, notice: text, saved: true };
    this.say(text);
    return undefined;
  }

  /** The screen; a notice longer than the notice line is wrapped onto the last body lines instead of being cut. */
  view(inner: number, room: number): EditorView {
    const long = this.notice !== null && this.notice.length > inner ? wrap(this.notice, inner) : null;
    if (!long) return this.screenView(inner, room, this.notice ?? undefined);
    const space = Math.max(room - long.length - 1, 3);
    const v = this.screenView(inner, space, undefined);
    const body = v.body.slice(0, space);
    while (body.length < space) body.push('');
    return { ...v, body: [...body, '', ...long] };
  }

  private screenView(inner: number, room: number, notice: string | undefined): EditorView {
    if (this.picker.active) return { ...this.picker.view(inner, room), notice };
    const title = `Environment Variables: ${this.name}`;
    if (this.state === 'loading') return { body: [title, '', 'Reading the environment variables.'], keys: 'Esc Back', notice };
    if (this.state === 'failed') return { body: ['Environment Variables', '', ...wrap(this.loadError, inner)], keys: 'Esc Back', notice };
    if (this.confirm) return { body: [title, '', ...this.confirm.lines.flatMap((l) => (l ? wrap(l, inner) : ['']))], keys: 'Y Save anyway  any other key Cancel', notice };
    const all = this.formLines(inner, title);
    const at = Math.max(all.findIndex((l) => l.focus === this.focus || (l.focus?.split('|').includes(this.focus) ?? false)), 0);
    const first = Math.max(0, Math.min(at - Math.floor(room / 2), all.length - room));
    const shown = all.slice(first, first + room);
    const focused = all[at];
    const line = at - first;
    if (this.state === 'saving') return { body: shown.map((l) => l.text), keys: 'Waiting for the manager', notice: this.savingText };
    return {
      body: shown.map((l) => l.text),
      ...(focused.col !== undefined ? { cursor: { line, col: focused.col } } : { highlight: line }),
      keys: this.formKeys(),
      notice,
    };
  }

  private formLines(inner: number, title: string): Line[] {
    const all: Line[] = [];
    const push = (text: string, extra: Partial<Line> = {}) => all.push({ text, ...extra });
    const wrapped = (text: string, indent = '') => {
      for (const t of wrap(text, inner, indent)) push(t);
    };
    push(title);
    const env = this.env;
    if (env.missing && env.missing.length) wrapped(`Missing required: ${env.missing.join(', ')}`);
    if (env.undecryptable && env.undecryptable.length) {
      wrapped(`Stored but cannot be decrypted: ${env.undecryptable.join(', ')}. Enter the value again, or restore the encryption key.`);
    }
    // storeHealthBanner for storage.json.
    if (env.secretKeyProblem) wrapped(`Secrets cannot be saved: ${env.secretKeyProblem}. Fix the key file and restart the manager.`);
    if (env.storeBroken) wrapped('storage.json cannot be read, so saves are refused until it is repaired or replaced.');
    if (env.corruptCopies && env.corruptCopies.length) wrapped(`Copies of damaged storage.json kept beside it: ${env.corruptCopies.join(', ')}.`);
    push('');
    for (const p of this.parts) {
      if (p.kind === 'group') {
        push(`  ${p.title}`);
        if (p.help) wrapped(p.help, '  ');
        continue;
      }
      if (p.kind === 'advanced') {
        push('  Advanced');
        continue;
      }
      const row = this.row(p.id);
      if (row && this.shown(row)) all.push(...this.rowLines(row, inner));
    }
    push('');
    push('  Save', { focus: 'save' });
    return all;
  }

  private rowLines(row: Row, inner: number): Line[] {
    const h = row.hint;
    const lines: Line[] = [];
    const text = (t: string, indent: string) => wrap(t, inner, indent).map((x) => ({ text: x }));
    const keyText = row.key.text;
    const label = h ? h.label || h.displayLabel || ENV_LABELS[keyText] || '' : '';
    if (label) lines.push({ text: `  ${label}${this.required(row) ? ' (required)' : ''}` });
    if (h?.inactive) {
      lines.push({ text: `  ${keyText.padEnd(KEY_WIDTH)} not used` }, ...text(h.inactive, '    '));
      return lines;
    }
    const keyField = showField(row.key, KEY_WIDTH);
    const kf = `k${row.id}`;
    const vf = `v${row.id}`;
    const valueWidth = Math.max(inner - VALUE_COL, 12);
    const options = h?.options && h.options.length ? h.options : null;
    if (row.items) {
      lines.push(this.focus === kf ? { text: `  ${keyField.text}`, focus: kf, col: 2 + keyField.col } : { text: `  ${keyField.text}`, focus: kf });
      row.items.forEach((f, n) => {
        const id = `i${row.id}:${n}`;
        const shown = showField(f, valueWidth, row.mask);
        lines.push({ text: `${' '.repeat(VALUE_COL)}${shown.text}`, focus: id, ...(this.focus === id ? { col: VALUE_COL + shown.col } : {}) });
      });
    } else {
      let valueText: string;
      let valueCol: number | undefined;
      if (options) {
        const hit = options.find((o) => String(o.value) === row.value.text);
        valueText = `< ${hit ? hit.label || hit.value : `${row.value.text} (current)`} >`;
      } else {
        const v = showField(row.value, valueWidth, row.mask);
        valueText = v.text;
        valueCol = v.col;
      }
      const line = `  ${keyField.text} ${valueText}`;
      if (this.focus === kf) lines.push({ text: line, focus: kf, col: 2 + keyField.col });
      else if (this.focus === vf) lines.push({ text: line, focus: vf, ...(valueCol === undefined ? {} : { col: VALUE_COL + valueCol }) });
      else lines.push({ text: line, focus: `${kf}|${vf}` });
    }
    const description = h?.undecryptable ? ['The stored value cannot be decrypted.', h.description || ''].join(' ').trim() : h?.description || '';
    if (description) lines.push(...text(description, '    '));
    if (h && row.sensitive && row.value.text === '' && !row.items) {
      lines.push({ text: h.undecryptable ? '    Stored value cannot be decrypted; enter it again' : h.isSet ? '    Sensitive - leave blank to keep current' : '    Sensitive value' });
    }
    if (h?.generate && !options && !row.items) lines.push({ text: '    Ctrl+G generates a new random secret.' });
    return lines;
  }

  private formKeys(): string {
    if (this.focus === 'save') return 'Enter Save  Up Previous  Ctrl+N Add  Esc Cancel';
    const at = this.focused();
    const keys = ['Tab Next'];
    if (at?.part === 'v' && at.row.hint?.options?.length) keys.unshift('Left/Right Choose');
    if (at?.part === 'v' && at.row.vault) keys.push('Ctrl+P Vault');
    if (at?.part === 'i') keys.push('Ctrl+A Add item', 'Ctrl+D Remove item', 'Ctrl+N Add');
    else keys.push('Ctrl+N Add', 'Ctrl+D Remove');
    keys.push('Esc Cancel');
    return keys.join('  ');
  }
}
