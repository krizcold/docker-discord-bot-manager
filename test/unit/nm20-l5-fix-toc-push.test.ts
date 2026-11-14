// NM20 fix after L5 (the TOC list), on the sender: an entry the -n smdb_manager read of its own dump lists that the
// full read lacks refuses the push before anything is sent. The harness is the switch harness; no row reaches docker.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm20-l5-fix-toc-push-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir, toc: null as string | null, managerToc: null as string | null };
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
    readDumpToc: async (c: string, p: string, s?: string) => {
      const r = await real.readDumpToc(c, p, s);
      const added = s ? tmp.managerToc : tmp.toc;
      return r.ok && added !== null ? { ok: true, toc: r.toc + added } : r;
    },
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
import { releaseFleetBackupBusy } from '../../src/instance/fleetBackupGuards';
import { getBotDir } from '../../src/git/repoManager';
import { fake, fakeJoin, freshDb, mainFixture, resetHarness, writeRegistry } from './switch-harness';

const FILE = 'pre-push-2026-10-28T12-00-00-000Z.dump';
const SUM = 'checksum|"public"."t"|0123456789abcdef0123456789abcdef';
const CODE = encodeMoveCode({ ...fakeJoin({ host: 'win.example', port: 5440, machine: 'win.example', db: 'app', app: { user: 'app', password: 'apppw' } }), recv: { user: 'smdb_receive', password: 'recvpw', id: '0123456789abcdef01234567' }, recvMeta: { user: 'smdb_receive_meta', password: 'metapw' } } as any);
const DIR = path.join(tmp.dir, 'backups', 'a', 'fleet-postgres');
const LIST = () => path.join(getBotDir('a'), 'fleet-join', 'push-restore.list');

const steps: string[] = [];
const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });

beforeEach(() => {
  resetHarness();
  releaseFleetBackupBusy('a');
  tmp.toc = null;
  tmp.managerToc = null;
  fake.dbs['a-pg'] = freshDb();
  writeRegistry({ a: mainFixture() });
  steps.length = 0;
  const answers: Record<string, ReturnType<typeof ok>> = { probe: ok('false\n2|win.example|\n0\n'), counts: ok('count|"public"."t"|3\n'), sums: ok(`${SUM}\n`) };
  fake.run = (args) => {
    const step = args[args.indexOf('--name') + 1].split('-fleet-move-')[1];
    steps.push(step);
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

describe('the sender refuses a dump whose table of contents it cannot read', () => {
  it('an entry the -n smdb_manager read lists that the full read lacks: refused, nothing sent, no list written', async () => {
    tmp.managerToc = '230; 1259 16420 TABLE2 smdb_manager x dbm_meta\n';
    const r = await push('a', CODE);
    expect(r.success).toBe(false);
    expect(r.text).toBe("The push was refused: this database's dump could not be read (pg_restore lists entry 230 in the manager's schema smdb_manager but not in the dump's full table of contents). Nothing was sent; the other machine is unchanged.");
    expect(steps).toEqual(['probe']);
    expect(fs.existsSync(LIST())).toBe(false);
  });

  it('an smdb_manager entry whose name holds U+2028 is left out of the list the push sends', async () => {
    const line = '220; 1259 16400 TABLE smdb_manager a\u2028b dbm_meta';
    const kept = '216; 1259 16386 TABLE smdb_data guild_ownership app';
    tmp.toc = `${kept}\n${line}\n`;
    tmp.managerToc = `${line}\n`;
    const sent = { text: null as string | null };
    const run = fake.run!;
    fake.run = (args, env, input) => {
      if (args.includes('a-fleet-move-push')) sent.text = fs.readFileSync(LIST(), 'utf-8');
      return run(args, env, input);
    };
    expect((await push('a', CODE)).success).toBe(true);
    expect(sent.text!.split('\n')).toContain(kept);
    expect(sent.text!.split('\n')).not.toContain(line);
  });
});
