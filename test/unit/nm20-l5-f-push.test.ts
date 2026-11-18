import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm20-l5-f-push-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir, skipped: null as { check: number; cap: number } | null, tocLength: null as number | null };
});

vi.mock('child_process', async (o) => (await import('./switch-harness')).childProcessMock(await o()));
vi.mock('../../src/instance/dbLogin', async (o) => (await import('./switch-harness')).dbLoginMock(await o()));
vi.mock('../../src/instance/maintenance', async (o) => (await import('./switch-harness')).maintenanceMock(await o()));
vi.mock('../../src/docker/containerManager', async (o) => (await import('./switch-harness')).containerManagerMock(await o()));
vi.mock('../../src/instance/fleetBackup', async (o) => {
  const real = await o<typeof import('../../src/instance/fleetBackup')>();
  const m = (await import('./switch-harness')).fleetBackupMock(real);
  return {
    ...m,
    readArchiveMeta: async (c: string, p: string) => {
      const r = await real.readArchiveMeta(c, p);
      return r.ok && tmp.skipped ? { ...r, skipped: tmp.skipped } : r;
    },
    readDumpToc: async (c: string, p: string, s?: string) => (tmp.tocLength !== null ? { ok: true, toc: 'x'.repeat(tmp.tocLength) } : real.readDumpToc(c, p, s)),
  };
});
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
import { TOC_MAX_CHARS } from '../../src/instance/fleetBackup';
import { releaseFleetBackupBusy } from '../../src/instance/fleetBackupGuards';
import { getBotDir } from '../../src/git/repoManager';
import { fake, fakeJoin, freshDb, mainFixture, resetHarness, writeRegistry } from './switch-harness';

const FILE = 'pre-push-2026-10-28T12-00-00-000Z.dump';
const SUM = 'checksum|"public"."t"|0123456789abcdef0123456789abcdef';
const CODE = encodeMoveCode({ ...fakeJoin({ host: 'win.example', port: 5440, machine: 'win.example', db: 'app', app: { user: 'app', password: 'apppw' } }), recv: { user: 'smdb_receive', password: 'recvpw', id: '0123456789abcdef01234567' }, recvMeta: { user: 'smdb_receive_meta', password: 'metapw' } } as any);
const DIR = path.join(tmp.dir, 'backups', 'a', 'fleet-postgres');
const TWO_LINES = 'ERROR:  first\nlast line';
const ALL = ['probe', 'create', 'meta', 'push', 'counts', 'sums', 'cap', 'commit', 'last', 'last-meta'];
const W_LAST = "[Switch] A: the receive login's password could not be removed after the push (ERROR:  first); the receiving machine removes the move code's logins at its own checks of receiving, and until its first check this move code's password still opens them";
const W_META = "[Switch] A: what the second receive login owns in the pushed database could not be handed to the bot's role after the push (ERROR:  first); the receiving machine does it when it ends receiving";
const UNCHANGED = 'Nothing was sent; the other machine is unchanged.';

type Answer = { code: number; stdout: string; stderr: string };
let answers: Record<string, Answer> = {};
const steps: string[] = [];
const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
const bad = (stderr: string) => ({ code: 1, stdout: '', stderr });
const client = (step: string) => {
  const args = fake.calls.find(c => c.args[0] === 'run' && c.args.includes(`a-fleet-move-${step}`))!.args;
  return args[args.indexOf('postgres:16-alpine') + 2];
};
const capture = () => {
  const out: string[] = [];
  const spy = vi.spyOn(console, 'warn').mockImplementation((m: unknown) => { out.push(String(m)); });
  return { out, restore: () => spy.mockRestore() };
};
const ours = (out: string[]) => out.filter(m => m.startsWith('[Switch] A:'));

beforeEach(() => {
  resetHarness();
  releaseFleetBackupBusy('a');
  tmp.skipped = null;
  tmp.tocLength = null;
  fake.dbs['a-pg'] = freshDb();
  writeRegistry({ a: mainFixture() });
  steps.length = 0;
  answers = { probe: ok('false\n2|win.example|\n0\n'), counts: ok('count|"public"."t"|3\n'), sums: ok(`${SUM}\n`) };
  fake.run = (args) => {
    const name = args[args.indexOf('--name') + 1];
    const step = name.split('-fleet-move-')[1];
    steps.push(step);
    return answers[step] ?? ok();
  };
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, FILE), 'PGDMP');
  fs.writeFileSync(path.join(DIR, `${FILE}.json`), JSON.stringify({ file: FILE, takenAt: 1, family: 'main', kind: 'safety', inRecovery: false, dataAt: null, dbBytes: 1, counts: { '"public"."t"': 3 }, tables: 1, rows: 3 }));
});
afterEach(() => { vi.restoreAllMocks(); });
afterAll(() => fs.rmSync(tmp.dir, { recursive: true, force: true }));

describe('L5 f (NM20): the sender reads its own dump', () => {
  it('no address rows left out: no warning', async () => {
    const warn = capture();
    expect((await push('a', CODE)).success).toBe(true);
    warn.restore();
    expect(ours(warn.out).filter(m => m.includes('left out'))).toEqual([]);
  });
  it('rows left out by both the check and the cap: the warning sums them', async () => {
    tmp.skipped = { check: 1, cap: 1 };
    const warn = capture();
    expect((await push('a', CODE)).success).toBe(true);
    warn.restore();
    expect(ours(warn.out).filter(m => m.includes('left out'))).toEqual(['[Switch] A: left out 2 row(s) of smdb_manager.addresses from the pushed dump (1 failed the address check or were over the size limit, 1 past the 1000-row cap)']);
  });
  it('a table of contents exactly at the limit is refused before anything is sent', async () => {
    tmp.tocLength = TOC_MAX_CHARS;
    expect((await push('a', CODE)).text).toBe(`The push was refused: this database's dump could not be read (its table of contents is longer than 8 MB, so the restore list made from it could miss an entry). ${UNCHANGED}`);
    expect(steps).toEqual(['probe']);
  }, 60_000);
  it('the restore list cannot be written: the refusal names it and nothing is sent', async () => {
    const listPath = path.join(getBotDir('a'), 'fleet-join', 'push-restore.list');
    fs.mkdirSync(listPath, { recursive: true });
    try {
      expect((await push('a', CODE)).text).toMatch(/^The push was refused: the list of the dump's entries could not be written \(.+\)\. Nothing was sent; the other machine is unchanged\.$/);
    } finally {
      fs.rmSync(listPath, { recursive: true, force: true });
    }
    expect(steps).toEqual(['probe']);
  });
});

describe('L5 f (NM20): the receiver steps', () => {
  it('the meta transaction fails: the push fails there', async () => {
    answers.meta = bad(TWO_LINES);
    expect((await push('a', CODE)).text).toBe("The push to win.example failed (ERROR:  first). This machine's database is unchanged; win.example's database is incomplete, and its bot stays Off. Press Push again with the same code, or Cancel the push.");
    expect(steps).toEqual(['probe', 'create', 'meta']);
  });
  it('the cap fails: the receiver is not made the main', async () => {
    answers.cap = bad(TWO_LINES);
    expect((await push('a', CODE)).text).toBe('The data reached win.example and matched, but win.example could not be made the main (ERROR:  first). Press Push again.');
    expect(steps).toEqual(['probe', 'create', 'meta', 'push', 'counts', 'sums', 'cap']);
  });
});

describe('L5 f (NM20): the last step', () => {
  it('both clean-ups succeed: quiet psql scripts and no warning', async () => {
    const warn = capture();
    expect((await push('a', CODE)).success).toBe(true);
    warn.restore();
    expect(steps).toEqual(ALL);
    expect(client('last')).toBe('psql -X "$1" -v ON_ERROR_STOP=1 -q');
    expect(client('last-meta')).toBe('psql -X "$1" -v ON_ERROR_STOP=1 -q');
    expect(ours(warn.out)).toEqual([]);
  });
  it('the smdb_receive clean-up fails: its warning names the ERROR line, the push still succeeds', async () => {
    answers.last = bad(TWO_LINES);
    const warn = capture();
    expect((await push('a', CODE)).success).toBe(true);
    warn.restore();
    expect(ours(warn.out)).toEqual([W_LAST]);
  });
  it('the smdb_receive_meta clean-up fails: its warning names the ERROR line, the push still succeeds', async () => {
    answers['last-meta'] = bad(TWO_LINES);
    const warn = capture();
    expect((await push('a', CODE)).success).toBe(true);
    warn.restore();
    expect(ours(warn.out)).toEqual([W_META]);
  });
});

