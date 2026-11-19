import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm34-admit-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir };
});

vi.mock('child_process', async (importOriginal) => (await import('./nm31-run')).childProcessMock(await importOriginal(), require('fs')));
vi.mock('fs', async (importOriginal) => (await import('./nm31-run')).fsMock(await importOriginal()));
vi.mock('../../src/docker/dockerClient', async (importOriginal) => {
  const { run } = await import('./nm31-run');
  return {
    ...(await importOriginal<typeof import('../../src/docker/dockerClient')>()),
    volumeState: (name: string) => run.volumes[name] ?? 'absent',
    listBotContainersAsync: async () => [],
  };
});
vi.mock('../../src/instance/appHookClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/appHookClient')>()),
  callAppHook: async () => ({ ok: true, body: { saved: true } }),
}));
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));

import * as fs from 'fs';
import * as path from 'path';
import YAML from 'yaml';
import * as containerManager from '../../src/docker/containerManager';
import * as envManager from '../../src/env/manager';
import * as dbLogin from '../../src/instance/dbLogin';
import * as maintenance from '../../src/instance/maintenance';
import { releaseFleetBackupBusy } from '../../src/instance/fleetBackupGuards';
import { KEPT_TEXT, keptRunningOp, newStartNames, startOnNewDatabase } from '../../src/instance/keptData';
import { docker, resetDocker } from './nm2-docker';
import { clearRegistry, registryPath } from './nm2-harness';
import { resetRun, run } from './nm31-run';
import { answerDatabase, app, composePathOf, CONTAINER, dataDirOf, OFF_MESSAGE, resetSeed, seedMain, stored, treeOf } from './nm31-seed';
import { noAdmin, dropOverride, offOrderNoAdmin, owner, resetOwner, s1Stdout, scriptOf, useOwner, isOwnerShape, Scripted } from './nm34-seed';
import type { InstanceConfig, KeptOpRecord } from '../../src/types';

const NOW = Date.parse('2026-11-17T12:00:00.000Z');
const ISO = new Date(NOW).toISOString();
const names = () => newStartNames({ sanitizedName: 'bota' }, dataDirOf('a'), NOW);
const bot = (): InstanceConfig => containerManager.getBot('a')!;
const user = () => bot().fleetDb!.user;
const realCreate = containerManager.createKeptOpIf;

const READS = (a: string[]) => a[0] === 'inspect' || a[0] === 'ps' || (a[0] === 'volume' && a[1] === 'inspect') || (a[0] === 'exec' && a.includes('psql'));
const WRITE_SQL = /\b(ALTER|CREATE|DROP|UPDATE|INSERT|DELETE|GRANT|REVOKE|TRUNCATE)\b/i;

function tree(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true }).map(String).sort();
}

type Snap = { registry: string; folders: string[]; compose: string; folder: Record<string, string>; inst: InstanceConfig };
const snap = (): Snap => ({
  registry: fs.readFileSync(registryPath(), 'utf-8'), folders: tree(path.join(h.dir, 'bots')),
  compose: fs.readFileSync(composePathOf('a'), 'utf-8'), folder: treeOf(dataDirOf('a')), inst: bot(),
});

/** Nothing changed: no state-changing docker call, no writing SQL, the registry, the compose and the folders as before. */
function unchanged(before: Snap): void {
  expect(docker.calls.filter(a => !READS(a))).toEqual([]);
  expect(run.psqlCalls.filter(c => WRITE_SQL.test(c.input.replace(/\bpg_catalog\.\w+/g, '')))).toEqual([]);
  expect(run.execCalls).toEqual([]);
  expect(fs.readFileSync(registryPath(), 'utf-8')).toBe(before.registry);
  expect(fs.readFileSync(composePathOf('a'), 'utf-8')).toBe(before.compose);
  expect(tree(path.join(h.dir, 'bots'))).toEqual(before.folders);
}

/** The record closed by a refusal at the re-check before N1: keptLast failed, and the database, compose and folder as before. */
function closedUnchanged(before: Snap, text: string): void {
  expect(docker.calls.filter(a => !READS(a))).toEqual([]);
  expect(run.psqlCalls.filter(c => WRITE_SQL.test(c.input.replace(/\bpg_catalog\.\w+/g, '')))).toEqual([]);
  expect(run.execCalls).toEqual([]);
  const after = bot();
  expect(after.keptOp).toBeUndefined();
  expect(after.keptLast).toEqual({ op: 'new-start', set: names().stamp, outcome: 'failed', text, at: ISO });
  expect(after.fleetDb).toEqual(before.inst.fleetDb);
  expect(after.maintenance).toEqual(before.inst.maintenance);
  expect(after.keptSets).toEqual(before.inst.keptSets);
  expect(fs.readFileSync(composePathOf('a'), 'utf-8')).toBe(before.compose);
  expect(treeOf(dataDirOf('a'))).toEqual(before.folder);
  expect(fs.existsSync(names().outDir)).toBe(false);
  expect(fs.existsSync(names().inDir)).toBe(false);
}

async function press() {
  docker.calls.length = 0;
  run.psqlCalls.length = 0;
  run.execCalls.length = 0;
  owner.calls.length = 0;
  const before = snap();
  const answer = await startOnNewDatabase('a');
  return { answer, before };
}

/** A press whose reads wait for runGuarded's 30 s limit: the clock is moved on until the press answers. */
async function pressWithClock() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const p = press();
    let done = false;
    p.then(() => { done = true; }, () => { done = true; });
    for (let i = 0; i < 400 && !done; i++) await vi.advanceTimersByTimeAsync(250);
    return await p;
  } finally {
    vi.useRealTimers();
  }
}

/** The NA fixture: a main whose Off ran on a cluster with no dbm_admin, and the bot role's reads answered. */
async function fixture(): Promise<void> {
  await seedMain('a', { off: false });
  await offOrderNoAdmin('a');
  answerDatabase();
  useOwner();
}

const refused = (text: string) => ({ success: false, status: 409, error: text });
const unsettled = () => refused(KEPT_TEXT.aUnsettled(maintenance.NO_ADMIN_OFF_REASON));
const fail = (stderr: string): Scripted => ({ code: 2, stderr });
const pass = (): Scripted => ({ code: 0, stdout: s1Stdout() });

function composeOf(): any {
  return YAML.parse(fs.readFileSync(composePathOf('a'), 'utf-8'));
}

function maintenanceJson(): unknown {
  return JSON.stringify({ state: 'maintenance', message: OFF_MESSAGE, since: ISO }, null, 2);
}

/** nm31-start's end state of a clean run of the main variant. */
function expectMainDone(before: Snap, answer: unknown): void {
  const n = names();
  const oldDb = before.inst.fleetDb!;
  const password = decodeURIComponent(new URL(envManager.getEnvVars('a').DATA_BACKEND_URL).password);
  expect(answer).toEqual({
    success: true,
    text: KEPT_TEXT.nDoneMain({ old: oldDb.volume, outDir: n.outDir, newVolume: n.newVolume, certs: false, replication: false, sharers: null }),
  });
  const after = bot();
  expect(after.maintenance).toEqual({
    state: 'running', message: '', orderedAt: ISO, settled: true, hook: 'not-sent', login: 'open', savedByBot: null,
    prior: { state: 'off', message: OFF_MESSAGE },
  });
  expect(after.keptSets).toEqual([{ id: n.stamp, keptAt: n.startedAt, by: 'new-start', folder: n.outDir, db: oldDb }]);
  expect(after.fleetDb).toEqual({ containerName: CONTAINER, user: oldDb.user, db: oldDb.db, volume: n.newVolume, password });
  expect(after.keptOp).toBeUndefined();
  expect(after.keptLast).toEqual({ op: 'new-start', set: n.stamp, outcome: 'done', text: (answer as { text: string }).text, at: ISO });
  expect(treeOf(n.outDir)).toEqual(before.folder);
  expect(treeOf(dataDirOf('a'))).toEqual({ 'maintenance.json': maintenanceJson() });
  expect(fs.existsSync(n.inDir)).toBe(false);
  expect(composeOf().volumes['fleet-postgres-data']).toEqual({ name: n.newVolume });
  expect(keptRunningOp('a')).toBeNull();
  expect(containerManager.isBotBusy('a')).toBeNull();
}

const changing = () => docker.calls.filter(a => a[0] === 'stop' || (a[0] === 'sh' && !/ pg_isready /.test(a[1])));

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  resetDocker();
  resetRun();
  clearRegistry();
  fs.rmSync(path.join(h.dir, 'bots'), { recursive: true, force: true });
  resetSeed();
  resetOwner();
  dbLogin.resetManagerRoleCache();
});
afterEach(() => {
  vi.useRealTimers();
  releaseFleetBackupBusy('a');
  vi.restoreAllMocks();
});
afterAll(() => { fs.rmSync(h.dir, { recursive: true, force: true }); });

describe('nm34 admit: the fixture', () => {
  it('fixture: the Off on a cluster with no dbm_admin leaves Off unsettled with the missing-role reason alone', async () => {
    await seedMain('a', { off: false });
    await offOrderNoAdmin('a');
    const m = bot().maintenance!;
    expect(m).toMatchObject({ state: 'off', settled: false, login: 'unconfirmed', lastError: maintenance.NO_ADMIN_OFF_REASON });
    expect(maintenance.NO_ADMIN_OFF_REASON).toBe(`the manager's database role dbm_admin could not be confirmed (${dbLogin.NO_ADMIN_ERROR})`);
    expect(maintenance.noAdminOff(m)).toBe(true);
    expect(docker.calls.some(a => a[0] === 'exec' && a.includes('dbm_admin'))).toBe(true);
  });
});

describe('nm34 admit: Start on a new database under Invariant A', () => {
  it('NA1 (1 of 2): admitted; the record carries the Off\'s orderedAt as noAdminOff, and the run ends in NM31\'s main end state', async () => {
    await fixture();
    const orderedAt = bot().maintenance!.orderedAt;
    const records: KeptOpRecord[] = [];
    vi.spyOn(containerManager, 'createKeptOpIf').mockImplementation((id, rec) => { records.push(rec); return realCreate(id, rec); });
    const { answer, before } = await press();
    expectMainDone(before, answer);
    expect(records).toHaveLength(1);
    expect(records[0].noAdminOff).toBe(orderedAt);
    expect(changing()).toEqual([
      ['stop', '--time', '60', CONTAINER],
      ['sh', `docker compose -f "${composePathOf('a')}" -p "bota" up --no-start fleet-postgres`],
      ['sh', `docker compose -f "${composePathOf('a')}" -p "bota" up -d fleet-postgres`],
    ]);
  });

  it('NA1 (2 of 2): up to N1\'s stop every psql call to the old container is the bot role\'s read-only read; from the stop to N8\'s compose up none names it', async () => {
    await fixture();
    await press();
    const stop = docker.calls.findIndex(a => a[0] === 'stop' && a[a.length - 1] === CONTAINER);
    const up = docker.calls.findIndex(a => a[0] === 'sh' && a[1].includes('up -d fleet-postgres'));
    expect(stop).toBeGreaterThan(0);
    expect(up).toBeGreaterThan(stop);
    const before = docker.calls.slice(0, stop).filter(a => a.includes('psql') && a.includes(CONTAINER));
    expect(before.length).toBe(4);
    for (const a of before) expect(isOwnerShape(a, user())).toBe(true);
    const reads = run.psqlCalls.filter(c => c.args.includes(CONTAINER) && docker.calls.indexOf(c.args) < stop);
    expect(reads.map(scriptOf)).toEqual(['S1', 'S2', 'S4', 'S1']);
    for (const c of reads) expect(c.input.startsWith('BEGIN TRANSACTION READ ONLY;')).toBe(true);
    expect(docker.calls.slice(stop + 1, up).filter(a => a[0] !== 'inspect' && a[0] !== 'container' && a.join(' ').includes(CONTAINER))).toEqual([]);
    expect(docker.calls.slice(stop + 1, up).filter(a => a[0] === 'inspect').every(a => a[1] === '-f')).toBe(true);
  });
});

describe('nm34 admit: Offs left unsettled for another reason', () => {
  it('NA2 (1 of 4): the database did not start: T-A-UNSETTLED with that reason', async () => {
    await seedMain('a', { off: false });
    docker.running[CONTAINER] = false;
    run.execOverrides.push({ match: c => c.includes('up -d fleet-postgres'), answer: { ok: false, stderr: 'no space left on device' } });
    await offOrderNoAdmin('a');
    const reason = bot().maintenance!.lastError!;
    expect(reason).toMatch(/^the database did not start \(/);
    useOwner();
    const { answer, before } = await press();
    expect(answer).toEqual(refused(KEPT_TEXT.aUnsettled(reason)));
    unchanged(before);
    expect(owner.calls).toEqual([]);
  });

  it('NA2 (2 of 4): the stop failed: T-A-UNSETTLED with that reason', async () => {
    await seedMain('a', { off: false });
    app.a = true;
    vi.spyOn(containerManager, 'stopBotInOp').mockResolvedValue({ success: false, error: 'the container did not stop' } as any);
    await offOrderNoAdmin('a');
    const reason = bot().maintenance!.lastError!;
    expect(reason).toBe('the stop failed (the container did not stop)');
    app.a = false;
    useOwner();
    const { answer, before } = await press();
    expect(answer).toEqual(refused(KEPT_TEXT.aUnsettled(reason)));
    unchanged(before);
    expect(owner.calls).toEqual([]);
  });

  it('NA2 (3 of 4): a retry that found the database down: T-A-UNSETTLED with RETRY_DB_DOWN', async () => {
    await seedMain('a', { off: false });
    await offOrderNoAdmin('a');
    docker.running[CONTAINER] = false;
    const over = noAdmin();
    await maintenance.runMaintenanceOrder('a', 'off', OFF_MESSAGE, { retry: true });
    dropOverride(over);
    const reason = bot().maintenance!.lastError!;
    expect(reason).toBe('the database is not running, and a retry does not start it');
    useOwner();
    const { answer, before } = await press();
    expect(answer).toEqual(refused(KEPT_TEXT.aUnsettled(reason)));
    unchanged(before);
  });

  it('NA2 (4 of 4): dbm_admin exists but is not a superuser: T-A-UNSETTLED with that reason', async () => {
    await seedMain('a', { off: false });
    docker.overrides.unshift({ match: a => a[0] === 'exec' && a.includes('dbm_admin'), answer: { ok: true, stdout: 'false\n' } });
    const r = await maintenance.runMaintenanceOrder('a', 'off', OFF_MESSAGE);
    expect(r.settled).toBe(false);
    docker.overrides.shift();
    const reason = bot().maintenance!.lastError!;
    expect(reason).toBe(maintenance.adminFailText('the role dbm_admin exists but is not a superuser'));
    useOwner();
    const { answer, before } = await press();
    expect(answer).toEqual(refused(KEPT_TEXT.aUnsettled(reason)));
    unchanged(before);
  });

  it('NA3: the Off is the no-dbm_admin one, but the URL now names another host (kind not database): T-A-UNSETTLED', async () => {
    await fixture();
    envManager.setEnvVars('a', { DATA_BACKEND_URL: 'postgresql://smdb:pw@db.example:5432/smdb' });
    const { answer, before } = await press();
    expect(answer).toEqual(unsettled());
    unchanged(before);
    expect(owner.calls).toEqual([]);
  });
});

describe('nm34 admit: the app and the database container', () => {
  it('NA4 (1 of 2): the app runs: T-A-RUNS', async () => {
    await fixture();
    app.a = true;
    const { answer, before } = await press();
    expect(answer).toEqual(refused(KEPT_TEXT.aRuns));
    unchanged(before);
    expect(owner.calls).toEqual([]);
  });

  it('NA4 (2 of 2): docker gives no answer for the app: R11', async () => {
    await fixture();
    app.a = null;
    const { answer, before } = await press();
    expect(answer).toEqual(refused('Docker did not say whether the bot is running, so nothing was changed; retry in a moment'));
    unchanged(before);
  });

  it('NA5 (1 of 2): the database container is stopped: T-A-GEN-DOWN', async () => {
    await fixture();
    docker.running[CONTAINER] = false;
    const { answer, before } = await press();
    expect(answer).toEqual(refused(KEPT_TEXT.aGenDown));
    unchanged(before);
    expect(owner.calls).toEqual([]);
  });

  it('NA5 (2 of 2): docker gives no answer for the database container: T-A-GEN-UNKNOWN', async () => {
    await fixture();
    docker.running[CONTAINER] = null;
    const { answer, before } = await press();
    expect(answer).toEqual(refused(KEPT_TEXT.aGenUnknown(`docker did not say whether the database container ${CONTAINER} runs`)));
    unchanged(before);
    expect(owner.calls).toEqual([]);
  });
});

describe('nm34 admit: S1', () => {
  it('NA6 (1 of 3): the bot role does not exist: T-A-NA-READ with psql\'s line', async () => {
    await fixture();
    owner.s1 = fail(`psql: error: connection to server on socket "/var/run/postgresql/.s.PGSQL.5432" failed: FATAL:  role "${user()}" does not exist\n`);
    const { answer, before } = await press();
    expect(answer).toEqual(refused(KEPT_TEXT.aNaRead(user(), `connection to server on socket "/var/run/postgresql/.s.PGSQL.5432" failed: FATAL:  role "${user()}" does not exist`)));
    unchanged(before);
  });

  it('NA6 (2 of 3): the login is refused (no password to give): T-A-NA-READ with psql\'s line', async () => {
    await fixture();
    owner.s1 = fail('psql: error: connection to server on socket "/var/run/postgresql/.s.PGSQL.5432" failed: fe_sendauth: no password supplied\n');
    const { answer, before } = await press();
    expect(answer).toEqual(refused(KEPT_TEXT.aNaRead(user(), 'connection to server on socket "/var/run/postgresql/.s.PGSQL.5432" failed: fe_sendauth: no password supplied')));
    unchanged(before);
  });

  it('NA6 (3 of 3): docker exec fails: T-A-NA-READ with docker\'s line', async () => {
    await fixture();
    owner.s1 = { code: 1, stderr: `Error response from daemon: container ${CONTAINER} is not running\n` };
    const { answer, before } = await press();
    expect(answer).toEqual(refused(KEPT_TEXT.aNaRead(user(), `Error response from daemon: container ${CONTAINER} is not running`)));
    unchanged(before);
  });

  it('NA7: S1 gives no answer within 30 seconds: T-A-NA-READ', async () => {
    await fixture();
    owner.s1 = 'hang';
    const { answer, before } = await pressWithClock();
    expect(answer).toEqual(refused(KEPT_TEXT.aNaRead(user(), 'no answer within 30 seconds')));
    unchanged(before);
  });

  it('NA8: the bot role is not a superuser: T-A-NA-NOTSUPER, and S1 was the only call', async () => {
    await fixture();
    owner.superuser = false;
    const { answer, before } = await press();
    expect(answer).toEqual(refused(KEPT_TEXT.aNaNotSuper(user())));
    unchanged(before);
    expect(owner.calls.map(scriptOf)).toEqual(['S1']);
    expect(run.psqlCalls).toHaveLength(1);
  });

  it('NA9: dbm_admin now exists, a superuser that can log in: T-A-NA-ADMIN', async () => {
    await fixture();
    owner.admin = 'true';
    const { answer, before } = await press();
    expect(answer).toEqual(refused(KEPT_TEXT.aNaAdmin));
    unchanged(before);
  });

  it('NA10: both counts above 0: T-A-NA-SESSIONS with both counts', async () => {
    await fixture();
    owner.sessions = [2, 1];
    const { answer, before } = await press();
    expect(answer).toEqual(refused(KEPT_TEXT.aNaSessions(user(), 2, 1)));
    expect((answer as { error: string }).error).toContain('(2, then 1)');
    unchanged(before);
  });

  it('NA11: S1\'s answer does not parse: T-A-NA-READ with its last line', async () => {
    await fixture();
    owner.s1 = { code: 0, stdout: 't\nrecovery|false\nadmin|maybe\n' };
    const { answer, before } = await press();
    expect(answer).toEqual(refused(KEPT_TEXT.aNaRead(user(), "the read answered 'admin|maybe'")));
    unchanged(before);
  });

  it('NA12: S1 reads restore floor 2: T-A-GEN with 2', async () => {
    await fixture();
    owner.restorekind = 'r';
    owner.restore = 'false|bota-2026.dump|2026-11-16T10:00:00Z|2|machine-a|';
    const { answer, before } = await press();
    expect(answer).toEqual(refused(KEPT_TEXT.aGen(2)));
    unchanged(before);
  });

  it('NA13: S1\'s restore line does not parse: T-A-GEN-UNKNOWN', async () => {
    await fixture();
    owner.restorekind = 'r';
    owner.restore = 'garbled';
    const { answer, before } = await press();
    expect(answer).toEqual(refused(KEPT_TEXT.aGenUnknown("the restore record answered 'garbled'")));
    unchanged(before);
    expect(owner.calls.map(scriptOf)).toEqual(['S1']);
  });

  it('NA20: S1 reads the database in recovery: T-A-NA-STANDBY', async () => {
    await fixture();
    owner.recovery = 'true';
    const { answer, before } = await press();
    expect(answer).toEqual(refused(KEPT_TEXT.aNaStandby));
    unchanged(before);
  });

  it('NA21 (1 of 2): dbm_admin exists and is not a superuser: T-A-NA-ADMINPLAIN', async () => {
    await fixture();
    owner.admin = 'false';
    const { answer, before } = await press();
    expect(answer).toEqual(refused(KEPT_TEXT.aNaAdminPlain));
    unchanged(before);
  });

  it('NA21 (2 of 2), the script check: S1 reads dbm_admin as rolsuper AND rolcanlogin, and false answers T-A-NA-ADMINPLAIN (PG11 drives both outcomes on a real cluster)', async () => {
    await fixture();
    owner.admin = 'false';
    const { answer, before } = await press();
    expect(answer).toEqual(refused(KEPT_TEXT.aNaAdminPlain));
    expect(owner.calls[0].input).toContain("(rolsuper AND rolcanlogin)::text FROM pg_catalog.pg_roles WHERE rolname = 'dbm_admin'");
    unchanged(before);
  });

  it('NA22: restore_state is not a plain table: T-A-GEN-UNKNOWN, and S2 is not read', async () => {
    await fixture();
    owner.restorekind = 'v';
    const { answer, before } = await press();
    expect(answer).toEqual(refused(KEPT_TEXT.aGenUnknown('smdb_manager.restore_state is not a plain table (relkind v), so the manager did not read it')));
    unchanged(before);
    expect(owner.calls.map(scriptOf)).toEqual(['S1']);
  });

  it('NA23: the first count above 0 and the second 0 (a healthcheck probe): admitted', async () => {
    await fixture();
    owner.sessions = [1, 0];
    const { answer, before } = await press();
    expectMainDone(before, answer);
  });
});

describe('nm34 admit: S2', () => {
  it('NA14 (1 of 2): S2 fails: T-A-GEN-UNKNOWN', async () => {
    await fixture();
    owner.s2 = fail('psql: error: connection to server on socket "/var/run/postgresql/.s.PGSQL.5432" failed: FATAL:  database "smdb" does not exist\n');
    const { answer, before } = await press();
    expect(answer).toEqual(refused(KEPT_TEXT.aGenUnknown('connection to server on socket "/var/run/postgresql/.s.PGSQL.5432" failed: FATAL:  database "smdb" does not exist')));
    unchanged(before);
  });

  it('NA14 (2 of 2): S2 gives no answer within 30 seconds: T-A-GEN-UNKNOWN', async () => {
    await fixture();
    owner.s2 = 'hang';
    const { answer, before } = await pressWithClock();
    expect(answer).toEqual(refused(KEPT_TEXT.aGenUnknown('no answer within 30 seconds')));
    unchanged(before);
  });

  it('NA15: smdb_manager.generation is not a plain table: T-A-GEN-UNKNOWN', async () => {
    await fixture();
    owner.gen = 'v\n';
    const { answer, before } = await press();
    expect(answer).toEqual(refused(KEPT_TEXT.aGenUnknown('smdb_manager.generation is not a plain table (relkind v), so the manager did not read it')));
    unchanged(before);
  });

  it('NA16: S2 reads generation 2: T-A-GEN with 2', async () => {
    await fixture();
    owner.gen = 'r\n2|machine-a|2026-11-16T10:00:00Z\n';
    const { answer, before } = await press();
    expect(answer).toEqual(refused(KEPT_TEXT.aGen(2)));
    unchanged(before);
    expect(owner.calls[1].login).toBe(user());
    expect(owner.calls[1].db).toBe(bot().fleetDb!.db);
  });

  it('NA17 (1 of 2): S2 reads generation 1: admitted', async () => {
    await fixture();
    owner.gen = 'r\n1|machine-a|\n';
    const { answer, before } = await press();
    expectMainDone(before, answer);
  });

  it('NA17 (2 of 2): there is no generation table: admitted', async () => {
    await fixture();
    owner.gen = '-\n';
    const { answer, before } = await press();
    expectMainDone(before, answer);
  });

  it('NA18: another admission records first, during S2: A5, and that record stays', async () => {
    await fixture();
    const other: KeptOpRecord = { op: 'put-back', set: 's0', asideSet: 's1', stamp: 's1', startedAt: '2026-11-17T11:59:00.000Z', parts: ['folder'], dataDir: dataDirOf('a'), outDir: 'o', inDir: 'i', offMessage: '', sharers: [], step: 'recorded' };
    const raced: Array<string | null> = [];
    owner.s2 = () => {
      raced.push(containerManager.createKeptOpIf('a', other));
      return { code: 0, stdout: '-\n' };
    };
    const { answer } = await press();
    expect(raced).toEqual([null]);
    expect(answer).toEqual(refused('Put back did not finish on this bot; finish it in the Database window first; nothing was changed'));
    expect(stored().keptOp).toEqual(other);
    expect(docker.calls.filter(a => !READS(a))).toEqual([]);
  });
});

describe('nm34 admit: the re-check before N1', () => {
  const causes: Array<[string, (u: string) => Scripted, (u: string) => string, boolean?]> = [
    ['sessions in both counts', () => ({ code: 0, stdout: s1With({ sessions: [1, 1] }) }), u => KEPT_TEXT.aNaSessions(u, 1, 1)],
    ['dbm_admin a superuser that can log in', () => ({ code: 0, stdout: s1With({ admin: 'true' }) }), () => KEPT_TEXT.aNaAdmin],
    ['dbm_admin not usable', () => ({ code: 0, stdout: s1With({ admin: 'false' }) }), () => KEPT_TEXT.aNaAdminPlain],
    ['recovery', () => ({ code: 0, stdout: s1With({ recovery: 'true' }) }), () => KEPT_TEXT.aNaStandby],
    ['not a superuser', () => ({ code: 0, stdout: 'f\n' }), u => KEPT_TEXT.aNaNotSuper(u)],
    ['the session does not open', u => fail(`psql: error: connection to server on socket "/var/run/postgresql/.s.PGSQL.5432" failed: FATAL:  role "${u}" does not exist\n`),
      u => KEPT_TEXT.aNaRead(u, `connection to server on socket "/var/run/postgresql/.s.PGSQL.5432" failed: FATAL:  role "${u}" does not exist`)],
    ['a time-out', () => 'hang', u => KEPT_TEXT.aNaRead(u, 'no answer within 30 seconds'), true],
    ['an answer that does not parse', () => ({ code: 0, stdout: 'x\n' }), u => KEPT_TEXT.aNaRead(u, "the read answered 'x'")],
  ];
  causes.forEach(([cause, answerOf, textOf, clock], i) => {
    it(`RC2 (${i + 1} of 8): the database runs and the second S1 reads ${cause}: the record closes, keptLast failed, nothing changed, 409`, async () => {
      await fixture();
      owner.s1Queue = [pass(), answerOf(user())];
      const { answer, before } = clock ? await pressWithClock() : await press();
      const text = textOf(user());
      expect(answer).toEqual(refused(text));
      expect(owner.calls.map(scriptOf)).toEqual(['S1', 'S2', 'S4', 'S1']);
      closedUnchanged(before, text);
    });
  });

  it('RC3: at the re-check the database reads stopped: no read, on to N1 and the clean end state', async () => {
    await fixture();
    owner.s4 = () => {
      docker.running[CONTAINER] = false;
      return { code: 0, stdout: 'ssl|off\n' };
    };
    const { answer, before } = await press();
    expectMainDone(before, answer);
    expect(owner.calls.map(scriptOf)).toEqual(['S1', 'S2', 'S4']);
  });

  it('RC4: at the re-check docker gives no answer for the database: the run stops with the record open', async () => {
    await fixture();
    owner.s4 = () => {
      docker.running[CONTAINER] = null;
      return { code: 0, stdout: 'ssl|off\n' };
    };
    const { answer } = await press();
    const reason = `docker did not say whether the database container ${CONTAINER} runs`;
    expect(answer).toEqual({ success: false, status: 409, open: true, error: KEPT_TEXT.nOpen(reason, []) });
    const rec = bot().keptOp!;
    expect(rec).toMatchObject({ op: 'new-start', step: 'recorded', lastError: reason, noAdminOff: bot().maintenance!.orderedAt });
    expect(owner.calls.map(scriptOf)).toEqual(['S1', 'S2', 'S4']);
    expect(docker.calls.filter(a => !READS(a))).toEqual([]);
  });
});

/** The settings Postgres 16.0 knows among those the reads as the bot role send (a dotted name is a placeholder any version takes). */
const PG16_0_SETTINGS = new Set(['search_path', 'lock_timeout', 'statement_timeout', 'idle_in_transaction_session_timeout', 'idle_session_timeout',
  'tcp_keepalives_idle', 'tcp_keepalives_interval', 'tcp_keepalives_count', 'tcp_user_timeout', 'TimeZone', 'DateStyle', 'IntervalStyle',
  'extra_float_digits', 'bytea_output', 'client_encoding', 'timezone_abbreviations', 'lc_numeric', 'lc_monetary', 'lc_time', 'xmloption',
  'standard_conforming_strings', 'backslash_quote', 'array_nulls', 'quote_all_identifiers', 'transform_null_equals', 'row_security',
  'gin_fuzzy_search_limit', 'local_preload_libraries', 'client_min_messages', 'exit_on_error', 'default_transaction_isolation',
  'default_transaction_deferrable', 'default_tablespace', 'temp_tablespaces', 'default_table_access_method', 'synchronous_commit',
  'stats_fetch_consistency', 'default_transaction_read_only', 'role']);

describe('nm34 admit: the session options of the reads as the bot role', () => {
  it('A2 (code review 1): ownerReadArgs sends no setting Postgres 16.0 lacks (restrict_nonsystem_relation_kind came in 16.4)', () => {
    const args = dbLogin.ownerReadArgs('bota-fleet-postgres', 'app', 'app');
    const env = args[args.indexOf('-e') + 1];
    expect(env.startsWith('PGOPTIONS=-c ')).toBe(true);
    const names = env.slice('PGOPTIONS=-c '.length).split(' -c ').map(o => o.split('=')[0]);
    expect(names).not.toContain('restrict_nonsystem_relation_kind');
    expect(names.filter(n => !n.includes('.') && !PG16_0_SETTINGS.has(n))).toEqual([]);
    expect(dbLogin.MANAGER_SESSION_OPTIONS).toContain('-c restrict_nonsystem_relation_kind= ');
  });
});

/** S1's stdout with some fields changed from the passing answer. */
function s1With(p: Partial<{ sessions: [number, number]; admin: 'missing' | 'true' | 'false'; recovery: string }>): string {
  const saved = { sessions: owner.sessions, admin: owner.admin, recovery: owner.recovery };
  Object.assign(owner, p);
  const out = s1Stdout();
  Object.assign(owner, saved);
  return out;
}
