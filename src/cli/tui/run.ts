import { spawn } from 'child_process';
import os from 'os';
import { createElement } from 'react';
import { createApp, FrameState, InkApi } from './app';
import { importEsm } from './esm';
import { Client } from '../client';
import { Session } from './session';
import { editBody, editorCommand, EditRequest, EditResult } from './editbody';

const SHOW_CURSOR = '\x1b[?25h';

export interface ScreenModes {
  enter: string;
  leave: string;
}

// On Windows a console program started after the alternate screen was used dies at start (0xC0000142), so the frame clears the screen instead.
export function screenModes(platform: NodeJS.Platform = process.platform): ScreenModes {
  if (platform === 'win32') return { enter: '\x1b[2J\x1b[H', leave: '\x1b[2J\x1b[H' };
  return { enter: '\x1b[?1049h', leave: '\x1b[?1049l' };
}

// The frame offers no command of its own; only the terminal check names one.
export function handOffCommand(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.DBM_TUI_CHECK_HANDOFF || undefined;
}

// The terminal leaves the frame for a child with inherited stdio; Ctrl+C belongs to the child meanwhile.
async function suspended<T>(modes: ScreenModes, banner: string, run: () => Promise<T>): Promise<T> {
  process.stdout.write(modes.leave + SHOW_CURSOR + banner);
  const ignore = () => {};
  process.on('SIGINT', ignore);
  try {
    return await run();
  } finally {
    process.off('SIGINT', ignore);
    process.stdout.write(modes.enter);
  }
}

// Async spawn: under spawnSync, cmd.exe on Windows never ran the lines typed into it.
function handOff(command: string, modes: ScreenModes): Promise<string | undefined> {
  return suspended(modes, 'Type exit to return to Bot Manager.\n', () => new Promise<string | undefined>((resolve) => {
    const child = spawn(command, [], { stdio: 'inherit' });
    child.once('error', (err) => resolve(`Could not start ${command}: ${err.message}`));
    child.once('exit', () => resolve(undefined));
  }));
}

/** The config body hand-off: the editor on a private copy of the body, then the outcome goes back to the form. */
export async function editHandOff(request: EditRequest, modes: ScreenModes, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  let result: EditResult;
  try {
    const command = editorCommand(env);
    result = await suspended(modes, '', () => editBody(request.name, request.body, command));
  } catch (err) {
    result = { ok: false, text: `Could not open the body in an editor (${err instanceof Error ? err.message : String(err)}); the body was not changed.` };
  }
  request.done(result);
}

export async function runTui(client: Client, deps: { ink?: InkApi } = {}): Promise<void> {
  const ink = deps.ink ?? (await importEsm<InkApi>('ink'));
  const App = createApp(ink);
  const machine = os.hostname() || 'this machine';
  const modes = screenModes();
  const restore = () => process.stdout.write(SHOW_CURSOR + modes.leave);
  process.once('exit', restore);
  process.stdout.write(modes.enter);
  const session = new Session(client);
  session.start();
  const command = handOffCommand();

  let state: FrameState = { screen: 'list', index: 0 };
  try {
    for (;;) {
      const outcome: { next?: FrameState; edit?: EditRequest } = {};
      let instance: ReturnType<InkApi['render']> | null = null;
      instance = ink.render(
        createElement(App, {
          machine,
          session,
          canHandOff: command !== undefined,
          initial: state,
          onHandOff: (s) => {
            outcome.next = s;
          },
          onEdit: (s, request) => {
            outcome.next = s;
            outcome.edit = request;
            instance?.unmount();
          },
        }),
        { exitOnCtrlC: true, patchConsole: false },
      );
      try {
        await instance.waitUntilExit();
      } finally {
        instance.cleanup();
      }
      if (outcome.edit && outcome.next) {
        state = outcome.next;
        process.stdin.pause();
        await editHandOff(outcome.edit, modes);
        continue;
      }
      if (!outcome.next || command === undefined) break;
      state = outcome.next;
      process.stdin.pause();
      state = { ...state, notice: await handOff(command, modes) };
    }
  } finally {
    session.stop();
    process.off('exit', restore);
    restore();
  }
}
