import { Client } from '../client';
import { Bot, botName, FsAnswer, fsCreate, fsDelete, FsEntry, fsList, FsListing, fsMkdir, fsRead, fsRename, fsWrite, readContainers } from './api';
import { hostDataRoot } from './dbtext';
import { Dialog, DialogKey } from './dialog';
import { EditRequest, EditResult } from './editbody';
import { editField, Field, field, FieldKey, showField } from './field';
import { wrap } from './install';
import { runningContainers } from './shell';

export interface FilesOptions {
  /** The time limit of each listing and file read. */
  limitMs?: number;
  /** The time limit of the containers read that finds the places. */
  containersLimitMs?: number;
  env?: NodeJS.ProcessEnv;
}

/** A write running for a bot: keys wait for it; Esc may leave only when `escape` is set. */
export interface FilesBusy {
  text: string;
  escape: boolean;
}

export interface FilesSource {
  bot(id: string | undefined): Bot | undefined;
  filesBusy: Map<string, FilesBusy>;
  sendBlock?(botId: string): string | null;
}

export interface FilesView {
  body: string[];
  highlight?: number;
  cursor?: { line: number; col: number };
  keys: string;
  notice?: string;
}

export type FilesExit = { quit: true } | { leave: true } | undefined;

type FilesKey = FieldKey & DialogKey & { escape?: boolean; return?: boolean };

const READ_LIMIT_MS = 15_000;
// The route waits up to 10 s for docker ps (dockerClient.ts:782) before its 503.
const CONTAINERS_LIMIT_MS = 20_000;

export const HOST = 'host';
export const LIST_CHANGED = 'The list changed; pick the row again with Up or Down.';

/** filesScopeLabel (index.html:5434). */
export function placeLabel(scope: string): string {
  return scope === HOST ? 'persistent data (host)' : `container ${scope}`;
}

/** joinPath (index.html:5426). */
export function joinPath(base: string, name: string): string {
  const out: string[] = [];
  for (const p of `${base}/${name}`.split('/')) {
    if (p === '' || p === '.') continue;
    if (p === '..') out.pop();
    else out.push(p);
  }
  return '/' + out.join('/');
}

/** parentPath (index.html:5432). */
export function parentPath(p: string): string {
  const t = p.replace(/\/+$/, '');
  const i = t.lastIndexOf('/');
  return i <= 0 ? '/' : t.slice(0, i);
}

const inside = (path: string, base: string): boolean => path === base || path.startsWith(`${base.replace(/\/+$/, '')}/`);

/**
 * Where the host place's folder is on the host, by hostBotDirFor's rule (containerManager.ts:118) for docker mode, and
 * the AppData folder itself in CasaOS mode (terminal.ts:103). Null when the base is not known yet.
 */
export function hostFolderLine(root: string | null, botId: string, base: string | null, path: string): string | null {
  if (base === null || !inside(path, base)) return null;
  if (/^\/DATA\/AppData\/[^/]+$/.test(base)) return `Folder on the host: ${path} (in the CasaOS Files app: ${path.slice('/DATA/'.length)})`;
  const rel = path.slice(base.replace(/\/+$/, '').length);
  return root ? `Folder on the host: ${root}/bots/${botId}/data${rel}` : `In the manager's data folder: bots/${botId}/data${rel}`;
}

const sentence = (text: string): string => (/[.!?]$/.test(text) ? text : `${text}.`);

/** The listing an action was pressed on: its place and folder are the ones the action sends. */
interface Where {
  scope: string;
  path: string;
}

interface Listing {
  seq: number;
  scope: string;
  asked: string;
  answer: FsAnswer<FsListing> | null;
}

type Row = { up: true } | { up: false; entry: FsEntry };

const rowKey = (r: Row): string => (r.up ? '..' : `${r.entry.isDir ? 'd' : 'f'}/${r.entry.name}`);

/** An edit nano made that is not saved yet. Its body lives only here and in nano. */
interface HeldEdit {
  where: Where;
  path: string;
  eol: 'lf' | 'crlf';
  body: string;
  /** Set when a save of this edit got no confirmed outcome: the file may already hold it. */
  unsure: boolean;
}

interface FormState {
  kind: 'newfile' | 'newfolder' | 'rename' | 'goto';
  where: Where;
  prompt: string;
  from?: string;
  f: Field;
}

/** The page's Files window (showFiles to hideFiles, index.html:5414 to :5618); the frame passes it every key. */
export class FilesScreen {
  places: string[] = [HOST];
  placesNote: string | null = null;
  placesReading = true;
  scope = HOST;
  cwd = '';
  hostBase: string | null = null;
  listing: Listing | null = null;
  cursor = 0;
  /** The row the operator picked (by place, folder and name); a press acts only while it is the row under the cursor. */
  picked: string | null = null;
  opening: { seq: number; path: string } | null = null;
  held: HeldEdit | null = null;
  form: FormState | null = null;
  confirm: Dialog | null = null;
  notice: string | null = null;
  private onCancel: () => void = () => undefined;
  private listSeq = 0;
  private openSeq = 0;
  private shown: Where | null = null;
  private closed = false;
  private readonly limitMs: number;
  private readonly containersLimitMs: number;
  private readonly root: string | null;

  constructor(
    private client: Client,
    private changed: () => void,
    readonly botId: string,
    private source: FilesSource,
    /** Hands a file to nano; false when the frame no longer shows this screen. */
    private openEditor: (request: EditRequest) => boolean,
    /** Takes an outcome that lands after this screen closed, so it reaches the bot screen. */
    private report: (text: string) => void,
    opts: FilesOptions = {},
  ) {
    this.limitMs = opts.limitMs ?? READ_LIMIT_MS;
    this.containersLimitMs = opts.containersLimitMs ?? CONTAINERS_LIMIT_MS;
    this.root = hostDataRoot(opts.env ?? process.env);
  }

  private name(): string {
    const b = this.source.bot(this.botId);
    return b ? botName(b) : this.botId;
  }

  get busy(): FilesBusy | null {
    return this.source.filesBusy.get(this.botId) ?? null;
  }

  private say(text: string | null): void {
    this.notice = text;
    this.changed();
  }

  /** An outcome: in this screen while it is open, else through the bot screen's notice. */
  private outcome(text: string): void {
    if (this.closed) this.report(text);
    else this.say(text);
  }

  open(): void {
    void this.list();
    void this.readPlaces();
  }

  /** hideFiles (index.html:5613): nothing read later lands, and the held edit is dropped. */
  close(): void {
    this.closed = true;
    this.listSeq++;
    this.openSeq++;
    this.opening = null;
    this.held = null;
    this.form = null;
    this.confirm = null;
  }

  // showFiles (:5445): persistent data first, then each running container.
  private async readPlaces(): Promise<void> {
    const r = await readContainers(this.client, this.botId, this.containersLimitMs);
    if (this.closed) return;
    this.placesReading = false;
    if (r.ok !== true) {
      this.placesNote = `Could not list the containers of ${this.name()}: ${sentence(r.text)} Only the persistent data can be browsed.`;
    } else {
      this.places = [HOST, ...runningContainers(r.value).map((c) => c.name)];
      this.placesNote = null;
    }
    this.changed();
  }

  // filesList (:5484): a newer read always wins over an older one.
  private async list(): Promise<void> {
    const seq = ++this.listSeq;
    const asked = { scope: this.scope, path: this.cwd };
    this.listing = { seq, scope: asked.scope, asked: asked.path, answer: null };
    this.changed();
    const r = await fsList(this.client, this.botId, asked.scope, asked.path, this.limitMs);
    if (this.closed || seq !== this.listSeq) return;
    this.listing = { seq, scope: asked.scope, asked: asked.path, answer: r };
    if (r.ok !== true) {
      this.shown = null;
      this.picked = null;
      this.changed();
      return;
    }
    this.cwd = r.value.path;
    if (asked.scope === HOST && asked.path === '') this.hostBase = r.value.path;
    const again = this.shown !== null && this.shown.scope === asked.scope && this.shown.path === r.value.path;
    this.shown = { scope: asked.scope, path: r.value.path };
    const rows = this.rows();
    if (again) {
      // A re-read of the same folder: the cursor stays, and keeps its pick only if the same row is still under it.
      this.cursor = Math.min(this.cursor, Math.max(rows.length - 1, 0));
      const under = rows[this.cursor];
      if (!under || rowKey(under) !== this.picked) this.picked = null;
    } else {
      this.cursor = 0;
      this.picked = rows.length ? rowKey(rows[0]) : null;
    }
    this.changed();
  }

  /** filesRelist (:5531): read the listing again only while the screen still shows the folder the action ran in. */
  private relist(where: Where): void {
    if (this.closed) return;
    const l = this.listing;
    if (l && l.answer?.ok === true && l.scope === where.scope && l.answer.value.path === where.path) void this.list();
  }

  private current(): (Where & { entries: FsEntry[] }) | null {
    const l = this.listing;
    if (!l || l.answer?.ok !== true) return null;
    return { scope: l.scope, path: l.answer.value.path, entries: l.answer.value.entries };
  }

  private canGoUp(path: string): boolean {
    if (path === '/' || path === '') return false;
    return !(this.scope === HOST && this.hostBase !== null && path === this.hostBase);
  }

  rows(): Row[] {
    const c = this.current();
    if (!c) return [];
    return [...(this.canGoUp(c.path) ? [{ up: true } as Row] : []), ...c.entries.map((entry) => ({ up: false, entry }) as Row)];
  }

  /** The row under the cursor, only while it is the one the operator picked. */
  private pickedRow(): Row | null {
    const r = this.rows()[this.cursor];
    return r && this.picked !== null && rowKey(r) === this.picked ? r : null;
  }

  // filesUp (:5522): the host place stops at its base.
  private up(): void {
    const from = this.cwd;
    if (this.scope === HOST) {
      if (this.hostBase === null) this.cwd = '';
      else {
        if (from === this.hostBase) return;
        const parent = parentPath(from);
        this.cwd = inside(parent, this.hostBase) ? parent : this.hostBase;
      }
    } else {
      if (from === '/' || from === '') return;
      this.cwd = parentPath(from);
    }
    void this.list();
  }

  private refusedPress(): void {
    if (this.rows().length === 0) return;
    this.picked = null;
    this.say(LIST_CHANGED);
  }

  private busyText(): string {
    return `A file change on ${this.name()} is still waiting for its answer; nothing was sent.`;
  }

  key(input: string, key: FilesKey, forwardDelete = false): FilesExit {
    if (this.confirm) {
      const c = this.confirm;
      const out = c.key(input, key);
      if (out === 'yes') {
        this.confirm = null;
        c.run();
        this.changed();
      } else if (out === 'cancel') {
        this.confirm = null;
        this.onCancel();
        this.changed();
      } else this.changed();
      return undefined;
    }
    const busy = this.busy;
    if (busy) return key.escape && busy.escape && !this.held ? { leave: true } : undefined;
    if (this.form) {
      this.formKey(input, key, forwardDelete);
      return undefined;
    }
    if (this.opening) {
      if (key.escape) {
        const path = this.opening.path;
        this.openSeq++;
        this.opening = null;
        this.say(`Stopped waiting for ${path}; nothing was opened.`);
      }
      return undefined;
    }
    if (this.held) {
      this.heldKey(input, key);
      return undefined;
    }
    if (key.escape) return { leave: true };
    const k = input.toLowerCase();
    if (k === 'q' && !key.ctrl) return { quit: true };
    const rows = this.rows();
    if (key.upArrow || key.downArrow) {
      if (rows.length === 0) return undefined;
      this.cursor = key.upArrow ? (this.cursor + rows.length - 1) % rows.length : (this.cursor + 1) % rows.length;
      this.picked = rowKey(rows[this.cursor]);
      this.notice = null;
      this.changed();
      return undefined;
    }
    if (key.leftArrow || key.backspace || (key.delete && !forwardDelete)) {
      this.notice = null;
      this.up();
      return undefined;
    }
    if (k === 'f' && !key.ctrl) {
      this.notice = null;
      void this.list();
      return undefined;
    }
    if (k === 'p' && !key.ctrl) {
      if (this.places.length < 2) {
        this.say(this.placesReading
          ? `Reading the containers of ${this.name()}; P offers them once they are listed.`
          : this.placesNote ?? `${this.name()} has no running containers, so only the persistent data can be browsed.`);
        return undefined;
      }
      this.scope = this.places[(Math.max(this.places.indexOf(this.scope), 0) + 1) % this.places.length];
      this.cwd = '';
      this.shown = null;
      this.notice = null;
      void this.list();
      return undefined;
    }
    if (k === 'g' && !key.ctrl) {
      const shownPath = this.current()?.path ?? this.cwd;
      this.form = { kind: 'goto', where: { scope: this.scope, path: shownPath }, prompt: `Go to a path in ${placeLabel(this.scope)}:`, f: field(shownPath) };
      this.notice = null;
      this.changed();
      return undefined;
    }
    const c = this.current();
    if (!c) return undefined;
    const where: Where = { scope: c.scope, path: c.path };
    if ((k === 'n' || k === 'k') && !key.ctrl) {
      const what = k === 'n' ? 'file' : 'folder';
      this.form = { kind: k === 'n' ? 'newfile' : 'newfolder', where, prompt: `New ${what} name in ${where.path} (${placeLabel(where.scope)}):`, f: field() };
      this.notice = null;
      this.changed();
      return undefined;
    }
    if (!key.return && !((k === 'r' || k === 'x') && !key.ctrl)) return undefined;
    const row = this.pickedRow();
    if (!row) {
      this.refusedPress();
      return undefined;
    }
    if (key.return) {
      this.notice = null;
      if (row.up) this.up();
      else if (row.entry.isDir) {
        this.cwd = joinPath(where.path, row.entry.name);
        void this.list();
      } else void this.openFile(where, row.entry.name);
      return undefined;
    }
    if (row.up) return undefined;
    const name = row.entry.name;
    const full = joinPath(where.path, name);
    if (k === 'r') {
      this.form = { kind: 'rename', where, from: name, prompt: `Rename ${full} to:`, f: field(name) };
      this.notice = null;
      this.changed();
      return undefined;
    }
    const ask = row.entry.isDir
      ? `Delete the folder ${full} and everything in it, in ${placeLabel(where.scope)}? This cannot be undone.`
      : `Delete ${full} in ${placeLabel(where.scope)}? This cannot be undone.`;
    this.ask([ask], 'Y Delete', () => void this.remove(where, full), () => this.say('Cancelled: nothing was sent.'));
    return undefined;
  }

  private ask(lines: string[], yes: string, run: () => void, cancel: () => void): void {
    this.confirm = new Dialog([`Files: ${this.name()}`, ''], (inner) => lines.flatMap((l) => (l ? wrap(l, inner) : [''])), yes, run);
    this.onCancel = cancel;
    this.notice = null;
    this.changed();
  }

  private formKey(input: string, key: FilesKey, forwardDelete: boolean): void {
    const form = this.form!;
    if (key.escape) {
      this.form = null;
      this.say(form.kind === 'goto' ? null : form.kind === 'rename' ? 'Nothing was renamed.' : 'Nothing was created.');
      return;
    }
    if (key.return) {
      this.form = null;
      this.submit(form);
      return;
    }
    const next = editField(form.f, input, key, forwardDelete);
    if (next) {
      form.f = next;
      this.changed();
    }
  }

  private submit(form: FormState): void {
    const text = form.f.text;
    if (form.kind === 'goto') {
      this.cwd = text.trim() || this.cwd;
      this.notice = null;
      void this.list();
      return;
    }
    if (form.kind === 'rename') {
      if (!text || text === form.from) {
        this.say('Nothing was renamed.');
        return;
      }
      void this.rename(form.where, form.from!, text, false);
      return;
    }
    if (!text) {
      this.say('Nothing was created.');
      return;
    }
    void this.create(form.where, joinPath(form.where.path, text), form.kind === 'newfolder');
  }

  private heldKey(input: string, key: FilesKey): void {
    const h = this.held!;
    const k = input.toLowerCase();
    if (key.escape) {
      this.ask(
        [`Discard the edit of ${h.path}? What was changed in nano is lost; the file in ${placeLabel(h.where.scope)} is not touched by this.`],
        'Y Discard',
        () => {
          if (this.held === h) this.held = null;
          this.say(`Discarded the edit of ${h.path}.`);
        },
        () => this.say(null),
      );
      return;
    }
    if (key.return) {
      this.notice = null;
      this.edit(h.where, h.path, h.body, h.eol, h);
      return;
    }
    if (k === 's' && !key.ctrl) this.askSave(h);
  }

  // filesOpenFile (:5535): the read for the listing the row came from; the newest read wins.
  private async openFile(where: Where, name: string): Promise<void> {
    const full = joinPath(where.path, name);
    const seq = ++this.openSeq;
    this.opening = { seq, path: full };
    this.changed();
    const r = await fsRead(this.client, this.botId, where.scope, full, this.limitMs);
    if (this.closed || seq !== this.openSeq) return;
    this.opening = null;
    if (r.ok === null) {
      this.say(`No answer from the manager, so ${full} can't be opened (${r.text}).`);
      return;
    }
    if (r.ok !== true) {
      this.say(`Could not open ${full}: ${sentence(r.text)}`);
      return;
    }
    this.edit(where, full, r.value.body, r.value.eol, null);
  }

  /** Hands the body to nano (M3's hand-off); `from` is the held edit being edited again, null for a fresh read. */
  private edit(where: Where, path: string, body: string, eol: 'lf' | 'crlf', from: HeldEdit | null): void {
    const request: EditRequest = { name: path, body, done: (result) => this.edited(where, path, eol, from, result) };
    if (!this.openEditor(request)) this.say(`${path} was read, but the editor could not be opened here; nothing was changed.`);
  }

  private edited(where: Where, path: string, eol: 'lf' | 'crlf', from: HeldEdit | null, result: EditResult): void {
    if (this.closed) return;
    if (!result.ok) {
      this.say(result.text);
      return;
    }
    if (!result.changed) {
      this.say(from ? `No further change to ${path}; the edit is still held.` : `No change to ${path}.`);
      return;
    }
    const h: HeldEdit = { where, path, eol, body: result.body, unsure: from?.unsure ?? false };
    this.held = h;
    this.askSave(h);
  }

  private askSave(h: HeldEdit): void {
    this.ask(
      [`Save ${h.path} in ${placeLabel(h.where.scope)}? It replaces the file as it is now; a change made to it since it was read is lost.`],
      'Y Save',
      () => void this.save(h),
      () => this.say(null),
    );
  }

  /** Runs one write under the bot's guard; null when another write holds it, so nothing is sent. */
  private async guarded<T>(text: string, escape: boolean, send: () => Promise<T>): Promise<T | null> {
    if (this.busy) {
      this.say(this.busyText());
      return null;
    }
    const block = this.source.sendBlock?.(this.botId);
    if (block) {
      this.say(block);
      return null;
    }
    const mine: FilesBusy = { text, escape };
    this.source.filesBusy.set(this.botId, mine);
    this.notice = null;
    this.changed();
    try {
      return await send();
    } finally {
      if (this.source.filesBusy.get(this.botId) === mine) this.source.filesBusy.delete(this.botId);
      this.changed();
    }
  }

  // filesSave (:5553), with eol from the read.
  private async save(h: HeldEdit): Promise<void> {
    const place = placeLabel(h.where.scope);
    const r = await this.guarded(`Saving ${h.path} in ${place}.`, false, () =>
      fsWrite(this.client, this.botId, { target: h.where.scope, path: h.path, body: h.body, eol: h.eol }));
    if (!r) return;
    if (r.ok === true) {
      if (this.held === h) this.held = null;
      this.outcome(`Saved ${h.path}`);
      this.relist(h.where);
      return;
    }
    if (r.ok === false) {
      this.outcome(`${h.path}: ${r.text}`);
      return;
    }
    h.unsure = true;
    this.outcome(r.ok === 'unsure'
      ? `Can't confirm the save of ${h.path}: ${r.text}`
      : `No answer from the manager (${r.text}), so the save of ${h.path} can't be confirmed. Refresh before trying again.`);
  }

  // filesNewFile (:5568) and filesNewFolder (:5579).
  private async create(where: Where, full: string, folder: boolean): Promise<void> {
    const place = placeLabel(where.scope);
    const what = folder ? 'folder' : 'file';
    const r = await this.guarded(`Creating the ${what} ${full} in ${place}.`, true, () =>
      (folder ? fsMkdir : fsCreate)(this.client, this.botId, where.scope, full));
    if (!r) return;
    // mkdir answers success whether it made the folder or found it there (terminal.ts:600, :1233); create is O_EXCL (:1089).
    if (r.ok === true) this.outcome(folder ? `The folder ${full} is there now` : `Created ${full}`);
    else if (r.ok === false) this.outcome(r.text);
    else this.outcome(r.ok === 'unsure'
      ? `Can't confirm the creation of ${full}: ${r.text}`
      : `No answer from the manager (${r.text}), so the creation of ${full} can't be confirmed. Refresh before trying again.`);
    this.relist(where);
  }

  // filesRename (:5596): `overwrite` only after its own Y on the route's `exists`.
  private async rename(where: Where, name: string, to: string, overwrite: boolean): Promise<void> {
    const from = joinPath(where.path, name);
    const dest = joinPath(where.path, to);
    const place = placeLabel(where.scope);
    const r = await this.guarded(`Renaming ${from} to ${dest} in ${place}.`, true, () =>
      fsRename(this.client, this.botId, { target: where.scope, from, to: dest, ...(overwrite ? { overwrite: true as const } : {}) }));
    if (!r) return;
    if (r.ok === false && r.exists && !overwrite) {
      if (this.closed) {
        this.report(r.text);
        return;
      }
      this.ask(
        [`${dest} already exists in ${place}. Replace it with ${from}? The current ${dest} will be lost.`],
        'Y Replace',
        () => void this.rename(where, name, to, true),
        () => {
          this.say('Nothing was renamed.');
          this.relist(where);
        },
      );
      return;
    }
    if (r.ok === true) this.outcome(`Renamed ${from} to ${dest}`);
    else if (r.ok === false) this.outcome(r.text);
    else this.outcome(r.ok === 'unsure'
      ? `Can't confirm the rename of ${from} to ${dest}: ${r.text}`
      : `No answer from the manager (${r.text}), so the rename of ${from} can't be confirmed. Refresh before trying again.`);
    this.relist(where);
  }

  // filesDelete (:5588).
  private async remove(where: Where, full: string): Promise<void> {
    const r = await this.guarded(`Deleting ${full} in ${placeLabel(where.scope)}.`, true, () => fsDelete(this.client, this.botId, where.scope, full));
    if (!r) return;
    if (r.ok === true) this.outcome(r.value.removed ? `Deleted ${full}` : `Nothing was at ${full}, so nothing was deleted`);
    else if (r.ok === false) this.outcome(r.text);
    else this.outcome(r.ok === 'unsure'
      ? `Can't confirm the delete of ${full}: ${r.text}`
      : `No answer from the manager (${r.text}), so the delete of ${full} can't be confirmed. Refresh before trying again.`);
    this.relist(where);
  }

  private head(inner: number): string[] {
    const name = this.name();
    const lines = wrap(`Files of ${name} in ${placeLabel(this.scope)}`, inner);
    const l = this.listing;
    const path = l?.answer?.ok === true ? l.answer.value.path : this.cwd || (this.scope === HOST ? this.hostBase ?? '' : '/');
    if (path) lines.push(...wrap(`Path: ${path}`, inner));
    if (this.scope === HOST && l?.answer?.ok === true) {
      const line = hostFolderLine(this.root, this.botId, this.hostBase, path);
      if (line) lines.push(...wrap(line, inner), ...wrap('No upload or download here: copy files to and from that folder on the host.', inner));
    }
    if (this.placesNote) lines.push(...wrap(this.placesNote, inner));
    return [...lines, ''];
  }

  private browseKeys(): string {
    const c = this.current();
    const row = this.pickedRow();
    const keys: string[] = [];
    if (this.rows().length) keys.push('Up/Down Pick');
    if (row) keys.push(row.up ? 'Enter Up' : row.entry.isDir ? 'Enter Open folder' : 'Enter Edit');
    if (c && this.canGoUp(c.path)) keys.push('Backspace Up');
    if (c) keys.push('N New file', 'K New folder');
    if (row && !row.up) keys.push('R Rename', 'X Delete');
    keys.push('G Go to', 'F Refresh');
    if (this.places.length > 1) keys.push('P Place');
    keys.push('Esc Back', 'Q Quit');
    return keys.join('  ');
  }

  view(inner: number, room: number, outer?: string): FilesView {
    const busy = this.busy;
    const notice = (busy ? busy.text : null) ?? this.notice ?? outer;
    const long = notice && notice.length > inner ? wrap(notice, inner) : null;
    const space = long ? Math.max(room - long.length - 1, 3) : room;
    const v = this.screen(inner, space, long ? undefined : notice ?? undefined);
    if (!long) return v;
    const body = v.body.slice(0, space);
    while (body.length < space) body.push('');
    return { ...v, body: [...body, '', ...long], notice: undefined };
  }

  private screen(inner: number, room: number, notice: string | undefined): FilesView {
    const busy = this.busy;
    const waiting = busy ? (busy.escape && !this.held ? 'Waiting for the manager  Esc Back' : 'Waiting for the manager') : null;
    if (this.confirm) {
      const d = this.confirm.view(inner, room);
      return { ...d, keys: waiting ?? d.keys, notice };
    }
    if (this.form) {
      const head = [`Files: ${this.name()}`, '', ...wrap(this.form.prompt, inner)];
      const f = showField(this.form.f, inner);
      return { body: [...head, f.text], cursor: { line: head.length, col: f.col }, keys: 'Enter OK  Esc Cancel', notice };
    }
    if (this.held) {
      const h = this.held;
      const body = [
        `Files: ${this.name()}`,
        '',
        ...wrap(h.unsure ? `Edited; whether it was saved can't be confirmed: ${h.path}` : `Edited, not saved: ${h.path}`, inner),
        ...wrap(`in ${placeLabel(h.where.scope)}`, inner),
        '',
        ...wrap('The edit stays here until it is saved or discarded; closing this screen drops it.', inner),
      ];
      return { body, keys: waiting ?? 'Enter Edit again  S Save  Esc Discard', notice };
    }
    const head = this.head(inner);
    const l = this.listing;
    if (this.opening) {
      return { body: head, keys: 'Waiting for the manager  Esc Stop waiting', notice: notice ?? `Reading ${this.opening.path}.` };
    }
    if (!l || l.answer === null) {
      const what = l?.asked ? `${l.asked} in ${placeLabel(l.scope)}` : placeLabel(this.scope);
      return { body: [...head, ...wrap(`Reading ${what}.`, inner)], keys: waiting ?? 'G Go to  F Refresh  Esc Back  Q Quit', notice };
    }
    const a = l.answer;
    if (a.ok !== true) {
      const what = l.asked ? `${l.asked} in ${placeLabel(l.scope)}` : placeLabel(l.scope);
      const text = a.ok === null
        ? `No answer from the manager, so ${what} can't be listed (${a.text}).`
        : `Could not list ${what}: ${sentence(a.text)}`;
      const keys = ['Backspace Up', 'G Go to', 'F Refresh', ...(this.places.length > 1 ? ['P Place'] : []), 'Esc Back', 'Q Quit'].join('  ');
      return { body: [...head, ...wrap(text, inner)], keys: waiting ?? keys, notice };
    }
    const rows = this.rows();
    if (rows.length === 0) return { body: [...head, 'Empty directory'], keys: waiting ?? this.browseKeys(), notice };
    const picked = this.pickedRow() !== null;
    const lines: string[] = [];
    let at = 0;
    let atLines = 1;
    rows.forEach((r, i) => {
      const text = r.up ? '../' : `${r.entry.name}${r.entry.isDir ? '/' : ''}`;
      const wrapped = wrap(text, inner - 4).map((w, j) => (j === 0 ? '  ' : '    ') + w);
      if (i === this.cursor) {
        at = lines.length;
        atLines = wrapped.length;
        if (picked) wrapped[0] = '>' + wrapped[0].slice(1);
      }
      lines.push(...wrapped);
    });
    if (a.value.entries.length === 0) lines.push('Empty directory');
    const rowRoom = Math.max(room - head.length, 1);
    const start = at + atLines > rowRoom ? Math.min(at, Math.max(lines.length - rowRoom, 0)) : 0;
    return {
      body: [...head, ...lines.slice(start, start + rowRoom)],
      highlight: picked ? head.length + at - start : undefined,
      keys: waiting ?? this.browseKeys(),
      notice,
    };
  }
}
