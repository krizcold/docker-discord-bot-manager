import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A fake docker: each spawn is recorded and answers after h.delay[verb] ms
// (never, when Infinity) with h.code[verb] and h.stderr[verb].
const h = vi.hoisted(() => ({
  spawns: [] as string[][],
  delay: {} as Record<string, number>,
  code: {} as Record<string, number>,
  stderr: {} as Record<string, string>,
}));

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const { EventEmitter } = await import('events');
  const { PassThrough } = await import('stream');
  const spawn = (cmd: string, args: string[], opts?: any) => {
    if (cmd !== 'docker') return real.spawn(cmd, args, opts);
    h.spawns.push(args);
    const verb = args[0];
    const child: any = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    let done = false;
    const close = (code: number | null) => {
      if (done) return;
      done = true;
      child.stdout.end();
      child.stderr.end(h.stderr[verb] ?? '');
      setTimeout(() => child.emit('close', code), 0);
    };
    child.kill = () => { close(null); };
    const delay = h.delay[verb] ?? 1;
    if (delay !== Infinity) setTimeout(() => close(h.code[verb] ?? 0), delay);
    return child;
  };
  return { ...real, spawn, default: { ...real, spawn } };
});

import { probeDatabaseUrl } from '../../src/webui/dbProbe';

const URL_ = 'postgresql://smdb:pw-secret@db.invalid:5432/smdb';

beforeEach(() => {
  h.spawns.length = 0;
  h.delay = {};
  h.code = {};
  h.stderr = {};
  vi.useFakeTimers();
});
afterEach(() => { vi.useRealTimers(); });

describe('the database URL test on a manager without the test image', () => {
  it('pulls the image under its own timeout and starts the 10 second timer only for psql', async () => {
    h.code.image = 1;
    h.delay.pull = 60_000;
    const p = probeDatabaseUrl(URL_, null);
    await vi.advanceTimersByTimeAsync(70_000);
    const res = await p;
    expect(res).toEqual({ ok: true });
    expect(h.spawns.map(a => a[0])).toEqual(['image', 'pull', 'run']);
    expect(h.spawns[2]).toContain('never');
  });

  it('says the image download ran out of time and the database was not tested', async () => {
    h.code.image = 1;
    h.delay.pull = Infinity;
    const p = probeDatabaseUrl(URL_, null);
    await vi.advanceTimersByTimeAsync(400_000);
    const res = await p;
    expect(res.ok).toBe(false);
    expect(res.error).toContain('could not be downloaded');
    expect(res.error).toContain('the database was not tested');
    expect(res.error).not.toMatch(/timed out after 10 seconds/);
    expect(res.notTested).toBe(true);
    expect(h.spawns.map(a => a[0])).toEqual(['image', 'pull']);
  });

  it('names a failed pull with docker\'s last line and runs no psql', async () => {
    h.code.image = 1;
    h.code.pull = 1;
    h.stderr.pull = 'Pulling from library/postgres\nError response from daemon: no space left on device';
    const p = probeDatabaseUrl(URL_, null);
    await vi.advanceTimersByTimeAsync(100);
    const res = await p;
    expect(res.error).toBe('The test image postgres:16-alpine could not be downloaded (Error response from daemon: no space left on device); the database was not tested');
    expect(res.notTested).toBe(true);
    expect(h.spawns.map(a => a[0])).toEqual(['image', 'pull']);
  });

  it('still reports a connection that does not answer in 10 seconds as a timeout', async () => {
    h.delay.run = Infinity;
    const p = probeDatabaseUrl(URL_, null);
    await vi.advanceTimersByTimeAsync(11_000);
    const res = await p;
    expect(res).toEqual({ ok: false, error: 'Connection test timed out after 10 seconds' });
    expect(h.spawns.map(a => a[0])).toEqual(['image', 'run']);
  });
});

describe('an untested database is not reported as a failed connection', () => {
  const root = path.join(__dirname, '..', '..');
  it('the route gives no sslmode hint when the database was not tested', () => {
    const src = fs.readFileSync(path.join(root, 'src/webui/routes/bots.ts'), 'utf8');
    expect(src).toContain('result.notTested ? null : sslModeHint(target)');
    expect(src).toContain('notTested: true');
  });
  it('the env editor asks about an untested database without calling it a failed test', () => {
    const src = fs.readFileSync(path.join(root, 'src/webui/public/index.html'), 'utf8');
    expect(src).toContain('check && check.notTested');
    expect(src).toContain('The database could not be tested:\\n${msg}\\n\\nSave anyway?');
  });
});
