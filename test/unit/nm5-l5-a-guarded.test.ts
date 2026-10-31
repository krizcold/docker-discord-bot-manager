import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// runGuarded, adminSql and the generation and restore reads against a scripted spawn: each call takes the next answer.
type Step = { code?: number; stdout?: string[]; stderr?: string[]; hang?: boolean; throws?: boolean; stdinError?: boolean };
const sp = vi.hoisted(() => ({
  queue: [] as Array<{ code?: number; stdout?: string[]; stderr?: string[]; hang?: boolean; throws?: boolean; stdinError?: boolean }>,
  calls: [] as Array<{ cmd: string; args: string[]; opts: any; input: string; kills: string[] }>,
  exec: [] as string[][],
}));

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const { EventEmitter } = require('events') as typeof import('events');
  const { PassThrough, Writable } = require('stream') as typeof import('stream');
  const spawn = (cmd: string, args: string[], opts: any) => {
    const step: Step = sp.queue.shift() ?? {};
    if (step.throws) throw Object.assign(new Error('spawn ENOMEM'), { code: 'ENOMEM' });
    const entry = { cmd, args, opts, input: '', kills: [] as string[] };
    sp.calls.push(entry);
    const child: any = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new Writable({ write(c: Buffer, _e: string, cb: () => void) { entry.input += String(c); cb(); } });
    child.stdin.on('finish', () => { entry.input += '<end>'; });
    child.kill = (sig: string) => { entry.kills.push(sig); setTimeout(() => child.emit('close', null), 1); return true; };
    if (step.stdinError) setTimeout(() => child.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })), 1);
    if (!step.hang) {
      setTimeout(() => {
        for (const s of step.stdout ?? []) child.stdout.write(s);
        for (const s of step.stderr ?? []) child.stderr.write(s);
        child.stdout.end();
        child.stderr.end();
        setTimeout(() => child.emit('close', step.code ?? 0), 5);
      }, 2);
    }
    return child;
  };
  const execFile = (_c: string, a: string[], o: unknown, c?: unknown) => {
    sp.exec.push(a);
    const cb = (typeof o === 'function' ? o : c) as (e: Error | null, out: string, err: string) => void;
    setTimeout(() => cb(null, 'true\n', ''), 0);
    return { on: () => undefined };
  };
  return { ...real, spawn, execFile, default: { ...real, spawn, execFile } };
});

import { adminSql, readGeneration, readRestoreState, runGuarded } from '../../src/instance/fleetSwitch';

const uncaught: unknown[] = [];
process.on('uncaughtException', e => { uncaught.push(e); });
beforeEach(() => { sp.queue = []; sp.calls = []; sp.exec = []; uncaught.length = 0; });
afterEach(() => { expect(uncaught).toEqual([]); });

const T = { container: 'c-pg', user: 'app' };

describe('runGuarded', () => {
  it('passes the env given to spawn, and no options without one', async () => {
    sp.queue = [{}, {}];
    await runGuarded('docker', ['ps'], { env: { A: '1' } });
    await runGuarded('docker', ['ps']);
    expect(sp.calls[0].opts).toEqual({ env: { A: '1' } });
    expect(sp.calls[1].opts).toEqual({});
  });
  it('a synchronous throw answers empty output and the reason', async () => {
    sp.queue = [{ throws: true }];
    expect(await runGuarded('docker', ['ps'])).toEqual({ ok: false, code: null, stdout: '', stderr: '', error: 'docker could not start (spawn ENOMEM)' });
  });
  it('a success answers no error key, and stdin gets an empty end without input', async () => {
    sp.queue = [{ stdout: ['1\n'] }];
    expect(await runGuarded('docker', ['ps'])).toEqual({ ok: true, code: 0, stdout: '1\n', stderr: '' });
    expect(sp.calls[0].input).toBe('<end>');
  });
  it('without a timeout a silent child is not killed', async () => {
    sp.queue = [{ hang: true }];
    let settled = false;
    void runGuarded('docker', ['ps']).then(() => { settled = true; });
    await new Promise(r => setTimeout(r, 30));
    expect(sp.calls[0].kills).toEqual([]);
    expect(settled).toBe(false);
  });
  it('a child silent past the timeout is killed and answers the exact reason', async () => {
    sp.queue = [{ hang: true }];
    const r = await runGuarded('docker', ['ps'], { timeoutMs: 1500 });
    expect(r).toEqual({ ok: false, code: null, stdout: '', stderr: '', error: 'no answer within 2 seconds' });
    expect(sp.calls[0].kills).toEqual(['SIGKILL']);
  });
  it('keeps stdout at the first chunk that reaches 1,000,000 characters and stderr at 8000', async () => {
    sp.queue = [{ stdout: ['a'.repeat(1_000_000), 'b'], stderr: ['e'.repeat(8000), 'f'] }];
    const r = await runGuarded('docker', ['ps']);
    expect(r.stdout.length).toBe(1_000_000);
    expect(r.stderr.length).toBe(8000);
  });
  it('an EPIPE on stdin is swallowed and close answers', async () => {
    sp.queue = [{ stdinError: true, stdout: ['x'] }];
    expect((await runGuarded('docker', ['ps'], { input: 'SELECT 1' })).ok).toBe(true);
  });
  it('an input file that does not read kills the child and answers the reason', async () => {
    sp.queue = [{ hang: true }];
    const r = await runGuarded('docker', ['ps'], { inputPath: 'D:/no/such/dir/nm5-l5-a.dump' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/^the file could not be read \(ENOENT: no such file or directory, open '.*nm5-l5-a\.dump'\)$/);
    expect(sp.calls[0].kills).toEqual(['SIGKILL']);
  });
});

describe('the error line of a failed psql (errorOf)', () => {
  it.each([
    [['  WARNING:  w\n', '  ERROR:  boom  \n', 'DETAIL: d\n'], 'ERROR:  boom'],
    [['first\n', 'something  \n'], 'something'],
    [['ERROR:  a\n', 'last\n'], 'ERROR:  a'],
    [[], 'no reason given'],
    [['note psql: error: y\n'], 'note psql: error: y'],
    [['psql: error: connection refused\n'], 'connection refused'],
  ])('%j -> %j', async (stderr, want) => {
    sp.queue = [{ code: 1, stderr }];
    expect((await runGuarded('docker', ['ps'])).error).toBe(want);
  });
});

describe('adminSql', () => {
  it('runs psql on stdin as the manager role with the exact argv', async () => {
    sp.queue = [{ stdout: ['ok\n'] }];
    const r = await adminSql(T, 'app', 'SELECT 1;');
    expect(r.ok).toBe(true);
    expect(sp.calls[0].args).toEqual(['exec', '-i', 'c-pg', 'psql', '-U', 'dbm_admin', '-d', 'app', '-tAq', '-v', 'ON_ERROR_STOP=1']);
    expect(sp.calls[0].input).toBe('SELECT 1;<end>');
    expect(sp.calls).toHaveLength(1);
    expect(sp.exec).toEqual([]);
  });
  it('a missing manager role is made and the script runs once more', async () => {
    sp.queue = [{ code: 2, stderr: ['psql: error: FATAL:  role "dbm_admin" does not exist\n'] }, { stdout: ['done\n'] }];
    const r = await adminSql({ container: 'c-pg-2', user: 'app' }, 'app', 'SELECT 1;');
    expect(r).toMatchObject({ ok: true, stdout: 'done\n' });
    expect(sp.calls).toHaveLength(2);
  });
  it('another failure is answered without a second run', async () => {
    sp.queue = [{ code: 1, stderr: ['ERROR:  syntax error\n'] }, { stdout: ['done\n'] }];
    const r = await adminSql({ container: 'c-pg-3', user: 'app' }, 'app', 'SELEC 1;');
    expect(r).toMatchObject({ ok: false, error: 'ERROR:  syntax error' });
    expect(sp.calls).toHaveLength(1);
    expect(sp.exec).toEqual([]);
  });
});

describe('the generation and restore reads', () => {
  it.each([
    ['junk\n  tail', "the generation read answered 'tail'"],
    ['a\n  b c', "the generation read answered 'b c'"],
    ['', "the generation read answered 'no reason given'"],
  ])('an unparsed generation answer %j', async (out, want) => {
    sp.queue = [{ stdout: [out] }];
    expect(await readGeneration(T, 'app')).toEqual({ ok: false, error: want });
  });
  it('an unparsed restore record names its last line, read on the postgres database', async () => {
    sp.queue = [{ stdout: ['x|y\n'] }];
    expect(await readRestoreState(T)).toEqual({ ok: false, error: "the restore record answered 'x|y'" });
    expect(sp.calls[0].args[sp.calls[0].args.indexOf('-d') + 1]).toBe('postgres');
  });
  it('a failed restore read answers its error', async () => {
    sp.queue = [{ code: 1, stderr: ['ERROR:  permission denied for schema smdb_manager\n'] }];
    expect(await readRestoreState(T)).toEqual({ ok: false, error: 'ERROR:  permission denied for schema smdb_manager' });
  });
});
