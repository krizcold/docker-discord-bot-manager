import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm5-l5-g-push-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir };
});

const g = vi.hoisted(() => ({ pull: null as string | null, reseedArgs: [] as unknown[][] }));

vi.mock('child_process', async (o) => (await import('./switch-harness')).childProcessMock(await o()));
vi.mock('../../src/instance/dbLogin', async (o) => (await import('./switch-harness')).dbLoginMock(await o()));
vi.mock('../../src/instance/maintenance', async (o) => (await import('./switch-harness')).maintenanceMock(await o()));
vi.mock('../../src/docker/containerManager', async (o) => (await import('./switch-harness')).containerManagerMock(await o()));
vi.mock('../../src/instance/fleetBackup', async (o) => (await import('./switch-harness')).fleetBackupMock(await o()));
vi.mock('../../src/instance/fleetJoin', async (o) => {
  const m = (await import('./switch-harness')).fleetJoinMock(await o());
  return { ...m, ensureClientImage: async () => g.pull };
});
vi.mock('../../src/instance/fleetReplica', async (o) => {
  const m = (await import('./switch-harness')).fleetReplicaMock(await o()) as Record<string, (...a: unknown[]) => unknown>;
  const inner = m.reseedStalePrimary;
  return { ...m, reseedStalePrimary: (...a: unknown[]) => { g.reseedArgs.push(a); return inner(...a); } };
});
vi.mock('../../src/instance/appHookClient', async (o) => (await import('./switch-harness')).appHookMock(await o()));
vi.mock('../../src/instance/backupCheck', async (o) => (await import('./switch-harness')).backupCheckMock(await o()));
vi.mock('../../src/env/manager', async (o) => (await import('./switch-harness')).envMock(await o()));
vi.mock('../../src/config/appCapabilities', async (o) => (await import('./switch-harness')).capsMock(await o()));

import * as fs from 'fs';
import * as path from 'path';
import { encodeMoveCode } from '../../src/config/joinCode';
import { moveOut, moveOutByFile, push, pushMain, receive, stopReceive } from '../../src/instance/fleetMove';
import { SWITCH_TIMING } from '../../src/instance/fleetSwitch';
import { releaseFleetBackupBusy } from '../../src/instance/fleetBackupGuards';
import * as containerManager from '../../src/docker/containerManager';
import { fake, fakeJoin, freshDb, h, mainFixture, resetHarness, stored, writeRegistry } from './switch-harness';

const NOTHING = '; nothing was changed';
const FILE = 'pre-push-2026-10-28T12-00-00-000Z.dump';
const MOVE_FILE = 'pre-move-2026-10-28T12-00-00-000Z.dump';
const SUM = 'checksum|"public"."t"|0123456789abcdef0123456789abcdef';
const PUSH_ID = '0123456789abcdef01234567';
const codeFor = (host: string, port: number) => encodeMoveCode({ ...fakeJoin({ host, port, machine: 'win.example', db: 'app', app: { user: 'app', password: 'apppw' } }), recv: { user: 'smdb_receive', password: 'recvpw', id: PUSH_ID } } as any);
const CODE = codeFor('win.example', 5440);
const PUSH_MARK = { mode: 'push', machine: 'win.example', host: 'win.example', port: 5440, generation: 4, file: FILE, phase: 'pushing', at: '2026-10-28T12:00:00.000Z' };
const S_PUSH = `The database was pushed to win.example and checked: 1 tables and 3 rows, with the same counts and checksums on both. win.example is the main now (generation 4); choose Running in its State window to start the bot there. This machine now rebuilds itself as a copy of win.example; a dump of its database from before the push is kept with the backups (${FILE}).`;
const S_FILE = `The backup ${MOVE_FILE} is ready and is downloading. Upload it in the other machine's manager (Upload a backup in the bot's Database window), then restore it there with the bot in Maintenance or Off. This bot stays stopped here, with its database login blocked, until you Cancel the move.`;
const DSN = (db: string) => `postgresql://smdb_receive@win.example:5440/${db}?sslmode=verify-full&sslrootcert=/primary-ca.crt`;
const DIR = path.join(tmp.dir, 'backups', 'a', 'fleet-postgres');
const TWO_LINES = 'ERROR:  first\nlast line';

type Step = 'probe' | 'push' | 'counts' | 'sums' | 'commit';
let answers: Partial<Record<Step, { code: number; stdout: string; stderr: string }>> = {};
const steps: Step[] = [];
const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
const bad = (stderr: string) => ({ code: 1, stdout: '', stderr });
const withDb = (over: Record<string, unknown>) => mainFixture({ fleetDb: { ...(mainFixture().fleetDb as object), ...over } });
const client = (step: Step) => {
  const args = fake.calls.find(c => c.args[0] === 'run' && c.args.includes(`a-fleet-move-${step}`))!.args;
  const i = args.indexOf('postgres:16-alpine');
  return { script: args[i + 2], rest: args.slice(i + 4) };
};

beforeEach(() => {
  resetHarness();
  releaseFleetBackupBusy('a');
  g.pull = null;
  g.reseedArgs.length = 0;
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
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, FILE), 'PGDMP');
  fs.writeFileSync(path.join(DIR, `${FILE}.json`), JSON.stringify({ file: FILE, takenAt: 1, family: 'main', kind: 'safety', inRecovery: false, dataAt: null, dbBytes: 1, counts: { '"public"."t"': 3 }, tables: 1, rows: 3 }));
});
afterAll(() => fs.rmSync(tmp.dir, { recursive: true, force: true }));

describe('pushMain admission', () => {
  it.each([
    ['a file mark naming the same address', { mode: 'file', host: 'win.example', port: 5440, file: 'x.dump', phase: 'done', at: 'x' }],
    ['a push mark for another host', { ...PUSH_MARK, host: 'other.example' }],
    ['a push mark for another port', { ...PUSH_MARK, port: 9999 }],
  ])('%s is not resumed: the move refused, nothing pushed', async (_n, mark) => {
    writeRegistry({ a: withDb({ handover: mark }) });
    expect((await push('a', CODE)).text).toMatch(/^A move of this database is already recorded \(.*\); finish it or Cancel it first; nothing was changed$/);
    expect(steps).toEqual([]);
  });
  it('a main without replication can push', async () => {
    writeRegistry({ a: withDb({ replication: undefined }) });
    expect((await push('a', CODE)).success).toBe(true);
  });
  it('a retiring main names the push in its refusal', async () => {
    writeRegistry({ a: withDb({ retiringAt: '2026-10-28T00:00:00.000Z' }) });
    expect((await push('a', CODE)).text).toBe(`This instance holds no main database, so there is nothing to push${NOTHING}`);
  });
  it.each([
    ['another host on the own port', 'win.example', 5433],
    ['the own host on another port', 'main.example', 5440],
  ])('a code for %s is not refused as the own database', async (_n, host, port) => {
    const r = await push('a', codeFor(host, port));
    expect(r.text).not.toMatch(/own database/);
    expect(steps[0]).toBe('probe');
  });
  it('Push without a confirm asks when the bot stopped without confirming its save', async () => {
    h.proof = { ok: true, state: 'maintenance', enforcement: 'database', botConfirmed: true, held: { state: 'stopped' } };
    const r = await push('a', CODE);
    expect(r.needsConfirm).toBe(true);
    expect(steps).toEqual([]);
  });
});

describe('pushLocked reads before the dump', () => {
  it('the client image pull fails: its text and nothing changed', async () => {
    g.pull = 'The client image postgres:16-alpine could not be pulled (x)';
    expect((await push('a', CODE)).text).toBe(`The client image postgres:16-alpine could not be pulled (x)${NOTHING}`);
    expect(steps).toEqual([]);
  });
  it('the identity read times out: its error is named', async () => {
    const was = SWITCH_TIMING.readMs;
    SWITCH_TIMING.readMs = 50;
    fake.dbs['a-pg'].beforeAnswer = (sql) => (sql.includes('pg_control_system') ? new Promise<void>(() => undefined) : undefined);
    try {
      expect((await push('a', CODE)).text).toBe(`The manager could not read this database's identity (no answer within 0 seconds)${NOTHING}`);
    } finally {
      SWITCH_TIMING.readMs = was;
    }
    expect(steps).toEqual([]);
  });
  it('the probe fails without a login error: the last stderr line is the reason', async () => {
    answers.probe = { code: 3, stdout: '', stderr: TWO_LINES };
    expect((await push('a', CODE)).text).toBe(`win.example:5440 did not answer the move code's login (last line)${NOTHING}`);
    expect(steps).toEqual(['probe']);
  });
  it.each([
    ['a leading blank line', '\nfalse\n2|win.example|\n0\n'],
    ['CRLF line ends', 'false\r\n2|win.example|\r\n0\r\n'],
    ['no received count line', 'false\n2|win.example|\n'],
  ])('the probe answer with %s is read as not received: the push runs', async (_n, stdout) => {
    answers.probe = ok(stdout);
    const r = await push('a', CODE);
    expect(r.text).toBe(S_PUSH);
    expect(steps).toEqual(['probe', 'push', 'counts', 'sums', 'commit']);
  });
  it('a CRLF recovery answer is still read as in recovery', async () => {
    answers.probe = ok('true\r\n2|win.example|\r\n0\r\n');
    expect((await push('a', CODE)).text).toBe(`The database at win.example:5440 follows another database, so it cannot receive a main${NOTHING}`);
    expect(steps).toEqual(['probe']);
  });
  it('the target generation above this one sets the new generation', async () => {
    answers.probe = ok('false\n7|win.example|\n0\n');
    expect((await push('a', CODE)).text).toContain('win.example is the main now (generation 8);');
  });
  it('the generation read fails: its error is named', async () => {
    fake.dbs['a-pg'].fail['gen-read'] = 'ERROR:  boom';
    expect((await push('a', CODE)).text).toBe(`The manager could not read this database's generation (ERROR:  boom)${NOTHING}`);
  });
  it('the dump fails without a reason', async () => {
    h.dump = { success: false };
    expect((await push('a', CODE)).text).toBe('The dump of this database failed (no reason given), so nothing was pushed');
  });
});

describe('pushLocked clients', () => {
  it('every client runs its own script with its own arguments', async () => {
    expect((await push('a', CODE)).success).toBe(true);
    const probe = client('probe');
    expect(probe.script).toBe('psql "$1" -v ON_ERROR_STOP=1 -Atc "SELECT pg_is_in_recovery()::text" || exit 2; '
      + 'psql "$2" -v ON_ERROR_STOP=1 -Atc "$3" 2>/tmp/g.err || { if grep -q "does not exist" /tmp/g.err; then echo "0||"; else cat /tmp/g.err >&2; exit 3; fi; }; '
      + 'psql "$2" -v ON_ERROR_STOP=1 -Atc "$4" 2>/tmp/r.err || { if grep -q "does not exist" /tmp/r.err; then echo "0"; else cat /tmp/r.err >&2; exit 4; fi; }');
    expect(probe.rest.slice(0, 2)).toEqual([DSN('postgres'), DSN('app')]);
    expect(probe.rest).toHaveLength(4);
    const pushed = client('push');
    expect(pushed.script).toBe(`psql "$1" -v ON_ERROR_STOP=1 -c 'DROP DATABASE IF EXISTS "app" WITH (FORCE)' -c 'CREATE DATABASE "app" OWNER "app"' && pg_restore --exit-on-error --single-transaction -d "$2"`);
    expect(pushed.rest).toEqual([DSN('postgres'), DSN('app')]);
    for (const step of ['counts', 'sums'] as const) {
      const c = client(step);
      expect(c.script).toBe('psql "$1" -v ON_ERROR_STOP=1 -Atc "$2"');
      expect(c.rest).toHaveLength(2);
      expect(c.rest[0]).toBe(DSN('app'));
    }
    expect(client('counts').rest[1]).toMatch(/count/);
    expect(client('sums').rest[1]).toMatch(/checksum/);
    const commit = client('commit');
    expect(commit.script).toBe('psql "$1" -v ON_ERROR_STOP=1 -tAq -c "$2"');
    expect(commit.rest[0]).toBe(DSN('app'));
  });
  it('the push fails with two stderr lines: the ERROR line is named, and the mark keeps it as lastError', async () => {
    answers.push = bad(TWO_LINES);
    const text = "The push to win.example failed (ERROR:  first). This machine's database is unchanged; win.example's database is incomplete, and its bot stays Off. Press Push again with the same code, or Cancel the push.";
    expect((await push('a', CODE)).text).toBe(text);
    expect(stored('a').fleetDb.handover).toMatchObject({ mode: 'push', phase: 'pushing', lastError: text });
  });
  it('the dump meta file is gone: the counts could not be read', async () => {
    fs.rmSync(path.join(DIR, `${FILE}.json`));
    expect((await push('a', CODE)).text).toMatch(/^The pushed copy on win\.example does not match this database \(the counts could not be read \(ENOENT.+\)\), so win\.example was not made the main\. Press Push again, or Cancel the push\.$/);
    expect(steps).toEqual(['probe', 'push']);
  });
  it('the counts read fails: its ERROR line is named', async () => {
    answers.counts = bad(TWO_LINES);
    expect((await push('a', CODE)).text).toBe('The pushed copy on win.example does not match this database (the counts could not be read (ERROR:  first)), so win.example was not made the main. Press Push again, or Cancel the push.');
  });
  it('the counts answer cannot be parsed', async () => {
    answers.counts = ok('count|"public"."t"|many\n');
    expect((await push('a', CODE)).text).toBe('The pushed copy on win.example does not match this database (the counts could not be read (a table count read back as count|"public"."t"|many)), so win.example was not made the main. Press Push again, or Cancel the push.');
    expect(steps).not.toContain('sums');
  });
  it('the checksum read there fails: its ERROR line is named', async () => {
    answers.sums = bad(TWO_LINES);
    expect((await push('a', CODE)).text).toBe('The pushed copy on win.example does not match this database (the checksums could not be read (ERROR:  first)), so win.example was not made the main. Press Push again, or Cancel the push.');
  });
  it('the commit fails with two stderr lines: the ERROR line is named', async () => {
    answers.commit = bad(TWO_LINES);
    expect((await push('a', CODE)).text).toBe('The data reached win.example and matched, but win.example could not be made the main (ERROR:  first). Press Push again.');
  });
});

describe('pushMain admit and the done step', () => {
  it('a new push calls admit once', async () => {
    const admit = vi.fn();
    expect((await pushMain('a', CODE, false, admit)).success).toBe(true);
    expect(admit).toHaveBeenCalledTimes(1);
  });
  it('an already received push calls admit once', async () => {
    writeRegistry({ a: withDb({ handover: PUSH_MARK }) });
    answers.probe = ok('false\n4|win.example|\n1\n');
    const admit = vi.fn();
    expect((await pushMain('a', CODE, false, admit)).success).toBe(true);
    expect(admit).toHaveBeenCalledTimes(1);
    expect(steps).toEqual(['probe']);
  });
  it('an already received push whose meta file is gone says every table', async () => {
    writeRegistry({ a: withDb({ handover: PUSH_MARK }) });
    answers.probe = ok('false\n4|win.example|\n1\n');
    fs.rmSync(path.join(DIR, `${FILE}.json`));
    expect((await push('a', CODE)).text).toContain('The database was pushed to win.example and checked: every table, with the same counts and checksums on both.');
  });
  it('the app not running: no stop', async () => {
    h.app = false;
    expect((await push('a', CODE)).text).toBe(S_PUSH);
    expect(h.events).not.toContain('stop-bot:push');
  });
  it('the stop answers that the bot is not running: no stop failure, and the rejoin runs', async () => {
    h.stop = { success: false, error: 'Bot is not running' };
    expect((await push('a', CODE)).text).toBe(S_PUSH);
    expect(h.events).toContain('reseed');
  });
  it('the rejoin is started without a confirm, and the log names the push', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      expect((await push('a', CODE)).success).toBe(true);
      expect(log.mock.calls.map(c => c[0])).toContain('[Switch] A: pushed the main to win.example (generation 4)');
    } finally {
      log.mockRestore();
    }
    expect(g.reseedArgs).toHaveLength(1);
    expect(g.reseedArgs[0][4]).toBe(false);
  });
});

describe('moveOut', () => {
  it('an unknown bot', async () => {
    expect(await moveOut('zz', false)).toEqual({ success: false, text: 'Bot not found', status: 404 });
  });
  it('a main without replication can move out', async () => {
    writeRegistry({ a: withDb({ replication: undefined }) });
    expect(await moveOut('a', false)).toMatchObject({ success: true, text: S_FILE });
  });
  it('a retiring main names the move in its refusal', async () => {
    writeRegistry({ a: withDb({ retiringAt: '2026-10-28T00:00:00.000Z' }) });
    expect((await moveOut('a', false)).text).toBe(`This instance holds no main database, so there is nothing to move${NOTHING}`);
  });
  it('a failed dump names no reason given and frees the slot for the next try', async () => {
    h.dump = { success: false };
    expect((await moveOut('a', false)).text).toBe('The dump failed (no reason given), so nothing was changed');
    expect((await moveOut('a', false)).text).toBe('The dump failed (no reason given), so nothing was changed');
  });
  it('the app not running: no stop', async () => {
    h.app = false;
    expect((await moveOut('a', false)).text).toBe(S_FILE);
    expect(h.events).not.toContain('stop-bot:move-out');
  });
  it('the stop answers that the bot is not running: no stop failure', async () => {
    h.stop = { success: false, error: 'Bot is not running' };
    expect((await moveOut('a', false)).text).toBe(S_FILE);
  });
});

describe('the lane wrappers', () => {
  it('each runs under its own operation name', async () => {
    const spy = vi.spyOn(containerManager, 'withExternalBotOp').mockImplementation((async () => ({ success: false, text: 'held' })) as any);
    try {
      await receive('a');
      await stopReceive('a');
      await push('a', CODE);
      await moveOutByFile('a');
      expect(spy.mock.calls.map(c => [c[0], c[1]])).toEqual([['a', 'receive'], ['a', 'receive'], ['a', 'push'], ['a', 'move-out']]);
    } finally {
      spy.mockRestore();
    }
  });
});
