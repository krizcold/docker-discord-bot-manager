import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm29-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir };
});

vi.mock('child_process', async (o) => (await import('./switch-harness')).childProcessMock(await o()));
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
import { push } from '../../src/instance/fleetMove';
import { releaseFleetBackupBusy } from '../../src/instance/fleetBackupGuards';
import { fake, fakeJoin, freshDb, h, mainFixture, resetHarness, stored, writeRegistry } from './switch-harness';

const FILE = 'pre-push-2026-10-28T12-00-00-000Z.dump';
const SUM = 'checksum|"public"."t"|0123456789abcdef0123456789abcdef';
const PUSH_ID = '0123456789abcdef01234567';
const CODE = encodeMoveCode({ ...fakeJoin({ host: 'win.example', port: 5440, machine: 'win.example', db: 'app', app: { user: 'app', password: 'apppw' } }), recv: { user: 'smdb_receive', password: 'recvpw', id: PUSH_ID }, recvMeta: { user: 'smdb_receive_meta', password: 'metapw' } } as any);

type Step = 'probe' | 'push' | 'counts' | 'sums' | 'commit';
let answers: Partial<Record<Step, { code: number; stdout: string; stderr: string }>> = {};
const steps: Step[] = [];
const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });

beforeEach(() => {
  resetHarness();
  releaseFleetBackupBusy('a');
  fake.dbs['a-pg'] = freshDb();
  writeRegistry({ a: mainFixture() });
  steps.length = 0;
  answers = { push: ok(), counts: ok('count|"public"."t"|3\n'), sums: ok(`${SUM}\n`), commit: ok() };
  fake.run = (args) => {
    const name = args[args.indexOf('--name') + 1];
    const step = name.split('-fleet-move-')[1] as Step;
    steps.push(step);
    h.events.push(`client:${step}`);
    return answers[step] ?? ok();
  };
  const dir = path.join(tmp.dir, 'backups', 'a', 'fleet-postgres');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, FILE), 'PGDMP');
  fs.writeFileSync(path.join(dir, `${FILE}.json`), JSON.stringify({ file: FILE, takenAt: 1, family: 'main', kind: 'safety', inRecovery: false, dataAt: null, dbBytes: 1, counts: { '"public"."t"': 3 }, tables: 1, rows: 3 }));
});
afterAll(() => fs.rmSync(tmp.dir, { recursive: true, force: true }));

const sent = () => steps.filter(s => s !== 'probe');

describe('NM29: a push refuses a receiver that holds a newer main', () => {
  it('receiver above this side: refused, both named, no dump, nothing sent', async () => {
    answers.probe = ok('false\n5|win.example|2026-11-01T00:00:00Z\n0\n');
    const r = await push('a', CODE);
    expect(r.success).toBe(false);
    expect(r.text).toBe('The push was refused: win.example:5440 holds a newer main than this database (generation 5 from win.example; this database is at generation 3 from main.example), so a push would replace its data with older data; nothing was changed');
    expect(h.events).not.toContain('dump:pre-push-');
    expect(sent()).toEqual([]);
  });
  it('equal generation with another machine: refused', async () => {
    answers.probe = ok('false\n3|win.example|2026-11-01T00:00:00Z\n0\n');
    const r = await push('a', CODE);
    expect(r.text).toBe('The push was refused: win.example:5440 holds a newer main than this database (generation 3 from win.example; this database is at generation 3 from main.example), so a push would replace its data with older data; nothing was changed');
    expect(h.events).not.toContain('dump:pre-push-');
    expect(sent()).toEqual([]);
  });
  it('this side with no row against a receiver at 1: the row is written first, the push goes on with target 2', async () => {
    fake.dbs['a-pg'] = freshDb({ generation: null });
    answers.probe = ok('false\n1|win.example|2026-11-01T00:00:00Z\n0\n');
    const r = await push('a', CODE);
    expect(r.success).toBe(true);
    expect(r.text).toContain('(generation 2)');
    expect(h.events).toContain('dump:pre-push-');
    expect(sent()).toContain('commit');
  });
  it('this side with no row and the row write fails: refused with the write error, no dump, nothing sent', async () => {
    fake.dbs['a-pg'] = freshDb({ generation: null });
    fake.dbs['a-pg'].fail['ensure'] = 'ERROR:  disk full';
    answers.probe = ok('false\n1|win.example|2026-11-01T00:00:00Z\n0\n');
    const r = await push('a', CODE);
    expect(r.success).toBe(false);
    expect(r.text).toBe('The push was refused: this database has no generation row, and writing it failed (ERROR:  disk full); nothing was changed');
    expect(h.events).not.toContain('dump:pre-push-');
    expect(sent()).toEqual([]);
  });
  it('this side with no row and the write leaves none: refused, saying the write left no row', async () => {
    fake.dbs['a-pg'] = freshDb({ generation: null, recovery: true });
    answers.probe = ok('false\n1|win.example|2026-11-01T00:00:00Z\n0\n');
    const r = await push('a', CODE);
    expect(r.text).toBe('The push was refused: this database has no generation row, and the write ran but left no row (a database in recovery takes none); nothing was changed');
    expect(h.events).not.toContain('dump:pre-push-');
    expect(sent()).toEqual([]);
  });
  it('already received (a lost reply), no row here and the write failing: Push again finishes, no refusal', async () => {
    writeRegistry({ a: mainFixture({ fleetDb: { ...(mainFixture().fleetDb as object), handover: { mode: 'push', machine: 'win.example', host: 'win.example', port: 5440, generation: 4, file: FILE, phase: 'pushing', at: '2026-10-28T12:00:00.000Z' } } }) });
    fake.dbs['a-pg'] = freshDb({ generation: null });
    fake.dbs['a-pg'].fail['ensure'] = 'ERROR:  disk full';
    answers.probe = ok('false\n4|main.example|2026-11-01T00:00:00Z\n1\n');
    const r = await push('a', CODE);
    expect(r.success, r.text).toBe(true);
    expect(stored('a').fleetDb.handover.phase).toBe('done');
    expect(sent()).toEqual([]);
  });
  it.each([
    ['equal with the same machine', 'false\n3|main.example|2026-11-01T00:00:00Z\n0\n', 4, 3],
    ['receiver below', 'false\n2|win.example|2026-11-01T00:00:00Z\n0\n', 4, 3],
    ['receiver with no row', 'false\n0||\n0\n', 4, 3],
    ['both at the starting generation 1 with different machines', 'false\n1|win.example|2026-11-01T00:00:00Z\n0\n', 2, 1],
  ])('%s: goes on', async (_n, probe, target, ownGen) => {
    fake.dbs['a-pg'].generation = { generation: ownGen, machine: 'main.example', since: '2026-10-28T10:00:00Z' };
    answers.probe = ok(probe);
    const r = await push('a', CODE);
    expect(r.success).toBe(true);
    expect(r.text).toContain(`(generation ${target})`);
    expect(h.events).toContain('dump:pre-push-');
    expect(sent()).toContain('commit');
  });
});
