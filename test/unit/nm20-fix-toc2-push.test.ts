// NM20 fix toc 2 (rule d), on the sender: the push reads its own dump's table of contents in full and with
// -n smdb_manager, and sends the list without the manager's entries. The harness is the switch harness; the two
// pg_restore -l reads answer with the text pg_restore 16 prints (out/NM20/claim-toc.txt, claim-toc2.txt).
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm20-fix-toc2-push-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir, toc: '', managerToc: '', managerFail: null as string | null, tocArgs: [] as string[][] };
});

vi.mock('child_process', async (o) => {
  const m = (await import('./switch-harness')).childProcessMock(await o()) as Record<string, any>;
  const { EventEmitter } = await import('events');
  const { PassThrough } = await import('stream');
  const spawn = (cmd: string, args: string[], opts?: unknown) => {
    if (cmd === 'docker' && args[0] === 'exec' && args.includes('pg_restore') && args.includes('-l')) {
      tmp.tocArgs.push([...args]);
      const manager = args.includes('-n');
      const failing = manager && tmp.managerFail !== null;
      const c: any = new EventEmitter();
      c.stdout = new PassThrough();
      c.stderr = new PassThrough();
      c.stdin = new PassThrough();
      c.kill = () => true;
      c.stdin.on('data', () => undefined);
      c.stdin.on('finish', () => setTimeout(() => {
        c.stdout.end(failing ? '' : manager ? tmp.managerToc : tmp.toc);
        c.stderr.end(failing ? tmp.managerFail : '');
        setTimeout(() => c.emit('close', failing ? 1 : 0), 1);
      }, 1));
      return c;
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
import { push } from '../../src/instance/fleetMove';
import { releaseFleetBackupBusy } from '../../src/instance/fleetBackupGuards';
import { getBotDir } from '../../src/git/repoManager';
import { fake, fakeJoin, freshDb, mainFixture, resetHarness, writeRegistry } from './switch-harness';

const FILE = 'pre-push-2026-10-28T12-00-00-000Z.dump';
const SUM = 'checksum|"public"."t"|0123456789abcdef0123456789abcdef';
const CODE = encodeMoveCode({ ...fakeJoin({ host: 'win.example', port: 5440, machine: 'win.example', db: 'app', app: { user: 'app', password: 'apppw' } }), recv: { user: 'smdb_receive', password: 'recvpw', id: '0123456789abcdef01234567' }, recvMeta: { user: 'smdb_receive_meta', password: 'metapw' } } as any);
const DIR = path.join(tmp.dir, 'backups', 'a', 'fleet-postgres');
const LIST = () => path.join(getBotDir('a'), 'fleet-join', 'push-restore.list');

const HEAD = ';\n; Archive created at 2026-11-15 21:19:32 UTC\n;     dbname: bot\n;\n; Selected TOC Entries:\n;\n';
const lines = (entries: string[]) => `${HEAD}${entries.join('\n')}\n`;
const KEPT = [
  '7; 2615 16393 SCHEMA - - app',
  '8; 2615 16394 SCHEMA - ABC app',
  '221; 1259 16397 TABLE - SCHEMA smdb_manager',
  '222; 1259 16400 TABLE - smdb_manager app',
  '223; 1259 16403 TABLE ABC smdb_manager app',
  '3474; 0 16397 TABLE DATA - SCHEMA smdb_manager',
  '3475; 0 16400 TABLE DATA - smdb_manager app',
  '3476; 0 16403 TABLE DATA ABC smdb_manager app',
];
const DROPPED = ['6; 2615 16387 SCHEMA - smdb_manager postgres', '220; 1259 16388 TABLE smdb_manager addresses postgres', '3473; 0 16388 TABLE DATA smdb_manager addresses postgres'];
const UNREAD = (detail: string) => `The push was refused: this database's dump could not be read (${detail}). Nothing was sent; the other machine is unchanged.`;

const steps: string[] = [];
const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
const sent = { text: null as string | null };

beforeEach(() => {
  resetHarness();
  releaseFleetBackupBusy('a');
  Object.assign(tmp, { toc: lines([...KEPT, ...DROPPED]), managerToc: lines(DROPPED.slice(1)), managerFail: null });
  tmp.tocArgs.length = 0;
  sent.text = null;
  fake.dbs['a-pg'] = freshDb();
  writeRegistry({ a: mainFixture() });
  steps.length = 0;
  const answers: Record<string, ReturnType<typeof ok>> = { probe: ok('false\n2|win.example|\n0\n'), counts: ok('count|"public"."t"|3\n'), sums: ok(`${SUM}\n`) };
  fake.run = (args) => {
    const step = args[args.indexOf('--name') + 1].split('-fleet-move-')[1];
    steps.push(step);
    if (step === 'push') sent.text = fs.readFileSync(LIST(), 'utf-8');
    return answers[step] ?? ok();
  };
  fs.rmSync(LIST(), { force: true });
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, FILE), 'PGDMP');
  fs.writeFileSync(path.join(DIR, `${FILE}.json`), JSON.stringify({ file: FILE, takenAt: 1, family: 'main', kind: 'safety', inRecovery: false, dataAt: null, dbBytes: 1, counts: { '"public"."t"': 3 }, tables: 1, rows: 3 }));
});
afterEach(() => { vi.restoreAllMocks(); });
afterAll(() => fs.rmSync(tmp.dir, { recursive: true, force: true }));

describe('the push reads its dump\'s table of contents in full and with -n smdb_manager', () => {
  it('runs pg_restore -l twice, the second with -n smdb_manager, and sends every bot entry without the manager\'s', async () => {
    expect((await push('a', CODE)).success).toBe(true);
    expect(tmp.tocArgs).toEqual([
      ['exec', '-i', 'a-pg', 'timeout', '-s', 'KILL', '60', 'pg_restore', '-l'],
      ['exec', '-i', 'a-pg', 'timeout', '-s', 'KILL', '60', 'pg_restore', '-l', '-n', 'smdb_manager'],
    ]);
    const listed = sent.text!.split('\n');
    for (const line of KEPT) expect(listed).toContain(line);
    for (const line of DROPPED) expect(listed).not.toContain(line);
  });

  it('a failed -n smdb_manager read refuses before anything is sent', async () => {
    tmp.managerFail = 'pg_restore: error: could not read input file';
    const r = await push('a', CODE);
    expect(r.success).toBe(false);
    expect(r.text).toBe(UNREAD('pg_restore exited with code 1: pg_restore: error: could not read input file'));
    expect(steps).toEqual(['probe']);
    expect(fs.existsSync(LIST())).toBe(false);
  });

  it('refuses a schema it cannot tell apart from the manager\'s before anything is sent', async () => {
    tmp.toc = lines([...KEPT, '9; 2615 16403 SCHEMA - smdb_manager x app', '223; 1259 16404 TABLE smdb_manager x t app']);
    tmp.managerToc = lines([]);
    const r = await push('a', CODE);
    expect(r.success).toBe(false);
    expect(r.text).toBe(UNREAD("entry 9 of its table of contents cannot be told apart from the manager's own schema smdb_manager"));
    expect(steps).toEqual(['probe']);
    expect(fs.existsSync(LIST())).toBe(false);
  });
});
