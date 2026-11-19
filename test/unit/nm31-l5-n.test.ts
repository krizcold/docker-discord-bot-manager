import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type PsqlCall = { login: string; db: string; input: string; args: string[] };
type PsqlAnswer = { code: number; stdout?: string; stderr?: string };

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm31-l5-n-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return {
    dir,
    volumes: {} as Record<string, 'exists' | 'absent' | 'unknown'>,
    psql: null as null | ((c: PsqlCall) => PsqlAnswer | Promise<PsqlAnswer>),
    psqlCalls: [] as PsqlCall[],
    execCalls: [] as string[],
    lstatFail: null as null | string,
  };
});

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const fake = await import('./nm2-docker');
  const base = await fake.childProcessMock(real) as { spawn: (...a: unknown[]) => unknown; execFile: unknown };
  const { EventEmitter } = await import('events');
  const { PassThrough } = await import('stream');
  const spawn = (cmd: string, args: string[], opts?: unknown) => {
    if (cmd !== 'docker' || !args.includes('psql')) return base.spawn(cmd, args, opts);
    fake.docker.calls.push(args);
    const child: any = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => true;
    let input = '';
    child.stdin.on('data', (d: Buffer) => { input += String(d); });
    child.stdin.on('finish', async () => {
      const u = args.indexOf('-U');
      const d = args.indexOf('-d');
      const call = { login: args[u + 1], db: args[d + 1], input, args };
      h.psqlCalls.push(call);
      const a = h.psql ? await h.psql(call) : { code: 1, stderr: 'no psql answer set' };
      child.stdout.end(a.stdout ?? '');
      child.stderr.end(a.stderr ?? '');
      setTimeout(() => child.emit('close', a.code), 1);
    });
    return child;
  };
  // The safety net: nothing in these rows may reach the real docker CLI through exec.
  const exec = (command: string, _opts: unknown, cb?: (err: Error | null, out: string, errOut: string) => void) => {
    h.execCalls.push(command);
    const done = typeof _opts === 'function' ? _opts as typeof cb : cb;
    setTimeout(() => done?.(Object.assign(new Error('docker is not reachable in this row'), { stderr: '' }), '', ''), 1);
    return new EventEmitter();
  };
  return { ...real, execFile: base.execFile, spawn, exec, default: { ...real, execFile: base.execFile, spawn, exec } };
});
vi.mock('../../src/docker/dockerClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/docker/dockerClient')>()),
  volumeState: (name: string) => h.volumes[name] ?? 'absent',
  listBotContainersAsync: async () => [],
}));
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));
vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>();
  const lstatSync = ((p: import('fs').PathLike, o?: any) => {
    if (h.lstatFail !== null && String(p) === h.lstatFail) throw Object.assign(new Error(`EACCES: permission denied, lstat '${h.lstatFail}'`), { code: 'EACCES' });
    return real.lstatSync(p, o);
  }) as typeof real.lstatSync;
  return { ...real, lstatSync, default: { ...real, lstatSync } };
});

import * as fs from 'fs';
import * as path from 'path';
import * as containerManager from '../../src/docker/containerManager';
import * as envManager from '../../src/env/manager';
import * as dbLogin from '../../src/instance/dbLogin';
import * as fleetBackup from '../../src/instance/fleetBackup';
import * as fleetReplica from '../../src/instance/fleetReplica';
import * as maintenance from '../../src/instance/maintenance';
import { claimFleetBackupBusy, isFleetBackupBusy, releaseFleetBackupBusy } from '../../src/instance/fleetBackupGuards';
import { APP_CAPABILITIES } from '../../src/config/appCapabilities';
import * as keptData from '../../src/instance/keptData';
import { admitNewStart, startOnNewDatabase, KEPT_TEXT, newStartNames } from '../../src/instance/keptData';
import { docker, resetDocker } from './nm2-docker';
import { seedBot, stored, registryPath, clearRegistry } from './nm2-harness';
import type { KeptOpRecord } from '../../src/types';

const SMDB = 'https://github.com/x/fully-modular-discord-bot';
const CONTAINER = 'bota-fleet-postgres';
const R8 = "The env store for this instance cannot be read, so the manager can't tell which database the bot uses; nothing was changed";
const R11 = 'Docker did not say whether the bot is running, so nothing was changed; retry in a moment';
const SLOT = 'A backup or restore operation is in progress on this database - wait for it to finish';
const NOW = Date.parse('2026-11-17T12:00:00.000Z');

const app: Record<string, boolean | null> = {};
const dataDirOf = (id: string) => path.join(h.dir, 'bots', id, 'data');

const gen = { meta: { code: 0, stdout: '0||\n' } as PsqlAnswer, restore: { code: 0, stdout: '\n' } as PsqlAnswer, rolsuper: { code: 0, stdout: 'true\n' } as PsqlAnswer, admin: { code: 0, stdout: '-\n' } as PsqlAnswer };
const META_MISSING = 'psql: error: connection to server on socket "/var/run/postgresql/.s.PGSQL.5432" failed: FATAL:  role "dbm_meta" does not exist\n';

function psqlAnswer(c: PsqlCall): PsqlAnswer {
  if (c.login === 'dbm_meta') return gen.meta;
  if (c.login === 'dbm_admin' && c.db === 'postgres') return c.input.includes('restore_state') ? gen.restore : c.input.includes('rolsuper') ? gen.rolsuper : { code: 1, stderr: 'ERROR: unexpected cluster read' };
  if (c.login === 'dbm_admin') return gen.admin;
  return { code: 1, stderr: 'ERROR: unexpected login' };
}

function makeDataDir(id: string): void {
  const d = dataDirOf(id);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, '.env'), 'DISCORD_TOKEN=x\n');
  fs.writeFileSync(path.join(d, 'state.json'), '{}');
}

/** The Off order as the maintenance tool runs it with the app stopped, its database calls answered at dbLogin. */
async function offOrder(id: string, opts: { blockFails?: string } = {}): Promise<void> {
  const spies = [
    vi.spyOn(dbLogin, 'ensureManagerDbRole').mockResolvedValue({ ok: true }),
    vi.spyOn(dbLogin, 'blockBotLogin').mockResolvedValue(opts.blockFails ? { ok: false, cls: 'other', error: opts.blockFails } : { ok: true } as any),
    vi.spyOn(dbLogin, 'endBotSessions').mockResolvedValue({ ok: true }),
    vi.spyOn(dbLogin, 'readBotLogin').mockResolvedValue({ ok: true, login: { inRecovery: false, canLogin: false, sessions: 0 } }),
  ];
  try {
    const r = await maintenance.runMaintenanceOrder(id, 'off', 'Moving to a new database');
    expect(r.settled).toBe(!opts.blockFails);
  } finally {
    spies.forEach(s => s.mockRestore());
  }
}

/** A main as ensureFleetDataBackend stamps it, its data folder, and Off settled. */
async function seedMain(id = 'a', opts: { off?: boolean } = {}): Promise<void> {
  seedBot({ sourceUrl: SMDB }, id);
  envManager.setEnvVars(id, { DATA_BACKEND: 'postgres' });
  expect(containerManager.ensureFleetDataBackend(containerManager.getBot(id)!)).not.toBeNull();
  makeDataDir(id);
  if (opts.off !== false) await offOrder(id);
}

/** A bot on a database this manager does not run: the folder variant. */
async function seedExternal(id = 'a'): Promise<void> {
  seedBot({ sourceUrl: SMDB }, id);
  envManager.setEnvVars(id, { DATA_BACKEND: 'postgres', DATA_BACKEND_URL: 'postgresql://smdb:pw@db.example:5432/smdb' });
  makeDataDir(id);
  await offOrder(id);
}

function patch(id: string, fields: Record<string, unknown>): void {
  const reg = JSON.parse(fs.readFileSync(registryPath(), 'utf-8'));
  Object.assign(reg.instances[id], fields);
  fs.writeFileSync(registryPath(), JSON.stringify(reg, null, 2));
}

function tree(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true }).map(String).sort();
}

type Snap = { registry: string; folders: string[] };
const snap = (): Snap => ({ registry: fs.readFileSync(registryPath(), 'utf-8'), folders: tree(path.join(h.dir, 'bots')) });

const READS = (a: string[]) => a[0] === 'inspect' || a[0] === 'ps' || (a[0] === 'volume' && a[1] === 'inspect') || (a[0] === 'exec' && a.includes('psql'));
const WRITE_SQL = /\b(ALTER|CREATE|DROP|UPDATE|INSERT|DELETE|GRANT|REVOKE|TRUNCATE)\b/i;

/** Nothing changed: no state-changing docker call, no writing SQL, the registry and the folders as before. */
function unchanged(before: Snap): void {
  expect(docker.calls.filter(a => !READS(a))).toEqual([]);
  expect(h.psqlCalls.filter(c => WRITE_SQL.test(c.input.replace(/\bpg_catalog\.\w+/g, '')))).toEqual([]);
  expect(h.execCalls).toEqual([]);
  expect(fs.readFileSync(registryPath(), 'utf-8')).toBe(before.registry);
  expect(tree(path.join(h.dir, 'bots'))).toEqual(before.folders);
}

/** Presses Start on a new database after the setup, from a clean call log. */
async function press(id = 'a') {
  docker.calls.length = 0;
  h.psqlCalls.length = 0;
  const before = snap();
  const answer = await startOnNewDatabase(id);
  return { answer, before };
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  resetDocker();
  docker.overrides.push({ match: a => a.join(' ').includes('SHOW ssl'), answer: { ok: true, stdout: 'off\n' } });
  clearRegistry();
  fs.rmSync(path.join(h.dir, 'bots'), { recursive: true, force: true });
  for (const k of Object.keys(h.volumes)) delete h.volumes[k];
  for (const k of Object.keys(app)) delete app[k];
  h.execCalls.length = 0;
  h.lstatFail = null;
  h.psqlCalls.length = 0;
  h.psql = psqlAnswer;
  Object.assign(gen, { meta: { code: 0, stdout: '0||\n' }, restore: { code: 0, stdout: '\n' }, rolsuper: { code: 0, stdout: 'true\n' }, admin: { code: 0, stdout: '-\n' } });
  vi.spyOn(containerManager, 'appContainerRunning').mockImplementation(async (id: string) => (id in app ? app[id] : false));
  vi.spyOn(containerManager, 'runningAppContainer').mockImplementation(async () => 'f00dcafe1234');
  vi.spyOn(fleetReplica, 'instanceDataDir').mockImplementation(async (inst) => dataDirOf(inst.id));
});
afterEach(() => {
  releaseFleetBackupBusy('a');
  vi.restoreAllMocks();
});
afterAll(() => { fs.rmSync(h.dir, { recursive: true, force: true }); });

const NOTHING = '; nothing was changed';

const expectRefused = (answer: unknown, status: number, error: string | RegExp) => {
  expect(answer).toMatchObject({ success: false, status });
  if (typeof error === 'string') expect((answer as { error: string }).error).toBe(error);
  else expect((answer as { error: string }).error).toMatch(error);
};
const folderText = (dir: string, why: string) => `The bot's data folder ${dir} could not be read (${why})${NOTHING}`;
const switchText = (w: string) => `The database is in a ${w} that has not finished, or another database has replaced it or claims the same generation; settle that in the Move section first${NOTHING}`;
const refused = (status: number, error: string) => ({ ok: false, answer: { success: false, status, error } });
const FENCE = "The bot's database stayed READ-ONLY after the restore";

/** A main whose stored URL names another host: admission takes the folder variant (C13). */
async function seedFolderOnMain(id = 'a'): Promise<void> {
  await seedMain(id);
  envManager.setEnvVars(id, { DATA_BACKEND_URL: 'postgresql://smdb:pw@db.example:5432/smdb' });
  expect(keptData.newStartVariantOf(containerManager.getBot(id)!)).toBe('folder');
}

describe('nm31 l5 n: admitFresh', () => {
  it('a folder variant on a main with an unfinished receive is admitted: only a take-over of a copy counts there', async () => {
    await seedFolderOnMain();
    patch('a', { fleetDb: { ...stored().fleetDb, receive: { startedAt: 'x', expiresAt: 'y', safetyDump: 'pre-receive.dump', pushId: 'p1', dbOid: '16384' } } });
    const a = await admitNewStart('a');
    expect(a).toMatchObject({ ok: true, slot: false });
    expect(stored().keptOp).toMatchObject({ op: 'new-start', parts: ['folder'] });
  });

  it('a copy variant with a take-over open refuses with the take-over word', async () => {
    await seedExternal();
    patch('a', { fleetDbReplica: { containerName: 'bota-fleet-postgres-replica', volume: 'bota-fleet-postgres-replica-data', user: 'smdb', db: 'smdb', slot: 's1', primaryHost: 'main.example', primaryPort: 5432, takeover: { startedAt: '2026-11-17T08:00:00.000Z', planned: true, generation: 2 } } });
    const { answer, before } = await press();
    expectRefused(answer, 409, switchText('take-over'));
    unchanged(before);
  });

  it('a folder variant on a main skips the fence check that only the main variant runs', async () => {
    await seedFolderOnMain();
    vi.spyOn(fleetBackup, 'getFleetFenceStuck').mockReturnValue(FENCE);
    expect(await admitNewStart('a')).toMatchObject({ ok: true, slot: false });
  });

  it('a data folder whose name is not data refuses', async () => {
    await seedExternal();
    const other = path.join(h.dir, 'bots', 'a', 'other');
    fs.mkdirSync(other, { recursive: true });
    vi.spyOn(fleetReplica, 'instanceDataDir').mockResolvedValue(other);
    const { answer, before } = await press();
    expectRefused(answer, 409, folderText(other, 'its name is not data'));
    unchanged(before);
  });

  it('a data path that is a file refuses', async () => {
    await seedExternal();
    const file = path.join(h.dir, 'bots', 'a', 'x', 'data');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'not a folder');
    vi.spyOn(fleetReplica, 'instanceDataDir').mockResolvedValue(file);
    const { answer, before } = await press();
    expectRefused(answer, 409, folderText(file, 'it is not a folder'));
    unchanged(before);
  });

  it('a kept name that cannot be looked at (not ENOENT) refuses with the error', async () => {
    await seedExternal();
    const names = newStartNames({ sanitizedName: 'bota' }, dataDirOf('a'), NOW);
    h.lstatFail = names.outDir;
    const a = await admitNewStart('a');
    expect(a.ok).toBe(false);
    const err = (a as { answer: { error: string } }).answer.error;
    expect(err.startsWith(`The bot's data folder ${names.outDir} could not be read (`)).toBe(true);
    expect(err).toContain('EACCES');
    expect(err.endsWith(NOTHING)).toBe(true);
    expect(stored().keptOp).toBeUndefined();
  });

  it('a main records the other bots on its database as sharers', async () => {
    await seedMain();
    seedBot({ sourceUrl: SMDB }, 'b');
    vi.spyOn(fleetBackup, 'databaseSharers').mockImplementation(() => [containerManager.getBot('a')!, containerManager.getBot('b')!]);
    vi.spyOn(fleetBackup, 'runningDatabaseSharers').mockImplementation(async () => ({ bots: [containerManager.getBot('a')!], unchecked: [] }));
    expect(await admitNewStart('a')).toMatchObject({ ok: true, slot: true });
    expect(stored().keptOp).toMatchObject({ parts: ['db', 'folder'], sharers: ['b'] });
  });

  it('a folder variant records no sharers and only the folder part, with no new volume', async () => {
    await seedFolderOnMain();
    seedBot({ sourceUrl: SMDB }, 'b');
    vi.spyOn(fleetBackup, 'databaseSharers').mockImplementation(() => [containerManager.getBot('a')!, containerManager.getBot('b')!]);
    expect(await admitNewStart('a')).toMatchObject({ ok: true, slot: false, resumed: false });
    const rec = stored().keptOp;
    expect(rec).toMatchObject({ parts: ['folder'], sharers: [] });
    expect(rec).not.toHaveProperty('newVolume');
  });

  it('a fresh record logs its variant and set', async () => {
    await seedMain();
    const log = vi.spyOn(console, 'log');
    expect((await admitNewStart('a')).ok).toBe(true);
    const names = newStartNames({ sanitizedName: 'bota' }, dataDirOf('a'), NOW);
    expect(log.mock.calls.map(c => c[0])).toContain(`[KeptData] Bot a: Start on a new database recorded (main, set ${names.stamp})`);
  });
});

describe('nm31 l5 n: admitNewStart and admitClaimed', () => {
  it('an unknown bot refuses with Bot not found', async () => {
    expect(await admitNewStart('zz')).toEqual(refused(404, 'Bot not found'));
  });

  it('the manager shutting down refuses before anything else', async () => {
    await seedFolderOnMain();
    vi.spyOn(containerManager, 'isShuttingDown').mockReturnValue(true);
    expect(await admitNewStart('a')).toEqual(refused(503, containerManager.SHUTDOWN_REFUSAL));
    expect(stored().keptOp).toBeUndefined();
  });

  it('a folder variant refuses while the backup slot is taken', async () => {
    await seedFolderOnMain();
    expect(claimFleetBackupBusy('a')).toBe(true);
    expect(await admitNewStart('a')).toEqual(refused(409, SLOT));
    expect(stored().keptOp).toBeUndefined();
  });

  it('a main admission holds the backup slot', async () => {
    await seedMain();
    expect(await admitNewStart('a')).toMatchObject({ ok: true, slot: true });
    expect(isFleetBackupBusy('a')).toBe(true);
  });

  it('a folder admission does not hold the backup slot', async () => {
    await seedFolderOnMain();
    expect(await admitNewStart('a')).toMatchObject({ ok: true, slot: false });
    expect(isFleetBackupBusy('a')).toBe(false);
  });

  it('a main admission that throws releases its slot', async () => {
    await seedMain();
    vi.spyOn(maintenance, 'maintenanceOf').mockImplementation(() => { throw new Error('boom'); });
    await expect(admitNewStart('a')).rejects.toThrow('boom');
    expect(isFleetBackupBusy('a')).toBe(false);
  });

  it('a folder admission that throws leaves a slot another operation took', async () => {
    await seedFolderOnMain();
    const took: boolean[] = [];
    vi.spyOn(maintenance, 'maintenanceOf').mockImplementation(() => { took.push(claimFleetBackupBusy('a')); throw new Error('boom'); });
    await expect(admitNewStart('a')).rejects.toThrow('boom');
    expect(took).toEqual([true]);
    expect(isFleetBackupBusy('a')).toBe(true);
  });

  it('a main admission refused releases its slot', async () => {
    await seedMain();
    vi.spyOn(fleetBackup, 'getFleetFenceStuck').mockReturnValue(FENCE);
    expect(await admitNewStart('a')).toEqual(refused(409, `${FENCE}; lift it first${NOTHING}`));
    expect(isFleetBackupBusy('a')).toBe(false);
  });

  it('a folder admission refused leaves a slot another operation took', async () => {
    await seedFolderOnMain();
    const took: boolean[] = [];
    vi.spyOn(fleetReplica, 'instanceDataDir').mockImplementation(async () => { took.push(claimFleetBackupBusy('a')); throw new Error('EIO: i/o error'); });
    const a = await admitNewStart('a');
    expect(took).toEqual([true]);
    expect(a.ok).toBe(false);
    expect(isFleetBackupBusy('a')).toBe(true);
  });

  it('a resume logs the step it goes on from', async () => {
    await seedMain();
    expect((await admitNewStart('a')).ok).toBe(true);
    releaseFleetBackupBusy('a');
    containerManager.saveKeptOpIf('a', stored().keptOp, { step: 'swapped' });
    const log = vi.spyOn(console, 'log');
    expect(await admitNewStart('a')).toMatchObject({ ok: true, resumed: true });
    expect(log.mock.calls.map(c => c[0])).toContain('[KeptData] Bot a: Start on a new database goes on from step swapped');
  });
});
