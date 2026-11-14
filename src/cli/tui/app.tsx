import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type * as Ink from 'ink';
import {
  ActionKind, Bot, botName, buildFrameLine, buildLogPath, Container, containerFrameLine, containerLogPath, listContainers, StreamLines,
} from './api';
import { isForwardDelete } from './field';
import { clock, copyText, dataText, lastBackupText, listHeader, listRow, statusText, updateText } from './format';
import { ConfigEditor, ConfigExit, ConfigOptions } from './configedit';
import { EditRequest } from './editbody';
import { EditorExit, EditorOptions, EnvEditor } from './envedit';
import { InstallWizard, WizardExit, WizardOptions, wrap } from './install';
import { Session } from './session';
import { VaultExit, VaultOptions, VaultScreen } from './vaultscreen';

export type InkApi = typeof Ink;

export type Screen = 'list' | 'bot' | 'confirm' | 'action' | 'containers' | 'logs' | 'buildlogs' | 'install' | 'env' | 'config' | 'vault';

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
  canHandOff?: boolean;
  now?: () => number;
  wizardOptions?: WizardOptions;
  envOptions?: EditorOptions;
  configOptions?: ConfigOptions;
  vaultOptions?: VaultOptions;
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

const KIND_LABEL: Record<ActionKind, string> = { start: 'Start', stop: 'Stop', restart: 'Restart', build: 'Build', update: 'Update' };

function confirmText(kind: ActionKind, name: string): string[] {
  if (kind === 'stop') return [`Stop ${name}?`, '', 'The bot goes offline until it is started again.'];
  return [`Restart ${name}?`, '', 'The bot goes offline while its containers restart.'];
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

function botKeys(bot: Bot, busy: boolean, hasRun: boolean, canHandOff: boolean): string {
  const keys: string[] = [];
  if (!busy) {
    keys.push(bot.status === 'running' || bot.status === 'starting' ? 'S Stop' : 'S Start', 'R Restart', 'B Build');
    if (bot.sourceType !== 'docker-image') keys.push('U Update');
  }
  if (hasRun) keys.push('P Progress');
  keys.push('L Logs', 'G Build logs', ...(canEditEnv(bot, busy) ? ['E Env', 'C Config'] : []), ...(canHandOff ? [HANDOFF_KEY] : []), 'Esc Back', 'Q Quit');
  return keys.join('  ');
}

export function createApp(ink: InkApi) {
  const { Box, Text, useApp, useInput, useStdin, useStdout } = ink;

  return function App({ machine, session, initial, onHandOff, canHandOff = false, now = Date.now, wizardOptions, envOptions, configOptions, vaultOptions, onEdit }: AppProps) {
    const { exit } = useApp();
    const { stdout } = useStdout();
    const { internal_eventEmitter: inputEvents } = useStdin();
    const raw = useRef<string | undefined>(undefined);
    const held = session.held;
    const wizard = { get current() { return held.install ?? null; }, set current(v: InstallWizard | null) { held.install = v ?? undefined; } };
    const editor = { get current() { return held.env ?? null; }, set current(v: EnvEditor | null) { held.env = v ?? undefined; } };
    const configEd = { get current() { return held.config ?? null; }, set current(v: ConfigEditor | null) { held.config = v ?? undefined; } };
    const vault = { get current() { return held.vault ?? null; }, set current(v: VaultScreen | null) { held.vault = v ?? undefined; } };

    // Registered before useInput's listener, so the raw sequence of each key is known when useInput runs.
    useEffect(() => {
      const onRaw = (data: string) => {
        raw.current = data;
      };
      inputEvents?.on('input', onRaw);
      return () => {
        inputEvents?.off('input', onRaw);
      };
    }, [inputEvents]);
    useSyncExternalStore(session.subscribe, session.snapshot);
    const [state, setState] = useState<FrameState>(initial ?? { screen: 'list', index: 0 });
    const [size, setSize] = useState({ columns: stdout.columns || 80, rows: stdout.rows || 24 });
    const [scroll, setScroll] = useState(0);
    const [containers, setContainers] = useState<{ list: Container[] | null; error: string | null }>({ list: null, error: null });
    const stream = useRef<StreamLines>({ lines: [], end: null });

    useEffect(() => {
      const onResize = () => setSize({ columns: stdout.columns || 80, rows: stdout.rows || 24 });
      stdout.on('resize', onResize);
      return () => {
        stdout.off('resize', onResize);
      };
    }, [stdout]);

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

    useInput((input, key) => {
      const k = input.toLowerCase();
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
        if (k === 'y' && state.kind) act(state.kind);
        else go({ screen: 'bot', notice: `Cancelled: ${bot ? botName(bot) : 'the bot'} was not ${state.kind === 'stop' ? 'stopped' : 'restarted'}.` });
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
      if (state.screen !== 'bot' || !bot) return;
      if (k === 'l') go({ screen: 'containers', pick: 0 });
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
        if (bot.status === 'running' || bot.status === 'starting') go({ screen: 'confirm', kind: 'stop' });
        else act('start');
      } else if (k === 'r') go({ screen: 'confirm', kind: 'restart' });
      else if (k === 'b') act('build');
      else if (k === 'u' && bot.sourceType !== 'docker-image') act('update');
    });

    const listKeys = (rows: boolean) =>
      [...(rows ? ['Enter Open'] : []), ...(canInstall ? ['I Install', 'V Vault'] : []), ...(canHandOff ? [HANDOFF_KEY] : []), 'Q Quit'].join('  ');

    const buildView = (room: number): View => {
      const notice = state.notice ?? session.notice ?? undefined;
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
      if (state.screen === 'config') {
        if (configEd.current) return configEd.current.view(innerWidth(size.columns), room);
        return { body: ['The config editor is not open.'], keys: 'Esc Back  Q Quit', notice };
      }
      const readFailed = session.list.error ? `can't read the bot list: ${session.list.error}` : null;
      if (state.screen === 'list') {
        if (readFailed) return { body: [readFailed], keys: listKeys(false), notice };
        if (session.list.readAt === null) return { body: ['Reading the bot list.'], keys: listKeys(false), notice };
        if (bots.length === 0) return { body: ['No bots on this manager.'], keys: listKeys(false), notice };
        const first = Math.max(0, Math.min(index - (room - 2), bots.length - (room - 1)));
        const shown = bots.slice(first, first + room - 1);
        const t = now();
        return {
          body: [listHeader(innerWidth(size.columns)), ...shown.map((b, i) => listRow(b, first + i === index, t, innerWidth(size.columns)))],
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
          ['Data', dataText(bot, true)],
          ['Copy', copyText(bot)],
          ['Last backup', lastBackupText(bot, t, true)],
          ['Update', updateText(bot)],
        ].flatMap(([label, value]) => fieldLines(label, value, innerWidth(size.columns)));
        if (readFailed) body.push('', readFailed, `The values above were read at ${clock(session.list.readAt ?? t)}.`);
        const keys = botKeys(bot, session.busy(bot.id), !!run, canHandOff);
        // A save's route text can be longer than the notice line; it goes under the values, whole.
        if (notice && notice.length > innerWidth(size.columns)) return { body: [...body, '', ...wrap(notice, innerWidth(size.columns))], keys };
        return { body, keys, notice };
      }
      if (state.screen === 'confirm' && state.kind) {
        return { body: confirmText(state.kind, name), keys: `Y ${KIND_LABEL[state.kind]}  any other key Cancel` };
      }
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
