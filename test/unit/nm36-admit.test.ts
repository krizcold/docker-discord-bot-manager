import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm36-admit-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir };
});

vi.mock('child_process', async (importOriginal) => (await import('./nm36-tls')).childProcessMock(await importOriginal(), require('fs')));
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
import * as containerManager from '../../src/docker/containerManager';
import * as dbLogin from '../../src/instance/dbLogin';
import { claimFleetBackupBusy, releaseFleetBackupBusy } from '../../src/instance/fleetBackupGuards';
import { KEPT_TEXT, newStartDone, newStartNames, startOnNewDatabase } from '../../src/instance/keptData';
import { docker, resetDocker } from './nm2-docker';
import { clearRegistry, registryPath } from './nm2-harness';
import { resetRun, run } from './nm31-run';
import { answerDatabase, composePathOf, CONTAINER, dataDirOf, db, resetSeed, seedCopy, seedExternal, seedMain, stored } from './nm31-seed';
import { offOrderNoAdmin, owner, resetOwner, scriptOf, useOwner, Scripted } from './nm34-seed';
import { resetTls, tlsFake } from './nm36-tls';
import type { InstanceConfig, KeptOpRecord } from '../../src/types';

const NOW = Date.parse('2026-11-17T12:00:00.000Z');
const names = () => newStartNames({ sanitizedName: 'bota' }, dataDirOf('a'), NOW);
const bot = (): InstanceConfig => containerManager.getBot('a')!;
const realCreate = containerManager.createKeptOpIf;

const READS = (a: string[]) => a[0] === 'inspect' || a[0] === 'ps' || (a[0] === 'volume' && a[1] === 'inspect') || (a[0] === 'exec' && a.includes('psql'));
const WRITE_SQL = /\b(ALTER|CREATE|DROP|UPDATE|INSERT|DELETE|GRANT|REVOKE|TRUNCATE)\b/i;
const isShowSsl = (a: string[]) => a.join(' ').includes('SHOW ssl');

function tree(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true }).map(String).sort();
}

type Snap = { registry: string; folders: string[]; compose: string };
const snap = (): Snap => ({ registry: fs.readFileSync(registryPath(), 'utf-8'), folders: tree(path.join(h.dir, 'bots')), compose: fs.readFileSync(composePathOf('a'), 'utf-8') });

/** NM31's unchanged: no state-changing docker call, no writing SQL, the registry, compose and folders as before; and the slot is free again. */
function unchanged(before: Snap): void {
  expect(docker.calls.filter(a => !READS(a))).toEqual([]);
  expect(run.psqlCalls.filter(c => WRITE_SQL.test(c.input.replace(/\bpg_catalog\.\w+/g, '')))).toEqual([]);
  expect(docker.calls.filter(a => a[0] === 'exec' && a.includes('-c') && WRITE_SQL.test(a[a.indexOf('-c') + 1]))).toEqual([]);
  expect(run.execCalls).toEqual([]);
  expect(tlsFake.calls).toEqual([]);
  expect(fs.readFileSync(registryPath(), 'utf-8')).toBe(before.registry);
  expect(fs.readFileSync(composePathOf('a'), 'utf-8')).toBe(before.compose);
  expect(tree(path.join(h.dir, 'bots'))).toEqual(before.folders);
  expect(claimFleetBackupBusy('a')).toBe(true);
  releaseFleetBackupBusy('a');
}

/** The records admission wrote, with the docker call count and the bot role's scripts at that moment. */
const created: Array<{ rec: KeptOpRecord; at: number; scripts: Array<string | null> }> = [];
function watchCreate(): void {
  vi.spyOn(containerManager, 'createKeptOpIf').mockImplementation((id, rec) => {
    created.push({ rec, at: docker.calls.length, scripts: owner.calls.map(scriptOf) });
    return realCreate(id, rec);
  });
}

async function press() {
  docker.calls.length = 0;
  run.psqlCalls.length = 0;
  run.execCalls.length = 0;
  owner.calls.length = 0;
  tlsFake.calls.length = 0;
  const before = snap();
  const answer = await startOnNewDatabase('a');
  return { answer, before };
}

/** A press whose read waits for its 30 s limit: the clock is moved on until the press answers. */
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

const refused = (text: string) => ({ success: false, status: 409, error: text });

async function mainFixture(): Promise<void> {
  await seedMain();
  answerDatabase();
}

async function noAdminFixture(): Promise<void> {
  await seedMain('a', { off: false });
  await offOrderNoAdmin('a');
  answerDatabase();
  useOwner();
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  resetDocker();
  resetRun();
  resetTls();
  clearRegistry();
  fs.rmSync(path.join(h.dir, 'bots'), { recursive: true, force: true });
  resetSeed();
  resetOwner();
  dbLogin.resetManagerRoleCache();
  created.length = 0;
  tlsFake.newVolume = names().newVolume;
});
afterEach(() => {
  vi.useRealTimers();
  releaseFleetBackupBusy('a');
  vi.restoreAllMocks();
});
afterAll(() => { fs.rmSync(h.dir, { recursive: true, force: true }); });

describe('nm36 admit: A21 on the admin path', () => {
  it('A21-1: SHOW ssl answers on: the record is written with keptSsl true, the read after the generation reads and before the save', async () => {
    await mainFixture();
    db.ssl = { ok: true, stdout: 'on\n' };
    watchCreate();
    const { answer } = await press();
    expect(answer).toMatchObject({ success: true });
    expect(created).toHaveLength(1);
    expect(created[0].rec.keptSsl).toBe(true);
    const ssl = docker.calls.findIndex(isShowSsl);
    const genReads = run.psqlCalls.filter(c => c.login === 'dbm_meta' || c.input.includes('restore_state')).map(c => docker.calls.indexOf(c.args));
    expect(genReads.length).toBeGreaterThan(0);
    expect(ssl).toBeGreaterThan(Math.max(...genReads));
    expect(ssl).toBeLessThan(created[0].at);
    expect(docker.calls.filter(isShowSsl)).toHaveLength(1);
    expect(docker.calls[ssl]).toEqual(['exec', CONTAINER, 'psql', '-X', '-U', 'dbm_admin', '-d', 'postgres', '-tA', '-v', 'ON_ERROR_STOP=1', '-c', 'SHOW ssl']);
  });

  it('A21-2: SHOW ssl answers off: keptSsl false', async () => {
    await mainFixture();
    watchCreate();
    const { answer } = await press();
    expect(answer).toMatchObject({ success: true });
    expect(created[0].rec.keptSsl).toBe(false);
    expect(tlsFake.calls).toEqual([]);
  });

  it('A21-3: the admin psql fails: T-A-SSL with its last line, nothing changed', async () => {
    await mainFixture();
    db.ssl = { ok: false, stderr: `Error response from daemon: container ${CONTAINER} is not running\n` };
    const { answer, before } = await press();
    expect(answer).toEqual(refused(KEPT_TEXT.aSslUnknown(`Error response from daemon: container ${CONTAINER} is not running`)));
    expect(bot().keptOp).toBeUndefined();
    unchanged(before);
  });

  it('A21-4: the admin read gets no answer in 30 s: T-A-SSL("docker did not answer within 30 s"), nothing changed', async () => {
    await mainFixture();
    tlsFake.hangSql = 'SHOW ssl';
    const { answer, before } = await pressWithClock();
    expect(answer).toEqual(refused(KEPT_TEXT.aSslUnknown('docker did not answer within 30 s')));
    expect(bot().keptOp).toBeUndefined();
    unchanged(before);
  });

  it.each([['', ''], ['true', 'true'], ['on\non', 'on'], ['ON', 'ON'], ['x', 'x']])('A21-5: the admin read answers %j: T-A-SSL("the read answered ..."), nothing changed', async (stdout, last) => {
    await mainFixture();
    db.ssl = { ok: true, stdout: `${stdout}\n` };
    const { answer, before } = await press();
    expect(answer).toEqual(refused(KEPT_TEXT.aSslUnknown(`the read answered '${last}'`)));
    expect(bot().keptOp).toBeUndefined();
    unchanged(before);
  });
});

describe('nm36 admit: A21 as the bot role (S4)', () => {
  it('A21-6: S4 answers ssl|on: keptSsl true, the scripts S1, S2, S4 before the record', async () => {
    await noAdminFixture();
    owner.ssl = 'on';
    watchCreate();
    const { answer } = await press();
    expect(answer).toMatchObject({ success: true });
    expect(created[0].rec.keptSsl).toBe(true);
    expect(created[0].scripts).toEqual(['S1', 'S2', 'S4']);
    const s4 = owner.calls.find(c => scriptOf(c) === 'S4')!;
    expect(s4.db).toBe('postgres');
    expect(s4.input).toBe("BEGIN TRANSACTION READ ONLY;\nSELECT 'ssl|' || pg_catalog.current_setting('ssl');\nROLLBACK;\n");
    expect(docker.calls.filter(isShowSsl)).toEqual([]);
  });

  it('A21-7: S4 answers ssl|off: keptSsl false', async () => {
    await noAdminFixture();
    watchCreate();
    const { answer } = await press();
    expect(answer).toMatchObject({ success: true });
    expect(created[0].rec.keptSsl).toBe(false);
    expect(created[0].scripts).toEqual(['S1', 'S2', 'S4']);
    expect(tlsFake.calls).toEqual([]);
  });

  it('A21-8: S4 fails: T-A-SSL with psql\'s error, nothing changed', async () => {
    await noAdminFixture();
    owner.s4 = { code: 2, stderr: 'psql: error: connection to server on socket "/var/run/postgresql/.s.PGSQL.5432" failed: FATAL:  the database system is shutting down\n' };
    const { answer, before } = await press();
    expect(answer).toEqual(refused(KEPT_TEXT.aSslUnknown('connection to server on socket "/var/run/postgresql/.s.PGSQL.5432" failed: FATAL:  the database system is shutting down')));
    expect(owner.calls.map(scriptOf)).toEqual(['S1', 'S2', 'S4']);
    expect(bot().keptOp).toBeUndefined();
    unchanged(before);
  });

  it('A21-9: S4 gets no answer: T-A-SSL("no answer within 30 seconds"), nothing changed', async () => {
    await noAdminFixture();
    owner.s4 = 'hang';
    const { answer, before } = await pressWithClock();
    expect(answer).toEqual(refused(KEPT_TEXT.aSslUnknown('no answer within 30 seconds')));
    expect(bot().keptOp).toBeUndefined();
    unchanged(before);
  });

  it.each([['ssl|true', 'ssl|true'], ['ssl|', 'ssl|'], ['on', 'on'], ['ssl|on\nssl|on', 'ssl|on']])('A21-10: S4 answers %j: T-A-SSL("the read answered ..."), nothing changed', async (stdout, last) => {
    await noAdminFixture();
    owner.s4 = { code: 0, stdout: `${stdout}\n` } as Scripted;
    const { answer, before } = await press();
    expect(answer).toEqual(refused(KEPT_TEXT.aSslUnknown(`the read answered '${last}'`)));
    expect(bot().keptOp).toBeUndefined();
    unchanged(before);
  });
});

describe('nm36 admit: no read', () => {
  it.each(['copy', 'folder'] as const)('A21-12: the %s variant reads no ssl and its record has no keptSsl field', async (variant) => {
    if (variant === 'copy') await seedCopy();
    else await seedExternal();
    answerDatabase();
    useOwner();
    watchCreate();
    const { answer } = await press();
    expect(answer).toMatchObject({ success: true });
    expect(created).toHaveLength(1);
    expect('keptSsl' in created[0].rec).toBe(false);
    expect(docker.calls.filter(isShowSsl)).toEqual([]);
    expect(owner.calls.filter(c => scriptOf(c) === 'S4')).toEqual([]);
    expect(tlsFake.calls).toEqual([]);
  });

  it('A21-13: a press on an open record with keptSsl true at db-in reads no ssl; the run uses the record\'s keptSsl', async () => {
    await mainFixture();
    db.ssl = { ok: true, stdout: 'on\n' };
    tlsFake.openssl = 'fail';
    const first = await press();
    expect(first.answer).toMatchObject({ success: false, open: true });
    expect(stored().keptOp).toMatchObject({ step: 'db-in', keptSsl: true });
    expect(docker.calls.filter(isShowSsl)).toHaveLength(1);
    tlsFake.openssl = 'pair';
    db.ssl = { ok: true, stdout: 'x\n' };
    const { answer } = await press();
    expect(docker.calls.filter(isShowSsl)).toEqual([]);
    expect(answer).toMatchObject({ success: true });
    expect((answer as { text: string }).text).toContain(', TLS on as the kept database had it (with a certificate of its own, which Enable replication replaces),');
    expect(tlsFake.calls).toContain('openssl');
    expect(newStartDone({ step: 'db-up', parts: ['db', 'folder'], keptSsl: true })).toContain('TLS is on');
  });
});
