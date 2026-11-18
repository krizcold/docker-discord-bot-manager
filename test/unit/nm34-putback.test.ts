import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm34-putback-'));
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
import * as dbLogin from '../../src/instance/dbLogin';
import * as maintenance from '../../src/instance/maintenance';
import { claimFleetBackupBusy, releaseFleetBackupBusy } from '../../src/instance/fleetBackupGuards';
import { KEPT_TEXT, keptDate, keptRunningOp, putBackDone } from '../../src/instance/keptData';
import type { KeptOpRecord } from '../../src/types';
import { docker, resetDocker } from './nm2-docker';
import { clearRegistry, registryPath } from './nm2-harness';
import { resetRun, run } from './nm31-run';
import { composePathOf, COPY_CONTAINER, COPY_VOLUME, CONTAINER, dataDirOf, patchRegistry, resetSeed, treeOf } from './nm31-seed';
import { answerOrders, asideDir, Before, bot, fwd, keptAfterStart, LATER, LATER_STAMP, login, orders, pressBack, resetBack, stored } from './nm31-back';
import { dropOverride, NO_ADMIN_STDERR, noAdmin, offOrderNoAdmin, owner, resetOwner, s1Stdout, scriptOf, Scripted, useOwner, isOwnerShape } from './nm34-seed';

const LATER_ISO = new Date(LATER).toISOString();
const DATE = keptDate(fwd().stamp);
const realSave = containerManager.saveKeptOpIf;
const realSwap = containerManager.swapKeptData;
const realCreate = containerManager.createKeptOpIf;
const user = () => bot().fleetDb!.user;
const regText = () => fs.readFileSync(registryPath(), 'utf-8');
const composeOf = (): any => YAML.parse(fs.readFileSync(composePathOf('a'), 'utf-8'));
const orderText = (i = orders.length - 1) => (orders[i] as { text: string }).text;
const fail = (stderr: string): Scripted => ({ code: 2, stderr });
const pass = (): Scripted => ({ code: 0, stdout: s1Stdout() });
const ROLE_GONE = (u: string) => `psql: error: connection to server on socket "/var/run/postgresql/.s.PGSQL.5432" failed: FATAL:  role "${u}" does not exist\n`;
const ROLE_GONE_LINE = (u: string) => `connection to server on socket "/var/run/postgresql/.s.PGSQL.5432" failed: FATAL:  role "${u}" does not exist`;

/** A kept set made by NM31's forward run, then an Off of the database in use that stays unsettled for the missing dbm_admin alone. */
async function naKept(opts: { folderOnly?: boolean } = {}): Promise<Before> {
  const before = await keptAfterStart('main', { off: false });
  if (opts.folderOnly) expect(containerManager.dropKeptPart('a', fwd().stamp, 'db')).toBeNull();
  vi.mocked(dbLogin.ensureManagerDbRole).mockRestore();
  await offOrderNoAdmin('a');
  expect(maintenance.noAdminOff(bot().maintenance!)).toBe(true);
  answerOrders();
  useOwner();
  login.canLogin = false;
  orders.length = 0;
  return before;
}

/** The run's own Off order meets the cluster with no dbm_admin, through the real ensureManagerDbRole. */
function orderWithoutAdmin(): () => void {
  vi.mocked(dbLogin.ensureManagerDbRole).mockRestore();
  dbLogin.resetManagerRoleCache();
  const over = noAdmin();
  return () => dropOverride(over);
}

function clearCalls(): void {
  docker.calls.length = 0;
  run.psqlCalls.length = 0;
  run.execCalls.length = 0;
  owner.calls.length = 0;
}

/** The end state of a clean Put back of the main's set onto the NA instance. */
function expectMainBack(before: Before, answer: unknown, warning?: string): void {
  const n = fwd();
  expect(answer).toEqual({
    success: true,
    text: KEPT_TEXT.pDone({ date: DATE, volume: before.inst.fleetDb!.volume, folder: dataDirOf('a'), asideVolume: n.newVolume, asideFolder: asideDir(), orderText: orderText() }),
    ...(warning ? { warning } : {}),
  });
  const after = bot();
  expect(after.fleetDb).toEqual(before.inst.fleetDb);
  expect(after.keptSets).toEqual([expect.objectContaining({ id: LATER_STAMP, by: 'put-back', folder: asideDir(), db: expect.objectContaining({ volume: n.newVolume }) })]);
  expect(after.keptOp).toBeUndefined();
  expect(after.keptLast).toEqual({ op: 'put-back', set: n.stamp, outcome: 'done', text: (answer as { text: string }).text, at: LATER_ISO });
  expect(treeOf(dataDirOf('a'))).toEqual(before.folder);
  expect(composeOf().volumes['fleet-postgres-data']).toEqual({ name: before.inst.fleetDb!.volume });
  expect(keptRunningOp('a')).toBeNull();
  expect(containerManager.isBotBusy('a')).toBeNull();
}

/** A refusal at P0: the answer, and nothing changed in the registry, the folders or the compose, and no docker call that changes state. */
async function refusedWith(error: string, clock = false) {
  const reg = regText();
  const data = treeOf(dataDirOf('a'));
  const kept = treeOf(fwd().outDir);
  const compose = fs.readFileSync(composePathOf('a'), 'utf-8');
  clearCalls();
  const answer = clock ? await withClock(() => pressBack()) : await pressBack();
  expect(answer).toEqual({ success: false, status: 409, error });
  expect(regText()).toBe(reg);
  expect(treeOf(dataDirOf('a'))).toEqual(data);
  expect(treeOf(fwd().outDir)).toEqual(kept);
  expect(fs.readFileSync(composePathOf('a'), 'utf-8')).toBe(compose);
  expect(docker.calls.filter(a => a[0] === 'stop' || a[0] === 'rm' || a[0] === 'start')).toEqual([]);
  expect(run.execCalls).toEqual([]);
  expect(keptRunningOp('a')).toBeNull();
  expect(claimFleetBackupBusy('a')).toBe(true);
  releaseFleetBackupBusy('a');
}

/** A press whose reads wait for runGuarded's 30 s limit: the clock is moved on until it answers. */
async function withClock<T>(fn: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const p = fn();
    let done = false;
    p.then(() => { done = true; }, () => { done = true; });
    for (let i = 0; i < 800 && !done; i++) await vi.advanceTimersByTimeAsync(250);
    return await p;
  } finally {
    vi.useRealTimers();
  }
}

/** Throws once from saveKeptOpIf for the patch that saves `step`, before anything is saved. */
function crashOnStep(step: string): void {
  let done = false;
  vi.spyOn(containerManager, 'saveKeptOpIf').mockImplementation((id, key, patch) => {
    if (!done && patch.step === step) {
      done = true;
      throw new Error('the manager stopped here');
    }
    return realSave(id, key, patch);
  });
}

function failRename(match: (from: string, to: string) => boolean, message: string): void {
  let done = false;
  run.beforeRename = (from, to) => {
    if (!done && match(from, to)) {
      done = true;
      throw Object.assign(new Error(message), { code: message.split(':')[0] });
    }
  };
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-17T12:00:00.000Z'));
  resetDocker();
  resetRun();
  clearRegistry();
  fs.rmSync(path.join(h.dir, 'bots'), { recursive: true, force: true });
  resetSeed();
  resetBack();
  resetOwner();
  dbLogin.resetManagerRoleCache();
});
afterEach(() => {
  vi.useRealTimers();
  releaseFleetBackupBusy('a');
  vi.restoreAllMocks();
});
afterAll(() => { fs.rmSync(h.dir, { recursive: true, force: true }); });

describe('nm34 put back: admitted under Invariant A', () => {
  it('PB1: a database set onto an instance whose Off is the no-dbm_admin one: the old database stopped and kept, the set\'s database in use, its Off settled', async () => {
    const before = await naKept();
    const orderedAt = bot().maintenance!.orderedAt;
    const records: KeptOpRecord[] = [];
    vi.spyOn(containerManager, 'createKeptOpIf').mockImplementation((id, rec) => { records.push(rec); return realCreate(id, rec); });
    clearCalls();
    const answer = await pressBack();
    expectMainBack(before, answer);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ op: 'put-back', noAdminOff: orderedAt });
    expect(owner.calls.map(scriptOf)).toEqual(['S1', 'S1']);
    for (const c of owner.calls) {
      expect(isOwnerShape(c.args, user())).toBe(true);
      expect(c.input.startsWith('BEGIN TRANSACTION READ ONLY;')).toBe(true);
    }
    expect(docker.calls.filter(a => a[0] === 'stop')).toEqual([['stop', '--time', '60', CONTAINER]]);
    expect(stored().maintenance).toMatchObject({ state: 'off', settled: true });
  });

  it('PB2: a folder-only set: S1 still runs, the database stays in use, and P7\'s Off stays unsettled for the missing dbm_admin as the close\'s warning', async () => {
    const before = await naKept({ folderOnly: true });
    const inUse = bot().fleetDb;
    const done = orderWithoutAdmin();
    clearCalls();
    const answer = await pressBack();
    done();
    const text = orderText();
    expect(text).toContain(dbLogin.NO_ADMIN_ERROR);
    expect(answer).toEqual({
      success: true,
      text: KEPT_TEXT.pDone({ date: DATE, folder: dataDirOf('a'), asideFolder: asideDir(), orderText: text }),
      warning: text,
    });
    expect(owner.calls.map(scriptOf)).toEqual(['S1', 'S1']);
    expect(bot().fleetDb).toEqual(inUse);
    expect(treeOf(dataDirOf('a'))).toEqual(before.folder);
    expect(docker.calls.filter(a => a[0] === 'stop')).toEqual([]);
    expect(stored().maintenance).toMatchObject({ state: 'off', settled: false, login: 'unconfirmed', lastError: maintenance.NO_ADMIN_OFF_REASON });
    expect(bot().keptOp).toBeUndefined();
  });
});

describe('nm34 put back: P0 refuses and changes nothing', () => {
  it('PB3 (1 of 2): the database in use is stopped: T-A-NA-DOWN', async () => {
    await naKept();
    docker.running[CONTAINER] = false;
    await refusedWith(KEPT_TEXT.aNaDown);
    expect(owner.calls).toEqual([]);
  });

  it('PB3 (2 of 2): docker gives no answer for the database: T-A-NA-READ', async () => {
    await naKept();
    docker.running[CONTAINER] = null;
    await refusedWith(KEPT_TEXT.aNaRead(user(), `docker did not say whether the database container ${CONTAINER} runs`));
    expect(owner.calls).toEqual([]);
  });

  const causes: Array<[string, (u: string) => void, (u: string) => string, boolean?]> = [
    ['the session does not open', (u) => { owner.s1 = fail(ROLE_GONE(u)); }, u => KEPT_TEXT.aNaRead(u, ROLE_GONE_LINE(u))],
    ['it times out', () => { owner.s1 = 'hang'; }, u => KEPT_TEXT.aNaRead(u, 'no answer within 30 seconds'), true],
    ['the bot role is not a superuser', () => { owner.superuser = false; }, u => KEPT_TEXT.aNaNotSuper(u)],
    ['dbm_admin is a superuser that can log in', () => { owner.admin = 'true'; }, () => KEPT_TEXT.aNaAdmin],
    ['sessions in both counts', () => { owner.sessions = [1, 2]; }, u => KEPT_TEXT.aNaSessions(u, 1, 2)],
    ['the answer does not parse', () => { owner.s1 = { code: 0, stdout: 't\nrecovery|false\nadmin|maybe\n' }; }, u => KEPT_TEXT.aNaRead(u, "the read answered 'admin|maybe'")],
    ['the database is in recovery', () => { owner.recovery = 'true'; }, () => KEPT_TEXT.aNaStandby],
    ['dbm_admin cannot be used', () => { owner.admin = 'false'; }, () => KEPT_TEXT.aNaAdminPlain],
  ];
  causes.forEach(([cause, set, textOf, clock], i) => {
    it(`PB4 (${i + 1} of 8): S1 at P0 reads ${cause}: refused, nothing recorded`, async () => {
      await naKept();
      set(user());
      await refusedWith(textOf(user()), clock);
      expect(owner.calls.map(scriptOf)).toEqual(['S1']);
      expect(stored().keptOp).toBeUndefined();
    });
  });
});

describe('nm34 put back: a crash after each step before db-in, then Run it again', () => {
  const cases: Array<[string, () => void, number]> = [
    ['after P0\'s save', () => {
      let thrown = false;
      vi.spyOn(containerManager, 'createKeptOpIf').mockImplementation((id, rec) => {
        const r = realCreate(id, rec);
        if (!thrown) { thrown = true; throw new Error('the manager stopped here'); }
        return r;
      });
    }, 1],
    ['after P1\'s stop, before its save', () => crashOnStep('db-stopped'), 0],
    ['after P2', () => crashOnStep('db-out'), 0],
    ['after P3', () => {
      let swaps = 0;
      vi.spyOn(containerManager, 'swapKeptData').mockImplementation((...args) => {
        swaps++;
        const r = realSwap(...args);
        if (swaps === 1) throw new Error('the manager stopped here');
        return r;
      });
    }, 0],
    ['after P4\'s rename', () => failRename((from) => from === fwd().outDir, 'the manager stopped here'), 0],
    ['after P5', () => crashOnStep('folder'), 0],
  ];
  cases.forEach(([when, crash, s1], i) => {
    it(`${i < 3 ? 'PB5' : 'PB6'} (${i < 3 ? i + 1 : i - 2} of 3): ${when}: A7 by the record's noAdminOff, ${s1 ? 'the re-check reads S1 again' : 'no S1'}, then the clean end`, async () => {
      const before = await naKept();
      crash();
      expect(await pressBack()).toMatchObject({ success: false });
      const rec = stored().keptOp;
      expect(rec).toMatchObject({ op: 'put-back', noAdminOff: bot().maintenance!.orderedAt });
      expect(maintenance.noAdminOff(bot().maintenance!)).toBe(true);
      clearCalls();
      expectMainBack(before, await pressBack());
      expect(owner.calls.map(scriptOf)).toEqual(s1 ? ['S1'] : []);
    });
  });
});

describe('nm34 put back: the other resumes', () => {
  it('PB7: a resume from db-in on skips A7: a record whose noAdminOff no longer matches goes on to done', async () => {
    const before = await naKept();
    vi.mocked(dbLogin.blockBotLogin).mockResolvedValue({ ok: false, cls: 'other', error: 'permission denied to alter role' });
    crashOnStep('settled');
    expect(await pressBack()).toMatchObject({ success: false, open: true });
    expect(stored().keptOp.step).toBe('db-in');
    patchRegistry('a', { keptOp: { ...stored().keptOp, noAdminOff: '2026-01-01T00:00:00.000Z' } });
    vi.mocked(dbLogin.blockBotLogin).mockImplementation(async () => { login.canLogin = false; return { ok: true } as any; });
    clearCalls();
    const answer = await pressBack();
    expect(answer).toMatchObject({ success: true });
    expect(bot().keptOp).toBeUndefined();
    expect(bot().fleetDb).toEqual(before.inst.fleetDb);
    expect(owner.calls).toEqual([]);
  });

  it('PB8: Put back onto an instance whose Off settled, on a cluster with no dbm_admin: done with the unsettled Off as warning; that Off then admits Put back of the other set', async () => {
    const before = await keptAfterStart('main');
    useOwner();
    const done = orderWithoutAdmin();
    const answer = await pressBack();
    done();
    const text = orderText();
    expect(text).toContain(dbLogin.NO_ADMIN_ERROR);
    expectMainBack(before, answer, text);
    expect(maintenance.noAdminOff(bot().maintenance!)).toBe(true);
    answerOrders();
    orders.length = 0;
    vi.mocked(Date.now).mockReturnValue(Date.parse('2026-11-17T14:00:00.000Z'));
    clearCalls();
    const again = await pressBack(LATER_STAMP);
    expect(again).toMatchObject({ success: true });
    expect(owner.calls.map(scriptOf)).toEqual(['S1', 'S1']);
    expect(bot().fleetDb!.volume).toBe(fwd().newVolume);
    expect(stored().maintenance).toMatchObject({ state: 'off', settled: true });
  });

  it('PB9: a resume before db-in whose noAdminOff differs from the Off\'s orderedAt: T-A-UNSETTLED, the record stays open', async () => {
    await naKept();
    crashOnStep('db-out');
    expect(await pressBack()).toMatchObject({ success: false, open: true });
    const changed = { ...stored().keptOp, noAdminOff: '2026-01-01T00:00:00.000Z' };
    patchRegistry('a', { keptOp: changed });
    clearCalls();
    const answer = await pressBack();
    expect(answer).toEqual({ success: false, status: 409, error: KEPT_TEXT.aUnsettled(maintenance.NO_ADMIN_OFF_REASON) });
    expect(stored().keptOp).toEqual(changed);
    expect(docker.calls.filter(a => a[0] === 'stop')).toEqual([]);
    expect(owner.calls).toEqual([]);
  });
});

describe('nm34 put back: the re-check before P1', () => {
  it('PB10a: the database runs and S1 passes: P1 and on to done', async () => {
    const before = await naKept();
    const over = { match: (a: string[]) => a[0] === 'stop', answer: { ok: false, stderr: 'Error response from daemon: cannot stop container: permission denied' } };
    docker.overrides.unshift(over);
    expect(await pressBack()).toMatchObject({ success: false, open: true });
    expect(stored().keptOp.step).toBe('recorded');
    dropOverride(over);
    clearCalls();
    expectMainBack(before, await pressBack());
    expect(owner.calls.map(scriptOf)).toEqual(['S1']);
  });

  it('PB10b: the database runs and S1 refuses: the record closes, keptLast failed, nothing changed, 409', async () => {
    const before = await naKept();
    owner.s1Queue = [pass(), { code: 0, stdout: 'f\n' }];
    const compose = fs.readFileSync(composePathOf('a'), 'utf-8');
    const data = treeOf(dataDirOf('a'));
    const inUse = bot();
    clearCalls();
    const answer = await pressBack();
    const text = KEPT_TEXT.aNaNotSuper(user());
    expect(answer).toEqual({ success: false, status: 409, error: text });
    expect(owner.calls.map(scriptOf)).toEqual(['S1', 'S1']);
    const after = bot();
    expect(after.keptOp).toBeUndefined();
    expect(after.keptLast).toEqual({ op: 'put-back', set: fwd().stamp, outcome: 'failed', text, at: LATER_ISO });
    expect(after.fleetDb).toEqual(inUse.fleetDb);
    expect(after.fleetDb!.volume).toBe(fwd().newVolume);
    expect(after.keptSets).toEqual(inUse.keptSets);
    expect(after.keptSets).toEqual([expect.objectContaining({ id: fwd().stamp, db: before.inst.fleetDb })]);
    expect(after.maintenance).toMatchObject({ state: 'off', settled: false, lastError: maintenance.NO_ADMIN_OFF_REASON });
    expect(fs.readFileSync(composePathOf('a'), 'utf-8')).toBe(compose);
    expect(treeOf(dataDirOf('a'))).toEqual(data);
    expect(docker.calls.filter(a => a[0] === 'stop' || a[0] === 'rm' || a[0] === 'start')).toEqual([]);
    expect(run.execCalls).toEqual([]);
    expect(keptRunningOp('a')).toBeNull();
    expect(claimFleetBackupBusy('a')).toBe(true);
  });

  it('PB10c: the database reads stopped at the re-check: no read, on to P1 and done', async () => {
    const before = await naKept();
    owner.s1 = () => {
      docker.running[CONTAINER] = false;
      return { code: 0, stdout: s1Stdout() };
    };
    clearCalls();
    expectMainBack(before, await pressBack());
    expect(owner.calls.map(scriptOf)).toEqual(['S1']);
  });

  it('PB10d: docker gives no answer for the database at the re-check: T-P-OPEN, the record stays open', async () => {
    await naKept();
    owner.s1 = () => {
      docker.running[CONTAINER] = null;
      return { code: 0, stdout: s1Stdout() };
    };
    clearCalls();
    const answer = await pressBack();
    const reason = `docker did not say whether the database container ${CONTAINER} runs`;
    expect(answer).toEqual({ success: false, status: 409, open: true, error: KEPT_TEXT.pOpen(reason, []) });
    expect(stored().keptOp).toMatchObject({ op: 'put-back', step: 'recorded', lastError: reason, noAdminOff: bot().maintenance!.orderedAt });
    expect(putBackDone(stored().keptOp)).toEqual([]);
    expect(owner.calls.map(scriptOf)).toEqual(['S1']);
    expect(docker.calls.filter(a => a[0] === 'stop')).toEqual([]);
  });

  it('B1 (code review 1): the instance has no managed database at the re-check: T-P-OPEN naming what was read, the record stays open', async () => {
    await naKept();
    owner.s1 = () => {
      patchRegistry('a', { fleetDb: undefined });
      return { code: 0, stdout: s1Stdout() };
    };
    clearCalls();
    const answer = await pressBack();
    const reason = "this instance no longer has a managed database, so the manager cannot check it as the bot's role before the database in use is stopped";
    expect(answer).toEqual({ success: false, status: 409, open: true, error: KEPT_TEXT.pOpen(reason, []) });
    expect(stored().keptOp).toMatchObject({ op: 'put-back', step: 'recorded', lastError: reason });
    expect(owner.calls.map(scriptOf)).toEqual(['S1']);
    expect(docker.calls.filter(a => a[0] === 'stop')).toEqual([]);
  });
});

describe('nm34 put back: the copy note when the copy has no dbm_admin', () => {
  /** The dbm_admin status probe of the copy: `stderr` its failure. */
  function probeFails(stderr: string): void {
    docker.overrides.unshift({ match: a => a[0] === 'exec' && a.includes(dbLogin.MANAGER_DB_ROLE) && a.join(' ').includes('pg_is_in_recovery'), answer: { ok: false, stderr } });
  }
  const probeText = (stderr: string) => `the standby could not be probed (${stderr.trim().split('\n').pop()!.trim()})`;

  async function copyBack(clock = false): Promise<{ answer: any; note: string }> {
    const before = await keptAfterStart('copy');
    useOwner();
    clearCalls();
    const answer: any = clock ? await withClock(() => pressBack()) : await pressBack();
    expect(answer).toMatchObject({ success: true });
    expect(bot().fleetDbReplica).toEqual(before.inst.fleetDbReplica);
    return { answer, note: answer.text };
  }

  const expected = (copy: { streams: string } | { down: string } | { unknown: string }) =>
    KEPT_TEXT.pDone({ date: DATE, copyVolume: COPY_VOLUME, folder: dataDirOf('a'), asideFolder: asideDir(), copy, orderText: orderText() });

  it('CN1: S3 reads a superuser, in recovery, streaming: the copy streams from the main', async () => {
    probeFails(NO_ADMIN_STDERR);
    const { answer } = await copyBack();
    expect(answer.text).toBe(expected({ streams: 'main.invalid:15432' }));
    expect(owner.calls.map(scriptOf)).toEqual(['S3']);
    expect(isOwnerShape(owner.calls[0].args, 'smdb')).toBe(true);
    expect(owner.calls[0].args).toContain(COPY_CONTAINER);
    expect(owner.calls[0].input.startsWith('BEGIN TRANSACTION READ ONLY;')).toBe(true);
  });

  it('CN2: S3 reads in recovery with another receiver status: runs but does not stream', async () => {
    probeFails(NO_ADMIN_STDERR);
    owner.copy = 'true|';
    const { answer } = await copyBack();
    expect(answer.text).toBe(expected({ down: 'its WAL receiver reads nothing' }));
  });

  it('CN3: S3 reads not in recovery: it does not follow the main', async () => {
    probeFails(NO_ADMIN_STDERR);
    owner.copy = 'false|';
    const { answer } = await copyBack();
    expect(answer.text).toBe(expected({ down: 'it is not in recovery, so it does not follow the main' }));
  });

  const cn4: Array<[string, () => void, () => string, boolean?]> = [
    ['the copy\'s role is not a superuser', () => { owner.superuser = false; }, () => KEPT_TEXT.cNotSuper('smdb')],
    ['the session fails', () => { owner.s3 = fail(ROLE_GONE('smdb')); }, () => KEPT_TEXT.cRead('smdb', ROLE_GONE_LINE('smdb'))],
    ['the read times out', () => { owner.s3 = 'hang'; }, () => KEPT_TEXT.cRead('smdb', 'no answer within 30 seconds'), true],
    ['the answer does not parse', () => { owner.s3 = { code: 0, stdout: 't\ncopy|maybe\n' }; }, () => KEPT_TEXT.cRead('smdb', "the read answered 'copy|maybe'")],
  ];
  cn4.forEach(([cause, set, tail, clock], i) => {
    it(`CN4 (${i + 1} of 5): ${cause}: can't confirm, with the reason`, async () => {
      probeFails(NO_ADMIN_STDERR);
      set();
      const { answer } = await copyBack(clock);
      expect(answer.text).toBe(expected({ unknown: `${probeText(NO_ADMIN_STDERR)}; ${tail()}` }));
      expect(owner.calls.map(scriptOf)).toEqual(['S3']);
    });
  });

  it('CN4 (5 of 5): the copy\'s role name is one the manager does not read as: can\'t confirm, no process started, the run goes on', async () => {
    probeFails(NO_ADMIN_STDERR);
    await keptAfterStart('copy');
    useOwner();
    const reg = JSON.parse(regText());
    reg.instances.a.keptSets[0].copy.user = 'dbm_meta';
    fs.writeFileSync(registryPath(), JSON.stringify(reg, null, 2));
    clearCalls();
    const answer: any = await pressBack();
    expect(answer).toMatchObject({ success: true });
    expect(answer.text).toBe(expected({ unknown: `${probeText(NO_ADMIN_STDERR)}; ${KEPT_TEXT.cName('dbm_meta')}` }));
    expect(owner.calls).toEqual([]);
    expect(run.psqlCalls).toEqual([]);
  });

  it('CN5: the probe fails for another reason: no S3, can\'t confirm as NM31 says', async () => {
    const stderr = 'psql: error: connection to server on socket "/var/run/postgresql/.s.PGSQL.5432" failed: No such file or directory';
    probeFails(stderr);
    const { answer } = await copyBack();
    expect(answer.text).toBe(expected({ unknown: probeText(stderr) }));
    expect(owner.calls).toEqual([]);
  });
});
