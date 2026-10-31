import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm5-l5-f-client-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir, spawned: [] as Array<{ cmd: string; args: string[] }>, rmPending: false, rmTimers: [] as Array<number | null> };
});

vi.mock('child_process', async (o) => {
  const m = (await import('./switch-harness')).childProcessMock(await o()) as any;
  const spawn = (cmd: string, args: string[], opts?: unknown) => {
    tmp.spawned.push({ cmd, args });
    if (args[0] === 'rm') {
      tmp.rmPending = true;
      queueMicrotask(() => { if (tmp.rmPending) { tmp.rmTimers.push(null); tmp.rmPending = false; } });
    }
    return m.spawn(cmd, args, opts);
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

const runs = (name: string) => fake.calls.filter(c => c.args[0] === 'run' && c.args.includes(`a-fleet-move-${name}`));
const removals = (name: string) => tmp.spawned.filter(s => s.args[0] === 'rm' && s.args.includes(`a-fleet-move-${name}`));

describe('L5 f: the receiver client', () => {
  it('unknown bot', async () => {
    expect(await pushMain('zz', CODE, false)).toEqual({ success: false, status: 404, text: 'Bot not found' });
  });
  it('the probe and the push: their argv, the password in the env only, the dump on stdin, one docker rm -f each under 30 s', async () => {
    const r = await push('a', CODE);
    expect(r.success).toBe(true);
    const probe = runs('probe')[0].args;
    expect(probe.slice(0, 12)).toEqual(HEAD('probe', false));
    expect(probe.slice(13)).toEqual(['sh', DSN('postgres'), DSN('app'), GEN_READ_SQL, `SELECT count(*) FROM smdb_manager.received WHERE push_id = '${PUSH_ID}'`]);
    const pushed = runs('push')[0].args;
    expect(pushed.slice(0, 13)).toEqual(HEAD('push', true));
    expect(pushed.slice(14)).toEqual(['sh', DSN('postgres'), DSN('app')]);
    expect(seen.find(s => s.step === 'probe')!.env.PGPASSWORD).toBe('recvpw');
    expect(seen.find(s => s.step === 'push')!.input).toBe('PGDMP');
    expect(seen.find(s => s.step === 'probe')!.input).toBe('');
    for (const name of ['probe', 'push', 'counts', 'sums', 'commit']) {
      expect(removals(name), name).toEqual([{ cmd: 'docker', args: ['rm', '-f', `a-fleet-move-${name}`] }]);
    }
    expect(tmp.rmTimers).toEqual([30_000, 30_000, 30_000, 30_000, 30_000]);
  });
  it('a probe with no answer in time: a second docker rm -f under 30 s', async () => {
    MOVE_TIMING.clientMs = 30;
    answers.probe = new Promise(() => undefined);
    const r = await push('a', CODE);
    expect(r.success).toBe(false);
    expect(removals('probe')).toEqual([{ cmd: 'docker', args: ['rm', '-f', 'a-fleet-move-probe'] }, { cmd: 'docker', args: ['rm', '-f', 'a-fleet-move-probe'] }]);
    expect(tmp.rmTimers).toEqual([30_000, 30_000]);
  });
  it('a probe that exits with an error: one docker rm, the last line trimmed, the password scrubbed', async () => {
    answers.probe = { code: 3, stdout: '', stderr: 'psql: error: connection to server failed\n   DETAIL:  recvpw was sent\n' };
    expect((await push('a', CODE)).text).toBe("win.example:5440 did not answer the move code's login (DETAIL:  *** was sent); nothing was changed");
    expect(removals('probe')).toHaveLength(1);
  });
  it("a role that does not exist reads as a refused login", async () => {
    answers.probe = { code: 2, stdout: '', stderr: 'psql: error: FATAL:  role "smdb_receive" does not exist' };
    expect((await push('a', CODE)).text).toMatch(/^win\.example:5440 refused the move code's login \(/);
  });
});
