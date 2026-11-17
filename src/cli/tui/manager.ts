import {
  DeploymentInfo, ManagerLastUpdate, ManagerVersion, openManagerStream, postManagerUpdate, readDeployment, readManagerVersion, setDeployment,
} from './api';
import { Dialog, DialogKey } from './dialog';
import { wrap } from './install';
import type { Session } from './session';

export const MANAGER_RUNNING_NOTICE = 'A manager update is running; M follows it.';
export const READING_VERSION = 'Reading the version (git fetch, up to 30 s)';
// The page's confirm (index.html:1145) says the UI reconnects; under dbm.sh and dbm.ps1 the terminal closes instead.
export const UPDATE_QUESTION = "Update the Bot Manager now? It pulls, rebuilds and restarts the manager. If this terminal runs inside the manager's container (./dbm.sh, .\\dbm.ps1), it closes when the manager restarts; open it again and press M to see the outcome.";
/** updateManager's texts (index.html:1158 to :1163). */
export const UPDATE_NOT_CHANGED = 'Nothing was changed.';
export const UPDATE_NO_ANSWER = 'Whether the update started cannot be confirmed; check the version again.';
export const UPDATE_LIMIT = "can't confirm the manager update: no outcome within 15 min. The Manager screen shows the last update when the manager answers.";
/** resolveManagerReconnect's text for a new process with no record of the update (index.html:1118). */
export const NO_RECORD = 'The manager restarted but recorded no outcome for this update, so whether it applied cannot be confirmed.';

export const DEPLOYMENT_MODES = ['casaos', 'docker'] as const;
export type DeploymentModeName = (typeof DEPLOYMENT_MODES)[number];

export function modeQuestion(mode: DeploymentModeName): string {
  return `Set the deployment mode to ${mode}? The mode decides where each bot's data folder is: casaos uses /DATA/AppData/<app>, docker the manager's data folder. A bot deployed under the other mode starts on the new folder at its next Build or Update, and its data stays in the old one. Self-update runs only in docker mode.`;
}

/** The reads the Manager screen shows, kept in the Session; only the newest read started writes. */
export interface ManagerReads {
  version: { reading: boolean; value: ManagerVersion | null; error: string | null };
  deployment: { reading: boolean; value: DeploymentInfo | null; error: string | null };
  versionSeq: number;
  deploySeq: number;
  /** A read was asked to join a running update; whichever read answers last does it, so a newer read never drops it. */
  joinPending: boolean;
  /** The newest version read; an older one waits for it, so its caller sees the outcome. */
  versionRead: Promise<void> | null;
}

const MAX_LINES = 2000;
const FOLLOWED = ['running', 'restarting', 'pending'];
// The states resolveManagerReconnect ends on while the same process answers (index.html:1104).
const FINAL_SAME_BOOT = ['applied', 'noop', 'failed', 'unknown'];
const UNKNOWN_TITLE = 'Update outcome unknown';
const UNKNOWN_TOAST = 'Manager update: outcome unknown';
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const refusedText = (text: string): string => text || 'the manager gave no reason';

export function liveFollow(session: Session): ManagerFollow | null {
  const f = session.managerFollow;
  return f && !f.end ? f : null;
}

/** GET /api/manager/version; with `join`, an answer that shows a running update starts following it (the page's loadManagerVersion, :1026). */
export function readVersion(session: Session, join: boolean): Promise<void> {
  const m = session.manager;
  if (join) m.joinPending = true;
  const read = readOnce(session, ++m.versionSeq);
  m.versionRead = read;
  return read;
}

async function readOnce(session: Session, seq: number): Promise<void> {
  const m = session.manager;
  m.version = { ...m.version, reading: true };
  session.changed();
  const r = await readManagerVersion(session.client, session.managerTimes.readMs);
  if (session.isStopped) return;
  if (seq !== m.versionSeq) {
    await m.versionRead;
    return;
  }
  m.version = r.ok === true
    ? { reading: false, value: r.value, error: null }
    : { reading: false, value: null, error: r.ok === false ? refusedText(r.text) : r.text };
  const join = m.joinPending;
  m.joinPending = false;
  if (r.ok === true && r.value.updateInProgress && join) joinUpdate(session, r.value);
  session.changed();
}

/** The Session's one read at start: a running update gives the list notice. */
export async function startRead(session: Session): Promise<void> {
  await readVersion(session, false);
  const v = session.manager.version.value;
  if (v?.updateInProgress && !liveFollow(session) && !session.isStopped) {
    session.notice = MANAGER_RUNNING_NOTICE;
    session.changed();
  }
}

export async function readDeploy(session: Session): Promise<void> {
  const m = session.manager;
  const seq = ++m.deploySeq;
  m.deployment = { ...m.deployment, reading: true };
  session.changed();
  const r = await readDeployment(session.client, session.managerTimes.deployReadMs);
  if (seq !== m.deploySeq || session.isStopped) return;
  m.deployment = r.ok === true
    ? { reading: false, value: r.value, error: null }
    : { reading: false, value: null, error: r.ok === false ? refusedText(r.text) : r.text };
  session.changed();
}

/** Follows the running update; a follow already running is kept, so a reopened screen never starts a second one. */
export function joinUpdate(session: Session, v: ManagerVersion | null): ManagerFollow {
  const live = liveFollow(session);
  if (live) return live;
  const f = new ManagerFollow(session, v?.bootId ?? null);
  session.managerFollow = f;
  void f.join(v);
  return f;
}

/**
 * One manager update followed from the terminal: the /ws frames of its opId (manager.ts:60 to :78) and, every
 * pollMs, GET /version judged as the page's resolveManagerReconnect (index.html:1091 to :1123). It lives in the
 * Session, so Esc and a reopened screen keep it.
 */
export class ManagerFollow {
  opId: string | null = null;
  lines: string[] = [];
  title = 'Updating Bot Manager';
  /** ok is null when the outcome is unknown. */
  end: { ok: boolean | null; text: string } | null = null;
  /** True from Y until the POST answers. */
  sending = false;
  private kept: Array<{ type: string; data: Record<string, unknown> }> = [];
  private stream: { close: () => void } | null = null;
  private timer: NodeJS.Timeout | null = null;
  private startedAt = 0;
  private polling = false;
  private following = false;
  private stopped = false;

  constructor(private readonly session: Session, private readonly baseBootId: string | null) {}

  private add(line: string): void {
    this.lines.push(line);
    if (this.lines.length > MAX_LINES) this.lines.splice(0, this.lines.length - MAX_LINES);
  }

  private async open(): Promise<string | null> {
    const s = openManagerStream(this.session.client, (type, data) => this.frame(type, data), (reason) => this.lost(reason));
    this.stream = s;
    const failed = await s.opened;
    if (failed !== null) {
      s.close();
      this.stream = null;
    }
    return failed;
  }

  /** U's Y: /ws first, then one POST (commands.ts:111 to :131); nothing is sent when /ws does not open. */
  async update(): Promise<void> {
    this.sending = true;
    this.add('Starting update...');
    this.session.changed();
    const failed = await this.open();
    if (this.stopped) return;
    if (failed !== null) {
      this.sending = false;
      this.finish(false, `The manager's event stream did not open (${failed}), so nothing was sent.`, 'Update not started', 'Manager update not started');
      return;
    }
    const r = await postManagerUpdate(this.session.client);
    this.sending = false;
    if (this.stopped) return;
    if (r.ok !== true) {
      this.add(`Error: ${r.text}`);
      this.finish(null, UPDATE_NO_ANSWER, UNKNOWN_TITLE, UNKNOWN_TOAST);
      return;
    }
    const b = r.value;
    if (b.success === true) {
      if (!str(b.opId)) {
        this.add('Error: the manager accepted the update but named no operation id');
        this.finish(null, UPDATE_NO_ANSWER, UNKNOWN_TITLE, UNKNOWN_TOAST);
        return;
      }
      this.opId = str(b.opId);
      this.follow();
      return;
    }
    if (b.inProgress === true) {
      this.add('An update is already running; following it.');
      this.follow();
      void this.poll();
      return;
    }
    this.add(`Error: ${str(b.error) || 'could not start update'}`);
    this.finish(false, UPDATE_NOT_CHANGED, 'Update not started', 'Manager update not started');
  }

  /** Follows an update that is already running; its opId is the record's while it runs (selfUpdate.ts:509). */
  async join(v: ManagerVersion | null): Promise<void> {
    const lu = v?.lastUpdate;
    if (lu && FOLLOWED.includes(str(lu.state)) && str(lu.opId)) this.opId = str(lu.opId);
    this.add('An update is running; following it.');
    this.session.changed();
    const failed = await this.open();
    if (this.stopped) return;
    if (failed !== null) this.add(`The manager's event stream did not open (${failed}); reading the version until the outcome shows.`);
    this.follow();
    void this.poll();
  }

  private follow(): void {
    this.startedAt = this.session.clock();
    this.following = true;
    this.timer = setInterval(() => void this.poll(), this.session.managerTimes.pollMs);
    this.timer.unref?.();
    this.replay();
    this.session.changed();
  }

  // Frames held until an opId is known are judged in their order once it is.
  private replay(): void {
    if (!this.opId) return;
    const held = this.kept.splice(0);
    for (const f of held) {
      if (this.end) return;
      if (f.data.opId === this.opId) this.handle(f.type, f.data);
    }
  }

  private frame(type: string, data: Record<string, unknown>): void {
    if (this.end || this.stopped) return;
    if (!this.opId || !this.following) {
      this.kept.push({ type, data });
      if (this.kept.length > MAX_LINES) this.kept.shift();
      return;
    }
    if (data.opId !== this.opId) return;
    this.handle(type, data);
  }

  // The page's ws handler (index.html:1341 to :1366).
  private handle(type: string, d: Record<string, unknown>): void {
    if (type === 'manager:log') this.add(str(d.line));
    else if (type === 'manager:restarting') {
      this.add('Manager restarting - waiting for it to come back...');
      this.title = 'Restarting Bot Manager...';
    } else if (type === 'manager:update-pending') {
      this.add(str(d.message) || 'The recreate is still running; this page reconnects when it finishes.');
      this.title = 'Recreate still running';
    } else if (type === 'manager:update-complete') {
      const state = str(d.state);
      const message = str(d.message);
      // The route sends a failed outcome on this event too (selfUpdate.ts:535, manager.ts:72).
      if (state === 'applied') this.finish(true, message || 'Update applied.', 'Bot Manager updated', 'Bot Manager updated');
      else if (state === 'failed') this.finish(false, message || 'The update did not finish.', 'Update did not apply', 'Manager update did not apply');
      else this.finish(true, message || 'Nothing to apply.', 'Nothing to apply', 'Bot Manager: nothing to apply');
      return;
    } else if (type === 'manager:update-failed') {
      this.finish(false, `Update failed: ${str(d.error) || 'unknown error'}`, 'Update failed', 'Manager update failed');
      return;
    } else return;
    this.session.changed();
  }

  private lost(reason: string): void {
    if (this.end || this.stopped) return;
    this.stream = null;
    this.add(`The manager's event stream closed (${reason}); reading the version until the outcome shows.`);
    this.session.changed();
  }

  private async poll(): Promise<void> {
    if (this.end || this.stopped || this.polling || !this.following) return;
    if (this.session.clock() - this.startedAt >= this.session.managerTimes.limitMs) {
      this.finish(null, UPDATE_LIMIT, UNKNOWN_TITLE, UNKNOWN_TOAST);
      return;
    }
    this.polling = true;
    const r = await readManagerVersion(this.session.client, this.session.managerTimes.readMs);
    this.polling = false;
    if (this.end || this.stopped) return;
    // The page's poll is quiet: a read that fails waits for the next one.
    if (r.ok !== true) return;
    this.judge(r.value);
  }

  /** resolveManagerReconnect (index.html:1091 to :1123). */
  judge(v: ManagerVersion): void {
    const lu = v.lastUpdate && typeof v.lastUpdate === 'object' ? v.lastUpdate : null;
    if (!this.opId && lu && FOLLOWED.includes(str(lu.state)) && str(lu.opId)) {
      this.opId = str(lu.opId);
      this.replay();
      if (this.end) return;
    }
    const ours = !!lu && (!this.opId || lu.opId === this.opId);
    if (this.baseBootId && v.bootId === this.baseBootId) {
      if (!v.updateInProgress && ours && FINAL_SAME_BOOT.includes(str(lu!.state))) this.fromLast(lu!);
      return;
    }
    if (ours && FOLLOWED.includes(str(lu!.state))) return;
    if (ours) {
      this.fromLast(lu!);
      return;
    }
    this.finish(null, NO_RECORD, UNKNOWN_TITLE, UNKNOWN_TOAST);
  }

  /** finishFromLastUpdate (index.html:1076 to :1088), without the reload. */
  private fromLast(lu: ManagerLastUpdate): void {
    const message = str(lu.message);
    if (lu.state === 'applied') this.finish(true, message || 'Updated.', 'Bot Manager updated', 'Bot Manager updated');
    else if (lu.state === 'noop') this.finish(true, message || 'Nothing to apply.', 'Nothing to apply', 'Bot Manager: nothing to apply');
    else if (lu.state === 'unstamped' || lu.state === 'unknown') this.finish(null, message || 'The outcome of the update is unknown.', UNKNOWN_TITLE, UNKNOWN_TOAST);
    else this.finish(false, message || 'The update did not finish.', 'Update did not apply', 'Manager update did not apply');
  }

  private finish(ok: boolean | null, line: string, title: string, toast: string): void {
    if (this.end) return;
    this.add(line);
    this.title = title;
    this.end = { ok, text: toast };
    this.halt();
    this.session.notice = toast;
    this.session.changed();
    void readVersion(this.session, false);
  }

  private halt(): void {
    this.following = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const s = this.stream;
    this.stream = null;
    s?.close();
  }

  stop(): void {
    this.stopped = true;
    this.halt();
  }
}

export type ManagerExit = { quit: true } | { leave: true } | undefined;
type ManagerKey = DialogKey & { escape?: boolean; return?: boolean; end?: boolean };
type Stage = 'main' | 'update' | 'ask-update' | 'pick-mode' | 'ask-mode' | 'setting-mode';

function when(at: string | undefined): string {
  if (!at) return 'an unknown time';
  const t = Date.parse(at);
  return Number.isNaN(t) ? at : `${new Date(t).toISOString().slice(0, 19).replace('T', ' ')} UTC`;
}

/** The version lines with the page's words (index.html:1009 to :1023). */
function lastUpdateLine(v: ManagerVersion): string {
  const lu = v.lastUpdate;
  return lu ? `Last update: ${lu.state || 'unknown'} at ${when(lu.at)}${lu.message ? `: ${lu.message}` : ''}` : 'Last update: none recorded.';
}

export function versionLines(reads: ManagerReads): string[] {
  const st = reads.version;
  if (st.reading) return [READING_VERSION, ...(st.value ? [lastUpdateLine(st.value)] : [])];
  if (st.error !== null) return [`Could not read the version: ${st.error}`];
  const v = st.value;
  if (!v) return ['The version has not been read yet.'];
  const out: string[] = [];
  if (v.supported === false) {
    if (v.currentCommit) out.push(`Version: ${v.stamped === false ? 'unstamped build' : `v${v.currentCommit}`}`);
    out.push(`Self-update is not available: ${v.reason || 'the manager gave no reason'}`);
  } else {
    out.push(v.stamped ? `Version: v${v.currentCommit || '?'}` : `Version: unstamped build (the checkout is at ${v.repoCommit || '?'})`);
    if (v.checked === false) out.push(`could not check for updates: ${v.fetchError || 'git fetch failed'}`);
    if (v.updateInProgress) out.push('An update is running.');
    else if (v.updateAvailable) {
      const why = (v.behindBy ?? 0) > 0 ? `${v.behindBy} behind` : v.buildStale ? 'build behind the checkout' : 'stack not applied';
      out.push(`Update available: ${why}`);
    } else if (v.checked !== false) out.push('No update available.');
  }
  out.push(lastUpdateLine(v));
  return out;
}

/** GET /api/system/deployment as lines (plan section 3.4). */
export function deploymentLines(reads: ManagerReads): string[] {
  const d = reads.deployment;
  if (d.reading) return ['Reading the deployment mode.'];
  if (d.error !== null) return [`Could not read the deployment mode: ${d.error}`];
  const v = d.value;
  if (!v) return ['The deployment mode has not been read yet.'];
  const how = v.forcedByEnv ? 'forced by DEPLOYMENT_MODE' : v.autoDetected === false ? 'set by the operator' : 'detected';
  return [`Deployment mode: ${v.mode || '?'} (${how})`, `CasaOS found: ${v.casaosAvailable ? 'yes' : 'no'}`];
}

function scrollWindow(lines: string[], room: number, scroll: number): string[] {
  const end = Math.max(lines.length - scroll, Math.min(room, lines.length));
  return lines.slice(Math.max(0, end - room), end);
}

/** The Manager screen: version, last update, deployment mode, U and D, and the update view. */
export class ManagerScreen {
  stage: Stage = 'main';
  pick = 0;
  scroll = 0;
  private dialog: Dialog | null = null;
  private closed = false;
  private settingMode: DeploymentModeName | null = null;

  constructor(private readonly session: Session) {}

  open(): void {
    const s = this.session;
    void readDeploy(s);
    if (liveFollow(s)) this.stage = 'update';
    this.readVersion();
  }

  close(): void {
    this.closed = true;
    this.dialog = null;
  }

  // A read that starts a follow shows the update view, as the page opens its log (index.html:1026).
  private readVersion(): void {
    const s = this.session;
    const before = s.managerFollow;
    void readVersion(s, true).then(() => {
      if (this.closed || this.stage !== 'main') return;
      if (s.managerFollow !== before && liveFollow(s)) {
        this.stage = 'update';
        this.scroll = 0;
        s.changed();
      }
    });
  }

  private canUpdate(): boolean {
    const st = this.session.manager.version;
    const v = st.value;
    return !st.reading && !!v && v.supported === true && v.updateAvailable === true && !v.updateInProgress && !liveFollow(this.session);
  }

  private canMode(): boolean {
    const d = this.session.manager.deployment;
    // A failed read shows no mode as current; a forced mode still answers 409 (detector.ts:170).
    return !d.reading && (d.value ? d.value.forcedByEnv !== true : d.error !== null) && !this.session.deploymentBusy;
  }

  private startUpdate(): void {
    const s = this.session;
    if (liveFollow(s)) return;
    const f = new ManagerFollow(s, s.manager.version.value?.bootId ?? null);
    s.managerFollow = f;
    this.stage = 'update';
    this.scroll = 0;
    void f.update();
  }

  private async setMode(mode: DeploymentModeName): Promise<void> {
    const s = this.session;
    if (s.deploymentBusy) return;
    s.deploymentBusy = mode;
    this.settingMode = mode;
    this.stage = 'setting-mode';
    s.changed();
    let text: string;
    try {
      const a = await setDeployment(s.client, mode);
      if (a.kind === 'set') {
        text = `Deployment mode set to ${mode}.`;
        s.manager.deploySeq++;
        s.manager.deployment = { reading: false, value: a.info, error: null };
      } else if (a.kind === 'saved') {
        text = a.text;
        void readDeploy(s);
      } else {
        text = a.kind === 'refused' ? a.text : `can't confirm whether the mode changed: ${a.text}`;
        void readDeploy(s);
      }
    } finally {
      s.deploymentBusy = null;
    }
    if (s.isStopped) return;
    // The list carries the mode the delete dialog names, and the version read decides U.
    s.reread();
    void readVersion(s, false);
    s.notice = text;
    if (!this.closed && this.stage === 'setting-mode') this.stage = 'main';
    s.changed();
  }

  key(input: string, key: ManagerKey): ManagerExit {
    const s = this.session;
    const k = input.toLowerCase();
    if (this.stage === 'setting-mode') {
      if (key.escape) {
        this.stage = 'main';
        s.changed();
      }
      return undefined;
    }
    if ((this.stage === 'ask-update' || this.stage === 'ask-mode') && this.dialog) {
      const d = this.dialog;
      const out = d.key(input, key);
      if (out === null) {
        s.changed();
        return undefined;
      }
      this.dialog = null;
      if (out === 'yes') {
        d.run();
        return undefined;
      }
      s.notice = this.stage === 'ask-update' ? 'Cancelled: the manager was not updated.' : 'Cancelled: the deployment mode was not changed.';
      this.stage = 'main';
      s.changed();
      return undefined;
    }
    if (k === 'q') return { quit: true };
    if (this.stage === 'update') {
      if (key.upArrow) this.scroll++;
      else if (key.downArrow) this.scroll = Math.max(0, this.scroll - 1);
      else if (key.end) this.scroll = 0;
      else if (key.escape) {
        this.stage = 'main';
        this.scroll = 0;
        this.readVersion();
      }
      s.changed();
      return undefined;
    }
    if (this.stage === 'pick-mode') {
      if (key.escape) this.stage = 'main';
      else if (key.upArrow || key.downArrow) this.pick = (this.pick + 1) % DEPLOYMENT_MODES.length;
      else if (key.return && this.canMode()) {
        const mode = DEPLOYMENT_MODES[this.pick];
        this.stage = 'ask-mode';
        this.dialog = new Dialog(['Deployment mode', ''], (width) => wrap(modeQuestion(mode), width), `Y Set ${mode}`, () => void this.setMode(mode));
      }
      s.changed();
      return undefined;
    }
    if (key.escape) return { leave: true };
    if (k === 'r') {
      this.readVersion();
      void readDeploy(s);
    } else if (k === 'u' && this.canUpdate()) {
      this.stage = 'ask-update';
      this.dialog = new Dialog(['Bot Manager', ''], (width) => wrap(UPDATE_QUESTION, width), 'Y Update manager', () => this.startUpdate());
    } else if (k === 'd' && this.canMode()) {
      this.stage = 'pick-mode';
      this.pick = Math.max(DEPLOYMENT_MODES.indexOf(s.manager.deployment.value?.mode as DeploymentModeName), 0);
    } else if (k === 'l' && s.managerFollow) {
      this.stage = 'update';
      this.scroll = 0;
    } else return undefined;
    s.changed();
    return undefined;
  }

  view(width: number, room: number, notice?: string): { body: string[]; highlight?: number; keys: string; notice?: string } {
    const s = this.session;
    if ((this.stage === 'ask-update' || this.stage === 'ask-mode') && this.dialog) return { ...this.dialog.view(width, room), notice };
    const long = !!notice && notice.length > width;
    const tail = long ? ['', ...wrap(notice!, width)] : [];
    const shown = long ? undefined : notice;
    if (this.stage === 'update') {
      const f = s.managerFollow;
      if (!f) return { body: ['No manager update has run in this session.', ...tail], keys: 'Esc Back  Q Quit', notice: shown };
      const head = [...wrap(f.title, width), ''];
      const lines = f.lines.flatMap((l) => (l ? wrap(l, width) : ['']));
      const foot = f.end ? [] : ['', ...wrap(f.sending ? 'Waiting for the manager to answer the update request.' : 'The update runs on if you leave this view.', width)];
      const win = scrollWindow(lines, Math.max(room - head.length - foot.length - tail.length, 1), this.scroll);
      return { body: [...head, ...win, ...foot, ...tail], keys: 'Up/Down Scroll  End Follow  Esc Back  Q Quit', notice: shown };
    }
    if (this.stage === 'setting-mode') {
      return {
        body: ['Deployment mode', '', ...wrap(`Asked the manager to set the deployment mode to ${this.settingMode ?? '?'}; waiting for the answer.`, width), ...tail],
        keys: 'Esc Back',
        notice: shown,
      };
    }
    if (this.stage === 'pick-mode') {
      const cur = s.manager.deployment.value?.mode;
      const head = ['Deployment mode', ''];
      const rows = DEPLOYMENT_MODES.map((m, i) => `${i === this.pick ? '>' : ' '} ${m}${m === cur ? '  (current)' : ''}`);
      return {
        body: [...head, ...rows, ...tail],
        highlight: head.length + this.pick,
        keys: 'Enter Choose  Up/Down Pick  Esc Back  Q Quit',
        notice: shown,
      };
    }
    const f = s.managerFollow;
    const followLine = !f ? [] : f.end ? [`Update in this session: ${f.end.text}. L shows its log.`] : ['An update started or joined in this session is running. L shows its log.'];
    const body = [
      'Bot Manager',
      '',
      ...versionLines(s.manager).flatMap((l) => wrap(l, width)),
      '',
      ...deploymentLines(s.manager).flatMap((l) => wrap(l, width)),
      ...(followLine.length ? ['', ...followLine.flatMap((l) => wrap(l, width))] : []),
      ...tail,
    ];
    const keys = [
      ...(this.canUpdate() ? ['U Update manager'] : []),
      ...(this.canMode() ? ['D Deployment mode'] : []),
      ...(f ? ['L Update log'] : []),
      'R Read again',
      'Esc Back',
      'Q Quit',
    ].join('  ');
    return { body, keys, notice: shown };
  }
}
