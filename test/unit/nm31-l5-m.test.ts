import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type PsqlCall = { login: string; db: string; input: string; args: string[] };
type PsqlAnswer = { code: number; stdout?: string; stderr?: string };

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm31-l5-m-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return {
    dir,
    volumes: {} as Record<string, 'exists' | 'absent' | 'unknown'>,
    psql: null as null | ((c: PsqlCall) => PsqlAnswer | Promise<PsqlAnswer>),
    psqlCalls: [] as PsqlCall[],
    execCalls: [] as string[],
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

import * as fs from 'fs';
import * as path from 'path';
import * as containerManager from '../../src/docker/containerManager';
import * as envManager from '../../src/env/manager';
import * as dbLogin from '../../src/instance/dbLogin';
import * as fleetBackup from '../../src/instance/fleetBackup';
import * as fleetReplica from '../../src/instance/fleetReplica';
import * as maintenance from '../../src/instance/maintenance';
import { claimFleetBackupBusy, releaseFleetBackupBusy } from '../../src/instance/fleetBackupGuards';
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

const expectRefused = (answer: unknown, status: number, error: string | RegExp) => {
  expect(answer).toMatchObject({ success: false, status });
  if (typeof error === 'string') expect((answer as { error: string }).error).toBe(error);
  else expect((answer as { error: string }).error).toMatch(error);
};

const OTHER = (host: string) => `The Database URL names ${host}, not this bot's managed database ${CONTAINER}; set the URL to the container name ${CONTAINER} in the Env editor first; nothing was changed`;

/** Admits a press, then changes the stored URL before the next press resumes the record. */
async function admittedThenUrl(url: string): Promise<void> {
  await seedMain();
  expect((await admitNewStart('a')).ok).toBe(true);
  releaseFleetBackupBusy('a');
  envManager.setEnvVars('a', { DATA_BACKEND_URL: url });
}

describe('nm31 l5 m: admission texts and checks', () => {
  it('A7: an Off order still in flight (no lastError) names the order as not finished', async () => {
    await seedMain();
    patch('a', { maintenance: { ...stored().maintenance, settled: false, lastError: undefined } });
    const { answer, before } = await press();
    expectRefused(answer, 409, "The bot's change to Off is not confirmed yet (the order has not finished), so its database may still be in use; nothing was changed");
    unchanged(before);
  });

  it('A15: a sharer the manager holds busy counts as running even with no live container', async () => {
    await seedMain();
    seedBot({ sourceUrl: SMDB }, 'b');
    vi.spyOn(fleetBackup, 'runningDatabaseSharers').mockImplementation(async () => ({ bots: [containerManager.getBot('a')!, containerManager.getBot('b')!], unchecked: [] }));
    vi.spyOn(containerManager, 'liveContainerNames').mockImplementation(async () => []);
    const realBusy = containerManager.isBotBusy;
    vi.spyOn(containerManager, 'isBotBusy').mockImplementation((id: string) => (id === 'b' ? 'update' as any : realBusy(id)));
    const { answer, before } = await press();
    expectRefused(answer, 409, 'Bot b uses this database and runs; choose Off for it first; nothing was changed');
    unchanged(before);
  });

  it('A20: docker silent about the database container names it in T-A-GEN-UNKNOWN', async () => {
    await seedMain();
    vi.spyOn(dbLogin, 'sidecarRunning').mockResolvedValue(null);
    const { answer, before } = await press();
    expectRefused(answer, 409, `The manager can't confirm the database's main generation (docker did not say whether the database container ${CONTAINER} runs), and a new database below it would leave the bot stopped as replaced; nothing was changed`);
    unchanged(before);
  });

  it('A14: a password that does not decode counts as no password', async () => {
    await seedMain();
    envManager.setEnvVars('a', { DATA_BACKEND_URL: `postgresql://smdb:%zz@${CONTAINER}:5432/smdb` });
    const { answer, before } = await press();
    expectRefused(answer, 409, "The Database URL holds no password for the bot's login, so the new database could not take the same login; nothing was changed");
    unchanged(before);
  });
});

describe('nm31 l5 m: the URL re-check before N1', () => {
  it('a URL with no address names an empty host in T-A-URLOTHER', async () => {
    await admittedThenUrl('not a url');
    const { answer } = await press();
    expectRefused(answer, 409, OTHER(''));
  });

  it('a URL naming another host than the public address refuses T-A-URLOTHER', async () => {
    await seedMain();
    patch('a', { fleetDb: { ...stored().fleetDb, replication: { role: 'smdb_join', password: '', hostPort: 15432, publicHost: 'pub.example', certHost: 'pub.example' } } });
    expect((await admitNewStart('a')).ok).toBe(true);
    releaseFleetBackupBusy('a');
    envManager.setEnvVars('a', { DATA_BACKEND_URL: 'postgresql://smdb:pw@db.example:5432/smdb' });
    const { answer } = await press();
    expectRefused(answer, 409, OTHER('db.example'));
  });

  it('a record that cannot be closed drops the refusal\'s ending before its own', async () => {
    await admittedThenUrl('postgresql://smdb:pw@db.example:5432/smdb');
    vi.spyOn(containerManager, 'closeKeptOp').mockImplementation(() => { throw new Error('EIO: i/o error'); });
    const { answer } = await press();
    expect(answer).toMatchObject({ success: false, status: 500 });
    expect((answer as { error: string }).error).toContain(`in the Env editor first; the record could not be closed (EIO: i/o error)`);
  });
});
