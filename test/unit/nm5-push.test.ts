import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm5-push-'));
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
import * as containerManager from '../../src/docker/containerManager';
import { fake, fakeJoin, freshDb, h, mainFixture, registryFile, resetHarness, stored, writeRegistry } from './switch-harness';

const NOTHING = '; nothing was changed';
const FILE = 'pre-push-2026-10-28T12-00-00-000Z.dump';
const SUM = 'checksum|"public"."t"|0123456789abcdef0123456789abcdef';
const PUSH_ID = '0123456789abcdef01234567';
const CODE = encodeMoveCode({ ...fakeJoin({ host: 'win.example', port: 5440, machine: 'win.example', db: 'app', app: { user: 'app', password: 'apppw' } }), recv: { user: 'smdb_receive', password: 'recvpw', id: PUSH_ID } } as any);
const OTHER = encodeMoveCode({ ...fakeJoin({ host: 'win.example', port: 5440, machine: 'win.example', app: { user: 'other', password: 'x' } }), recv: { user: 'smdb_receive', password: 'recvpw', id: PUSH_ID } } as any);
const PUSH_MARK = { mode: 'push', machine: 'win.example', host: 'win.example', port: 5440, generation: 4, file: FILE, phase: 'pushing', at: '2026-10-28T12:00:00.000Z' };

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

const destructive = () => steps.filter(s => s === 'push' || s === 'commit');

describe('O6 Push', () => {
  it('P1: dump, intent, drop and restore, counts, checksums, commit, done, stop, rejoin', async () => {
    const r = await push('a', CODE);
    expect(r.text).toBe(`The database was pushed to win.example and checked: 1 tables and 3 rows, with the same counts and checksums on both. win.example is the main now (generation 4); choose Running in its State window to start the bot there. This machine now rebuilds itself as a copy of win.example; a dump of its database from before the push is kept with the backups (${FILE}).`);
    expect(h.events.filter(e => e.startsWith('dump:') || e.startsWith('client:') || e === 'stop-bot:push' || e === 'reseed')).toEqual(['client:probe', 'dump:pre-push-', 'client:push', 'client:counts', 'client:sums', 'client:commit', 'stop-bot:push', 'reseed']);
    expect(stored('a').fleetDb.handover).toMatchObject({ mode: 'push', phase: 'done', generation: 4, file: FILE });
    expect(h.reseedCalls[0].opts).toEqual({ dumpDone: true, safetyDump: FILE });
    const commit = fake.calls.find(c => c.args[0] === 'run' && c.args.includes('a-fleet-move-commit'))!;
    expect(commit.args.join(' ')).toContain(`INSERT INTO smdb_manager.received (push_id, from_system_id, from_machine, generation) VALUES ('${PUSH_ID}', '7001', 'main.example', 4) ON CONFLICT (push_id) DO NOTHING`);
    const probe = fake.calls.find(c => c.args[0] === 'run' && c.args.includes('a-fleet-move-probe'))!;
    expect(probe.args[probe.args.length - 1]).toBe(`SELECT count(*) FROM smdb_manager.received WHERE push_id = '${PUSH_ID}'`);
  });
  it.each([
    ['not a move code', 'smdbjoin1.xyz', /^This is not a move code: /],
    ['own address', encodeMoveCode({ ...fakeJoin({ host: 'main.example', port: 5433 }), recv: { user: 'smdb_receive', password: 'p', id: PUSH_ID } } as any), new RegExp(`^That move code is for this machine's own database${NOTHING}$`)],
    ['owner role differs', OTHER, new RegExp(`^The other machine's database role is other, not app, so the pushed tables would have no owner there${NOTHING}$`)],
  ])('P2: %s', async (_n, code, text) => {
    expect((await push('a', code as string)).text).toMatch(text);
    expect(destructive()).toEqual([]);
  });
  it('P2: an admission refusal (receiving here)', async () => {
    writeRegistry({ a: mainFixture({ fleetDb: { ...(mainFixture().fleetDb as object), receive: { startedAt: 'x', expiresAt: 'y', safetyDump: 'z' } } }) });
    expect((await push('a', CODE)).text).toBe(`This database is waiting to receive a main from another machine; Stop receiving first${NOTHING}`);
  });
  it('P3: held no refuses with "push"', async () => {
    h.proof = { ok: true, state: 'maintenance', enforcement: 'database', botConfirmed: true, held: { state: 'no', guilds: 1, files: 0 } };
    expect((await push('a', CODE)).text).toBe('The bot reports changes it could not save (1 guild(s), 0 file(s)), so the push was refused and nothing was changed: a push now would leave them behind. Choose Maintenance again so the bot tries the save again; the bot\'s log names what it could not save.');
    expect(steps).toEqual([]);
  });
  it('P4: the certificate unreachable', async () => {
    h.cert = { ok: false, kind: 'unreachable', reason: 'x', text: 'win.example:5440 did not answer (x); nothing was changed' };
    expect((await push('a', CODE)).text).toBe('win.example:5440 did not answer (x); nothing was changed');
    expect(steps).toEqual([]);
  });
  it.each([
    ['P5 expired', 'psql: error: FATAL:  password authentication failed for user "smdb_receive"'],
    ['P22 fenced', 'psql: error: FATAL:  pg_hba.conf rejects connection for host "1.2.3.4", user "smdb_receive"'],
  ])('%s: MV-LOGIN', async (_n, stderr) => {
    answers.probe = { code: 2, stdout: '', stderr };
    expect((await push('a', CODE)).text).toMatch(/^win\.example:5440 refused the move code's login \(.*\): the code expired, receiving was stopped, a newer code replaced it, or a lane on that machine holds a write fence on its database\. Check that machine's Database window, then press Receive again there; nothing was changed\.$/);
    expect(destructive()).toEqual([]);
  });
  it('P6: the target in recovery', async () => {
    answers.probe = ok('true\n');
    expect((await push('a', CODE)).text).toBe(`The database at win.example:5440 follows another database, so it cannot receive a main${NOTHING}`);
  });
  it('P7 and P19: already received, and this machine\'s push mark names a dump on disk: done, stop, rejoin, nothing pushed again', async () => {
    writeRegistry({ a: mainFixture({ fleetDb: { ...(mainFixture().fleetDb as object), handover: PUSH_MARK } }) });
    answers.probe = ok('false\n4|win.example|\n1\n');
    const r = await push('a', CODE);
    expect(r.success).toBe(true);
    expect(destructive()).toEqual([]);
    expect(h.events).not.toContain('dump:pre-push-');
    expect(stored('a').fleetDb.handover.phase).toBe('done');
    expect(h.reseedCalls[0].opts).toEqual({ dumpDone: true, safetyDump: FILE });
  });
  it('P8: the dump fails', async () => {
    h.dump = { success: false, error: 'pg_dump died' };
    expect((await push('a', CODE)).text).toBe('The dump of this database failed (pg_dump died), so nothing was pushed');
    expect(destructive()).toEqual([]);
  });
  it('P9: the intent write throws: the dump kept, nothing pushed', async () => {
    h.failSwitchWrite = 'ENOSPC';
    expect((await push('a', CODE)).text).toBe(`The push could not be recorded (ENOSPC); the dump ${FILE} was kept and nothing was pushed`);
    expect(destructive()).toEqual([]);
  });
  it('P10: the push fails: the mark stays pushing', async () => {
    answers.push = { code: 1, stdout: '', stderr: 'pg_restore: error: could not execute query' };
    expect((await push('a', CODE)).text).toBe("The push to win.example failed (pg_restore: error: could not execute query). This machine's database is unchanged; win.example's database is incomplete, and its bot stays Off. Press Push again with the same code, or Cancel the push.");
    expect(stored('a').fleetDb.handover.phase).toBe('pushing');
    expect(steps).not.toContain('commit');
  });
  it('P11: counts differ', async () => {
    answers.counts = ok('count|"public"."t"|2\n');
    expect((await push('a', CODE)).text).toMatch(/^The pushed copy on win\.example does not match this database \(counts: .*\), so win\.example was not made the main\. Press Push again, or Cancel the push\.$/);
    expect(steps).not.toContain('commit');
  });
  it('P12: checksums differ', async () => {
    answers.sums = ok('checksum|"public"."t"|ffffffffffffffffffffffffffffffff\n');
    expect((await push('a', CODE)).text).toMatch(/^The pushed copy on win\.example does not match this database \(checksums: .*\), so win\.example was not made the main\./);
    expect(steps).not.toContain('commit');
  });
  it('P13: a checksum read fails', async () => {
    fake.dbs['a-pg'].fail.checksum = 'ERROR:  canceling statement due to statement timeout';
    expect((await push('a', CODE)).text).toMatch(/^The pushed copy on win\.example does not match this database \(the checksums could not be read \(/);
    expect(steps).not.toContain('commit');
  });
  it('P14: the commit fails', async () => {
    answers.commit = { code: 1, stdout: '', stderr: 'ERROR:  could not serialize access' };
    expect((await push('a', CODE)).text).toBe('The data reached win.example and matched, but win.example could not be made the main (ERROR:  could not serialize access). Press Push again.');
    expect(stored('a').fleetDb.handover.phase).toBe('pushing');
  });
  it('P16: the app stop fails: S-PUSH + MV-STOPFAIL, and no rejoin', async () => {
    h.stop = { success: false, error: 'compose stop timed out' };
    const r = await push('a', CODE);
    expect(r.text.endsWith(' The bot here did not stop (compose stop timed out); stop it, then press Rejoin as a copy.')).toBe(true);
    expect(h.events).not.toContain('reseed');
  });
  it('P17: the rejoin refuses: S-PUSH + MV-REJOIN', async () => {
    h.reseed = { success: false, error: 'the safety dump folder is full' };
    expect((await push('a', CODE)).text.endsWith(' Rejoining as a copy did not start: the safety dump folder is full; press Rejoin as a copy.')).toBe(true);
  });
  it('P20: Push while one runs', async () => {
    await containerManager.withExternalBotOp('a', 'push', async () => {
      expect((await push('a', CODE)).text).toBe(`Operation 'push' is running on this bot; wait for it to finish${NOTHING}`);
    });
  });
  it.each([
    ['a notice', { fleetRestoreError: { file: 'old.dump', text: 'x', at: 'y', doubt: false } }, null, /^A restore of old\.dump has not finished cleanly \(its notice is on the Database window\), so the push was refused and nothing was changed/],
  ])('P21: %s', async (_n, over, _m, text) => {
    writeRegistry({ a: mainFixture(over) });
    expect((await push('a', CODE)).text).toMatch(text);
    expect(steps).toEqual([]);
  });
  it('P21: the read-only layer on', async () => {
    h.fence = { ok: true, on: true, owner: null, persisted: true };
    expect((await push('a', CODE)).text).toMatch(/^The bot's database is READ-ONLY, and .*\. The push was refused and nothing was changed/);
    expect(steps).toEqual([]);
  });
});

describe('P15, P18: a push cut after the intent', () => {
  const S_PUSH = `The database was pushed to win.example and checked: 1 tables and 3 rows, with the same counts and checksums on both. win.example is the main now (generation 4); choose Running in its State window to start the bot there. This machine now rebuilds itself as a copy of win.example; a dump of its database from before the push is kept with the backups (${FILE}).`;
  it('P15: the done write throws: S-PUSH + NOTREC-TAIL, the mark stays pushing, and Push again takes P7', async () => {
    const run = fake.run!;
    fake.run = (args, env, input) => {
      const r = run(args, env, input);
      if (steps.at(-1) === 'commit') h.failSwitchWrite = 'EACCES: permission denied';
      return r;
    };
    const r = await push('a', CODE);
    expect(r.text).toBe(`${S_PUSH} The manager could not record this (EACCES: permission denied); press the same button again to finish recording it.`);
    expect(stored('a').fleetDb.handover).toMatchObject({ mode: 'push', phase: 'pushing' });
    h.failSwitchWrite = null;
    steps.length = 0;
    answers.probe = ok('false\n4|win.example|\n1\n');
    const again = await push('a', CODE);
    expect(again.success).toBe(true);
    expect(destructive()).toEqual([]);
    expect(stored('a').fleetDb.handover).toMatchObject({ mode: 'push', phase: 'done', generation: 4 });
  });

  it.each(['push', 'counts', 'commit'] as const)('P18: a crash at %s: the mark stays pushing; Push again replaces the target again', async (at) => {
    const run = fake.run!;
    let crashed = false;
    let answer: (a: { code: number; stdout: string; stderr: string }) => void = () => undefined;
    fake.run = ((args: string[], env: Record<string, string | undefined>, input: string) => {
      const name = args[args.indexOf('--name') + 1];
      if (!crashed && name.endsWith(`-fleet-move-${at}`)) { crashed = true; return new Promise(r => { answer = r; }); }
      return run(args, env, input);
    }) as typeof run;
    const first = push('a', CODE);
    await vi.waitFor(() => expect(crashed).toBe(true));
    // The manager stops while the client runs: the registry stays as it is now, and the op lock goes with the process.
    const atCrash = fs.readFileSync(registryFile());
    expect(stored('a').fleetDb.handover).toMatchObject({ mode: 'push', phase: 'pushing' });
    answer({ code: 1, stdout: '', stderr: 'killed' });
    await first;
    fs.writeFileSync(registryFile(), atCrash);
    expect(steps).not.toContain('commit');
    steps.length = 0;
    const again = await push('a', CODE);
    expect(again.success).toBe(true);
    expect(steps).toEqual(['probe', 'push', 'counts', 'sums', 'commit']);
    expect(stored('a').fleetDb.handover).toMatchObject({ mode: 'push', phase: 'done', generation: 4 });
  });
});

describe('P23, P24: the received row of this push id (D41)', () => {
  it.each([
    ['no push mark here', null, 'this machine has no record of making it'],
    ['the dump gone', { ...PUSH_MARK, file: 'pre-push-gone.dump' }, 'the dump this machine made for it, pre-push-gone.dump, is no longer on disk'],
  ])('P23: already received, %s: MV-ELSEWHERE, no dump, no stop, no rejoin', async (_n, mark, why) => {
    writeRegistry({ a: mainFixture({ fleetDb: { ...(mainFixture().fleetDb as object), ...(mark ? { handover: mark } : {}) } }) });
    const before = fs.readFileSync(registryFile(), 'utf-8');
    answers.probe = ok('false\n4|win.example|\n1\n');
    const r = await push('a', CODE);
    expect(r.text).toBe(`win.example:5440 already holds the push made with this move code, and ${why}, so nothing was pushed or changed here. If this database should move there, press Receive again on that machine and push with the new move code.`);
    expect(r.success).toBe(false);
    expect(h.events.filter(e => e.startsWith('dump:') || e.startsWith('stop-bot') || e === 'reseed')).toEqual([]);
    expect(destructive()).toEqual([]);
    expect(fs.readFileSync(registryFile(), 'utf-8')).toBe(before);
  });
  it('P24: a target that holds an older push of this database (another push id) is pushed in full', async () => {
    const rows = new Set<string>(['aaaaaaaaaaaaaaaaaaaaaaaa']);
    fake.run = (args) => {
      const name = args[args.indexOf('--name') + 1];
      const step = name.split('-fleet-move-')[1] as Step;
      steps.push(step);
      h.events.push(`client:${step}`);
      if (step === 'probe') {
        // The receiver counts the rows the probe asks for: this code's push id, or (the built key) any row of this system id.
        const id = /push_id = '([0-9a-f]+)'/.exec(args[args.length - 1])?.[1];
        return ok(`false\n3|win.example|\n${(id ? rows.has(id) : rows.size > 0) ? 1 : 0}\n`);
      }
      if (step === 'commit') rows.add(/VALUES \('([0-9a-f]+)'/.exec(args.join(' '))![1]);
      return answers[step] ?? ok();
    };
    const r = await push('a', CODE);
    expect(r.success).toBe(true);
    expect(steps).toEqual(['probe', 'push', 'counts', 'sums', 'commit']);
    expect(h.events).toContain('dump:pre-push-');
    expect(rows.has(PUSH_ID)).toBe(true);
    expect(h.reseedCalls[0].opts).toEqual({ dumpDone: true, safetyDump: FILE });
  });
});

describe('G20: Push and Move out by file while pushBroken stands', () => {
  it('Push and Move out by file: HV-ADMIT\'s push entry, nothing changed', async () => {
    const { moveOutByFile } = await import('../../src/instance/fleetMove');
    writeRegistry({ a: mainFixture({ fleetDb: { ...(mainFixture().fleetDb as object), pushBroken: { at: 'x', safetyDump: 'pre-receive-old.dump' } } }) });
    const text = 'A push into this database did not finish; restore the dump pre-receive-old.dump or receive a push again first; nothing was changed';
    expect((await push('a', CODE)).text).toBe(text);
    expect((await moveOutByFile('a', true)).text).toBe(text);
    expect(steps).toEqual([]);
    expect(h.events.filter(e => e.startsWith('dump:'))).toEqual([]);
  });
});

describe('P25 (D59): the commit runs as the manager role', () => {
  it('the commit script starts with SET ROLE dbm_admin, before the raise', async () => {
    expect((await push('a', CODE)).success).toBe(true);
    const commit = fake.calls.find(c => c.args[0] === 'run' && c.args.includes('a-fleet-move-commit'))!;
    const script = commit.args[commit.args.length - 1];
    expect(script.startsWith('SET ROLE dbm_admin;\nBEGIN;')).toBe(true);
  });
});
