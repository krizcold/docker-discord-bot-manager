import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm9-push-'));
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
import * as switchSql from '../../src/instance/switchSql';
import { fake, fakeJoin, freshDb, h, mainFixture, resetHarness, stored, writeRegistry } from './switch-harness';

const FILE = 'pre-push-2026-10-28T12-00-00-000Z.dump';
const SUM = 'checksum|"public"."t"|0123456789abcdef0123456789abcdef';
const PUSH_ID = '0123456789abcdef01234567';
const CODE = encodeMoveCode({ ...fakeJoin({ host: 'win.example', port: 5440, machine: 'win.example', db: 'app', app: { user: 'app', password: 'apppw' } }), recv: { user: 'smdb_receive', password: 'recvpw', id: PUSH_ID } } as any);
const PUSH_MARK = { mode: 'push', machine: 'win.example', host: 'win.example', port: 5440, generation: 4, file: FILE, phase: 'pushing', at: '2026-10-28T12:00:00.000Z' };
const RECEIVED = `INSERT INTO smdb_manager.received (push_id, from_system_id, from_machine, generation) VALUES ('${PUSH_ID}', '7001', 'main.example', 4) ON CONFLICT (push_id) DO NOTHING;`;
const CAP: string = (switchSql as any).SHARD_CAP_DO_SQL;

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
  answers = { probe: ok('false\n2|win.example|\n0\n'), push: ok(), counts: ok('count|"public"."t"|3\n'), sums: ok(`${SUM}\n`), commit: ok() };
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

const commits = () => fake.calls.filter(c => c.args[0] === 'run' && c.args.includes('a-fleet-move-commit')).map(c => c.args[c.args.length - 1]);
const count = (text: string, part: string) => text.split(part).length - 1;

describe('NM9 the push caps the receiver\'s shard claims in its commit (D14, D17)', () => {
  it('H1: the commit holds the cap once, after the received row and before the final SELECT and COMMIT', async () => {
    const r = await push('a', CODE);
    expect(r.success).toBe(true);
    expect(typeof CAP).toBe('string');
    const [commit] = commits();
    expect(commit.startsWith('SET ROLE dbm_admin;\nBEGIN;')).toBe(true);
    expect(count(commit, CAP)).toBe(1);
    const cap = commit.indexOf(CAP);
    expect(commit.indexOf(RECEIVED)).toBeGreaterThan(0);
    expect(cap).toBeGreaterThan(commit.indexOf(RECEIVED));
    expect(commit.slice(cap + CAP.length)).toMatch(/^SELECT generation \|\| '\|' \|\| machine .*\nCOMMIT;$/);
    expect(h.events.filter(e => e.startsWith('dump:') || e.startsWith('client:') || e === 'stop-bot:push' || e === 'reseed')).toEqual(['client:probe', 'dump:pre-push-', 'client:push', 'client:counts', 'client:sums', 'client:commit', 'stop-bot:push', 'reseed']);
  });

  it('H4: the commit fails: NM5\'s text, no done phase', async () => {
    answers.commit = { code: 1, stdout: '', stderr: 'ERROR:  permission denied for table shard_claims' };
    const r = await push('a', CODE);
    expect(r.text).toBe('The data reached win.example and matched, but win.example could not be made the main (ERROR:  permission denied for table shard_claims). Press Push again.');
    expect(stored('a').fleetDb.handover.phase).toBe('pushing');
    expect(count(commits()[0], CAP)).toBe(1);
  });

  it('H5: Push again after H4 sends the commit again, with the cap', async () => {
    answers.commit = { code: 1, stdout: '', stderr: 'ERROR:  could not serialize access' };
    await push('a', CODE);
    answers.commit = ok();
    steps.length = 0;
    const again = await push('a', CODE);
    expect(again.success).toBe(true);
    expect(steps).toEqual(['probe', 'push', 'counts', 'sums', 'commit']);
    const all = commits();
    expect(all).toHaveLength(2);
    expect(count(all[1], CAP)).toBe(1);
    expect(stored('a').fleetDb.handover.phase).toBe('done');
  });

  it('H6: the received row already there, with the push mark and its dump: no commit sent', async () => {
    writeRegistry({ a: mainFixture({ fleetDb: { ...(mainFixture().fleetDb as object), handover: PUSH_MARK } }) });
    answers.probe = ok('false\n4|win.example|\n1\n');
    const r = await push('a', CODE);
    expect(r.success).toBe(true);
    expect(commits()).toEqual([]);
    expect(stored('a').fleetDb.handover.phase).toBe('done');
  });
});
