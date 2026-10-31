import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm5-l5-fix-probe-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir, spawned: [] as Array<{ cmd: string; args: string[] }>, rmPending: false, rmTimers: [] as Array<number | null>, probeBlank: false };
});

vi.mock('child_process', async (o) => {
  const m = (await import('./switch-harness')).childProcessMock(await o()) as any;
  const spawn = (cmd: string, args: string[], opts?: unknown) => {
    tmp.spawned.push({ cmd, args });
    if (args[0] === 'rm') {
      tmp.rmPending = true;
      queueMicrotask(() => { if (tmp.rmPending) { tmp.rmTimers.push(null); tmp.rmPending = false; } });
    }
    const c = m.spawn(cmd, args, opts);
    if (args[0] === 'run' && String(args[args.indexOf('--name') + 1]).endsWith('-fleet-move-probe') && tmp.probeBlank) queueMicrotask(() => c.stderr.write('  \n\n'));
    return c;
  };
  return { ...m, spawn, default: { ...m.default, spawn } };
});
vi.mock('../../src/instance/dbLogin', async (o) => (await import('./switch-harness')).dbLoginMock(await o()));
vi.mock('../../src/instance/maintenance', async (o) => (await import('./switch-harness')).maintenanceMock(await o()));
vi.mock('../../src/docker/containerManager', async (o) => (await import('./switch-harness')).containerManagerMock(await o()));
vi.mock('../../src/instance/fleetBackup', async (o) => (await import('./switch-harness')).fleetBackupMock(await o()));
vi.mock('../../src/instance/fleetJoin', async (o) => (await import('./switch-harness')).fleetJoinMock(await o()));
vi.mock('../../src/instance/fleetReplica', async (o) => (await import('./switch-harness')).fleetReplicaMock(await o()));
vi.mock('../../src/instance/appHookClient', async (o) => (await import('./switch-harness')).appHookMock(await o()));
vi.mock('../../src/instance/backupCheck', async (o) => (await import('./switch-harness')).backupCheckMock(await o()));
vi.mock('../../src/env/manager', async (o) => (await import('./switch-harness')).envMock(await o()));
vi.mock('../../src/config/appCapabilities', async (o) => (await import('./switch-harness')).capsMock(await o()));

import * as fs from 'fs';
import * as path from 'path';
import { encodeMoveCode } from '../../src/config/joinCode';
import { MOVE_TIMING, push, pushMain } from '../../src/instance/fleetMove';
import { GEN_READ_SQL } from '../../src/instance/switchSql';
import { releaseFleetBackupBusy } from '../../src/instance/fleetBackupGuards';
import { fake, fakeJoin, freshDb, h, mainFixture, resetHarness, writeRegistry } from './switch-harness';

const FILE = 'pre-push-2026-10-28T12-00-00-000Z.dump';
const SUM = 'checksum|"public"."t"|0123456789abcdef0123456789abcdef';
const PUSH_ID = '0123456789abcdef01234567';
const CODE = encodeMoveCode({ ...fakeJoin({ host: 'win.example', port: 5440, machine: 'win.example', db: 'app', app: { user: 'app', password: 'apppw' } }), recv: { user: 'smdb_receive', password: 'recvpw', id: PUSH_ID } } as any);
const DSN = (db: string) => `postgresql://smdb_receive@win.example:5440/${db}?sslmode=verify-full&sslrootcert=/primary-ca.crt`;
const HEAD = (name: string, input: boolean) => ['run', '--rm', ...(input ? ['-i'] : []), '--name', `a-fleet-move-${name}`, '-e', 'PGPASSWORD', '-v', '/host/probe.crt:/primary-ca.crt:ro', '--entrypoint', 'sh', 'postgres:16-alpine', '-c'];
const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });

type Step = 'probe' | 'push' | 'counts' | 'sums' | 'commit';
let answers: Partial<Record<Step, any>> = {};
const seen: Array<{ step: Step; env: Record<string, string | undefined>; input: string }> = [];
const clientMs = MOVE_TIMING.clientMs;

beforeEach(() => {
  resetHarness();
  releaseFleetBackupBusy('a');
  fake.dbs['a-pg'] = freshDb();
  writeRegistry({ a: mainFixture() });
  tmp.spawned.length = 0;
  tmp.rmTimers.length = 0;
  tmp.rmPending = false;
  tmp.probeBlank = false;
  const real = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number, ...a: unknown[]) => {
    if (tmp.rmPending) { tmp.rmTimers.push(ms ?? null); tmp.rmPending = false; }
    return (real as any)(fn, ms, ...a);
  }) as any);
  seen.length = 0;
  answers = { probe: ok('false\n2|win.example|\n0\n'), push: ok(), counts: ok('count|"public"."t"|3\n'), sums: ok(`${SUM}\n`), commit: ok() };
  fake.run = (args, env, input) => {
    const step = args[args.indexOf('--name') + 1].split('-fleet-move-')[1] as Step;
    seen.push({ step, env, input });
    return answers[step] ?? ok();
  };
  const dir = path.join(tmp.dir, 'backups', 'a', 'fleet-postgres');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, FILE), 'PGDMP');
  fs.writeFileSync(path.join(dir, `${FILE}.json`), JSON.stringify({ file: FILE, takenAt: 1, family: 'main', kind: 'safety', inRecovery: false, dataAt: null, dbBytes: 1, counts: { '"public"."t"': 3 }, tables: 1, rows: 3 }));
});
afterEach(() => { MOVE_TIMING.clientMs = clientMs; vi.restoreAllMocks(); });
afterAll(() => fs.rmSync(tmp.dir, { recursive: true, force: true }));

const refusal = (reason: string) => `win.example:5440 did not answer the move code's login (${reason}); nothing was changed`;

describe('L5 fix: the reason a failed probe gives', () => {
  it("a probe with no answer in time names the probe's own error", async () => {
    MOVE_TIMING.clientMs = 30;
    answers.probe = new Promise(() => undefined);
    expect(await push('a', CODE)).toMatchObject({ success: false, text: refusal('no answer within 0 seconds') });
  });
  it("a probe that fails with stderr lines gives stderr's last non-empty line", async () => {
    answers.probe = { code: 3, stdout: '', stderr: 'psql: error: first\n  could not connect to server  \n\n' };
    expect((await push('a', CODE)).text).toBe(refusal('could not connect to server'));
  });
  it("a probe that exits non-zero with stderr empty gives runGuarded's own 'no reason given' (a failed run always carries an error, so 'no answer' is not reached)", async () => {
    answers.probe = { code: 3, stdout: '', stderr: '' };
    expect((await push('a', CODE)).text).toBe(refusal('no reason given'));
  });
  it("a probe that times out after writing only blank lines to stderr names the probe's own error", async () => {
    MOVE_TIMING.clientMs = 30;
    answers.probe = new Promise(() => undefined);
    tmp.probeBlank = true;
    expect(await push('a', CODE)).toMatchObject({ success: false, text: refusal('no answer within 0 seconds') });
  });
});
