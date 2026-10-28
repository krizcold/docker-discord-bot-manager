import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm4-l5-d-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir, claimOut: '', spawnThrow: undefined as unknown, noStdio: false, child: null as any, spawnArgs: [] as string[][], kills: [] as string[] };
});

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const { EventEmitter } = await import('events');
  const { PassThrough, Writable } = await import('stream');
  const execFile = (_f: string, args: string[], opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    const sql = args[args.length - 1];
    const out = sql.startsWith('SELECT to_regclass') ? 't|t|t\n' : h.claimOut;
    setImmediate(() => done(null, out, ''));
    return { stdin: null };
  };
  const spawn = (_cmd: string, args: string[]) => {
    h.spawnArgs.push(args);
    if (h.spawnThrow !== undefined) throw h.spawnThrow;
    const child: any = new EventEmitter();
    if (!h.noStdio) {
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new Writable({ autoDestroy: false, write(_c, _e, cb) { cb(); } });
    }
    child.kill = (sig: string) => { h.kills.push(sig); };
    h.child = child;
    return child;
  };
  return { ...real, default: { ...real, execFile, spawn }, execFile, spawn };
});

import * as fs from 'fs';
import * as path from 'path';
import * as fleetBackup from '../../src/instance/fleetBackup';

const fleetDb = { containerName: 'pg', user: 'postgres', db: 'smdb', volume: 'v' };
const DUMP = path.join(h.dir, 'x.dump');
fs.writeFileSync(DUMP, 'dump');
const saved = { ...fleetBackup.tocTiming };
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));

beforeEach(() => {
  h.spawnThrow = undefined; h.noStdio = false; h.child = null; h.spawnArgs.length = 0; h.kills.length = 0;
  Object.assign(fleetBackup.tocTiming, saved);
});
afterEach(() => { vi.restoreAllMocks(); });
afterAll(() => { fs.rmSync(h.dir, { recursive: true, force: true }); });

describe('probeClaims reads the claim probe answer', () => {
  const rows: Array<[string, unknown]> = [
    ['7\n', { ok: true, shape: 'claims', claim: 7 }],
    ['17\n', { ok: true, shape: 'claims', claim: 17 }],
    ['0\n', { ok: true, shape: 'claims', claim: 0 }],
    ['-1\n', { ok: true, shape: 'claims', claim: null }],
    ['x7\n', { ok: false, error: "the claim probe answered 'x7'" }],
    ['7x\n', { ok: false, error: "the claim probe answered '7x'" }],
    ['+7\n', { ok: false, error: "the claim probe answered '+7'" }],
    ['7e3\n', { ok: false, error: "the claim probe answered '7e3'" }],
    ['9007199254740993\n', { ok: false, error: "the claim probe answered '9007199254740993'" }],
  ];
  it.each(rows)('%j', async (out, want) => {
    h.claimOut = out;
    expect(await fleetBackup.probeClaims(fleetDb)).toEqual(want);
  });
});

describe('readDumpToc', () => {
  const start = () => fleetBackup.readDumpToc('side', DUMP);

  it('keeps output past a small cap and stops at 8 MiB', async () => {
    const p = start();
    h.child.stdout.write('a'.repeat(10));
    h.child.stdout.write('b');
    await tick(5);
    h.child.emit('close', 0);
    expect(await p).toEqual({ ok: true, toc: 'a'.repeat(10) + 'b' });
    const q = start();
    const big = 'c'.repeat(8 * 1024 * 1024);
    h.child.stdout.write(big);
    h.child.stdout.write('d');
    await tick(5);
    h.child.emit('close', 0);
    const r: any = await q;
    expect(r.ok).toBe(true);
    expect(r.toc.length).toBe(big.length);
  });

  it('stops reading stderr at 4000 characters', async () => {
    const p = start();
    h.child.stderr.write(' '.repeat(4000));
    h.child.stderr.write('y');
    await tick(5);
    h.child.emit('close', 1);
    expect(await p).toEqual({ ok: false, error: 'pg_restore exited with code 1: ' });
  });

  it('trims stderr and keeps its first 500 characters', async () => {
    const p = start();
    h.child.stderr.write(' boom\n');
    await tick(5);
    h.child.emit('close', 2);
    expect(await p).toEqual({ ok: false, error: 'pg_restore exited with code 2: boom' });
    const q = start();
    h.child.stderr.write('e'.repeat(600));
    await tick(5);
    h.child.emit('close', 2);
    expect(await q).toEqual({ ok: false, error: `pg_restore exited with code 2: ${'e'.repeat(500)}` });
  });

  it('a code 1 with no stderr names only the code', async () => {
    const p = start();
    h.child.emit('close', 1);
    expect(await p).toEqual({ ok: false, error: 'pg_restore exited with code 1: ' });
  });

  it('a spawn that throws is reported with its message', async () => {
    h.spawnThrow = new Error('spawn ENOMEM');
    expect(await start()).toEqual({ ok: false, error: 'Failed to run docker exec: spawn ENOMEM' });
    h.spawnThrow = null;
    expect(await start()).toEqual({ ok: false, error: 'Failed to run docker exec: null' });
  });

  it('a child error event is reported', async () => {
    h.noStdio = true;
    const p = start();
    await tick();
    h.child.emit('error', new Error('spawn docker EMFILE'));
    expect(await p).toEqual({ ok: false, error: 'Failed to run docker exec: spawn docker EMFILE' });
  });

  it('an EPIPE on stdin does not fail the read', async () => {
    const p = start();
    expect(() => h.child.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))).not.toThrow();
    h.child.stdout.write('toc');
    await tick(5);
    h.child.emit('close', 0);
    expect(await p).toEqual({ ok: true, toc: 'toc' });
  });

  it('the backstop kills the child and says it was slow', async () => {
    fleetBackup.tocTiming.backstopMs = 10;
    const p = start();
    expect(await p).toEqual({ ok: false, error: 'reading it took more than 60 seconds' });
    expect(h.kills).toEqual(['SIGKILL']);
  });

  it('a quick code 137 is an exit code, not slowness', async () => {
    const p = start();
    await tick(5);
    h.child.emit('close', 137);
    expect(await p).toEqual({ ok: false, error: 'pg_restore exited with code 137: ' });
  });

  it('a code 137 after the in-container limit is slowness', async () => {
    fleetBackup.tocTiming.inContainerSec = 0.01;
    const p = start();
    expect(h.spawnArgs[0]).toEqual(['exec', '-i', 'side', 'timeout', '-s', 'KILL', '0.01', 'pg_restore', '-l']);
    await tick(30);
    h.child.emit('close', 137);
    expect(await p).toEqual({ ok: false, error: 'reading it took more than 0.01 seconds' });
  });

  it('a code 137 exactly at the limit is slowness, another code is not', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValueOnce(1000).mockReturnValueOnce(61000);
    const p = start();
    h.child.emit('close', 137);
    expect(await p).toEqual({ ok: false, error: 'reading it took more than 60 seconds' });
    now.mockReset().mockReturnValueOnce(1000).mockReturnValueOnce(61000);
    const q = start();
    h.child.emit('close', 1);
    expect(await q).toEqual({ ok: false, error: 'pg_restore exited with code 1: ' });
  });

  it('a dump file that cannot be read kills the child', async () => {
    const missing = path.join(h.dir, 'none.dump');
    const p = fleetBackup.readDumpToc('side', missing);
    expect(await p).toEqual({ ok: false, error: `Failed to read dump file: ENOENT: no such file or directory, open '${missing}'` });
    expect(h.kills).toEqual(['SIGKILL']);
  });
});
