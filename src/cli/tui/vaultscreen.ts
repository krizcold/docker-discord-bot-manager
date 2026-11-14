import { Client } from '../client';
import {
  addVaultEntry, Answer, Outcome, readVault, removeDeletedEntry, removeDeletedGroup, removeVaultEntry, saveBotEnv, updateDeletedEntry,
  updateVaultEntry, VaultGroup, VaultList,
} from './api';
import { editField, Field, field, showField } from './field';
import { WizardKey, wrap } from './install';

export interface VaultView {
  body: string[];
  highlight?: number;
  cursor?: { line: number; col: number };
  keys: string;
  notice?: string;
}

export type VaultExit = { quit: true } | { leave: true } | undefined;

export interface VaultOptions {
  retryMs?: number;
  /** Formats a deleted bot's date when two deleted groups share a name. */
  date?: (ms: number) => string;
}

/** One entry row as edited: the page's .vault-entry with its data-original-key and data-orig-value. */
interface Row {
  groupId: string;
  type: VaultGroup['type'];
  originalKey: string;
  origValue: string;
  masked: string;
  hidden: boolean;
  key: Field;
  value: Field;
  dirty: boolean;
}

interface Line {
  text: string;
  focus?: string;
  col?: number;
}

const KEY_WIDTH = 26;

function localDate(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const rowId = (groupId: string, key: string) => `${groupId}\u0000${key}`;

/** The page's Credentials Vault (loadVault to addVaultEntry); the frame shows its view and passes it every key. */
export class VaultScreen {
  groups: VaultGroup[] = [];
  /** The groups on screen: the last read, unless a reload is held back for a focused edit. */
  painted: VaultGroup[] = [];
  health: VaultList = {};
  loaded = false;
  loadError: string | null = null;
  notice: string | null = null;
  expanded = new Set<string>(['standalone']);
  rows = new Map<string, Row>();
  focus = '';
  newKey = field();
  newValue = field();
  newHidden = true;
  deferred = false;
  busy = false;
  confirm: { lines: string[]; run: () => Promise<void> } | null = null;
  private timer: NodeJS.Timeout | null = null;
  private closed = false;
  private readonly retryMs: number;
  private readonly date: (ms: number) => string;

  constructor(private client: Client, private changed: () => void, opts: VaultOptions = {}) {
    this.retryMs = opts.retryMs ?? 10_000;
    this.date = opts.date ?? localDate;
  }

  private say(text: string | null): void {
    this.notice = text;
    this.changed();
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  // loadVault: a failed read keeps the last list and tries again in 10 s.
  async load(): Promise<void> {
    const r = await readVault(this.client);
    if (this.closed) return;
    if (r.ok === true && r.value.success === true && Array.isArray(r.value.groups)) {
      this.groups = r.value.groups;
      this.health = r.value;
      this.loadError = null;
    } else if (r.ok === true) {
      this.loadError = r.value.error || 'Failed to load the vault';
    } else if (r.ok === false) {
      this.loadError = r.text;
    } else {
      this.loadError = `the manager did not answer (${r.text})`;
    }
    this.loaded = true;
    if (this.loadError && !this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.load();
      }, this.retryMs);
      this.timer.unref?.();
    }
    this.render();
  }

  // renderVault, captureVaultEdits and restoreVaultEdits: edits stay on the rows they were made on; a focused dirty row
  // whose entry is gone or folded keeps the old list until it is left.
  private render(): void {
    const focused = this.focusedRow();
    if (focused && focused.dirty) {
      const still = this.groups.some((g) => g.id === focused.groupId && this.expanded.has(g.id) && g.entries.some((e) => e.key === focused.originalKey));
      if (!still) {
        if (!this.deferred) {
          // After the route's own result, never in its place.
          const held = `The vault list was not refreshed (it changed elsewhere or a group was toggled), so your unsaved edit to ${focused.originalKey} is kept. Save it or leave the row to refresh.`;
          this.notice = this.notice ? `${this.notice} ${held}` : held;
        }
        this.deferred = true;
        this.changed();
        return;
      }
    }
    this.deferred = false;
    const kept = new Map<string, Row>();
    this.painted = this.groups;
    for (const g of this.groups) {
      for (const e of g.entries) {
        const id = rowId(g.id, e.key);
        const before = this.rows.get(id);
        const origValue = e.hidden ? '' : e.value;
        const fresh: Row = {
          groupId: g.id, type: g.type, originalKey: e.key, origValue, masked: e.masked, hidden: !!e.hidden,
          key: field(e.key), value: field(origValue), dirty: false,
        };
        const isFocus = this.focus.endsWith(`:${id}`);
        if (before && (before.dirty || isFocus)) {
          fresh.key = before.key;
          fresh.value = before.value;
          fresh.dirty = before.dirty;
        }
        kept.set(id, fresh);
      }
    }
    this.rows = kept;
    const list = this.focusables();
    if (!list.includes(this.focus)) this.focus = list[0] ?? '';
    this.changed();
  }

  private visibleGroups(): VaultGroup[] {
    return this.painted.filter((g) => !(g.type === 'instance' && g.entries.length === 0));
  }

  private empty(): boolean {
    return this.painted.length === 0 || this.painted.every((g) => g.entries.length === 0 && g.type !== 'standalone');
  }

  private focusables(): string[] {
    if (this.empty()) return [];
    const out: string[] = [];
    for (const g of this.visibleGroups()) {
      out.push(`h:${g.id}`);
      if (!this.expanded.has(g.id)) continue;
      for (const e of g.entries) out.push(`k:${rowId(g.id, e.key)}`, `v:${rowId(g.id, e.key)}`);
      if (g.type === 'standalone') out.push('nk', 'nv', 'nh');
    }
    return out;
  }

  private focusedRow(): Row | undefined {
    const m = /^[kv]:(.*)$/s.exec(this.focus);
    return m ? this.rows.get(m[1]) : undefined;
  }

  private focusedGroup(): VaultGroup | undefined {
    const id = this.focus.startsWith('h:') ? this.focus.slice(2) : this.focusedRow()?.groupId;
    return this.painted.find((g) => g.id === id);
  }

  private moveFocus(step: number): void {
    const list = this.focusables();
    if (!list.length) return;
    const at = Math.max(list.indexOf(this.focus), 0);
    const next = list[Math.min(Math.max(at + step, 0), list.length - 1)];
    const row = this.focusedRow();
    this.focus = next;
    // revertVaultIfClean: leaving a row with an unsaved edit puts its loaded values back.
    if (row && this.focusedRow() !== row && row.dirty) {
      row.key = field(row.originalKey);
      row.value = field(row.origValue);
      row.dirty = false;
      this.notice = `Your unsaved edit to ${row.originalKey} was dropped; it was not saved.`;
      if (this.deferred) this.render();
    }
    this.changed();
  }

  key(input: string, key: WizardKey, forwardDelete = false): VaultExit | Promise<VaultExit> {
    if (this.confirm) {
      const run = this.confirm.run;
      this.confirm = null;
      if (input.toLowerCase() === 'y' && !key.ctrl) return run().then(() => undefined);
      this.say('Cancelled: nothing was deleted.');
      return undefined;
    }
    if (this.busy) return undefined;
    if (key.escape) {
      this.close();
      return { leave: true };
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
    if (c === 'r') {
      void this.load();
      return undefined;
    }
    if (this.focus.startsWith('h:')) {
      const g = this.focusedGroup();
      if (!g) return undefined;
      if (key.return || input === ' ') this.toggle(g.id);
      else if (c === 'd' && g.type === 'deleted') this.askGroup(g);
      return undefined;
    }
    if (this.focus === 'nh') {
      if (input === ' ') {
        this.newHidden = !this.newHidden;
        this.changed();
      } else if (key.return) return this.add().then(() => undefined);
      return undefined;
    }
    if (this.focus === 'nk' || this.focus === 'nv') {
      if (key.return) return this.add().then(() => undefined);
      const f = this.focus === 'nk' ? this.newKey : this.newValue;
      const next = editField(f, input, key, forwardDelete);
      if (next && this.focus === 'nk') this.newKey = next;
      else if (next) this.newValue = next;
      this.changed();
      return undefined;
    }
    const row = this.focusedRow();
    if (!row) return undefined;
    if (key.return) return this.save(row).then(() => undefined);
    if (c === 'd') {
      if (row.type !== 'instance') this.askEntry(row);
      return undefined;
    }
    const target = this.focus.startsWith('k:') ? row.key : row.value;
    const next = editField(target, input, key, forwardDelete);
    if (next) {
      if (this.focus.startsWith('k:')) row.key = next;
      else row.value = next;
      if (next.text !== target.text) row.dirty = true;
      this.changed();
    }
    return undefined;
  }

  // toggleVaultGroup.
  private toggle(id: string): void {
    if (this.expanded.has(id)) this.expanded.delete(id);
    else this.expanded.add(id);
    this.render();
  }

  private async run(what: string, call: () => Promise<Outcome<Answer>>, fallback: string, done: (a: Answer) => string): Promise<void> {
    this.busy = true;
    this.say(null);
    const r = await call();
    this.busy = false;
    if (r.ok === null) this.say(`can't confirm ${what}: the manager did not answer (${r.text}). Check whether it took effect before trying again.`);
    else if (r.ok === false) this.say(r.text);
    else if (r.value.success !== true) this.say(r.value.error || fallback);
    else this.say(done(r.value));
    await this.load();
  }

  // saveVaultRow: a rename and a non-empty value go to the entry's own route; a bot's variable only through its env.
  private async save(row: Row): Promise<void> {
    const newKey = row.key.text.trim();
    const newValue = row.value.text;
    const original = row.originalKey;
    // A reload while the call ran rebuilds the rows; the mark is cleared on the row shown now.
    const after = () => {
      const now = this.rows.get(rowId(row.groupId, original));
      if (now) now.dirty = false;
    };
    if (row.type === 'deleted' || row.type === 'standalone') {
      const body: { newKey?: string; value?: string } = {};
      if (newKey !== original) body.newKey = newKey;
      if (newValue) body.value = newValue;
      if (Object.keys(body).length === 0) {
        this.say('The key is unchanged and the value is empty, so nothing was saved.');
        return;
      }
      const name = body.newKey ?? original;
      await this.run(`the save of ${original}`, () => (row.type === 'deleted'
        ? updateDeletedEntry(this.client, row.groupId, original, body)
        : updateVaultEntry(this.client, original, body)), 'Failed to save', () => {
        after();
        if (this.focusedRow()?.originalKey === original && this.focusedRow()?.groupId === row.groupId) this.focus = `${this.focus.charAt(0)}:${rowId(row.groupId, name)}`;
        return `Saved ${name}.`;
      });
      return;
    }
    if (newKey !== original) {
      this.say("A bot instance variable cannot be renamed here; rename it in the bot's Env editor. Nothing was saved.");
      return;
    }
    if (!newValue) {
      this.say("The value is empty, so nothing was saved. To remove a variable, use the bot's Env editor.");
      return;
    }
    await this.run(`the save of ${original}`, () => saveBotEnv(this.client, row.groupId, { vars: { [original]: newValue } }) as Promise<Outcome<Answer>>, 'Failed to save', (a) => {
      after();
      if (a.warning) return `${original} saved. ${a.warning}`;
      if (a.notApplied) return `${original} saved. The running bot still uses the old value until you Apply or Restart it.`;
      return `${original} saved.`;
    });
  }

  private askEntry(row: Row): void {
    const g = this.painted.find((x) => x.id === row.groupId);
    const where = row.type === 'standalone' ? 'the standalone vault' : `"${g?.name ?? row.groupId}"`;
    const last = row.type === 'deleted' && g && g.entries.length === 1 ? ' It is the group\'s last entry, so the group goes too.' : '';
    this.confirm = {
      lines: [`Delete ${row.originalKey} from ${where}? Its value cannot be recovered.${last}`],
      run: () => this.run(`the delete of ${row.originalKey}`, () => (row.type === 'deleted'
        ? removeDeletedEntry(this.client, row.groupId, row.originalKey)
        : removeVaultEntry(this.client, row.originalKey)), 'Failed to delete entry', () => {
        const now = this.rows.get(rowId(row.groupId, row.originalKey));
        if (now) now.dirty = false;
        return `Deleted ${row.originalKey}.`;
      }),
    };
    this.changed();
  }

  // deleteDeletedVaultGroup: the page's own question.
  private askGroup(g: VaultGroup): void {
    this.confirm = {
      lines: [`Remove "${g.name}" and all its saved credentials? This cannot be undone.`, '', `It holds ${g.entries.length} entr${g.entries.length === 1 ? 'y' : 'ies'}.`],
      run: () => this.run(`the removal of "${g.name}"`, () => removeDeletedGroup(this.client, g.id), 'Failed to remove category', () => `Removed "${g.name}".`),
    };
    this.changed();
  }

  // addVaultEntry: the key and the trimmed value, hidden unless turned off.
  private async add(): Promise<void> {
    const key = this.newKey.text.trim();
    const value = this.newValue.text.trim();
    if (!key) {
      this.say('A key is required to add an entry.');
      return;
    }
    await this.run(`the add of ${key}`, () => addVaultEntry(this.client, key, value, this.newHidden), 'Failed to add vault entry', () => {
      this.newKey = field();
      this.newValue = field();
      return `Added ${key}.`;
    });
  }

  /** The screen; a notice longer than the notice line is wrapped onto the last body lines instead of being cut. */
  view(inner: number, room: number): VaultView {
    const long = this.notice !== null && this.notice.length > inner ? wrap(this.notice, inner) : null;
    if (!long) return this.screenView(inner, room, this.notice ?? undefined);
    const space = Math.max(room - long.length - 1, 3);
    const v = this.screenView(inner, space, undefined);
    const body = v.body.slice(0, space);
    while (body.length < space) body.push('');
    return { ...v, body: [...body, '', ...long] };
  }

  private screenView(inner: number, room: number, notice: string | undefined): VaultView {
    if (this.confirm) return { body: ['Credentials Vault', '', ...this.confirm.lines.flatMap((l) => (l ? wrap(l, inner) : ['']))], keys: 'Y Delete  any other key Cancel', notice };
    if (!this.loaded) return { body: ['Credentials Vault', '', 'Reading the vault.'], keys: 'Esc Back', notice };
    const all: Line[] = [];
    const push = (text: string, extra: Partial<Line> = {}) => all.push({ text, ...extra });
    const wrapped = (text: string) => {
      for (const t of wrap(text, inner)) push(t);
    };
    push('Credentials Vault');
    if (this.loadError) wrapped(`Could not load the vault: ${this.loadError}; retrying.${this.groups.length ? ' The list below is from the last successful load.' : ''}`);
    // storeHealthBanner for vault.json.
    const h = this.health;
    if (h.secretKeyProblem) wrapped(`Secrets cannot be saved: ${h.secretKeyProblem}. Fix the key file and restart the manager.`);
    if (h.vaultBroken) wrapped('vault.json cannot be read, so saves are refused until it is repaired or replaced.');
    if (h.corruptCopies && h.corruptCopies.length) wrapped(`Copies of damaged vault.json kept beside it: ${h.corruptCopies.join(', ')}.`);
    push('');
    if (this.loadError && this.groups.length === 0) return { body: all.map((l) => l.text), keys: 'Ctrl+R Reread  Esc Back', notice };
    if (this.empty()) {
      push('No credentials yet.');
      push('Install a bot or add standalone entries.');
      return { body: all.map((l) => l.text), keys: 'Ctrl+R Reread  Esc Back', notice };
    }
    const groups = this.visibleGroups();
    for (const g of groups) {
      const open = this.expanded.has(g.id);
      const dup = g.type === 'deleted' && groups.some((o) => o !== g && o.type === 'deleted' && o.name === g.name);
      const date = dup && g.deletedAt ? `  ${this.date(g.deletedAt)}` : '';
      push(`${open ? 'v' : '>'} ${g.name}${date}  (${g.entries.length})`.slice(0, inner), { focus: `h:${g.id}` });
      if (!open) continue;
      for (const e of g.entries) all.push(this.rowLine(rowId(g.id, e.key), inner));
      if (g.type === 'standalone') {
        const nk = showField(this.newKey, KEY_WIDTH);
        const nv = showField(this.newValue, Math.max(inner - KEY_WIDTH - 5, 12), this.newHidden);
        const line = `  ${nk.text} ${nv.text}`;
        push(line, {
          focus: 'nk|nv',
          ...(this.focus === 'nk' ? { focus: 'nk', col: 2 + nk.col } : {}),
          ...(this.focus === 'nv' ? { focus: 'nv', col: 3 + KEY_WIDTH + nv.col } : {}),
        });
        push(`    [${this.newHidden ? 'x' : ' '}] Hidden (the value is masked in this list)`, { focus: 'nh' });
      }
    }
    const at = Math.max(all.findIndex((l) => l.focus === this.focus || (l.focus?.split('|').includes(this.focus) ?? false)), 0);
    const first = Math.max(0, Math.min(at - Math.floor(room / 2), all.length - room));
    const shown = all.slice(first, first + room);
    const focused = all[at];
    const line = at - first;
    if (this.busy) return { body: shown.map((l) => l.text), keys: 'Waiting for the manager', notice };
    return {
      body: shown.map((l) => l.text),
      ...(focused && focused.col !== undefined ? { cursor: { line, col: focused.col } } : { highlight: line }),
      keys: this.keys(),
      notice,
    };
  }

  private rowLine(id: string, inner: number): Line {
    const row = this.rows.get(id)!;
    const kf = showField(row.key, KEY_WIDTH);
    const vw = Math.max(inner - KEY_WIDTH - 5, 12);
    const vf = showField(row.value, vw, row.hidden);
    // The page's placeholder for a hidden value: the route's masked form, shown while nothing is typed.
    const valueText = row.hidden && row.value.text === '' ? `[${row.masked.slice(0, vw - 2).padEnd(vw - 2)}]` : vf.text;
    const text = `  ${kf.text} ${valueText}${row.dirty ? ' *' : ''}`;
    if (this.focus === `k:${id}`) return { text, focus: `k:${id}`, col: 2 + kf.col };
    if (this.focus === `v:${id}`) return { text, focus: `v:${id}`, col: 3 + KEY_WIDTH + (row.hidden && row.value.text === '' ? 1 : vf.col) };
    return { text, focus: `k:${id}|v:${id}` };
  }

  private keys(): string {
    if (this.focus.startsWith('h:')) {
      const g = this.focusedGroup();
      return ['Enter Open/close', ...(g?.type === 'deleted' ? ['Ctrl+D Remove group'] : []), 'Ctrl+R Reread', 'Esc Back'].join('  ');
    }
    if (this.focus === 'nh') return 'Space Hidden on/off  Enter Add  Esc Back';
    if (this.focus === 'nk' || this.focus === 'nv') return 'Enter Add  Tab Next  Esc Back';
    const row = this.focusedRow();
    return ['Enter Save', ...(row && row.type !== 'instance' ? ['Ctrl+D Delete'] : []), 'Tab Next', 'Ctrl+R Reread', 'Esc Back'].join('  ');
  }
}
