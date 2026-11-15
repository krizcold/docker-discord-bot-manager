// NM22 fix after the rebase, on the sender: the push leaves a large object's entries out of the list it sends and
// refuses a dump whose entry cannot be told apart from one. The harness is nm20-fix-toc2-push's; the lines are
// pg_restore 16's (out/NM22/claim-lo.txt).
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm22-fix-lo-push-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir, toc: '', managerToc: '' };
});

vi.mock('child_process', async (o) => {
  const m = (await import('./switch-harness')).childProcessMock(await o()) as Record<string, any>;
  const { EventEmitter } = await import('events');
  const { PassThrough } = await import('stream');
  const spawn = (cmd: string, args: string[], opts?: unknown) => {
    if (cmd === 'docker' && args[0] === 'exec' && args.includes('pg_restore') && args.includes('-l')) {
      const manager = args.includes('-n');
      const c: any = new EventEmitter();
      c.stdout = new PassThrough();
      c.stderr = new PassThrough();
      c.stdin = new PassThrough();
      c.kill = () => true;
      c.stdin.on('data', () => undefined);
      c.stdin.on('finish', () => setTimeout(() => {
        c.stdout.end(manager ? tmp.managerToc : tmp.toc);
        c.stderr.end('');
        setTimeout(() => c.emit('close', 0), 1);
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

const HEAD = ';\n; Archive created at 2026-11-16 09:12:40 UTC\n;     dbname: bot\n;\n; Selected TOC Entries:\n;\n';
const lines = (entries: string[]) => `${HEAD}${entries.join('\n')}\n`;
const KEPT = ['8; 2615 16398 SCHEMA - LARGE app', '220; 1259 16399 TABLE LARGE t app', '3456; 0 16399 TABLE DATA LARGE t app'];
const MANAGER = ['218; 1259 16389 TABLE smdb_manager addresses postgres', '3454; 0 16389 TABLE DATA smdb_manager addresses postgres'];
const LARGE_OBJECT = ['3457; 2613 16500 BLOB - 16500 app', '3468; 0 0 COMMENT - LARGE OBJECT 16500 app', '3469; 0 0 ACL - LARGE OBJECT 16500 app', '3458; 0 0 BLOBS - BLOBS '];

const steps: string[] = [];
const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
const sent = { text: null as string | null };

beforeEach(() => {
  resetHarness();
  releaseFleetBackupBusy('a');
  Object.assign(tmp, { toc: lines([...KEPT, ...MANAGER, ...LARGE_OBJECT]), managerToc: lines(MANAGER) });
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

describe('the push with a dump that holds a large object', () => {
  it('sends the bot\'s entries and none of the large object\'s', async () => {
    expect((await push('a', CODE)).success).toBe(true);
    expect(sent.text).toBe(lines(KEPT));
  });

  it('refuses a dump holding entry 3465 before anything is sent', async () => {
    tmp.toc = lines([...KEPT, '219; 1259 16395 TABLE - LARGE OBJECT 1 t app', '3465; 0 0 COMMENT - LARGE OBJECT 1 TABLE t app', ...MANAGER]);
    const r = await push('a', CODE);
    expect(r.success).toBe(false);
    expect(r.text).toBe("The push was refused: this database's dump could not be read (entry 3465 of its table of contents cannot be told apart from a large object's entry). Nothing was sent; the other machine is unchanged.");
    expect(steps).toEqual(['probe']);
    expect(fs.existsSync(LIST())).toBe(false);
  });
});
