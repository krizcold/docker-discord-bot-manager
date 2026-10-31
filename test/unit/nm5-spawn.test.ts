import { afterEach, describe, expect, it, vi } from 'vitest';

// Node 24's fork faults (D19): a synchronous throw (ENOMEM) and a child with no stdio that emits 'error' on the next
// tick (EMFILE, ENFILE). Both process starts NM5 adds or routes through must answer ok false and throw nothing.
const sp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  process.env.DATA_DIR = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm5-spawn-'));
  return { mode: 'enomem' as 'enomem' | 'emfile' | 'answer', stdout: '', code: 0, args: [] as string[] };
});

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const { EventEmitter } = require('events') as typeof import('events');
  const spawn = (_cmd: string, args: string[]) => {
    if (sp.mode === 'enomem') throw Object.assign(new Error('spawn ENOMEM'), { code: 'ENOMEM' });
    const child: any = new EventEmitter();
    if (sp.mode === 'answer') {
      const { PassThrough } = require('stream') as typeof import('stream');
      sp.args = args;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new PassThrough();
      child.kill = () => true;
      setTimeout(() => { child.stdout.end(sp.stdout); child.stderr.end(''); setTimeout(() => child.emit('close', sp.code), 1); }, 1);
      return child;
    }
    child.stdout = null;
    child.stderr = null;
    child.stdin = null;
    child.kill = () => true;
    process.nextTick(() => child.emit('error', Object.assign(new Error('spawn EMFILE'), { code: 'EMFILE' })));
    return child;
  };
  const execFile = (_c: string, _a: string[], o: unknown, c?: unknown) => { const cb = (typeof o === 'function' ? o : c) as ((e: Error | null) => void) | undefined; setTimeout(() => cb?.(null), 0); return { on: () => undefined }; };
  return { ...real, spawn, execFile, default: { ...real, spawn, execFile } };
});

import { runGuarded } from '../../src/instance/fleetSwitch';
import { peerProbe, runPrimaryClient } from '../../src/instance/fleetJoin';
import { RECEIVE_MARK_COUNT_SQL } from '../../src/instance/switchSql';
import { FIXTURE_PEM, fakeJoin } from './join-fake';

const uncaught: unknown[] = [];
const onUncaught = (e: unknown) => { uncaught.push(e); };
process.on('uncaughtException', onUncaught);
afterEach(() => { expect(uncaught).toEqual([]); });

describe('runGuarded and runPrimaryClient under the fork faults', () => {
  it.each(['enomem', 'emfile'] as const)('runGuarded, %s: ok false with the reason, input or not', async mode => {
    sp.mode = mode;
    const r = await runGuarded('docker', ['exec', '-i', 'c', 'psql'], { input: 'SELECT 1', timeoutMs: 5000 });
    expect(r.ok).toBe(false);
    expect(r.error).toContain(mode === 'enomem' ? 'could not start (spawn ENOMEM)' : 'failed (spawn EMFILE)');
    expect((await runGuarded('docker', ['ps'])).ok).toBe(false);
  });
  it.each(['enomem', 'emfile'] as const)('runPrimaryClient, %s: ok false', async mode => {
    sp.mode = mode;
    const r = await runPrimaryClient('smdb-x', { password: 'pw' }, [], 'psql', ['-c', 'SELECT 1'], 5000);
    expect(r.ok).toBe(false);
    expect(r.stderr).toMatch(mode === 'enomem' ? /docker run could not start \(spawn ENOMEM\)/ : /docker run failed/);
  });
});

describe('peerProbe reads the receive mark count on the target\'s postgres database (D64)', () => {
  const inst = { id: 'a', sanitizedName: 'a', displayName: 'A' } as any;
  it.each([
    ['1', true], ['0', false], ['unread', null], ['', null],
  ] as const)('the fourth line %j -> receiveMark %s', async (line, want) => {
    sp.mode = 'answer';
    sp.code = 0;
    sp.stdout = `7001|2|0/5000000\nfalse\n4|copy.example|2026-10-30T09:00:00Z\n${line}\n`;
    const p = await peerProbe(inst, fakeJoin({ host: 'copy.example', port: 5434, db: 'app' }), FIXTURE_PEM);
    expect(p).toMatchObject({ kind: 'writable', systemId: '7001', receiveMark: want });
    const tail = sp.args.slice(sp.args.indexOf('-c') + 1);
    expect(tail[0]).toContain('2>/tmp/mark.err || { if grep -q smdb_manager /tmp/mark.err; then echo 0; else echo unread; fi; }');
    expect(tail[2]).toMatch(/\/app\?/);
    expect(tail[4]).toMatch(/@copy\.example:5434\/postgres\?sslmode=verify-full/);
    expect(tail[5]).toBe(RECEIVE_MARK_COUNT_SQL);
  });
});
