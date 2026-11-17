import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type PsqlCall = { login: string; db: string; input: string; args: string[] };
type PsqlAnswer = { code: number; stdout?: string; stderr?: string };

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm31-admit-'));
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

describe('nm31 admit: refusals change nothing', () => {
  it('A1 (1 of 3): the manager shutting down refuses', async () => {
    await seedMain();
    vi.spyOn(containerManager, 'isShuttingDown').mockReturnValue(true);
    const { answer, before } = await press();
    expectRefused(answer, 503, containerManager.SHUTDOWN_REFUSAL);
    unchanged(before);
  });

  it('A1 (2 of 3): another operation holding the bot refuses with its name', async () => {
    await seedMain();
    let release!: () => void;
    const holding = containerManager.withExternalBotOp('a', 'build', () => new Promise<void>(r => { release = r; }));
    try {
      const { answer, before } = await press();
      expectRefused(answer, 409, "Operation 'build' already in progress");
      unchanged(before);
    } finally {
      release();
      await holding;
    }
  });

  it('A1 (3 of 3): the backup slot taken refuses with the decommission slot text', async () => {
    await seedMain();
    expect(claimFleetBackupBusy('a')).toBe(true);
    const { answer, before } = await press();
    expectRefused(answer, 409, SLOT);
    unchanged(before);
  });

  it('A3: an env store that cannot be read refuses R8', async () => {
    await seedMain();
    vi.spyOn(envManager, 'getEnvVarsWithStatus').mockReturnValue({ vars: {}, undecryptable: [], encrypted: [], corrupt: true });
    const { answer, before } = await press();
    expectRefused(answer, 409, R8);
    unchanged(before);
  });

  it('A4 (1 of 2): a bot that keeps its data in files refuses T-A-JSON', async () => {
    seedBot({ sourceUrl: SMDB }, 'a');
    envManager.setEnvVars('a', { DATA_BACKEND: 'file' });
    makeDataDir('a');
    await offOrder('a');
    const { answer, before } = await press();
    expectRefused(answer, 409, KEPT_TEXT.aJson);
    unchanged(before);
  });

  it('A4 (2 of 2): an app that declares no state file refuses T-A-NOFILE', async () => {
    const smdb = APP_CAPABILITIES[0];
    APP_CAPABILITIES.unshift({ match: { urlContains: 'nofile-app' }, companionDb: smdb.companionDb, hooks: { ...smdb.hooks!, stateFile: undefined } });
    try {
      seedBot({ sourceUrl: 'https://github.com/x/nofile-app' }, 'a');
      envManager.setEnvVars('a', { DATA_BACKEND: 'postgres', DATA_BACKEND_URL: 'postgresql://smdb:pw@db.example:5432/smdb' });
      makeDataDir('a');
      await offOrder('a');
      const { answer, before } = await press();
      expectRefused(answer, 409, 'This app does not declare the file its maintenance state is saved in, so the manager cannot make its next start a maintenance boot; nothing was changed');
      unchanged(before);
    } finally {
      APP_CAPABILITIES.shift();
    }
  });

  it('A5: another open record refuses with its name', async () => {
    await seedMain();
    const del: KeptOpRecord = { op: 'delete', set: 'older', stamp: '2026-11-17T11-00-00-000Z', startedAt: '2026-11-17T11:00:00.000Z', parts: ['folder'], dataDir: dataDirOf('a'), outDir: '', inDir: '', offMessage: '', sharers: [], step: 'recorded' };
    expect(containerManager.createKeptOpIf('a', del)).toBeNull();
    const { answer, before } = await press();
    expectRefused(answer, 409, 'Delete did not finish on this bot; finish it in the Database window first; nothing was changed');
    unchanged(before);
  });

  it('A6: State Running refuses T-A-OFF', async () => {
    await seedMain('a', { off: false });
    const { answer, before } = await press();
    expectRefused(answer, 409, 'Start on a new database needs the bot Off: choose Off in its State window first; nothing was changed');
    unchanged(before);
  });

  it('A7: an Off that did not settle refuses T-A-UNSETTLED with its lastError', async () => {
    await seedMain('a', { off: false });
    await offOrder('a', { blockFails: 'the server closed the connection' });
    const last = stored().maintenance.lastError as string;
    expect(last).toContain('the server closed the connection');
    const { answer, before } = await press();
    expectRefused(answer, 409, `The bot's change to Off is not confirmed yet (${last}), so its database may still be in use; nothing was changed`);
    unchanged(before);
  });

  it('A8 (1 of 2): docker silent about the app refuses R11', async () => {
    await seedMain();
    app.a = null;
    const { answer, before } = await press();
    expectRefused(answer, 409, R11);
    unchanged(before);
  });

  it('A8 (2 of 2): the app running under Off refuses T-A-RUNS', async () => {
    await seedMain();
    app.a = true;
    const { answer, before } = await press();
    expectRefused(answer, 409, "The bot's container runs although its State is Off; choose Off again to stop it; nothing was changed");
    unchanged(before);
  });

  const a9: Array<[string, () => void, string | RegExp]> = [
    ['A9 (1 of 5): a lane cut short refuses T-A-LANE', () => patch('a', { lane: { op: 'update', wasRunning: false, startedAt: '2026-11-17T09:00:00.000Z', interrupted: true } }),
      'An update of this instance was cut short; run it again first; nothing was changed'],
    ['A9 (2 of 5): an open migration refuses MIGRATE_GATE.db', () => patch('a', { migrate: { to: 'file', from: 'postgres', destination: 'file', companion: false, jobId: 'mgr-1', jobIds: [], posted: false, started: 0, kept: 0, phase: 'waiting', loginOpened: false, sharers: [], sharersStopped: [], openedAt: '2026-11-17T09:00:00.000Z', text: '' } }),
      "A data migration to JSON files is open on this bot, so its database setup cannot change until it ends; nothing was changed"],
    ['A9 (3 of 5): a live copy seed refuses T-A-SEED', () => patch('a', { fleetDbReplicaSeed: { purpose: 'provision', phase: 'seeding', startedAt: 1 } }),
      'A live copy is being seeded on this instance; wait for it to finish; nothing was changed'],
    ['A9 (4 of 5): another bot\'s migration holding this one refuses with its text', () => {
      seedBot({ sourceUrl: SMDB, migrate: { to: 'file', from: 'postgres', destination: 'file', companion: false, jobId: 'mgr-2', jobIds: [], posted: false, started: 0, kept: 0, phase: 'waiting', loginOpened: false, sharers: ['a'], sharersStopped: [], openedAt: '2026-11-17T09:00:00.000Z', text: '' } }, 'b');
    }, "Bot b's data migration to JSON files is open on the database this bot uses, so this bot's database setup cannot change until that migration ends; nothing was changed"],
    ['A9 (5 of 5): a Delete lane that did not finish refuses with its text', () => patch('a', { lane: { op: 'delete', wasRunning: false, keepData: true, startedAt: '2026-11-17T09:00:00.000Z' } }),
      'A Delete of this instance (keeping its data) did not finish, so its containers, image or compose may already be gone; Start on a new database is refused until Delete is run again'],
  ];
  it.each(a9)('%s', async (_n, arrange, error) => {
    await seedMain();
    arrange();
    const { answer, before } = await press();
    expectRefused(answer, 409, error);
    unchanged(before);
  });

  const switchText = (w: string) => `The database is in a ${w} that has not finished, or another database has replaced it or claims the same generation; settle that in the Move section first; nothing was changed`;
  const fleetDbWith = (extra: Record<string, unknown>) => () => patch('a', { fleetDb: { ...stored().fleetDb, ...extra } });
  const a10: Array<[string, () => void, string | RegExp]> = [
    ['A10 (1 of 7): a retire that did not finish', fleetDbWith({ retiringAt: '2026-11-17T08:00:00.000Z' }), /being removed \(since 2026-11-17T08:00:00.000Z\) and the removal did not finish/],
    ['A10 (2 of 7): a hand-over', fleetDbWith({ handover: { mode: 'stream', phase: 'waiting', at: '2026-11-17T08:00:00.000Z', machine: 'm2' } }), switchText('hand-over')],
    ['A10 (3 of 7): a receive', fleetDbWith({ receive: { startedAt: 'x', expiresAt: 'y', safetyDump: 'pre-receive.dump', pushId: 'p1', dbOid: '16384' } }), switchText('receive')],
    ['A10 (4 of 7): a push that did not finish', fleetDbWith({ pushBroken: { at: '2026-11-17T08:00:00.000Z', safetyDump: 'pre-push.dump' } }), switchText('push')],
    ['A10 (5 of 7): a take-over', () => patch('a', { fleetDbReplica: { containerName: 'bota-fleet-postgres-replica', volume: 'bota-fleet-postgres-replica-data', user: 'smdb', db: 'smdb', slot: 's1', primaryHost: 'main.example', primaryPort: 5432, takeover: { startedAt: '2026-11-17T08:00:00.000Z', planned: true, generation: 2 } } }), switchText('take-over')],
    ['A10 (6 of 7): replaced by another database', fleetDbWith({ replacedBy: { machine: 'm2', host: 'h2', port: 5432, generation: 3, own: 2, since: null } }), switchText('take-over')],
    ['A10 (7 of 7): a main conflict', fleetDbWith({ mainConflict: { machine: 'm2', host: 'h2', port: 5432, generation: 2, at: '2026-11-17T08:00:00.000Z' } }), switchText('take-over')],
  ];
  it.each(a10)('%s', async (_n, arrange, error) => {
    await seedMain();
    arrange();
    const { answer, before } = await press();
    expectRefused(answer, 409, error);
    unchanged(before);
  });

  it('A11: the main and a live copy together refuse T-A-BOTH', async () => {
    await seedMain();
    patch('a', { fleetDbReplica: { containerName: 'bota-fleet-postgres-replica', volume: 'bota-fleet-postgres-replica-data', user: 'smdb', db: 'smdb', slot: 's1', primaryHost: 'main.example', primaryPort: 5432 } });
    const { answer, before } = await press();
    expectRefused(answer, 409, 'This instance runs the main database and also holds a live copy; remove or adopt the copy first; nothing was changed');
    unchanged(before);
  });

  it('A12: a write fence that could not be lifted refuses T-A-FENCE', async () => {
    await seedMain();
    vi.spyOn(fleetBackup, 'getFleetFenceStuck').mockReturnValue("The bot's database stayed READ-ONLY after the restore");
    const { answer, before } = await press();
    expectRefused(answer, 409, "The bot's database stayed READ-ONLY after the restore; lift it first; nothing was changed");
    unchanged(before);
  });

  it('A13: an empty stored Database URL refuses T-A-URLEMPTY', async () => {
    await seedMain();
    envManager.setEnvVars('a', { DATA_BACKEND_URL: '' });
    const { answer, before } = await press();
    expectRefused(answer, 409, 'The manager holds no Database URL for this bot (the bot may read one from its own .env); set it in the Env editor first; nothing was changed');
    unchanged(before);
  });

  it('A13b: a URL through the public address refuses T-A-URLHOST', async () => {
    await seedMain();
    patch('a', { fleetDb: { ...stored().fleetDb, replication: { role: 'smdb_join', password: '', hostPort: 15432, publicHost: 'pub.example', certHost: 'pub.example' } } });
    envManager.setEnvVars('a', { DATA_BACKEND_URL: 'postgresql://smdb:pw@pub.example:15432/smdb' });
    const { answer, before } = await press();
    expectRefused(answer, 409, `The Database URL reaches this database through its public address pub.example, and the new database has no public address until replication is enabled on it; set the URL to the container name ${CONTAINER} first; nothing was changed`);
    unchanged(before);
  });

  it('A14: a URL without a password refuses T-A-NOPASS', async () => {
    await seedMain();
    envManager.setEnvVars('a', { DATA_BACKEND_URL: `postgresql://smdb@${CONTAINER}:5432/smdb` });
    const { answer, before } = await press();
    expectRefused(answer, 409, "The Database URL holds no password for the bot's login, so the new database could not take the same login; nothing was changed");
    unchanged(before);
  });

  it('A15 (1 of 3): another bot on this database that runs refuses T-A-SHARERS', async () => {
    await seedMain();
    seedBot({ sourceUrl: SMDB }, 'b');
    vi.spyOn(fleetBackup, 'runningDatabaseSharers').mockImplementation(async () => ({ bots: [containerManager.getBot('a')!, containerManager.getBot('b')!], unchecked: [] }));
    vi.spyOn(containerManager, 'liveContainerNames').mockImplementation(async (id: string) => (id === 'b' ? ['botb-app-1'] : []));
    const { answer, before } = await press();
    expectRefused(answer, 409, 'Bot b uses this database and runs; choose Off for it first; nothing was changed'); // C9 leftover (code review 3)
    unchanged(before);
  });

  it('A15 (2 of 3): a bot docker did not answer for refuses T-A-SHARERS-UNKNOWN', async () => {
    await seedMain();
    seedBot({ sourceUrl: SMDB }, 'b');
    vi.spyOn(fleetBackup, 'runningDatabaseSharers').mockImplementation(async () => ({ bots: [containerManager.getBot('a')!], unchecked: ['b'] }));
    const { answer, before } = await press();
    expectRefused(answer, 409, 'Docker did not say whether Bot b, which uses this database, is running; nothing was changed');
    unchanged(before);
  });

  it('A16: a data folder that cannot be read refuses T-A-FOLDER', async () => {
    await seedMain();
    fs.rmSync(dataDirOf('a'), { recursive: true });
    const { answer, before } = await press();
    expectRefused(answer, 409, new RegExp(`^The bot's data folder ${dataDirOf('a').replace(/[\\.]/g, '\\$&')} could not be read \\(.*ENOENT.*\\); nothing was changed$`));
    unchanged(before);
  });

  it('A17: a folder already at the kept name refuses T-A-NAMES', async () => {
    await seedMain();
    const names = newStartNames({ sanitizedName: 'bota' }, dataDirOf('a'), NOW);
    fs.mkdirSync(names.outDir);
    const { answer, before } = await press();
    expectRefused(answer, 409, `The folder ${names.outDir} already exists, so that name is taken; nothing was changed; try again`);
    unchanged(before);
  });

  it('A18 (1 of 2): a volume already at the new name refuses T-A-NAMES', async () => {
    await seedMain();
    const v = newStartNames({ sanitizedName: 'bota' }, dataDirOf('a'), NOW).newVolume;
    h.volumes[v] = 'exists';
    const { answer, before } = await press();
    expectRefused(answer, 409, `The volume ${v} already exists, so that name is taken; nothing was changed; try again`);
    unchanged(before);
  });

  it('A18 (2 of 2): docker silent about the new volume refuses T-A-DOCKER', async () => {
    await seedMain();
    const v = newStartNames({ sanitizedName: 'bota' }, dataDirOf('a'), NOW).newVolume;
    h.volumes[v] = 'unknown';
    const { answer, before } = await press();
    expectRefused(answer, 409, `Docker did not say whether the volume ${v} exists; nothing was changed; try again`);
    unchanged(before);
  });

  it('A19: a record that cannot be saved refuses T-A-RECORD', async () => {
    await seedMain();
    vi.spyOn(containerManager, 'createKeptOpIf').mockImplementation(() => { throw new Error('ENOSPC: no space left on device'); });
    const { answer, before } = await press();
    expectRefused(answer, 500, 'Start on a new database was not recorded, so nothing was changed: ENOSPC: no space left on device');
    unchanged(before);
  });
});

describe('nm31 admit: A20, the generation read before anything changes', () => {
  const genUnknown = /^The manager can't confirm the database's main generation \(.+\), and a new database below it would leave the bot stopped as replaced; nothing was changed$/;
  const refusedRows: Array<[string, () => void, string | RegExp]> = [
    ['A20 (1 of 10): generation 2 refuses T-A-GEN', () => { gen.meta = { code: 0, stdout: '2|m1|2026-11-01T00:00:00Z\n' }; }, KEPT_TEXT.aGen(2)],
    ['A20 (4 of 10): a restore floor of 2 over a row of 1 refuses', () => {
      gen.meta = { code: 0, stdout: '1|m1|2026-11-01T00:00:00Z\n' };
      gen.restore = { code: 0, stdout: 'false|daily-x.dump|2026-11-02T00:00:00Z|2|m1|2026-11-01T00:00:00Z\n' };
    }, KEPT_TEXT.aGen(2)],
    ['A20 (5 of 10): no dbm_meta and an admin read of generation 2 refuses', () => {
      gen.meta = { code: 2, stderr: META_MISSING };
      gen.admin = { code: 0, stdout: 'r\n2|m1|2026-11-01T00:00:00Z\n' };
    }, KEPT_TEXT.aGen(2)],
    ['A20 (7 of 10): no dbm_meta and a bot role that is not a superuser refuses', () => {
      gen.meta = { code: 2, stderr: META_MISSING };
      gen.rolsuper = { code: 0, stdout: 'false\n' };
    }, genUnknown],
    ['A20 (8 of 10): no dbm_meta and an admin read that fails refuses', () => {
      gen.meta = { code: 2, stderr: META_MISSING };
      gen.admin = { code: 3, stderr: 'psql:<stdin>:4: ERROR:  permission denied for schema smdb_manager\n' };
    }, genUnknown],
    ['A20 (9 of 10): another read failure refuses', () => { gen.meta = { code: 2, stderr: 'psql: error: FATAL:  the database system is starting up\n' }; }, genUnknown],
    ['A20 (10 of 10): the database down refuses T-A-GEN-DOWN', () => { docker.running[CONTAINER] = false; },
      "The bot's database is not running, so its main generation cannot be read; choose Off again, which starts it alone; nothing was changed"],
  ];
  it.each(refusedRows)('%s', async (_n, arrange, error) => {
    await seedMain();
    arrange();
    const { answer, before } = await press();
    expectRefused(answer, 409, error);
    unchanged(before);
    // Once the role check fails, nothing runs as the superuser in the bot's database.
    if (_n.startsWith('A20 (7 of 10)')) expect(h.psqlCalls.filter(c => c.login === 'dbm_admin' && c.db !== 'postgres')).toEqual([]);
  });

  const passRows: Array<[string, () => void]> = [
    ['A20 (2 of 10): generation 1 passes', () => { gen.meta = { code: 0, stdout: '1|m1|2026-11-01T00:00:00Z\n' }; }],
    ['A20 (3 of 10): no generation row passes', () => { gen.meta = { code: 1, stderr: 'ERROR:  relation "smdb_manager.generation" does not exist\n' }; }],
    ['A20 (6 of 10): no dbm_meta and no generation table passes', () => {
      gen.meta = { code: 2, stderr: META_MISSING };
      gen.admin = { code: 0, stdout: '-\n' };
    }],
  ];
  it.each(passRows)('%s', async (_n, arrange) => {
    await seedMain();
    arrange();
    const a = await admitNewStart('a');
    expect(a).toMatchObject({ ok: true, resumed: false, slot: true });
    expect(stored().keptOp).toMatchObject({ op: 'new-start', step: 'recorded', parts: ['db', 'folder'] });
    const admin = h.psqlCalls.filter(c => c.login === 'dbm_admin' && c.db !== 'postgres');
    expect(admin).toHaveLength(_n.startsWith('A20 (6 of 10)') ? 1 : 0);
    expect(h.psqlCalls.filter(c => c.login === 'dbm_meta')).toHaveLength(1);
    for (const c of admin) {
      expect(c.args.join(' ')).toContain('default_transaction_read_only=on');
      expect(c.input).toContain("relkind");
    }
  });
});

describe('nm31 admit: passes, resumes and the record race', () => {
  it('A15 (3 of 3): only the instance itself on the database passes, and the record holds no sharers', async () => {
    await seedMain();
    vi.spyOn(fleetBackup, 'runningDatabaseSharers').mockImplementation(async () => ({ bots: [containerManager.getBot('a')!], unchecked: ['a'] }));
    const a = await admitNewStart('a');
    expect(a).toMatchObject({ ok: true, slot: true });
    const names = newStartNames({ sanitizedName: 'bota' }, dataDirOf('a'), NOW);
    expect(stored().keptOp).toEqual({
      op: 'new-start', set: names.stamp, stamp: names.stamp, startedAt: names.startedAt, parts: ['db', 'folder'],
      dataDir: dataDirOf('a'), outDir: names.outDir, inDir: names.inDir, owner: expect.objectContaining({ uid: expect.any(Number), gid: expect.any(Number), mode: expect.any(Number) }),
      newVolume: names.newVolume, offMessage: 'Moving to a new database', sharers: [], step: 'recorded',
    });
  });

  it('A2 (1 of 2): a press with an open new-start record resumes it after A6 to A8, writing no new record', async () => {
    await seedMain();
    const first = await admitNewStart('a');
    expect(first.ok).toBe(true);
    releaseFleetBackupBusy('a');
    const rec = stored().keptOp;
    containerManager.saveKeptOpIf('a', rec, { step: 'swapped' });
    const before = fs.readFileSync(registryPath(), 'utf-8');
    const again = await admitNewStart('a');
    expect(again).toMatchObject({ ok: true, resumed: true, slot: true, record: { ...rec, step: 'swapped' } });
    expect(fs.readFileSync(registryPath(), 'utf-8')).toBe(before);
  });

  it('A2 (2 of 2): on a resume, the app running answers the open record with T-N-RUNS', async () => {
    await seedMain();
    expect((await admitNewStart('a')).ok).toBe(true);
    releaseFleetBackupBusy('a');
    const rec = stored().keptOp;
    containerManager.saveKeptOpIf('a', rec, { step: 'db-out' });
    app.a = true;
    const { answer, before } = await press();
    expect(answer).toEqual({
      success: false, status: 409, open: true,
      error: 'Start on a new database stopped before it finished: the bot\'s container (or its database or copy container) runs although this has not finished; stop it in a shell with docker stop f00dcafe1234, then run it again. Done so far: the database was stopped, its service was taken out of the compose. Run it again to go on, or Put back to return to the earlier database and data folder; until one of them finishes, the bot stays stopped and Start is refused.',
    });
    unchanged(before);
  });

  it('A19 (race): a record another admission writes during A20\'s reads refuses A5, and that record stays', async () => {
    await seedMain();
    const other: KeptOpRecord = { op: 'put-back', set: 's0', asideSet: 's1', stamp: 's1', startedAt: '2026-11-17T11:59:00.000Z', parts: ['folder'], dataDir: dataDirOf('a'), outDir: 'o', inDir: 'i', offMessage: '', sharers: [], step: 'recorded' };
    const raced: Array<string | null> = [];
    h.psql = (c) => {
      if (c.login === 'dbm_meta') raced.push(containerManager.createKeptOpIf('a', other));
      return psqlAnswer(c);
    };
    const a = await admitNewStart('a');
    expect(raced).toEqual([null]);
    expect(a).toEqual({ ok: false, answer: { success: false, status: 409, error: 'Put back did not finish on this bot; finish it in the Database window first; nothing was changed' } });
    expect(stored().keptOp).toEqual(other);
  });
});

describe('nm31 admit: code review 1, fix 2', () => {
  it('A5 (code review 1): T-A-LANE takes its article from the op word', async () => {
    await seedMain();
    patch('a', { lane: { op: 'build', wasRunning: false, startedAt: '2026-11-17T09:00:00.000Z', interrupted: true } });
    const { answer, before } = await press();
    expectRefused(answer, 409, 'A build of this instance was cut short; run it again first; nothing was changed');
    unchanged(before);
  });

  it('A5 (code review 1): two running sharers take the plural verb in T-A-SHARERS', async () => {
    await seedMain();
    seedBot({ sourceUrl: SMDB }, 'b');
    seedBot({ sourceUrl: SMDB }, 'c');
    vi.spyOn(fleetBackup, 'runningDatabaseSharers').mockImplementation(async () => ({ bots: ['a', 'b', 'c'].map(id => containerManager.getBot(id)!), unchecked: [] }));
    vi.spyOn(containerManager, 'liveContainerNames').mockImplementation(async (id: string) => (id === 'a' ? [] : [`bot${id}-app-1`]));
    const { answer, before } = await press();
    expectRefused(answer, 409, 'Bot b and Bot c use this database and run; choose Off for each first; nothing was changed');
    unchanged(before);
  });

  it('A5 (code review 1): two sharers docker did not answer for take the plural verb in T-A-SHARERS-UNKNOWN', async () => {
    await seedMain();
    seedBot({ sourceUrl: SMDB }, 'b');
    seedBot({ sourceUrl: SMDB }, 'c');
    vi.spyOn(fleetBackup, 'runningDatabaseSharers').mockImplementation(async () => ({ bots: [containerManager.getBot('a')!], unchecked: ['b', 'c'] }));
    const { answer, before } = await press();
    expectRefused(answer, 409, 'Docker did not say whether Bot b and Bot c, which use this database, are running; nothing was changed');
    unchanged(before);
  });
});

describe('nm31 admit: code review 2', () => {
  it('A8 (code review 2): a URL through fleetDb.replication.publicHost refuses T-A-URLHOST', async () => {
    await seedMain();
    patch('a', { fleetDb: { ...stored().fleetDb, replication: { role: 'smdb_join', password: '', hostPort: 15432, publicHost: 'pub.example', certHost: 'pub.example' } } });
    envManager.setEnvVars('a', { DATA_BACKEND_URL: 'postgresql://smdb:pw@pub.example:15432/smdb' });
    const { answer, before } = await press();
    expectRefused(answer, 409, `The Database URL reaches this database through its public address pub.example, and the new database has no public address until replication is enabled on it; set the URL to the container name ${CONTAINER} first; nothing was changed`);
    unchanged(before);
  });
});

describe('nm31 admit: code review 3', () => {
  it('A9 and C14 (code review 3): a URL through a bracketed IPv6 public host refuses T-A-URLHOST', async () => {
    await seedMain();
    patch('a', { fleetDb: { ...stored().fleetDb, replication: { role: 'smdb_join', password: '', hostPort: 15432, publicHost: '[2001:db8::1]', certHost: '[2001:db8::1]' } } });
    envManager.setEnvVars('a', { DATA_BACKEND_URL: 'postgresql://smdb:pw@[2001:db8::1]:15432/smdb' });
    const { answer, before } = await press();
    expectRefused(answer, 409, `The Database URL reaches this database through its public address 2001:db8::1, and the new database has no public address until replication is enabled on it; set the URL to the container name ${CONTAINER} first; nothing was changed`);
    unchanged(before);
  });

  it('C13 (code review 3): the variant the page is given is the one admission runs: a main whose URL names another host gets the folder variant', async () => {
    await seedMain();
    expect(keptData.newStartVariantOf(containerManager.getBot('a')!)).toBe('main');
    envManager.setEnvVars('a', { DATA_BACKEND_URL: 'postgresql://smdb:pw@db.example:5432/smdb' });
    expect(keptData.newStartVariantOf(containerManager.getBot('a')!)).toBe('folder');
    envManager.setEnvVars('a', { DATA_BACKEND: 'json' });
    expect(keptData.newStartVariantOf(containerManager.getBot('a')!)).toBeNull();
  });
});
