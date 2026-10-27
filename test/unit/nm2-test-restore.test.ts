import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm2-test-'));
  process.env.DATA_DIR = dir;
  return { dir, testSaveFails: null as null | ((record: any) => boolean), shutdown: false, freeBytes: null as number | null, startSaveFails: false };
});

vi.mock('child_process', async (importOriginal) => (await import('./nm2-docker')).childProcessMock(await importOriginal()));
vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>();
  const statfsSync = (p: any, o?: any) => (h.freeBytes !== null ? { bavail: h.freeBytes / 4096, bsize: 4096 } : (real.statfsSync as any)(p, o));
  return { ...real, statfsSync, default: { ...real, statfsSync } };
});
vi.mock('../../src/config/appCapabilities', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/config/appCapabilities')>()),
  findAppCapabilities: () => ({ companionDb: { env: { url: 'DATABASE_URL' } } }),
}));
vi.mock('../../src/env/manager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/env/manager')>()),
  getEnvVars: () => ({ DATABASE_URL: 'postgresql://app:pw@bot-a-postgres:5432/app' }),
  getEnvVarsWithStatus: () => ({ vars: { DATABASE_URL: 'postgresql://app:pw@bot-a-postgres:5432/app' }, undecryptable: [], corrupt: false }),
}));
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));
vi.mock('../../src/docker/containerManager', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/docker/containerManager')>();
  return {
    ...real,
    isShuttingDown: () => h.shutdown,
    updateInstanceFleetBackupStart: (...args: any[]) => {
      if (h.startSaveFails) throw new Error('disk full');
      return (real.updateInstanceFleetBackupStart as any)(...args);
    },
    updateInstanceFleetBackupTest: (id: string, family: any, tests: any) => {
      if (h.testSaveFails?.(tests?.last)) throw new Error('disk full');
      return real.updateInstanceFleetBackupTest(id, family, tests);
    },
  };
});

import * as fs from 'fs';
import * as path from 'path';
import { docker, resetDocker, callsWith } from './nm2-docker';
import { holder } from './dump-fake';
import { fenceOwners } from './fence-fake';
import { PRIMARY, REPLICA, seedBot, clearRegistry, stored, dumps, dumpsDir, putDump, stampText, restartedManager, startedWithTick, tickOnce, localAt, logged } from './nm2-harness';
import { setNow, realNow } from './nm2-harness';

const NOW = localAt(10, 30);
const H = 3_600_000;
const FILE = `daily-${stampText(localAt(4, 10))}.dump`;
const COUNTS = { '"public"."t"': 3, '"smdb_data"."guilds"': 2 };
const T = 'smdb-testrestore-a';

const noDumpDue = () => {
  putDump(FILE, { counts: COUNTS, takenAt: localAt(4, 10) });
  putDump(`hourly-${stampText(localAt(10, 5))}.dump`, { counts: COUNTS, takenAt: localAt(10, 5) });
};
const lastTest = () => stored().fleetBackupTests?.main?.last;

async function check() {
  const fb = await restartedManager();
  const bc = await import('../../src/instance/backupCheck');
  const cm = await import('../../src/docker/containerManager');
  return { fb, bc, cm, bot: () => cm.getBot('a')! };
}

beforeEach(() => {
  setNow(NOW);
  resetDocker();
  fenceOwners.clear();
  docker.restoredCounts = { ...COUNTS };
  holder.counts = { ...COUNTS };
  h.testSaveFails = null;
  h.shutdown = false;
  h.startSaveFails = false;
  h.freeBytes = null;
  fs.rmSync(path.join(h.dir, 'backups'), { recursive: true, force: true });
  clearRegistry();
  seedBot({ fleetDb: PRIMARY });
});
afterEach(() => { realNow(); });
afterAll(() => { fs.rmSync(h.dir, { recursive: true, force: true }); });

describe('NM2 B: the daily test restore', () => {
  it('B1 not due, or no scheduled dump: nothing runs, and the status has no test', async () => {
    const { fb } = await check();
    const tick = startedWithTick(fb);
    docker.running[PRIMARY.containerName] = false;
    putDump('pre-restore-x.dump');
    await tickOnce(fb, tick);
    expect(callsWith(T)).toEqual([]);
    expect(fb.fleetBackupStatus(stored()).main?.test).toBeNull();
    seedBot({ fleetDb: PRIMARY, fleetBackupTests: { main: { last: { file: FILE, startedAt: NOW - 60_000, finishedAt: NOW, result: 'passed', tables: 2, rows: 5 } } } });
    noDumpDue();
    delete docker.running[PRIMARY.containerName];
    docker.calls = [];
    await tickOnce(fb, tick);
    expect(callsWith(T)).toEqual([]);
  });

  it('B2 shutting down: the test is skipped', async () => {
    noDumpDue();
    const { fb } = await check();
    const tick = startedWithTick(fb);
    h.shutdown = true;
    await tickOnce(fb, tick);
    expect(callsWith(T)).toEqual([]);
    expect(lastTest()).toBeUndefined();
  });

  it('B3 a running record that cannot be saved skips the test for the hour slot and logs X-UNSAVED', async () => {
    noDumpDue();
    h.testSaveFails = () => true;
    const { fb } = await check();
    const tick = startedWithTick(fb);
    const lines = await tickOnce(fb, tick);
    expect(lines.join('\n')).toContain("[FleetBackup] The test restore of Bot a's main database did not start: its record could not be saved (disk full)");
    expect(callsWith(T)).toEqual([]);
    h.testSaveFails = null;
    await tickOnce(fb, tick);
    expect(callsWith(T)).toEqual([]);
    setNow(NOW + H);
    await tickOnce(fb, tick);
    expect(lastTest()?.result).toBe('passed');
  });

  it('B4 a missing counts file fails with X-META', async () => {
    putDump(FILE, { meta: null });
    const { bc, bot } = await check();
    const rec = await bc.runTestRestore(bot(), 'main', FILE);
    expect(rec?.result).toBe('failed');
    expect(rec?.text).toMatch(/^the counts recorded with this backup could not be read \(.+\)$/);
    expect(lastTest()?.result).toBe('failed');
  });

  it('B5 a leftover that cannot be removed fails with X-LEFTOVER', async () => {
    putDump(FILE, { counts: COUNTS });
    docker.overrides.push({ match: a => a[0] === 'rm' && a.includes(T), answer: { ok: false, stderr: 'Error response from daemon: permission denied' } });
    const { bc, bot } = await check();
    const rec = await bc.runTestRestore(bot(), 'main', FILE);
    expect(rec?.text).toMatch(/^the throwaway container or volume smdb-testrestore-a from an earlier test could not be removed \(Error response from daemon: permission denied\)/);
    expect(callsWith('postgres:16-alpine')).toEqual([]);
  });

  it('B5 "No such" answers count as removed', async () => {
    putDump(FILE, { counts: COUNTS });
    docker.overrides.push({ match: a => a[0] === 'rm' && a.includes(T), answer: { ok: false, stderr: 'Error: No such container: smdb-testrestore-a' } });
    docker.overrides.push({ match: a => a[0] === 'volume' && a[1] === 'rm', answer: { ok: false, stderr: 'Error: No such volume: smdb-testrestore-a' } });
    const { bc, bot } = await check();
    expect((await bc.runTestRestore(bot(), 'main', FILE))?.result).toBe('passed');
  });

  it('B6 a throwaway that cannot start fails with X-START', async () => {
    putDump(FILE, { counts: COUNTS });
    docker.overrides.push({ match: a => a[0] === 'run', answer: { ok: false, stderr: 'Unable to find image postgres:16-alpine locally\ndocker: Error response from daemon: pull access denied' } });
    const { bc, bot } = await check();
    const rec = await bc.runTestRestore(bot(), 'main', FILE);
    expect(rec?.text).toMatch(/^the throwaway database could not be started \(docker: Error response from daemon: pull access denied\)$/);
  });

  it('B7 a throwaway not ready within the bound fails with X-READY', async () => {
    putDump(FILE, { counts: COUNTS });
    docker.ready = false;
    const { bc, bot } = await check();
    bc.testTiming.readyDeadlineMs = 30;
    bc.testTiming.readyGapMs = 5;
    const rec = await bc.runTestRestore(bot(), 'main', FILE);
    expect(rec?.text).toBe('the throwaway database did not accept connections within 90 s');
  });

  it('B8 an unreadable df fails with X-DFREAD', async () => {
    putDump(FILE, { counts: COUNTS });
    docker.overrides.push({ match: a => a.includes('df'), answer: { ok: true, stdout: 'garbage\n' } });
    const { bc, bot } = await check();
    const rec = await bc.runTestRestore(bot(), 'main', FILE);
    expect(rec?.text).toMatch(/^the free space of the disk that holds Docker's volumes could not be read \(.+\)$/);
  });

  it('B9 too little space fails with X-DISK', async () => {
    putDump(FILE, { counts: COUNTS, meta: { dbBytes: 2 * 1048576 } });
    docker.dfFreeKb = 500 * 1024;
    const { bc, bot } = await check();
    const rec = await bc.runTestRestore(bot(), 'main', FILE);
    expect(rec?.text).toBe("the disk that holds Docker's volumes has 500 MB free, and the test needs 1028 MB (twice the database's size, plus 1 GB kept free for the live database)");
    expect(callsWith('pg_restore')).toEqual([]);
  });

  it('B10 pg_restore exiting non-zero fails with X-RESTORE', async () => {
    putDump(FILE, { counts: COUNTS });
    docker.restore = { code: 1, stderr: 'pg_restore: error: could not execute query' };
    const { bc, bot } = await check();
    const rec = await bc.runTestRestore(bot(), 'main', FILE);
    expect(rec?.text).toBe('pg_restore exited with code 1: pg_restore: error: could not execute query');
    expect(callsWith('pg_restore')[0]).toEqual(['exec', '-i', T, 'timeout', '-s', 'KILL', '600', 'pg_restore', '-U', 'postgres', '--no-owner', '--no-privileges', '--exit-on-error', '-d', 'restorecheck']);
  });

  it('B11 pg_restore past its bound fails with X-RESTTIME', async () => {
    putDump(FILE, { counts: COUNTS });
    docker.restore = { code: 0, hang: true };
    const { bc, bot } = await check();
    bc.testTiming.backstopMs = 30;
    const rec = await bc.runTestRestore(bot(), 'main', FILE);
    expect(rec?.text).toBe('pg_restore did not finish within 10 minutes');
  });

  it('B12 a counts query that fails fails with X-COUNTREAD', async () => {
    putDump(FILE, { counts: COUNTS });
    docker.overrides.push({ match: a => a[0] === 'exec' && a[1] === T && a.includes('psql'), answer: { ok: false, stderr: 'psql: error: FATAL: database "restorecheck" does not exist' } });
    const { bc, bot } = await check();
    const rec = await bc.runTestRestore(bot(), 'main', FILE);
    expect(rec?.text).toBe('the restored tables could not be counted (psql: error: FATAL: database "restorecheck" does not exist)');
  });

  it('B13 counts that differ fail with X-MISMATCH', async () => {
    putDump(FILE, { counts: COUNTS });
    docker.restoredCounts = { '"public"."t"': 2 };
    const { bc, bot } = await check();
    const rec = await bc.runTestRestore(bot(), 'main', FILE);
    expect(rec?.text).toBe('2 table(s) differ from the counts recorded when the backup was taken: "public"."t": 3 recorded, 2 restored; "smdb_data"."guilds": missing after the restore');
  });

  it('B14 counts that match pass, set lastGood, and the next tick removes the test alert, in the ruled order of calls', async () => {
    noDumpDue();
    seedBot({ fleetDb: PRIMARY, fleetBackupTests: { main: { last: { file: 'old.dump', startedAt: NOW - 30 * H, finishedAt: NOW - 30 * H, result: 'failed', text: 'x' } } }, fleetBackupAlerts: { 'main:test': { kind: 'test', text: 'x', since: NOW - 30 * H, dm: 'sent', dmAt: NOW - 30 * H } } });
    const { fb } = await check();
    const tick = startedWithTick(fb);
    await tickOnce(fb, tick);
    expect(lastTest()).toMatchObject({ file: `hourly-${stampText(localAt(10, 5))}.dump`, result: 'passed', tables: 2, rows: 5, startedAt: NOW, finishedAt: NOW });
    expect(stored().fleetBackupTests.main.lastGood).toBe(`hourly-${stampText(localAt(10, 5))}.dump`);
    await tickOnce(fb, tick);
    expect(stored().fleetBackupAlerts?.['main:test']).toBeUndefined();
    const seq = docker.calls.filter(a => a.join(' ').includes(T)).map(a => a.slice(0, 2).join(' '));
    expect(seq).toEqual(['rm -f', 'volume rm', 'volume create', 'run -d', `exec ${T}`, `exec ${T}`, `exec -i`, `exec ${T}`, 'rm -f', 'volume rm']);
    expect(callsWith('run -d')[0]).toEqual(['run', '-d', '--name', T, '--label', 'smdb.testrestore=a', '--network', 'none', '--memory', '1g', '--cpus', '1',
      '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', '-e', 'POSTGRES_DB=restorecheck', '-e', 'POSTGRES_INITDB_ARGS=--data-checksums',
      '-v', `${T}:/var/lib/postgresql/data`, 'postgres:16-alpine']);
    expect(callsWith('pg_isready')[0]).toEqual(['exec', T, 'pg_isready', '-h', '127.0.0.1', '-q']);
    expect(docker.restoreStdin).toBeGreaterThan(0);
  });

  it('B15 a cleanup that fails after the verdict keeps the verdict and ends the text with X-CLEANUP', async () => {
    putDump(FILE, { counts: COUNTS });
    let n = 0;
    docker.overrides.push({ match: a => a[0] === 'rm' && a.includes(T), answer: () => (++n === 1 ? { ok: true } : { ok: false, stderr: 'Error: device busy' }) });
    const { bc, bot } = await check();
    const rec = await bc.runTestRestore(bot(), 'main', FILE);
    expect(rec?.result).toBe('passed');
    expect(rec?.text).toBe('; the throwaway container or volume smdb-testrestore-a could not be removed (Error: device busy), and the next test removes it first');
  });

  it('B16 a result that cannot be saved is held in memory with X-NOTSAVED, and logged', async () => {
    putDump(FILE, { counts: COUNTS });
    h.testSaveFails = (r) => r?.result !== 'running';
    const { fb, bc, bot } = await check();
    const { value: rec, lines } = await logged(() => bc.runTestRestore(bot(), 'main', FILE));
    expect(rec?.result).toBe('passed');
    expect(rec?.text).toBe(' (this result is not saved, and a manager restart drops it)');
    expect(lastTest()?.result).toBe('running');
    expect(fb.fleetBackupStatus(stored()).main?.test?.result).toBe('passed');
    expect(lines.join('\n')).toMatch(/\[FleetBackup\] .*disk full/);
  });

  it('B17 a restart mid-test reads interrupted, cutShort 1, and the next tick tests again', async () => {
    noDumpDue();
    seedBot({ fleetDb: PRIMARY, fleetBackupTests: { main: { last: { file: FILE, startedAt: NOW - 60_000, result: 'running' } } } });
    const { fb } = await check();
    const tick = startedWithTick(fb);
    expect(lastTest()).toMatchObject({ result: 'interrupted', cutShort: 1 });
    expect(fb.fleetBackupStatus(stored()).main?.test?.result).toBe('interrupted');
    await tickOnce(fb, tick);
    expect(lastTest()?.result).toBe('passed');
  });

  it('B18 cut short a second time: failed with X-CUT, and the test alert is raised', async () => {
    noDumpDue();
    seedBot({ fleetDb: PRIMARY, fleetBackupTests: { main: { last: { file: FILE, startedAt: NOW - 60_000, result: 'running', cutShort: 1 } } } });
    const { fb } = await check();
    const tick = startedWithTick(fb);
    expect(lastTest()).toMatchObject({ result: 'failed', text: 'the test was cut short twice by a manager restart', cutShort: 2 });
    await tickOnce(fb, tick);
    expect(stored().fleetBackupAlerts['main:test'].text).toBe(`The daily test restore of ${FILE}, a backup of Bot a's main database, failed: the test was cut short twice by a manager restart. The manager tests the newest backup again after the daily backup at 04:00.`);
  });

  it('B19 a dump file deleted by hand fails with X-RESTORE naming the read', async () => {
    putDump(FILE, { counts: COUNTS });
    fs.rmSync(path.join(dumpsDir(), FILE));
    const { bc, bot } = await check();
    const rec = await bc.runTestRestore(bot(), 'main', FILE);
    expect(rec?.text).toMatch(/^Failed to read dump file: /);
  });

  it('B20 backups turned off: a test already running is recorded, and no new test starts', async () => {
    noDumpDue();
    const { fb, bc, cm, bot } = await check();
    const tick = startedWithTick(fb);
    const running = bc.runTestRestore(bot(), 'main', FILE);
    cm.updateInstanceFleetBackup('a', { enabled: false });
    expect((await running)?.result).toBe('passed');
    expect(lastTest()?.result).toBe('passed');
    setNow(NOW + 24 * H);
    docker.calls = [];
    await tickOnce(fb, tick);
    expect(callsWith(T)).toEqual([]);
  });

  it('B21 a real restore may run while a test runs: the test holds no backup slot', async () => {
    putDump(FILE, { counts: COUNTS });
    docker.restore = { code: 0, hang: true };
    const { bc, bot } = await check();
    bc.testTiming.backstopMs = 200;
    const running = bc.runTestRestore(bot(), 'main', FILE);
    await vi.waitFor(() => expect(callsWith('pg_restore').length).toBe(1));
    const guards = await import('../../src/instance/fleetBackupGuards');
    expect(guards.claimFleetBackupBusy('a')).toBe(true);
    guards.releaseFleetBackupBusy('a');
    await running;
  });

  it('B22 a family removed mid-test: the next tick clears its last test, keeps lastGood, and removes its alerts', async () => {
    noDumpDue();
    seedBot({
      fleetDb: PRIMARY,
      fleetBackupTests: { main: { lastGood: FILE, last: { file: FILE, startedAt: NOW, finishedAt: NOW, result: 'failed', text: 'x' } } },
      fleetBackupAlerts: { 'main:test': { kind: 'test', text: 'x', since: NOW, dm: 'sent', dmAt: NOW } },
    });
    const { fb } = await check();
    const tick = startedWithTick(fb);
    seedBot({ fleetBackupTests: stored().fleetBackupTests, fleetBackupAlerts: stored().fleetBackupAlerts });
    await tickOnce(fb, tick);
    expect(stored().fleetBackupTests?.main).toEqual({ lastGood: FILE });
    expect(stored().fleetBackupAlerts?.['main:test']).toBeUndefined();
  });

  it('B26 a re-seed keeps the copy lastGood, and the trim after the seed keeps that dump', async () => {
    const good = `copy-daily-${stampText(NOW - 40 * 24 * H)}.dump`;
    const hourly = `copy-hourly-${stampText(localAt(10, 5))}.dump`;
    putDump(good, { counts: COUNTS, takenAt: NOW - 40 * 24 * H });
    putDump(hourly, { counts: COUNTS, takenAt: localAt(10, 5) });
    seedBot({
      fleetDbReplica: { ...REPLICA, copyCleared: true },
      fleetBackupTests: { copy: { lastGood: good, last: { file: hourly, startedAt: NOW - H, finishedAt: NOW - H, result: 'failed', text: 'x' } } },
    });
    const { fb } = await check();
    const tick = startedWithTick(fb);
    await tickOnce(fb, tick);
    expect(stored().fleetBackupTests?.copy).toEqual({ lastGood: good });
    seedBot({ fleetDbReplica: { ...REPLICA, seededAt: NOW }, fleetBackupTests: stored().fleetBackupTests });
    await tickOnce(fb, tick);
    expect(dumps()).toContain(`copy-daily-${stampText(NOW)}.dump`);
    expect(dumps()).toContain(good);
  });

  it('B27 a refused clear of the last test is logged once per hour slot', async () => {
    seedBot({ fleetBackupTests: { main: { lastGood: FILE, last: { file: FILE, startedAt: NOW, finishedAt: NOW, result: 'failed', text: 'x' } } } });
    h.testSaveFails = () => true;
    const { fb } = await check();
    const tick = startedWithTick(fb);
    const said = (lines: string[]) => lines.filter(l => l.includes("Bot a's main database") && l.includes('(disk full)')).length;
    let n = said(await tickOnce(fb, tick));
    n += said(await tickOnce(fb, tick));
    expect(n).toBe(1);
    setNow(NOW + H);
    expect(said(await tickOnce(fb, tick))).toBe(1);
  });

  it('B28 a standing test alert stays while a new test runs and after it fails again, with no second DM', async () => {
    noDumpDue();
    const standing = { kind: 'test', text: 'x', since: NOW - 30 * H, dm: 'unknown', dmAt: NOW - 30 * H };
    seedBot({ fleetDb: PRIMARY, fleetBackupTests: { main: { last: { file: 'old.dump', startedAt: NOW - 30 * H, finishedAt: NOW - 30 * H, result: 'failed', text: 'x' } } }, fleetBackupAlerts: { 'main:test': standing } });
    docker.restore = { code: 0, hang: true };
    const { fb, bc } = await check();
    bc.testTiming.backstopMs = 1500;
    const tick = startedWithTick(fb);
    tick();
    await vi.waitFor(() => expect(callsWith('pg_restore').length).toBe(1));
    await vi.waitFor(() => expect(fb.isTickRunning()).toBe(false), { timeout: 1000 });
    expect(lastTest()?.result).toBe('running');
    tick();
    await vi.waitFor(() => expect(fb.isTickRunning()).toBe(false), { timeout: 1000 });
    expect(stored().fleetBackupAlerts?.['main:test']).toMatchObject({ since: NOW - 30 * H, dm: 'unknown' });
    await vi.waitFor(() => expect(lastTest()?.result).toBe('failed'), { timeout: 4000 });
    await tickOnce(fb, tick);
    expect(stored().fleetBackupAlerts['main:test']).toMatchObject({ since: NOW - 30 * H, dm: 'unknown', dmAt: NOW - 30 * H });
  });

  it('B29 a restart mid-test keeps the standing test alert while the test is interrupted', async () => {
    noDumpDue();
    seedBot({ fleetDb: PRIMARY, fleetBackupTests: { main: { last: { file: FILE, startedAt: NOW - 60_000, result: 'running' } } }, fleetBackupAlerts: { 'main:test': { kind: 'test', text: 'x', since: NOW - 30 * H, dm: 'sent', dmAt: NOW - 30 * H } } });
    docker.restore = { code: 1, stderr: 'pg_restore: error: bad' };
    const { fb } = await check();
    const tick = startedWithTick(fb);
    expect(lastTest()?.result).toBe('interrupted');
    await tickOnce(fb, tick);
    expect(lastTest()?.result).toBe('failed');
    expect(stored().fleetBackupAlerts['main:test']).toMatchObject({ since: NOW - 30 * H, dm: 'sent' });
  });

  it('B30 a refused clear of the backups start is logged with the old start kept, and is tried again on the next tick', async () => {
    noDumpDue();
    seedBot({ fleetDb: PRIMARY, fleetBackup: { enabled: false, hour: 4 }, fleetBackupStarts: { main: NOW - 50 * H } });
    h.startSaveFails = true;
    const { fb } = await check();
    const tick = startedWithTick(fb);
    const lines = await tickOnce(fb, tick);
    expect(stored().fleetBackupStarts?.main).toBe(NOW - 50 * H);
    expect(lines.join('\n')).toContain("[FleetBackup] The registry still holds the old start of the backups of Bot a's main database: clearing it failed, and the manager tries again on every tick (disk full)");
    h.startSaveFails = false;
    await tickOnce(fb, tick);
    expect(stored().fleetBackupStarts?.main ?? null).toBeNull();
  });

  it('B31 a refused first save of the backups start is logged with no start stored yet', async () => {
    noDumpDue();
    seedBot({ fleetDb: PRIMARY });
    h.startSaveFails = true;
    const { fb } = await check();
    const tick = startedWithTick(fb);
    const lines = (await tickOnce(fb, tick)).join('\n');
    expect(stored().fleetBackupStarts).toBeUndefined();
    expect(lines).not.toContain('still holds the old start');
    expect(lines).toContain("[FleetBackup] No start of the backups of Bot a's main database is stored yet: saving ");
    expect(lines).toContain('failed, and the manager tries again on every tick (disk full)');
  });

  it('B23 a test restore runs outside the tick: the next hour dumps every bot while the test still runs', async () => {
    noDumpDue();
    seedBot({ fleetDbReplica: { ...REPLICA, containerName: 'bot-b-replica', seededAt: NOW - 30 * 24 * H } }, 'b');
    putDump(`copy-daily-${stampText(localAt(4, 10))}.dump`, { id: 'b', counts: COUNTS, takenAt: localAt(4, 10) });
    putDump(`copy-hourly-${stampText(localAt(10, 5))}.dump`, { id: 'b', counts: COUNTS, takenAt: localAt(10, 5) });
    docker.restore = { code: 0, hang: true };
    const { fb, bc } = await check();
    bc.testTiming.backstopMs = 1500;
    const tick = startedWithTick(fb);
    tick();
    await vi.waitFor(() => expect(callsWith('pg_restore').length).toBe(1));
    await vi.waitFor(() => expect(fb.isTickRunning()).toBe(false), { timeout: 1000 });
    setNow(NOW + H);
    tick();
    await vi.waitFor(() => expect(fb.isTickRunning()).toBe(false), { timeout: 1000 });
    expect(callsWith('pg_dump').filter(a => a.includes('pg_dump')).map(a => a[1]).sort()).toEqual(['bot-a-postgres', 'bot-b-replica']);
    expect(callsWith('pg_restore').length).toBe(1);
    await vi.waitFor(() => expect(lastTest()?.result).toBe('failed'), { timeout: 4000 });
  });

  it('B24 the trim keeps the dump a running test reads', async () => {
    const old = `hourly-${stampText(NOW - 49 * H)}.dump`;
    putDump(old, { counts: COUNTS, takenAt: NOW - 49 * H });
    holder.failQueue = ['psql: error: connection refused'];
    docker.restore = { code: 0, hang: true };
    const { fb, bc } = await check();
    bc.testTiming.backstopMs = 1500;
    const tick = startedWithTick(fb);
    tick();
    await vi.waitFor(() => expect(callsWith('pg_restore').length).toBe(1));
    await vi.waitFor(() => expect(fb.isTickRunning()).toBe(false), { timeout: 1000 });
    setNow(NOW + H);
    tick();
    await vi.waitFor(() => expect(fb.isTickRunning()).toBe(false), { timeout: 1000 });
    expect(dumps()).toContain(`daily-${stampText(NOW + H)}.dump`);
    expect(dumps()).toContain(old);
    await vi.waitFor(() => expect(lastTest()?.result).toBe('failed'), { timeout: 4000 });
  });

  it('B25 the dump disk check counts what a running test holds', async () => {
    putDump(FILE, { counts: COUNTS, takenAt: localAt(4, 10) });
    putDump(`hourly-${stampText(localAt(10, 5))}.dump`, { counts: COUNTS, takenAt: localAt(10, 5), meta: { dbBytes: 1024 * 1048576 } });
    h.freeBytes = 2048 * 1048576;
    docker.restore = { code: 0, hang: true };
    const { fb, bc } = await check();
    bc.testTiming.backstopMs = 1500;
    const tick = startedWithTick(fb);
    tick();
    await vi.waitFor(() => expect(callsWith('pg_restore').length).toBe(1));
    await vi.waitFor(() => expect(fb.isTickRunning()).toBe(false), { timeout: 1000 });
    setNow(NOW + H);
    tick();
    await vi.waitFor(() => expect(fb.isTickRunning()).toBe(false), { timeout: 1000 });
    expect(fb.fleetBackupStatus(stored()).main?.lastError).toMatch(/^only 2048 MB is free under .+, and a dump needs about 3584 MB, of which 3072 MB is held for the test restore that is running; free space there/);
    await vi.waitFor(() => expect(lastTest()?.result).toBe('failed'), { timeout: 4000 });
  });
});
