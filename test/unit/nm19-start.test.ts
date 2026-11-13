import { describe, expect, it, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

const h = vi.hoisted(() => ({ mode: 'ok' as 'ok' | 'throw' | 'nostdio', spawnArgs: [] as any[][], execArgs: [] as any[][] }));

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const fault = () => Object.assign(new Error('spawn ENOMEM'), { code: 'ENOMEM' });
  const spawn = (...a: any[]) => {
    h.spawnArgs.push(a);
    if (h.mode === 'throw') throw fault();
    const child: any = new EventEmitter();
    child.stdin = null; child.stdout = null; child.stderr = null;
    child.kill = () => true;
    process.nextTick(() => child.emit('error', Object.assign(new Error('spawn EMFILE'), { code: 'EMFILE' })));
    return child;
  };
  const execFile = (...a: any[]) => {
    h.execArgs.push(a);
    if (h.mode === 'throw') throw fault();
    const cb = a[a.length - 1];
    process.nextTick(() => cb(Object.assign(new Error('spawn EMFILE'), { code: 'EMFILE' }), '', ''));
    return new EventEmitter();
  };
  return { ...real, spawn, execFile, default: { ...real, spawn, execFile } };
});

import { startProcess, execFileGuarded } from '../../src/docker/processStart';

beforeEach(() => { h.mode = 'ok'; h.spawnArgs.length = 0; h.execArgs.length = 0; });

describe('NM19 startProcess', () => {
  it('answers the error and the reason when spawn throws', () => {
    h.mode = 'throw';
    const r = startProcess('docker', ['ps']);
    expect(r.child).toBeUndefined();
    expect(r.error).toBe('docker could not start (spawn ENOMEM)');
    expect(r.reason).toBe('spawn ENOMEM');
  });

  it('answers the child when spawn returns, and passes two arguments when given no options', () => {
    h.mode = 'nostdio';
    const r = startProcess('docker', ['ps']);
    expect(r.child).toBeDefined();
    expect(r.error).toBeUndefined();
    expect(h.spawnArgs[0]).toEqual(['docker', ['ps']]);
    r.child!.on('error', () => {});
  });

  it('passes the options when given', () => {
    h.mode = 'nostdio';
    const r = startProcess('docker', ['ps'], { windowsHide: true });
    expect(h.spawnArgs[0]).toEqual(['docker', ['ps'], { windowsHide: true }]);
    r.child!.on('error', () => {});
  });
});

describe('NM19 execFileGuarded', () => {
  it('calls back on a later tick with the message and the code when execFile throws', async () => {
    h.mode = 'throw';
    const seen: any[] = [];
    execFileGuarded('docker', ['ps'], { timeout: 5 }, (err, stdout, stderr) => seen.push([err, stdout, stderr]));
    expect(seen).toHaveLength(0);
    await new Promise(r => setImmediate(r));
    expect(seen).toHaveLength(1);
    expect(seen[0][0].message).toBe('docker could not start (spawn ENOMEM)');
    expect(seen[0][0].code).toBe('ENOMEM');
    expect(seen[0][1]).toBe('');
    expect(seen[0][2]).toBe('');
  });

  it('passes the same arguments to execFile', async () => {
    h.mode = 'nostdio';
    const seen: any[] = [];
    const cb = (err: any) => seen.push(err);
    execFileGuarded('docker', ['ps'], { timeout: 5 }, cb);
    expect(h.execArgs[0]).toEqual(['docker', ['ps'], { timeout: 5 }, cb]);
    await new Promise(r => setImmediate(r));
    expect(seen[0].code).toBe('EMFILE');
  });
});
