import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type * as Ink from 'ink';
import {
  ActionKind, Bot, botName, buildFrameLine, buildLogPath, Container, containerFrameLine, containerLogPath, listContainers, readContainers, StreamLines,
} from './api';
import { runningContainers } from './shell';
import { DeleteExit, DeleteScreen } from './botdelete';
import { WebAuthExit, WebAuthScreen } from './webauth';
import { isForwardDelete } from './field';
import { clock, copyText, dataText, lastBackupText, listHeader, listRow, statusText, updateText } from './format';
import { codeScreen, CodeShown, PASTE_OFF, PASTE_ON, PasteReader } from './codes';
import { ConfigEditor, ConfigExit, ConfigOptions } from './configedit';
import { DatabaseExit, DatabaseOptions, DatabaseScreen } from './database';
import { Dialog } from './dialog';
import { databaseBadges, hasDatabaseScreen, heldWarningText, hostDataRoot, orphanLines, startOffRefusal, stateName, timeIn } from './dbtext';
import { StateExit, StateOptions, StateScreen } from './statescreen';
import { EditRequest } from './editbody';
import { EditorExit, EditorOptions, EnvEditor } from './envedit';
import { FilesExit, FilesOptions, FilesScreen } from './files';
import { InstallWizard, WizardExit, WizardOptions, wrap } from './install';
import { ManagerExit, ManagerScreen } from './manager';
import { Session } from './session';
import { VaultExit, VaultOptions, VaultScreen } from './vaultscreen';

export type InkApi = typeof Ink;

export type Screen = 'list' | 'bot' | 'confirm' | 'action' | 'containers' | 'logs' | 'buildlogs' | 'install' | 'env' | 'config' | 'vault' | 'database' | 'state' | 'code' | 'shell' | 'files' | 'delete' | 'webauth' | 'manager';

export interface FrameState {
  screen: Screen;
  index: number;
  botId?: string;
  kind?: ActionKind;
  container?: string;
  pick?: number;
  notice?: string;
}

export interface AppProps {
  machine: string;
  session: Session;
  initial?: FrameState;
  onHandOff: (state: FrameState) => void;
  /** Hands the terminal to the editor for a config body; the frame is drawn again at `state` afterwards. */
  onEdit?: (state: FrameState, request: EditRequest) => void;
  /** Hands the terminal to a shell in the named container; the frame is drawn again at `state` afterwards. */
  onShell?: (state: FrameState, container: string) => void;
  shellOptions?: { readLimitMs?: number };
  filesOptions?: FilesOptions;
  canHandOff?: boolean;
  now?: () => number;
  wizardOptions?: WizardOptions;
  envOptions?: EditorOptions;
  configOptions?: ConfigOptions;
  vaultOptions?: VaultOptions;
  databaseOptions?: DatabaseOptions;
  stateOptions?: StateOptions;
  /** Writes a terminal mode sequence (bracketed paste on and off); Ink's stdout by default. */
  writeMode?: (sequence: string) => void;
}

export interface View {
  body: string[];
  highlight?: number;
  /** The text cursor of a focused field: a body line and a column in it. */
  cursor?: { line: number; col: number };
  keys: string;
  notice?: string;
}

function fit(text: string, width: number): string {
  return text.length > width ? text.slice(0, width) : text.padEnd(width);
}

/** Lines between the title bar and the notice line. */
export function bodyRows(rows: number): number {
  return Math.max(rows - 1, 10) - 4;
}

export function frameLines(machine: string, view: View, columns: number, rows: number): string[] {
  // One column short of the edge: some terminals wrap a line that fills the last column.
  const width = Math.max(columns - 1, 20);
  const inner = width - 4;
  const titleText = `+ Bot Manager - ${machine} `;
  const top = fit(titleText + '-'.repeat(Math.max(width - titleText.length - 1, 0)), width - 1) + '+';
  const keys = keyLines(view.keys, inner);
  const room = bodyRows(rows) - (keys.length - 1);
  const body = view.body.slice(0, room);
  while (body.length < room) body.push('');
  body.push(view.notice ?? '');
  body.push(...keys);
  const bottom = '+' + '-'.repeat(width - 2) + '+';
  return [top, ...body.map((line) => `| ${fit(line, inner)} |`), bottom];
}

/** The key bar in lines of the inner width, broken between keys; each line past the first takes a body line. */
export function keyLines(keys: string, inner: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const k of keys.split('  ')) {
    const next = line ? `${line}  ${k}` : k;
    if (line && next.length > inner) {
      lines.push(line);
      line = k;
    } else line = next;
  }
  lines.push(line);
  return lines;
}

export function innerWidth(columns: number): number {
  return Math.max(columns - 1, 20) - 4;
}

/** A labelled value, wrapped at spaces onto lines indented under the value. */
export function fieldLines(label: string, value: string, width: number): string[] {
  const indent = 13;
  const room = Math.max(width - indent, 10);
  const lines: string[] = [];
  let rest = value;
  while (rest.length > room) {
    const cut = rest.lastIndexOf(' ', room);
    const at = cut > 0 ? cut : room;
    lines.push(rest.slice(0, at));
    rest = rest.slice(at).trimStart();
  }
  lines.push(rest);
  return lines.map((l, i) => (i === 0 ? label.padEnd(indent) : ' '.repeat(indent)) + l);
}

/** The window of a scrolling view: `scroll` lines up from the end, 0 follows the end. */
export function scrollWindow(lines: string[], room: number, scroll: number): string[] {
  const end = Math.max(lines.length - scroll, Math.min(room, lines.length));
  return lines.slice(Math.max(0, end - room), end);
}

const SCROLL_KEYS = 'Up/Down Scroll  End Follow  Esc Back  Q Quit';
// Offered only when DBM_TUI_CHECK_HANDOFF names a command (the terminal check).
const HANDOFF_KEY = 'H Hand-off';

// The route waits up to 10 s for docker ps (dockerClient.ts:782) before its 503.
const SHELL_READ_MS = 20_000;
const sentence = (text: string): string => (/[.!?]$/.test(text) ? text : `${text}.`);

const KIND_LABEL: Record<ActionKind, string> = { start: 'Start', stop: 'Stop', restart: 'Restart', build: 'Build', update: 'Update' };

// The held warning (index.html:3740) joins the question when the bot holds changes it could not save.
function confirmText(kind: ActionKind, bot: Bot): string[] {
  const name = botName(bot);
  const action = kind === 'stop' ? 'stop' : kind === 'update' ? 'update' : 'restart';
  const warning = heldWarningText(bot, action);
  const head = kind === 'stop' ? [`Stop ${name}?`, '', 'The bot goes offline until it is started again.']
    : kind === 'update' ? [`Update ${name}?`, '', 'The bot is recreated from its source.']
      : [`Restart ${name}?`, '', 'The bot goes offline while its containers restart.'];
  return warning ? [...head, '', warning] : head;
}

function waitingText(kind: ActionKind, name: string): string {
  return {
    start: `Asked the manager to start ${name}; waiting for the result.`,
    stop: `Asked the manager to stop ${name}; waiting for the answer.`,
    restart: `Asked the manager to restart ${name}; waiting for the result.`,
    build: `Asked the manager to build ${name}; waiting for the result.`,
    update: `Asked the manager to update ${name} from its source; waiting for the result.`,
  }[kind];
}

// The page offers Env and Config on a bot that is not running and has no operation in flight.
export function canEditEnv(bot: Bot, busy: boolean): boolean {
  return !busy && !bot.activeOp && !['running', 'building', 'starting', 'stopping'].includes(bot.status ?? '');
}

// The page offers Files on a running bot and on one started before (index.html:1709, :1726).
export function canBrowseFiles(bot: Bot): boolean {
  return bot.status === 'running' || !!bot.hasBeenStarted || !!bot.lastStartAt;
}

// The page offers Delete on a bot that is not running and not busy (index.html:1551, :1727, :1734).
export function canDelete(bot: Bot, busy: boolean): boolean {
  return canEditEnv(bot, busy);
}

// Screens without a held object of their own: a bot removed by a delete sends them to the list.
const BOT_FRAMES: Screen[] = ['bot', 'delete', 'webauth', 'confirm', 'action', 'containers', 'logs', 'buildlogs', 'shell'];

function botKeys(bot: Bot, busy: boolean, hasRun: boolean, canHandOff: boolean, deleting: boolean): string {
  const keys: string[] = [];
  if (!busy) {
    keys.push(bot.status === 'running' || bot.status === 'starting' ? 'S Stop' : 'S Start', 'R Restart', 'B Build');
    if (bot.sourceType !== 'docker-image') keys.push('U Update');
  }
  if (hasRun) keys.push('P Progress');
  keys.push('L Logs', 'G Build logs', ...(hasDatabaseScreen(bot) ? ['D Database'] : []), 'T State', ...(bot.status === 'running' ? ['O Console'] : []), ...(canBrowseFiles(bot) ? ['F Files'] : []), ...(bot.publicUrl ? ['W Web login'] : []), ...(canEditEnv(bot, busy) ? ['E Env', 'C Config'] : []), ...(canDelete(bot, busy) && !deleting ? ['X Delete'] : []), ...(canHandOff ? [HANDOFF_KEY] : []), 'Esc Back', 'Q Quit');
  return keys.join('  ');
}

export function createApp(ink: InkApi) {
  const { Box, Text, useApp, useInput, useStdin, useStdout } = ink;

  return function App({
    machine, session, initial, onHandOff, canHandOff = false, now = Date.now, wizardOptions, envOptions, configOptions, vaultOptions, databaseOptions, stateOptions, onEdit,
    writeMode, onShell, shellOptions, filesOptions,
  }: AppProps) {
    const { exit } = useApp();
    const { stdout } = useStdout();
    const { internal_eventEmitter: inputEvents } = useStdin();
    const raw = useRef<string | undefined>(undefined);
    // False for a bracketed paste's markers and text: no key inside a paste acts.
    const rawKey = useRef(true);
    const paste = useRef(new PasteReader());
    // The code on the code screen; it lives only while that screen shows, never in the Session.
    const codeShown = useRef<CodeShown | null>(null);
    const held = session.held;
    const wizard = { get current() { return held.install ?? null; }, set current(v: InstallWizard | null) { held.install = v ?? undefined; } };
    const editor = { get current() { return held.env ?? null; }, set current(v: EnvEditor | null) { held.env = v ?? undefined; } };
    const configEd = { get current() { return held.config ?? null; }, set current(v: ConfigEditor | null) { held.config = v ?? undefined; } };
    const vault = { get current() { return held.vault ?? null; }, set current(v: VaultScreen | null) { held.vault = v ?? undefined; } };
    const database = { get current() { return held.database ?? null; }, set current(v: DatabaseScreen | null) { held.database = v ?? undefined; } };
    const stateScreen = { get current() { return held.state ?? null; }, set current(v: StateScreen | null) { held.state = v ?? undefined; } };
    const filesScreen = { get current() { return held.files ?? null; }, set current(v: FilesScreen | null) { held.files = v ?? undefined; } };
    const deleteScreen = { get current() { return held.delete ?? null; }, set current(v: DeleteScreen | null) { held.delete = v ?? undefined; } };
    const webAuthScreen = { get current() { return held.webAuth ?? null; }, set current(v: WebAuthScreen | null) { held.webAuth = v ?? undefined; } };
    const managerScreen = { get current() { return held.manager ?? null; }, set current(v: ManagerScreen | null) { held.manager = v ?? undefined; } };

    // Registered before useInput's listener, so the raw sequence of each key is known when useInput runs.
    useEffect(() => {
      const onRaw = (data: string) => {
        raw.current = data;
        const r = paste.current.read(data);
        rawKey.current = r.key;
        const focus = session.codeFocus;
        if (r.text && focus) {
          focus.add(r.text);
          session.changed();
        }
      };
      inputEvents?.on('input', onRaw);
      return () => {
        inputEvents?.off('input', onRaw);
      };
    }, [inputEvents]);
    useSyncExternalStore(session.subscribe, session.snapshot);
    const [state, setState] = useState<FrameState>(initial ?? { screen: 'list', index: 0 });
    const stateRef = useRef(state);
    stateRef.current = state;
    const [size, setSize] = useState({ columns: stdout.columns || 80, rows: stdout.rows || 24 });
    const [scroll, setScroll] = useState(0);
    const [quitting, setQuitting] = useState(false);
    useEffect(() => {
      if (quitting) exit();
    }, [quitting]);
    const [containers, setContainers] = useState<{ list: Container[] | null; error: string | null }>({ list: null, error: null });
    const stream = useRef<StreamLines>({ lines: [], end: null });
    // The open stop, restart or update question.
    const confirmDialog = useRef<Dialog | null>(null);
    // The containers read O or R started; its answer acts only while the screen that asked still shows that bot.
    const shellRead = useRef<{ botId: string; from: Screen; token: number } | null>(null);
    const shellSeq = useRef(0);
    const shellPick = useRef<{ botId: string; list: Container[] } | null>(null);
    // Set once the frame handed the terminal to a shell: no key acts in the gap before the frame unmounts.
    const leaving = useRef(false);
    useEffect(() => {
      const r = shellRead.current;
      if (r && (r.botId !== state.botId || r.from !== state.screen)) shellRead.current = null;
    }, [state.screen, state.botId]);

    // Bracketed paste is on only while a code field has focus, so a paste elsewhere stays plain keys.
    const write = useRef(writeMode ?? ((sequence: string) => void stdout.write(sequence)));
    const pasteOn = useRef(false);
    const codeFocused = !!session.codeFocus && state.screen !== 'code';
    useEffect(() => {
      if (codeFocused === pasteOn.current) return;
      pasteOn.current = codeFocused;
      write.current(codeFocused ? PASTE_ON : PASTE_OFF);
    }, [codeFocused]);
    useEffect(() => () => {
      if (!pasteOn.current) return;
      pasteOn.current = false;
      write.current(PASTE_OFF);
    }, []);

    useEffect(() => {
      const onResize = () => setSize({ columns: stdout.columns || 80, rows: stdout.rows || 24 });
      stdout.on('resize', onResize);
      return () => {
        stdout.off('resize', onResize);
      };
    }, [stdout]);

    // A delete or web login outcome ends its screen through the Session; the frame then shows the bot screen.
    useEffect(() => {
      if ((state.screen === 'delete' && !deleteScreen.current) || (state.screen === 'webauth' && !webAuthScreen.current)) {
        setScroll(0);
        setState((s) => ({ ...s, screen: 'bot', notice: undefined }));
      }
    });
    // A bot the delete removed: once a list read after the outcome no longer lists it, the frame goes to the list.
    useEffect(() => {
      if (state.botId && BOT_FRAMES.includes(state.screen) && session.deletedGone(state.botId)) {
        confirmDialog.current = null;
        setScroll(0);
        setState((s) => ({ ...s, screen: 'list', botId: undefined, notice: undefined }));
      }
    });

    const bot = session.bot(state.botId);
    const bots = session.list.error ? [] : session.list.bots;
    const index = Math.min(state.index, Math.max(bots.length - 1, 0));

    useEffect(() => {
      if (state.screen !== 'containers' || !bot) return;
      let live = true;
      setContainers({ list: null, error: null });
      listContainers(session.client, bot).then(
        (list) => live && setContainers({ list, error: null }),
        (err: Error) => live && setContainers({ list: null, error: err.message }),
      );
      return () => {
        live = false;
      };
    }, [state.screen, state.botId]);

    useEffect(() => {
      if ((state.screen !== 'logs' && state.screen !== 'buildlogs') || !bot) return;
      stream.current = { lines: [], end: null };
      if (state.screen === 'buildlogs') return session.watch(buildLogPath(bot), buildFrameLine, stream.current);
      return session.watch(containerLogPath(bot, state.container ?? ''), containerFrameLine, stream.current);
    }, [state.screen, state.botId, state.container]);

    const go = (next: Partial<FrameState>) => {
      setScroll(0);
      setState({ ...state, notice: undefined, ...next });
    };

    const openShell = (container: string) => {
      if (leaving.current) return;
      if (!onShell) {
        setState((s) => ({ ...s, notice: 'No shell can be opened here.' }));
        return;
      }
      leaving.current = true;
      shellRead.current = null;
      onShell({ ...stateRef.current, screen: 'bot', notice: undefined }, container);
    };

    const readShell = (b: Bot, from: 'bot' | 'shell') => {
      if (shellRead.current || leaving.current) return;
      const token = ++shellSeq.current;
      shellRead.current = { botId: b.id, from, token };
      const name = botName(b);
      setState((s) => ({ ...s, notice: `Reading the containers of ${name}.` }));
      void readContainers(session.client, b.id, shellOptions?.readLimitMs ?? SHELL_READ_MS).then((r) => {
        if (shellRead.current?.token !== token) return;
        shellRead.current = null;
        const s = stateRef.current;
        if (leaving.current || s.botId !== b.id || s.screen !== from) return;
        if (r.ok !== true) {
          setState((x) => ({ ...x, notice: `Could not list the containers of ${name}: ${sentence(r.text)}` }));
          return;
        }
        const running = runningContainers(r.value);
        const none = `${name} has no running containers.`;
        if (from === 'bot') {
          if (running.length === 0) setState((x) => ({ ...x, notice: none }));
          else if (running.length === 1) openShell(running[0].name);
          else {
            shellPick.current = { botId: b.id, list: running };
            setScroll(0);
            setState((x) => ({ ...x, screen: 'shell', pick: 0, container: running[0].name, notice: undefined }));
          }
          return;
        }
        shellPick.current = { botId: b.id, list: running };
        // A row that moved under the cursor is not the one the operator picked: Enter waits for Up or Down.
        setState((x) => {
          const pick = Math.min(x.pick ?? 0, Math.max(running.length - 1, 0));
          const same = x.container !== undefined && running[pick]?.name === x.container;
          return { ...x, pick, container: same ? x.container : undefined, notice: running.length === 0 ? none : undefined };
        });
      });
    };

    const askConfirm = (kind: ActionKind) => {
      if (!bot) return;
      const b = bot;
      confirmDialog.current = new Dialog([], (inner) => confirmText(kind, b).flatMap((l) => (l ? wrap(l, inner) : [''])), `Y ${KIND_LABEL[kind]}`, () => act(kind));
      go({ screen: 'confirm', kind });
    };

    const act = (kind: ActionKind) => {
      if (!bot) return;
      void session.act(bot, kind);
      go({ screen: 'action', kind });
    };

    const fullRoom = bodyRows(size.rows);
    const run = state.botId ? session.runs.get(state.botId) : undefined;
    // Install is offered once the manager has answered the list read.
    const canInstall = !session.list.error && session.list.readAt !== null;

    const handEdit = (request: EditRequest) => {
      if (onEdit) onEdit({ ...state, notice: undefined }, request);
      else request.done({ ok: false, text: 'No editor can be opened here; the body was not changed.' });
    };

    // An edit opens only for the form that asked, while it is still the open one.
    const afterWizard = (out: WizardExit, asker?: InstallWizard | null) => {
      if (!out) return;
      if ('edit' in out) {
        if (asker === undefined || wizard.current === asker) handEdit(out.edit);
        return;
      }
      if ('quit' in out) {
        exit();
        return;
      }
      wizard.current = null;
      setScroll(0);
      setState((s) => ({ ...s, screen: 'list', notice: out.notice }));
      if (out.installed) void session.refresh();
    };

    const afterEditor = (out: EditorExit) => {
      if (!out) return;
      if ('quit' in out) {
        exit();
        return;
      }
      editor.current = null;
      setScroll(0);
      setState((s) => ({ ...s, screen: 'bot', notice: out.notice }));
      if (out.saved) void session.refresh();
    };

    const afterConfig = (out: ConfigExit, asker?: ConfigEditor | null) => {
      if (!out) return;
      if ('edit' in out) {
        if (asker === undefined || configEd.current === asker) handEdit(out.edit);
        return;
      }
      if ('quit' in out) {
        exit();
        return;
      }
      configEd.current = null;
      setScroll(0);
      setState((s) => ({ ...s, screen: 'bot', notice: out.notice }));
      if (out.saved) void session.refresh();
    };

    const afterVault = (out: VaultExit) => {
      if (!out) return;
      vault.current?.close();
      if ('quit' in out) {
        exit();
        return;
      }
      vault.current = null;
      setScroll(0);
      setState((s) => ({ ...s, screen: 'list', notice: undefined }));
    };

    // An outcome reaches the shared notice with its bot's name: it may land while another bot's screen is open.
    const reportFor = (botId: string) => (result: { text: string }) => {
      const b = session.bot(botId);
      session.notice = `${b ? botName(b) : botId}: ${result.text}`;
      session.changed();
      void session.refresh();
    };

    const openState = (botId: string, from: 'bot' | 'database') => {
      stateScreen.current?.close();
      stateScreen.current = new StateScreen(session.client, () => session.changed(), botId, session, reportFor(botId), from, { timeZone: databaseOptions?.timeZone, ...stateOptions });
      stateScreen.current.open();
      setScroll(0);
      setState((s) => ({ ...s, screen: 'state', notice: undefined }));
    };

    const afterState = (out: StateExit) => {
      if (!out) return;
      const from = stateScreen.current?.from ?? 'bot';
      stateScreen.current?.close();
      stateScreen.current = null;
      if ('quit' in out) {
        exit();
        return;
      }
      setScroll(0);
      setState((s) => ({ ...s, screen: from === 'database' && database.current ? 'database' : 'bot', notice: undefined }));
    };

    // A file read lands later; nano opens only while this Files screen is the one shown.
    const openFiles = (b: Bot) => {
      filesScreen.current?.close();
      const screen: FilesScreen = new FilesScreen(session.client, () => session.changed(), b.id, session, (request) => {
        if (filesScreen.current !== screen || stateRef.current.screen !== 'files' || leaving.current) return false;
        if (!onEdit) return false;
        onEdit({ ...stateRef.current, notice: undefined }, request);
        return true;
      }, (text) => reportFor(b.id)({ text }), filesOptions);
      filesScreen.current = screen;
      screen.open();
      go({ screen: 'files' });
    };

    // X: the dialog names the bot this screen was opened for, never a list row.
    const askDelete = (b: Bot) => {
      const name = botName(b);
      if (session.deleting.has(b.id)) {
        // In the Session, so the outcome that lands later replaces it.
        session.notice = `The delete of ${name} is still running; waiting for the manager.`;
        go({});
        return;
      }
      if (b.status === 'running') {
        go({ notice: `Stop ${name} to remove it.` });
        return;
      }
      if (!canDelete(b, session.busy(b.id))) {
        go({ notice: `${name} is busy, so it cannot be removed now.` });
        return;
      }
      deleteScreen.current?.close();
      const screen = new DeleteScreen(session, b.id, b);
      screen.open();
      deleteScreen.current = screen;
      go({ screen: 'delete' });
    };

    const afterDelete = (out: DeleteExit) => {
      if (!out) return;
      if ('quit' in out) {
        exit();
        return;
      }
      const d = deleteScreen.current;
      if (d && d.stage !== 'sending') {
        d.close();
        deleteScreen.current = null;
      }
      if (out.shared) session.notice = out.notice ?? null;
      setScroll(0);
      setState((s) => ({ ...s, screen: 'bot', notice: out.shared ? undefined : out.notice }));
    };

    const openWebAuth = (b: Bot) => {
      if (!b.publicUrl) {
        go({ notice: `${botName(b)} has no public URL, so it has no web login to set.` });
        return;
      }
      if (session.webAuthBusy.has(b.id)) {
        session.notice = `The web login change of ${botName(b)} is still running; waiting for the manager.`;
        go({});
        return;
      }
      webAuthScreen.current?.close();
      const screen = new WebAuthScreen(session, b.id, b);
      screen.open();
      webAuthScreen.current = screen;
      go({ screen: 'webauth' });
    };

    const afterWebAuth = (out: WebAuthExit) => {
      if (!out) return;
      if ('quit' in out) {
        exit();
        return;
      }
      if (out.shared) session.notice = out.notice ?? null;
      setScroll(0);
      setState((s) => ({ ...s, screen: 'bot', notice: out.shared ? undefined : out.notice }));
    };

    const openManager = () => {
      managerScreen.current?.close();
      const screen = new ManagerScreen(session);
      managerScreen.current = screen;
      screen.open();
      go({ screen: 'manager' });
    };

    const afterManager = (out: ManagerExit) => {
      if (!out) return;
      managerScreen.current?.close();
      managerScreen.current = null;
      if ('quit' in out) {
        exit();
        return;
      }
      setScroll(0);
      setState((s) => ({ ...s, screen: 'list', notice: undefined }));
    };

    const afterFiles = (out: FilesExit) => {
      if (!out) return;
      filesScreen.current?.close();
      filesScreen.current = null;
      if ('quit' in out) {
        exit();
        return;
      }
      setScroll(0);
      setState((s) => ({ ...s, screen: 'bot', notice: undefined }));
    };

    // A code read lands later; it opens only while the screen that asked is still the one shown.
    const openCode = (asker: DatabaseScreen, shown: CodeShown): boolean => {
      if (database.current !== asker || stateRef.current.screen !== 'database') return false;
      codeShown.current = shown;
      setScroll(0);
      setState((s) => (s.screen === 'database' ? { ...s, screen: 'code', notice: undefined } : s));
      return true;
    };

    const afterDatabase = (out: DatabaseExit) => {
      if (!out) return;
      if ('state' in out) {
        if (database.current) openState(database.current.botId, 'database');
        return;
      }
      database.current?.close();
      database.current = null;
      if ('quit' in out) {
        exit();
        return;
      }
      setScroll(0);
      setState((s) => ({ ...s, screen: 'bot', notice: undefined }));
    };

    const onInput = (input: string, key: Ink.Key) => {
      if (leaving.current) return;
      const k = input.toLowerCase();
      // Before the paste gate: an unfinished paste or a held escape start must not keep the operator in. A pasted Ctrl+C
      // arrives inside a longer input and does not match.
      if (key.ctrl && k === 'c') {
        // The terminal keeps the last frame after the exit, so a code on screen is replaced by a frame without it first.
        if (state.screen === 'code') {
          codeShown.current = null;
          setState((s) => ({ ...s, screen: database.current ? 'database' : 'bot', notice: undefined }));
          setQuitting(true);
        } else exit();
        return;
      }
      if (!rawKey.current) return;
      // Only Esc acts on the code screen: Q or a hand-off would leave the code in the terminal's scrollback.
      if (state.screen === 'code') {
        if (key.escape) {
          codeShown.current = null;
          setScroll(0);
          setState((s) => ({ ...s, screen: database.current ? 'database' : 'bot', notice: undefined }));
        }
        return;
      }
      const focus = session.codeFocus;
      if (focus) {
        const out = focus.key(input, key);
        if (out) {
          if (out === 'enter') focus.hooks.onEnter?.();
          if (out === 'escape') focus.hooks.onEscape?.();
          session.changed();
          return;
        }
      }
      if (state.screen === 'delete') {
        const d = deleteScreen.current;
        if (d && d.botId === state.botId) afterDelete(d.key(input, key));
        else afterDelete({ leave: true });
        return;
      }
      if (state.screen === 'webauth') {
        const w = webAuthScreen.current;
        if (w && w.botId === state.botId) afterWebAuth(w.key(input, key));
        else afterWebAuth({ leave: true });
        return;
      }
      if (state.screen === 'manager') {
        afterManager(managerScreen.current ? managerScreen.current.key(input, key) : { leave: true });
        return;
      }
      if (state.screen === 'files') {
        afterFiles(filesScreen.current ? filesScreen.current.key(input, key, isForwardDelete(raw.current)) : { leave: true });
        return;
      }
      if (state.screen === 'state') {
        afterState(stateScreen.current ? stateScreen.current.key(input, key, isForwardDelete(raw.current)) : { leave: true });
        return;
      }
      if (state.screen === 'database') {
        afterDatabase(database.current ? database.current.key(input, key, isForwardDelete(raw.current)) : { leave: true });
        return;
      }
      if (state.screen === 'vault') {
        const out = vault.current ? vault.current.key(input, key, isForwardDelete(raw.current)) : { leave: true as const };
        if (out instanceof Promise) void out.then(afterVault);
        else afterVault(out);
        return;
      }
      if (state.screen === 'config') {
        const asker = configEd.current;
        const out = asker ? asker.key(input, key, isForwardDelete(raw.current)) : { leave: true as const };
        if (out instanceof Promise) void out.then((r) => afterConfig(r, asker));
        else afterConfig(out);
        return;
      }
      if (state.screen === 'env') {
        const out = editor.current ? editor.current.key(input, key, isForwardDelete(raw.current)) : { leave: true as const };
        if (out instanceof Promise) void out.then(afterEditor);
        else afterEditor(out);
        return;
      }
      if (state.screen === 'install') {
        const asker = wizard.current;
        const out = asker ? asker.key(input, key, isForwardDelete(raw.current)) : { leave: true as const };
        if (out instanceof Promise) void out.then((r) => afterWizard(r, asker));
        else afterWizard(out);
        return;
      }
      if (state.screen === 'confirm') {
        const d = confirmDialog.current;
        const out = d ? d.key(input, key) : 'cancel';
        if (out === null) {
          session.changed();
          return;
        }
        confirmDialog.current = null;
        if (out === 'yes' && d) d.run();
        else go({ screen: 'bot', notice: `Cancelled: ${bot ? botName(bot) : 'the bot'} was not ${state.kind === 'stop' ? 'stopped' : state.kind === 'update' ? 'updated' : 'restarted'}.` });
        return;
      }
      if (k === 'q') {
        exit();
        return;
      }
      if (k === 'h' && canHandOff && (state.screen === 'list' || state.screen === 'bot')) {
        onHandOff({ ...state, index, notice: undefined });
        exit();
        return;
      }
      const scrolling = state.screen === 'logs' || state.screen === 'buildlogs' || (state.screen === 'action' && !!run?.progress);
      if (scrolling) {
        if (key.upArrow) setScroll(scroll + 1);
        else if (key.downArrow) setScroll(Math.max(0, scroll - 1));
        else if (key.end) setScroll(0);
      }
      if (key.escape) {
        if (state.screen === 'bot') go({ screen: 'list' });
        else if (state.screen === 'logs') go({ screen: 'containers' });
        else if (state.screen !== 'list') go({ screen: 'bot' });
        return;
      }
      if (state.screen === 'list') {
        if (k === 'i' && canInstall) {
          wizard.current = new InstallWizard(session.client, () => session.changed(), wizardOptions);
          wizard.current.open();
          go({ screen: 'install' });
          return;
        }
        if (k === 'm' && canInstall) {
          openManager();
          return;
        }
        if (k === 'v' && canInstall) {
          vault.current = new VaultScreen(session.client, () => session.changed(), vaultOptions);
          void vault.current.load();
          go({ screen: 'vault' });
          return;
        }
        if (bots.length === 0) return;
        if (key.upArrow) go({ index: (index + bots.length - 1) % bots.length });
        else if (key.downArrow) go({ index: (index + 1) % bots.length });
        else if (key.return) go({ screen: 'bot', botId: bots[index].id, index });
        return;
      }
      if (state.screen === 'containers') {
        const list = containers.list ?? [];
        const pick = Math.min(state.pick ?? 0, Math.max(list.length - 1, 0));
        if (list.length === 0) return;
        if (key.upArrow) go({ pick: (pick + list.length - 1) % list.length });
        else if (key.downArrow) go({ pick: (pick + 1) % list.length });
        else if (key.return) go({ screen: 'logs', container: list[pick].name, pick });
        return;
      }
      if (state.screen === 'shell') {
        if (!bot) return;
        if (k === 'r') {
          readShell(bot, 'shell');
          return;
        }
        const list = shellPick.current?.botId === bot.id ? shellPick.current.list : [];
        if (list.length === 0) return;
        const pick = Math.min(state.pick ?? 0, list.length - 1);
        if (key.upArrow || key.downArrow) {
          const next = key.upArrow ? (pick + list.length - 1) % list.length : (pick + 1) % list.length;
          go({ pick: next, container: list[next].name });
        } else if (key.return && state.container !== undefined && list[pick]?.name === state.container) openShell(state.container);
        return;
      }
      if (state.screen !== 'bot' || !bot) return;
      if (k === 't') openState(bot.id, 'bot');
      else if (k === 'f') {
        if (canBrowseFiles(bot)) openFiles(bot);
        else go({ notice: `${botName(bot)} has never been started, so it has no files to browse yet.` });
      } else if (k === 'o') {
        if (bot.status !== 'running') go({ notice: 'Start the bot to open a console.' });
        else readShell(bot, 'bot');
      } else if (k === 'w') openWebAuth(bot);
      else if (k === 'x') askDelete(bot);
      else if (k === 'd' && hasDatabaseScreen(bot)) {
        database.current?.close();
        const screen: DatabaseScreen = new DatabaseScreen(session.client, () => session.changed(), bot.id, session, databaseOptions, reportFor(bot.id), (shown) => openCode(screen, shown));
        database.current = screen;
        screen.open();
        go({ screen: 'database' });
      } else if (k === 'l') go({ screen: 'containers', pick: 0 });
      else if (k === 'g') go({ screen: 'buildlogs' });
      else if (k === 'p' && run) go({ screen: 'action', kind: run.kind });
      else if (k === 'e') {
        if (bot.status === 'running') go({ notice: 'Stop the bot to edit environment variables.' });
        else if (canEditEnv(bot, session.busy(bot.id))) {
          editor.current = new EnvEditor(session.client, () => session.changed(), bot.id, botName(bot), envOptions);
          void editor.current.open();
          go({ screen: 'env' });
        }
      } else if (k === 'c') {
        if (bot.status === 'running') go({ notice: 'Stop the bot to edit config files.' });
        else if (canEditEnv(bot, session.busy(bot.id))) {
          configEd.current = new ConfigEditor(session.client, () => session.changed(), bot.id, botName(bot), configOptions);
          void configEd.current.open();
          go({ screen: 'config' });
        }
      }
      else if (session.busy(bot.id)) return;
      else if (k === 's') {
        if (bot.status === 'running' || bot.status === 'starting') askConfirm('stop');
        else if (startOffRefusal(bot)) go({ notice: startOffRefusal(bot) });
        else act('start');
      } else if (k === 'r') askConfirm('restart');
      else if (k === 'b') act('build');
      else if (k === 'u' && bot.sourceType !== 'docker-image') {
        if (heldWarningText(bot, 'update')) askConfirm('update');
        else act('update');
      }
    };
    // Ink registers a new handler after each commit; a key read in that gap would reach the previous screen's handler.
    const onInputRef = useRef(onInput);
    onInputRef.current = onInput;
    useInput(useCallback((input: string, key: Ink.Key) => onInputRef.current(input, key), []));

    const listKeys = (rows: boolean) =>
      [...(rows ? ['Enter Open'] : []), ...(canInstall ? ['I Install', 'V Vault', 'M Manager'] : []), ...(canHandOff ? [HANDOFF_KEY] : []), 'Q Quit'].join('  ');

    const buildView = (room: number): View => {
      let notice = state.notice ?? session.notice ?? undefined;
      if (state.screen === 'install') {
        if (wizard.current) return wizard.current.view(innerWidth(size.columns), room);
        return { body: ['Install is not open.'], keys: 'Esc Back  Q Quit', notice };
      }
      if (state.screen === 'env') {
        if (editor.current) return editor.current.view(innerWidth(size.columns), room);
        return { body: ['The environment editor is not open.'], keys: 'Esc Back  Q Quit', notice };
      }
      if (state.screen === 'vault') {
        if (vault.current) return vault.current.view(innerWidth(size.columns), room);
        return { body: ['The vault is not open.'], keys: 'Esc Back  Q Quit', notice };
      }
      if (state.screen === 'state') {
        if (stateScreen.current) return stateScreen.current.view(innerWidth(size.columns), room, notice);
        return { body: ['The state screen is not open.'], keys: 'Esc Back  Q Quit', notice };
      }
      if (state.screen === 'delete') {
        if (deleteScreen.current) return { ...deleteScreen.current.view(innerWidth(size.columns), room), notice };
        return { body: ['The delete dialog is not open.'], keys: 'Esc Back  Q Quit', notice };
      }
      if (state.screen === 'webauth') {
        if (webAuthScreen.current) return { ...webAuthScreen.current.view(innerWidth(size.columns), room), notice };
        return { body: ['The web login picker is not open.'], keys: 'Esc Back  Q Quit', notice };
      }
      if (state.screen === 'manager') {
        if (managerScreen.current) return managerScreen.current.view(innerWidth(size.columns), room, notice);
        return { body: ['The Manager screen is not open.'], keys: 'Esc Back  Q Quit', notice };
      }
      if (state.screen === 'files') {
        if (filesScreen.current) return filesScreen.current.view(innerWidth(size.columns), room, notice);
        return { body: ['The Files screen is not open.'], keys: 'Esc Back  Q Quit', notice };
      }
      if (state.screen === 'database') {
        if (database.current) return database.current.view(innerWidth(size.columns), room, notice);
        return { body: ['The database screen is not open.'], keys: 'Esc Back  Q Quit', notice };
      }
      if (state.screen === 'config') {
        if (configEd.current) return configEd.current.view(innerWidth(size.columns), room);
        return { body: ['The config editor is not open.'], keys: 'Esc Back  Q Quit', notice };
      }
      const readFailed = session.list.error ? `can't read the bot list: ${session.list.error}` : null;
      if (state.screen === 'list') {
        if (readFailed) return { body: [readFailed], keys: listKeys(false), notice };
        if (session.list.readAt === null) return { body: ['Reading the bot list.'], keys: listKeys(false), notice };
        const orphans = orphanLines(session.orphans, hostDataRoot(databaseOptions?.env ?? process.env)).flatMap((l) => wrap(l, innerWidth(size.columns)));
        // A notice longer than the notice line (a delete's outcome) goes under the rows, whole.
        const longNotice = !!notice && notice.length > innerWidth(size.columns);
        if (longNotice) orphans.unshift(...wrap(notice!, innerWidth(size.columns)), ...(orphans.length ? [''] : []));
        if (longNotice) notice = undefined;
        const below = orphans.length ? ['', ...orphans] : [];
        if (bots.length === 0) return { body: ['No bots on this manager.', ...below], keys: listKeys(false), notice };
        const rowRoom = Math.max(room - below.length, 2);
        const first = Math.max(0, Math.min(index - (rowRoom - 2), bots.length - (rowRoom - 1)));
        const shown = bots.slice(first, first + rowRoom - 1);
        const t = now();
        return {
          body: [listHeader(innerWidth(size.columns)), ...shown.map((b, i) => listRow(b, first + i === index, t, innerWidth(size.columns))), ...below],
          highlight: index - first + 1,
          keys: listKeys(true),
          notice,
        };
      }
      if (!bot) return { body: ['This bot is no longer in the bot list.', ...(readFailed ? [readFailed] : [])], keys: 'Esc Back  Q Quit', notice };
      const name = botName(bot);
      if (state.screen === 'bot') {
        const t = now();
        const body = [
          ['Name', name],
          ['Status', statusText(bot)],
          ['State', stateName(bot.maintenance?.state)],
          ['Data', dataText(bot, true)],
          ['Copy', copyText(bot)],
          ['Last backup', lastBackupText(bot, t, true)],
          ['Update', updateText(bot)],
        ].flatMap(([label, value]) => fieldLines(label, value, innerWidth(size.columns)));
        if (readFailed) body.push('', readFailed, `The values above were read at ${clock(session.list.readAt ?? t)}.`);
        // A route's text can be longer than the notice line; it goes under the values, whole, before the badge lines.
        const longNotice = !!notice && notice.length > innerWidth(size.columns);
        if (longNotice) body.push('', ...wrap(notice!, innerWidth(size.columns)));
        const badges = databaseBadges(bot, timeIn(databaseOptions?.timeZone));
        if (badges.length) body.push('');
        for (const b of badges) {
          body.push(`${b.danger ? '! ' : ''}${b.text}`);
          for (const part of b.title.split('\n')) if (part) body.push(...wrap(part, innerWidth(size.columns), '  '));
        }
        const keys = botKeys(bot, session.busy(bot.id), !!run, canHandOff, session.deleting.has(bot.id));
        if (longNotice) return { body, keys };
        return { body, keys, notice };
      }
      if (state.screen === 'shell') {
        const w = innerWidth(size.columns);
        const list = shellPick.current?.botId === bot.id ? shellPick.current.list : [];
        const head = [...wrap(`Open a shell in a container of ${name}`, w), ''];
        const longNotice = !!notice && notice.length > w;
        const tail = longNotice ? ['', ...wrap(notice!, w)] : [];
        const shownNotice = longNotice ? undefined : notice;
        if (list.length === 0) return { body: [...head, `${name} has no running containers.`, ...tail], keys: 'R Read again  Esc Back  Q Quit', notice: shownNotice };
        const pick = Math.min(state.pick ?? 0, list.length - 1);
        const picked = state.container !== undefined && list[pick]?.name === state.container;
        const rows: string[] = [];
        let at = 0;
        let atLines = 1;
        list.forEach((c, i) => {
          const lines = wrap(`${c.name}  ${c.status || c.state}`, w, '  ');
          if (i === pick) {
            at = rows.length;
            atLines = lines.length;
            if (picked) lines[0] = '>' + lines[0].slice(1);
          }
          rows.push(...lines);
        });
        const rowRoom = Math.max(room - head.length - tail.length, 1);
        const start = at + atLines > rowRoom ? at : 0;
        return {
          body: [...head, ...rows.slice(start, start + rowRoom), ...tail],
          highlight: picked ? head.length + at - start : undefined,
          keys: [...(picked ? ['Enter Open shell'] : []), 'Up/Down Pick', 'R Read again', 'Esc Back', 'Q Quit'].join('  '),
          notice: shownNotice,
        };
      }
      if (state.screen === 'confirm' && confirmDialog.current) return confirmDialog.current.view(innerWidth(size.columns), room);
      if (state.screen === 'action') {
        if (!run) return { body: ['No action has run on this bot in this session.'], keys: 'Esc Back  Q Quit' };
        const head = [`${KIND_LABEL[run.kind]} ${run.name}`, ''];
        const tail = ['', run.result ? run.result.text : waitingText(run.kind, run.name)];
        if (!run.progress) return { body: [...head, tail[1]], keys: 'Esc Back  Q Quit' };
        const lines = [...run.progress.lines, ...(run.progress.end ? ['', run.progress.end.text] : [])];
        const win = scrollWindow(lines, room - head.length - tail.length, scroll);
        return { body: [...head, ...win, ...tail], keys: SCROLL_KEYS };
      }
      if (state.screen === 'containers') {
        if (containers.error) return { body: [`Could not list the containers of ${name}: ${containers.error}`], keys: 'Esc Back  Q Quit' };
        if (!containers.list) return { body: [`Listing the containers of ${name}.`], keys: 'Esc Back  Q Quit' };
        if (containers.list.length === 0) return { body: [`${name} has no containers.`], keys: 'Esc Back  Q Quit' };
        const pick = Math.min(state.pick ?? 0, containers.list.length - 1);
        return {
          body: [`Containers of ${name}`, '', ...containers.list.map((c, i) => `${i === pick ? '>' : ' '} ${c.name}  ${c.state}  ${c.status}`)],
          highlight: pick + 2,
          keys: 'Enter Open  Esc Back  Q Quit',
        };
      }
      const s = stream.current;
      const head = state.screen === 'buildlogs' ? `Build log of ${name}` : `Logs of ${state.container ?? ''}`;
      const lines = [...s.lines, ...(s.end ? ['', s.end.text] : [])];
      return { body: [head, '', ...scrollWindow(lines, room - 2, scroll)], keys: SCROLL_KEYS };
    };
    const codeView = state.screen === 'code' && codeShown.current ? codeScreen(codeShown.current, size.columns, size.rows) : null;
    // A held move code leaves the Session only once a frame has drawn it whole.
    useLayoutEffect(() => {
      const shown = codeShown.current;
      if (!codeView?.whole || !shown?.onWhole) return;
      const done = shown.onWhole;
      shown.onWhole = undefined;
      done();
    });
    if (state.screen === 'code') {
      const lines = codeView ? codeView.lines : ['The code is no longer shown.', '', 'Esc Close'];
      return (
        <Box flexDirection="column">
          {lines.map((line, i) => <Text key={i}>{line}</Text>)}
        </Box>
      );
    }
    let view = buildView(fullRoom);
    const extraKeys = keyLines(view.keys, innerWidth(size.columns)).length - 1;
    if (extraKeys > 0) view = buildView(fullRoom - extraKeys);

    const lines = frameLines(machine, view, size.columns, size.rows);
    const marked = view.highlight === undefined ? -1 : view.highlight + 1;
    const cursorRow = view.cursor === undefined ? -1 : view.cursor.line + 1;
    const cursorAt = view.cursor === undefined ? -1 : Math.min(view.cursor.col + 2, lines[0].length - 3);
    return (
      <Box flexDirection="column">
        {lines.map((line, i) =>
          i === cursorRow ? (
            <Text key={i}>
              {line.slice(0, cursorAt)}
              <Text inverse>{line.charAt(cursorAt)}</Text>
              {line.slice(cursorAt + 1)}
            </Text>
          ) : i === marked ? (
            <Text key={i}>
              {line.slice(0, 2)}
              <Text inverse>{line.slice(2, line.length - 2)}</Text>
              {line.slice(line.length - 2)}
            </Text>
          ) : (
            <Text key={i}>{line}</Text>
          ),
        )}
      </Box>
    );
  };
}
