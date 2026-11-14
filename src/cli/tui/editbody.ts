import { spawn } from 'child_process';
import { promises as fs, rmSync } from 'fs';
import os from 'os';
import path from 'path';

/** A config file body to edit in nano: the frame hands the terminal over, then `done` takes the outcome. */
export interface EditRequest {
  /** The config file's in-container path; its base name names the file nano shows. */
  name: string;
  body: string;
  done: (result: EditResult) => void;
}

export type EditResult = { ok: true; changed: boolean; body: string } | { ok: false; text: string };

export interface EditorCommand {
  program: string;
  args: string[];
}

// nano in restricted mode: it edits the one file it is given and offers no command, no other file and no suspend.
// DBM_TUI_CHECK_EDITOR, a JSON list of program and arguments, names another editor for the checks only.
export function editorCommand(env: NodeJS.ProcessEnv = process.env): EditorCommand {
  const raw = env.DBM_TUI_CHECK_EDITOR;
  if (raw) {
    const list = JSON.parse(raw) as unknown;
    if (Array.isArray(list) && list.length > 0 && list.every((x) => typeof x === 'string')) {
      return { program: list[0] as string, args: list.slice(1) as string[] };
    }
    throw new Error('DBM_TUI_CHECK_EDITOR must be a JSON list of strings');
  }
  return { program: 'nano', args: ['-R'] };
}

function why(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function fileName(name: string): string {
  const base = path.posix.basename(name.trim().replace(/\\/g, '/'));
  return base && base !== '.' && base !== '..' ? base : 'config';
}

/**
 * Writes the body to a new private folder under the OS temp folder (the file mode 0600), runs the editor on it with
 * the terminal's stdio, and reads it back. The folder is removed on every path.
 */
export async function editBody(name: string, body: string, command: EditorCommand = editorCommand()): Promise<EditResult> {
  const shown = path.basename(command.program);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dbm-edit-'));
  // A closed ttyd tab (SIGHUP) or a stopped container (SIGTERM) would skip the finally and leave the plaintext body.
  const ending = (code: number) => () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } finally {
      process.exit(code);
    }
  };
  const onHup = ending(129);
  const onTerm = ending(143);
  process.on('SIGHUP', onHup);
  process.on('SIGTERM', onTerm);
  try {
    const file = path.join(dir, fileName(name));
    await fs.writeFile(file, body, { mode: 0o600, flag: 'wx' });
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null } | { error: NodeJS.ErrnoException }>((resolve) => {
      const child = spawn(command.program, [...command.args, file], { stdio: 'inherit' });
      child.once('error', (error: NodeJS.ErrnoException) => resolve({ error }));
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    if ('error' in exit) {
      if (exit.error.code === 'ENOENT') return { ok: false, text: `${shown} is not installed here; the body was not changed.` };
      return { ok: false, text: `Could not start ${shown} (${exit.error.message}); the body was not changed.` };
    }
    if (exit.code !== 0) {
      const how = exit.code === null ? `was stopped (${exit.signal ?? 'signal'})` : `exited with code ${exit.code}`;
      return { ok: false, text: `${shown} ${how}; the body was not changed.` };
    }
    let after: string;
    try {
      after = await fs.readFile(file, 'utf8');
    } catch (err) {
      return { ok: false, text: `Could not read the edited file back (${why(err)}); the body was not changed.` };
    }
    return { ok: true, changed: after !== body, body: after };
  } catch (err) {
    return { ok: false, text: `Could not open the body in ${shown} (${why(err)}); the body was not changed.` };
  } finally {
    process.off('SIGHUP', onHup);
    process.off('SIGTERM', onTerm);
    await fs.rm(dir, { recursive: true, force: true });
  }
}
